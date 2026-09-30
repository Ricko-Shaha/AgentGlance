'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const MAX_TAIL = 1024 * 1024;
const STALE_MS = 30 * 60 * 1000;
const cache = new Map();
const SOURCE = 'Most recent Codex session';
const unknown = detail => ({ state: 'unknown', detail, updatedAt: null, source: SOURCE });

function parseActivity(text, now = Date.now()) {
  const lines = text.split('\n');
  // Only explicit lifecycle events determine activity. Token traffic alone
  // cannot distinguish waiting for a user from an occupied model/tool turn.
  const events = {
    task_started: ['occupied', 'This session has an unfinished task.'],
    task_complete: ['free', 'This session completed its task.'],
    turn_aborted: ['free', 'This session stopped its task.'],
    exec_approval_request: ['waiting', 'This session requested command approval.'],
    apply_patch_approval_request: ['waiting', 'This session requested change approval.'],
    request_user_input: ['waiting', 'This session requested user input.'],
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.length > MAX_TAIL || !/"(?:task_started|task_complete|turn_aborted|exec_approval_request|apply_patch_approval_request|request_user_input)"/.test(line)) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'event_msg') continue;
    const match = events[event.payload?.type];
    const at = Date.parse(event.timestamp);
    if (!match || !Number.isFinite(at) || at > now + 60000) continue;
    const [state, detail] = match;
    if (state !== 'free' && now - at > STALE_MS) return { state: 'unknown', detail: 'The latest unfinished task is over 30 minutes old; current activity is unconfirmed.', updatedAt: new Date(at).toISOString(), source: SOURCE };
    return { state, detail, updatedAt: new Date(at).toISOString(), source: SOURCE };
  }
  return unknown('No explicit task lifecycle was found in this session.');
}

function sessionKind(meta) {
  if (meta?.type !== 'session_meta') return null;
  const source = meta.payload?.source;
  if (source && typeof source === 'object' && Object.hasOwn(source, 'subagent')) return 'agent';
  if (typeof source === 'string' && ['cli', 'vscode', 'exec', 'appServer', 'app_server', 'app-server'].includes(source)) return 'main';
  return null;
}

async function readSession(filename, now) {
  let file;
  try {
    file = await fs.open(filename, 'r');
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const header = Buffer.alloc(Math.min(262144, stat.size));
    const first = await file.read(header, 0, header.length, 0);
    const text = header.subarray(0, first.bytesRead).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0) return null;
    let meta;
    try { meta = JSON.parse(text.slice(0, end)); } catch { return null; }
    if (!sessionKind(meta)) return null;
    const start = Math.max(0, stat.size - MAX_TAIL);
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_TAIL));
    const result = await file.read(buffer, 0, buffer.length, start);
    let tail = buffer.subarray(0, result.bytesRead).toString('utf8');
    if (start) tail = tail.slice(tail.indexOf('\n') + 1);
    return parseActivity(tail, now);
  } catch { return null; }
  finally { await file?.close().catch(() => {}); }
}

async function discoverSessionFiles(codexHome) {
  let budget = 512;
  const candidates = [];
  async function visit(directory, depth) {
    if (--budget < 0) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    const files = entries.filter(e => e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)).sort((a,b) => b.name.localeCompare(a.name)).slice(0, 1024);
    await Promise.all(files.map(async e => {
      const filename = path.join(directory, e.name);
      try { const stat = await fs.stat(filename); candidates.push({ filename, time: stat.mtimeMs }); } catch { /* rotating */ }
    }));
    if (depth < 3) {
      const folders = entries.filter(e => e.isDirectory() && /^\d{2,4}$/.test(e.name)).sort((a,b) => b.name.localeCompare(a.name));
      for (const entry of folders) await visit(path.join(directory, entry.name), depth + 1);
    }
  }
  await visit(path.join(codexHome, 'sessions'), 0);
  candidates.sort((a,b) => b.time - a.time);
  // Windows can retain a creation-time mtime while a rollout is open. Never
  // reject older date folders or files solely because their mtime is old.
  return candidates.slice(0, 512);
}

async function readLatestMain(codexHome, now) {
  const candidates = await discoverSessionFiles(codexHome);
  const records = [];
  for (const entry of candidates) {
    const result = await readSession(entry.filename, now);
    if (result?.updatedAt && now - Date.parse(result.updatedAt) <= 86400000) records.push(result);
  }
  records.sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const current = records.find(record => record.state === 'occupied') || records.find(record => record.state === 'waiting') || records[0];
  if (!current) return unknown('No recent readable session lifecycle metadata was found.');
  return { ...current, source: 'Recent Codex sessions and agents', detail: current.state === 'occupied' ? 'At least one recent session or agent has an unfinished task.' : current.state === 'waiting' ? 'A recent session or agent is waiting for input or approval.' : current.detail };
}

async function readCodexActivity(options = {}) {
  if (options.processCount === 0) return { state: 'free', detail: 'No Codex process is running.', updatedAt: null, source: 'Local process scan' };
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const codexHome = env.CODEX_HOME || path.join(options.home ?? os.homedir(), '.codex');
  const key = options.readSession || codexHome;
  const previous = cache.get(key);
  if (previous?.pending) return previous.pending;
  if (previous && now < previous.expires) return previous.value;
  const pending = Promise.resolve().then(() => options.readSession ? options.readSession(now) : readLatestMain(codexHome, now)).catch(() => unknown('Session activity is unavailable.')).then(value => {
    cache.set(key, { value, expires: now + 5000 }); return value;
  });
  cache.set(key, { pending });
  return pending;
}

module.exports = { readCodexActivity, parseActivity, readLatestMain, discoverSessionFiles, sessionKind };
