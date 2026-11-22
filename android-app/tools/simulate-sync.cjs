const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

// In-memory mock cloud database simulating Supabase PostgREST tables
function createMockSupabaseServer() {
  const db = {
    nms_users: new Map(),
    nms_settings: new Map(),
    nms_olts: new Map(),
    nms_audit: [],
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const table = url.pathname.replace(/^\/rest\/v1\//, '');
    let bodyText = '';

    req.on('data', chunk => { bodyText += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = bodyText ? JSON.parse(bodyText) : null; } catch {}

      res.setHeader('Content-Type', 'application/json; charset=utf-8');

      if (table.startsWith('nms_users')) {
        if (req.method === 'GET') {
          return res.end(JSON.stringify(Array.from(db.nms_users.values())));
        }
        if (req.method === 'POST') {
          db.nms_users.set(body.username, body);
          return res.end(JSON.stringify([body]));
        }
      }

      if (table.startsWith('nms_settings')) {
        if (req.method === 'GET') {
          const keyParam = url.searchParams.get('key');
          if (keyParam && keyParam.startsWith('eq.')) {
            const key = keyParam.slice(3);
            const val = db.nms_settings.get(key);
            return res.end(JSON.stringify(val ? [val] : []));
          }
          return res.end(JSON.stringify(Array.from(db.nms_settings.values())));
        }
        if (req.method === 'POST') {
          db.nms_settings.set(body.key, body);
          return res.end(JSON.stringify([body]));
        }
      }

      if (table.startsWith('nms_olts')) {
        if (req.method === 'GET') {
          return res.end(JSON.stringify(Array.from(db.nms_olts.values())));
        }
        if (req.method === 'POST') {
          if (Array.isArray(body)) {
            for (const item of body) db.nms_olts.set(item.host, item);
          } else {
            db.nms_olts.set(body.host, body);
          }
          return res.end(JSON.stringify(body));
        }
        if (req.method === 'DELETE') {
          const hostParam = url.searchParams.get('host');
          if (hostParam && hostParam.startsWith('eq.')) {
            db.nms_olts.delete(hostParam.slice(3));
          } else {
            db.nms_olts.clear();
          }
          return res.end(JSON.stringify([]));
        }
      }

      if (table.startsWith('nms_audit')) {
        if (req.method === 'GET') {
          return res.end(JSON.stringify(db.nms_audit));
        }
        if (req.method === 'POST') {
          const entry = { ...body, id: db.nms_audit.length + 1 };
          db.nms_audit.unshift(entry);
          return res.end(JSON.stringify([entry]));
        }
        if (req.method === 'PATCH') {
          const idParam = url.searchParams.get('id');
          if (idParam && idParam.startsWith('eq.')) {
            const id = Number(idParam.slice(3));
            const item = db.nms_audit.find(a => a.id === id);
            if (item) Object.assign(item, body);
          }
          return res.end(JSON.stringify([]));
        }
      }

      res.writeHead(404).end(JSON.stringify({ message: 'Not found' }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: 'http://127.0.0.1:' + port,
        close: () => server.close(),
        db,
      });
    });
  });
}

test('multi-phone sync flow: admin phone sets data -> cloud receives -> technician phone pulls data', async () => {
  const cloud = await createMockSupabaseServer();
  process.env.SUPABASE_URL = cloud.url;
  process.env.SUPABASE_KEY = 'mock-key';

  const { SupabaseSync } = require('../src/server/supabase.cjs');
  const customSupabase = new SupabaseSync(cloud.url, 'mock-key');

  const dirPhoneA = mkdtempSync(join(tmpdir(), 'phone-a-'));
  const dirPhoneB = mkdtempSync(join(tmpdir(), 'phone-b-'));

  try {
    const { openStore } = require('../src/server/store.cjs');
    const { createNmsServer } = require('../src/server/server.cjs');

    // === PHONE A (ADMIN SETUP) ===
    console.log('--- Step 1: Admin configures Phone A ---');
    const storeA = openStore(join(dirPhoneA, 'data.sqlite'));
    await storeA.createUser('superadmin', 'adminpassword123', 'admin');
    await storeA.createUser('technician1', 'techpassword123', 'technician');
    await storeA.setPin('888999');
    storeA.setRouterConfig({ url: 'http://10.0.0.1:808', username: 'admin', password: 'mypassword' });

    // Wait a brief moment for async cloud pushes to finish
    await new Promise(r => setTimeout(r, 100));

    // Verify Cloud received data from Phone A
    console.log('--- Step 2: Verifying Cloud State ---');
    assert.equal(cloud.db.nms_users.has('superadmin'), true);
    assert.equal(cloud.db.nms_users.has('technician1'), true);
    assert.equal(cloud.db.nms_settings.has('security_pin'), true);
    assert.equal(cloud.db.nms_settings.has('router_config'), true);

    // Seed an OLT into Cloud
    await customSupabase.upsertOlt({
      name: 'OLT Mongkonai Pusat',
      host: '192.168.10.1',
      community: 'public',
      port: 161,
    });
    assert.equal(cloud.db.nms_olts.has('192.168.10.1'), true);

    // === PHONE B (NEW TECHNICIAN PHONE) ===
    console.log('--- Step 3: Technician opens Phone B (fresh install) ---');
    const storeB = openStore(join(dirPhoneB, 'data.sqlite'));
    await storeB.syncFromCloud();

    // Verify Phone B now has superadmin and technician1
    const usersB = storeB.users();
    console.log('Users on Phone B after cloud sync:', usersB);
    assert.equal(usersB.some(u => u.username === 'superadmin'), true);
    assert.equal(usersB.some(u => u.username === 'technician1'), true);

    // Verify Technician can login on Phone B
    const techToken = await storeB.login('technician1', 'techpassword123');
    assert.ok(techToken, 'Technician successfully logged in on Phone B!');

    // Verify PIN works on Phone B
    assert.equal(storeB.hasPin(), true);
    const pinToken = await storeB.loginPin('888999');
    assert.ok(pinToken, 'Admin PIN unlock works on Phone B!');

    // Verify Router config synced to Phone B
    const routerCfgB = storeB.getRouterConfig();
    assert.equal(routerCfgB.url, 'http://10.0.0.1:808');

    // === Step 4: Technician on Phone B restarts an ONU ===
    console.log('--- Step 4: Technician triggers ONU Restart on Phone B ---');
    const auditId = storeB.beginAudit('technician1', '192.168.10.1', 'A0:B1:C2:D3:E4:F5', 'reboot', 'Budi Santoso', '1.1');
    storeB.finishAudit(auditId, 200, true);

    await new Promise(r => setTimeout(r, 100));

    // === Step 5: Admin on Phone A opens Audit Log ===
    console.log('--- Step 5: Admin on Phone A inspects shared Audit Log ---');
    const auditsOnPhoneA = await storeA.audits();
    console.log('Audits visible to Admin on Phone A:', auditsOnPhoneA);
    assert.equal(auditsOnPhoneA.length > 0, true);
    assert.equal(auditsOnPhoneA[0].username, 'technician1');
    assert.equal(auditsOnPhoneA[0].mac, 'A0:B1:C2:D3:E4:F5');
    assert.equal(auditsOnPhoneA[0].outcome, 'sent');

    storeA.close();
    storeB.close();
    console.log('All multi-phone Supabase sync tests PASSED successfully!');
  } finally {
    cloud.close();
    rmSync(dirPhoneA, { recursive: true, force: true });
    rmSync(dirPhoneB, { recursive: true, force: true });
  }
});
