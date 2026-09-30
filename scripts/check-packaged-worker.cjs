'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { workerCommand } = require('../electron/claude-integration.cjs');
const { readClaudeUsage } = require('../electron/claude-usage.cjs');
const { readClaudeTasks } = require('../electron/claude-tasks.cjs');

function invoke(command, payload, env) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh', windows
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
      : ['-c', command], { env, windowsHide: true, detached: !windows, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      // Stop only this test's process tree if a broken package launches a GUI.
      if (child.pid) {
        if (windows) {
          const stop = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          stop.once('error', () => child.kill());
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }
      reject(new Error('Packaged Claude worker did not exit within 15 seconds.'));
    }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

async function checkPackagedWorker(executable) {
  executable = path.resolve(executable);
  const resources = process.platform === 'darwin'
    ? path.resolve(path.dirname(executable), '../Resources')
    : path.join(path.dirname(executable), 'resources');
  const archive = path.join(resources, 'app.asar');
  await Promise.all([fs.access(executable), fs.access(archive)]);
  const temporaryRoot = path.resolve(os.tmpdir());
  const temporary = await fs.mkdtemp(path.join(temporaryRoot, 'agentglance-packaged-worker-'));
  // Exercise quoting too; no real settings, account credentials or home files.
  const configDirectory = path.join(temporary, "Claude's synthetic config");
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDirectory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PORTABLE_EXECUTABLE_FILE;
  delete env.APPIMAGE;
  const options = { env, executablePath: executable, workerPath: path.join(archive, 'electron', 'claude-worker.cjs'), isPackaged: true };
  const session = 'synthetic-packaged-session';
  const sessionHash = crypto.createHash('sha256').update(session).digest('hex');
  try {
    await fs.mkdir(path.join(configDirectory, 'statusline-integration'), { recursive: true });
    await fs.writeFile(path.join(configDirectory, 'statusline-integration', 'manifest.json'), JSON.stringify({ schemaVersion: 1, active: true, forwardCommand: null }));
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const usage = await invoke(workerCommand('usage', configDirectory, options), {
      session_id: session,
      rate_limits: { five_hour: { used_percentage: 23, resets_at: reset }, seven_day: { used_percentage: 61, resets_at: reset + 86400 } },
      context_window: { context_window_size: 100000, used_percentage: 37, current_usage: { input_tokens: 32000, cache_read_input_tokens: 5000 } },
      prompt: 'Synthetic content must not be captured',
    }, env);
    assert.equal(usage.code, 0, usage.stderr);
    assert.equal(usage.stdout.trim(), '5-hour 23% | Weekly 61% | Context 37%');
    const captureText = await fs.readFile(path.join(configDirectory, 'statusline-usage', 'latest.json'), 'utf8');
    assert(!captureText.includes('Synthetic content'));
    assert(!captureText.includes(session));
    const capture = await readClaudeUsage({ claudeHome: configDirectory, allowNetwork: false });
    assert.equal(capture.state, 'available');
    assert.deepEqual(capture.limits.map(limit => limit.usedPercent), [23, 61]);
    assert.equal(capture.context.usedTokens, 37000);
    assert.equal(capture.context.usedPercent, 37);
    assert.equal(capture.limits[0].resetsAt, new Date(reset * 1000).toISOString());

    const activity = await invoke(workerCommand('activity', configDirectory, options), { session_id: session, hook_event_name: 'PermissionRequest' }, env);
    assert.equal(activity.code, 0, activity.stderr);
    assert.equal(activity.stdout, '');
    const tasks = await readClaudeTasks({ claudeHome: configDirectory });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, sessionHash);
    assert.equal(tasks[0].state, 'waiting');
    assert.equal(tasks[0].context.usedPercent, 37);
    console.log('Packaged Claude worker: actual executable + ASAR commands deliver usage, resets, task context and activity.');
  } finally {
    const target = path.resolve(temporary);
    if (path.dirname(target) !== temporaryRoot || !path.basename(target).startsWith('agentglance-packaged-worker-')) throw new Error('Temporary worker cleanup escaped its test directory.');
    await fs.rm(target, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const executable = process.argv[2];
  if (!executable) { console.error('Supply the unpacked application executable path.'); process.exitCode = 1; }
  else checkPackagedWorker(executable).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { checkPackagedWorker };
