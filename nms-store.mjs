import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const derive = promisify(scrypt);
const day = 86400000;

export function openStore(path = fileURLToPath(new URL('./nms-data.sqlite', import.meta.url))) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, salt TEXT, hash TEXT, role TEXT);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, username TEXT,
      host TEXT, mac TEXT, outcome TEXT, recovery TEXT);
    CREATE TABLE IF NOT EXISTS samples (host TEXT, mac TEXT, at INTEGER, rx REAL, status TEXT, tx REAL, upload REAL,
      PRIMARY KEY(host,mac,at));
    CREATE INDEX IF NOT EXISTS samples_by_time ON samples(at);
    CREATE TABLE IF NOT EXISTS onu_state (host TEXT, onu_index TEXT, mac TEXT, status TEXT,
      seen INTEGER, offline_since INTEGER, last_online INTEGER, PRIMARY KEY(host,onu_index,mac));
    CREATE TABLE IF NOT EXISTS alarms (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, at INTEGER, until INTEGER,
      kind TEXT, title TEXT, detail TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS active_alarm ON alarms(key) WHERE until IS NULL;
  `);
  const sql = statement => db.prepare(statement);
  const auditColumns = new Set(sql('PRAGMA table_info(audit)').all().map(column => column.name));
  if (!auditColumns.has('operation')) {
    db.exec("ALTER TABLE audit ADD COLUMN operation TEXT NOT NULL DEFAULT 'reboot'");
  }
  if (!auditColumns.has('client_name')) db.exec('ALTER TABLE audit ADD COLUMN client_name TEXT');
  if (!auditColumns.has('onu_index')) db.exec('ALTER TABLE audit ADD COLUMN onu_index TEXT');
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
  const upsert = sql(`INSERT INTO samples(host,mac,at,rx,status,tx,upload) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(host,mac,at) DO UPDATE SET rx=excluded.rx,status=excluded.status,tx=excluded.tx,upload=excluded.upload`);
  const setOnuState = sql(`INSERT INTO onu_state VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(host,onu_index,mac) DO UPDATE SET status=excluded.status,seen=excluded.seen,
    offline_since=CASE WHEN excluded.status='Offline' AND onu_state.status='Offline'
      AND excluded.seen-onu_state.seen <= 300000 THEN onu_state.offline_since ELSE excluded.offline_since END,
    last_online=COALESCE(excluded.last_online,onu_state.last_online)`);
  const getOnuState = sql('SELECT seen,offline_since,last_online FROM onu_state WHERE host=? AND onu_index=? AND mac=?');

  async function createUser(username, password, role) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username) ||
        typeof password !== 'string' || password.length < 8 || password.length > 128) return 'Username 3–32 karakter dan password 8–128 karakter diperlukan.';
    username = username.toLowerCase();
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(password, salt, 64)).toString('hex');
    if (role === 'admin' && hasAdmin()) return 'Akun admin sudah tersedia.';
    if (getUser.get(username)) return 'Username sudah digunakan.';
    sql('INSERT INTO users VALUES(?,?,?,?)').run(username, salt, hash, role);
    return null;
  }

  async function login(username, password) {
    if (typeof username !== 'string' || username.length > 32 || typeof password !== 'string' || password.length > 128) return null;
    const user = getUser.get(username.toLowerCase());
    const hash = await derive(password, user?.salt ?? 'nms-invalid-account', 64);
    if (!user || !timingSafeEqual(hash, Buffer.from(user.hash, 'hex'))) return null;
    const token = randomBytes(32).toString('hex');
    sql('INSERT INTO sessions VALUES(?,?,?)').run(sha(token), user.username, Date.now() + day);
    return token;
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

  return { hasAdmin, createUser, login, session, logout, recordPoll, recordRecovery, sample,
    onuState: (host, index, mac) => getOnuState.get(host, index, mac) ?? null,
    retireOlt(host) {
      sql('DELETE FROM onu_state WHERE host=?').run(host);
      failures.delete(host);
      previous.delete(host);
      sql("UPDATE alarms SET until=? WHERE until IS NULL AND (key=? OR key LIKE ? OR key LIKE ?)")
        .run(Date.now(), 'olt:' + host, 'onu:' + host + '/%', 'pon:' + host + '/%');
    },
    users: () => sql('SELECT username,role FROM users ORDER BY role,username').all(),
    alarms: () => sql('SELECT * FROM alarms ORDER BY until IS NOT NULL,id DESC LIMIT 250').all(),
    audits: () => sql('SELECT * FROM audit ORDER BY id DESC LIMIT 250').all(),
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
      return sql("INSERT INTO audit(at,username,host,mac,outcome,recovery,operation,client_name,onu_index) VALUES(?,?,?,?,'request','waiting',?,?,?)")
        .run(Date.now(), username, host, mac, operation, clientName, index).lastInsertRowid;
    },
    finishAudit(id, status, attempted) {
      sql('UPDATE audit SET outcome=? WHERE id=?').run(status === 200 ? 'sent' : attempted ? 'uncertain' : 'rejected', id);
    },
    retireOnu(host, mac, index, otherRegistration = false) {
      sql('DELETE FROM onu_state WHERE host=? AND onu_index=? AND mac=?').run(host, index, mac);
      if (otherRegistration) return;
      previous.get(host)?.delete(mac);
      clear.run(Date.now(), 'onu:' + host + '/' + mac);
    },
  };
}
