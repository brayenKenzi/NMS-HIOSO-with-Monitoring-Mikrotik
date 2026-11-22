const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { createNmsServer } = require('../src/server/server.cjs');

const dataDir = join(__dirname, '..', '.local-pc-data');
mkdirSync(dataDir, { recursive: true });

const port = Number(process.env.NMS_LOCAL_PORT || 8085);
const srv = createNmsServer(dataDir, { port });

srv.start().then((actualPort) => {
  console.log('====================================================');
  console.log('MOMO NET NMS (Mode Uji Lokal PC - Multi-MikroTik & HSGQ)');
  console.log('Buka di browser: http://127.0.0.1:' + actualPort + '/');
  console.log('Data lokal disimpan di:', dataDir);
  console.log('====================================================');
}).catch((err) => {
  console.error('Gagal menjalankan server lokal:', err);
  process.exit(1);
});

process.on('SIGINT', () => { srv.stop(); process.exit(0); });
process.on('SIGTERM', () => { srv.stop(); process.exit(0); });
