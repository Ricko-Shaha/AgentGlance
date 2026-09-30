'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { readCodexUsage, parseLimits, parseSessionTail, readLocalSession, readRemoteLimits } = require('../electron/codex-usage.cjs');
const NOW = Date.UTC(2026, 8, 29, 12);
const at = new Date(NOW).toISOString();
const limits = { primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: NOW / 1000 + 3600 }, secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: NOW / 1000 + 86400 } };
const event = { timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 900000 }, last_token_usage: { total_tokens: 75000 }, model_context_window: 250000 }, rate_limits: { primary: { used_percent: 24, window_minutes: 300, resets_at: NOW / 1000 + 3600 } } } };
const emptyLocal = () => ({ context: null, limits: [], updatedAt: null });

test('rate limits use actual window durations, not assumed primary/secondary semantics', () => {
  assert.deepEqual(parseLimits({ rateLimits: limits }).map(row => [row.label, row.usedPercent]), [['5-hour', 24], ['Weekly', 42]]);
  assert.equal(parseLimits({ primary: { usedPercent: 40, windowDurationMins: 10080 } })[0].label, 'Weekly');
  assert.equal(parseLimits({ primary: { usedPercent: 12, windowDurationMins: 60 } })[0].label, '1-hour');
  assert.deepEqual(parseLimits({ primary: { usedPercent: '12' } }), []);
  assert.equal(parseLimits({ rateLimits: limits, rateLimitsByLimitId: { codex: { primary: { usedPercent: 10 } } } })[0].usedPercent, 10);
});

test('context uses the last turn rather than lifetime cumulative tokens and strips conversation data', () => {
  const text = [JSON.stringify({ type: 'response_item', payload: { text: 'PRIVATE CONVERSATION token_count' } }), JSON.stringify(event), '{partial'].join('\n');
  const result = parseSessionTail(text, NOW);
  assert.equal(result.context.usedTokens, 75000);
  assert.equal(result.context.maxTokens, 250000);
  assert.equal(result.context.usedPercent, 30);
  assert.equal(result.context.sessionLabel, 'Most recent Codex session');
  assert(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(result.limits[0].label, '5-hour');
  assert.equal(result.stale, false);
});

test('local reader uses bounded session tail and returns no file path or session id', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'statusline-usage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessionDir = path.join(directory, 'sessions', '2026', '09', '29');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, 'rollout-2026-private-session-id.jsonl'), `${'x'.repeat(1100000)}\n${JSON.stringify(event)}\n`);
  const result = await readLocalSession(directory, NOW);
  assert.equal(result.context.usedTokens, 75000);
  assert(!JSON.stringify(result).includes(directory));
  assert(!JSON.stringify(result).includes('private-session-id'));
});

test('remote reads cache for 120 seconds and concurrent calls share one request', async () => {
  let reads = 0;
  const readRemote = async () => { reads++; await new Promise(resolve => setTimeout(resolve, 5)); return { rateLimits: limits }; };
  const readLocal = emptyLocal;
  const options = { now: NOW, readRemote, readLocal };
  const [a, b] = await Promise.all([readCodexUsage(options), readCodexUsage(options)]);
  assert.equal(reads, 1);
  assert.deepEqual(a, b);
  await readCodexUsage({ ...options, now: NOW + 119000 });
  assert.equal(reads, 1);
  await readCodexUsage({ ...options, now: NOW + 120001 });
  assert.equal(reads, 2);
  assert.equal(a.source, 'Codex account usage');
});

test('refresh failure retains cached values with stale notice and never exposes error details', async () => {
  let reads = 0;
  const readRemote = async () => { if (++reads > 1) throw new Error('private-auth-value'); return { rateLimits: limits }; };
  const options = { now: NOW, readRemote, readLocal: emptyLocal };
  await readCodexUsage(options);
  const result = await readCodexUsage({ ...options, now: NOW + 120001 });
  assert.equal(result.stale, true);
  assert.equal(result.limits[0].usedPercent, 24);
  assert.match(result.message, /could not be refreshed/);
  assert(!JSON.stringify(result).includes('private-auth-value'));
});

test('local fallback and entirely unavailable sources are explicit', async () => {
  const local = parseSessionTail(JSON.stringify(event), NOW + 3600000);
  const fallback = await readCodexUsage({ now: NOW + 3600000, readRemote: async () => { throw new Error('offline'); }, readLocal: () => local });
  assert.equal(fallback.state, 'available');
  assert.equal(fallback.source, 'Local Codex session metadata');
  assert.equal(fallback.stale, true);
  const unavailable = await readCodexUsage({ now: NOW, readRemote: async () => ({}), readLocal: emptyLocal });
  assert.equal(unavailable.state, 'unavailable');
  assert.deepEqual(unavailable.limits, []);
  assert.equal(unavailable.context, null);
});

test('app-server protocol initializes then reads account limits, never starts inference, and terminates', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough();
  let killed = false;
  child.kill = () => { killed = true; };
  const sent = [];
  child.stdin.on('data', buffer => {
    const message = JSON.parse(buffer.toString()); sent.push(message);
    if (message.id === 1) setImmediate(() => child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`));
    if (message.id === 2) setImmediate(() => child.stdout.write(`${JSON.stringify({ id: 2, result: { rateLimits: limits } })}\n`));
  });
  const result = await readRemoteLimits({ env: {}, home: '/fixture', codexHome: '/fixture/.codex', executable: 'fake-codex', spawnProcess: (program, args, options) => {
    assert.equal(program, 'fake-codex'); assert.deepEqual(args, ['app-server']); assert.equal(options.windowsHide, true); return child;
  } });
  assert.deepEqual(sent.map(message => message.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.deepEqual(result.rateLimits, limits);
  assert.equal(killed, true);
});

test('app-server timeout is bounded and terminates the child', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
  let killed = false; child.kill = () => { killed = true; };
  await assert.rejects(readRemoteLimits({ env: {}, home: '/fixture', codexHome: '/fixture', executable: 'fake', timeoutMs: 10, spawnProcess: () => child }), /timed out/);
  assert.equal(killed, true);
});
