import http from 'node:http';

const profiles = new Map([
  ['192.168.0.97', { list: 'onuConfigOnuList.asp', pons: ['0/1/1', '0/1/2'], indexedPons: true }],
  ['192.168.0.98', { list: 'onuConfigOnuList.asp', pons: ['0/1/1', '0/1/2'], indexedPons: true }],
  ['192.168.0.99', { list: 'onuOverview.asp', pons: ['0/1', '0/2', '0/3', '0/4'] }],
]);
for (const [host, profile] of profiles) {
  const prefix = 'OLT_0' + host.split('.').at(-1) + '_ADMIN_';
  profile.username = process.env[prefix + 'USER'];
  profile.password = process.env[prefix + 'PASSWORD'];
}
const inFlight = new Set();

export function canRestart(host, bindHost) {
  const profile = profiles.get(host);
  return bindHost === '127.0.0.1' && Boolean(profile?.username && profile.password);
}

function oltRequest(origin, path, profile, body, referer) {
  return new Promise((resolve, reject) => {
    const request = http.request(origin + path, {
      method: body ? 'POST' : 'GET',
      auth: profile.username + ':' + profile.password,
      agent: false,
      signal: AbortSignal.timeout(7000),
      headers: body ? {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Origin: origin,
        Referer: origin + referer,
      } : {},
    }, response => {
      response.setEncoding('utf8');
      let html = '';
      response.on('data', chunk => {
        html += chunk;
        if (html.length > 1024 * 1024) request.destroy(new Error('Respons OLT terlalu besar.'));
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, html }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function findTargets(origin, profile, mac, deleting = false) {
  const targets = [];
  for (const pon of profile.pons) {
    const path = '/' + (deleting ? 'onuDeleteOnuList.asp' : profile.list) + '?oltponno=' + pon;
    const list = await oltRequest(origin, path, profile);
    const table = /var\s+(?:ponOnuTable|onutable)\s*=\s*new Array\(([\s\S]*?)\s*\);/.exec(list.html);
    if (list.status !== 200 || !table || /ASP Error/i.test(list.html) ||
        (deleting && (!/action\s*=\s*["']\/goform\/deleteOnu["']/i.test(list.html) ||
          !/myForm\.onuId\.value\s*=\s*ponOnuTable\[p\*\d+\+0\]/.test(list.html)))) {
      throw new Error('Daftar ONU tidak bisa dibaca.');
    }
    for (const [, id, listedMac, status] of table[1].matchAll(/^\s*'([\d/]+:\d+)'\s*,\s*'[^'\r\n]*'\s*,\s*'((?:[0-9A-F]{2}:){5}[0-9A-F]{2})'\s*,\s*'([^']*)'/gim)) {
      if (id.split(':')[0] === pon && listedMac.toUpperCase() === mac) targets.push({ id, pon, path, status });
    }
  }
  return targets;
}

function selectTarget(targets, profile, index, deleting, duplicateInInventory) {
  if (!deleting || !profile.indexedPons) {
    return targets.length === 1 && !(deleting && duplicateInInventory) ? targets[0] : null;
  }
  const [, port, onu] = /^1\.([1-9]\d*)\.([1-9]\d*)$/.exec(index) ?? [];
  const scoped = targets.filter(target => target.pon === '0/1/' + port && target.id === target.pon + ':' + onu);
  return scoped.length === 1 ? scoped[0] : null;
}

export async function restartRequest(req, res, devices, bindHost, port, audit, deleting = false) {
  let auditId;
  let attempted = false;
  function reply(status, message) {
    if (auditId != null) audit.finish(auditId, status, attempted);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message }));
    if (attempted && !deleting) audit.watch(host, index, mac);
  }
  if (req.socket.remoteAddress !== '127.0.0.1' ||
      !['127.0.0.1', 'localhost'].some(host => req.headers.host === host + ':' + port &&
        req.headers.origin === 'http://' + req.headers.host) ||
      req.headers['content-type'] !== 'application/json') {
    return reply(403, 'Restart langsung hanya tersedia dari dashboard lokal.');
  }
  let data;
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1024) return reply(413, 'Permintaan terlalu besar.');
    }
    data = JSON.parse(body);
  } catch {
    return reply(400, 'Permintaan tidak valid.');
  }
  const { host, index, mac, action, confirmation } = data ?? {};
  const operation = deleting ? 'delete' : 'reboot';
  if (!canRestart(host, bindHost) || typeof index !== 'string' || !/^\d+(?:\.\d+)+$/.test(index) ||
      typeof mac !== 'string' || !/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ||
      !['verify', operation].includes(action) || (action === 'delete' && confirmation !== mac)) {
    return reply(400, 'Target atau konfirmasi ONU tidak valid.');
  }
  if (action === operation) auditId = audit.begin(host, mac, operation, index);
  const device = devices.find(device => device.host === host);
  const rows = device?.rows.filter(row => row.index === index && row.mac === mac);
  if (rows?.length !== 1 || rows[0].status !== (deleting ? 'Offline' : 'Online') || !device.updated ||
      Date.now() - Date.parse(device.updated) > 240000) {
    return reply(409, 'Status ' + (deleting ? 'offline' : 'online') + ' target belum terverifikasi di inventaris.');
  }
  const key = host + '/' + mac;
  if (inFlight.has(key)) return reply(409, 'Permintaan untuk ONU ini masih diproses.');
  inFlight.add(key);
  const origin = 'http://' + host;
  const profile = profiles.get(host);
  try {
    const targets = await findTargets(origin, profile, mac, deleting);
    const duplicateInInventory = device.rows.filter(row => row.mac === mac).length > 1;
    const target = selectTarget(targets, profile, index, deleting, duplicateInInventory);
    if (!target) return reply(409, targets.length
      ? 'MAC terdaftar di beberapa ONU dan PON/ID target tidak bisa dipastikan.'
      : 'MAC tidak ditemukan di daftar PON OLT.');
    if (deleting && target.status !== 'Down') return reply(409, 'ONU harus berstatus Down pada daftar OLT.');
    const { id, pon } = target;
    const detail = '/onuConfig.asp?onuno=' + id + '&oltponno=' + pon;
    const check = await oltRequest(origin, detail, profile);
    if (check.status !== 200) return reply(502, 'Halaman ONU tidak bisa dibaca. HTTP ' + check.status + '.');
    const html = check.html;
    const fields = /var\s+onuinfo\s*=\s*new Array\(\s*'([^'\\]*)'\s*,\s*'([^'\\]*)'\s*,\s*'([^'\\]*)'\s*,\s*'(Up|Down)'/.exec(html);
    // Some firmware reports :0 in the detail array. The form submits onuno.
    const formId = /var\s+onuno\s*=\s*'([\d/]+:\d+)'/.exec(html)?.[1];
    if (!fields || formId !== id || !/onuForm\.onuId\.value\s*=\s*onuno\b/.test(html) ||
        fields[3].toUpperCase() !== mac || fields[4] !== (deleting ? 'Down' : 'Up') ||
        (!deleting && (!fields[2] || !/action\s*=\s*["']\/goform\/setOnu["']/i.test(html) || !html.includes('rebootOp')))) {
      return reply(409, 'MAC, status, atau formulir tidak cocok dengan data live OLT.');
    }
    if (action === 'verify') return reply(200, 'MAC dan status terverifikasi di ONU ' + id + '.');
    if (!devices.includes(device)) return reply(409, 'OLT sudah dihapus dari daftar pemantauan.');
    attempted = true;
    if (deleting) {
      const result = await oltRequest(origin, '/goform/deleteOnu', profile, new URLSearchParams({ onuId: id }).toString(), target.path);
      if (result.status < 400 && !(await findTargets(origin, profile, mac, true)).some(entry => entry.id === id)) {
        audit.removed(device, mac, index);
        return reply(200, 'Registrasi ONU ' + id + ' sudah terhapus dari OLT.');
      }
      return reply(502, 'Penghapusan belum terkonfirmasi. Periksa daftar ONU sebelum mencoba lagi.');
    }
    const body = new URLSearchParams({ onuId: id, onuName: fields[2], onuOperation: 'rebootOp' }).toString();
    const response = await oltRequest(origin, '/goform/setOnu', profile, body, detail);
    if (response.status === 200 && /Configure\s+Success!/i.test(response.html)) {
      return reply(200, 'OLT menerima perintah reboot. Pantau status ONU hingga kembali online.');
    }
    return reply(502, 'Hasil reboot belum terkonfirmasi. Periksa status ONU sebelum mencoba lagi.');
  } catch {
    return reply(502, attempted ? 'Hasil tindakan belum terkonfirmasi. Periksa status ONU sebelum mencoba lagi.'
      : 'Gagal memeriksa ONU melalui web admin OLT.');
  } finally {
    inFlight.delete(key);
  }
}
