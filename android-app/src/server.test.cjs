process.env.SUPABASE_DISABLED = 'true';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { openStore } = require('./server/store.cjs');
const { createNmsServer } = require('./server/server.cjs');
const { pppoeView } = require('./server/pppoe.cjs');
const { encodeWord, encodeSentence, runRosApiCommands, probeRosApi, closeAllRosApiSessions } = require('./server/ros-api.cjs');
const { canRestart, restartRequest, isHsgqDevice, decodeHsgqIndex } = require('./server/restart-onu.cjs');
const genieacs = require('./server/genieacs.cjs');

test('store initializes, handles admin setup, session, pin, and settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'momo-test-'));
  try {
    const store = openStore(join(dir, 'test.sqlite'));
    assert.equal(store.hasAdmin(), false);
    assert.equal(store.hasPin(), false);

    // Create admin
    const err = await store.createUser('admin', 'password123', 'admin');
    assert.equal(err, null);
    assert.equal(store.hasAdmin(), true);

    // Login with password
    const token = await store.login('admin', 'password123');
    assert.ok(token);

    // Set PIN
    await store.setPin('123456');
    assert.equal(store.hasPin(), true);

    // Login with PIN
    const pinToken = await store.loginPin('123456');
    assert.ok(pinToken);

    // Router settings (legacy single -> multi migration)
    store.setRouterConfig({ url: 'http://10.0.1.2:808', username: 'admin', password: 'secret' });
    const routerCfg = store.getRouterConfig();
    assert.equal(routerCfg.url, 'http://10.0.1.2:808');
    const migratedRouters = store.getRouterConfigs();
    assert.equal(migratedRouters.length, 1);
    assert.equal(migratedRouters[0].url, 'http://10.0.1.2:808');
    assert.equal(migratedRouters[0].id, 'default');
    store.setRouterConfigs([
      { id: 'r1', name: 'Site A', url: 'http://10.0.1.2:808', username: 'admin', password: 'secret', oltHosts: ['192.168.0.99'] },
      { id: 'r2', name: 'Site B', url: 'http://192.168.100.1:808', username: 'root', password: 'pw2', oltHosts: ['192.168.100.2'] },
    ]);
    assert.equal(store.getRouterConfigs().length, 2);

    // OLT snapshot cache (for instant startup UI)
    assert.equal(store.loadOltCache('192.168.0.99'), null);
    const sampleRows = [
      { index: '1.1', name: 'PELANGGAN-A', mac: 'AA:BB:CC:DD:EE:FF', status: 'Online', rx: -18.5 },
    ];
    const ts = '2026-11-21T10:00:00.000Z';
    store.saveOltCache('192.168.0.99', sampleRows, ts);
    const cached = store.loadOltCache('192.168.0.99');
    assert.equal(cached.updated, ts);
    assert.equal(cached.rows.length, 1);
    assert.equal(cached.rows[0].name, 'PELANGGAN-A');
    assert.equal(cached.rows[0].mac, 'AA:BB:CC:DD:EE:FF');

    store.retireOlt('192.168.0.99');
    assert.equal(store.loadOltCache('192.168.0.99'), null);

    // Technician management: create, change password, delete
    const techErr = await store.createUser('teknisi1', 'passawal123', 'technician');
    assert.equal(techErr, null);
    const oldTechToken = await store.login('teknisi1', 'passawal123');
    assert.ok(oldTechToken);
    const shortPwErr = await store.updateUserPassword('teknisi1', '123');
    assert.ok(shortPwErr);
    const missingUserErr = await store.updateUserPassword('tidakada', 'passbaru456');
    assert.ok(missingUserErr);
    const pwErr = await store.updateUserPassword('teknisi1', 'passbaru456');
    assert.equal(pwErr, null);
    assert.equal(store.session({ headers: { cookie: 'momo_session=' + oldTechToken } }), null);
    assert.equal(await store.login('teknisi1', 'passawal123'), null);
    assert.ok(await store.login('teknisi1', 'passbaru456'));
    const delSelfErr = store.deleteUser('admin', 'admin');
    assert.ok(delSelfErr);
    const delErr = store.deleteUser('teknisi1', 'admin');
    assert.equal(delErr, null);
    assert.equal(await store.login('teknisi1', 'passbaru456'), null);

    // rxBaselineMap() computes 24h average RX from samples
    const fakeDevices = [{
      host: '192.168.0.99',
      updated: new Date().toISOString(),
      pollFailed: false,
      rows: [
        { index: '1.1', mac: 'AA:BB:CC:DD:EE:FF', status: 'Online', rx: -18.5 },
        { index: '1.2', mac: '11:22:33:44:55:66', status: 'Online', rx: -22.0 },
      ],
    }];
    const fakePppoe = { match: () => ({ state: 'unmatched' }) };
    store.sample(fakeDevices, fakePppoe);
    const baselines = store.rxBaselineMap();
    assert.equal(baselines.get('192.168.0.99/1.1/AA:BB:CC:DD:EE:FF'), -18.5);
    assert.equal(baselines.get('192.168.0.99/AA:BB:CC:DD:EE:FF'), -18.5);
    assert.equal(baselines.get('192.168.0.99/1.2/11:22:33:44:55:66'), -22.0);

    store.close();
    await new Promise(r => setTimeout(r, 100));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('nms server hydrates cached ONU rows instantly on startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'momo-cache-'));
  try {
    const dbPath = join(dir, 'nms-data.sqlite');
    const s = openStore(dbPath);
    s.saveOltCache('192.168.0.98', [
      { index: '1.1', name: 'ONU-CACHED', mac: '11:22:33:44:55:66', status: 'Online', rx: -19.2 },
    ], '2026-11-21T10:00:00.000Z');
    s.close();

    const nms = createNmsServer(dir, {
      port: 0,
      seedOlts: [{ name: 'TEST OLT', host: '192.168.0.98', community: 'public', port: 161 }],
    });
    assert.equal(nms.devices.length, 1);
    assert.equal(nms.devices[0].rows.length, 1);
    assert.equal(nms.devices[0].rows[0].name, 'ONU-CACHED');
    assert.equal(nms.devices[0].updated, '2026-11-21T10:00:00.000Z');
    assert.equal(nms.devices[0].metaNames.get('1.1'), 'ONU-CACHED');
    assert.equal(nms.devices[0].metaMacs.get('1.1'), '112233445566');
    nms.stop();
    await new Promise(r => setTimeout(r, 100));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('nms server starts and serves dashboard and API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'momo-srv-'));
  let nms;
  try {
    nms = createNmsServer(dir, { port: 0 });
    const port = await nms.start();
    assert.ok(port > 0);

    // Fetch dashboard HTML
    const resHtml = await fetch('http://127.0.0.1:' + port + '/');
    assert.equal(resHtml.status, 200);
    const htmlText = await resHtml.text();
    assert.ok(htmlText.includes('ADT Monitoring'));
    assert.ok(htmlText.includes('id="pon-filter"'));
    assert.ok(htmlText.includes('Semua PON'));

    // Fetch logo PNG
    const resLogo = await fetch('http://127.0.0.1:' + port + '/momo-logo.png');
    assert.equal(resLogo.status, 200);
    assert.equal(resLogo.headers.get('content-type'), 'image/png');

    // Fetch session API
    const resSession = await fetch('http://127.0.0.1:' + port + '/api/session');
    assert.equal(resSession.status, 200);
    const sessionData = await resSession.json();
    assert.equal(typeof sessionData.setup, 'boolean');

    // Setup admin & authenticate
    const resSetup = await fetch('http://127.0.0.1:' + port + '/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password123', pin: '1234' }),
    });
    assert.equal(resSetup.status, 200);
    const adminCookie = (resSetup.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(adminCookie.startsWith('momo_session='));

    // Verify startup connectivity check when nothing is configured
    const resNet1 = await fetch('http://127.0.0.1:' + port + '/api/network-check', {
      headers: { Cookie: adminCookie },
    });
    assert.equal(resNet1.status, 200);
    const netData1 = await resNet1.json();
    assert.equal(netData1.reachable, true);
    assert.equal(typeof netData1.checkedAt, 'string');

    // Trigger fast refresh via POST /api/olt/refresh
    const resRefresh = await fetch('http://127.0.0.1:' + port + '/api/olt/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({}),
    });
    assert.equal(resRefresh.status, 200);

    // Technician create, password reset, delete via API + non-admin 403 check
    await fetch('http://127.0.0.1:' + port + '/api/technicians', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'techuser', password: 'password123' }),
    });

    const techLoginRes = await fetch('http://127.0.0.1:' + port + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'techuser', password: 'password123' }),
    });
    assert.equal(techLoginRes.status, 200);
    const techCookie = (techLoginRes.headers.get('set-cookie') || '').split(';')[0];

    const forbiddenPw = await fetch('http://127.0.0.1:' + port + '/api/technicians/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: techCookie },
      body: JSON.stringify({ username: 'admin', password: 'newpassword1' }),
    });
    assert.equal(forbiddenPw.status, 403);

    const forbiddenDel = await fetch('http://127.0.0.1:' + port + '/api/technicians/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: techCookie },
      body: JSON.stringify({ username: 'admin' }),
    });
    assert.equal(forbiddenDel.status, 403);

    const resetPw = await fetch('http://127.0.0.1:' + port + '/api/technicians/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'techuser', password: 'newpassword1' }),
    });
    assert.equal(resetPw.status, 200);

    const delTech = await fetch('http://127.0.0.1:' + port + '/api/technicians/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'techuser' }),
    });
    assert.equal(delTech.status, 200);

    nms.stop();
    await new Promise(r => setTimeout(r, 150));
  } finally {
    try { nms?.stop(); } catch {}
    await new Promise(r => setTimeout(r, 50));
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('pppoeView marks inventoryReady as soon as any OLT has ONU MAC rows', () => {
  const devices = [
    { host: '192.168.0.99', updated: null, pollFailed: true, rows: [] },
    { host: '192.168.0.98', updated: '2026-11-21T10:00:00.000Z', pollFailed: false, rows: [{ index: '1.1', mac: 'AA:BB:CC:DD:EE:FF', status: 'Online' }] },
  ];
  const view = pppoeView(devices);
  assert.equal(view.status.inventoryReady, true);
});

test('pppoeView resolves exact 12-char MAC without ambiguity even with shared 10-char prefix', () => {
  const rowA = { index: '1.1', name: 'CLIENT-A', mac: 'AA:BB:CC:DD:EE:01', status: 'Online' };
  const rowB = { index: '1.2', name: 'CLIENT-B', mac: 'AA:BB:CC:DD:EE:02', status: 'Online' };
  const rowAOfflineDup = { index: '1.9', name: 'CLIENT-A-OLD', mac: 'AA:BB:CC:DD:EE:01', status: 'Offline' };
  const devices = [
    { host: '192.168.0.98', updated: '2026-11-21T10:00:00.000Z', pollFailed: false, rows: [rowA, rowB, rowAOfflineDup] },
  ];
  const view = pppoeView(devices, {
    configured: true,
    available: true,
    active: [
      { mac: 'AABBCCDDEE01', username: 'client-a', address: '10.1.0.1', uptime: '1h', txBps: 1000, rxBps: 500 },
      { mac: 'AABBCCDDEE02', username: 'client-b', address: '10.1.0.2', uptime: '2h', txBps: 2000, rxBps: 600 },
    ],
  });
  assert.equal(view.match(rowA).state, 'exact');
  assert.equal(view.match(rowA).username, 'client-a');
  assert.equal(view.match(rowB).state, 'exact');
  assert.equal(view.match(rowB).username, 'client-b');

  // Sibling prefix match works cleanly once exact-matched ONU/session is excluded
  const rowC = { index: '1.3', name: 'CLIENT-C', mac: 'AA:BB:CC:DD:EE:04', status: 'Online' };
  const view2 = pppoeView(
    [{ host: '192.168.0.98', updated: '2026-11-21T10:00:00.000Z', pollFailed: false, rows: [rowA, rowC] }],
    {
      configured: true,
      available: true,
      active: [
        { mac: 'AABBCCDDEE01', username: 'client-a', address: '10.1.0.1', uptime: '1h', txBps: 1000, rxBps: 500 },
        { mac: 'AABBCCDDEE05', username: 'client-c', address: '10.1.0.3', uptime: '3h', txBps: 3000, rxBps: 700 },
      ],
    },
  );
  assert.equal(view2.match(rowA).state, 'exact');
  assert.equal(view2.match(rowC).state, 'prefix');
  assert.equal(view2.match(rowC).username, 'client-c');
});

test('network-check works before login and returns unreachable message on timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'momo-netcheck-'));
  let nms;
  try {
    nms = createNmsServer(dir, {
      port: 0,
      seedOlts: [{ name: 'UNREACHABLE OLT', host: '192.0.2.1', community: 'public', port: 161 }],
      routerConfig: { url: 'http://192.0.2.2:808', username: 'admin', password: 'secret' },
    });
    const port = await nms.start();

    // Accessible even without login cookie (for startup check before PIN/login)
    const res = await fetch('http://127.0.0.1:' + port + '/api/network-check');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reachable, false);
    assert.equal(body.oltReachable, false);
    assert.equal(body.routerReachable, false);
    assert.match(body.message, /MOMO NET/i);
    assert.ok(!JSON.stringify(body).includes('192.0.2.1'));
  } finally {
    try { nms?.stop(); } catch {}
    await new Promise(r => setTimeout(r, 100));
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('pppoeView scopes multi-router sessions by oltHosts without cross-site collision', () => {
  const rowSiteA = { index: '1.1', name: 'USER-A', mac: 'AA:BB:CC:DD:EE:01', status: 'Online' };
  const rowSiteB = { index: '16777473', name: 'USER-B', mac: 'AA:BB:CC:DD:EE:01', status: 'Online' };
  const devices = [
    { host: '192.168.0.99', updated: '2026-11-22T10:00:00.000Z', pollFailed: false, rows: [rowSiteA] },
    { host: '192.168.100.2', updated: '2026-11-22T10:00:00.000Z', pollFailed: false, rows: [rowSiteB] },
  ];
  const view = pppoeView(devices, {
    configured: true,
    available: true,
    active: [
      { mac: 'AABBCCDDEE01', username: 'pppoe-a', address: '10.0.1.10', uptime: '1h', routerId: 'r1', routerName: 'MikroTik Site A', oltHosts: ['192.168.0.99'] },
      { mac: 'AABBCCDDEE01', username: 'pppoe-b', address: '192.168.100.10', uptime: '2h', routerId: 'r2', routerName: 'MikroTik Site B', oltHosts: ['192.168.100.2'] },
    ],
  });
  const mA = view.match(rowSiteA, '192.168.0.99');
  const mB = view.match(rowSiteB, '192.168.100.2');
  assert.equal(mA.state, 'exact');
  assert.equal(mA.username, 'pppoe-a');
  assert.equal(mA.routerName, 'MikroTik Site A');
  assert.equal(mB.state, 'exact');
  assert.equal(mB.username, 'pppoe-b');
  assert.equal(mB.routerName, 'MikroTik Site B');
});

test('multi-mikrotik /api/admin/routers CRUD and HSGQ OLT preset work cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'momo-multi-'));
  let nms;
  try {
    nms = createNmsServer(dir, { port: 0 });
    const port = await nms.start();
    const resSetup = await fetch('http://127.0.0.1:' + port + '/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password123' }),
    });
    const cookie = (resSetup.headers.get('set-cookie') || '').split(';')[0];

    const resOlt = await fetch('http://127.0.0.1:' + port + '/api/admin/olts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        action: 'add',
        name: 'OLT HSGQ Site B',
        host: '192.168.100.2',
        community: 'public-test',
        port: 161,
        vendor: 'hsgq',
      }),
    });
    assert.equal(resOlt.status, 201);
    const addedOlt = nms.devices.find(d => d.host === '192.168.100.2');
    assert.equal(addedOlt.rxDivider, 100);
    assert.equal(addedOlt.oids.rx, '1.3.6.1.4.1.50224.3.3.3.1.4');
    assert.equal(addedOlt.oids.mac, '1.3.6.1.4.1.50224.3.3.2.1.7');

    const addR1 = await fetch('http://127.0.0.1:' + port + '/api/admin/routers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        action: 'add',
        name: 'MikroTik Site A',
        url: 'http://10.0.1.2:808',
        username: 'admin',
        password: 'secret1',
        oltHosts: ['192.168.0.99'],
      }),
    });
    assert.equal(addR1.status, 201);

    const addR2 = await fetch('http://127.0.0.1:' + port + '/api/admin/routers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        action: 'add',
        name: 'MikroTik Site B ROS6',
        url: 'api://192.168.100.1:8728',
        username: 'admin',
        password: 'secret2',
        oltHosts: ['192.168.100.2'],
      }),
    });
    assert.equal(addR2.status, 201);

    const badProto = await fetch('http://127.0.0.1:' + port + '/api/admin/routers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        action: 'add',
        name: 'Bad Proto',
        url: 'ftp://192.168.100.1',
        username: 'admin',
        password: 'x',
      }),
    });
    assert.equal(badProto.status, 400);

    const listRes = await fetch('http://127.0.0.1:' + port + '/api/admin/routers', {
      headers: { Cookie: cookie },
    });
    assert.equal(listRes.status, 200);
    const routers = await listRes.json();
    assert.equal(routers.length, 2);
    assert.equal(routers[0].password, undefined);
    assert.equal(routers[1].name, 'MikroTik Site B ROS6');
    assert.equal(routers[1].url, 'api://192.168.100.1:8728');

    const delR2 = await fetch('http://127.0.0.1:' + port + '/api/admin/routers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'remove', id: routers[1].id }),
    });
    assert.equal(delR2.status, 200);
    const listRes2 = await fetch('http://127.0.0.1:' + port + '/api/admin/routers', {
      headers: { Cookie: cookie },
    });
    const routers2 = await listRes2.json();
    assert.equal(routers2.length, 1);
  } finally {
    try { nms?.stop(); } catch {}
    await new Promise(r => setTimeout(r, 100));
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function createMockRosApiServer(options = {}) {
  const { legacyChallenge = false, rejectBadAuth = true } = options;
  const challengeHex = '0123456789abcdef0123456789abcdef';
  let loginCount = 0;
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let currentWords = [];
    const readLength = (b, off) => {
      if (off >= b.length) return null;
      const c0 = b[off];
      if ((c0 & 0x80) === 0) return [c0, 1];
      if ((c0 & 0xC0) === 0x80) {
        if (off + 1 >= b.length) return null;
        return [((c0 & 0x3F) << 8) | b[off + 1], 2];
      }
      if ((c0 & 0xE0) === 0xC0) {
        if (off + 2 >= b.length) return null;
        return [((c0 & 0x1F) << 16) | (b[off + 1] << 8) | b[off + 2], 3];
      }
      if ((c0 & 0xF0) === 0xE0) {
        if (off + 3 >= b.length) return null;
        return [((c0 & 0x0F) << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3], 4];
      }
      if (off + 4 >= b.length) return null;
      return [(b[off + 1] << 24) | (b[off + 2] << 16) | (b[off + 3] << 8) | b[off + 4], 5];
    };
    const handleSentence = (words) => {
      const cmd = words[0];
      const attrs = Object.fromEntries(words.slice(1).filter(w => w.startsWith('=')).map(w => {
        const idx = w.indexOf('=', 1);
        return idx > 0 ? [w.slice(1, idx), w.slice(idx + 1)] : [w.slice(1), ''];
      }));
      if (cmd === '/login') {
        if (legacyChallenge && !attrs.response) {
          socket.write(encodeSentence(['!done', '=ret=' + challengeHex]));
          return;
        }
        if (legacyChallenge && attrs.response) {
          const expected = '00' + crypto.createHash('md5').update(
            Buffer.concat([Buffer.from([0]), Buffer.from('secret', 'utf8'), Buffer.from(challengeHex, 'hex')])
          ).digest('hex');
          if (attrs.name === 'admin' && attrs.response === expected) {
            loginCount++;
            socket.write(encodeSentence(['!done']));
          } else {
            socket.write(encodeSentence(['!trap', '=message=invalid user name or password (6)']));
            socket.write(encodeSentence(['!done']));
          }
          return;
        }
        if (!rejectBadAuth || (attrs.name === 'admin' && attrs.password === 'secret')) {
          loginCount++;
          socket.write(encodeSentence(['!done']));
        } else {
          socket.write(encodeSentence(['!trap', '=message=invalid user name or password (6)']));
          socket.write(encodeSentence(['!done']));
        }
      } else if (cmd === '/ppp/active/print') {
        socket.write(encodeSentence(['!re', '=.id=*1', '=name=user1', '=caller-id=44:13:D0:2B:12:D5', '=service=pppoe', '=address=10.1.0.2', '=uptime=1h']));
        socket.write(encodeSentence(['!done']));
      } else if (cmd === '/system/identity/print') {
        socket.write(encodeSentence(['!re', '=name=MockMikroTik']));
        socket.write(encodeSentence(['!done']));
      } else {
        socket.write(encodeSentence(['!trap', '=message=unknown command']));
        socket.write(encodeSentence(['!done']));
      }
    };
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const res = readLength(buf, 0);
        if (!res) break;
        const [len, hdr] = res;
        if (len === 0) {
          buf = buf.subarray(hdr);
          const sent = currentWords;
          currentWords = [];
          handleSentence(sent);
          continue;
        }
        if (buf.length < hdr + len) break;
        currentWords.push(buf.subarray(hdr, hdr + len).toString('utf8'));
        buf = buf.subarray(hdr + len);
      }
    });
  });
  server.getLoginCount = () => loginCount;
  return server;
}

