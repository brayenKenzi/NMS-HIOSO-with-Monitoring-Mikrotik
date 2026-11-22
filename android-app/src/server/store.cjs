const { createHash, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { supabase } = require('./supabase.cjs');

const derive = promisify(scrypt);
const day = 86400000;

function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, salt TEXT, hash TEXT, role TEXT);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, username TEXT,
      host TEXT, mac TEXT, outcome TEXT, recovery TEXT, operation TEXT NOT NULL DEFAULT 'reboot',
      client_name TEXT, onu_index TEXT);
    CREATE TABLE IF NOT EXISTS samples (host TEXT, mac TEXT, at INTEGER, rx REAL, status TEXT, tx REAL, upload REAL,
      PRIMARY KEY(host,mac,at));
    CREATE INDEX IF NOT EXISTS samples_by_time ON samples(at);
    CREATE TABLE IF NOT EXISTS onu_state (host TEXT, onu_index TEXT, mac TEXT, status TEXT,
      seen INTEGER, offline_since INTEGER, last_online INTEGER, PRIMARY KEY(host,onu_index,mac));
    CREATE TABLE IF NOT EXISTS alarms (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, at INTEGER, until INTEGER,
      kind TEXT, title TEXT, detail TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS active_alarm ON alarms(key) WHERE until IS NULL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS olt_cache (host TEXT PRIMARY KEY, rows_json TEXT, updated TEXT);
  `);

  const sql = statement => db.prepare(statement);
  const sha = value => createHash('sha256').update(value).digest('hex');
  const getUser = sql('SELECT username,salt,hash,role FROM users WHERE username=?');
  const hasAdmin = () => Boolean(sql("SELECT 1 AS yes FROM users WHERE role='admin'").get());
  const active = sql('SELECT * FROM alarms WHERE key=? AND until IS NULL');
  const clear = sql('UPDATE alarms SET until=? WHERE key=? AND until IS NULL');
  const add = sql('INSERT OR IGNORE INTO alarms(key,at,kind,title,detail) VALUES(?,?,?,?,?)');
  const recover = sql(`UPDATE audit SET recovery=CASE WHEN ?='Offline' THEN 'down' ELSE 'online' END
    WHERE host=? AND mac=? AND operation='reboot' AND outcome IN ('sent','uncertain') AND at>=?
    AND ((?='Offline' AND recovery='waiting') OR (?='Online' AND recovery='down'))`);
  const failures = new Map();
  const previous = new Map();
  let lastMinute = -1;
  let baselineCache = { at: 0, map: new Map() };
  const upsert = sql(`INSERT INTO samples(host,mac,at,rx,status,tx,upload) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(host,mac,at) DO UPDATE SET rx=excluded.rx,status=excluded.status,tx=excluded.tx,upload=excluded.upload`);
  const setOnuState = sql(`INSERT INTO onu_state VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(host,onu_index,mac) DO UPDATE SET status=excluded.status,seen=excluded.seen,
    offline_since=CASE WHEN excluded.status='Offline' AND onu_state.status='Offline'
      AND excluded.seen-onu_state.seen <= 300000 THEN onu_state.offline_since ELSE excluded.offline_since END,
    last_online=COALESCE(excluded.last_online,onu_state.last_online)`);
  const getOnuState = sql('SELECT seen,offline_since,last_online FROM onu_state WHERE host=? AND onu_index=? AND mac=?');

  const getSetting = sql('SELECT value FROM settings WHERE key=?');
  const setSetting = sql('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const getOltCacheStmt = sql('SELECT rows_json, updated FROM olt_cache WHERE host=?');
  const setOltCacheStmt = sql('INSERT INTO olt_cache(host,rows_json,updated) VALUES(?,?,?) ON CONFLICT(host) DO UPDATE SET rows_json=excluded.rows_json,updated=excluded.updated');

  function saveOltCache(host, rows, updated) {
    setOltCacheStmt.run(host, JSON.stringify(rows || []), updated || null);
  }

  function rxBaselineMap() {
    const now = Date.now();
    if (now - baselineCache.at < 60000 && baselineCache.map.size > 0) {
      return baselineCache.map;
    }
    const rows = sql('SELECT host, mac, AVG(rx) AS avg_rx, COUNT(rx) AS cnt FROM samples WHERE at >= ? AND rx IS NOT NULL GROUP BY host, mac')
      .all(now - day);
    const map = new Map();
    for (const row of rows) {
      if (row.cnt >= 1 && Number.isFinite(row.avg_rx)) {
        map.set(row.host + '/' + row.mac, row.avg_rx);
        const macOnly = String(row.mac).split('/').pop();
        const shortKey = row.host + '/' + macOnly;
        if (!map.has(shortKey)) map.set(shortKey, row.avg_rx);
      }
    }
    baselineCache = { at: now, map };
    return map;
  }

  function loadOltCache(host) {
    const row = getOltCacheStmt.get(host);
    if (!row) return null;
    try {
      const rows = JSON.parse(row.rows_json);
      return Array.isArray(rows) ? { rows, updated: row.updated || null } : null;
    } catch {
      return null;
    }
  }

  async function createUser(username, password, role) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username) ||
        typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return 'Username 3–32 karakter dan password 8–128 karakter diperlukan.';
    }
    username = username.toLowerCase();
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(password, salt, 64)).toString('hex');
    if (role === 'admin' && hasAdmin()) return 'Akun admin sudah tersedia.';
    if (getUser.get(username)) return 'Username sudah digunakan.';
    sql('INSERT INTO users VALUES(?,?,?,?)').run(username, salt, hash, role);
    void supabase.upsertUser({ username, salt, hash, role }).catch(e => console.warn('Supabase user sync:', e.message));
    return null;
  }

  async function updateUserPassword(username, newPassword) {
    if (typeof username !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      return 'Password baru 8–128 karakter diperlukan.';
    }
    const clean = username.trim().toLowerCase();
    const user = getUser.get(clean);
    if (!user) return 'Akun tidak ditemukan.';
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(newPassword, salt, 64)).toString('hex');
    sql('UPDATE users SET salt=?, hash=? WHERE username=?').run(salt, hash, clean);
    sql('DELETE FROM sessions WHERE username=?').run(clean);
    void supabase.upsertUser({ username: clean, salt, hash, role: user.role }).catch(e => console.warn('Supabase password sync:', e.message));
    return null;
  }

  function deleteUser(username, actorUsername) {
    if (typeof username !== 'string' || !username.trim()) return 'Username tidak valid.';
    const clean = username.trim().toLowerCase();
    if (clean === String(actorUsername ?? '').trim().toLowerCase()) {
      return 'Tidak dapat menghapus akun yang sedang digunakan.';
    }
    const user = getUser.get(clean);
    if (!user) return 'Akun tidak ditemukan.';
    if (user.role === 'admin') return 'Akun admin tidak dapat dihapus.';
    sql('DELETE FROM sessions WHERE username=?').run(clean);
    sql('DELETE FROM users WHERE username=?').run(clean);
    void supabase.deleteUser(clean).catch(e => console.warn('Supabase delete user:', e.message));
    return null;
  }

  async function login(username, password) {
    if (typeof username !== 'string' || username.length > 32 || typeof password !== 'string' || password.length > 128) return null;
    username = username.toLowerCase();
    let user = getUser.get(username);
    if (!user) {
      await syncFromCloud();
      user = getUser.get(username);
    }

    if (user && user.salt && user.hash) {
      const hash = await derive(password, user.salt, 64);
      if (timingSafeEqual(hash, Buffer.from(user.hash, 'hex'))) {
        const token = randomBytes(32).toString('hex');
        sql('INSERT INTO sessions VALUES(?,?,?)').run(sha(token), user.username, Date.now() + 30 * day);
        return token;
      }
    }

    // Re-sync from Supabase once in case user or password was updated in cloud
    try {
      await syncFromCloud();
      user = getUser.get(username);
      if (user && user.salt && user.hash) {
        const hash = await derive(password, user.salt, 64);
        if (timingSafeEqual(hash, Buffer.from(user.hash, 'hex'))) {
          const token = randomBytes(32).toString('hex');
          sql('INSERT INTO sessions VALUES(?,?,?)').run(sha(token), user.username, Date.now() + 30 * day);
          return token;
        }
      }
    } catch {}

    return null;
  }

  async function setPin(pin) {
    if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) {
      throw new Error('PIN harus berupa 4–8 angka.');
    }
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(pin, salt, 64)).toString('hex');
    setSetting.run('security_pin', JSON.stringify({ salt, hash }));
    void supabase.setSetting('security_pin', { salt, hash }).catch(e => console.warn('Supabase pin sync:', e.message));
  }

  function hasPin() {
    const raw = getSetting.get('security_pin');
    return Boolean(raw?.value);
  }

  async function loginPin(pin) {
    if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) return null;
    let raw = getSetting.get('security_pin');
    if (!raw?.value) {
      await syncFromCloud();
      raw = getSetting.get('security_pin');
    }
    if (!raw?.value) return null;
    try {
      let { salt, hash } = JSON.parse(raw.value);
      let derived = await derive(pin, salt, 64);
      if (!timingSafeEqual(derived, Buffer.from(hash, 'hex'))) {
        await syncFromCloud();
        const freshRaw = getSetting.get('security_pin');
        if (!freshRaw?.value) return null;
        const fresh = JSON.parse(freshRaw.value);
        salt = fresh.salt;
        hash = fresh.hash;
        derived = await derive(pin, salt, 64);
        if (!timingSafeEqual(derived, Buffer.from(hash, 'hex'))) return null;
      }
      let admin = sql("SELECT username FROM users WHERE role='admin' LIMIT 1").get();
      if (!admin) {
        await syncFromCloud();
        admin = sql("SELECT username FROM users WHERE role='admin' LIMIT 1").get();
      }
      if (!admin) return null;
      const token = randomBytes(32).toString('hex');
      sql('INSERT INTO sessions VALUES(?,?,?)').run(sha(token), admin.username, Date.now() + 30 * day);
      return token;
    } catch {
      return null;
    }
  }

  function getRouterConfig() {
    const raw = getSetting.get('router_config');
    if (!raw?.value) return null;
    try { return JSON.parse(raw.value); } catch { return null; }
  }

  function normalizeRouterList(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      if (!item || !item.url || !item.username || !item.password) continue;
      let id = String(item.id || '').trim();
      if (!id || seen.has(id)) id = 'r-' + (out.length + 1) + '-' + randomBytes(3).toString('hex');
      seen.add(id);
      out.push({
        id,
        name: String(item.name || 'MikroTik ' + (out.length + 1)).trim().slice(0, 60),
        url: String(item.url).trim(),
        username: String(item.username),
        password: String(item.password),
        oltHosts: Array.isArray(item.oltHosts) ? item.oltHosts.filter(Boolean) : [],
      });
    }
    return out;
  }

  function getRouterConfigs() {
    const raw = getSetting.get('router_configs');
    if (raw?.value) {
      try {
        const parsed = JSON.parse(raw.value);
        if (Array.isArray(parsed)) return normalizeRouterList(parsed);
      } catch {}
    }
    const legacy = getRouterConfig();
    if (legacy && legacy.url && legacy.username && legacy.password) {
      return [{
        id: 'default',
        name: legacy.name || 'MikroTik Utama',
        url: legacy.url,
        username: legacy.username,
        password: legacy.password,
        oltHosts: Array.isArray(legacy.oltHosts) ? legacy.oltHosts : [],
      }];
    }
    return [];
  }

  function setRouterConfigs(list) {
    const clean = normalizeRouterList(list);
    setSetting.run('router_configs', JSON.stringify(clean));
    if (clean[0]) {
      setSetting.run('router_config', JSON.stringify(clean[0]));
    } else {
      sql("DELETE FROM settings WHERE key='router_config'").run();
    }
    void supabase.setSetting('router_configs', clean).catch(e => console.warn('Supabase routers sync:', e.message));
    void supabase.setSetting('router_config', clean[0] || null).catch(e => console.warn('Supabase router sync:', e.message));
    return clean;
  }

  function setRouterConfig(config) {
    if (!config) {
      setRouterConfigs([]);
      return;
    }
    setRouterConfigs([{
      id: config.id || 'default',
      name: config.name || 'MikroTik Utama',
      url: config.url,
      username: config.username,
      password: config.password,
      oltHosts: Array.isArray(config.oltHosts) ? config.oltHosts : [],
    }]);
  }

  function session(req) {
    const token = /(?:^|;\s*)momo_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    if (!token) return null;
    return sql('SELECT u.username,u.role FROM sessions s JOIN users u USING(username) WHERE s.token=? AND s.expires>?')
      .get(sha(token), Date.now()) ?? null;
  }

  function logout(req) {
    const token = /(?:^|;\s*)momo_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    if (token) sql('DELETE FROM sessions WHERE token=?').run(sha(token));
  }

  function recordPoll(device) {
    const now = Date.now();
    const host = device.host;
    const oltKey = 'olt:' + host;
    if (device.pollFailed) {
      const count = (failures.get(host) ?? 0) + 1;
      failures.set(host, count);
      if (count >= 2) add.run(oltKey, now, 'olt', 'OLT tidak terjangkau', device.name);
      return;
    }
    failures.delete(host);
    clear.run(now, oltKey);
    const prior = previous.get(host) ?? new Map();
    const groups = new Map();
    const down = [];
    const known = device.rows.filter(row => row.mac && row.status);
    for (const row of known) {
      setOnuState.run(host, row.index, row.mac, row.status, now,
        row.status === 'Offline' ? now : null, row.status === 'Online' ? now : null);
      const group = row.index.split('.').slice(0, -1).join('.');
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(row);
      const key = 'onu:' + host + '/' + row.mac;
      if (row.status === 'Online') clear.run(now, key);
      else if (prior.get(row.mac) === 'Online') down.push({ row, group, key });
      recordRecovery(host, row.mac, row.status, now);
      prior.set(row.mac, row.status);
    }
    previous.set(host, prior);
    const mass = new Set();
    for (const [group, rows] of groups) {
      const key = 'pon:' + host + '/' + group;
      const count = down.filter(item => item.group === group).length;
      if (count >= 3) {
        add.run(key, now, 'mass', 'Gangguan massal', device.name + ' · Grup SNMP ' + group + ' · ' + count + ' ONU turun bersama');
      }
      if (active.get(key) && rows.filter(row => row.status === 'Offline').length >= 3) mass.add(group);
      else clear.run(now, key);
    }
    for (const { row, group, key } of down) {
      if (!mass.has(group)) add.run(key, now, 'onu', 'Pelanggan offline', device.name + ' · ' + (row.name || row.mac));
    }
  }

  function recordRecovery(host, mac, status, now = Date.now()) {
    recover.run(status, host, mac, now - 15 * 60000, status, status);
  }

  function sample(devices, pppoe) {
    const now = Date.now();
    const at = Math.floor(now / 60000) * 60000;
    if (at === lastMinute || !devices.some(device => device.updated)) return;
    db.exec('BEGIN');
    try {
      for (const device of devices) {
        if (!device.updated || device.pollFailed || now - Date.parse(device.updated) > 240000) continue;
        for (const row of device.rows) {
          if (!row.mac) continue;
          const traffic = pppoe.match(row);
          upsert.run(device.host, row.index + '/' + row.mac, at, row.rx, row.status, traffic.txBps ?? null, traffic.rxBps ?? null);
        }
      }
      sql('DELETE FROM samples WHERE at<?').run(now - 8 * day);
      sql('DELETE FROM sessions WHERE expires<?').run(now);
      db.exec('COMMIT');
      lastMinute = at;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function syncFromCloud() {
    try {
      const cloudUsers = await supabase.getUsers();
      if (Array.isArray(cloudUsers)) {
        for (const u of cloudUsers) {
          sql('INSERT INTO users(username,salt,hash,role) VALUES(?,?,?,?) ON CONFLICT(username) DO UPDATE SET salt=excluded.salt,hash=excluded.hash,role=excluded.role')
            .run(u.username, u.salt, u.hash, u.role);
        }
      }
      const cloudPin = await supabase.getSetting('security_pin');
      if (cloudPin && cloudPin.salt && cloudPin.hash) {
        setSetting.run('security_pin', JSON.stringify(cloudPin));
      }
      const cloudRouter = await supabase.getSetting('router_config');
      if (cloudRouter && cloudRouter.url) {
        setSetting.run('router_config', JSON.stringify(cloudRouter));
      }
      const cloudRouters = await supabase.getSetting('router_configs');
      if (Array.isArray(cloudRouters)) {
        setSetting.run('router_configs', JSON.stringify(normalizeRouterList(cloudRouters)));
      }
    } catch (err) {
      console.warn('Sync cloud to local store skipped/offline:', err.message);
    }
  }

  // Initial sync attempt
  void syncFromCloud();

  return {
    hasAdmin, createUser, updateUserPassword, deleteUser, login, session, logout, recordPoll, recordRecovery, sample, rxBaselineMap,
    hasPin, setPin, loginPin, getRouterConfig, setRouterConfig, getRouterConfigs, setRouterConfigs, syncFromCloud,
    saveOltCache, loadOltCache,
    onuState: (host, index, mac) => getOnuState.get(host, index, mac) ?? null,
    retireOlt(host) {
      sql('DELETE FROM onu_state WHERE host=?').run(host);
      sql('DELETE FROM olt_cache WHERE host=?').run(host);
      failures.delete(host);
      previous.delete(host);
      sql("UPDATE alarms SET until=? WHERE until IS NULL AND (key=? OR key LIKE ? OR key LIKE ?)")
        .run(Date.now(), 'olt:' + host, 'onu:' + host + '/%', 'pon:' + host + '/%');
    },
    retireOnu(host, mac, index, otherRegistration = false) {
      sql('DELETE FROM onu_state WHERE host=? AND onu_index=? AND mac=?').run(host, index, mac);
      if (otherRegistration) return;
      previous.get(host)?.delete(mac);
      clear.run(Date.now(), 'onu:' + host + '/' + mac);
    },
    users: () => sql('SELECT username,role FROM users ORDER BY role,username').all(),
    alarms: () => sql('SELECT * FROM alarms ORDER BY until IS NOT NULL,id DESC LIMIT 250').all(),
    async audits() {
      try {
        const cloudLog = await supabase.getAuditLog(250);
        if (Array.isArray(cloudLog) && cloudLog.length > 0) return cloudLog;
      } catch {}
      return sql('SELECT * FROM audit ORDER BY id DESC LIMIT 250').all();
    },
    history(host, mac, days, index, includeLegacy = true) {
      const key = index ? index + '/' + mac : mac;
      return sql(`SELECT at,rx,status,tx,upload FROM samples WHERE host=? AND mac=? AND at>=?
        UNION ALL SELECT at,rx,status,tx,upload FROM samples WHERE host=? AND mac=? AND at>=?
          AND at < COALESCE((SELECT MIN(at) FROM samples WHERE host=? AND mac=?), 9223372036854775807)
        ORDER BY at`).all(host, key, Date.now() - days * day, host, includeLegacy && index ? mac : '',
        Date.now() - days * day, host, key);
    },
    clientActions(host, mac, index, includeLegacy) {
      return sql(`SELECT at,username,operation,outcome,recovery FROM audit WHERE host=? AND mac=?
        AND (onu_index=? OR (? AND onu_index IS NULL)) ORDER BY id DESC LIMIT 30`).all(host, mac, index, Number(includeLegacy));
    },
    beginAudit(username, host, mac, operation = 'reboot', clientName = null, index = null) {
      const at = Date.now();
      const localId = sql("INSERT INTO audit(at,username,host,mac,outcome,recovery,operation,client_name,onu_index) VALUES(?,?,?,?,'request','waiting',?,?,?)")
        .run(at, username, host, mac, operation, clientName, index).lastInsertRowid;
      void supabase.insertAudit({
        at,
        username,
        host,
        mac,
        operation,
        outcome: 'request',
        recovery: 'waiting',
        client_name: clientName,
        onu_index: index,
      }).then(res => {
        if (res?.id) sql('UPDATE audit SET id=? WHERE id=?').run(res.id, localId);
      }).catch(e => console.warn('Supabase audit sync:', e.message));
      return localId;
    },
    finishAudit(id, status, attempted) {
      const outcome = status === 200 ? 'sent' : attempted ? 'uncertain' : 'rejected';
      sql('UPDATE audit SET outcome=? WHERE id=?').run(outcome, id);
      void supabase.updateAudit(id, { outcome }).catch(e => console.warn('Supabase update audit:', e.message));
    },
    close: () => db.close(),
  };
}

module.exports = { openStore };
