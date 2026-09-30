'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readClaudeUsage, sanitizeStatusline } = require('../electron/claude-usage.cjs');
const run = promisify(execFile);
const now = Date.parse('2026-09-29T12:00:00Z');

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'statusline-claude-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test('documented statusline fields produce actual limits/context and exclude sensitive fields', () => {
  const value = sanitizeStatusline({
    api_key: 'excluded', session_name: 'private task', transcript_path: '/private/path',
    rate_limits: { five_hour: { used_percentage: 73, resets_at: now / 1000 + 3600 }, seven_day: { used_percentage: 68 } },
    context_window: { used_percentage: 25, context_window_size: 1000000, current_usage: { input_tokens: 1000, cache_read_input_tokens: 200000, cache_creation_input_tokens: 49000, output_tokens: 99999 } },
  }, now);
  assert.equal(value.context.usedTokens, 250000);
  assert.equal(value.context.usedPercent, 25);
  assert.equal(value.context.maxTokens, 1000000);
  assert.equal(value.limits[0].resetsAt, '2026-09-29T13:00:00.000Z');
  assert.equal(value.limits[1].resetsAt, null);
  assert.doesNotMatch(JSON.stringify(value), /excluded|private|99999/);
});

test('missing or invalid usage never becomes fake zero or guessed capacity', () => {
  const value = sanitizeStatusline({ rate_limits: { five_hour: { used_percentage: null }, seven_day: { used_percentage: 101 } }, context_window: { current_usage: null, used_percentage: null } }, now);
  assert.deepEqual(value.limits, []);
  assert.equal(value.context, null);
  const partial = sanitizeStatusline({ context_window: { current_usage: { input_tokens: 1200 } } }, now);
  assert.equal(partial.context.usedTokens, 1200);
  assert.equal(partial.context.maxTokens, null);
  assert.equal(partial.context.usedPercent, null);
});

test('fresh complete capture avoids network and expired reset is stale', async t => {
  const claudeHome = await fixture(t);
  const cachePath = path.join(claudeHome, 'capture.json');
  const capture = sanitizeStatusline({ rate_limits: { five_hour: { used_percentage: 42, resets_at: now / 1000 + 30 }, seven_day: { used_percentage: 51 } }, context_window: { used_percentage: 20, context_window_size: 200000 } }, now);
  await fs.writeFile(cachePath, JSON.stringify(capture));
  const result = await readClaudeUsage({ claudeHome, cachePath, now, transcriptPath: null, requestUsage: () => { throw new Error('Must not call network'); } });
  assert.equal(result.state, 'available');
  assert.equal(result.stale, false);
  const expired = await readClaudeUsage({ claudeHome, cachePath, now: now + 31000, transcriptPath: null, allowNetwork: false });
  assert.equal(expired.stale, true);
  assert.equal(expired.limits[0].usedPercent, 42);
});

test('transcript fallback reports only latest main-session input/cache totals', async t => {
  const claudeHome = await fixture(t);
  const transcriptPath = path.join(claudeHome, 'session.jsonl');
  await fs.writeFile(transcriptPath, [
    JSON.stringify({ type: 'assistant', timestamp: new Date(now).toISOString(), message: { content: 'PRIVATE PROMPT', usage: { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 55 } } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: new Date(now).toISOString(), message: { usage: { input_tokens: 9999 } } }),
  ].join('\n'));
  const result = await readClaudeUsage({ claudeHome, now, transcriptPath, allowNetwork: false });
  assert.equal(result.state, 'partial');
  assert.equal(result.context.usedTokens, 240);
  assert.equal(result.context.maxTokens, null);
  assert.equal(result.context.usedPercent, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|9999/);
});

test('account service results and failures are cached for 120 seconds, without exposing credentials', async t => {
  const claudeHome = await fixture(t);
  await fs.writeFile(path.join(claudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test-token', expiresAt: now + 3600000 } }));
  let requests = 0;
  const options = { claudeHome, transcriptPath: null, requestUsage: async token => {
    requests++;
    assert.equal(token, 'test-token');
    if (requests === 2) throw new Error('credential must never appear in error output');
    return { five_hour: { utilization: 12, resets_at: '2026-09-29T14:00:00Z' }, seven_day: { utilization: 34 } };
  } };
  const first = await readClaudeUsage({ ...options, now });
  const cached = await readClaudeUsage({ ...options, now: now + 119999 });
  assert.equal(requests, 1);
  assert.equal(first.limits[0].usedPercent, 12);
  assert.equal(cached.updatedAt, first.updatedAt);
  assert.doesNotMatch(JSON.stringify(first), /test-token|accessToken/);
  await readClaudeUsage({ ...options, now: now + 120001 });
  await readClaudeUsage({ ...options, now: now + 130000 });
  assert.equal(requests, 2);
});

test('expired credentials never cause network access or refresh writes', async t => {
  const claudeHome = await fixture(t);
  const credentialsPath = path.join(claudeHome, '.credentials.json');
  const original = JSON.stringify({ claudeAiOauth: { accessToken: 'expired-token', refreshToken: 'do-not-use', expiresAt: now - 1 } });
  await fs.writeFile(credentialsPath, original);
  const result = await readClaudeUsage({ claudeHome, now, transcriptPath: null, requestUsage: () => { throw new Error('Should not be called'); } });
  assert.equal(result.state, 'unavailable');
  assert.equal(await fs.readFile(credentialsPath, 'utf8'), original);
});

test('bridge installation preserves existing output and restores only statusLine settings', async t => {
  const claudeHome = await fixture(t);
  const existing = path.join(claudeHome, 'previous.cjs');
  await fs.writeFile(existing, "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('unchanged terminal output'));");
  const original = { type: 'command', command: `"${process.execPath}" "${existing}"`, padding: 2 };
  const settingsPath = path.join(claudeHome, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify({ statusLine: original, theme: 'dark' }));
  const installer = path.join(__dirname, '..', 'scripts', 'install-claude-bridge.cjs');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome };
  await run(process.execPath, [installer, '--install'], { env, windowsHide: true });
  const manifest = path.join(claudeHome, 'statusline-usage', 'manifest.json');
  const bridge = path.join(claudeHome, 'statusline-usage', 'bridge.cjs');
  const input = JSON.stringify({ context_window: { used_percentage: 37, context_window_size: 1000000 }, private: 'not cached' });
  const output = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [bridge, '--manifest', manifest], { env, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(input);
  });
  assert.equal(output, 'unchanged terminal output');
  const capture = JSON.parse(await fs.readFile(path.join(claudeHome, 'statusline-usage', 'latest.json'), 'utf8'));
  assert.equal(capture.context.usedPercent, 37);
  assert.doesNotMatch(JSON.stringify(capture), /not cached|private/);
  const modified = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  modified.theme = 'light';
  await fs.writeFile(settingsPath, JSON.stringify(modified));
  await run(process.execPath, [installer, '--restore'], { env, windowsHide: true });
  const restored = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.deepEqual(restored.statusLine, original);
  assert.equal(restored.theme, 'light');
});