test('ros-api client reuses persistent login session across polls, handles legacy MD5, and rejects bad auth', async () => {
  // Multi-byte length encoding checks
  assert.equal(encodeWord('abc').subarray(0, 1)[0], 3);
  const medium = 'x'.repeat(200);
  const encMed = encodeWord(medium);
  assert.equal(encMed[0], 0x80);
  assert.equal(encMed[1], 200);

  // ROS 6.43+ login + multiple polls reuse ONE persistent session without re-logging in
  const srv = createMockRosApiServer({ legacyChallenge: false });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    for (let i = 0; i < 3; i++) {
      const [records] = await runRosApiCommands('127.0.0.1', port, 'admin', 'secret', [
        ['/ppp/active/print', '=.proplist=.id,name,caller-id'],
      ]);
      assert.equal(records.length, 1);
      assert.equal(records[0].name, 'user1');
      assert.equal(records[0]['caller-id'], '44:13:D0:2B:12:D5');
    }
    assert.equal(await probeRosApi('127.0.0.1', port, 'admin', 'secret', 2000), true);
    assert.equal(srv.getLoginCount(), 1);

    await assert.rejects(
      runRosApiCommands('127.0.0.1', port, 'admin', 'wrongpass', [['/ppp/active/print']]),
      /invalid user name or password/i
    );
  } finally {
    closeAllRosApiSessions();
    srv.closeAllConnections?.();
    srv.close();
  }

  // Pre-6.43 legacy MD5 challenge-response login
  const srvLegacy = createMockRosApiServer({ legacyChallenge: true });
  await new Promise(r => srvLegacy.listen(0, '127.0.0.1', r));
  const legacyPort = srvLegacy.address().port;
  try {
    const [records] = await runRosApiCommands('127.0.0.1', legacyPort, 'admin', 'secret', [
      ['/ppp/active/print'],
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0].address, '10.1.0.2');
    assert.equal(srvLegacy.getLoginCount(), 1);
  } finally {
    closeAllRosApiSessions();
    srvLegacy.closeAllConnections?.();
    srvLegacy.close();
  }
});

