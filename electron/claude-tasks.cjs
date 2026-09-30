'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const DAY = 24 * 60 * 60 * 1000;
const MAX_TASKS = 64;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percent = value => numeric(value) !== null && value <= 100 ? value : null;
function timestamp(value, now) {
  const result = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(result) && result > 0 && result <= now + 60000 ? result : null;
}
function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!title || /^(?:[a-z]:[\\/]|[\\/])/i.test(title) || UUID.test(title)) return null;
  return title;
}
function titleValue(value, priority) {
  const label = cleanTitle(value);
  return label ? { label, priority } : null;
}
function betterTitle(first, second) {
  return !first || (second && second.priority > first.priority) ? second : first;
}
function labelFor(title, id, agent = false) {
  return title?.label || `${agent ? 'Agent' : 'Untitled'} session · ${id.slice(0, 6)}`;
}
function titleFromEntry(entry, candidate) {
  if ((typeof entry.sessionId === 'string' && entry.sessionId !== candidate.sessionId) || (typeof entry.session_id === 'string' && entry.session_id !== candidate.sessionId)) return null;
  if (!candidate.agentId && entry.isSidechain === true) return null;
  if (entry.type === 'custom-title') return titleValue(entry.customTitle, 4);
  if (entry.type === 'summary') return titleValue(entry.summary, 1);
  return null;
}
function safeContext(value) {
  if (!value || (numeric(value.usedTokens) === null && percent(value.usedPercent) === null)) return null;
  return { usedTokens: numeric(value.usedTokens), maxTokens: numeric(value.maxTokens) > 0 ? value.maxTokens : null, usedPercent: percent(value.usedPercent) };
}
async function boundedJson(filename, size = 8192) {
  try {
    if ((await fs.stat(filename)).size > size) return null;
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch { return null; }
}
async function filesIn(directory) {
  try { return await fs.readdir(directory, { withFileTypes: true }); } catch { return []; }
}
async function mapBatches(values, callback, width = 16) {
  const result = [];
  for (let index = 0; index < values.length; index += width) result.push(...await Promise.all(values.slice(index, index + width).map(callback)));
  return result;
}
function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
async function liveSessions(home, now, options) {
  const directory = path.join(home, 'sessions');
  const entries = (await filesIn(directory)).filter(entry => entry.isFile() && /^\d+\.json$/.test(entry.name)).slice(0, 512);
  return (await mapBatches(entries, async entry => {
    const record = await boundedJson(path.join(directory, entry.name));
    if (!UUID.test(record?.sessionId || '') || !Number.isInteger(record.pid) || record.pid <= 0 || String(record.pid) !== entry.name.slice(0, -5)) return null;
    if (record.pidDomain && record.pidDomain.toLowerCase() !== `${process.platform}:${os.hostname().toLowerCase()}`) return null;
    const alive = options.activePids ? options.activePids.includes(record.pid) : (options.isProcessAlive ?? processExists)(record.pid);
    if (!alive) return null;
    const time = timestamp(record.updatedAt, now) ?? timestamp(record.startedAt, now);
    if (time === null) return null;
    const id = hash(record.sessionId);
    const title = record.nameSource === 'user' ? titleValue(record.name, 5) : null;
    return { id, title, label: labelFor(title, id), context: null, contextTime: 0, updatedAt: new Date(time).toISOString(), active: true };
  })).filter(Boolean);
}
async function activityRecords(home, now) {
  const directory = path.join(home, 'statusline-activity');
  const entries = (await filesIn(directory)).filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).slice(0, 2048);
  return new Map((await mapBatches(entries, async entry => {
    const record = await boundedJson(path.join(directory, entry.name), 4096);
    const time = timestamp(record?.updatedAt, now);
    if (record?.sessionHash !== entry.name.slice(0, -5) || time === null || now - time > 15 * 60 * 1000 || !['free', 'occupied', 'waiting'].includes(record.state)) return null;
    return [record.sessionHash, { state: record.state, time, ended: record.event === 'SessionEnd' }];
  })).filter(Boolean));
}
async function capturedTasks(home, now, active) {
  const directory = path.join(home, 'statusline-usage', 'sessions');
  const entries = (await filesIn(directory)).filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).slice(0, 2048);
  return (await mapBatches(entries, async entry => {
    const value = await boundedJson(path.join(directory, entry.name));
    const time = timestamp(value?.updatedAt, now);
    if (value?.schemaVersion !== 1 || value.id !== entry.name.slice(0, -5) || time === null || (now - time > DAY && !active.has(value.id))) return null;
    // Earlier bridge versions store a project basename in label, not a task title.
    return { id: value.id, title: null, label: labelFor(null, value.id), context: safeContext(value.context), updatedAt: new Date(time).toISOString(), contextTime: time };
  })).filter(Boolean);
}
async function transcriptCandidates(home, now, active) {
  const directory = path.join(home, 'projects');
  // Appending an existing transcript does not update its parent directory mtime.
  const dirs = (await filesIn(directory)).filter(entry => entry.isDirectory()).slice(0, 256);
  const files = [];
  for (const dir of dirs) {
    const base = path.join(directory, dir.name);
    const children = await filesIn(base);
    const index = await boundedJson(path.join(base, 'sessions-index.json'), 2 * 1024 * 1024);
    const titles = new Map();
    if (Array.isArray(index?.entries)) for (const entry of index.entries.slice(0, 5000)) {
      if (UUID.test(entry.sessionId || '')) titles.set(entry.sessionId, titleValue(entry.customTitle, 3) || titleValue(entry.summary, 1));
    }
    const mains = children.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') && UUID.test(entry.name.slice(0, -6))).slice(0, 2000);
    files.push(...mains.map(entry => ({ filename: path.join(base, entry.name), sessionId: entry.name.slice(0, -6), agentId: null, title: titles.get(entry.name.slice(0, -6)) || null })));
    const sessions = children.filter(entry => entry.isDirectory() && UUID.test(entry.name)).slice(0, 512);
    for (const session of sessions) {
      const agentDirectory = path.join(base, session.name, 'subagents');
      const agents = (await filesIn(agentDirectory)).filter(entry => entry.isFile() && /^agent-[a-z0-9_-]+\.jsonl$/i.test(entry.name)).slice(0, 1000);
      files.push(...agents.map(entry => ({ filename: path.join(agentDirectory, entry.name), sessionId: session.name, agentId: entry.name.slice(6, -6) })));
    }
    if (files.length >= 20000) break;
  }
  const candidates = (await mapBatches(files.slice(0, 20000), async candidate => {
    try {
      const id = hash(candidate.agentId ? `${candidate.sessionId}:${candidate.agentId}` : candidate.sessionId);
      const time = (await fs.stat(candidate.filename)).mtimeMs;
      const isActive = active.has(id);
      return time >= now - DAY || isActive ? { ...candidate, id, time, active: isActive } : null;
    } catch { return null; }
  }, 64)).filter(Boolean);
  return candidates.sort((a, b) => Number(b.active) - Number(a.active) || b.time - a.time).slice(0, 256);
}
async function transcriptTask(candidate, now) {
  let file;
  try {
    file = await fs.open(candidate.filename, 'r');
    const { size } = await file.stat();
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    const start = size - length;
    await file.read(buffer, 0, length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    let title = candidate.title || null;
    if (candidate.agentId) {
      const metadata = await boundedJson(candidate.filename.replace(/\.jsonl$/, '.meta.json'), 65536);
      title = titleValue(metadata?.description, 5) || titleValue(metadata?.customTitle, 4);
    }
    let updatedAt = null;
    let contextTime = null;
    let context = null;
    for (const line of lines.reverse()) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      title = betterTitle(title, titleFromEntry(entry, candidate));
      if ((!candidate.agentId && entry?.isSidechain === true) || (typeof entry.sessionId === 'string' && entry.sessionId !== candidate.sessionId) || (typeof entry.session_id === 'string' && entry.session_id !== candidate.sessionId)) continue;
      if (candidate.agentId && typeof entry.agentId === 'string' && entry.agentId !== candidate.agentId) continue;
      const time = timestamp(entry.timestamp, now);
      if (time === null || (!candidate.active && now - time > DAY)) continue;
      if (updatedAt === null) updatedAt = time;
      const usage = entry.message?.usage;
      if (!context && entry.type === 'assistant' && numeric(usage?.input_tokens) !== null) {
        context = { usedTokens: usage.input_tokens + (numeric(usage.cache_read_input_tokens) ?? 0) + (numeric(usage.cache_creation_input_tokens) ?? 0), maxTokens: null, usedPercent: null };
        contextTime = time;
      }
    }
    // Renames/summaries may be stored near the beginning of a long transcript.
    // Read bounded metadata there rather than using its first user prompt.
    if ((!title || title.priority < 4) && start > 0) {
      const head = Buffer.alloc(Math.min(size, 512 * 1024));
      await file.read(head, 0, head.length, 0);
      const headLines = head.toString('utf8').split('\n');
      if (head.length < size) headLines.pop();
      for (const line of headLines.reverse()) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        title = betterTitle(title, titleFromEntry(entry, candidate));
      }
    }
    if (updatedAt === null) return null;
    return { id: candidate.id, title, agent: Boolean(candidate.agentId), label: labelFor(title, candidate.id, Boolean(candidate.agentId)), context, contextTime: contextTime ?? updatedAt, updatedAt: new Date(updatedAt).toISOString(), active: candidate.active };
  } catch { return null; }
  finally { await file?.close().catch(() => {}); }
}

