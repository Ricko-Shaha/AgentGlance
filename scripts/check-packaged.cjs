'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function main() {
  const root = path.resolve(__dirname, '..');
  const args = process.argv.slice(2);
  let arch = process.arch;
  let executable = process.env.STATUSLINE_TEST_EXECUTABLE;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--arch') arch = args[++index];
    else if (args[index] === '--executable') executable = args[++index];
    else throw new Error(`Unknown packaged check option: ${args[index]}`);
  }
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Architecture must be x64 or arm64.');
  if (!executable) {
    const suffix = arch === 'x64' ? '' : `-${arch}`;
    const platformPath = {
      win32: `win${suffix}-unpacked/AgentGlance.exe`,
      darwin: `mac${suffix}/AgentGlance.app/Contents/MacOS/AgentGlance`,
      linux: `linux${suffix}-unpacked/agentglance`,
    }[process.platform];
    if (!platformPath) throw new Error('Packaged desktop checks support Windows, macOS and Linux.');
    executable = path.join(root, 'release', platformPath);
  }
  executable = path.resolve(executable);
  await fs.access(executable);
  await require('./check-packaged-worker.cjs').checkPackagedWorker(executable);
  const env = { ...process.env, STATUSLINE_TEST_EXECUTABLE: executable };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [path.join(root, 'tests', 'desktop-smoke.cjs')], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
