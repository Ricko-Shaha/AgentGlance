'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readClaudeTasks } = require('../electron/claude-tasks.cjs');
const run = promisify(execFile);
const wrapper = path.join(__dirname, '..', 'scripts', 'claude-statusline.cjs');
const installer = path.join(__dirname, '..', 'scripts', 'install-claude-bridge.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sessionA = '11111111-1111-4111-8111-111111111111';
const sessionB = '22222222-2222-4222-8222-222222222222';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'statusline-claude-tasks-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}
async function capture(home, session_id, project, used, max, filename = wrapper, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [filename, ...extraArgs], { env: { ...process.env, CLAUDE_CONFIG_DIR: home }, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(JSON.stringify({ session_id, workspace: { current_dir: project }, prompt: 'PRIVATE PROMPT', accessToken: 'SECRET TOKEN', context_window: { context_window_size: max, current_usage: { input_tokens: used }, used_percentage: used / max * 100 } }));
  });
}
async function transcript(home, sessionId, entries) {
  const directory = path.join(home, 'projects', 'encoded-project');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${sessionId}.jsonl`), entries.map(entry => JSON.stringify({ sessionId, cwd: 'D:/private/RealProject', ...entry })).join('\n'));
}

test('two captures keep distinct session capacities and matching activity state', async t => {
  const home = await fixture(t);
  await capture(home, sessionA, 'D:/private/Alpha', 10000, 200000);
  await capture(home, sessionB, 'D:/private/Beta', 600000, 1000000);
  await fs.mkdir(path.join(home, 'statusline-activity'));
  await fs.writeFile(path.join(home, 'statusline-activity', `${hash(sessionA)}.json`), JSON.stringify({ sessionHash: hash(sessionA), state: 'waiting', updatedAt: new Date().toISOString() }));
  const tasks = await readClaudeTasks({ claudeHome: home });
  assert.equal(tasks.length, 2);
  const alpha = tasks.find(task => task.id === hash(sessionA));
  const beta = tasks.find(task => task.id === hash(sessionB));
  assert.deepEqual(alpha.context, { usedTokens: 10000, maxTokens: 200000, usedPercent: 5 });
  assert.deepEqual(beta.context, { usedTokens: 600000, maxTokens: 1000000, usedPercent: 60 });
  assert.equal(alpha.state, 'waiting');
  assert.equal(beta.state, 'unknown');
  assert.match(alpha.label, /^Untitled session · [a-f0-9]{6}$/);
  assert.doesNotMatch(JSON.stringify(tasks), /PRIVATE|SECRET|D:|private|11111111/);
  const persisted = await fs.readFile(path.join(home, 'statusline-usage', 'sessions', `${hash(sessionA)}.json`), 'utf8');
  assert.doesNotMatch(persisted, /PRIVATE|SECRET|D:|private|11111111/);
  assert.ok(await fs.stat(path.join(home, 'statusline-usage', 'latest.json')));
});

test('transcript bootstrap uses matching main-session input/cache metadata without guessing capacity', async t => {
  const home = await fixture(t);
  const now = Date.now();
  await transcript(home, sessionA, [
    { type: 'assistant', timestamp: new Date(now - 1000).toISOString(), message: { content: 'private conversation', usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 300, output_tokens: 9999 } } },
    { type: 'assistant', sessionId: sessionB, timestamp: new Date(now).toISOString(), message: { usage: { input_tokens: 8888 } } },
    { type: 'assistant', isSidechain: true, timestamp: new Date(now).toISOString(), message: { usage: { input_tokens: 7777 } } },
  ]);
  const tasks = await readClaudeTasks({ claudeHome: home, now });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, hash(sessionA));
  assert.deepEqual(tasks[0].context, { usedTokens: 600, maxTokens: null, usedPercent: null });
  assert.match(tasks[0].label, /^Untitled session ·/);
  assert.doesNotMatch(JSON.stringify(tasks), /private|conversation|9999|8888|7777/);
});

test('newer exact capture replaces only its matching transcript context', async t => {
  const home = await fixture(t);
  const timestamp = new Date(Date.now() - 60000).toISOString();
  await transcript(home, sessionA, [{ type: 'assistant', timestamp, message: { usage: { input_tokens: 100 } } }]);
  await transcript(home, sessionB, [{ type: 'assistant', timestamp, message: { usage: { input_tokens: 200 } } }]);
  await capture(home, sessionA, '/projects/Alpha', 8000, 200000);
  const tasks = await readClaudeTasks({ claudeHome: home });
  assert.equal(tasks.find(task => task.id === hash(sessionA)).context.maxTokens, 200000);
  assert.equal(tasks.find(task => task.id === hash(sessionB)).context.maxTokens, null);
  assert.equal(tasks.find(task => task.id === hash(sessionB)).context.usedTokens, 200);
});

test('inactive history expires after 24 hours and output is capped at 64 rather than five', async t => {
  const home = await fixture(t);
  const directory = path.join(home, 'statusline-usage', 'sessions');
  await fs.mkdir(directory, { recursive: true });
  const now = Date.now();
  for (let index = 0; index < 70; index++) {
    const id = hash(`session-${index}`);
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ schemaVersion: 1, id, label: `Project${index}`, context: null, updatedAt: new Date(now - index * 1000).toISOString() }));
  }
  const oldId = hash('old');
  await fs.writeFile(path.join(directory, `${oldId}.json`), JSON.stringify({ schemaVersion: 1, id: oldId, label: 'old', context: null, updatedAt: new Date(now - 25 * 3600000).toISOString() }));
  const tasks = await readClaudeTasks({ claudeHome: home, now });
  assert.equal(tasks.length, 64);
  assert.equal(tasks[0].id, hash('session-0'));
  assert.equal(tasks[63].id, hash('session-63'));
  assert.ok(tasks.every(task => task.state === 'unknown'));
});

test('live registry retains old sessions with exact context and prioritizes them above recent history', async t => {
  const home = await fixture(t);
  const now = Date.now();
  const old = now - 3 * 24 * 3600000;
  await fs.mkdir(path.join(home, 'sessions'));
  await fs.writeFile(path.join(home, 'sessions', '12345.json'), JSON.stringify({ pid: 12345, sessionId: sessionA, cwd: 'D:/private/LongRunning', updatedAt: old, startedAt: old }));
  await transcript(home, sessionA, [{ type: 'assistant', timestamp: new Date(old).toISOString(), message: { usage: { input_tokens: 987, cache_read_input_tokens: 13 } } }]);
  await fs.utimes(path.join(home, 'projects', 'encoded-project', `${sessionA}.jsonl`), old / 1000, old / 1000);
  await capture(home, sessionB, 'D:/private/RecentHistory', 100, 200000);
  const tasks = await readClaudeTasks({ claudeHome: home, now, activePids: [12345] });
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, hash(sessionA));
  assert.deepEqual(tasks[0].context, { usedTokens: 1000, maxTokens: null, usedPercent: null });
  assert.equal(tasks[0].state, 'unknown', 'PID existence is not evidence of working');
  assert.deepEqual(Object.keys(tasks[0]).sort(), ['context', 'id', 'label', 'state', 'updatedAt']);
  const inactive = await readClaudeTasks({ claudeHome: home, now, activePids: [] });
  assert.equal(inactive.length, 1);
});

test('fresh activity rescues old same-session captures and unknown-context newly observed sessions', async t => {
  const home = await fixture(t);
  const now = Date.now();
  const captures = path.join(home, 'statusline-usage', 'sessions');
  const activity = path.join(home, 'statusline-activity');
  await fs.mkdir(captures, { recursive: true });
  await fs.mkdir(activity);
  await fs.writeFile(path.join(captures, `${hash(sessionA)}.json`), JSON.stringify({ schemaVersion: 1, id: hash(sessionA), label: 'OlderTask', updatedAt: new Date(now - 2 * 24 * 3600000).toISOString(), context: { usedTokens: 777, maxTokens: 200000, usedPercent: 0.3885 } }));
  for (const [id, state] of [[hash(sessionA), 'waiting'], [hash(sessionB), 'occupied']]) {
    await fs.writeFile(path.join(activity, `${id}.json`), JSON.stringify({ sessionHash: id, state, event: 'UserPromptSubmit', updatedAt: new Date(now).toISOString() }));
  }
  const tasks = await readClaudeTasks({ claudeHome: home, now });
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, hash(sessionA));
  assert.equal(tasks[0].context.usedTokens, 777);
  assert.equal(tasks[1].context, null);
  assert.equal(tasks[1].state, 'occupied');
});

test('recent explicit subagent transcript has its own context, hash, and agent label', async t => {
  const home = await fixture(t);
  const now = Date.now();
  await transcript(home, sessionA, [{ type: 'assistant', timestamp: new Date(now).toISOString(), message: { usage: { input_tokens: 100 } } }]);
  const directory = path.join(home, 'projects', 'encoded-project', sessionA, 'subagents');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'agent-a123.jsonl'), JSON.stringify({ sessionId: sessionA, agentId: 'a123', isSidechain: true, cwd: 'D:/private/RealProject', timestamp: new Date(now).toISOString(), type: 'assistant', message: { content: 'PRIVATE CHILD PROMPT', usage: { input_tokens: 500, cache_read_input_tokens: 600 } } }));
  const tasks = await readClaudeTasks({ claudeHome: home, now });
  assert.equal(tasks.length, 2);
  const agent = tasks.find(task => task.id === hash(`${sessionA}:a123`));
  assert.match(agent.label, /^Agent session ·/);
  assert.equal(agent.context.usedTokens, 1100);
  assert.equal(agent.context.maxTokens, null);
  assert.equal(tasks.find(task => task.id === hash(sessionA)).context.usedTokens, 100);
  assert.doesNotMatch(JSON.stringify(tasks), /PRIVATE|D:|private/);
});

test('latest explicit rename wins over project labels and older saved summaries', async t => {
  const home = await fixture(t);
  const now = Date.now();
  await transcript(home, sessionA, [
    { type: 'summary', summary: 'Saved summary of the task' },
    { type: 'custom-title', customTitle: 'Older name' },
    { type: 'assistant', timestamp: new Date(now).toISOString(), message: { content: 'PRIVATE BODY', usage: { input_tokens: 321 } } },
    { type: 'custom-title', customTitle: 'Fix login timeout' },
  ]);
  await capture(home, sessionA, 'D:/some/directory', 321, 200000);
  const tasks = await readClaudeTasks({ claudeHome: home });
  assert.equal(tasks[0].label, 'Fix login timeout');
  assert.equal(tasks[0].context.maxTokens, 200000);
  assert.doesNotMatch(JSON.stringify(tasks), /directory|RealProject|PRIVATE BODY/);
});

test('bounded transcript head and session index recover saved names outside the usage tail', async t => {
  const home = await fixture(t);
  const now = Date.now();
  await transcript(home, sessionA, [
    { type: 'custom-title', customTitle: 'Restore billing webhook' },
    { type: 'user', timestamp: new Date(now).toISOString(), message: { content: 'PRIVATE'.repeat(110000) } },
    { type: 'assistant', timestamp: new Date(now).toISOString(), message: { usage: { input_tokens: 101 } } },
  ]);
  await transcript(home, sessionB, [{ type: 'assistant', timestamp: new Date(now).toISOString(), message: { usage: { input_tokens: 202 } } }]);
  await fs.writeFile(path.join(home, 'projects', 'encoded-project', 'sessions-index.json'), JSON.stringify({ entries: [{ sessionId: sessionB, summary: 'Investigate queue retry failures', firstPrompt: 'DO NOT DISPLAY THIS PROMPT' }] }));
  const tasks = await readClaudeTasks({ claudeHome: home, now });
  assert.equal(tasks.find(task => task.id === hash(sessionA)).label, 'Restore billing webhook');
  assert.equal(tasks.find(task => task.id === hash(sessionB)).label, 'Investigate queue retry failures');
  assert.doesNotMatch(JSON.stringify(tasks), /PRIVATE|DO NOT DISPLAY/);
});

test('live user names survive context merging while derived registry slugs are not task titles', async t => {
  const home = await fixture(t);
  const now = Date.now();
  await fs.mkdir(path.join(home, 'sessions'));
  for (const [pid, sessionId, name, nameSource] of [[12345, sessionA, 'ASP-1090', 'user'], [12346, sessionB, 'foundry-96', 'derived']]) {
    await fs.writeFile(path.join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, name, nameSource, updatedAt: now }));
  }
  await capture(home, sessionA, 'D:/private/project', 100, 200000);
  const tasks = await readClaudeTasks({ claudeHome: home, activePids: [12345, 12346] });
  assert.equal(tasks.find(task => task.id === hash(sessionA)).label, 'ASP-1090');
  assert.match(tasks.find(task => task.id === hash(sessionB)).label, /^Untitled session ·/);
});

test('explicit subagent metadata supplies the actual assigned task description', async t => {
  const home = await fixture(t);
  const now = Date.now();
  const directory = path.join(home, 'projects', 'encoded-project', sessionA, 'subagents');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'agent-a123.jsonl'), JSON.stringify({ sessionId: sessionA, agentId: 'a123', isSidechain: true, type: 'assistant', timestamp: new Date(now).toISOString(), cwd: 'D:/private/Project', message: { usage: { input_tokens: 300 } } }));
  await fs.writeFile(path.join(directory, 'agent-a123.meta.json'), JSON.stringify({ description: 'Audit retry handling', requestShape: { prompt: 'DO NOT DISPLAY' } }));
  const tasks = await readClaudeTasks({ claudeHome: home, now });
  assert.equal(tasks[0].label, 'Audit retry handling');
  assert.doesNotMatch(JSON.stringify(tasks), /DO NOT DISPLAY|D:|Project/);
});

test('recent transcript in old project directory is not hidden behind newest 20 directory mtimes', async t => {
  const home = await fixture(t);
  const now = Date.now();
  await transcript(home, sessionA, [{ type: 'assistant', timestamp: new Date(now).toISOString(), message: { usage: { input_tokens: 123 } } }]);
  const old = now - 5 * 24 * 3600000;
  await fs.utimes(path.join(home, 'projects', 'encoded-project'), old / 1000, old / 1000);
  for (let index = 0; index < 24; index++) await fs.mkdir(path.join(home, 'projects', `new-${index}`));
  const tasks = await readClaudeTasks({ claudeHome: home, now });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].context.usedTokens, 123);
});

test('installer rerun refreshes bridge, preserves original manifest/output, and remains restorable', async t => {
  const home = await fixture(t);
  const previous = path.join(home, 'previous.cjs');
  await fs.writeFile(previous, "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('existing output'));\n");
  const originalStatusLine = { type: 'command', command: `"${process.execPath}" "${previous}"`, padding: 3 };
  const settingsPath = path.join(home, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify({ statusLine: originalStatusLine, theme: 'dark' }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home };
  await run(process.execPath, [installer, '--install'], { env, windowsHide: true });
  const directory = path.join(home, 'statusline-usage');
  const manifest = path.join(directory, 'manifest.json');
  const before = await fs.readFile(manifest, 'utf8');
  const settingsBefore = await fs.readFile(settingsPath, 'utf8');
  const bridge = path.join(directory, 'bridge.cjs');
  await fs.writeFile(bridge, '// old installed version');
  await run(process.execPath, [installer, '--install'], { env, windowsHide: true });
  assert.equal(await fs.readFile(manifest, 'utf8'), before);
  assert.equal(await fs.readFile(settingsPath, 'utf8'), settingsBefore);
  assert.match(await fs.readFile(bridge, 'utf8'), /session_id/);
  assert.equal(await capture(home, sessionA, 'C:/projects/Test', 500, 200000, bridge, ['--manifest', manifest]), 'existing output');
  assert.equal((await readClaudeTasks({ claudeHome: home }))[0].context.usedTokens, 500);
  await run(process.execPath, [installer, '--restore'], { env, windowsHide: true });
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')).statusLine, originalStatusLine);
});
