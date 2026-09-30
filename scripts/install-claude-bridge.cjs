#!/usr/bin/env node
'use strict';

// Explicit, reversible setup. Never run automatically at app startup.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function readJson(filename, fallback) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filename);
}

function quotedCommandPath(value) {
  // Claude runs statusLine commands through a shell. Reject metacharacters rather
  // than pretending JSON escaping is shell escaping; use forward slashes on Windows.
  const normalized = value.replace(/\\/g, '/');
  if (/["`$\r\n]/.test(normalized)) throw new Error('This path needs manual shell quoting; no settings were changed.');
  return `"${normalized}"`;
}

async function main() {
  const action = process.argv[2];
  if (!['--install', '--restore'].includes(action)) {
    console.log('Usage: node scripts/install-claude-bridge.cjs --install | --restore');
    return;
  }
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settingsPath = path.join(claudeHome, 'settings.json');
  const directory = path.join(claudeHome, 'statusline-usage');
  const manifestPath = path.join(directory, 'manifest.json');
  const settings = await readJson(settingsPath, {});
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Claude settings are not an object.');
  const prior = await readJson(manifestPath, null);
  if (action === '--restore') {
    if (!prior) throw new Error('No usage bridge installation was found.');
    if (settings.statusLine?.command !== prior.installedCommand) throw new Error('The status line changed after installation; restore it manually to preserve those changes.');
    if (prior.originalHadStatusLine) settings.statusLine = prior.originalStatusLine;
    else delete settings.statusLine;
    await atomicJson(settingsPath, settings);
    console.log('Restored the previous Claude status line. Usage cache and restore manifest were retained.');
    return;
  }
  if (prior && settings.statusLine?.command === prior.installedCommand) {
    await fs.copyFile(path.join(__dirname, 'claude-statusline.cjs'), path.join(directory, 'bridge.cjs'));
    await fs.copyFile(path.join(__dirname, '..', 'electron', 'claude-usage.cjs'), path.join(directory, 'claude-usage.cjs'));
    console.log('Claude usage bridge updated. Existing output, settings and original restore manifest were preserved.');
    return;
  }
  let forwardExecutable = null;
  let forwardScript = null;
  if (settings.statusLine?.command) {
    const match = settings.statusLine.command.match(/^(?:"([^"]+)"|(\S+))\s+(?:"([^"]+)"|(\S+))\s*$/);
    if (!match) throw new Error('Existing status line needs manual composition; settings were not changed.');
    forwardExecutable = match[1] || match[2];
    forwardScript = match[3] || match[4];
    if (!/^node(?:\.exe)?$/i.test(path.basename(forwardExecutable)) || !/\.(?:cjs|mjs|js)$/i.test(forwardScript) || !path.isAbsolute(forwardScript)) {
      throw new Error('Only a standalone Node status-line script can be composed automatically; settings were not changed.');
    }
    await fs.access(forwardScript);
  }
  const bridgePath = path.join(directory, 'bridge.cjs');
  const installedCommand = `${quotedCommandPath(process.execPath)} ${quotedCommandPath(bridgePath)} --manifest ${quotedCommandPath(manifestPath)}`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.copyFile(path.join(__dirname, 'claude-statusline.cjs'), bridgePath);
  await fs.copyFile(path.join(__dirname, '..', 'electron', 'claude-usage.cjs'), path.join(directory, 'claude-usage.cjs'));
  const manifest = {
    schemaVersion: 1,
    originalHadStatusLine: Object.hasOwn(settings, 'statusLine'),
    originalStatusLine: settings.statusLine ?? null,
    installedCommand, forwardExecutable, forwardScript,
    installedAt: new Date().toISOString(),
  };
  await atomicJson(manifestPath, manifest);
  settings.statusLine = { ...(settings.statusLine || {}), type: 'command', command: installedCommand, refreshInterval: 30 };
  await atomicJson(settingsPath, settings);
  console.log('Claude usage sync installed. The existing status-line output is preserved; only numeric usage is cached.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
