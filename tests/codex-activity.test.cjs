'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readCodexActivity, parseActivity, readLatestMain } = require('../electron/codex-activity.cjs');
const NOW = Date.UTC(2026, 8, 29, 14);
const event = (type, time=NOW) => JSON.stringify({ type: 'event_msg', timestamp: new Date(time).toISOString(), payload: { type } });

test('explicit task lifecycle controls activity instead of process presence or tokens', () => {
  assert.equal(parseActivity(event('task_started'), NOW).state, 'occupied');
  assert.equal(parseActivity([event('task_started'), event('task_complete')].join('\n'), NOW).state, 'free');
  assert.equal(parseActivity(event('turn_aborted'), NOW).state, 'free');
  assert.equal(parseActivity(event('token_count'), NOW).state, 'unknown');
  assert.equal(parseActivity(event('task_started', NOW - 31*60000), NOW).state, 'unknown');
  assert.equal(parseActivity(event('task_complete', NOW - 86400000), NOW).state, 'free');
});

test('waiting requires explicit approval or user input event', () => {
  assert.equal(parseActivity(event('exec_approval_request'), NOW).state, 'waiting');
  assert.equal(parseActivity(event('request_user_input'), NOW).state, 'waiting');
  assert.equal(parseActivity(JSON.stringify({ type: 'response_item', timestamp: new Date(NOW).toISOString(), payload: { type: 'task_started', text: 'PRIVATE' } }), NOW).state, 'unknown');
});

test('newer completed child does not hide occupied main session', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'statusline-activity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'sessions', '2026', '09', '29');
  await fs.mkdir(directory, { recursive: true });
  const main = path.join(directory, 'rollout-main.jsonl');
  const child = path.join(directory, 'rollout-child.jsonl');
  await fs.writeFile(main, `${JSON.stringify({ type: 'session_meta', payload: { source: 'cli', id: 'PRIVATE' } })}\n${event('task_started')}\n`);
  await fs.writeFile(child, `${JSON.stringify({ type: 'session_meta', payload: { source: { subagent: { spawn: 'PRIVATE' } } } })}\n${event('task_complete')}\n`);
  await fs.utimes(child, new Date(NOW+1000), new Date(NOW+1000));
  const result = await readLatestMain(root, NOW);
  assert.equal(result.state, 'occupied');
  assert.equal(result.source, 'Recent Codex sessions and agents');
  assert(!JSON.stringify(result).includes('PRIVATE'));
  assert(!JSON.stringify(result).includes(root));
});

test('an occupied session in an old date folder is not replaced by a newly completed session', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'statusline-old-activity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [month, day, type, time] of [['08', '01', 'task_started', NOW-1000], ['09', '29', 'task_complete', NOW]]) {
    const directory = path.join(root, 'sessions', '2026', month, day);
    await fs.mkdir(directory, { recursive: true });
    const filename = path.join(directory, 'rollout-test.jsonl');
    await fs.writeFile(filename, `${JSON.stringify({type:'session_meta',payload:{source:'cli'}})}\n${event(type,time)}\n`);
    if (month === '08') await fs.utimes(filename, new Date(NOW-50*86400000), new Date(NOW-50*86400000));
  }
  assert.equal((await readLatestMain(root, NOW)).state, 'occupied');
});

test('missing session metadata remains unknown, no running process is free', async () => {
  assert.equal((await readCodexActivity({ processCount: 0 })).state, 'free');
  assert.equal((await readLatestMain(path.join(os.tmpdir(), 'nonexistent-activity-fixture'), NOW)).state, 'unknown');
});

test('five-second cache deduplicates reads and refreshes activity', async () => {
  let calls = 0;
  const readSession = () => { calls++; return parseActivity(event(calls === 1 ? 'task_started' : 'task_complete'), NOW); };
  const [a,b] = await Promise.all([readCodexActivity({ now: NOW, readSession }), readCodexActivity({ now: NOW, readSession })]);
  assert.equal(calls, 1); assert.equal(a.state, 'occupied'); assert.deepEqual(a,b);
  assert.equal((await readCodexActivity({ now: NOW+5001, readSession })).state, 'free');
  assert.equal(calls, 2);
});
