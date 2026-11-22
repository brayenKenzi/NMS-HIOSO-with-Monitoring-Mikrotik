import { spawn } from 'node:child_process';

const port = process.env.NMS_PORT || 8080;
const url = 'http://127.0.0.1:' + port;
const isNms = async () => {
  try {
    const response = await fetch(url + '/api/session', { signal: AbortSignal.timeout(1000) });
    return response.ok && typeof (await response.json()).setup === 'boolean';
  } catch {
    return false;
  }
};
const openBrowser = () => {
  spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
    detached: true, stdio: 'ignore',
  }).unref();
};

if (await isNms()) {
  openBrowser();
} else {
  const server = spawn(process.execPath, ['server.mjs'], { stdio: 'inherit' });
  server.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  for (let attempt = 0; attempt < 20 && server.exitCode === null; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (await isNms()) {
      openBrowser();
      break;
    }
  }
}
