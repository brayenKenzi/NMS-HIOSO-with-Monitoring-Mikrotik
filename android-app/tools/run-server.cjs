const { mkdirSync } = require('node:fs');
const { createNmsServer } = require('../src/server/server.cjs');

process.on('uncaughtException', (err) => {
  console.error('ADT Server uncaughtException:', err?.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('ADT Server unhandledRejection:', reason);
});

const dataDir = process.env.NMS_DATA_DIR || '/var/lib/adt-monitoring';
const bindHost = process.env.NMS_HOST || '0.0.0.0';
const port = Number(process.env.NMS_PORT || 8080);

mkdirSync(dataDir, { recursive: true });
const srv = createNmsServer(dataDir, { port, bindHost });

srv.start().then((actualPort) => {
  console.log(`ADT Monitoring Server active on http://${bindHost}:${actualPort}/ (dataDir=${dataDir})`);
}).catch((err) => {
  console.error('Failed to start ADT Monitoring Server:', err);
  process.exit(1);
});

function shutdown() {
  try { srv.stop(); } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
