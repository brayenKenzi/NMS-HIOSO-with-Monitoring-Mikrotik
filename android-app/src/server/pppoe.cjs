const { performance } = require('node:perf_hooks');
const { runRosApiCommands, probeRosApi, closeAllRosApiSessions } = require('./ros-api.cjs');

const pppoeInterval = 3000;
const routers = new Map();

function normalizeId(item, index) {
  return String(item.id || ('r-' + (index + 1)));
}

function makeRouterEntry(item, index = 0) {
  return {
    id: normalizeId(item, index),
    name: String(item.name || 'MikroTik ' + (index + 1)).trim(),
    url: item.url,
    username: item.username,
    password: item.password,
    oltHosts: Array.isArray(item.oltHosts) ? item.oltHosts.filter(Boolean) : [],
    active: [],
    previous: new Map(),
    sampledAt: null,
    error: null,
    polling: false,
    consecutiveFailures: 0,
    nextAllowedPollAt: 0,
  };
}

function updateRouterConfigs(list) {
  closeAllRosApiSessions();
  const valid = Array.isArray(list) ? list.filter(r => r?.url && r?.username && r?.password) : [];
  const nextIds = new Set();
  valid.forEach((item, index) => {
    const id = normalizeId(item, index);
    nextIds.add(id);
    const existing = routers.get(id);
    if (existing && existing.url === item.url && existing.username === item.username && existing.password === item.password) {
      existing.name = String(item.name || existing.name).trim();
      existing.oltHosts = Array.isArray(item.oltHosts) ? item.oltHosts.filter(Boolean) : [];
    } else {
      routers.set(id, makeRouterEntry({ ...item, id }, index));
    }
  });
  for (const id of routers.keys()) {
    if (!nextIds.has(id)) routers.delete(id);
  }
}

function initRouterConfigs(list, fallbackSingle) {
  if (Array.isArray(list) && list.length > 0) {
    updateRouterConfigs(list);
    return;
  }
  if (fallbackSingle?.url && fallbackSingle?.username && fallbackSingle?.password) {
    updateRouterConfigs([{ id: 'default', name: 'MikroTik Utama', ...fallbackSingle }]);
    return;
  }
  if (process.env.PPPOE_URL && process.env.PPPOE_USER && process.env.PPPOE_PASSWORD) {
    updateRouterConfigs([{
      id: 'env',
      name: 'MikroTik Utama',
      url: process.env.PPPOE_URL,
      username: process.env.PPPOE_USER,
      password: process.env.PPPOE_PASSWORD,
    }]);
    return;
  }
  routers.clear();
}

function initRouterConfig(config) {
  initRouterConfigs(null, config);
}

function updateRouterConfig(config) {
  if (config && config.url && config.username && config.password) {
    updateRouterConfigs([{ id: config.id || 'default', name: config.name || 'MikroTik Utama', ...config }]);
  } else {
    updateRouterConfigs([]);
  }
}

function getRouterConfigs() {
  return Array.from(routers.values()).map(r => ({
    id: r.id,
    name: r.name,
    url: r.url,
    username: r.username,
    oltHosts: r.oltHosts,
    configured: true,
    activeSessions: r.active.length,
    sampledAt: r.sampledAt,
    error: r.error,
    available: Boolean(r.sampledAt && !r.error && Date.now() - Date.parse(r.sampledAt) <= 45000),
  }));
}