test('HSGQ-E04R direct ONU reboot, delete, MAC mismatch rejection, and logout work cleanly', async () => {
  assert.deepEqual(decodeHsgqIndex('16777473'), { portId: 1, onuId: 1 });
  assert.deepEqual(decodeHsgqIndex('16777730'), { portId: 2, onuId: 2 });
  assert.equal(decodeHsgqIndex('1.1.1'), null);
  assert.equal(decodeHsgqIndex('0'), null);
  assert.equal(decodeHsgqIndex('abc'), null);

  assert.equal(isHsgqDevice({ vendor: 'hsgq' }), true);
  assert.equal(isHsgqDevice({ oids: { rx: '1.3.6.1.4.1.50224.3.3.3.1.4' } }), true);
  assert.equal(isHsgqDevice({ vendor: 'hioso' }), false);

  assert.equal(canRestart({ host: '192.168.100.2', vendor: 'hsgq', adminUser: 'root', adminPassword: 'secret' }, '127.0.0.1'), true);
  assert.equal(canRestart({ host: '192.168.100.2', vendor: 'hsgq' }, '127.0.0.1'), false);

  const actionsCalled = [];
  const validToken = 'tok-hsgq-test-123';
  const expectedKey = crypto.createHash('md5').update('root:admin').digest('hex');

  const hsgqServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;

    if (req.url === '/userlogin?form=login' && req.method === 'POST') {
      if (body?.param?.name === 'root' && body?.param?.key === expectedKey) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'x-token': validToken });
        res.end(JSON.stringify({ code: 1, message: 'success' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, message: 'bad auth' }));
      }
      return;
    }

    if (req.headers['x-token'] !== validToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, message: 'unauthorized' }));
      return;
    }

    if (req.url === '/onutable' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 1,
        data: [
          { port_id: 1, onu_id: 1, onu_name: 'ZIBIL', macaddr: '44:13:d0:2b:12:d5', status: 'Online' },
          { port_id: 1, onu_id: 2, onu_name: 'OFFLINE-CPE', macaddr: '44:13:d0:2b:12:d6', status: 'Offline' },
        ],
      }));
      return;
    }

    if (req.url === '/onumgmt?form=config' && req.method === 'POST') {
      actionsCalled.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 1, message: 'success' }));
      return;
    }

    if (req.url === '/onu_allow_list?form=onucfg' && req.method === 'POST') {
      actionsCalled.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 1, message: 'success' }));
      return;
    }

    if (req.url === '/userlogin?form=logout' && req.method === 'POST') {
      actionsCalled.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 1, message: 'success' }));
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise(r => hsgqServer.listen(0, '127.0.0.1', r));
  const mockOltPort = hsgqServer.address().port;

  const hsgqDevice = {
    name: 'OLT HSGQ',
    host: '127.0.0.1',
    webPort: mockOltPort,
    vendor: 'hsgq',
    adminUser: 'root',
    adminPassword: 'admin',
    updated: new Date().toISOString(),
    rows: [
      { index: '16777473', name: 'ZIBIL', mac: '44:13:D0:2B:12:D5', status: 'Online', rx: -15.5 },
      { index: '16777474', name: 'OFFLINE-CPE', mac: '44:13:D0:2B:12:D6', status: 'Offline', rx: null },
      { index: '16777475', name: 'MISMATCH-CPE', mac: 'AA:BB:CC:DD:EE:FF', status: 'Online', rx: -20.0 },
    ],
  };
  const devices = [hsgqDevice];

  const proxyServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const deleting = url.pathname === '/api/onu/delete';
    await restartRequest(req, res, devices, '127.0.0.1', proxyServer.address().port, {
      begin: () => 1,
      finish: () => {},
      watch: () => {},
      removed: (dev, mac, index) => {
        dev.rows = dev.rows.filter(r => r.index !== index || r.mac !== mac);
      },
    }, deleting);
  });

  await new Promise(r => proxyServer.listen(0, '127.0.0.1', r));
  const srvPort = proxyServer.address().port;

  try {
    const callRestart = (path, payload) => fetch('http://127.0.0.1:' + srvPort + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: '127.0.0.1:' + srvPort,
        Origin: 'http://127.0.0.1:' + srvPort,
      },
      body: JSON.stringify(payload),
    });

    // 1. Verify online ONU
    const vRes = await callRestart('/api/onu/restart', {
      host: '127.0.0.1', index: '16777473', mac: '44:13:D0:2B:12:D5', action: 'verify',
    });
    assert.equal(vRes.status, 200);
    assert.match((await vRes.json()).message, /PON 1:1/);

    // 2. Reboot online ONU
    const rRes = await callRestart('/api/onu/restart', {
      host: '127.0.0.1', index: '16777473', mac: '44:13:D0:2B:12:D5', action: 'reboot',
    });
    assert.equal(rRes.status, 200);
    assert.match((await rRes.json()).message, /reboot.*PON 1:1/i);
    assert.ok(actionsCalled.some(a =>
      a.url === '/onumgmt?form=config' &&
      a.body.method === 'set' &&
      a.body.param.port_id === 1 &&
      a.body.param.onu_id === 1 &&
      a.body.param.flags === 1 &&
      a.body.param.fec_mode === 1
    ));
    assert.ok(actionsCalled.some(a => a.url === '/userlogin?form=logout'));

    // 3. Delete offline ONU
    const dRes = await callRestart('/api/onu/delete', {
      host: '127.0.0.1',
      index: '16777474',
      mac: '44:13:D0:2B:12:D6',
      action: 'delete',
      confirmation: '44:13:D0:2B:12:D6',
    });
    assert.equal(dRes.status, 200);
    assert.match((await dRes.json()).message, /PON 1:2.*terhapus/i);
    assert.ok(actionsCalled.some(a =>
      a.url === '/onu_allow_list?form=onucfg' &&
      a.body.method === 'delete' &&
      a.body.param.port_id === 1 &&
      a.body.param.onu_id === 2 &&
      a.body.param.macaddr === '44:13:d0:2b:12:d6'
    ));
    assert.equal(hsgqDevice.rows.some(r => r.mac === '44:13:D0:2B:12:D6'), false);

    // 4. Reject MAC mismatch on live OLT before sending any config change
    const beforeCount = actionsCalled.filter(a => a.url !== '/userlogin?form=logout').length;
    const mRes = await callRestart('/api/onu/restart', {
      host: '127.0.0.1', index: '16777475', mac: 'AA:BB:CC:DD:EE:FF', action: 'reboot',
    });
    assert.equal(mRes.status, 409);
    assert.match((await mRes.json()).message, /MAC dan Port\/ONU tidak cocok/i);
    const afterCount = actionsCalled.filter(a => a.url !== '/userlogin?form=logout').length;
    assert.equal(afterCount, beforeCount);
  } finally {
    proxyServer.closeAllConnections?.();
    proxyServer.close();
    hsgqServer.closeAllConnections?.();
    hsgqServer.close();
  }
});

