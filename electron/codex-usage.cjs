'use strict';

// Only the documented account/rateLimits/read RPC is invoked. No threads,
// model turns, prompts, login flow or credit-consuming actions are started.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { resolveCli } = require('./platform-runtime.cjs');
const REMOTE_TTL = 120000;
const LOCAL_TTL = 5000;
const MAX_TAIL = 1024 * 1024;
const remoteCache = new Map();
const localCache = new Map();

function iso(value) {
  const ms = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 && ms <= 8640000000000000 ? new Date(ms).toISOString() : null;
}
function number(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function labelForWindow(minutes, fallback) {
  if (minutes === 300) return '5-hour';
  if (minutes === 10080) return 'Weekly';
  if (minutes === 1440) return 'Daily';
  if (number(minutes) && minutes % 60 === 0) return `${minutes / 60}-hour`;
  if (number(minutes)) return `${minutes}-minute`;
  return fallback;
}

function parseLimits(input) {
  const bucket = input?.rateLimitsByLimitId?.codex ?? input?.rateLimits ?? input;
  if (!bucket || typeof bucket !== 'object') return [];
  return ['primary', 'secondary'].flatMap((key, index) => {
    const row = bucket[key];
    const used = number(row?.usedPercent ?? row?.used_percent);
    if (used === null) return [];
    const minutes = row.windowDurationMins ?? row.window_minutes;
    return [{ id: key, label: labelForWindow(minutes, index === 0 ? 'Primary' : 'Secondary'), usedPercent: Math.min(100, used), resetsAt: iso(row.resetsAt ?? row.resets_at) }];
  });
}

// Raw session content stays inside this function. Only token-count events are
// parsed; text, tool output, thread IDs and filesystem paths never escape.
function parseSessionTail(text, now = Date.now()) {
  let context = null;
  let limits = [];
  let updatedAt = null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"token_count"') || line.length > MAX_TAIL) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
    const at = iso(event.timestamp);
    if (!at) continue;
    if (!limits.length) {
      limits = parseLimits(event.payload.rate_limits);
      if (limits.length) updatedAt = at;
    }
    const info = event.payload.info;
    if (!context && info?.last_token_usage) {
      const usage = info.last_token_usage;
      const used = number(usage.total_tokens) ?? (number(usage.input_tokens) !== null && number(usage.output_tokens) !== null ? usage.input_tokens + usage.output_tokens : null);
      const max = number(info.model_context_window);
      if (used !== null) context = {
        usedTokens: used, maxTokens: max && max > 0 ? max : null,
        usedPercent: max && max > 0 ? Math.min(100, used / max * 100) : null,
        sessionLabel: 'Most recent Codex session', updatedAt: at,
      };
    }
    if (limits.length && context) break;
  }
  return { context, limits, updatedAt, stale: !updatedAt || now - Date.parse(updatedAt) > REMOTE_TTL };
}

async function tailFile(filename) {
  let file;
  try {
    file = await fs.open(filename, 'r');
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - MAX_TAIL);
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_TAIL));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch { return null; }
  finally { await file?.close().catch(() => {}); }
}

async function readLocalSession(codexHome, now) {
  let budget = 36;
  const candidates = [];
  async function visit(directory, depth) {
    if (--budget < 0) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    const folders = entries.filter(entry => entry.isDirectory() && /^\d{2,4}$/.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name)).slice(0, depth === 0 ? 2 : 3);
    const files = entries.filter(entry => entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 24);
    await Promise.all(files.map(async entry => {
      const filename = path.join(directory, entry.name);
      try { const stat = await fs.stat(filename); candidates.push({ filename, time: stat.mtimeMs }); } catch { /* rotated */ }
    }));
    if (depth < 3) for (const folder of folders) await visit(path.join(directory, folder.name), depth + 1);
  }
  await visit(path.join(codexHome, 'sessions'), 0);
  candidates.sort((a, b) => b.time - a.time);
  for (const candidate of candidates.slice(0, 6)) {
    const text = await tailFile(candidate.filename);
    if (text === null) continue;
    const result = parseSessionTail(text, now);
    if (result.context || result.limits.length) return result;
  }
  return { context: null, limits: [], updatedAt: null, stale: true };
}

