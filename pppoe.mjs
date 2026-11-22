import { performance } from 'node:perf_hooks';

export const pppoeInterval = 2000;
const routerUrl = process.env.PPPOE_URL;
const username = process.env.PPPOE_USER;
const password = process.env.PPPOE_PASSWORD;
const configured = Boolean(routerUrl && username && password);
let active = [];
let previous = new Map();
let sampledAt = null;
let error = null;
let polling = false;

function macKey(value) {
  const key = String(value ?? '').replace(/[:-]/g, '').toUpperCase();
  return /^[0-9A-F]{12}$/.test(key) && key !== '000000000000' && key !== 'FFFFFFFFFFFF'
    ? key : null;
}

function group(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

async function request(path, body) {
  const url = new URL('/rest/' + path, routerUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL RouterOS tidak valid.');
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: body && JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('RouterOS HTTP ' + response.status);
  const records = await response.json();
  if (!Array.isArray(records)) throw new Error('Respons RouterOS bukan daftar.');
  return records;
}

function readCounter(value) {
  return /^\d+$/.test(value ?? '') ? BigInt(value) : null;
}

function rate(bytes, before, elapsed) {
  if (bytes === null || before == null || bytes < before || elapsed <= 0 || elapsed > 20) return null;
  return Number(bytes - before) * 8 / elapsed;
}

export async function pollPppoe() {
  if (!configured || polling) return;
  polling = true;
  try {
    const [sessions, interfaces, stats] = await Promise.all([
      request('ppp/active?.proplist=.id,name,address,service,caller-id,session-id,uptime'),
      request('interface/pppoe-server?.proplist=.id,name,user,running'),
      request('interface/print', {
        stats: '',
        '.query': ['type=pppoe-in'],
        '.proplist': '.id,name,rx-byte,tx-byte',
      }),
    ]);
    const now = performance.now();
    const bindings = group(interfaces.filter(row => row.running === 'true'), row => row.user);
    const counters = new Map(stats.map(row => [row.name, row]));
    const currentSessions = sessions.filter(row => row.service === 'pppoe');
    const byUser = group(currentSessions, row => row.name);
    const next = new Map();
    active = currentSessions.map(row => {
      const links = bindings.get(row.name);
      const link = links?.length === 1 && byUser.get(row.name)?.length === 1 ? links[0] : null;
      const counter = link && counters.get(link.name);
      const tx = readCounter(counter?.['tx-byte']);
      const rx = readCounter(counter?.['rx-byte']);
      const id = row['session-id'] && row['.id'] && link?.['.id']
        ? JSON.stringify([row['session-id'], row['.id'], link['.id'], row.name, row['caller-id']]) : null;
      const prior = previous.get(id);
      if (id && counter) next.set(id, { tx, rx, now });
      return {
        mac: macKey(row['caller-id']),
        username: row.name,
        address: row.address,
        uptime: row.uptime,
        txGB: tx === null ? null : Number(tx) / 1e9,
        rxGB: rx === null ? null : Number(rx) / 1e9,
        txBps: rate(tx, prior?.tx, (now - prior?.now) / 1000),
        rxBps: rate(rx, prior?.rx, (now - prior?.now) / 1000),
      };
    });
    previous = next;
    sampledAt = new Date().toISOString();
    error = null;
  } catch (failure) {
    previous.clear();
    error = failure.message;
  } finally {
    polling = false;
  }
}

export function pppoeView(devices) {
  const available = configured && sampledAt && !error && Date.now() - Date.parse(sampledAt) <= 20000;
  const inventoryReady = devices.every(device => device.updated &&
    Date.now() - Date.parse(device.updated) <= 240000 && device.rows.some(row => row.mac));
  const inventory = devices.flatMap(device => device.rows);
  const allPrefixes = group(inventory, row => macKey(row.mac)?.slice(0, 10));
  const candidates = group(available ? active : [], row => row.mac?.slice(0, 10));
  return {
    status: { configured, sampledAt, available: Boolean(available), error, inventoryReady, intervalMs: pppoeInterval },
    match(row) {
      if (!available || !inventoryReady) return { state: 'unavailable' };
      const prefix = macKey(row.mac)?.slice(0, 10);
      const sessions = candidates.get(prefix);
      if (!sessions) return { state: 'unmatched' };
      if (sessions.length !== 1 || allPrefixes.get(prefix)?.length !== 1) {
        return { state: 'ambiguous' };
      }
      const session = sessions[0];
      return { ...session, state: macKey(row.mac) === session.mac ? 'exact' : 'prefix' };
    },
  };
}
