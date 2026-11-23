function getBaseUrl(overrideUrl) {
  const raw = overrideUrl ?? process.env.GENIEACS_URL ?? '';
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  return trimmed || null;
}

function isConfigured(overrideUrl) {
  return Boolean(getBaseUrl(overrideUrl));
}

function readVal(node) {
  if (!node || typeof node !== 'object') return undefined;
  return '_value' in node ? node._value : undefined;
}

function toInt(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function walkLeaves(node, prefix, visitor) {
  if (!node || typeof node !== 'object') return;
  if ('_value' in node) {
    visitor(prefix, node._value);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('_')) continue;
    walkLeaves(v, prefix ? prefix + '.' + k : k, visitor);
  }
}

function normalizeMac(value) {
  const clean = String(value ?? '').toUpperCase().replace(/[^0-9A-F]/g, '');
  return /^[0-9A-F]{12}$/.test(clean) && clean !== '000000000000' && clean !== 'FFFFFFFFFFFF' ? clean : null;
}

function formatMac(clean) {
  return clean ? clean.match(/../g).join(':') : null;
}

async function nbiRequest(baseUrl, path, { method = 'GET', body, timeoutMs = 6000 } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { status: res.status, ok: res.ok, data };
}

const SUMMON_COOLDOWN_MS = 15000;
const summonCooldown = new Map();

function detectWifiPaths(doc) {
  const wlan1 = doc?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1'];
  const prefix = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1';
  let passwordPath = prefix + '.KeyPassphrase';
  if (wlan1?.PreSharedKey?.['1']?.KeyPassphrase) {
    passwordPath = prefix + '.PreSharedKey.1.KeyPassphrase';
  } else if (wlan1?.PreSharedKey?.['1']?.PreSharedKey) {
    passwordPath = prefix + '.PreSharedKey.1.PreSharedKey';
  } else if (wlan1?.KeyPassphrase) {
    passwordPath = prefix + '.KeyPassphrase';
  }
  return {
    ssidPath: prefix + '.SSID',
    passwordPath,
    hasExplicitPasswordNode: Boolean(
      wlan1?.PreSharedKey?.['1']?.KeyPassphrase ||
      wlan1?.PreSharedKey?.['1']?.PreSharedKey ||
      wlan1?.KeyPassphrase
    ),
  };
}

function extractClients(doc) {
  const byMac = new Map();
  const listNoMac = [];
  const lan1 = doc?.InternetGatewayDevice?.LANDevice?.['1'];

  const upsert = (entry) => {
    const clean = normalizeMac(entry.mac);
    if (!clean) {
      if (entry.ip || entry.name) listNoMac.push(entry);
      return;
    }
    const formatted = formatMac(clean);
    const prev = byMac.get(clean) || {};
    byMac.set(clean, {
      mac: formatted,
      name: entry.name || prev.name || null,
      ip: entry.ip || prev.ip || null,
      rssi: entry.rssi ?? prev.rssi ?? null,
      iface: entry.iface || prev.iface || null,
    });
  };

  const assoc = lan1?.WLANConfiguration?.['1']?.AssociatedDevice;
  if (assoc && typeof assoc === 'object') {
    for (const [k, item] of Object.entries(assoc)) {
      if (k.startsWith('_') || !item || typeof item !== 'object') continue;
      const mac = readVal(item.AssociatedDeviceMACAddress);
      const ip = readVal(item.AssociatedDeviceIPAddress);
      const name = readVal(item.AssociatedDeviceName) || readVal(item.HostName);
      const rssiRaw =
        readVal(item.X_HW_RSSI) ??
        readVal(item.RSSI) ??
        readVal(item.SignalStrength) ??
        readVal(item['X_ZTE-COM_RSSI']);
      const rssi = Number.isFinite(Number(rssiRaw)) ? Number(rssiRaw) : null;
      if (mac || ip) upsert({ mac, ip, name, rssi, iface: 'Wi-Fi' });
    }
  }

  const hosts = lan1?.Hosts?.Host;
  if (hosts && typeof hosts === 'object') {
    for (const [k, item] of Object.entries(hosts)) {
      if (k.startsWith('_') || !item || typeof item !== 'object') continue;
      const active = readVal(item.Active);
      const isActive = active === true || active === 'true' || active === 1 || active === '1';
      if (!isActive) continue;
      const mac = readVal(item.MACAddress);
      const ip = readVal(item.IPAddress);
      const name = readVal(item.HostName);
      const iface = readVal(item.InterfaceType) || null;
      if (mac || ip) upsert({ mac, ip, name, rssi: null, iface });
    }
  }

  return [...byMac.values(), ...listNoMac];
}

