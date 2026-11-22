async function check() {
  const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = pages.find(p => p.url.includes('127.0.0.1:8080'));
  console.log('Connected to page:', page.title, page.url);
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

  const session = await evalExpr("fetch('/api/session').then(r => r.json())");
  console.log('Current Session:', session);

  const olts = await evalExpr("fetch('/api/olts').then(r => r.json())");
  console.log('OLTs in system:', Array.isArray(olts) ? olts.map(o => ({ name: o.name, host: o.host, polling: o.polling, error: o.error, rows: o.rows?.length })) : olts);

  ws.close();
}
check().catch(console.error);