test('HiOSO non-hardcoded IP auto-detects 3-segment PON 0/1/x and reboots ONU', async () => {
  const posted = [];
  const authHeader = 'Basic ' + Buffer.from('admin:admin').toString('base64');
  const hiosoServer = http.createServer(async (req, res) => {
    if (req.headers.authorization !== authHeader) {
      res.writeHead(401).end('Unauthorized');
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/onuOverview.asp' && url.searchParams.get('oltponno') === '0/1') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<script>var ponOnuTable = new Array(
  '0/1/1:1', 'ANDRE', 'B4:E4:6B:6F:07:E7', 'Up',
  '0/1/2:1', 'BUDI', 'B4:E4:6B:6F:9C:E8', 'Up'
);</script>`);
      return;
    }
    if (url.pathname === '/onuConfigOnuList.asp') {
      const pon = url.searchParams.get('oltponno');
      const rows = pon === '0/1/1'
        ? "  '0/1/1:1', 'ANDRE', 'B4:E4:6B:6F:07:E7', 'Up'\n"
        : pon === '0/1/2'
          ? "  '0/1/2:1', 'BUDI', 'B4:E4:6B:6F:9C:E8', 'Up'\n"
          : '';
      if (pon === '0/1/3' || pon === '0/1/4') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<script>var ponOnuTable = new Array(\n);</script>`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<script>var ponOnuTable = new Array(\n${rows});</script>`);
      return;
    }
    if (url.pathname === '/onuConfig.asp') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<script>
var onuinfo = new Array('0/1/1:0', 'ANDRE', 'b4:e4:6b:6f:07:e7', 'Up');
var onuno = '0/1/1:1';
onuForm.onuId.value = onuno;
</script>
<form action="/goform/setOnu" method="post">
<select name="onuOperation"><option value="rebootOp">Reboot</option></select>
</form>`);
      return;
    }
    if (url.pathname === '/goform/setOnu' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      posted.push(body);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Configure Success!</body></html>');
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise(r => hiosoServer.listen(0, '127.0.0.1', r));
  const mockPort = hiosoServer.address().port;

  const hiosoDevice = {
    name: 'OLT KOTOBANGON',
    host: '127.0.0.1',
    webPort: mockPort,
    vendor: 'hioso',
    adminUser: 'admin',
    adminPassword: 'admin',
    updated: new Date().toISOString(),
    rows: [
      { index: '1.1.1', name: 'ANDRE', mac: 'B4:E4:6B:6F:07:E7', status: 'Online', rx: -18.2 },
    ],
  };

  const proxyServer = http.createServer(async (req, res) => {
    await restartRequest(req, res, [hiosoDevice], '127.0.0.1', proxyServer.address().port, {
      begin: () => 1,
      finish: () => {},
      watch: () => {},
    }, false);
  });
  await new Promise(r => proxyServer.listen(0, '127.0.0.1', r));
  const srvPort = proxyServer.address().port;

  try {
    const callRestart = (payload) => fetch('http://127.0.0.1:' + srvPort + '/api/onu/restart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: '127.0.0.1:' + srvPort,
        Origin: 'http://127.0.0.1:' + srvPort,
      },
      body: JSON.stringify(payload),
    });

    const vRes = await callRestart({
      host: '127.0.0.1', index: '1.1.1', mac: 'B4:E4:6B:6F:07:E7', action: 'verify',
    });
    assert.equal(vRes.status, 200);
    assert.match((await vRes.json()).message, /0\/1\/1:1/);

    const rRes = await callRestart({
      host: '127.0.0.1', index: '1.1.1', mac: 'B4:E4:6B:6F:07:E7', action: 'reboot',
    });
    assert.equal(rRes.status, 200);
    assert.match((await rRes.json()).message, /perintah reboot/i);
    assert.equal(posted.length, 1);
    const params = new URLSearchParams(posted[0]);
    assert.equal(params.get('onuId'), '0/1/1:1');
    assert.equal(params.get('onuName'), 'ANDRE');
    assert.equal(params.get('onuOperation'), 'rebootOp');
  } finally {
    proxyServer.closeAllConnections?.();
    proxyServer.close();
    hiosoServer.closeAllConnections?.();
    hiosoServer.close();
  }
});

