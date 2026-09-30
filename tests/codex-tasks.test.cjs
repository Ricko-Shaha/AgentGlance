'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readCodexTasks } = require('../electron/codex-tasks.cjs');
const NOW = Date.UTC(2026, 8, 29, 15);
function session({ id='private-raw-session-id', project='Project', title=`${project} task`, used=50000, max=200000, time=NOW, state='task_started', source='cli' } = {}) {
  return [
    { type: 'session_meta', payload: { source, id, title, cwd: `C:\\Users\\PRIVATE_USERNAME\\Projects\\${project}` } },
    { type: 'response_item', payload: { text: 'PRIVATE_PROMPT do not render this' } },
    { type: 'event_msg', timestamp: new Date(time-1000).toISOString(), payload: { type: state } },
    { type: 'event_msg', timestamp: new Date(time).toISOString(), payload: { type: 'token_count', info: { last_token_usage: { total_tokens: used }, total_token_usage: { total_tokens: 9000000 }, model_context_window: max } } },
  ].map(row => JSON.stringify(row)).join('\n')+'\n';
}
async function fixture(t, records) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'statusline-tasks-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, '.codex', 'sessions', '2026', '09', '29');
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(records.map((text, index) => fs.writeFile(path.join(directory, `rollout-${index}.jsonl`), text)));
  return { home, env: {}, now: NOW };
}

test('each recent main session retains its own context and lifecycle, never cumulative tokens', async t => {
  const options = await fixture(t, [session({ id:'first', project:'Alpha', used:50000, max:200000 }), session({ id:'second', project:'Beta', used:30000, max:100000, state:'task_complete', time:NOW-5000 })]);
  const rows = await readCodexTasks(options);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].context.usedTokens, 50000);
  assert.equal(rows[0].context.usedPercent, 25);
  assert.equal(rows[0].state, 'occupied');
  assert.equal(rows[1].context.usedTokens, 30000);
  assert.equal(rows[1].context.usedPercent, 30);
  assert.equal(rows[1].state, 'free');
  assert.match(rows[0].label, /^Alpha task · [a-f0-9]{4}$/);
  assert.notEqual(rows[0].id, rows[1].id);
});

test('child sessions are included with an agent label but old agents are excluded', async t => {
  const options = await fixture(t, [session({ id:'main' }), session({ id:'child', source:{subagent:{spawn:'hidden'}} }), session({ id:'old', source:{subagent:'old-agent'}, time:NOW-25*3600000 })]);
  const rows = await readCodexTasks(options);
  assert.equal(rows.length, 2);
  assert.match(rows[1].label, / · agent [a-f0-9]{4}$/);
});

test('older completed main history remains visible with its original age and context, without reviving old agents', async t => {
  const observed = NOW-3*86400000;
  const options = await fixture(t, [session({ id:'current', time:NOW }), session({ id:'old-main', project:'IdleProject', time:observed, state:'task_complete', used:62000 }), session({ id:'old-agent', source:{subagent:'worker'}, time:observed, state:'task_complete' })]);
  const rows = await readCodexTasks(options);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, 'occupied');
  assert.match(rows[1].label, /^IdleProject task · /);
  assert.equal(rows[1].state, 'free');
  assert.equal(rows[1].updatedAt, new Date(observed).toISOString());
  assert.equal(rows[1].context.usedTokens, 62000);
  assert.deepEqual(Object.keys(rows[1]).sort(), ['context','id','label','state','updatedAt']);
});

test('unknown capacity stays unknown and raw paths, IDs and prompts never leak', async t => {
  const options = await fixture(t, [session({ max:null })]);
  const rows = await readCodexTasks(options);
  assert.equal(rows[0].context.maxTokens, null);
  assert.equal(rows[0].context.usedPercent, null);
  const result = JSON.stringify(rows);
  for (const secret of ['PRIVATE_USERNAME', 'PRIVATE_PROMPT', 'private-raw-session-id', 'C:', '\\Users']) assert(!result.includes(secret));
  assert.match(rows[0].id, /^[a-f0-9]{16}$/);
  assert.deepEqual(await readCodexTasks({ ...options, now: NOW+5001 }), rows);
});

