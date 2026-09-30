'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readClaudeActivity } = require('../electron/claude-activity.cjs');
const run = promisify(execFile);
const script = path.join(__dirname, '..', 'scripts', 'claude-activity-hook.cjs');
const installer = path.join(__dirname, '..', 'scripts', 'install-claude-activity.cjs');

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'statusline-activity-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}
function hook(home, payload, filename = script) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [filename], { env: { ...process.env, CLAUDE_CONFIG_DIR: home }, windowsHide: true, timeout: 4000 }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}
async function state(home) { return readClaudeActivity({ claudeHome: home, processCount: 1 }); }

test('a running process alone is unknown; no running processes are free', async t => {
  const home = await fixture(t);
  assert.equal((await state(home)).state, 'unknown');
  assert.equal((await readClaudeActivity({ claudeHome: home, processCount: 0 })).state, 'free');
});

test('observed prompt, permission, continuation and stop events follow actual activity', async t => {
  const home = await fixture(t);
  for (const [event, expected] of [['SessionStart', 'free'], ['UserPromptSubmit', 'occupied'], ['PreToolUse', 'occupied'], ['PermissionRequest', 'waiting'], ['PostToolUse', 'occupied'], ['Stop', 'free']]) {
    const output = await hook(home, { hook_event_name: event, session_id: 'session-one' });
    assert.deepEqual(output, { stdout: '', stderr: '' });
    assert.equal((await state(home)).state, expected, event);
  }
});

test('permission/idle notifications and AskUserQuestion are waiting; unrelated notifications are ignored', async t => {
  const home = await fixture(t);
  for (const notification_type of ['permission_prompt', 'idle_prompt']) {
    await hook(home, { hook_event_name: 'Notification', notification_type, session_id: 'one' });
    assert.equal((await state(home)).state, 'waiting');
  }
  await hook(home, { hook_event_name: 'Stop', session_id: 'one' });
  await hook(home, { hook_event_name: 'Notification', notification_type: 'auth_success', session_id: 'one' });
  assert.equal((await state(home)).state, 'free');
  await hook(home, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 'one' });
  assert.equal((await state(home)).state, 'waiting');
});

test('session aggregation prioritizes waiting then working and ignores ended sessions', async t => {
  const home = await fixture(t);
  await hook(home, { hook_event_name: 'SessionStart', session_id: 'free' });
  await hook(home, { hook_event_name: 'UserPromptSubmit', session_id: 'working' });
  assert.equal((await state(home)).state, 'occupied');
  await hook(home, { hook_event_name: 'PermissionRequest', session_id: 'waiting' });
  assert.equal((await state(home)).state, 'waiting');
  await hook(home, { hook_event_name: 'SessionEnd', session_id: 'waiting' });
  assert.equal((await state(home)).state, 'occupied');
});

test('only hashed session/state/event/time/pid persist, and subagents cannot overwrite main state', async t => {
  const home = await fixture(t);
  const session_id = '../../private-session';
  await hook(home, { hook_event_name: 'PermissionRequest', session_id, prompt: 'secret prompt', tool_input: { command: 'secret command' }, transcript_path: 'private-path', accessToken: 'secret-token' });
  await hook(home, { hook_event_name: 'PostToolUse', session_id, agent_id: 'subagent' });
  assert.equal((await state(home)).state, 'waiting');
  const hash = crypto.createHash('sha256').update(session_id).digest('hex');
  const record = JSON.parse(await fs.readFile(path.join(home, 'statusline-activity', `${hash}.json`), 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['event', 'pid', 'sessionHash', 'state', 'updatedAt']);
  assert.doesNotMatch(JSON.stringify(record), /secret|private|subagent/);
  assert.equal(record.pid, null);
});

test('stale activity becomes unknown rather than claiming free or occupied', async t => {
  const home = await fixture(t);
  await hook(home, { hook_event_name: 'UserPromptSubmit', session_id: 'one' });
  const future = await readClaudeActivity({ claudeHome: home, processCount: 1, now: Date.now() + 16 * 60 * 1000 });
  assert.equal(future.state, 'unknown');
});

test('malformed or unsupported inputs exit silently without recording state', async t => {
  const home = await fixture(t);
  assert.deepEqual(await hook(home, '{invalid'), { stdout: '', stderr: '' });
  assert.deepEqual(await hook(home, { hook_event_name: 'future-event', session_id: 'one' }), { stdout: '', stderr: '' });
  assert.equal((await state(home)).state, 'unknown');
});

test('additive installation is idempotent and restore preserves unrelated hooks and later edits', async t => {
  const home = await fixture(t);
  const originalHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo existing' }] };
  const settingsPath = path.join(home, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'original' }, hooks: { PreToolUse: [originalHook], Stop: [] }, theme: 'dark' }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home };
  await run(process.execPath, [installer, '--install'], { env, windowsHide: true });
  await run(process.execPath, [installer, '--install'], { env, windowsHide: true });
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.deepEqual(settings.hooks.PreToolUse[0], originalHook);
  assert.equal(settings.statusLine.command, 'original');
  const owned = settings.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(owned.async, true);
  assert.equal(owned.timeout, 2);
  const laterHook = { hooks: [{ type: 'command', command: 'echo later' }] };
  settings.hooks.Stop.push(laterHook);
  settings.theme = 'light';
  await fs.writeFile(settingsPath, JSON.stringify(settings));
  const copiedScript = path.join(home, 'statusline-activity', 'hook.cjs');
  await hook(home, { session_id: 'one', hook_event_name: 'UserPromptSubmit' }, copiedScript);
  assert.equal((await state(home)).state, 'occupied');
  await run(process.execPath, [installer, '--restore'], { env, windowsHide: true });
  const restored = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.deepEqual(restored.hooks, { PreToolUse: [originalHook], Stop: [laterHook] });
  assert.equal(restored.theme, 'light');
  assert.equal(restored.statusLine.command, 'original');
});
