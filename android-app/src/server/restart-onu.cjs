const http = require('node:http');
const crypto = require('node:crypto');

const defaultProfiles = new Map([
  ['192.168.0.97', { list: 'onuConfigOnuList.asp', pons: ['0/1/1', '0/1/2'], indexedPons: true }],
  ['192.168.0.98', { list: 'onuConfigOnuList.asp', pons: ['0/1/1', '0/1/2'], indexedPons: true }],
  ['192.168.0.99', { list: 'onuOverview.asp', pons: ['0/1', '0/2', '0/3', '0/4'] }],
]);

function getProfile(device) {
  const host = typeof device === 'string' ? device : device?.host;
  let profile = defaultProfiles.get(host);
  if (!profile) {
    // Default fallback for HiOSO 2-port or 4-port EPON (auto-detects 0/1/x vs 0/x)
    profile = { list: 'onuOverview.asp', pons: ['0/1', '0/2', '0/3', '0/4'], autoDetect: true };
  }
  const cloned = { ...profile };
  if (device && typeof device === 'object') {
    if (device.adminUser) cloned.username = device.adminUser;
    if (device.adminPassword) cloned.password = device.adminPassword;
  }
  if (!cloned.username || !cloned.password) {
    const prefix = 'OLT_0' + host.split('.').at(-1) + '_ADMIN_';
    cloned.username = cloned.username || process.env[prefix + 'USER'];
    cloned.password = cloned.password || process.env[prefix + 'PASSWORD'];
  }
  return cloned;
}

const inFlight = new Set();

function canRestart(deviceOrHost, bindHost) {
  const profile = getProfile(deviceOrHost);
  return bindHost === '127.0.0.1' && Boolean(profile?.username && profile.password);
}

function isHsgqDevice(device) {
  return Boolean(
    device &&
    (device.vendor === 'hsgq' || String(device.oids?.rx || '').startsWith('1.3.6.1.4.1.50224.'))
  );
}

function decodeHsgqIndex(index) {
  if (typeof index !== 'string' || !/^\d+$/.test(index)) return null;
  const n = Number(index);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  const portId = (n >>> 8) & 0xFF;
  const onuId = n & 0xFF;
  return portId >= 1 && onuId >= 1 ? { portId, onuId } : null;
}

function hsgqJsonRequest(origin, path, bodyObj = null, token = null) {
  return new Promise((resolve, reject) => {
    const body = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const headers = {};
    if (body != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (token) headers['X-Token'] = token;

    const request = http.request(origin + path, {
      method: body != null ? 'POST' : 'GET',
      agent: false,
      signal: AbortSignal.timeout(7000),
      headers,
    }, response => {
      response.setEncoding('utf8');
      let text = '';
      response.on('data', chunk => {
        text += chunk;
        if (text.length > 2 * 1024 * 1024) request.destroy(new Error('Respons OLT HSGQ terlalu besar.'));
      });
      response.on('error', reject);
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({
          status: response.statusCode,
          json,
          token: response.headers['x-token'] || null,
        });
      });
    });
    request.on('error', reject);
    if (body != null) request.end(body);
    else request.end();
  });
}

async function hsgqLogout(origin, username, token) {
  if (!token) return;
  try {
    await hsgqJsonRequest(origin, '/userlogin?form=logout', {
      method: 'set',
      param: { name: username },
    }, token);
  } catch {}
}

