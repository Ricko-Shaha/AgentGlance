'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MAX_AGE_MS = 15 * 60 * 1000;
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd', 'Notification:permission_prompt', 'Notification:idle_prompt']);
const unknown = detail => ({ state: 'unknown', detail, updatedAt: null, source: 'Claude Code activity hooks' });

/** No activity is inferred from process existence. Options are backend/test-only. */
async function readClaudeActivity(options = {}) {
  if (options.processCount === 0) return { state: 'free', detail: 'No local Claude process is running.', updatedAt: null, source: 'Local process scan' };
  const env = options.env ?? process.env;
  const home = options.claudeHome ?? env.CLAUDE_CONFIG_DIR ?? path.join(options.home ?? os.homedir(), '.claude');
  const directory = path.join(home, 'statusline-activity');
  const now = options.now ?? Date.now();
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return unknown('Waiting for an observed Claude activity event.'); }
  const files = entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).slice(0, 512);
  const records = (await Promise.all(files.map(async entry => {
    try {
      const filename = path.join(directory, entry.name);
      if ((await fs.stat(filename)).size > 4096) return null;
      const record = JSON.parse(await fs.readFile(filename, 'utf8'));
      const time = Date.parse(record.updatedAt);
      if (record.sessionHash !== entry.name.slice(0, -5) || !['free', 'occupied', 'waiting'].includes(record.state) || !EVENTS.has(record.event) || !Number.isFinite(time) || time > now + 60000) return null;
      return { state: record.state, event: record.event, updatedAt: new Date(time).toISOString(), time };
    } catch { return null; }
  }))).filter(Boolean);
  const fresh = records.filter(record => now - record.time <= MAX_AGE_MS && record.event !== 'SessionEnd');
  if (!fresh.length) return unknown(records.length ? 'The last Claude activity signal is no longer current.' : 'Waiting for an observed Claude activity event.');
  const priorities = { waiting: 3, occupied: 2, free: 1 };
  fresh.sort((a, b) => priorities[b.state] - priorities[a.state] || b.time - a.time);
  const selected = fresh[0];
  const detail = selected.state === 'waiting' ? 'Claude is waiting for your input or approval.'
    : selected.state === 'occupied' ? 'Claude is working on a submitted task.' : 'Claude has finished its turn and is free.';
  return { state: selected.state, detail, updatedAt: selected.updatedAt, source: 'Claude Code activity hooks' };
}

module.exports = { readClaudeActivity };
