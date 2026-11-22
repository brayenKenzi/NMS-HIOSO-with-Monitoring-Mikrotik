const dgram = require('node:dgram');
const http = require('node:http');
const { isIPv4 } = require('node:net');
const { join } = require('node:path');
const snmp = require('net-snmp');

const enterprise = '1.3.6.1.4.1.25355.3.2.6';
function isPrivateIp(ip) {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}

async function localHttp() {
  const server = http.createServer((_, res) => res.end('momo-loopback'));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port, address } = server.address();
    const response = await fetch('http://' + address + ':' + port, { signal: AbortSignal.timeout(2500) });
    if (await response.text() !== 'momo-loopback') throw new Error('HTTP loopback tidak sesuai.');
    return address;
  } finally {
    server.close();
  }
}

function localUdp() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => finish(new Error('UDP loopback timeout.')), 3000);
    function finish(error) {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve('Datagram diterima');
    }
    socket.once('error', finish);
    socket.once('message', value => finish(String(value) === 'momo-udp' ? null : new Error('Datagram tidak sesuai.')));
    socket.bind(0, '127.0.0.1', () => socket.send('momo-udp', socket.address().port, '127.0.0.1'));
  });
}

function sqlite(dataDirectory) {
  const { DatabaseSync } = require('node:sqlite');
  const path = join(dataDirectory, 'runtime-probe.sqlite');
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE TABLE IF NOT EXISTS probe (message TEXT); DELETE FROM probe; INSERT INTO probe VALUES ('SQLite aktif')");
  } finally { database.close(); }
  const reopened = new DatabaseSync(path);
  try {
    return reopened.prepare('SELECT message FROM probe').get().message;
  } finally { reopened.close(); }
}

function readColumn(session, oid) {
  return new Promise((resolve, reject) => {
    const values = new Map();
    session.subtree(oid, 15, batch => {
      for (const item of batch) {
        if (!snmp.isVarbindError(item)) values.set(item.oid.slice(oid.length + 1), String(item.value).trim());
        if (values.size > 4096) {
          reject(new Error('Batas ukuran tabel OLT terlampaui.'));
          return true;
        }
      }
    }, error => error ? reject(error) : resolve(values));
  });
}

async function readOlt(host, community, port = 161) {
  if (!isPrivateIp(host) || typeof community !== 'string' || !community || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Diperlukan IPv4 privat, port UDP dan community baca.');
  }
  const session = snmp.createSession(host, community, { port, version: snmp.Version2c, timeout: 3500, retries: 1 });
  let timer;
  try {
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Batas waktu polling tercapai.')), 85000); });
    const columns = Promise.all(['.3.2.1.37', '.3.2.1.11', '.3.2.1.39', '.14.2.1.8']
      .map(suffix => readColumn(session, enterprise + suffix)));
    const [names, macs, statuses, rx] = await Promise.race([columns, limit]);
    const ids = new Set([...names.keys(), ...macs.keys(), ...statuses.keys(), ...rx.keys()]);
    if (!ids.size) throw new Error('OLT merespons, tetapi tabel HiOSO kosong.');
    const rows = [...ids].map(id => {
      const mac = macs.get(id)?.toUpperCase();
      const status = statuses.get(id);
      const raw = rx.get(id);
      const power = raw && /^[+-]?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
      return { id, name: names.get(id) ?? '', mac: /^[A-F0-9]{12}$/.test(mac ?? '') ? mac.match(/../g).join(':') : null,
        status: status === '1' ? 'Online' : status === '2' ? 'Offline' : 'Tidak diketahui',
        rx: status !== '2' && Number.isFinite(power) && power >= -60 && power <= 15 ? power : null };
    });
    return { rows, measured: rows.filter(row => row.rx !== null).length };
  } catch (error) {
    if (/timed?\s*out|timeout|batas waktu|unreachable|epm|eacces|eperm/i.test(error.message)) {
      throw new Error('Tidak satu jaringan dengan OLT, izin LAN ditolak, atau SNMP tidak merespons.');
    }
    throw error;
  } finally { clearTimeout(timer); session.close(); }
}

async function readRouter(url, username, password) {
  const endpoint = new URL(url);
  if (!isPrivateIp(endpoint.hostname) || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username ||
      endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Isi origin HTTP atau HTTPS MikroTik dengan IPv4 privat.');
  }
  if (!username || !password) throw new Error('Isi akun REST baca MikroTik.');
  const headers = { Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
    'Content-Type': 'application/json' };
  async function get(path, body) {
    const result = await fetch(endpoint.origin + '/rest/' + path, {
      method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
      redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (!result.ok) throw new Error('MikroTik HTTP ' + result.status + '.');
    const data = await result.json();
    if (!Array.isArray(data)) throw new Error('MikroTik tidak mengembalikan daftar data.');
    return data;
  }
  const [sessions, interfaces, stats] = await Promise.all([
    get('ppp/active?.proplist=name,address,service,caller-id,uptime'),
    get('interface/pppoe-server?.proplist=name,user,running'),
    get('interface/print', { stats:'', '.query':['type=pppoe-in'], '.proplist':'name,rx-byte,tx-byte' }),
  ]);
  const active = sessions.filter(row => row.service === 'pppoe');
  const running = new Map(interfaces.filter(row => row.running === 'true').map(row => [row.user, row.name]));
  const counters = new Set(stats.filter(row => /^\d+$/.test(row['tx-byte']) && /^\d+$/.test(row['rx-byte'])).map(row => row.name));
  return { sessions: active.length, withCounters: active.filter(row => counters.has(running.get(row.name))).length };
}

module.exports = { localHttp, localUdp, sqlite, readOlt, readRouter, isPrivateIp };
