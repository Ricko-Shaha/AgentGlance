'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const STALE_AFTER_MS = 5 * 60 * 1000;
const REMOTE_CACHE_MS = 120000;
const remoteCache = new Map();
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percent = value => number(value) !== null && value <= 100 ? value : null;
const iso = value => {
  const timestamp = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8640000000000000 ? new Date(timestamp).toISOString() : null;
};
const empty = message => ({ state: 'unavailable', limits: [], context: null, source: 'Claude Code', updatedAt: null, message, stale: false });

function inputTokens(usage) {
  if (!usage || number(usage.input_tokens) === null) return null;
  return usage.input_tokens + (number(usage.cache_read_input_tokens) ?? 0) + (number(usage.cache_creation_input_tokens) ?? 0);
}

/** Select only documented numerical fields; never persist prompts, credentials, paths or session names. */
function sanitizeStatusline(payload, now = Date.now()) {
  const limits = [];
  for (const [key, label] of [['five_hour', '5-hour'], ['seven_day', 'Weekly']]) {
    const limit = payload?.rate_limits?.[key];
    const usedPercent = percent(limit?.used_percentage);
    if (usedPercent !== null) limits.push({ id: key, label, usedPercent, resetsAt: iso(limit.resets_at) });
  }
  const window = payload?.context_window;
  const maxTokens = number(window?.context_window_size);
  const usedTokens = inputTokens(window?.current_usage);
  const suppliedPercent = percent(window?.used_percentage);
  const usedPercent = suppliedPercent ?? (usedTokens !== null && maxTokens > 0 ? Math.min(100, usedTokens / maxTokens * 100) : null);
  const updatedAt = new Date(now).toISOString();
  const context = window && (usedTokens !== null || usedPercent !== null)
    ? { usedTokens, maxTokens: maxTokens > 0 ? maxTokens : null, usedPercent, sessionLabel: 'Latest Claude session', updatedAt }
    : null;
  return { schemaVersion: 1, limits, context, updatedAt };
}

function normalizeCapture(capture, now) {
  if (capture?.schemaVersion !== 1 || !Array.isArray(capture.limits)) return null;
  const updatedAt = iso(capture.updatedAt);
  if (!updatedAt || Date.parse(updatedAt) > now + 60000) return null;
  const limits = capture.limits.filter(limit => ['five_hour', 'seven_day'].includes(limit?.id) && percent(limit.usedPercent) !== null)
    .map(limit => ({ id: limit.id, label: limit.id === 'five_hour' ? '5-hour' : 'Weekly', usedPercent: limit.usedPercent, resetsAt: iso(limit.resetsAt) }));
  const raw = capture.context;
  const context = raw && (number(raw.usedTokens) !== null || percent(raw.usedPercent) !== null)
    ? { usedTokens: number(raw.usedTokens), maxTokens: number(raw.maxTokens) > 0 ? raw.maxTokens : null, usedPercent: percent(raw.usedPercent), sessionLabel: 'Latest Claude session', updatedAt }
    : null;
  const expired = limits.some(limit => limit.resetsAt && Date.parse(limit.resetsAt) <= now);
  const stale = now - Date.parse(updatedAt) > STALE_AFTER_MS || expired;
  return {
    state: limits.length === 2 && context?.usedPercent !== null && context ? 'available' : limits.length || context ? 'partial' : 'unavailable',
    limits, context, source: 'Claude Code status line', updatedAt,
    message: stale ? 'Last reported usage; waiting for a new Claude Code status update.' : limits.length < 2 ? 'Some rate limits are not reported by this Claude session.' : null,
    stale,
  };
}

async function readCapture(filename, now) {
  try {
    const stat = await fs.stat(filename);
    if (stat.size > 65536) return null;
    return normalizeCapture(JSON.parse(await fs.readFile(filename, 'utf8')), now);
  } catch { return null; }
}

async function latestTranscript(claudeHome) {
  try {
    const base = path.join(claudeHome, 'projects');
    const dirs = (await fs.readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory()).slice(0, 100);
    const ranked = await Promise.all(dirs.map(async entry => {
      const filename = path.join(base, entry.name);
      return { filename, time: (await fs.stat(filename)).mtimeMs };
    }));
    const candidates = [];
    for (const directory of ranked.sort((a, b) => b.time - a.time).slice(0, 12)) {
      const entries = (await fs.readdir(directory.filename, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).slice(0, 200);
      candidates.push(...await Promise.all(entries.map(async entry => {
        const filename = path.join(directory.filename, entry.name);
        return { filename, time: (await fs.stat(filename)).mtimeMs };
      })));
    }
    return candidates.sort((a, b) => b.time - a.time)[0]?.filename || null;
  } catch { return null; }
}

async function transcriptContext(filename, now) {
  if (!filename) return null;
  let file;
  try {
    file = await fs.open(filename, 'r');
    const stat = await file.stat();
    const length = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    const start = stat.size - length;
    await file.read(buffer, 0, length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    for (const line of lines.reverse()) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== 'assistant' || entry.isSidechain === true) continue;
      const usedTokens = inputTokens(entry.message?.usage);
      const updatedAt = iso(entry.timestamp);
      if (usedTokens === null || !updatedAt || Date.parse(updatedAt) > now + 60000) continue;
      return { usedTokens, maxTokens: null, usedPercent: null, sessionLabel: 'Latest Claude session', updatedAt };
    }
  } catch { /* Unreadable/rotating transcripts are normal. */ }
  finally { await file?.close().catch(() => {}); }
  return null;
}

