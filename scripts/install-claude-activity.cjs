#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
async function readJson(filename, fallback) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function writeJson(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filename);
}
function quote(value) {
  const normalized = value.replace(/\\/g, '/');
  if (/["`$%\r\n]/.test(normalized)) throw new Error('This installation path needs manual shell quoting.');
  return `"${normalized}"`;
}

async function main() {
  const action = process.argv[2];
  if (!['--install', '--restore'].includes(action)) {
    console.log('Usage: node scripts/install-claude-activity.cjs --install | --restore');
    return;
  }
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const directory = path.join(home, 'statusline-activity');
  const settingsPath = path.join(home, 'settings.json');
  const manifestPath = path.join(directory, 'manifest.json');
  const settings = await readJson(settingsPath, {});
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Claude settings must be a JSON object.');
  if (settings.hooks != null && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error('Existing Claude hooks must be an object.');
  const prior = await readJson(manifestPath, null);
  if (action === '--restore') {
    if (!prior?.command || !Array.isArray(prior.events)) throw new Error('No activity hook installation was found.');
    for (const event of prior.events) {
      if (!Array.isArray(settings.hooks?.[event])) continue;
      settings.hooks[event] = settings.hooks[event].flatMap(group => {
        if (!Array.isArray(group.hooks)) return [group];
        const retained = group.hooks.filter(hook => hook.command !== prior.command);
        if (retained.length === group.hooks.length) return [group];
        return retained.length ? [{ ...group, hooks: retained }] : [];
      });
      if (!settings.hooks[event].length && !prior.originalEvents.includes(event)) delete settings.hooks[event];
    }
    if (settings.hooks && !Object.keys(settings.hooks).length && !prior.originalHadHooks) delete settings.hooks;
    await writeJson(settingsPath, settings);
    console.log('Removed AgentGlance activity hooks. All other hooks and settings were preserved.');
    return;
  }
  for (const event of EVENTS) if (settings.hooks?.[event] != null && !Array.isArray(settings.hooks[event])) throw new Error(`Existing ${event} hooks are not an array; no settings changed.`);
  const script = path.join(directory, 'hook.cjs');
  const marker = prior?.marker || crypto.randomUUID();
  const command = `${quote(process.execPath)} ${quote(script)} --statusline-activity=${marker}`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.copyFile(path.join(__dirname, 'claude-activity-hook.cjs'), script);
  const existingInstallation = Boolean(prior?.command && Object.values(settings.hooks || {}).some(groups => Array.isArray(groups) && groups.some(group => group.hooks?.some(hook => hook.command === prior.command))));
  const manifest = existingInstallation ? { ...prior, command } : {
    schemaVersion: 1, marker, command, events: EVENTS,
    originalHadHooks: Object.hasOwn(settings, 'hooks'), originalEvents: Object.keys(settings.hooks || {}), installedAt: new Date().toISOString(),
  };
  settings.hooks ||= {};
  for (const event of EVENTS) {
    settings.hooks[event] ||= [];
    if (settings.hooks[event].some(group => group.hooks?.some(hook => hook.command === command))) continue;
    const group = { hooks: [{ type: 'command', command, async: true, timeout: 2 }] };
    if (event === 'Notification') group.matcher = 'permission_prompt|idle_prompt';
    settings.hooks[event].push(group);
  }
  await writeJson(manifestPath, manifest);
  await writeJson(settingsPath, settings);
  console.log('Installed silent Claude activity hooks alongside existing hooks. No conversation content is saved.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
