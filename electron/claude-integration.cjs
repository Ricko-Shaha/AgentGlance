'use strict';

// Explicit, reversible application-owned setup. Reading status never writes files.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));

function locations(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const configDirectory = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
  const directory = path.join(configDirectory, 'statusline-integration');
  return { env, home, configDirectory, directory, settings: path.join(configDirectory, 'settings.json'), manifest: path.join(directory, 'manifest.json') };
}

async function readJson(filename, fallback) {
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Claude configuration is not a supported JSON file.');
    return JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

function quoteArgument(value, platform) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error('The installation path cannot be used in a Claude command.');
  if (platform === 'win32') {
    // Commands may be launched through cmd or Git Bash; reject characters whose
    // expansion differs instead of relying on JSON escaping or changing the path.
    if (/["`$%!]/.test(value)) throw new Error('This Windows installation path requires manual Claude setup.');
    return `"${value.replace(/\\/g, '/')}"`;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function workerCommand(mode, configDirectory, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (options.portable || env.PORTABLE_EXECUTABLE_FILE || env.APPIMAGE) {
    throw new Error('Install AgentGlance in a stable application location before connecting Claude telemetry. Portable launchers do not provide a persistent worker executable.');
  }
  const executable = options.executablePath || process.execPath;
  if (options.isPackaged === true && !options.workerPath) throw new Error('Packaged setup requires an explicit worker path.');
  const runtimePath = platform === 'win32' ? path.win32 : path.posix;
  const workerPath = options.workerPath || runtimePath.join(options.appPath || path.join(__dirname, '..'), 'electron', 'claude-worker.cjs');
  const args = [workerPath, mode, '--config', configDirectory];
  if (platform === 'win32') {
    // A bare quoted executable is not callable in PowerShell. A fixed encoded
    // invocation works under both documented Claude Windows shells and retains
    // stdin for the worker. Paths are PowerShell literal arguments, never code.
    const literal = value => {
      if (typeof value !== 'string' || !value || /[\0\r\n"]/.test(value)) throw new Error('The installation path cannot be used in a Claude command.');
      return `'${value.replace(/'/g, "''")}'`;
    };
    const invocation = `$ProgressPreference='SilentlyContinue'; $env:ELECTRON_RUN_AS_NODE='1'; & ${[executable, ...args].map(literal).join(' ')}; exit $LASTEXITCODE`;
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(invocation, 'utf16le').toString('base64')}`;
  }
  return `env ELECTRON_RUN_AS_NODE=1 ${[executable, ...args].map(value => quoteArgument(value, platform)).join(' ')}`;
}

function claudeCommandShell(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== 'win32') return { kind: 'sh', executable: '/bin/sh' };
  const candidates = [env.CLAUDE_CODE_GIT_BASH_PATH];
  for (const directory of (env.PATH || env.Path || '').split(';').filter(Boolean)) {
    candidates.push(path.win32.join(directory, 'bash.exe'), path.win32.resolve(directory, '..', 'bin', 'bash.exe'));
  }
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean)) candidates.push(path.win32.join(root, 'Git', 'bin', 'bash.exe'));
  const bash = candidates.find(filename => {
    try { return filename && path.win32.isAbsolute(filename) && fsSync.statSync(filename).isFile(); } catch { return false; }
  });
  return bash ? { kind: 'bash', executable: bash } : { kind: 'powershell', executable: 'powershell.exe' };
}

function validateSettings(settings) {
  if (!isObject(settings)) throw new Error('Claude settings must be a JSON object; nothing was changed.');
  if (settings.hooks != null && !isObject(settings.hooks)) throw new Error('Claude hooks must be a JSON object; nothing was changed.');
  for (const event of EVENTS) {
    if (settings.hooks?.[event] != null && !Array.isArray(settings.hooks[event])) throw new Error(`Claude ${event} hooks must be an array; nothing was changed.`);
    for (const group of settings.hooks?.[event] || []) {
      if (!isObject(group) || !Array.isArray(group.hooks)) throw new Error(`Claude ${event} hook groups are unsupported; nothing was changed.`);
    }
  }
}

function hasHook(settings, event, command) {
  return Boolean(command && settings.hooks?.[event]?.some(group => group.hooks?.some(hook => hook.command === command)));
}

async function signedIn(options, loc) {
  const result = await require('./providers.cjs').getSnapshot({ home: loc.home, env: loc.env, platform: options.platform, processes: [], includeUsage: false, allowAuthProbe: true, ...(options.probeAuth ? { probeAuth: options.probeAuth } : {}) });
  return result.providers.some(provider => provider.id === 'claude');
}

async function state(options = {}) {
  const loc = locations(options);
  const settingsText = await fs.readFile(loc.settings, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (settingsText && Buffer.byteLength(settingsText) > 2 * 1024 * 1024) throw new Error('Claude configuration exceeds the supported size.');
  const settings = settingsText === null ? {} : JSON.parse(settingsText.replace(/^\uFEFF/, ''));
  validateSettings(settings);
  const manifest = await readJson(loc.manifest, null);
  const usageLegacy = await readJson(path.join(loc.configDirectory, 'statusline-usage', 'manifest.json'), null);
  const activityLegacy = await readJson(path.join(loc.configDirectory, 'statusline-activity', 'manifest.json'), null);
  const ownUsage = Boolean(manifest?.usageCommand && settings.statusLine?.command === manifest.usageCommand);
  const legacyUsage = Boolean(usageLegacy?.installedCommand && settings.statusLine?.command === usageLegacy.installedCommand);
  const ownActivity = Boolean(manifest?.activityCommand && EVENTS.every(event => hasHook(settings, event, manifest.activityCommand)));
  const legacyActivity = Boolean(activityLegacy?.command && EVENTS.every(event => hasHook(settings, event, activityLegacy.command)));
  const authenticated = await signedIn(options, loc);
  let reason = null;
  try { workerCommand('usage', loc.configDirectory, options); } catch (error) { reason = error.message; }
  if (!authenticated) reason = 'Sign in to Claude Code on this device before connecting telemetry.';
  const owned = Boolean(manifest?.schemaVersion === 1 && manifest.active !== false);
  return { loc, settings, settingsText, manifest, status: {
    provider: 'claude', signedIn: authenticated,
    installed: (ownUsage || legacyUsage) && (ownActivity || legacyActivity),
    usageConnected: ownUsage || legacyUsage,
    activityConnected: ownActivity || legacyActivity,
    legacy: legacyUsage || legacyActivity,
    canConnect: !reason,
    canDisconnect: owned,
    configDirectory: loc.configDirectory,
    reason,
  } };
}

async function getIntegrationStatus(options = {}) { return (await state(options)).status; }

async function connectIntegration(options = {}) {
  const current = await state(options);
  const { loc, settings, status } = current;
  if (!status.canConnect) throw new Error(status.reason);
  // An already working legacy bridge remains exactly as the user installed it.
  if (status.usageConnected && status.activityConnected) return status;
  const originalText = current.settingsText;
  const usageCommand = workerCommand('usage', loc.configDirectory, options);
  const activityCommand = workerCommand('activity', loc.configDirectory, options);
  const prior = current.manifest;
  if (prior?.active !== false && prior?.usageCommand && settings.statusLine?.command !== prior.usageCommand) {
    throw new Error('The Claude status line changed after setup. Disconnect the previous integration before reconnecting; your edits were preserved.');
  }
  if (settings.statusLine != null && (!isObject(settings.statusLine) || settings.statusLine.type !== 'command' || typeof settings.statusLine.command !== 'string')) {
    throw new Error('The existing Claude status line is not a shell command; nothing was changed.');
  }
  const activePrior = prior?.schemaVersion === 1 && prior.active !== false;
  const manifest = activePrior ? { ...prior, usageCommand, activityCommand } : {
    schemaVersion: 1, active: true,
    originalHadStatusLine: Object.hasOwn(settings, 'statusLine'),
    originalStatusLine: settings.statusLine ?? null,
    originalHadHooks: Object.hasOwn(settings, 'hooks'),
    originalEvents: Object.keys(settings.hooks || {}),
    forwardCommand: settings.statusLine?.command || null,
    forwardShell: claudeCommandShell(options),
    usageCommand, activityCommand,
    installedAt: new Date().toISOString(),
  };
  const next = clone(settings);
  // Preserve a legacy observer when adding the missing half of setup.
  if (!status.usageConnected || activePrior) next.statusLine = { ...(next.statusLine || {}), type: 'command', command: usageCommand, refreshInterval: 30 };
  manifest.installedStatusLine = next.statusLine;
  next.hooks ||= {};
  for (const event of EVENTS) {
    next.hooks[event] ||= [];
    if (status.activityConnected && !activePrior) continue;
    if (prior?.activityCommand && prior.activityCommand !== activityCommand) removeHooks(next, [event], prior.activityCommand);
    if (hasHook(next, event, activityCommand)) continue;
    const group = { hooks: [{ type: 'command', command: activityCommand, async: true, timeout: 5 }] };
    if (event === 'Notification') group.matcher = 'permission_prompt|idle_prompt';
    next.hooks[event].push(group);
  }
  await fs.mkdir(loc.directory, { recursive: true, mode: 0o700 });
  const latestText = await fs.readFile(loc.settings, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (latestText !== originalText) throw new Error('Claude settings changed during setup. Retry to preserve the latest changes.');
  await atomicJson(loc.manifest, manifest);
  await atomicJson(loc.settings, next);
  return getIntegrationStatus(options);
}

function removeHooks(settings, events, command) {
  for (const event of events) {
    if (!Array.isArray(settings.hooks?.[event])) continue;
    settings.hooks[event] = settings.hooks[event].flatMap(group => {
      if (!Array.isArray(group.hooks)) return [group];
      const retained = group.hooks.filter(hook => hook.command !== command);
      return retained.length === group.hooks.length ? [group] : retained.length ? [{ ...group, hooks: retained }] : [];
    });
  }
}

async function disconnectIntegration(options = {}) {
  const current = await state(options);
  const { loc, settings, manifest } = current;
  if (!manifest || manifest.active === false) return current.status;
  const originalText = current.settingsText;
  const next = clone(settings);
  if (next.statusLine?.command === manifest.usageCommand) {
    if (JSON.stringify(next.statusLine) !== JSON.stringify(manifest.installedStatusLine)) throw new Error('The status line was edited after setup. Preserve or restore those edits manually before disconnecting.');
    if (manifest.originalHadStatusLine) next.statusLine = manifest.originalStatusLine;
    else delete next.statusLine;
  }
  // If the user replaced our status line, keep their replacement untouched.
  removeHooks(next, EVENTS, manifest.activityCommand);
  for (const event of EVENTS) if (next.hooks?.[event]?.length === 0 && !manifest.originalEvents.includes(event)) delete next.hooks[event];
  if (next.hooks && !Object.keys(next.hooks).length && !manifest.originalHadHooks) delete next.hooks;
  if (await fs.readFile(loc.settings, 'utf8') !== originalText) throw new Error('Claude settings changed during disconnect. Retry to preserve the latest changes.');
  await atomicJson(loc.settings, next);
  await atomicJson(loc.manifest, { ...manifest, active: false, disconnectedAt: new Date().toISOString() });
  return getIntegrationStatus(options);
}

module.exports = { getIntegrationStatus, connectIntegration, disconnectIntegration, workerCommand, quoteArgument, claudeCommandShell, EVENTS };
