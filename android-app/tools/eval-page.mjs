async function run() {
  const ws = new WebSocket('ws://127.0.0.1:55505/devtools/page/5B3B9EADCD42E6904EE79C25409B6EB4');
  await new Promise(r => ws.onopen = r);

  function evalExpr(expr) {
    return new Promise((resolve, reject) => {
      const id = 100 + Math.floor(Math.random() * 1000);
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

  const status = await evalExpr('document.getElementById("splash-status")?.textContent');
  console.log('Splash Status:', status);
  const runtime = await evalExpr('document.getElementById("runtime-result")?.textContent');
  console.log('Runtime Result:', runtime);

  // Test fetching from the internal server (127.0.0.1:8080) directly from inside WebView!
  const fetchTest = await evalExpr(`(async () => {
    try {
      const res = await fetch("http://127.0.0.1:8080/api/session");
      const data = await res.json();
      return "FETCH SUCCESS: " + JSON.stringify(data);
    } catch (err) {
      return "FETCH ERROR: " + err.message;
    }
  })()`);
  console.log('Fetch from inside WebView to 127.0.0.1:8080:', fetchTest);

  ws.close();
}

run().catch(console.error);
