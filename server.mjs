import http from 'node:http';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { fileURLToPath } from 'node:url';
import snmp from 'net-snmp';
import { canRestart, restartRequest } from './restart-onu.mjs';
import { pollPppoe, pppoeInterval, pppoeView } from './pppoe.mjs';
import { openStore } from './nms-store.mjs';
import { createRoutes, json } from './nms-routes.mjs';

const checking = process.argv.includes('--check');
const store = checking ? null : openStore(process.env.NMS_DB);
const configPath = process.env.NMS_OLTS_FILE || fileURLToPath(new URL('./olts.json', import.meta.url));
let config = JSON.parse(readFileSync(configPath, 'utf8'));
const root = '1.3.6.1.4.1.25355.3.2.6';
const defaultOids = {
  name: root + '.3.2.1.37',
  status: root + '.3.2.1.39',
  rx: root + '.14.2.1.8',
  mac: root + '.3.2.1.11',
};
function makeDevice(device) {
  if (!isIPv4(device.host) || !device.name || !(device.communityEnv || device.community)) {
    throw new Error('Isi nama, IPv4, dan community baca untuk setiap OLT.');
  }
  return { ...device, rows: [], updated: null, error: null, polling: false };
}
const devices = config.map(makeDevice);
const communityFor = device => device.community ?? process.env[device.communityEnv];

function readColumn(session, oid) {
  return new Promise((resolve, reject) => {
    const values = new Map();
    let count = 0;
    session.subtree(oid, 15, (batch) => {
      for (const binding of batch) {
        if (snmp.isVarbindError(binding)) continue;
        const index = binding.oid.slice(oid.length + 1);
        values.set(index, String(binding.value).trim());
        if (++count > 4096) {
          reject(new Error('Batas pembacaan kolom ONU terlampaui.'));
          return true;
        }
      }
    }, (error) => error ? reject(error) : resolve(values));
  });
}

async function poll(device) {
  if (device.polling) return;
  device.polling = true;
  let session;
  let deadline;
  try {
    const community = communityFor(device);
    if (!community) throw new Error('Community baca belum diisi di environment server.');
    session = snmp.createSession(device.host, community, {
      version: snmp.Version2c, port: device.port ?? 161, timeout: 3500, retries: 1,
    });
    const oids = { ...defaultOids, ...device.oids };
    const columns = Promise.all([
      readColumn(session, oids.name),
      readColumn(session, oids.status),
      readColumn(session, oids.rx),
      readColumn(session, oids.mac).catch(() => new Map()),
    ]);
    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Batas waktu polling terlampaui.')), 90000);
    });
    const [names, states, powers, macs] = await Promise.race([columns, timeout]);
    if (!names.size && !states.size && !powers.size) {
      throw new Error('Tabel ONU kosong. Periksa OID firmware atau registrasi ONU.');
    }
    device.rows = [...new Set([...names.keys(), ...states.keys(), ...powers.keys()])].map((index) => {
      const state = states.get(index);
      const raw = powers.get(index);
      const mac = macs.get(index)?.toUpperCase();
      const rx = raw && /^[+-]?\d+(?:\.\d+)?$/.test(raw)
        ? Number(raw) / (device.rxDivider ?? 1) : null;
      return {
        index,
        name: names.get(index) ?? '',
        mac: /^[0-9A-F]{12}$/.test(mac ?? '') && mac !== '000000000000' && mac !== 'FFFFFFFFFFFF'
          ? mac.match(/../g).join(':') : null,
        status: state === '1' ? 'Online' : state === '2' ? 'Offline' : null,
        rx: state === '2' || !Number.isFinite(rx) || rx < -60 || rx > 15 ? null : rx,
      };
    });
    device.updated = new Date().toISOString();
    device.pollFailed = false;
    device.error = powers.size ? null : 'Data redaman kosong. Periksa OID daya optik firmware.';
  } catch (error) {
    device.pollFailed = true;
    device.error = error.message;
  } finally {
    clearTimeout(deadline);
    session?.close();
    device.polling = false;
    if (store && devices.includes(device)) {
      try { store.recordPoll(device); }
      catch (error) { console.error('Gagal menyimpan hasil pemantauan:', error.message); }
    }
  }
}

