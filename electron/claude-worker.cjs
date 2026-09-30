'use strict';

// Runs inside the installed Electron executable before the UI and instance lock.
// It needs neither a separately installed Node runtime nor a repository checkout.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { sanitizeStatusline } = require('./claude-usage.cjs');

async function atomicJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

async function inputBuffer(stream) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += data.length;
    if (length > 2 * 1024 * 1024) throw new Error('Observer input is too large.');
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

async function captureUsage(payload, configDirectory, now) {
  const capture = sanitizeStatusline(payload, now);
  const directory = path.join(configDirectory, 'statusline-usage');
  await atomicJson(path.join(directory, 'latest.json'), capture);
  if (typeof payload.session_id === 'string' && payload.session_id && payload.session_id.length <= 1024) {
    const id = crypto.createHash('sha256').update(payload.session_id).digest('hex');
    // Task titles are read from the assistant's own session metadata by its reader.
    // Raw status-line payloads, prompts and paths are never cached here.
    const context = capture.context ? { usedTokens: capture.context.usedTokens, maxTokens: capture.context.maxTokens, usedPercent: capture.context.usedPercent } : null;
    await atomicJson(path.join(directory, 'sessions', `${id}.json`), { schemaVersion: 1, id, label: `Claude session · ${id.slice(0, 6)}`, context, updatedAt: capture.updatedAt });
  }
  return capture;
}

async function captureActivity(payload, configDirectory, now) {
  if (typeof payload.session_id !== 'string' || !payload.session_id || payload.session_id.length > 1024 || payload.agent_id) return;
  let event = payload.hook_event_name;
  let state;
  if (event === 'Notification') {
    if (!['permission_prompt', 'idle_prompt'].includes(payload.notification_type)) return;
    event = `Notification:${payload.notification_type}`;
    state = 'waiting';
  } else if (event === 'PermissionRequest' || (event === 'PreToolUse' && payload.tool_name === 'AskUserQuestion')) state = 'waiting';
  else if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event)) state = 'occupied';
  else if (['SessionStart', 'Stop', 'StopFailure', 'SessionEnd'].includes(event)) state = 'free';
  else return;
  const sessionHash = crypto.createHash('sha256').update(payload.session_id).digest('hex');
  const destination = path.join(configDirectory, 'statusline-activity', `${sessionHash}.json`);
  try { if (Date.parse(JSON.parse(await fs.readFile(destination, 'utf8')).updatedAt) > now) return; } catch { /* First observation. */ }
  await atomicJson(destination, { sessionHash, state, event, updatedAt: new Date(now).toISOString(), pid: null });
}

function forwardCommand(command, input, options = {}) {
  return new Promise(resolve => {
    const env = { ...(options.env || process.env) };
    delete env.ELECTRON_RUN_AS_NODE;
    const shell = options.forwardShell || require('./claude-integration.cjs').claudeCommandShell({ env });
    const args = shell.kind === 'powershell'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]
      : ['-c', command];
    const child = spawn(shell.executable, args, {
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => (options.stdout || process.stdout).write(chunk));
    child.stderr.on('data', chunk => (options.stderr || process.stderr).write(chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const deadline = setTimeout(() => { child.kill(); resolve(0); }, 8000);
    deadline.unref();
    child.once('error', () => { clearTimeout(deadline); resolve(0); });
    child.once('close', code => { clearTimeout(deadline); resolve(Number.isInteger(code) ? code : 0); });
  });
}

async function runClaudeWorker(args = process.argv.slice(2), options = {}) {
  const marker = args.indexOf('--statusline-claude-worker');
  if (marker >= 0) args = args.slice(marker + 1);
  const mode = args[0];
  const configIndex = args.indexOf('--config');
  const configDirectory = args[configIndex + 1];
  if (!['usage', 'activity'].includes(mode) || configIndex < 0 || !configDirectory || !path.isAbsolute(configDirectory)) return 0;
  const now = options.now ?? Date.now();
  let manifest;
  try {
    const filename = path.join(configDirectory, 'statusline-integration', 'manifest.json');
    if ((await fs.stat(filename)).size > 256 * 1024) return 0;
    manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.active === false) return 0;
  } catch { return 0; }
  let input;
  try { input = await inputBuffer(options.stdin || process.stdin); } catch { return 0; }
  let capture;
  try {
    const payload = JSON.parse(input.toString('utf8'));
    if (mode === 'activity') await captureActivity(payload, configDirectory, now);
    else capture = await captureUsage(payload, configDirectory, now);
  } catch { /* Telemetry failure must never change the assistant's behavior. */ }
  if (mode === 'activity') return 0;
  if (typeof manifest.forwardCommand === 'string' && manifest.forwardCommand.trim()) return forwardCommand(manifest.forwardCommand, input, { ...options, env: { ...(options.env || process.env), CLAUDE_CONFIG_DIR: configDirectory }, forwardShell: manifest.forwardShell });
  const parts = (capture?.limits || []).map(limit => `${limit.label} ${Math.round(limit.usedPercent)}%`);
  if (capture?.context?.usedPercent != null) parts.push(`Context ${Math.round(capture.context.usedPercent)}%`);
  (options.stdout || process.stdout).write(parts.join(' | ') || 'Claude');
  return 0;
}

if (require.main === module) runClaudeWorker().then(code => { process.exitCode = code; }).catch(() => {});
module.exports = { runClaudeWorker, captureUsage, captureActivity };