// Verified in the official installed Claude Code binary. This read-only endpoint
// is internal and may change; failure leaves documented status-line data usable.
function requestAccountUsage(accessToken) {
  return new Promise((resolve, reject) => {
    const request = https.get('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      timeout: 6000,
      signal: AbortSignal.timeout(6000),
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('Usage service unavailable'));
        return;
      }
      let length = 0;
      const chunks = [];
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 65536) { request.destroy(); reject(new Error('Usage response too large')); }
        else chunks.push(chunk);
      });
      response.on('error', () => reject(new Error('Usage response interrupted')));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Invalid usage response')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Usage request timed out')));
    request.on('error', () => reject(new Error('Usage service unavailable')));
  });
}

async function accountLimits(claudeHome, now, options) {
  let oauth;
  try {
    const credentialsPath = path.join(claudeHome, '.credentials.json');
    if ((await fs.stat(credentialsPath)).size > 65536) return null;
    oauth = JSON.parse(await fs.readFile(credentialsPath, 'utf8')).claudeAiOauth;
  } catch { return null; }
  if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken || (number(oauth.expiresAt) !== null && oauth.expiresAt <= now)) return null;
  const key = `${claudeHome}:${crypto.createHash('sha256').update(oauth.accessToken).digest('hex')}`;
  const cached = remoteCache.get(key);
  if (cached && now - cached.time < REMOTE_CACHE_MS && now >= cached.time) return cached.promise;
  const promise = (async () => {
    try {
      const payload = await (options.requestUsage ?? requestAccountUsage)(oauth.accessToken);
      const limits = [];
      for (const [id, label] of [['five_hour', '5-hour'], ['seven_day', 'Weekly']]) {
        const usedPercent = percent(payload?.[id]?.utilization);
        if (usedPercent !== null) limits.push({ id, label, usedPercent, resetsAt: iso(payload[id].resets_at) });
      }
      return limits.length ? { limits, updatedAt: new Date(now).toISOString() } : null;
    } catch { return null; }
  })();
  if (remoteCache.size >= 32) remoteCache.delete(remoteCache.keys().next().value);
  remoteCache.set(key, { time: now, promise });
  return promise;
}

/** Options exist for tests and backend configuration; never accept them through renderer IPC. */
async function readClaudeUsage(options = {}) {
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const claudeHome = options.claudeHome ?? env.CLAUDE_CONFIG_DIR ?? path.join(options.home ?? os.homedir(), '.claude');
  const capture = await readCapture(options.cachePath ?? path.join(claudeHome, 'statusline-usage', 'latest.json'), now);
  if (capture && !capture.stale && capture.limits.length === 2) return capture;
  const filename = Object.hasOwn(options, 'transcriptPath') ? options.transcriptPath : await latestTranscript(claudeHome);
  const transcript = capture?.context && !capture.stale ? null : await transcriptContext(filename, now);
  const context = capture?.context && (!transcript || Date.parse(capture.context.updatedAt) >= Date.parse(transcript.updatedAt)) ? capture.context : transcript;
  const account = options.allowNetwork === false ? null : await accountLimits(claudeHome, now, options);
  if (account) return {
    state: account.limits.length === 2 && context?.usedPercent != null ? 'available' : 'partial',
    limits: account.limits, context, source: context ? 'Claude account + session metadata' : 'Claude account usage', updatedAt: account.updatedAt,
    message: context?.usedPercent != null ? null : 'Enable usage sync to include the session’s actual context capacity.',
    stale: false,
  };
  if (capture && (capture.limits.length || capture.context)) return capture;
  if (!context) return empty((options.platform ?? process.platform) === 'darwin' ? 'Enable Claude usage sync for account limits and context. Keychain credentials remain managed by Claude Code.' : 'Enable Claude usage sync to receive its reported 5-hour, weekly and context limits.');
  return {
    state: 'partial', limits: [], context, source: 'Claude Code session metadata', updatedAt: context.updatedAt,
    message: 'Input and cache tokens from the latest session. Enable usage sync for rate limits and the actual context capacity.',
    stale: now - Date.parse(context.updatedAt) > STALE_AFTER_MS,
  };
}

module.exports = { readClaudeUsage, sanitizeStatusline };
