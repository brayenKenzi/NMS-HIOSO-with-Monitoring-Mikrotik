import { readFileSync } from 'node:fs';

async function check() {
  const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  console.log('Available Pages:', pages.map(p => ({ title: p.title, url: p.url })));
  if (!pages.length) return;
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);

  let seq = 0;
  function evaluate(expr) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const handler = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          ws.removeEventListener('message', handler);
          if (msg.error || msg.result?.exceptionDetails) reject(msg.error || msg.result.exceptionDetails);
          else resolve(msg.result?.result?.value);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
  }

  const currentHref = await evaluate('location.href');
  console.log('Current location.href:', currentHref);
  const title = await evaluate('document.title');
  console.log('Current document.title:', title);
  const splashText = await evaluate('document.getElementById("splash-status")?.textContent');
  console.log('Splash status text:', splashText);

  // If still on localhost, try navigating to 127.0.0.1:8080
  if (currentHref.includes('localhost')) {
    console.log('Attempting navigation to http://127.0.0.1:8080/ ...');
    await evaluate('location.href = "http://127.0.0.1:8080/"');
    await new Promise(r => setTimeout(r, 1500));
    const nextPages = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    console.log('Pages after navigation:', nextPages.map(p => ({ title: p.title, url: p.url })));
  }

  ws.close();
}

check().catch(console.error);
