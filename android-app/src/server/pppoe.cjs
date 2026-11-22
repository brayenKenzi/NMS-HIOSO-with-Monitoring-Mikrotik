const { performance } = require('node:perf_hooks');

const pppoeInterval = 3000;
let routerUrl = process.env.PPPOE_URL;
let username = process.env.PPPOE_USER;
let password = process.env.PPPOE_PASSWORD;
let configured = Boolean(routerUrl && username && password);
let active = [];
let previous = new Map();
let sampledAt = null;
let error = null;
let polling = false;

function initRouterConfig(config) {
  if (config?.url && config?.username && config?.password) {
    routerUrl = config.url;
    username = config.username;
    password = config.password;
    configured = true;
  } else if (process.env.PPPOE_URL && process.env.PPPOE_USER && process.env.PPPOE_PASSWORD) {
    routerUrl = process.env.PPPOE_URL;
    username = process.env.PPPOE_USER;
    password = process.env.PPPOE_PASSWORD;
    configured = true;
  } else {
    configured = false;
  }
}

function updateRouterConfig(config) {
  if (config && config.url && config.username && config.password) {
    routerUrl = config.url;
    username = config.username;
    password = config.password;
    configured = true;
  } else {
    routerUrl = null;
    username = null;
    password = null;
    configured = false;
  }
  previous.clear();
  active = [];
  sampledAt = null;
  error = null;
}

function getRouterConfig() {
  return {
    url: routerUrl ?? '',
    username: username ?? '',
    configured,
    activeSessions: active.length,
    sampledAt,
    error,
  };
}

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

async function pollPppoe() {
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

async function probeRouter(timeoutMs = 2000) {
  if (!configured || !routerUrl) return false;
  try {
    const url = new URL('/rest/system/identity', routerUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: 'Basic ' + Buffer.from((username ?? '') + ':' + (password ?? '')).toString('base64'),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

function normalizeLabel(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function disambiguateByName(rowName, sessions) {
  const target = normalizeLabel(rowName);
  if (target.length < 3) return null;
  const matched = sessions.filter(s => {
    const user = normalizeLabel(s.username);
    return user.length >= 3 && (user === target || user.includes(target) || target.includes(user));
  });
  return matched.length === 1 ? matched[0] : null;
}

function pppoeView(devices, override = null) {
  const isConfigured = override?.configured ?? configured;
  const isAvailable = override?.available ?? (isConfigured && sampledAt && !error && Date.now() - Date.parse(sampledAt) <= 45000);
  const activeList = override?.active ?? (isAvailable ? active : []);
  const inventoryReady = devices.some(device => device.rows.some(row => row.mac));
  const inventory = devices.flatMap(device => device.rows);

  // Pass 1: Full 12-char exact MAC index (exact matches NEVER become ambiguous due to shared 10-char OUI/prefix)
  const exactSessions = group(isAvailable ? activeList : [], s => s.mac);
  const onlineExactMacs = new Set(
    inventory.filter(r => r.status === 'Online').map(r => macKey(r.mac)).filter(Boolean)
  );
  const exactMatchedMacs = new Set();
  for (const row of inventory) {
    const full = macKey(row.mac);
    if (full && exactSessions.has(full)) exactMatchedMacs.add(full);
  }

  // Pass 2: Residual 10-char prefix pools (exclude sessions & ONUs already claimed by exact 12-char MAC match)
  const residualSessions = (isAvailable ? activeList : []).filter(s => s.mac && !exactMatchedMacs.has(s.mac));
  const residualSessionPrefixes = group(residualSessions, s => s.mac.slice(0, 10));

  const residualInventory = inventory.filter(r => {
    const full = macKey(r.mac);
    return full && !exactMatchedMacs.has(full);
  });
  const residualInvAllPrefixes = group(residualInventory, r => macKey(r.mac).slice(0, 10));
  const residualInvOnlinePrefixes = group(
    residualInventory.filter(r => r.status === 'Online'),
    r => macKey(r.mac).slice(0, 10)
  );

  return {
    status: { configured: isConfigured, sampledAt, available: Boolean(isAvailable), error, inventoryReady, intervalMs: pppoeInterval },
    match(row) {
      if (!isAvailable || !inventoryReady) return { state: 'unavailable' };
      const full = macKey(row.mac);
      if (!full) return { state: 'unmatched' };

      // 1. Exact 12-char MAC match first
      const exact = exactSessions.get(full);
      if (exact?.length) {
        // If another Online registration holds this exact MAC and this row is an Offline duplicate, don't duplicate session
        if (row.status === 'Offline' && onlineExactMacs.has(full)) {
          return { state: 'unmatched' };
        }
        if (exact.length === 1) {
          return { ...exact[0], state: 'exact' };
        }
        const byName = disambiguateByName(row.name, exact);
        return byName ? { ...byName, state: 'exact' } : { state: 'ambiguous' };
      }

      // 2. Fallback to 10-char MAC prefix on remaining (non-exact) pool
      const prefix = full.slice(0, 10);
      const sessions = residualSessionPrefixes.get(prefix);
      if (!sessions?.length) return { state: 'unmatched' };

      const onlinePeers = residualInvOnlinePrefixes.get(prefix) ?? [];
      const allPeers = residualInvAllPrefixes.get(prefix) ?? [];
      if (row.status === 'Offline' && onlinePeers.length > 0) {
        return { state: 'unmatched' };
      }
      const peerCount = onlinePeers.length > 0 ? onlinePeers.length : allPeers.length;
      if (sessions.length === 1 && peerCount <= 1) {
        return { ...sessions[0], state: 'prefix' };
      }

      // 3. Name-based disambiguation if multiple prefix candidates remain
      const byName = disambiguateByName(row.name, sessions);
      if (byName) return { ...byName, state: 'prefix' };
      return { state: 'ambiguous' };
    },
  };
}

module.exports = {
  pppoeInterval,
  initRouterConfig,
  updateRouterConfig,
  getRouterConfig,
  probeRouter,
  pollPppoe,
  pppoeView,
};
