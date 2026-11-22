process.env.SUPABASE_DISABLED = 'true';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { openStore } = require('./server/store.cjs');
const { createNmsServer } = require('./server/server.cjs');
const { pppoeView } = require('./server/pppoe.cjs');

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

    // Router settings
    store.setRouterConfig({ url: 'http://10.0.1.2:808', username: 'admin', password: 'secret' });
    const routerCfg = store.getRouterConfig();
    assert.equal(routerCfg.url, 'http://10.0.1.2:808');

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
    assert.ok(htmlText.includes('MOMO NET MONITORING SYSTEM'));

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