const page = readFileSync(new URL('./dashboard.html', import.meta.url));
const logo = readFileSync(new URL('./momo-logo.png', import.meta.url));
const bindHost = process.env.NMS_HOST || '127.0.0.1';
const port = Number(process.env.NMS_PORT || 8080);
function listOlts() {
  return devices.map(({ name, host, port = 161, updated, error, polling }) =>
    ({ name, host, port, updated, error, polling }));
}

function manageOlt(data) {
  const { action, host } = data ?? {};
  if (typeof host !== 'string' || !isIPv4(host)) return [400, 'Masukkan alamat IPv4 OLT yang valid.'];
  const existing = devices.findIndex(device => device.host === host);
  let next;
  let added;
  if (action === 'remove') {
    if (existing < 0) return [404, 'OLT tidak ditemukan.'];
    next = config.filter(device => device.host !== host);
  } else if (action === 'add') {
    if (existing >= 0) return [409, 'Alamat IP OLT ini sudah terdaftar.'];
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const community = data.community;
    const port = Number(data.port ?? 161);
    if (!name || name.length > 80 || typeof community !== 'string' || !community.trim() || community.length > 128 ||
        !Number.isInteger(port) || port < 1 || port > 65535) {
      return [400, 'Isi nama OLT, community baca, dan port UDP yang valid.'];
    }
    added = makeDevice({ name, host, community, port });
    next = [...config, { name, host, community, port }];
  } else {
    return [400, 'Aksi tidak didukung.'];
  }
  const draft = configPath + '.tmp';
  writeFileSync(draft, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(draft, configPath);
  config = next;
  if (added) {
    devices.push(added);
    void poll(added);
    return [201, 'OLT ditambahkan. NMS sedang memeriksa koneksi SNMP.'];
  }
  devices.splice(existing, 1);
  try { store.retireOlt(host); }
  catch (error) { console.error('Gagal menutup alarm OLT:', error.message); }
  return [200, 'OLT dihapus dari daftar pemantauan.'];
}

function findClientName(host, mac, index) {
  const matches = devices.find(device => device.host === host)?.rows.filter(row =>
    row.mac === mac?.toUpperCase() && (!index || row.index === index));
  return matches?.length === 1 ? matches[0].name?.trim() || null : null;
}

function clientView(device, row, pppoe) {
  return {
    ...row,
    pppoe: pppoe?.match(row),
    source: { host: device.host, name: device.name, directRestart: canRestart(device.host, bindHost) },
    stale: Boolean(device.pollFailed || !device.updated || Date.now() - Date.parse(device.updated) > 240000),
    sampledAt: device.updated,
    duplicate: device.rows.filter(item => item.mac === row.mac).length > 1,
    observation: store.onuState(device.host, row.index, row.mac),
  };
}

const clients = {
  find(host, mac, index) {
    const device = devices.find(item => item.host === host);
    const candidates = device?.rows.filter(row => row.mac === mac && (!index || row.index === index));
    return candidates?.length === 1 ? clientView(device, candidates[0], pppoeView(devices)) : null;
  },
  offline(days) {
    const now = Date.now();
    const candidates = [];
    const excluded = [];
    for (const device of devices) {
      if (device.pollFailed || !device.updated || now - Date.parse(device.updated) > 240000) {
        excluded.push(device.name);
        continue;
      }
      for (const row of device.rows) {
        if (row.status !== 'Offline' || !row.mac) continue;
        const entry = clientView(device, row);
        const since = entry.observation?.offline_since;
        if (since != null && now - since >= days * 86400000) candidates.push(entry);
      }
    }
    candidates.sort((a, b) => a.observation.offline_since - b.observation.offline_since);
    return { candidates, excluded };
  },
};
const route = store && createRoutes(store, port, { list: listOlts, update: manageOlt }, findClientName, clients);
const operations = readFileSync(new URL('./operations.js', import.meta.url));
const worker = readFileSync(new URL('./nms-worker.js', import.meta.url));

function monitorRestart(host, index, mac) {
  const device = devices.find(item => item.host === host);
  const community = device && communityFor(device);
  if (!community) return;
  const oids = { ...defaultOids, ...device.oids };
  let polls = 0;
  let wentDown = false;
  function observe() {
    if (++polls > 30 || !devices.includes(device)) return;
    const session = snmp.createSession(host, community, { version: snmp.Version2c, port: device.port ?? 161, timeout: 2500, retries: 0 });
    session.get([oids.mac + '.' + index, oids.status + '.' + index], (error, bindings) => {
      session.close();
      let backOnline = false;
      if (!error && bindings.every(binding => !snmp.isVarbindError(binding)) &&
          String(bindings[0].value).toUpperCase() === mac.replaceAll(':', '')) {
        const status = String(bindings[1].value);
        if (status === '2') wentDown = true;
        if (status === '1' && wentDown) backOnline = true;
        try {
          if (status === '2' || backOnline) store.recordRecovery(host, mac, backOnline ? 'Online' : 'Offline');
        } catch (error) { console.error('Gagal menyimpan status restart:', error.message); }
      }
      if (!backOnline) setTimeout(observe, 5000).unref();
    });
  }
  setTimeout(observe, 3000).unref();
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
  const url = new URL(req.url, 'http://127.0.0.1');
  const user = url.pathname.startsWith('/api/') ? await route(req, res, url) : null;
  if (url.pathname.startsWith('/api/') && !user) return;
  if (req.method === 'GET' && req.url === '/api/olts') {
    const pppoe = pppoeView(devices);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(devices.map(({ name, host, rows, updated, error, polling }) =>
      ({ name, host, rows: rows.map(row => ({ ...row, pppoe: pppoe.match(row) })),
        updated, error, polling, pppoe: pppoe.status, directRestart: canRestart(host, bindHost) }))));
  } else if (req.method === 'POST' && ['/api/onu/restart', '/api/onu/delete'].includes(req.url)) {
    const deleting = req.url === '/api/onu/delete';
    if (deleting && user.role !== 'admin') {
      json(res, 403, { message: 'Hapus ONU khusus admin.' });
      return;
    }
    await restartRequest(req, res, devices, bindHost, port, {
      begin: (host, mac, operation, index) => store.beginAudit(user.username, host, mac, operation, findClientName(host, mac, index), index),
      finish: store.finishAudit,
      watch: monitorRestart,
      removed: (device, mac, index) => {
        device.rows = device.rows.filter(row => row.index !== index || row.mac !== mac);
        store.retireOnu(device.host, mac, index, device.rows.some(row => row.mac === mac));
        void poll(device);
      },
    }, deleting);
  } else if (req.method === 'GET' && ['/operations.js', '/nms-worker.js'].includes(req.url)) {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.end(req.url === '/operations.js' ? operations : worker);
  } else if (req.method === 'GET' && req.url === '/momo-logo.png') {
    res.setHeader('Content-Type', 'image/png');
    res.end(logo);
  } else if (req.method === 'GET' && req.url === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page);
  } else {
    res.writeHead(404).end();
  }
  } catch (error) {
    console.error('NMS request:', error.message);
    if (!res.headersSent) json(res, 500, { message: 'Terjadi kesalahan pada server NMS.' });
    else res.end();
  }
});

const pollAll = () => Promise.all(devices.map(poll));
if (checking) {
  await pollAll();
  for (const { name, rows, updated, error } of devices) {
    console.log(JSON.stringify({ name, onu: rows.length, withRx: rows.filter(row => row.rx !== null).length, withMac: rows.filter(row => row.mac !== null).length, updated, error }));
  }
  if (devices.some(device => device.error)) process.exitCode = 1;
} else {
  server.listen(port, bindHost, () => {
    console.log('Dashboard tersedia di http://' + bindHost + ':' + port);
    void pollAll();
    void pollPppoe();
    setInterval(pollAll, 90000);
    setInterval(pollPppoe, pppoeInterval);
    setInterval(() => {
      try { store.sample(devices, pppoeView(devices)); }
      catch (error) { console.error('Gagal menyimpan riwayat:', error.message); }
    }, 10000);
  });
}
