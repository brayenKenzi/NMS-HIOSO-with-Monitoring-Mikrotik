function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 65536) throw new Error('Request terlalu besar.');
  }
  return JSON.parse(text);
}

function createRoutes(store, port, olts, findClientName, clients, routerModule, controls = {}) {
  const attempts = new Map();
  const remoteOrigin = process.env.NMS_ORIGIN;
  const local = req => (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::ffff:127.0.0.1' || req.socket.remoteAddress === '::1');

  return async (req, res, url) => {
    const path = url.pathname;
    const user = store.session(req);
    const post = req.method === 'POST';
    const origin = req.headers.origin;
    const secure = Boolean(remoteOrigin?.startsWith('https://') && remoteOrigin === origin);
    const cookie = 'momo_session=';
    const flags = '; Path=/; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');

    if (post && req.headers['content-type'] !== 'application/json') {
      json(res, 400, { message: 'Content-Type harus application/json.' });
      return false;
    }

    // Startup connectivity check (accessible even before login — returns booleans only, no secrets/IPs)
    if (req.method === 'GET' && path === '/api/network-check') {
      const result = await (controls.checkNetwork?.() ?? { reachable: true, checkedAt: new Date().toISOString() });
      json(res, 200, result);
      return false;
    }

    // Session info
    if (req.method === 'GET' && path === '/api/session') {
      if (!store.hasAdmin()) {
        await store.syncFromCloud();
      }
      json(res, 200, {
        user,
        setup: !store.hasAdmin(),
        hasPin: store.hasPin(),
      });
      return false;
    }

    // PIN Login
    if (post && path === '/api/pin/login') {
      let payload;
      try { payload = await body(req); } catch {
        json(res, 400, { message: 'Format data PIN tidak valid.' });
        return false;
      }
      const token = await store.loginPin(payload.pin);
      if (token) {
        res.setHeader('Set-Cookie', cookie + token + flags + '; Max-Age=2592000');
        json(res, 200, { message: 'PIN terverifikasi.' });
      } else {
        json(res, 401, { message: 'PIN salah.' });
      }
      return false;
    }

    // PIN Setup / Change
    if (post && path === '/api/pin/setup') {
      if (!user && store.hasAdmin()) {
        json(res, 401, { message: 'Silakan masuk terlebih dahulu untuk mengatur PIN.' });
        return false;
      }
      let payload;
      try { payload = await body(req); } catch {
        json(res, 400, { message: 'Format data tidak valid.' });
        return false;
      }
      try {
        await store.setPin(payload.pin);
        json(res, 200, { message: 'PIN berhasil diperbarui.' });
      } catch (err) {
        json(res, 400, { message: err.message });
      }
      return false;
    }

    // Login, Setup, Technicians, Logout
    if (post && ['/api/login', '/api/setup', '/api/technicians', '/api/logout'].includes(path)) {
      if (path === '/api/logout') {
        store.logout(req);
        res.setHeader('Set-Cookie', cookie + flags + '; Max-Age=0');
        json(res, 200, {});
        return false;
      }
      if (path === '/api/setup' && store.hasAdmin()) {
        let creds;
        try { creds = await body(req); } catch {}
        const { username: uName, password: uPass } = creds ?? {};
        if (uName && uPass) {
          const token = await store.login(uName, uPass);
          if (token) {
            attempts.delete(address);
            res.setHeader('Set-Cookie', cookie + token + flags + '; Max-Age=2592000');
            json(res, 200, {});
            return false;
          }
        }
        json(res, 403, { message: 'Akun admin sudah dibuat. Silakan masuk menggunakan password yang benar.' });
        return false;
      }
      if (path === '/api/technicians' && user?.role !== 'admin') {
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
      const { username, password, pin } = credentials ?? {};
      if (path !== '/api/login') {
        const failure = await store.createUser(username, password, path === '/api/setup' ? 'admin' : 'technician');
        if (failure || path === '/api/technicians') {
          json(res, failure ? 400 : 201, { message: failure ?? 'Akun teknisi dibuat.' });
          return false;
        }
        if (pin && /^\d{4,8}$/.test(pin)) {
          await store.setPin(pin);
        }
      }
      const token = await store.login(username, password);
      if (token) {
        attempts.delete(address);
        res.setHeader('Set-Cookie', cookie + token + flags + '; Max-Age=2592000');
      }
      json(res, token ? 200 : 401, token ? {} : { message: 'Username atau password salah.' });
      return false;
    }

    if (!user) {
      json(res, 401, { message: 'Silakan masuk terlebih dahulu.' });
      return false;
    }

    // Technician password reset & delete (admin only)
    if (post && (path === '/api/technicians/password' || path === '/api/technicians/delete')) {
      if (user.role !== 'admin') {
        json(res, 403, { message: 'Khusus admin.' });
        return false;
      }
      let payload;
      try { payload = await body(req); } catch {
        json(res, 400, { message: 'Data tidak valid.' });
        return false;
      }
      if (path === '/api/technicians/password') {
        const err = await store.updateUserPassword(payload?.username, payload?.password);
        json(res, err ? 400 : 200, { message: err ?? 'Password berhasil diperbarui.' });
      } else {
        const err = store.deleteUser(payload?.username, user.username);
        json(res, err ? 400 : 200, { message: err ?? 'Akun teknisi berhasil dihapus.' });
      }
      return false;
    }

    // Fast SNMP & MikroTik refresh
    if (post && path === '/api/olt/refresh') {
      let payload = {};
      try { payload = await body(req); } catch {}
      controls.refreshOlt?.(payload?.host || null);
      json(res, 200, { message: 'Refresh cepat SNMP & MikroTik dimulai.' });
      return false;
    }

    // Manual SNMP agent restart on OLT
    if (post && path === '/api/olt/restart-snmp') {
      let payload;
      try { payload = await body(req); } catch {
        json(res, 400, { message: 'Data tidak valid.' });
        return false;
      }
      const [status, message] = await (controls.restartSnmp?.(payload?.host) ?? [501, 'Tidak tersedia.']);
      json(res, status, { message });
      return false;
    }

    // MikroTik Routers (Multi-Site Admin)
    if (path === '/api/admin/routers') {
      if (user.role !== 'admin') {
        json(res, 403, { message: 'Pengaturan MikroTik khusus admin.' });
        return false;
      }
      if (req.method === 'GET') {
        json(res, 200, routerModule.getRouterConfigs());
        return false;
      }
      if (post) {
        let data;
        try { data = await body(req); } catch {
          json(res, 400, { message: 'Data MikroTik tidak valid.' });
          return false;
        }
        const current = store.getRouterConfigs();
        if (data?.action === 'remove') {
          const next = current.filter(r => r.id !== data.id);
          const saved = store.setRouterConfigs(next);
          routerModule.updateRouterConfigs(saved);
          void routerModule.pollPppoe(true);
          json(res, 200, { message: 'MikroTik dihapus.' });
          return false;
        }
        const name = typeof data?.name === 'string' ? data.name.trim() : '';
        const url = typeof data?.url === 'string' ? data.url.trim() : '';
        const username = typeof data?.username === 'string' ? data.username.trim() : '';
        const password = typeof data?.password === 'string' ? data.password : '';
        const oltHosts = Array.isArray(data?.oltHosts) ? data.oltHosts.filter(Boolean) : [];
        let validUrl = false;
        try {
          const u = new URL(url);
          validUrl = ['http:', 'https:', 'api:'].includes(u.protocol);
        } catch {}
        if (!name || !validUrl || !username || !password) {
          json(res, 400, { message: 'Isi Nama Site, URL MikroTik (http/https/api), Username, dan Password.' });
          return false;
        }
        const saved = store.setRouterConfigs([...current, { name, url, username, password, oltHosts }]);
        routerModule.updateRouterConfigs(saved);
        void routerModule.pollPppoe(true);
        json(res, 201, { message: 'MikroTik ' + name + ' berhasil ditambahkan.' });
        return false;
      }
      json(res, 405, { message: 'Metode tidak didukung.' });
      return false;
    }

    // MikroTik Router configuration (legacy single compatibility)
    if (path === '/api/admin/router') {
      if (user.role !== 'admin') {
        json(res, 403, { message: 'Pengaturan MikroTik khusus admin.' });
        return false;
      }
      if (req.method === 'GET') {
        json(res, 200, routerModule.getRouterConfig());
      } else if (post) {
        let data;
        try { data = await body(req); } catch {
          json(res, 400, { message: 'Data tidak valid.' });
          return false;
        }
        store.setRouterConfig(data);
        routerModule.updateRouterConfig(data);
        void routerModule.pollPppoe(true);
        json(res, 200, { message: 'Konfigurasi MikroTik berhasil disimpan.' });
      } else {
        json(res, 405, { message: 'Metode tidak didukung.' });
      }
      return false;
    }

    // OLT Admin
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

    // Full config export/import
    if (path === '/api/admin/config/export' && req.method === 'GET') {
      if (user.role !== 'admin') {
        json(res, 403, { message: 'Khusus admin.' });
        return false;
      }
      json(res, 200, {
        olts: olts.listFull?.() || olts.list(),
        router: store.getRouterConfig(),
        routers: store.getRouterConfigs(),
      });
      return false;
    }

    if (path === '/api/admin/config/import' && post) {
      if (user.role !== 'admin') {
        json(res, 403, { message: 'Khusus admin.' });
        return false;
      }
      let data;
      try { data = await body(req); } catch {
        json(res, 400, { message: 'JSON tidak valid.' });
        return false;
      }
      if (data.olts && Array.isArray(data.olts)) {
        olts.importAll?.(data.olts);
      }
      if (Array.isArray(data.routers)) {
        const saved = store.setRouterConfigs(data.routers);
        routerModule.updateRouterConfigs(saved);
        void routerModule.pollPppoe(true);
      } else if (data.router) {
        store.setRouterConfig(data.router);
        routerModule.updateRouterConfig(data.router);
        void routerModule.pollPppoe(true);
      }
      json(res, 200, { message: 'Konfigurasi berhasil diimpor.' });
      return false;
    }

    if (req.method !== 'GET') return user;

    if (path === '/api/alarms') json(res, 200, store.alarms());
    else if (path === '/api/audit' || path === '/api/technicians') {
      if (user.role !== 'admin') json(res, 403, { message: 'Khusus admin.' });
      else if (path === '/api/audit') {
        const auditEntries = await store.audits();
        json(res, 200, (Array.isArray(auditEntries) ? auditEntries : []).map(entry => ({
          ...entry,
          inventory_name: entry.client_name ? null : findClientName(entry.host, entry.mac),
        })));
      }
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

module.exports = {
  createRoutes,
  json,
};