function extractDeviceSummary(doc) {
  const devId = doc?._deviceId || {};
  const wlan1 = doc?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1'];
  const vp = doc?.VirtualParameters || {};
  const ssidRaw = readVal(wlan1?.SSID) ?? readVal(vp.WlanSSID);
  const ssid = ssidRaw != null && String(ssidRaw).trim() ? String(ssidRaw) : null;
  const totalAssoc = toInt(
    readVal(wlan1?.TotalAssociations) ??
    readVal(vp.userconnected) ??
    readVal(vp.activedevices)
  );
  const clients = extractClients(doc);
  const activeClientsCount = Math.max(clients.length, totalAssoc ?? 0);
  const { passwordPath } = detectWifiPaths(doc);

  let pppoeUsername = null;
  walkLeaves(doc?.InternetGatewayDevice?.WANDevice, '', (path, val) => {
    if (!pppoeUsername && /\.WANPPPConnection\.[^.]+\.Username$/i.test(path) && val) {
      pppoeUsername = String(val).trim();
    }
  });
  if (!pppoeUsername) {
    for (const k of ['pppoeUsername', 'pppoeUsername2', 'pppUsername']) {
      const v = readVal(vp[k]);
      if (v && String(v).trim()) { pppoeUsername = String(v).trim(); break; }
    }
  }

  return {
    id: doc._id,
    manufacturer: devId._Manufacturer || null,
    productClass: devId._ProductClass || null,
    serialNumber: devId._SerialNumber || null,
    lastInform: doc._lastInform || null,
    pppoeUsername,
    ssid,
    totalAssociations: totalAssoc,
    activeClientsCount,
    clients,
    passwordPath,
  };
}

function scoreDeviceMatch(doc, targetUser, targetMac) {
  let score = 0;
  if (targetUser) {
    const vp = doc?.VirtualParameters || {};
    for (const k of ['pppoeUsername', 'pppoeUsername2', 'pppUsername']) {
      const v = String(readVal(vp[k]) || '').trim().toLowerCase();
      if (v && v === targetUser) score = Math.max(score, 3);
    }
    if (score < 3) {
      walkLeaves(doc?.InternetGatewayDevice?.WANDevice, '', (path, val) => {
        if (/\.Username$/i.test(path) && String(val || '').trim().toLowerCase() === targetUser) {
          score = Math.max(score, 3);
        }
      });
    }
  }

  if (targetMac && score < 3) {
    const targetPrefix = targetMac.slice(0, 10);
    const candidates = [];
    const vp = doc?.VirtualParameters || {};
    for (const k of ['MacAddress', 'PonMac', 'pppoeMac']) {
      const m = normalizeMac(readVal(vp[k]));
      if (m) candidates.push(m);
    }
    walkLeaves(doc?.InternetGatewayDevice, '', (path, val) => {
      if (/(?:MACAddress|BSSID)$/i.test(path)) {
        const m = normalizeMac(val);
        if (m) candidates.push(m);
      }
    });
    if (candidates.includes(targetMac)) score = Math.max(score, 2);
    else if (candidates.some(m => m.slice(0, 10) === targetPrefix)) score = Math.max(score, 1);
  }

  return score;
}

async function findDevice({ pppoeUsername, mac, baseUrl: overrideUrl } = {}) {
  const baseUrl = getBaseUrl(overrideUrl);
  if (!baseUrl) return null;
  const targetUser = String(pppoeUsername || '').trim().toLowerCase();
  const targetMac = normalizeMac(mac);
  if (!targetUser && !targetMac) return null;

  const projection = [
    '_id',
    '_deviceId',
    '_lastInform',
    'VirtualParameters',
    'InternetGatewayDevice.WANDevice',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1',
    'InternetGatewayDevice.LANDevice.1.Hosts',
  ].join(',');

  const res = await nbiRequest(baseUrl, '/devices?projection=' + encodeURIComponent(projection), { timeoutMs: 6000 });
  if (!res.ok || !Array.isArray(res.data)) {
    throw new Error('Gagal membaca daftar perangkat GenieACS (HTTP ' + res.status + ').');
  }

  const scored = [];
  for (const doc of res.data) {
    const s = scoreDeviceMatch(doc, targetUser, targetMac);
    if (s > 0) scored.push({ doc, score: s, informAt: Date.parse(doc._lastInform || '') || 0 });
  }
  if (!scored.length) return null;

  scored.sort((a, b) => (b.score - a.score) || (b.informAt - a.informAt));
  const best = scored[0];
  // Avoid ambiguous 10-char MAC prefix matches across multiple devices
  if (best.score === 1 && scored.filter(x => x.score === 1).length > 1) {
    return null;
  }
  return best.doc;
}

async function fetchDeviceById(deviceId, baseUrl) {
  const query = JSON.stringify({ _id: deviceId });
  const res = await nbiRequest(baseUrl, '/devices?query=' + encodeURIComponent(query), { timeoutMs: 5000 });
  if (!res.ok || !Array.isArray(res.data) || !res.data.length) return null;
  return res.data[0];
}

