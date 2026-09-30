#!/usr/bin/env node
'use strict';

// Standalone observer: no output, no permission decisions, no network access.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const observedAt = Date.now();
const deadline = setTimeout(() => process.exit(0), 1800);
deadline.unref();
let length = 0;
const chunks = [];
process.stdin.on('error', () => process.exit(0));
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
process.stdin.on('data', chunk => {
  length += chunk.length;
  if (length > 2 * 1024 * 1024) process.exit(0);
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 1024 || input.agent_id) return;
    let event = input.hook_event_name;
    let state;
    if (event === 'Notification') {
      if (!['permission_prompt', 'idle_prompt'].includes(input.notification_type)) return;
      event = `Notification:${input.notification_type}`;
      state = 'waiting';
    } else if (event === 'PermissionRequest' || (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion')) state = 'waiting';
    else if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event)) state = 'occupied';
    else if (['SessionStart', 'Stop', 'StopFailure', 'SessionEnd'].includes(event)) state = 'free';
    else return;
    const sessionHash = crypto.createHash('sha256').update(input.session_id).digest('hex');
    const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const directory = path.join(home, 'statusline-activity');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `${sessionHash}.json`);
    // A delayed async hook must not overwrite a newer observation.
    try {
      if (Date.parse(JSON.parse(fs.readFileSync(filename, 'utf8')).updatedAt) > observedAt) return;
    } catch { /* First event or an interrupted write. */ }
    const temporary = path.join(directory, `${sessionHash}.${process.pid}.tmp`);
    const record = { sessionHash, state, event, updatedAt: new Date(observedAt).toISOString(), pid: null };
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, filename);
  } catch { /* Observer failure must never alter Claude's behavior. */ }
  finally { clearTimeout(deadline); }
});