function getRouterConfig() {
  const first = routers.values().next().value;
  if (!first) {
    return { url: '', username: '', configured: false, activeSessions: 0, sampledAt: null, error: null };
  }
  return {
    url: first.url,
    username: first.username,
    configured: true,
    activeSessions: first.active.length,
    sampledAt: first.sampledAt,
    error: first.error,
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

async function request(entry, path, body) {
  const url = new URL('/rest/' + path, entry.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL RouterOS tidak valid.');
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Basic ' + Buffer.from(entry.username + ':' + entry.password).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: body && JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(6000),
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

async function fetchRouterData(entry) {
  const parsed = new URL(entry.url);
  if (parsed.protocol === 'api:') {
    const host = parsed.hostname;
    const port = Number(parsed.port) || 8728;
    return runRosApiCommands(host, port, entry.username, entry.password, [
      ['/ppp/active/print', '=.proplist=.id,name,address,service,caller-id,session-id,uptime'],
      ['/interface/pppoe-server/print', '=.proplist=.id,name,user,running'],
      ['/interface/print', '=stats=', '?type=pppoe-in', '=.proplist=.id,name,rx-byte,tx-byte'],
    ], 6000);
  }
  return Promise.all([
    request(entry, 'ppp/active?.proplist=.id,name,address,service,caller-id,session-id,uptime'),
    request(entry, 'interface/pppoe-server?.proplist=.id,name,user,running'),
    request(entry, 'interface/print', {
      stats: '',
      '.query': ['type=pppoe-in'],
      '.proplist': '.id,name,rx-byte,tx-byte',
    }),
  ]);
}

async function pollSingleRouter(entry, force = false) {
  if (entry.polling) return;
  if (!force && entry.nextAllowedPollAt && Date.now() < entry.nextAllowedPollAt) return;
  entry.polling = true;
  try {
    const [sessions, interfaces, stats] = await fetchRouterData(entry);
    const now = performance.now();
    const bindings = group(interfaces.filter(row => row.running === 'true'), row => row.user);
    const counters = new Map(stats.map(row => [row.name, row]));
    const currentSessions = sessions.filter(row => row.service === 'pppoe');
    const byUser = group(currentSessions, row => row.name);
    const next = new Map();
    entry.active = currentSessions.map(row => {
      const links = bindings.get(row.name);
      const link = links?.length === 1 && byUser.get(row.name)?.length === 1 ? links[0] : null;
      const counter = link && counters.get(link.name);
      const tx = readCounter(counter?.['tx-byte']);
      const rx = readCounter(counter?.['rx-byte']);
      const id = row['session-id'] && row['.id'] && link?.['.id']
        ? JSON.stringify([row['session-id'], row['.id'], link['.id'], row.name, row['caller-id']]) : null;
      const prior = entry.previous.get(id);
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
        routerId: entry.id,
        routerName: entry.name,
        oltHosts: entry.oltHosts,
      };
    });
    entry.previous = next;
    entry.sampledAt = new Date().toISOString();
    entry.error = null;
    entry.consecutiveFailures = 0;
    entry.nextAllowedPollAt = 0;
  } catch (failure) {
    entry.previous.clear();
    entry.error = failure.message;
    entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
    // Smart backoff for unreachable off-site routers (10s..60s)
    entry.nextAllowedPollAt = Date.now() + Math.min(10000 * entry.consecutiveFailures, 60000);
  } finally {
    entry.polling = false;
  }
}

async function pollPppoe(force = false) {
  if (!routers.size) return;
  await Promise.allSettled(Array.from(routers.values(), r => pollSingleRouter(r, force)));
}

async function probeRouter(timeoutMs = 2000) {
  if (!routers.size) return false;
  const results = await Promise.all(Array.from(routers.values(), async (entry) => {
    try {
      const url = new URL(entry.url);
      if (url.protocol === 'api:') {
        return await probeRosApi(url.hostname, Number(url.port) || 8728, entry.username, entry.password, timeoutMs);
      }
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      const target = new URL('/rest/system/identity', url);
      const res = await fetch(target, {
        method: 'GET',
        headers: {
          Authorization: 'Basic ' + Buffer.from((entry.username ?? '') + ':' + (entry.password ?? '')).toString('base64'),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok || res.status === 401;
    } catch {
      return false;
    }
  }));
  return results.some(Boolean);
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

function buildMatcher(inventory, sessions) {
  const exactSessions = group(sessions, s => s.mac);
  const onlineExactMacs = new Set(
    inventory.filter(r => r.status === 'Online').map(r => macKey(r.mac)).filter(Boolean)
  );
  const exactMatchedMacs = new Set();
  for (const row of inventory) {
    const full = macKey(row.mac);
    if (full && exactSessions.has(full)) exactMatchedMacs.add(full);
  }

  const residualSessions = sessions.filter(s => s.mac && !exactMatchedMacs.has(s.mac));
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

  return function matchRow(row) {
    const full = macKey(row.mac);
    if (!full) return { state: 'unmatched' };

    const exact = exactSessions.get(full);
    if (exact?.length) {
      if (row.status === 'Offline' && onlineExactMacs.has(full)) {
        return { state: 'unmatched' };
      }
      if (exact.length === 1) {
        return { ...exact[0], state: 'exact' };
      }
      const byName = disambiguateByName(row.name, exact);
      return byName ? { ...byName, state: 'exact' } : { state: 'ambiguous' };
    }

    const prefix = full.slice(0, 10);
    const cand = residualSessionPrefixes.get(prefix);
    if (!cand?.length) return { state: 'unmatched' };

    const onlinePeers = residualInvOnlinePrefixes.get(prefix) ?? [];
    const allPeers = residualInvAllPrefixes.get(prefix) ?? [];
    if (row.status === 'Offline' && onlinePeers.length > 0) {
      return { state: 'unmatched' };
    }
    const peerCount = onlinePeers.length > 0 ? onlinePeers.length : allPeers.length;
    if (cand.length === 1 && peerCount <= 1) {
      return { ...cand[0], state: 'prefix' };
    }

    const byName = disambiguateByName(row.name, cand);
    if (byName) return { ...byName, state: 'prefix' };
    return { state: 'ambiguous' };
  };
}

function pppoeView(devices, override = null) {
  const routerList = Array.from(routers.values());
  const isConfigured = override?.configured ?? routerList.length > 0;
  const now = Date.now();
  const availableRouters = routerList.filter(r => r.sampledAt && !r.error && now - Date.parse(r.sampledAt) <= 45000);
  const isAvailable = override?.available ?? (isConfigured && availableRouters.length > 0);
  const activeList = override?.active ?? (isAvailable ? availableRouters.flatMap(r => r.active) : []);
  const latestSample = availableRouters.map(r => r.sampledAt).sort().at(-1) ?? null;
  const allErrors = routerList.filter(r => r.error).map(r => r.name + ': ' + r.error);
  const statusError = isAvailable || !allErrors.length ? null : allErrors.join(' | ');
  const inventoryReady = devices.some(device => device.rows.some(row => row.mac));
  const routerSummaries = routerList.map(r => ({
    id: r.id,
    name: r.name,
    activeSessions: r.active.length,
    available: Boolean(r.sampledAt && !r.error && now - Date.parse(r.sampledAt) <= 45000),
    error: r.error,
  }));

  const matchersByHost = new Map();
  function getMatcher(deviceHost) {
    const key = deviceHost || '__all__';
    if (matchersByHost.has(key)) return matchersByHost.get(key);
    const scopedSessions = !isAvailable ? [] : activeList.filter(s =>
      !Array.isArray(s.oltHosts) || !s.oltHosts.length || !deviceHost || s.oltHosts.includes(deviceHost)
    );
    const scopedInventory = deviceHost && activeList.some(s => Array.isArray(s.oltHosts) && s.oltHosts.includes(deviceHost))
      ? devices.filter(d => d.host === deviceHost).flatMap(d => d.rows)
      : devices.flatMap(d => d.rows);
    const matcher = buildMatcher(scopedInventory, scopedSessions);
    matchersByHost.set(key, matcher);
    return matcher;
  }

  return {
    status: {
      configured: isConfigured,
      sampledAt: latestSample,
      available: Boolean(isAvailable),
      error: statusError,
      inventoryReady,
      intervalMs: pppoeInterval,
      routers: routerSummaries,
    },
    match(row, deviceHost = null) {
      if (!isAvailable || !inventoryReady) return { state: 'unavailable' };
      return getMatcher(deviceHost)(row);
    },
  };
}

module.exports = {
  pppoeInterval,
  initRouterConfig,
  updateRouterConfig,
  getRouterConfig,
  initRouterConfigs,
  updateRouterConfigs,
  getRouterConfigs,
  probeRouter,
  pollPppoe,
  pppoeView,
  closeRouters: () => closeAllRosApiSessions(),
};
