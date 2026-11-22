async function run() {
  const pages = await (await fetch('http://127.0.0.1:61459/json/list')).json();
  const page = pages.find(p => p.url.includes('127.0.0.1:8080'));

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);

  function evalExpr(expr) {
    return new Promise((resolve) => {
      const id = 200 + Math.floor(Math.random() * 1000);
      const onMsg = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          ws.removeEventListener('message', onMsg);
          resolve(msg.result?.result?.value);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
  }

  // Logout
  console.log('Logging out...');
  await evalExpr(`(async () => {
    await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    location.reload();
  })()`);

  await new Promise(r => setTimeout(r, 1500));

  // Check login modal after reload
  const loginState = await evalExpr(`(() => {
    return {
      authOpen: document.getElementById('auth-dialog')?.open,
      authTitle: document.getElementById('auth-title')?.textContent,
      pinSectionVisible: !document.getElementById('pin-section')?.hidden,
      formVisible: !document.getElementById('auth-form')?.hidden,
    };
  })()`);
  console.log('Login modal state:', loginState);

  // Try PIN login with 123456
  console.log('Testing PIN unlock with 123456...');
  const pinResult = await evalExpr(`(async () => {
    document.getElementById('pin-input').value = '123456';
    document.getElementById('pin-submit').click();
    await new Promise(r => setTimeout(r, 800));
    return {
      authOpen: document.getElementById('auth-dialog')?.open,
      user: document.getElementById('session-user')?.textContent,
    };
  })()`);
  console.log('PIN Unlock Result:', pinResult);

  ws.close();
}

run().catch(console.error);
