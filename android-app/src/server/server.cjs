const http = require('node:http');
const { readFileSync, writeFileSync, renameSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { isIPv4 } = require('node:net');
const snmp = require('net-snmp');

const { openStore } = require('./store.cjs');
const { createRoutes, json } = require('./routes.cjs');
const { canRestart, restartRequest } = require('./restart-onu.cjs');
const routerModule = require('./pppoe.cjs');
const { page, operations, worker, logo } = require('./static-assets.cjs');
const { supabase } = require('./supabase.cjs');

const root = '1.3.6.1.4.1.25355.3.2.6';
const defaultOids = {
  name: root + '.3.2.1.37',
  status: root + '.3.2.1.39',
  rx: root + '.14.2.1.8',
  mac: root + '.3.2.1.11',
};

function createNmsServer(dataDir, options = {}) {
  const dbPath = join(dataDir, 'nms-data.sqlite');
  const configPath = join(dataDir, 'olts.json');
  const store = openStore(dbPath);

  // Initialize router configuration
  const storedRouter = store.getRouterConfig();
  routerModule.initRouterConfig(storedRouter || options.routerConfig);

  // Initialize OLT list from disk or seeds
  let config = [];
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
    catch { config = []; }
  } else if (options.seedOlts && Array.isArray(options.seedOlts)) {
    config = options.seedOlts;
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  const META_REFRESH_MS = 10 * 60 * 1000; // Refresh static ONU Name & MAC every 10 minutes

  function makeDevice(device) {
    if (!isIPv4(device.host) || !device.name || !(device.communityEnv || device.community)) {
      throw new Error('Isi nama, IPv4, dan community baca untuk setiap OLT.');
    }
    const cached = store.loadOltCache(device.host);
    const metaNames = new Map();
    const metaMacs = new Map();
    if (cached && cached.rows.length > 0) {
      for (const r of cached.rows) {
        if (r.index != null) {
          if (r.name) metaNames.set(r.index, r.name);
          if (r.mac) metaMacs.set(r.index, r.mac.replaceAll(':', '').toUpperCase());
        }
      }
    }
    return {
      ...device,
      rows: cached ? cached.rows : [],
      updated: cached ? cached.updated : null,
      error: null,
      polling: false,
      metaNames,
      metaMacs,
      // If hydrated from SQLite cache, run fast 2-column poll first on startup,
      // then refresh Name & MAC ~60s later in the background.
      metaUpdatedAt: metaNames.size > 0 ? Date.now() - META_REFRESH_MS + 60000 : 0,
      maxRep: 15,
      consecutiveSuccess: 0,
    };
  }

  const devices = [];
  let isStopped = false;
  const retryTimers = new Set();
  for (const item of config) {
    try { devices.push(makeDevice(item)); } catch (e) { console.error('Skip invalid OLT:', e.message); }
  }

  const communityFor = device => device.community ?? (device.communityEnv ? process.env[device.communityEnv] : null);

  // Paced getBulk walk — reuses a single UDP SNMP session per column and
  // adapts batch size + pause so HiOSO OLT agents stay fast and stable.
  function readColumnPaced(host, community, port, oid, opts = {}) {
    const {
      timeout = 3500,
      retries = 2,
      maxRep = 15,
      pauseMs = 20,
      signal = { aborted: false },
    } = opts;
    return new Promise((resolve, reject) => {
      const values = new Map();
      let currentOid = oid;
      let count = 0;
      let settled = false;
      const session = snmp.createSession(host, community, {
        version: snmp.Version2c, port, timeout, retries,
      });

      function finish(err, result) {
        if (settled) return;
        settled = true;
        try { session.close(); } catch {}
        if (err) reject(err);
        else resolve(result);
      }

      function step() {
        if (isStopped || signal.aborted) {
          return finish(new Error('Polling dibatalkan.'));
        }
        session.getBulk([currentOid], 0, maxRep, (err, vbs) => {
          if (isStopped || signal.aborted) {
            return finish(new Error('Polling dibatalkan.'));
          }
          if (err) return finish(err);
          const list = vbs[0] || [];
          if (!list.length) return finish(null, values);
          let done = false;
          for (const vb of list) {
            if (snmp.isVarbindError(vb) ||
                vb.type === snmp.ObjectType.EndOfMibView ||
                !vb.oid.startsWith(oid + '.')) {
              done = true;
              break;
            }
            const idx = vb.oid.slice(oid.length + 1);
            values.set(idx, String(vb.value).trim());
            currentOid = vb.oid;
            if (++count > 4096) {
              return finish(new Error('Batas pembacaan kolom ONU terlampaui.'));
            }
          }
          if (done) return finish(null, values);
          const t = setTimeout(() => {
            retryTimers.delete(t);
            step();
          }, pauseMs);
          retryTimers.add(t);
        });
      }
      step();
    });
  }

  async function tryRestartOltSnmp(device, force = false) {
    if (!device.adminUser || !device.adminPassword) {
      return { ok: false, message: 'Kredensial admin web OLT belum diatur.' };
    }
    const now = Date.now();
    if (!force && device.lastSnmpRestart && now - device.lastSnmpRestart < 300000) {
      return { ok: false, message: 'Baru saja dijalankan. Tunggu sebentar sebelum restart ulang.' };
    }
    device.lastSnmpRestart = now;
    try {
      const auth = 'Basic ' + Buffer.from(device.adminUser + ':' + device.adminPassword).toString('base64');
      const res = await fetch(`http://${device.host}/goform/setSnmpRestart`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { ok: false, message: 'Web admin OLT merespons HTTP ' + res.status };
      }
      console.log('Restarted SNMP agent on OLT ' + device.host);
      return { ok: true, message: 'Perintah restart SNMP diterima.' };
    } catch (err) {
      return { ok: false, message: err.message || 'Gagal menghubungi web admin OLT.' };
    }
  }

  async function poll(device, opts = {}) {
    if (device.polling) return;
    device.polling = true;
    const signal = { aborted: false };
    device.pollSignal = signal;
    let deadline;
    try {
      const community = communityFor(device);
      if (!community) throw new Error('Community baca belum diisi.');
      const port = device.port ?? 161;
      const host = device.host;
      const oids = { ...defaultOids, ...device.oids };
      const maxRep = device.maxRep ?? 15;
      const pauseMs = maxRep >= 12 ? 20 : 40;
      const walkOpts = { timeout: 3500, retries: 2, maxRep, pauseMs, signal };

      // 2-Tier Sequential Polling:
      // Always poll dynamic columns (Status + RX).
      // Poll static columns (Name + MAC) only on first run, every 10 min, or when new ONU index appears.
      const readCol = oid => readColumnPaced(host, community, port, oid, walkOpts);
      const columns = (async () => {
        const states = await readCol(oids.status);
        const powers = await readCol(oids.rx);

        let hasNewIndex = false;
        if (device.metaNames && device.metaNames.size > 0) {
          for (const idx of states.keys()) {
            if (!device.metaNames.has(idx)) { hasNewIndex = true; break; }
          }
        }
        const skipMeta = Boolean(opts.forceFast) && Boolean(device.metaNames?.size);
        const needMeta = !skipMeta && (
          !device.metaUpdatedAt ||
          (Date.now() - device.metaUpdatedAt >= META_REFRESH_MS) ||
          !device.metaNames?.size ||
          hasNewIndex
        );

        let names = device.metaNames || new Map();
        let macs = device.metaMacs || new Map();
        if (needMeta) {
          names = await readCol(oids.name);
          macs = await readCol(oids.mac).catch(() => device.metaMacs || new Map());
          device.metaNames = names;
          device.metaMacs = macs;
          device.metaUpdatedAt = Date.now();
        }
        return [names, states, powers, macs];
      })();
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(() => {
          signal.aborted = true;
          reject(new Error('Batas waktu polling terlampaui.'));
        }, 180000);
      });
      const [names, states, powers, macs] = await Promise.race([columns, timeout]);
      if (!names.size && !states.size && !powers.size) {
        throw new Error('Tabel ONU kosong. Periksa OID firmware atau registrasi ONU.');
      }
      const indexSet = states.size || powers.size
        ? new Set([...states.keys(), ...powers.keys()])
        : new Set([...names.keys()]);
      device.rows = [...indexSet].map((index) => {
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
      device.consecutiveFailures = 0;
      device.consecutiveSuccess = (device.consecutiveSuccess || 0) + 1;
      if (device.consecutiveSuccess >= 3 && (device.maxRep ?? 15) < 15) {
        device.maxRep = Math.min(15, (device.maxRep ?? 10) + 1);
        device.consecutiveSuccess = 0;
      }
      device.error = powers.size ? null : 'Data redaman kosong. Periksa OID daya optik firmware.';
      try { store.saveOltCache(device.host, device.rows, device.updated); } catch {}
    } catch (error) {
      device.pollFailed = true;
      device.consecutiveSuccess = 0;
      device.consecutiveFailures = (device.consecutiveFailures || 0) + 1;
      if (/timed out|terlampaui/i.test(error.message)) {
        device.maxRep = Math.max(8, (device.maxRep ?? 15) - 3);
      }
      device.error = error.message;
      if (device.consecutiveFailures >= 3 && /timed out|terlampaui/i.test(error.message)) {
        void tryRestartOltSnmp(device);
      }
    } finally {
      signal.aborted = true;
      clearTimeout(deadline);
      device.polling = false;
      device.lastPollEnd = Date.now();
      if (store && devices.includes(device)) {
        try { store.recordPoll(device); }
        catch (error) { console.error('Gagal menyimpan hasil pemantauan:', error.message); }
      }
      if (!isStopped && device.pollFailed && devices.includes(device)) {
        const delay = Math.min(5000 * Math.max(1, device.consecutiveFailures || 1), 30000);
        const timer = setTimeout(() => {
          retryTimers.delete(timer);
          if (!isStopped && !device.polling && devices.includes(device)) void poll(device);
        }, delay);
        retryTimers.add(timer);
      }
    }
  }

  function listOlts() {
    return devices.map(({ name, host, port = 161, updated, error, polling }) =>
      ({ name, host, port, updated, error, polling }));
  }

  function listOltsFull() {
    return config;
  }

  function abortAllPolls() {
    for (const dev of devices) {
      if (dev.pollSignal) dev.pollSignal.aborted = true;
    }
  }

  function oltSignature(list) {
    return JSON.stringify(list.map(o => ({
      name: o.name,
      host: o.host,
      community: o.community,
      port: Number(o.port || 161),
      adminUser: o.adminUser || null,
      adminPassword: o.adminPassword || null,
      oids: o.oids || null,
      rxDivider: o.rxDivider ? Number(o.rxDivider) : 1,
    })).sort((a, b) => a.host.localeCompare(b.host)));
  }

  async function syncOltsFromCloud() {
    try {
      const cloudOlts = await supabase.getOlts();
      if (Array.isArray(cloudOlts) && cloudOlts.length > 0) {
        const mapped = cloudOlts.map(o => ({
          name: o.name,
          host: o.host,
          community: o.community,
          port: Number(o.port || 161),
          adminUser: o.admin_user || undefined,
          adminPassword: o.admin_password || undefined,
          oids: o.oids || undefined,
          rxDivider: o.rx_divider ? Number(o.rx_divider) : undefined,
        }));
        // Skip full reset if OLT list is identical — prevents double-polling on startup
        if (devices.length > 0 && oltSignature(config) === oltSignature(mapped)) {
          console.log('Cloud OLTs unchanged (' + mapped.length + ' OLTs), keeping active polls.');
          return;
        }
        console.log('Syncing ' + cloudOlts.length + ' OLTs from Supabase...');
        config = mapped;
        try { writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8'); } catch {}
        abortAllPolls();
        devices.length = 0;
        for (const item of config) {
          try {
            const dev = makeDevice(item);
            devices.push(dev);
            void poll(dev);
          } catch {}
        }
      } else if (Array.isArray(cloudOlts) && cloudOlts.length === 0 && config.length > 0) {
        void supabase.replaceAllOlts(config).catch(e => console.warn('Supabase initial seed OLTs:', e.message));
      }
    } catch (err) {
      console.warn('Sync cloud OLTs skipped/offline:', err.message);
    }
  }

  function importAllOlts(newOlts) {
    if (!Array.isArray(newOlts)) return;
    config = newOlts;
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    abortAllPolls();
    devices.length = 0;
    for (const item of config) {
      try {
        const dev = makeDevice(item);
        devices.push(dev);
        void poll(dev);
      } catch {}
    }
    if (newOlts.length > 0) {
      void supabase.replaceAllOlts(newOlts).catch(e => console.warn('Supabase replace all olts:', e.message));
    }
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
      const adminUser = data.adminUser ? String(data.adminUser).trim() : undefined;
      const adminPassword = data.adminPassword ? String(data.adminPassword).trim() : undefined;
      if (!name || name.length > 80 || typeof community !== 'string' || !community.trim() || community.length > 128 ||
          !Number.isInteger(port) || port < 1 || port > 65535) {
        return [400, 'Isi nama OLT, community baca, dan port UDP yang valid.'];
      }
      const newEntry = { name, host, community, port };
      if (adminUser) newEntry.adminUser = adminUser;
      if (adminPassword) newEntry.adminPassword = adminPassword;
      added = makeDevice(newEntry);
      next = [...config, newEntry];
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
      void supabase.upsertOlt(added).catch(e => console.warn('Supabase upsert olt:', e.message));
      return [201, 'OLT ditambahkan. NMS sedang memeriksa koneksi SNMP.'];
    }
    devices.splice(existing, 1);
    try { store.retireOlt(host); }
    catch (error) { console.error('Gagal menutup alarm OLT:', error.message); }
    void supabase.deleteOlt(host).catch(e => console.warn('Supabase delete olt:', e.message));
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
      source: { host: device.host, name: device.name, directRestart: canRestart(device, '127.0.0.1') },
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
      return candidates?.length === 1 ? clientView(device, candidates[0], routerModule.pppoeView(devices)) : null;
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

  function monitorRestart(host, index, mac) {
    const device = devices.find(item => item.host === host);
    const community = device && communityFor(device);
    if (!community) return;
    const oids = { ...defaultOids, ...device.oids };
    let polls = 0;
    let wentDown = false;
    function observe() {
      if (++polls > 30 || !devices.includes(device)) return;
      const session = snmp.createSession(host, community, { version: snmp.Version2c, port: device.port ?? 161, timeout: 5000, retries: 1 });
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

  async function httpProbe(url, timeoutMs = 2000) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.status > 0;
    } catch {
      return false;
    }
  }

  function snmpPing(host, community, port = 161, timeoutMs = 2000) {
    return new Promise((resolve) => {
      if (!host || !community) return resolve(false);
      let settled = false;
      const session = snmp.createSession(host, community, {
        version: snmp.Version2c,
        port,
        timeout: timeoutMs,
        retries: 0,
      });
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        try { session.close(); } catch {}
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs + 200);
      session.get(['1.3.6.1.2.1.1.3.0'], (err) => {
        clearTimeout(timer);
        finish(!err);
      });
    });
  }

  let activePort = options.port || 8080;
  let snmpIntervalId;
  let pppoeIntervalId;
  let sampleIntervalId;
  let initialSyncPromise = null;
  const pollAll = () => Promise.all(devices.map(dev => poll(dev)));

  const controls = {
    async checkNetwork() {
      const checkedAt = new Date().toISOString();
      if (!devices.length && initialSyncPromise) {
        await Promise.race([initialSyncPromise, new Promise(r => setTimeout(r, 4000))]);
      }
      const routerCfg = routerModule.getRouterConfig();
      const hasRouter = Boolean(routerCfg?.configured && routerCfg.url);
      if (!devices.length && !hasRouter) {
        return {
          reachable: true,
          oltReachable: true,
          routerReachable: true,
          checkedAt,
          message: 'OK',
        };
      }
      const [oltChecks, routerReachable] = await Promise.all([
        Promise.all(devices.map(async (dev) => {
          const [snmpOk, webOk] = await Promise.all([
            snmpPing(dev.host, communityFor(dev), dev.port ?? 161, 2000),
            httpProbe('http://' + dev.host + '/', 2000),
          ]);
          return snmpOk || webOk;
        })),
        hasRouter ? routerModule.probeRouter(2000) : Promise.resolve(false),
      ]);
      const oltReachable = devices.length ? oltChecks.some(Boolean) : false;
      const reachable = oltReachable || routerReachable;
      return {
        reachable,
        oltReachable,
        routerReachable,
        checkedAt,
        message: reachable ? 'Terhubung ke jaringan MOMO NET.' : 'Harus terhubung ke Wi-Fi MOMO NET.',
      };
    },
    refreshOlt(host) {
      for (const dev of devices) {
        if (!host || dev.host === host) {
          if (dev.polling && dev.pollSignal) dev.pollSignal.aborted = true;
          void poll(dev, { forceFast: true });
        }
      }
      void routerModule.pollPppoe();
    },
    async restartSnmp(host) {
      const dev = devices.find(d => d.host === host);
      if (!dev) return [404, 'OLT tidak ditemukan.'];
      if (!dev.adminUser || !dev.adminPassword) {
        return [400, 'Kredensial admin web OLT belum diatur untuk OLT ini.'];
      }
      const res = await tryRestartOltSnmp(dev, true);
      if (res.ok) {
        const t = setTimeout(() => {
          retryTimers.delete(t);
          if (!isStopped && devices.includes(dev)) void poll(dev, { forceFast: true });
        }, 2500);
        retryTimers.add(t);
        return [200, 'Perintah restart SNMP dikirim ke ' + dev.name + '. Memeriksa ulang koneksi…'];
      }
      return [502, 'Gagal menghubungi web admin OLT ' + dev.host + '. Pastikan HP terhubung ke jaringan MOMO NET.'];
    },
  };

  const route = createRoutes(
    store,
    activePort,
    { list: listOlts, listFull: listOltsFull, update: manageOlt, importAll: importAllOlts },
    findClientName,
    clients,
    routerModule,
    controls
  );

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const user = url.pathname.startsWith('/api/') ? await route(req, res, url) : null;
      if (url.pathname.startsWith('/api/') && !user) return;

      if (req.method === 'GET' && req.url === '/api/olts') {
        for (const device of devices) {
          if (!device.polling && (!device.lastPollEnd || Date.now() - device.lastPollEnd > 15000)) {
            void poll(device);
          }
        }
        const pppoe = routerModule.pppoeView(devices);
        const baselines = store.rxBaselineMap();
        const networkUnreachable = devices.length > 0 && devices.every(d => d.pollFailed && Boolean(d.error));
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(devices.map((device) => {
          const { name, host, rows, updated, error, polling, adminUser, adminPassword } = device;
          return {
            name,
            host,
            rows: rows.map(row => {
              const baseline = row.mac
                ? (baselines.get(host + '/' + row.index + '/' + row.mac) ?? baselines.get(host + '/' + row.mac))
                : null;
              const drop = row.rx != null && baseline != null ? Number((baseline - row.rx).toFixed(2)) : 0;
              return {
                ...row,
                rxDrop: drop >= 0.5 ? drop : 0,
                pppoe: pppoe.match(row),
              };
            }),
            updated,
            error,
            polling,
            liveOk: Boolean(!device.pollFailed && device.lastPollEnd && !error),
            pppoe: pppoe.status,
            networkUnreachable,
            hasAdminCreds: Boolean(adminUser && adminPassword),
            directRestart: canRestart(device, '127.0.0.1'),
          };
        })));
      } else if (req.method === 'POST' && ['/api/onu/restart', '/api/onu/delete'].includes(req.url)) {
        const deleting = req.url === '/api/onu/delete';
        if (deleting && user.role !== 'admin') {
          json(res, 403, { message: 'Hapus ONU khusus admin.' });
          return;
        }
        await restartRequest(req, res, devices, '127.0.0.1', activePort, {
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
      console.error('NMS request error:', error.message);
      if (!res.headersSent) json(res, 500, { message: 'Terjadi kesalahan pada server NMS.' });
      else res.end();
    }
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once('listening', () => onListen(resolve));
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && activePort !== 0) {
          console.warn('Port ' + activePort + ' in use, falling back to random port...');
          activePort = 0;
          server.listen(0, '127.0.0.1');
        } else {
          reject(err);
        }
      });

      async function onListen(done) {
        activePort = server.address().port;
        console.log('NMS Server listening on http://127.0.0.1:' + activePort);
        void pollAll();
        void routerModule.pollPppoe();
        initialSyncPromise = (async () => {
          try {
            await syncOltsFromCloud();
            await store.syncFromCloud();
            const rCfg = store.getRouterConfig();
            if (rCfg?.url) {
              routerModule.updateRouterConfig(rCfg);
              void routerModule.pollPppoe();
            }
          } catch {}
        })();
        snmpIntervalId = setInterval(pollAll, 15000);
        pppoeIntervalId = setInterval(routerModule.pollPppoe, routerModule.pppoeInterval);
        sampleIntervalId = setInterval(() => {
          try { store.sample(devices, routerModule.pppoeView(devices)); }
          catch (e) { console.error('Sample history error:', e.message); }
        }, 10000);
        done(activePort);
      }

      server.listen(activePort, '127.0.0.1');
    });
  }

  function stop() {
    isStopped = true;
    abortAllPolls();
    for (const t of retryTimers) clearTimeout(t);
    retryTimers.clear();
    clearInterval(snmpIntervalId);
    clearInterval(pppoeIntervalId);
    clearInterval(sampleIntervalId);
    server.closeAllConnections?.();
    server.close();
    store.close?.();
  }

  return {
    start,
    stop,
    getPort: () => activePort,
    store,
    devices,
    pollAll,
  };
}

module.exports = {
  createNmsServer,
};
