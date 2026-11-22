async function run() {
  const pages = await (await fetch('http://127.0.0.1:61459/json/list')).json();
  const page = pages.find(p => p.url.includes('127.0.0.1:8080'));

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);

  function evalExpr(expr) {
    return new Promise((resolve, reject) => {
      const id = 100 + Math.floor(Math.random() * 1000);
      const onMsg = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          ws.removeEventListener('message', onMsg);
          if (msg.error || msg.result?.exceptionDetails) reject(msg.error || msg.result.exceptionDetails);
          else resolve(msg.result?.result?.value);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
  }

  // 1. Create admin account and PIN via setup form
  console.log('--- 1. Testing Admin Setup ---');
  const setupResult = await evalExpr(`(async () => {
    const form = document.getElementById('auth-form');
    form.elements['username'].value = 'admin';
    form.elements['password'].value = 'momo2026!';
    if (form.elements['pin']) form.elements['pin'].value = '123456';
    form.requestSubmit();
    await new Promise(r => setTimeout(r, 1000));
    return {
      authOpen: document.getElementById('auth-dialog')?.open,
      user: document.getElementById('session-user')?.textContent,
      hasAdminMenu: !document.getElementById('admin-menu')?.hidden,
    };
  })()`);
  console.log('Setup result:', setupResult);

  // 2. Verify Session after Setup
  console.log('--- 2. Verifying Session & Roles ---');
  const sessionAfter = await evalExpr(`(async () => {
    const res = await fetch('/api/session');
    return await res.json();
  })()`);
  console.log('Session after setup:', sessionAfter);

  // 3. Import OLT & MikroTik config via API
  console.log('--- 3. Testing Config Import ---');
  const importResult = await evalExpr(`(async () => {
    const testConfig = {
      olts: [
        { name: "Momonetwork Mongkonai", host: "192.168.0.99", port: 161, community: "public" },
        { name: "Momonetwork Mocil", host: "192.168.0.97", port: 161, community: "public" }
      ],
      router: {
        url: "http://10.0.1.2:808",
        username: "admin",
        password: "secretpassword"
      }
    };
    const res = await fetch('/api/admin/config/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testConfig)
    });
    return await res.json();
  })()`);
  console.log('Import result:', importResult);

  // 4. Verify OLTs API as logged in user
  console.log('--- 4. Checking /api/olts ---');
  await new Promise(r => setTimeout(r, 1000));
  const oltsAfter = await evalExpr(`(async () => {
    const res = await fetch('/api/olts');
    return await res.json();
  })()`);
  console.log('OLTs returned:', oltsAfter.map(d => ({ name: d.name, host: d.host, error: d.error, polling: d.polling })));

  // 5. Test Router API
  console.log('--- 5. Checking /api/admin/router ---');
  const routerData = await evalExpr(`(async () => {
    const res = await fetch('/api/admin/router');
    return await res.json();
  })()`);
  console.log('Router config in store:', routerData);

  ws.close();
}

run().catch(console.error);
