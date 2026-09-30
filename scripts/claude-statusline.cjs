#!/usr/bin/env node
'use strict';

// Optional Claude statusLine wrapper. Nothing is installed or configured automatically.
// node scripts/claude-statusline.cjs --forward-script C:/Users/you/.claude/statusline.js
// Forwards the original stdin to an existing Node status line, preserving its output.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
let sanitizeStatusline;
try { ({ sanitizeStatusline } = require('./claude-usage.cjs')); }
catch { ({ sanitizeStatusline } = require('../electron/claude-usage.cjs')); }

async function main() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) return;
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  let capture;
  try {
    const payload = JSON.parse(input.toString('utf8'));
    capture = sanitizeStatusline(payload);
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const directory = path.join(claudeHome, 'statusline-usage');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, 'latest.json');
    const temporary = path.join(directory, `${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(capture), { mode: 0o600 });
    await fs.rename(temporary, destination);
    if (typeof payload.session_id === 'string' && payload.session_id.length > 0 && payload.session_id.length <= 1024) {
      const id = crypto.createHash('sha256').update(payload.session_id).digest('hex');
      const candidate = payload.workspace?.current_dir || payload.workspace?.project_dir || payload.cwd;
      const basename = typeof candidate === 'string' ? candidate.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64) : '';
      const label = `${basename || 'Claude session'} · ${id.slice(0, 6)}`;
      const context = capture.context ? { usedTokens: capture.context.usedTokens, maxTokens: capture.context.maxTokens, usedPercent: capture.context.usedPercent } : null;
      const sessions = path.join(directory, 'sessions');
      await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
      const task = { schemaVersion: 1, id, label, context, updatedAt: capture.updatedAt };
      const tempSession = path.join(sessions, `${id}.${process.pid}.tmp`);
      await fs.writeFile(tempSession, JSON.stringify(task), { mode: 0o600 });
      await fs.rename(tempSession, path.join(sessions, `${id}.json`));
    }
  } catch { /* Sync failure must not break an existing terminal status line. */ }
  const args = process.argv.slice(2);
  let forward = args[0] === '--forward-script' && args[1] ? path.resolve(args[1]) : null;
  let executable = process.execPath;
  if (args[0] === '--manifest' && args[1]) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.resolve(args[1]), 'utf8'));
      forward = manifest.forwardScript || null;
      executable = manifest.forwardExecutable || process.execPath;
    } catch { /* Still render the captured metrics when no prior command exists. */ }
  }
  if (forward && forward !== __filename) {
    const child = spawn(executable, [forward], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    child.stdin.on('error', () => {});
    child.on('error', () => {});
    child.stdin.end(input);
    return;
  }
  const parts = (capture?.limits || []).map(limit => `${limit.label} ${Math.round(limit.usedPercent)}%`);
  if (capture?.context?.usedPercent != null) parts.push(`Context ${Math.round(capture.context.usedPercent)}%`);
  process.stdout.write(parts.join(' | ') || 'Claude');
}

main().catch(() => {});
