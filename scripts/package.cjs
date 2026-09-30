'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { build, Platform, Arch } = require('electron-builder');
const { getElectronVersion } = require('app-builder-lib/out/electron/electronVersion');

async function localElectronConfig(root, target, arch) {
  const host = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
  if (target !== host || arch !== process.arch) return {};
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = await getElectronVersion(root, metadata.build || {});
  const directory = path.join(root, 'node_modules', 'electron');
  const relativeExecutable = { win32: 'electron.exe', darwin: 'Electron.app/Contents/MacOS/Electron', linux: 'electron' }[process.platform];
  const executable = path.join(directory, 'dist', relativeExecutable);
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (installed.version !== version || !fs.statSync(executable).isFile()) return {};
    const result = spawnSync(executable, ['-p', 'JSON.stringify({version:process.versions.electron,platform:process.platform,arch:process.arch})'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 16384,
    });
    if (result.error || result.status !== 0) return {};
    const actual = JSON.parse(result.stdout.trim());
    if (actual.version !== version || actual.platform !== process.platform || actual.arch !== arch) return {};
    return { electronVersion: version, electronDist: path.join(directory, 'dist') };
  } catch { return {}; }
}

async function main() {
  const args = process.argv.slice(2);
  const host = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
  let target = host;
  let arch = process.arch;
  let unpacked = false;
  let requestedFormat;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--platform') target = args[++index];
    else if (args[index] === '--arch') arch = args[++index];
    else if (args[index] === '--dir') unpacked = true;
    else if (args[index] === '--target') requestedFormat = args[++index];
    else throw new Error(`Unknown packaging option: ${args[index]}`);
  }
  if (!host || !['win', 'mac', 'linux'].includes(target)) throw new Error('Choose a supported target: win, mac, or linux.');
  if (target !== host) throw new Error(`Build ${target} packages on a native ${target} host or use the matching CI job.`);
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Supported package architectures are x64 and arm64.');
  if (target === 'win' && arch !== 'x64') throw new Error('The Windows release currently targets x64. macOS and Linux support x64 and arm64.');
  const supportedFormats = { win: ['portable', 'nsis'], mac: ['dmg', 'zip'], linux: ['AppImage', 'deb'] }[target];
  if (requestedFormat && !supportedFormats.includes(requestedFormat)) throw new Error(`Unsupported ${target} format: ${requestedFormat}`);
  if (unpacked && requestedFormat) throw new Error('Choose either --dir or --target, not both.');
  const formats = unpacked ? ['dir'] : requestedFormat ? [requestedFormat] : supportedFormats;
  const config = {};
  if (target === 'linux' && formats.includes('deb')) {
    const homepage = process.env.STATUSLINE_PROJECT_HOMEPAGE || (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}` : null);
    if (!homepage) throw new Error('DEB metadata requires your project URL. Set STATUSLINE_PROJECT_HOMEPAGE, or use --target AppImage. CI uses its actual repository URL.');
    const url = new URL(homepage);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Project homepage must be an HTTP(S) URL without credentials.');
    config.extraMetadata = { homepage: url.href };
  }
  const root = path.resolve(__dirname, '..');
  Object.assign(config, await localElectronConfig(root, target, arch));
  const icons = spawnSync(process.execPath, [path.join(__dirname, 'create-icon.cjs')], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (icons.error || icons.status !== 0) throw icons.error || new Error('Icon generation failed.');
  const platform = { win: Platform.WINDOWS, mac: Platform.MAC, linux: Platform.LINUX }[target];
  console.log(`Packaging AgentGlance for ${target}/${arch}: ${formats.join(', ')}`);
  await build({
    projectDir: root,
    targets: platform.createTarget(formats, arch === 'arm64' ? Arch.arm64 : Arch.x64),
    publish: 'never',
    config,
  });
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { localElectronConfig };
