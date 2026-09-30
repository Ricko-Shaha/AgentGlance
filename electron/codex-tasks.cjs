'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { parseActivity, discoverSessionFiles, sessionKind } = require('./codex-activity.cjs');
const { parseSessionTail } = require('./codex-usage.cjs');
const MAX_TAIL = 1024 * 1024;
const RECENT_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 120) : null;
}

async function readTitles(codexHome) {
  const titles = new Map();
  let file;
  try {
    file = await fs.open(path.join(codexHome, 'session_index.jsonl'), 'r');
    const stat = await file.stat();
    if (!stat.isFile()) return titles;
    const maximum = 4 * 1024 * 1024;
    const start = Math.max(0, stat.size - maximum);
    const buffer = Buffer.alloc(Math.min(stat.size, maximum));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
    for (const line of text.split('\n')) {
      if (line.length > 16384) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const title = cleanTitle(row.thread_name ?? row.title);
      if (typeof row.id !== 'string' || !title) continue;
      const updated = Date.parse(row.updated_at);
      const previous = titles.get(row.id);
      if (!previous || !Number.isFinite(updated) || !Number.isFinite(previous.updated) || updated >= previous.updated) titles.set(row.id, { title, updated });
    }
  } catch { /* Missing or partially written index: use explicit metadata title. */ }
  finally { await file?.close().catch(() => {}); }
  return titles;
}

// These rows describe observed main-session history and recent agents, not
// process-owned tasks or a provider-wide context total. Older main sessions
// remain visible because an open idle CLI may not write a new event for days.
// Their observation timestamp is retained; presence never proves they are live.
// Labels use saved session titles, never directory names, prompts or responses.
async function readTask(filename, now, titles) {
  let file;
  try {
    file = await fs.open(filename, 'r');
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const header = Buffer.alloc(Math.min(262144, stat.size));
    const first = await file.read(header, 0, header.length, 0);
    const headerText = header.subarray(0, first.bytesRead).toString('utf8');
    const end = headerText.indexOf('\n');
    if (end < 0) return null;
    let meta;
    try { meta = JSON.parse(headerText.slice(0, end)); } catch { return null; }
    const kind = sessionKind(meta);
    if (!kind) return null;
    const start = Math.max(0, stat.size - MAX_TAIL);
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_TAIL));
    const result = await file.read(buffer, 0, buffer.length, start);
    let tail = buffer.subarray(0, result.bytesRead).toString('utf8');
    if (start) tail = tail.slice(tail.indexOf('\n') + 1);
    const activity = parseActivity(tail, now);
    const usage = parseSessionTail(tail, now);
    const timestamps = [activity.updatedAt, usage.context?.updatedAt, usage.updatedAt, meta.timestamp].map(value => Date.parse(value)).filter(value => Number.isFinite(value) && value <= now + 60000);
    if (!timestamps.length) return null;
    const observed = Math.max(...timestamps);
    if (kind === 'agent' && now - observed > RECENT_MS) return null;
    const id = createHash('sha256').update(typeof meta.payload?.id === 'string' ? meta.payload.id : filename).digest('hex').slice(0, 16);
    const title = titles.get(meta.payload?.id)?.title || cleanTitle(meta.payload?.thread_name ?? meta.payload?.title) || (kind === 'agent' ? 'Untitled agent' : 'Untitled session');
    return {
      _kind: kind,
      id, label: `${title} · ${kind === 'agent' && title !== 'Untitled agent' ? 'agent ' : ''}${id.slice(0, 4)}`,
      state: activity.state,
      updatedAt: new Date(observed).toISOString(),
      context: usage.context ? {
        usedTokens: usage.context.usedTokens,
        maxTokens: usage.context.maxTokens,
        usedPercent: usage.context.usedPercent,
      } : null,
    };
  } catch { return null; }
  finally { await file?.close().catch(() => {}); }
}

async function collectTasks(codexHome, now) {
  const [candidates, titles] = await Promise.all([discoverSessionFiles(codexHome), readTitles(codexHome)]);
  const records = [];
  // Sequential bounded reads keep peak session-content memory small.
  for (const candidate of candidates) {
    const record = await readTask(candidate.filename, now, titles);
    if (record) records.push(record);
  }
  const priority = { occupied: 0, waiting: 1, unknown: 2, free: 3 };
  const group = record => ['occupied', 'waiting'].includes(record.state) ? record._kind === 'main' ? 0 : 1 : record._kind === 'main' ? 2 : 3;
  records.sort((a,b) => group(a) - group(b) || (group(a) < 2 ? priority[a.state] - priority[b.state] : 0) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const unique = new Map();
  for (const record of records) if (!unique.has(record.id)) unique.set(record.id, record);
  return [...unique.values()].slice(0, 100).map(({ _kind, ...record }) => record);
}

async function readCodexTasks(options = {}) {
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const codexHome = env.CODEX_HOME || path.join(options.home ?? os.homedir(), '.codex');
  const previous = cache.get(codexHome);
  if (previous?.pending) return previous.pending;
  if (previous && now >= previous.createdAt && now < previous.expires) return previous.records;
  const pending = collectTasks(codexHome, now).catch(() => []).then(records => {
    cache.set(codexHome, { records, createdAt: now, expires: now + 5000 }); return records;
  });
  cache.set(codexHome, { pending });
  return pending;
}

module.exports = { readCodexTasks };
