import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const adb = join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe');
const serial = process.argv[2] ?? 'emulator-5554';
const packageName = 'id.momonet.nms.probe';
const cmd = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000 }).trim();
const targets = JSON.parse(readFileSync(new URL('../../olts.json', import.meta.url)));

cmd('shell', 'am', 'start', '-n', packageName + '/.MainActivity');
let localPort;
let socket;
let sequence = 0;
const calls = new Map();
try {
  for (let attempt = 0; attempt < 30; attempt++) {
    let processId;
    try { processId = cmd('shell', 'pidof', packageName).split(' ')[0]; }
    catch { /* Activity may still be starting. */ }
    if (processId) {
      const unix = cmd('shell', 'cat', '/proc/net/unix');
      if (unix.includes('webview_devtools_remote_' + processId)) {
        localPort = cmd('forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + processId);
        break;
      }
    }
    await delay(750);
  }
  assert(localPort, 'WebView debug socket unavailable');
  let target;
  for (let attempt = 0; attempt < 20; attempt++) {
    const pages = await (await fetch('http://127.0.0.1:' + localPort + '/json/list',
      { signal: AbortSignal.timeout(3000) })).json();
    target = pages.find(item => item.type === 'page' && item.title === 'Momo Net LAN Test');
    if (target) break;
    await delay(500);
  }
  assert(target, 'Momo Net test page unavailable');
  socket = new WebSocket('ws://127.0.0.1:' + localPort + new URL(target.webSocketDebuggerUrl).pathname);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const packet = JSON.parse(event.data);
    calls.get(packet.id)?.(packet);
  });

  function evaluate(expression) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        calls.delete(id);
        reject(new Error('WebView evaluation timed out'));
      }, 100000);
      calls.set(id, packet => {
        clearTimeout(timeout);
        calls.delete(id);
        if (packet.error || packet.result.exceptionDetails) reject(new Error('WebView evaluation failed'));
        else resolve(packet.result.result.value);
      });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  }

  async function waitForRuntime() {
    const expression = "document.getElementById('runtime-result').textContent";
    for (let attempt = 0; attempt < 40; attempt++) {
      const value = await evaluate(expression);
      if (value.includes('SQLite:') || value.includes('gagal dimulai')) return value;
      await delay(500);
    }
    throw new Error('Runtime UI did not report results');
  }

  async function form(kind, input) {
    const invoke = `(() => {
      const form = document.getElementById(${JSON.stringify(kind)});
      for (const [key, value] of Object.entries(${JSON.stringify(input)})) form.elements[key].value = value;
      form.requestSubmit();
      return form.querySelector('button').disabled;
    })()`;
    assert(await evaluate(invoke), 'Test form did not begin');
    for (let attempt = 0; attempt < 95; attempt++) {
      const value = await evaluate(`document.getElementById(${JSON.stringify(kind + '-result')}).textContent`);
      if (value && value !== 'Pengujian berlangsung…') return value;
      await delay(1000);
    }
    throw new Error('No result for ' + kind);
  }

  const runtime = await waitForRuntime();
  console.log(runtime);
  assert.match(runtime, /HTTP loopback: Lulus/);
  assert.match(runtime, /UDP loopback: Lulus/);
  if (!runtime.includes('SQLite: Lulus')) process.exitCode = 1;
  for (const device of targets) {
    const community = device.community ?? process.env[device.communityEnv];
    assert(community, 'Community baca belum dikonfigurasi.');
    const value = await form('olt', { host: device.host, port: device.port ?? 161, community });
    console.log(device.host, value);
    if (!/^[1-9]\d* ONU · [1-9]\d* dengan redaman$/.test(value)) process.exitCode = 1;
  }
  const router = await form('router', { url: process.env.PPPOE_URL, username: process.env.PPPOE_USER, password: process.env.PPPOE_PASSWORD });
  console.log('MikroTik:', router);
  if (!/^[1-9]\d* sesi aktif · [1-9]\d* dengan penghitung trafik$/.test(router)) process.exitCode = 1;
  const disconnected = await form('olt', { host:'192.168.254.253', port:161, community:'test-only' });
  console.log('OLT tidak terjangkau:', disconnected);
  if (!disconnected.includes('Tidak satu jaringan dengan OLT')) process.exitCode = 1;
} finally {
  socket?.close();
  if (localPort) cmd('forward', '--remove', 'tcp:' + localPort);
}