/** Bounded local session discovery, with live sessions before recent history. */
async function readClaudeTasks(options = {}) {
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const home = options.claudeHome ?? env.CLAUDE_CONFIG_DIR ?? path.join(options.home ?? os.homedir(), '.claude');
  const [live, activity] = await Promise.all([liveSessions(home, now, options), activityRecords(home, now)]);
  const active = new Set([...live.map(task => task.id), ...[...activity].filter(([, record]) => !record.ended).map(([id]) => id)]);
  const [captures, candidates] = await Promise.all([capturedTasks(home, now, active), transcriptCandidates(home, now, active)]);
  const transcripts = (await mapBatches(candidates, candidate => transcriptTask(candidate, now), 8)).filter(Boolean);
  const tasks = new Map(live.map(task => [task.id, task]));
  for (const next of [...transcripts, ...captures]) {
    const previous = tasks.get(next.id);
    const selected = !previous || next.contextTime >= previous.contextTime ? next : previous;
    const title = betterTitle(previous?.title, next.title);
    const agent = previous?.agent || next.agent;
    tasks.set(next.id, { ...selected, title, agent, label: labelFor(title, next.id, agent), active: active.has(next.id), updatedAt: previous && Date.parse(previous.updatedAt) > Date.parse(next.updatedAt) ? previous.updatedAt : next.updatedAt });
  }
  for (const [id, record] of activity) {
    if (!record.ended && !tasks.has(id)) tasks.set(id, { id, label: labelFor(null, id), context: null, updatedAt: new Date(record.time).toISOString(), active: true });
  }
  const result = [...tasks.values()].map(task => {
    const record = activity.get(task.id);
    const updatedAt = record && record.time > Date.parse(task.updatedAt) ? new Date(record.time).toISOString() : task.updatedAt;
    return { id: task.id, label: task.label, state: record?.state || 'unknown', updatedAt, context: task.context, active: active.has(task.id) };
  });
  const rank = task => task.state === 'waiting' ? 4 : task.state === 'occupied' ? 3 : task.active ? 2 : 1;
  return result.sort((a, b) => rank(b) - rank(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, MAX_TASKS).map(({ active: _active, ...task }) => task);
}

module.exports = { readClaudeTasks };