test('more than five rows are returned, sorted by observed event time within priority', async t => {
  const options = await fixture(t, Array.from({length:8}, (_, index) => session({ id:`session-${index}`, time:NOW-index*60000 })));
  const rows = await readCodexTasks(options);
  assert.equal(rows.length, 8);
  assert.equal(rows[0].updatedAt, new Date(NOW).toISOString());
  assert.equal(rows[4].updatedAt, new Date(NOW-4*60000).toISOString());
});

test('old date directories and old Windows mtimes do not hide a currently active session', async t => {
  const options = await fixture(t, [session({ id:'new-completed', state:'task_complete' })]);
  const directory = path.join(options.home, '.codex', 'sessions', '2026', '08', '01');
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'rollout-old-start-currently-active.jsonl');
  await fs.writeFile(filename, session({ id:'old-running', project:'CurrentMain', time:NOW-1000 }));
  await fs.utimes(filename, new Date(NOW-50*86400000), new Date(NOW-50*86400000));
  const rows = await readCodexTasks(options);
  assert.equal(rows.length, 2);
  assert.match(rows[0].label, /^CurrentMain/);
  assert.equal(rows[0].state, 'occupied');
});

test('occupied main stays above occupied agents and completed main sessions', async t => {
  const options = await fixture(t, [session({ id:'completed', state:'task_complete', time:NOW }), session({ id:'agent', source:{subagent:'review'}, time:NOW-100 }), session({ id:'ongoing-main', project:'Main', time:NOW-5000 })]);
  const rows = await readCodexTasks(options);
  assert.match(rows[0].label, /^Main task · [a-f0-9]{4}$/);
  assert.match(rows[1].label, / · agent /);
  assert.equal(rows[2].state, 'free');
});

test('saved thread names override directory and metadata titles, and renames refresh after the cache expires', async t => {
  const options = await fixture(t, [session({ id:'main', project:'DirectoryName', title:'Original metadata title' })]);
  const index = path.join(options.home, '.codex', 'session_index.jsonl');
  const row = (title, time) => JSON.stringify({ id:'main', thread_name:title, updated_at:new Date(time).toISOString() })+'\n';
  await fs.writeFile(index, row('Build AI status widget', NOW));
  const first = await readCodexTasks(options);
  assert.match(first[0].label, /^Build AI status widget · [a-f0-9]{4}$/);
  assert(!first[0].label.includes('DirectoryName'));
  await fs.appendFile(index, row('Renamed desktop task', NOW+5000)+row('Out of order old title', NOW-1000));
  const renamed = await readCodexTasks({ ...options, now:NOW+5001 });
  assert.match(renamed[0].label, /^Renamed desktop task · /);
  assert.equal(renamed[0].id, first[0].id);
});

test('untitled sessions and agents never substitute directories or prompt text', async t => {
  const options = await fixture(t, [session({ id:'main', project:'SECRET_DIRECTORY', title:null }), session({ id:'agent', project:'SECRET_DIRECTORY', title:null, source:{subagent:'worker'} })]);
  const rows = await readCodexTasks(options);
  assert.match(rows[0].label, /^Untitled session · [a-f0-9]{4}$/);
  assert.match(rows[1].label, /^Untitled agent · [a-f0-9]{4}$/);
  assert(!JSON.stringify(rows).includes('SECRET_DIRECTORY'));
  assert(!JSON.stringify(rows).includes('PRIVATE_PROMPT'));
});

test('session without a token snapshot has null context, missing storage is empty', async t => {
  const text = session().split('\n').filter(line => !line.includes('token_count')).join('\n');
  const options = await fixture(t, [text]);
  assert.equal((await readCodexTasks(options))[0].context, null);
  assert.deepEqual(await readCodexTasks({ home:path.join(options.home, 'missing'), env:{}, now:NOW }), []);
});
