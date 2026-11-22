export function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4096) throw new Error('Request terlalu besar.');
  }
  return JSON.parse(text);
}

export function createRoutes(store, port, olts, findClientName, clients) {
  const attempts = new Map();
  const remoteOrigin = process.env.NMS_ORIGIN;
  const local = req => req.socket.remoteAddress === '127.0.0.1' &&
    ['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host);

  return async (req, res, url) => {
    const path = url.pathname;
    const user = store.session(req);
    const post = req.method === 'POST';
    const origin = req.headers.origin;
    const secure = Boolean(remoteOrigin?.startsWith('https://') && remoteOrigin === origin);
    const cookie = 'momo_session=';
    const flags = '; Path=/; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
    if (post && (req.headers['content-type'] !== 'application/json' ||
        !(secure || (local(req) && origin === 'http://' + req.headers.host)))) {
      json(res, 403, { message: 'Asal permintaan ditolak.' });
      return false;
    }
    if (req.method === 'GET' && path === '/api/session') {
      json(res, 200, { user, setup: local(req) && !store.hasAdmin() });
      return false;
    }
    if (post && ['/api/login', '/api/setup', '/api/technicians', '/api/logout'].includes(path)) {
      if (path === '/api/logout') {
        store.logout(req);
        res.setHeader('Set-Cookie', cookie + flags + '; Max-Age=0');
        json(res, 200, {});
        return false;
      }
      if (path === '/api/setup' && (!local(req) || origin !== 'http://' + req.headers.host || store.hasAdmin()) ||
          path === '/api/technicians' && user?.role !== 'admin') {
        json(res, 403, { message: 'Akses ditolak.' });
        return false;
      }
      const now = Date.now();
      for (const [key, entry] of attempts) if (entry.until < now) attempts.delete(key);
      const address = req.socket.remoteAddress;
      const entry = attempts.get(address) ?? { count: 0, until: now + 60000 };
      if (path === '/api/login' && entry.count >= 10) {
        json(res, 429, { message: 'Terlalu banyak percobaan. Coba lagi dalam satu menit.' });
        return false;
      }
      if (path === '/api/login') {
        entry.count++;
        attempts.set(address, entry);
      }
      let credentials;
      try { credentials = await body(req); } catch {
        json(res, 400, { message: 'Data akun tidak valid.' });
        return false;
      }
      const { username, password } = credentials ?? {};
      if (path !== '/api/login') {
        const failure = await store.createUser(username, password, path === '/api/setup' ? 'admin' : 'technician');
        if (failure || path === '/api/technicians') {
          json(res, failure ? 400 : 201, { message: failure ?? 'Akun teknisi dibuat.' });
          return false;
        }
      }
      const token = await store.login(username, password);
      if (token) {
        attempts.delete(address);
        res.setHeader('Set-Cookie', cookie + token + flags + '; Max-Age=86400');
      }
      json(res, token ? 200 : 401, token ? {} : { message: 'Username atau password salah.' });
      return false;
    }
    if (!user) {
      json(res, 401, { message: 'Silakan masuk terlebih dahulu.' });
      return false;
    }
    if (path === '/api/admin/olts') {
      if (user.role !== 'admin') json(res, 403, { message: 'Pengelolaan OLT khusus admin.' });
      else if (req.method === 'GET') json(res, 200, olts.list());
      else if (post) {
        let data;
        try { data = await body(req); } catch {
          json(res, 400, { message: 'Data OLT tidak valid.' });
          return false;
        }
        const [status, message] = olts.update(data);
        json(res, status, { message });
      } else json(res, 405, { message: 'Metode tidak didukung.' });
      return false;
    }
    if (req.method !== 'GET') return user;
    if (path === '/api/alarms') json(res, 200, store.alarms());
    else if (path === '/api/audit' || path === '/api/technicians') {
      if (user.role !== 'admin') json(res, 403, { message: 'Khusus admin.' });
      else if (path === '/api/audit') json(res, 200, store.audits().map(entry => ({
        ...entry,
        inventory_name: entry.client_name ? null : findClientName(entry.host, entry.mac),
      })));
      else json(res, 200, store.users());
    } else if (path === '/api/admin/offline-onus') {
      if (user.role !== 'admin') json(res, 403, { message: 'Daftar kandidat hapus khusus admin.' });
      else {
        const days = Number(url.searchParams.get('days') ?? 7);
        if (![0, 7, 14, 30].includes(days)) json(res, 400, { message: 'Ambang offline tidak valid.' });
        else json(res, 200, clients.offline(days));
      }
    } else if (path === '/api/onu/detail' || path === '/api/history') {
      const host = url.searchParams.get('host');
      const mac = url.searchParams.get('mac');
      const index = url.searchParams.get('index');
      const client = host && mac && clients.find(host, mac, index);
      if (!client) json(res, 404, { message: 'Registrasi ONU tidak ditemukan atau MAC ambigu.' });
      else {
        const range = url.searchParams.get('days');
        const history = store.history(host, mac, range === '7' ? 7 : range === 'hour' ? 1 / 24 : 1,
          client.index, !client.duplicate);
        if (path === '/api/history') json(res, 200, history);
        else json(res, 200, { client, history,
          actions: user.role === 'admin' ? store.clientActions(host, mac, client.index, !client.duplicate) : null });
      }
    } else return user;
    return false;
  };
}
