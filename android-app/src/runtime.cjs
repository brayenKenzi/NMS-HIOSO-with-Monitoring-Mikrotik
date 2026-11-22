const { app, channel } = require('bridge');
const { createNmsServer } = require('./server/server.cjs');
const { localHttp, localUdp, sqlite, readOlt, readRouter } = require('./probes.cjs');

const dataDir = app.datadir();
let nmsInstance = null;
let activePort = null;
let startError = null;

async function ensureServer() {
  if (activePort) return activePort;
  if (!nmsInstance) {
    nmsInstance = createNmsServer(dataDir, { port: 8080 });
    try {
      activePort = await nmsInstance.start();
      console.log('MOMO NET NMS Server aktif di port:', activePort);
    } catch (err) {
      startError = err.message;
      console.error('Gagal memulai NMS Server:', err.message);
      throw err;
    }
  }
  return activePort;
}

// Start NMS server on launch
ensureServer()
  .then(port => {
    channel.post('server-ready', { port, host: '127.0.0.1', ok: true });
  })
  .catch(err => {
    channel.post('server-ready', { error: err.message, ok: false });
  });

// Handle commands from WebView
channel.on('get-server-info', async (id) => {
  try {
    const port = await ensureServer();
    channel.post('server-info', id, true, { port, host: '127.0.0.1' });
  } catch (err) {
    channel.post('server-info', id, false, err.message);
  }
});

// Diagnostic probe listener (backward compatibility for unit and emulator tests)
channel.on('probe', async (id, kind, input) => {
  try {
    let result;
    if (kind === 'runtime') {
      const port = await ensureServer();
      const checks = await Promise.allSettled([localHttp(), localUdp(), Promise.resolve().then(() => sqlite(dataDir))]);
      result = { version: process.versions.node, arch: process.arch, nmsPort: port };
      for (const [index, check] of checks.entries()) {
        result[['http', 'udp', 'sqlite'][index]] = check.status === 'fulfilled'
          ? { ok: true, value: check.value } : { ok: false, value: check.reason.message };
      }
    } else if (kind === 'olt') {
      result = await readOlt(input.host, input.community, Number(input.port || 161));
    } else if (kind === 'router') {
      result = await readRouter(input.url, input.username, input.password);
    } else throw new Error('Pengujian tidak dikenal.');
    channel.post('probe-result', id, true, result);
  } catch (error) {
    channel.post('probe-result', id, false, error.message);
  }
});