async function readRemoteLimits({ env, home, codexHome, executable, platform = process.platform, timeoutMs = 15000, spawnProcess = spawn }) {
  const cli = executable ? { command:executable, args:[], env } : await resolveCli('codex', { home, env, platform });
  return new Promise((resolve, reject) => {
    let finished = false;
    let buffer = '';
    let total = 0;
    let initialized = false;
    const child = spawnProcess(cli.command, [...cli.args, 'app-server'], { env: { ...cli.env, CODEX_HOME: codexHome }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => finish(new Error('Usage request timed out')), timeoutMs);
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill();
      error ? reject(error) : resolve(result);
    }
    function send(message) { if (!finished) child.stdin.write(`${JSON.stringify(message)}\n`); }
    child.on('error', () => finish(new Error('Codex app server unavailable')));
    child.stdin.on('error', () => finish(new Error('Codex app server closed')));
    child.on('exit', () => { if (!finished) finish(new Error('Codex app server closed')); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      total += Buffer.byteLength(chunk);
      if (total > 1024 * 1024) return finish(new Error('Usage response too large'));
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && !initialized) {
          if (message.error) return finish(new Error('Codex initialization failed'));
          initialized = true;
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (message.id === 2) {
          if (message.error) return finish(new Error('Account usage unavailable'));
          return finish(null, message.result);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agentglance_widget', title: 'AgentGlance', version: require('../package.json').version } } });
  });
}

async function cached(cache, key, ttl, now, reader) {
  const current = cache.get(key);
  if (current?.pending) return current.pending;
  if (current && now < current.expires) return current;
  const next = { ...current, expires: now + ttl };
  next.pending = Promise.resolve().then(reader).then(value => ({ value, expires: now + ttl, successAt: now, failed: false }), () => ({ value: current?.value ?? null, successAt: current?.successAt ?? null, expires: now + ttl, failed: true })).then(result => { cache.set(key, result); return result; });
  cache.set(key, next);
  return next.pending;
}

async function readCodexUsage(options = {}) {
  const now = options.now ?? Date.now();
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const readRemote = options.readRemote || (() => readRemoteLimits({ env, home, codexHome, platform:options.platform, executable: options.executable, timeoutMs: options.timeoutMs }));
  const readLocal = options.readLocal || (() => readLocalSession(codexHome, now));
  // Injected readers use their own cache identity and cannot touch real auth.
  const remoteKey = options.readRemote || codexHome;
  const localKey = options.readLocal || codexHome;
  const [remote, local] = await Promise.all([
    cached(remoteCache, remoteKey, REMOTE_TTL, now, async () => parseLimits(await readRemote())),
    cached(localCache, localKey, LOCAL_TTL, now, readLocal),
  ]);
  const liveLimits = remote.value || [];
  const localData = local.value || {};
  const limits = liveLimits.length ? liveLimits : localData.limits || [];
  const context = localData.context || null;
  const fromRemote = liveLimits.length > 0;
  const updatedAt = fromRemote ? iso(remote.successAt) : localData.updatedAt || context?.updatedAt || null;
  const stale = fromRemote ? remote.failed || now - remote.successAt > REMOTE_TTL : !updatedAt || now - Date.parse(updatedAt) > REMOTE_TTL;
  return {
    state: limits.length && context ? 'available' : limits.length || context ? 'partial' : 'unavailable',
    limits, context,
    source: fromRemote ? 'Codex account usage' : limits.length || context ? 'Local Codex session metadata' : 'Codex usage unavailable',
    updatedAt, stale,
    message: !limits.length ? 'Account limits are unavailable. Sign in to Codex with ChatGPT to expose account usage.'
      : remote.failed ? 'Live account usage could not be refreshed; showing the last available values.'
      : !fromRemote ? 'Limits are from the most recent local session and may lag account usage.'
      : !context ? 'No recent local session context was found.' : null,
  };
}

module.exports = { readCodexUsage, parseLimits, parseSessionTail, readLocalSession, readRemoteLimits };