test('LAN server mode allows same-origin restartRequest and blocks cross-origin CSRF', async () => {
  assert.equal(canRestart({ host: '192.168.100.2', vendor: 'hsgq', adminUser: 'root', adminPassword: 'secret' }, '0.0.0.0'), true);
  assert.equal(canRestart({ host: '192.168.100.2', vendor: 'hsgq', adminUser: 'root', adminPassword: 'secret' }, '10.10.10.7'), true);

  const validToken = 'tok-lan-123';
  const expectedKey = crypto.createHash('md5').update('root:admin').digest('hex');
  const mockHsgq = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    if (req.url === '/userlogin?form=login') {
      if (body?.param?.name === 'root' && body?.param?.key === expectedKey) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'x-token': validToken });
        res.end(JSON.stringify({ code: 1 }));
      } else {
        res.writeHead(401).end();
      }
      return;
    }
    if (req.url === '/onutable') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 1,
        data: [{ port_id: 1, onu_id: 1, onu_name: 'LAN-ONU', macaddr: '44:13:d0:2b:12:d5', status: 'Online' }],
      }));
      return;
    }
    if (req.url === '/userlogin?form=logout') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 1 }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise(r => mockHsgq.listen(0, '127.0.0.1', r));
  const mockPort = mockHsgq.address().port;

  const dev = {
    name: 'LAN HSGQ',
    host: '127.0.0.1',
    webPort: mockPort,
    vendor: 'hsgq',
    adminUser: 'root',
    adminPassword: 'admin',
    updated: new Date().toISOString(),
    rows: [{ index: '16777473', name: 'LAN-ONU', mac: '44:13:D0:2B:12:D5', status: 'Online', rx: -17 }],
  };

  const lanProxy = http.createServer(async (req, res) => {
    await restartRequest(req, res, [dev], '0.0.0.0', lanProxy.address().port, {
      begin: () => 1,
      finish: () => {},
    }, false);
  });
  await new Promise(r => lanProxy.listen(0, '127.0.0.1', r));
  const srvPort = lanProxy.address().port;

  const lanPost = (headers, payload) => new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port: srvPort,
      path: '/api/onu/restart',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
        ...headers,
      },
    }, async (res) => {
      let text = '';
      for await (const c of res) text += c;
      resolve({ status: res.statusCode, json: () => JSON.parse(text) });
    });
    req.on('error', reject);
    req.end(raw);
  });

  try {
    // Same-origin over LAN hostname passes
    const okRes = await lanPost(
      { Host: '10.10.10.7:' + srvPort, Origin: 'http://10.10.10.7:' + srvPort },
      { host: '127.0.0.1', index: '16777473', mac: '44:13:D0:2B:12:D5', action: 'verify' }
    );
    assert.equal(okRes.status, 200);
    assert.match(okRes.json().message, /PON 1:1/);

    // Cross-origin CSRF rejected with 403
    const csrfRes = await lanPost(
      { Host: '10.10.10.7:' + srvPort, Origin: 'http://evil.example' },
      { host: '127.0.0.1', index: '16777473', mac: '44:13:D0:2B:12:D5', action: 'verify' }
    );
    assert.equal(csrfRes.status, 403);
  } finally {
    lanProxy.closeAllConnections?.();
    lanProxy.close();
    mockHsgq.closeAllConnections?.();
    mockHsgq.close();
  }
});

