import { Nodejs } from '@capawesome/capacitor-nodejs';

const byId = id => document.getElementById(id);
const pending = new Map();
let sequence = 0;
let nmsPort = null;

async function probe(kind, input = {}) {
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Runtime tidak merespons dalam batas waktu.'));
    }, 93000);
    pending.set(id, (ok, value) => {
      clearTimeout(timer);
      pending.delete(id);
      if (ok) resolve(value);
      else reject(new Error(value));
    });
    Nodejs.send({ eventName: 'probe', args: [id, kind, input] }).catch(error => {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    });
  });
}

const runtimeSummary = value => [
  'Node.js ' + value.version + ' · ' + value.arch,
  ...[['http', 'HTTP loopback'], ['udp', 'UDP loopback'], ['sqlite', 'SQLite']]
    .map(([key, label]) => label + ': ' + (value[key].ok ? 'Lulus · ' : 'Gagal · ') + value[key].value),
].join('\n');

function renderOnus(value) {
  const list = document.createElement('ul');
  for (const row of value.rows) {
    const item = document.createElement('li');
    item.textContent = [row.name || 'Tanpa nama', row.mac || 'MAC kosong', row.status,
      row.rx === null ? 'Redaman belum terukur' : row.rx + ' dBm'].join(' · ');
    list.append(item);
  }
  const container = byId('onu-list');
  if (container) container.replaceChildren(list);
  return value.rows.length + ' ONU · ' + value.measured + ' dengan redaman';
}

async function run(kind, input, button, summarize) {
  const result = byId(kind + '-result');
  if (result) result.textContent = 'Pengujian berlangsung…';
  if (button) button.disabled = true;
  try {
    const res = await probe(kind, input);
    if (result) result.textContent = summarize(res);
  } catch (error) {
    if (result) result.textContent = error.message;
  } finally {
    if (button) button.disabled = false;
  }
}

let launched = false;

async function launchDashboard(port) {
  const btn = byId('btn-open-dashboard');
  if (btn) btn.style.display = 'inline-block';
  if (window.location.search.includes('probe=1') || window.__PROBE_MODE__) {
    console.log('Mode diagnostik aktif, tidak beralih ke dashboard otomatis.');
    return;
  }
  if (launched) return;
  launched = true;
  const status = byId('splash-status');
  if (status) status.textContent = 'Membuka Dashboard ADT Monitoring...';
  const targetUrl = 'http://127.0.0.1:' + port + '/';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const check = await fetch(targetUrl + 'api/session', { signal: AbortSignal.timeout(3000) });
      if (check.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  window.location.replace(targetUrl);
}

async function start() {
  const runtime = byId('runtime');

  await Nodejs.addListener('message', event => {
    if (event.eventName === 'server-ready') {
      const data = event.args[0];
      if (data && data.port) {
        nmsPort = data.port;
        launchDashboard(nmsPort);
      }
    } else if (event.eventName === 'probe-result') {
      const [id, ok, value] = event.args;
      pending.get(id)?.(ok, value);
    }
  });

  let enabled = false;
  async function ready() {
    if (enabled) return;
    enabled = true;
    if (runtime) runtime.disabled = false;
    byId('olt')?.querySelector('button')?.removeAttribute('disabled');
    byId('router')?.querySelector('button')?.removeAttribute('disabled');
    try {
      const res = await probe('runtime', {});
      if (byId('runtime-result')) byId('runtime-result').textContent = runtimeSummary(res);
      if (res.nmsPort) {
        nmsPort = res.nmsPort;
        launchDashboard(nmsPort);
      }
    } catch (e) {
      if (byId('runtime-result')) byId('runtime-result').textContent = 'Error runtime: ' + e.message;
    }
  }

  await Nodejs.addListener('ready', ready);

  if (runtime) runtime.onclick = () => run('runtime', {}, runtime, runtimeSummary);

  for (const [kind, summarize] of [
    ['olt', renderOnus],
    ['router', value => value.sessions + ' sesi aktif · ' + value.withCounters + ' dengan penghitung trafik'],
  ]) {
    const form = byId(kind);
    if (!form) continue;
    form.onsubmit = event => {
      event.preventDefault();
      const input = Object.fromEntries(new FormData(form));
      if (kind === 'olt') {
        const onuList = byId('onu-list');
        if (onuList) onuList.replaceChildren();
        form.elements.community.value = '';
      } else form.elements.password.value = '';
      void run(kind, input, form.querySelector('button'), summarize);
    };
  }

  const btnOpen = byId('btn-open-dashboard');
  if (btnOpen) {
    btnOpen.onclick = () => {
      if (nmsPort) window.location.replace('http://127.0.0.1:' + nmsPort + '/');
      else alert('Server NMS belum siap.');
    };
  }

  const isReady = await Nodejs.isReady();
  if (isReady.ready) ready();
  else await Nodejs.start();
}

start().catch(error => {
  const el = byId('runtime-result') || byId('splash-status');
  if (el) el.textContent = 'Runtime gagal dimulai: ' + error.message;
});
