'use strict';

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');

async function main() {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: path.resolve(__dirname, '..'),
    server: { host: '127.0.0.1', port: 5173, strictPort: false },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  console.log(`AgentGlance desktop · ${url}`);
  const environment = { ...process.env, STATUSLINE_DEV_URL: url };
  delete environment.ELECTRON_RUN_AS_NODE;
  const electron = spawn(require('electron'), ['.'], {
    cwd: path.resolve(__dirname, '..'),
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  let stopping = false;
  async function stop(code = 0, killChild = true) {
    if (stopping) return;
    stopping = true;
    if (killChild && electron.pid && electron.exitCode === null) {
      if (process.platform === 'win32') {
        await new Promise((resolve) => execFile('taskkill', ['/pid', String(electron.pid), '/T', '/F'], { windowsHide: true }, resolve));
      } else {
        electron.kill('SIGTERM');
      }
    }
    await server.close();
    process.exitCode = code;
  }
  electron.on('exit', (code) => { void stop(code || 0, false); });
  electron.on('error', (error) => {
    console.error('Could not start Electron:', error.message);
    void stop(1, false);
  });
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