test('GenieACS realtime auto-summon, active clients parsing, and Wi-Fi SSID/password update with audit work cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'momo-genieacs-'));
  let nms;
  const nbiCalls = [];

  let currentSsid = 'RUMAH-LAMA';
  let currentPass = 'sandilama123';
  const mockGenie = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    nbiCalls.push({ method: req.method, path: u.pathname, query: u.search, body });

    const devDoc = {
      _id: 'F86CE1-G99%2DXPON-GGCL00001111',
      _deviceId: { _Manufacturer: 'GGCL', _ProductClass: 'G99-XPON', _SerialNumber: 'GGCL00001111' },
      _lastInform: '2026-11-23T13:55:00.000Z',
      InternetGatewayDevice: {
        WANDevice: {
          1: { WANConnectionDevice: { 2: { WANPPPConnection: { 1: { Username: { _value: 'pelanggan-01' }, MACAddress: { _value: 'F8:6C:E1:00:11:12' } } } } } },
        },
        LANDevice: {
          1: {
            WLANConfiguration: {
              1: {
                SSID: { _value: currentSsid },
                TotalAssociations: { _value: 2 },
                KeyPassphrase: { _value: currentPass },
                AssociatedDevice: {
                  1: {
                    AssociatedDeviceMACAddress: { _value: 'AA:11:22:33:44:55' },
                    AssociatedDeviceIPAddress: { _value: '192.168.1.10' },
                    RSSI: { _value: -54 },
                  },
                },
              },
            },
            Hosts: {
              Host: {
                1: {
                  Active: { _value: true },
                  HostName: { _value: 'Galaxy-A55' },
                  IPAddress: { _value: '192.168.1.10' },
                  MACAddress: { _value: 'AA:11:22:33:44:55' },
                  InterfaceType: { _value: '802.11' },
                },
                2: {
                  Active: { _value: true },
                  HostName: { _value: 'Laptop-Kerja' },
                  IPAddress: { _value: '192.168.1.11' },
                  MACAddress: { _value: 'BB:11:22:33:44:66' },
                  InterfaceType: { _value: 'Ethernet' },
                },
                3: {
                  Active: { _value: false },
                  HostName: { _value: 'HP-Lama-Offline' },
                  IPAddress: { _value: '192.168.1.12' },
                  MACAddress: { _value: 'CC:11:22:33:44:77' },
                },
              },
            },
          },
        },
      },
    };

    if (req.method === 'GET' && u.pathname === '/devices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([devDoc]));
      return;
    }

    if (req.method === 'POST' && u.pathname.endsWith('/tasks')) {
      if (body?.name === 'setParameterValues') {
        for (const [p, v] of body.parameterValues || []) {
          if (p.endsWith('.SSID')) currentSsid = v;
          if (p.endsWith('.KeyPassphrase')) currentPass = v;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ _id: 'task-1', ...body }));
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise(r => mockGenie.listen(0, '127.0.0.1', r));
  const geniePort = mockGenie.address().port;
  const genieUrl = 'http://127.0.0.1:' + geniePort;

  try {
    // 1. Direct unit validation on genieacs helper
    const modem = await genieacs.getClientModem({
      mac: 'F8:6C:E1:00:11:11', // tests 10-char prefix match too
      summon: true,
      baseUrl: genieUrl,
    });
    assert.equal(modem.configured, true);
    assert.equal(modem.found, true);
    assert.equal(modem.summonResult.live, true);
    assert.ok(nbiCalls.some(c => c.body?.name === 'getParameterValues'));
    assert.equal(nbiCalls.some(c => c.body?.name === 'refreshObject'), false);
    assert.equal(modem.device.ssid, 'RUMAH-LAMA');
    assert.equal(modem.device.activeClientsCount, 2);
    assert.equal(modem.device.clients.length, 2); // inactive host excluded; merged RSSI from AssociatedDevice
    assert.equal(modem.device.clients[0].rssi, -54);
    assert.equal(modem.device.clients[0].name, 'Galaxy-A55');

    await assert.rejects(
      genieacs.updateWifi('F86CE1-G99%2DXPON-GGCL00001111', { ssid: 'OK', password: '123', baseUrl: genieUrl }),
      /8 sampai 63 karakter/i
    );

    // 2. End-to-end HTTP routes + audit log via createNmsServer
    nms = createNmsServer(dir, {
      port: 0,
      genieacsUrl: genieUrl,
      seedOlts: [{ name: 'OLT TEST', host: '192.168.100.2', community: 'public', port: 161 }],
    });
    const dev = nms.devices[0];
    dev.updated = new Date().toISOString();
    dev.rows = [{ index: '16777473', name: 'PELANGGAN-01', mac: 'F8:6C:E1:00:11:11', status: 'Online', rx: -18.5 }];
    const port = await nms.start();

    const setupRes = await fetch('http://127.0.0.1:' + port + '/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password123' }),
    });
    const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];

    const getRes = await fetch('http://127.0.0.1:' + port + '/api/genieacs/device?host=192.168.100.2&mac=F8:6C:E1:00:11:11&index=16777473&force=1', {
      headers: { Cookie: cookie },
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.found, true);
    assert.equal(getBody.device.ssid, 'RUMAH-LAMA');

    // CSRF rejection
    const badWifi = await fetch('http://127.0.0.1:' + port + '/api/genieacs/wifi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'http://evil.example' },
      body: JSON.stringify({ host: '192.168.100.2', mac: 'F8:6C:E1:00:11:11', index: '16777473', ssid: 'NEW' }),
    });
    assert.equal(badWifi.status, 403);

    // Valid SSID & Password change
    const wifiRes = await fetch('http://127.0.0.1:' + port + '/api/genieacs/wifi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'http://127.0.0.1:' + port },
      body: JSON.stringify({
        host: '192.168.100.2',
        mac: 'F8:6C:E1:00:11:11',
        index: '16777473',
        ssid: 'RUMAH-BARU',
        password: 'sandibaru456',
      }),
    });
    assert.equal(wifiRes.status, 200);
    const wifiBody = await wifiRes.json();
    assert.equal(wifiBody.live, true);
    assert.equal(currentSsid, 'RUMAH-BARU');
    assert.equal(currentPass, 'sandibaru456');

    // Audit recorded without plaintext password, plus login action recorded
    const auditRes = await fetch('http://127.0.0.1:' + port + '/api/audit', {
      headers: { Cookie: cookie },
    });
    const audits = await auditRes.json();
    assert.ok(audits.some(a => a.operation === 'wifi' && a.outcome === 'sent' && a.mac === 'F8:6C:E1:00:11:11'));
    assert.ok(audits.some(a => a.operation === 'login' && a.username === 'admin'));
    assert.equal(JSON.stringify(audits).includes('sandibaru456'), false);
  } finally {
    try { nms?.stop(); } catch {}
    mockGenie.closeAllConnections?.();
    mockGenie.close();
    await new Promise(r => setTimeout(r, 100));
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('store enforces 7-day log retention on samples/alarms/audit and records admin actions', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'momo-retention-'));
  const dbPath = join(dir, 'ret.sqlite');
  try {
    const store = openStore(dbPath);
    await store.createUser('admin', 'password123', 'admin');
    store.recordAction('admin', 'olt_update', '192.168.100.2', 'Tambah OLT TEST');
    store.close();

    const now = Date.now();
    const eightDaysAgo = now - 8 * 86400000;
    const oneDayAgo = now - 1 * 86400000;
    const rawDb = new DatabaseSync(dbPath);
    rawDb.prepare('INSERT INTO samples(host,mac,at,rx,status,tx,upload) VALUES(?,?,?,?,?,?,?)')
      .run('10.0.0.1', '1.1/AA:BB:CC:DD:EE:01', eightDaysAgo, -18, 'Online', 100, 50);
    rawDb.prepare('INSERT INTO samples(host,mac,at,rx,status,tx,upload) VALUES(?,?,?,?,?,?,?)')
      .run('10.0.0.1', '1.1/AA:BB:CC:DD:EE:01', oneDayAgo, -18, 'Online', 200, 80);
    rawDb.prepare('INSERT INTO alarms(key,at,until,kind,title,detail) VALUES(?,?,?,?,?,?)')
      .run('old-resolved', eightDaysAgo - 3600000, eightDaysAgo, 'onu', 'Alarm Lama', 'Sudah pulih');
    rawDb.prepare('INSERT INTO alarms(key,at,until,kind,title,detail) VALUES(?,?,?,?,?,?)')
      .run('still-active', eightDaysAgo - 3600000, null, 'olt', 'Alarm Aktif', 'Belum pulih');
    rawDb.prepare('INSERT INTO alarms(key,at,until,kind,title,detail) VALUES(?,?,?,?,?,?)')
      .run('recent-resolved', oneDayAgo - 3600000, oneDayAgo, 'onu', 'Alarm Baru', 'Pulih baru');
    rawDb.prepare('INSERT INTO audit(at,username,host,mac,outcome,recovery,operation,client_name,onu_index) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(eightDaysAgo, 'admin', '10.0.0.1', '', 'sent', 'done', 'login', 'Login lama', null);
    rawDb.close();

    const reopened = openStore(dbPath);
    reopened.pruneOldLogs(now);
    const audits = await reopened.audits();
    const alarms = reopened.alarms();
    const hist = reopened.history('10.0.0.1', 'AA:BB:CC:DD:EE:01', 14, '1.1', false);
    reopened.close();

    assert.equal(hist.length, 1);
    assert.equal(hist[0].tx, 200);
    assert.equal(alarms.some(a => a.key === 'old-resolved'), false);
    assert.equal(alarms.some(a => a.key === 'still-active'), true);
    assert.equal(alarms.some(a => a.key === 'recent-resolved'), true);
    assert.equal(audits.some(a => a.client_name === 'Login lama'), false);
    assert.equal(audits.some(a => a.operation === 'olt_update' && a.client_name === 'Tambah OLT TEST'), true);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('pppoe module collects non-PPPoE interface rates, live ring buffer, and minute averages alongside PPPoE sessions', async () => {
  const { updateRouterConfigs, pollPppoe, interfaceView, interfaceLiveHistory, consumeInterfaceMinuteSamples, pppoeView } = require('./server/pppoe.cjs');
  let tick = 0;
  const mockRouter = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/rest/ppp/active') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        { '.id': '*1', name: 'klien-a', address: '10.1.0.10', service: 'pppoe', 'caller-id': 'AA:BB:CC:DD:EE:01', 'session-id': 's1', uptime: '1h' },
      ]));
      return;
    }
    if (u.pathname === '/rest/interface/pppoe-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        { '.id': '*2', name: '<pppoe-klien-a>', user: 'klien-a', running: 'true' },
      ]));
      return;
    }
    if (u.pathname === '/rest/interface/print') {
      const mul = tick;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        { '.id': '*1', name: 'ether1-UPLINK', type: 'ether', running: 'true', disabled: 'false', comment: 'ISP', 'rx-byte': String(1000000 + mul * 500000), 'tx-byte': String(2000000 + mul * 250000) },
        { '.id': '*2', name: 'vlan333-PPPOE', type: 'vlan', running: 'true', disabled: 'false', 'rx-byte': String(300000 + mul * 100000), 'tx-byte': String(400000 + mul * 200000) },
        { '.id': '*3', name: 'lo', type: 'loopback', running: 'true', disabled: 'false', 'rx-byte': '100', 'tx-byte': '100' },
        { '.id': '*4', name: '<pppoe-klien-a>', type: 'pppoe-in', running: 'true', disabled: 'false', 'rx-byte': String(50000 + mul * 12500), 'tx-byte': String(80000 + mul * 25000) },
      ]));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise(r => mockRouter.listen(0, '127.0.0.1', r));
  const rPort = mockRouter.address().port;
  try {
    updateRouterConfigs([{ id: 'r-test', name: 'Router Test', url: 'http://127.0.0.1:' + rPort, username: 'admin', password: 'pw' }]);
    await pollPppoe(true);
    tick = 1;
    await new Promise(r => setTimeout(r, 80));
    await pollPppoe(true);

    const view = interfaceView();
    assert.equal(view.routers.length, 1);
    const ifaces = view.routers[0].interfaces;
    assert.equal(ifaces.some(i => i.name === 'lo' || i.name === '<pppoe-klien-a>'), false);
    const uplink = ifaces.find(i => i.name === 'ether1-UPLINK');
    assert.ok(uplink);
    assert.equal(uplink.running, true);
    assert.equal(uplink.comment, 'ISP');
    assert.ok(Number.isFinite(uplink.rxBps) && uplink.rxBps > 0);
    assert.ok(Number.isFinite(uplink.txBps) && uplink.txBps > 0);

    const livePts = interfaceLiveHistory('r-test', 'ether1-UPLINK');
    assert.equal(livePts.length, 1);
    assert.ok(livePts[0].rx > 0);

    const mins = consumeInterfaceMinuteSamples();
    assert.equal(mins.length, 2);
    assert.equal(consumeInterfaceMinuteSamples().length, 0);

    // PPPoE matching remains intact
    const matched = pppoeView([{ host: '10.0.0.1', rows: [{ mac: 'AA:BB:CC:DD:EE:01', status: 'Online' }] }])
      .match({ mac: 'AA:BB:CC:DD:EE:01', status: 'Online' }, '10.0.0.1');
    assert.equal(matched.username, 'klien-a');
    assert.ok(Number.isFinite(matched.txBps) && matched.txBps > 0);
  } finally {
    updateRouterConfigs([]);
    mockRouter.closeAllConnections?.();
    mockRouter.close();
  }
});