async function runHsgqAction({ origin, profile, device, devices, index, mac, action, deleting }) {
  const parsed = decodeHsgqIndex(index);
  if (!parsed) return { status: 400, message: 'Indeks ONU HSGQ tidak valid.' };
  const { portId, onuId } = parsed;
  const loginKey = crypto.createHash('md5')
    .update(profile.username + ':' + profile.password)
    .digest('hex');
  const loginValue = Buffer.from(profile.password, 'utf8').toString('base64');
  const login = await hsgqJsonRequest(origin, '/userlogin?form=login', {
    method: 'set',
    param: {
      name: profile.username,
      key: loginKey,
      value: loginValue,
      captcha_v: '',
      captcha_f: '',
    },
  });
  if (login.status !== 200 || !(login.json?.code === 1 || login.json?.code === 2) || !login.token) {
    return { status: 502, message: 'Login web admin OLT HSGQ gagal. Periksa user/password admin OLT.' };
  }

  let attempted = false;
  try {
    const tbl = await hsgqJsonRequest(origin, '/onutable', null, login.token);
    if (tbl.status !== 200 || tbl.json?.code !== 1 || !Array.isArray(tbl.json.data)) {
      return { status: 502, message: 'Daftar ONU OLT HSGQ tidak bisa dibaca.' };
    }
    const target = tbl.json.data.find(entry =>
      String(entry.macaddr || '').toUpperCase() === mac &&
      Number(entry.port_id) === portId &&
      Number(entry.onu_id) === onuId
    );
    if (!target) {
      return { status: 409, message: 'MAC dan Port/ONU tidak cocok dengan data live OLT HSGQ.' };
    }
    const isOnline = String(target.status || '').toLowerCase() === 'online';
    if (!deleting && !isOnline) {
      return { status: 409, message: 'ONU harus berstatus Online pada OLT HSGQ untuk direstart.' };
    }
    if (deleting && isOnline) {
      return { status: 409, message: 'ONU harus berstatus Offline pada OLT HSGQ untuk dihapus.' };
    }
    const label = 'PON ' + portId + ':' + onuId;
    if (action === 'verify') {
      return { status: 200, message: 'MAC dan status terverifikasi di ONU ' + label + '.' };
    }
    if (!devices.includes(device)) {
      return { status: 409, message: 'OLT sudah dihapus dari daftar pemantauan.' };
    }
    attempted = true;
    if (deleting) {
      const delRes = await hsgqJsonRequest(origin, '/onu_allow_list?form=onucfg', {
        method: 'delete',
        param: {
          port_id: portId,
          onu_id: onuId,
          macaddr: target.macaddr || mac.toLowerCase(),
        },
      }, login.token);
      if (delRes.status === 200 && delRes.json?.code === 1) {
        return {
          status: 200,
          message: 'Registrasi ONU ' + label + ' sudah terhapus dari OLT HSGQ.',
          attempted,
          removed: true,
        };
      }
      return {
        status: 502,
        message: 'Penghapusan ONU HSGQ belum terkonfirmasi. Periksa daftar ONU sebelum mencoba lagi.',
        attempted,
      };
    }
    const rebootRes = await hsgqJsonRequest(origin, '/onumgmt?form=config', {
      method: 'set',
      param: {
        port_id: portId,
        onu_id: onuId,
        flags: 1,
        fec_mode: 1,
      },
    }, login.token);
    if (rebootRes.status === 200 && rebootRes.json?.code === 1) {
      return {
        status: 200,
        message: 'OLT HSGQ menerima perintah reboot untuk ' + label + '. Pantau status ONU hingga kembali online.',
        attempted,
      };
    }
    return {
      status: 502,
      message: 'Hasil reboot HSGQ belum terkonfirmasi. Periksa status ONU sebelum mencoba lagi.',
      attempted,
    };
  } catch (err) {
    err.hsgqAttempted = attempted;
    throw err;
  } finally {
    await hsgqLogout(origin, profile.username, login.token);
  }
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

async function resolveHiosoProfile(origin, profile) {
  if (!profile.autoDetect) return profile;
  const overview = await oltRequest(origin, '/onuOverview.asp?oltponno=0/1', profile);
  const hasValidOverview = overview.status === 200 && !/ASP Error/i.test(overview.html);
  const table = hasValidOverview
    ? /var\s+(?:ponOnuTable|onutable)\s*=\s*new Array\(([\s\S]*?)\s*\);/.exec(overview.html)
    : null;
  const ids = table ? [...table[1].matchAll(/^\s*'([\d/]+:\d+)'/gm)].map(m => m[1]) : [];
  if (ids.some(id => /^\d+\/\d+\/\d+:\d+$/.test(id))) {
    return {
      ...profile,
      list: 'onuConfigOnuList.asp',
      pons: ['0/1/1', '0/1/2', '0/1/3', '0/1/4'],
      indexedPons: true,
      autoDetect: true,
    };
  }
  if (!ids.some(id => /^\d+\/\d+:\d+$/.test(id))) {
    try {
      const cfg = await oltRequest(origin, '/onuConfigOnuList.asp?oltponno=0/1/1', profile);
      const cfgTable = /var\s+(?:ponOnuTable|onutable)\s*=\s*new Array\(([\s\S]*?)\s*\);/.exec(cfg.html);
      if (cfg.status === 200 && cfgTable && !/ASP Error/i.test(cfg.html)) {
        return {
          ...profile,
          list: 'onuConfigOnuList.asp',
          pons: ['0/1/1', '0/1/2', '0/1/3', '0/1/4'],
          indexedPons: true,
          autoDetect: true,
        };
      }
    } catch {}
  }
  return {
    ...profile,
    list: 'onuOverview.asp',
    pons: ['0/1', '0/2', '0/3', '0/4'],
    indexedPons: false,
    autoDetect: true,
  };
}

async function findTargets(origin, profile, mac, deleting = false) {
  const targets = [];
  let validPages = 0;
  for (const pon of profile.pons) {
    const path = '/' + (deleting ? 'onuDeleteOnuList.asp' : profile.list) + '?oltponno=' + pon;
    const list = await oltRequest(origin, path, profile);
    const table = /var\s+(?:ponOnuTable|onutable)\s*=\s*new Array\(([\s\S]*?)\s*\);/.exec(list.html);
    if (list.status !== 200 || !table || /ASP Error/i.test(list.html) ||
        (deleting && (!/action\s*=\s*["']\/goform\/deleteOnu["']/i.test(list.html) ||
          !/myForm\.onuId\.value\s*=\s*ponOnuTable\[p\*\d+\+0\]/.test(list.html)))) {
      if (profile.autoDetect && validPages > 0) continue;
      throw new Error('Daftar ONU tidak bisa dibaca.');
    }
    validPages++;
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

async function restartRequest(req, res, devices, bindHost, port, audit, deleting = false) {
  let auditId;
  let attempted = false;
  let targetHost = '';
  let targetIndex = '';
  let targetMac = '';

  function reply(status, message) {
    if (auditId != null) audit.finish(auditId, status, attempted);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message }));
    if (attempted && !deleting && targetHost && targetIndex && targetMac) {
      audit.watch?.(targetHost, targetIndex, targetMac);
    }
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
  targetHost = host;
  targetIndex = index;
  targetMac = mac;
  const operation = deleting ? 'delete' : 'reboot';
  const device = devices.find(d => d.host === host);

  if (!canRestart(device || host, bindHost) || typeof index !== 'string' || !/^\d+(?:\.\d+)*$/.test(index) ||
      typeof mac !== 'string' || !/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ||
      !['verify', operation].includes(action) || (action === 'delete' && confirmation !== mac)) {
    return reply(400, 'Target atau konfirmasi ONU tidak valid.');
  }

  if (action === operation) auditId = audit.begin(host, mac, operation, index);

  const rows = device?.rows.filter(row => row.index === index && row.mac === mac);
  if (rows?.length !== 1 || rows[0].status !== (deleting ? 'Offline' : 'Online') || !device.updated ||
      Date.now() - Date.parse(device.updated) > 240000) {
    return reply(409, 'Status ' + (deleting ? 'offline' : 'online') + ' target belum terverifikasi di inventaris.');
  }

  const key = host + '/' + mac;
  if (inFlight.has(key)) return reply(409, 'Permintaan untuk ONU ini masih diproses.');
  inFlight.add(key);
  const origin = 'http://' + host + (device?.webPort ? ':' + device.webPort : '');
  const profile = getProfile(device || host);

  try {
    if (isHsgqDevice(device)) {
      const outcome = await runHsgqAction({
        origin, profile, device, devices, index, mac, action, deleting,
      });
      if (outcome.attempted) attempted = true;
      if (outcome.removed) audit.removed?.(device, mac, index);
      inFlight.delete(key);
      return reply(outcome.status, outcome.message);
    }

    const hiosoProfile = await resolveHiosoProfile(origin, profile);
    const targets = await findTargets(origin, hiosoProfile, mac, deleting);
    const duplicateInInventory = device.rows.filter(row => row.mac === mac).length > 1;
    const target = selectTarget(targets, hiosoProfile, index, deleting, duplicateInInventory);
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
      if (result.status < 400 && !(await findTargets(origin, hiosoProfile, mac, true)).some(entry => entry.id === id)) {
        audit.removed?.(device, mac, index);
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
  } catch (err) {
    if (err?.hsgqAttempted) attempted = true;
    inFlight.delete(key);
    return reply(502, attempted ? 'Hasil tindakan belum terkonfirmasi. Periksa status ONU sebelum mencoba lagi.'
      : 'Gagal memeriksa ONU melalui web admin OLT.');
  } finally {
    inFlight.delete(key);
  }
}

module.exports = {
  canRestart,
  restartRequest,
  isHsgqDevice,
  decodeHsgqIndex,
};