async function summonDevice(deviceId, { force = false, baseUrl: overrideUrl } = {}) {
  const baseUrl = getBaseUrl(overrideUrl);
  if (!baseUrl || !deviceId) return { live: false, queued: false };
  const key = baseUrl + '/' + deviceId;
  const now = Date.now();
  if (!force && now - (summonCooldown.get(key) || 0) < SUMMON_COOLDOWN_MS) {
    return { live: false, queued: false, cached: true };
  }
  summonCooldown.set(key, now);

  const encodedId = encodeURIComponent(deviceId);
  let live = false;
  let queued = false;

  try {
    const r1 = await nbiRequest(baseUrl, `/devices/${encodedId}/tasks?timeout=8000&connection_request`, {
      method: 'POST',
      body: {
        name: 'getParameterValues',
        parameterNames: [
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDevice.',
          'InternetGatewayDevice.LANDevice.1.Hosts.Host.',
        ],
      },
      timeoutMs: 9500,
    });
    if (r1.status === 200) live = true;
    else if (r1.status === 202) queued = true;
  } catch {}

  return { live, queued };
}

async function getClientModem({ pppoeUsername, mac, summon = true, force = false, baseUrl: overrideUrl } = {}) {
  const baseUrl = getBaseUrl(overrideUrl);
  if (!baseUrl) return { configured: false, found: false };

  const matched = await findDevice({ pppoeUsername, mac, baseUrl });
  if (!matched) return { configured: true, found: false };

  let summonResult = { live: false, queued: false };
  let latestDoc = matched;
  if (summon) {
    summonResult = await summonDevice(matched._id, { force, baseUrl });
    const refreshed = await fetchDeviceById(matched._id, baseUrl).catch(() => null);
    if (refreshed) latestDoc = refreshed;
  }

  return {
    configured: true,
    found: true,
    summonResult,
    device: extractDeviceSummary(latestDoc),
  };
}

async function updateWifi(deviceId, { ssid, password, baseUrl: overrideUrl } = {}) {
  const baseUrl = getBaseUrl(overrideUrl);
  if (!baseUrl) {
    const err = new Error('GenieACS belum dikonfigurasi di server.');
    err.status = 501;
    throw err;
  }

  const cleanSsid = typeof ssid === 'string' ? ssid.trim() : '';
  const hasPassword = typeof password === 'string' && password.length > 0;
  if (cleanSsid.length > 32) {
    const err = new Error('SSID Wi-Fi maksimal 32 karakter.');
    err.status = 400;
    throw err;
  }
  if (hasPassword && (password.length < 8 || password.length > 63)) {
    const err = new Error('Password Wi-Fi harus 8 sampai 63 karakter.');
    err.status = 400;
    throw err;
  }
  if (!cleanSsid && !hasPassword) {
    const err = new Error('Isi SSID baru atau Password Wi-Fi baru (minimal salah satu).');
    err.status = 400;
    throw err;
  }

  let doc = await fetchDeviceById(deviceId, baseUrl);
  if (!doc) {
    const err = new Error('Perangkat modem tidak ditemukan di GenieACS.');
    err.status = 404;
    throw err;
  }

  let paths = detectWifiPaths(doc);
  if (hasPassword && !paths.hasExplicitPasswordNode) {
    try {
      await nbiRequest(baseUrl, `/devices/${encodeURIComponent(deviceId)}/tasks?timeout=6000&connection_request`, {
        method: 'POST',
        body: {
          name: 'getParameterValues',
          parameterNames: [
            'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
            'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
            'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey',
          ],
        },
        timeoutMs: 7500,
      });
      const fresh = await fetchDeviceById(deviceId, baseUrl);
      if (fresh) {
        doc = fresh;
        paths = detectWifiPaths(doc);
      }
    } catch {}
  }

  const parameterValues = [];
  if (cleanSsid) parameterValues.push([paths.ssidPath, cleanSsid, 'xsd:string']);
  if (hasPassword) parameterValues.push([paths.passwordPath, password, 'xsd:string']);

  const res = await nbiRequest(baseUrl, `/devices/${encodeURIComponent(deviceId)}/tasks?timeout=10000&connection_request`, {
    method: 'POST',
    body: { name: 'setParameterValues', parameterValues },
    timeoutMs: 11500,
  });

  if (!res.ok) {
    const err = new Error('GenieACS menolak perintah ubah Wi-Fi (HTTP ' + res.status + ').');
    err.status = 502;
    throw err;
  }

  summonCooldown.delete(baseUrl + '/' + deviceId);
  return {
    ok: true,
    live: res.status === 200,
    queued: res.status === 202,
    deviceId,
    ssid: cleanSsid || null,
    passwordUpdated: hasPassword,
    passwordPath: paths.passwordPath,
  };
}

module.exports = {
  isConfigured,
  getBaseUrl,
  findDevice,
  summonDevice,
  extractDeviceSummary,
  getClientModem,
  updateWifi,
};