test('store persists interface_samples, aggregates 7d buckets & 24h summaries, and prunes >7d rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'momo-iface-store-'));
  try {
    const store = openStore(join(dir, 'iface.sqlite'));
    const now = Math.floor(Date.now() / 600000) * 600000 + 120000;
    const nineDaysAgo = now - 9 * 86400000;
    const twoDaysAgo = now - 2 * 86400000;
    const tenMinAgo = now - 10 * 60000;

    assert.equal(store.shouldSampleInterfaces(now), true);
    store.sampleInterfaces([{ routerId: 'r1', iface: 'ether1-UP LINK', rx: 120e6, tx: 30e6 }], nineDaysAgo);
    store.sampleInterfaces([{ routerId: 'r1', iface: 'ether1-UP LINK', rx: 60e6, tx: 15e6 }], twoDaysAgo);
    store.sampleInterfaces([{ routerId: 'r1', iface: 'ether1-UP LINK', rx: 80e6, tx: 20e6 }], twoDaysAgo + 60000);
    store.sampleInterfaces([{ routerId: 'r1', iface: 'ether1-UP LINK', rx: 100e6, tx: 25e6 }], tenMinAgo);
    store.sampleInterfaces([{ routerId: 'r1', iface: 'ether1-UP LINK', rx: 200e6, tx: 50e6 }], now);
    assert.equal(store.shouldSampleInterfaces(now), false);

    store.pruneOldLogs(now);
    const hourPts = store.interfaceHistory('r1', 'ether1-UP LINK', 'hour', now);
    assert.equal(hourPts.length, 2);
    assert.equal(hourPts[1].rx, 200e6);

    const sevenDayPts = store.interfaceHistory('r1', 'ether1-UP LINK', '7', now);
    assert.equal(sevenDayPts.length, 3); // 9d row pruned; 2d rows grouped (avg 70e6) + 10m bucket + current bucket
    assert.equal(sevenDayPts[0].rx, 70e6);
    assert.equal(sevenDayPts[1].rx, 100e6);
    assert.equal(sevenDayPts[2].rx, 200e6);

    const summaries = store.interfaceSummaries(86400000, now);
    const s = summaries.get('r1\0ether1-UP LINK');
    assert.ok(s);
    assert.equal(s.maxRx, 200e6);
    assert.equal(s.avgRx, 150e6);
    assert.ok(s.estRxBytes > 0);
    assert.ok(s.sparkline.length >= 1);
    store.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('HTTP endpoints /api/interfaces, /api/interfaces/history, and /charts.js enforce auth and return valid payloads', async () => {
  const { updateRouterConfigs, pollPppoe } = require('./server/pppoe.cjs');
  const dir = mkdtempSync(join(tmpdir(), 'momo-iface-http-'));
  let nms;
  let tick = 0;
  const mockRouter = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/rest/ppp/active' || u.pathname === '/rest/interface/pppoe-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    if (u.pathname === '/rest/interface/print') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        { '.id': '*1', name: 'ether1-UPLINK', type: 'ether', running: 'true', disabled: 'false', 'rx-byte': String(500000 + tick * 250000), 'tx-byte': String(200000 + tick * 125000) },
      ]));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise(r => mockRouter.listen(0, '127.0.0.1', r));
  const rPort = mockRouter.address().port;

  try {
    nms = createNmsServer(dir, {
      port: 0,
      seedOlts: [{ name: 'OLT TEST', host: '192.168.100.2', community: 'public', port: 161 }],
    });
    const port = await nms.start();

    // Wait briefly so auth cookie is ready & setup admin
    const unauth = await fetch('http://127.0.0.1:' + port + '/api/interfaces');
    assert.equal(unauth.status, 401);

    const setupRes = await fetch('http://127.0.0.1:' + port + '/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password123' }),
    });
    const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];

    // Configure router and poll twice
    updateRouterConfigs([{ id: 'r-http', name: 'MikroTik Utama', url: 'http://127.0.0.1:' + rPort, username: 'admin', password: 'pw' }]);
    await pollPppoe(true);
    tick = 1;
    await new Promise(r => setTimeout(r, 80));
    await pollPppoe(true);

    // /charts.js served cleanly
    const jsRes = await fetch('http://127.0.0.1:' + port + '/charts.js');
    assert.equal(jsRes.status, 200);
    assert.match(await jsRes.text(), /createInterfaceGraphView/);

    // /api/interfaces overview
    const ovRes = await fetch('http://127.0.0.1:' + port + '/api/interfaces?days=1', { headers: { Cookie: cookie } });
    assert.equal(ovRes.status, 200);
    const ov = await ovRes.json();
    assert.equal(ov.routers.length, 1);
    assert.equal(ov.routers[0].interfaces[0].name, 'ether1-UPLINK');
    assert.ok(ov.routers[0].interfaces[0].rxBps > 0);

    // /api/interfaces/history validation & live range
    const badHist = await fetch('http://127.0.0.1:' + port + '/api/interfaces/history', { headers: { Cookie: cookie } });
    assert.equal(badHist.status, 400);

    const liveHist = await fetch('http://127.0.0.1:' + port + '/api/interfaces/history?routerId=r-http&iface=ether1-UPLINK&range=live', {
      headers: { Cookie: cookie },
    });
    assert.equal(liveHist.status, 200);
    const livePayload = await liveHist.json();
    assert.equal(livePayload.meta.routerName, 'MikroTik Utama');
    assert.ok(livePayload.points.length >= 1);
    assert.ok(livePayload.points[0].rx > 0);
  } finally {
    updateRouterConfigs([]);
    try { nms?.stop(); } catch {}
    mockRouter.closeAllConnections?.();
    mockRouter.close();
    await new Promise(r => setTimeout(r, 100));
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
