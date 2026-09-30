'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { getIntegrationStatus, connectIntegration, disconnectIntegration, workerCommand, quoteArgument, EVENTS } = require('../electron/claude-integration.cjs');
const { runClaudeWorker } = require('../electron/claude-worker.cjs');

async function fixture(t, settings = {}, authenticated = true) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'statusline-integration-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = path.join(home, 'custom claude');
  await fs.mkdir(config, { recursive: true });
  await fs.writeFile(path.join(config, 'settings.json'), JSON.stringify(settings));
  if (authenticated) await fs.writeFile(path.join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test-only-local-placeholder' } }));
  const options = { home, env: { CLAUDE_CONFIG_DIR: config }, executablePath: process.execPath, workerPath: path.resolve(__dirname, '../electron/claude-worker.cjs'), isPackaged: true, platform: process.platform, probeAuth: async () => null };
  const read = () => fs.readFile(path.join(config, 'settings.json'), 'utf8').then(JSON.parse);
  return { home, config, options, read };
}

test('connect preserves arbitrary user status line, all hooks, and unrelated settings; disconnect restores them', async t => {
  const initial = { theme: 'dark', statusLine: { type: 'command', command: 'printf custom | cat', padding: 3 }, hooks: { Stop: [{ matcher: 'original', hooks: [{ type: 'command', command: 'echo keep-me' }] }], CustomEvent: [{ hooks: [{ type: 'command', command: 'keep-custom' }] }] } };
  const f = await fixture(t, initial);
  const connected = await connectIntegration(f.options);
  assert.equal(connected.installed, true);
  const settings = await f.read();
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.statusLine.padding, 3);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo keep-me');
  for (const event of EVENTS) assert(settings.hooks[event].some(group => group.hooks.some(hook => hook.command === workerCommand('activity', f.config, f.options))));
  settings.extraUserSetting = 42;
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command: 'later-user-hook' }] });
  await fs.writeFile(path.join(f.config, 'settings.json'), JSON.stringify(settings));
  await disconnectIntegration(f.options);
  const restored = await f.read();
  assert.deepEqual(restored.statusLine, initial.statusLine);
  assert.equal(restored.extraUserSetting, 42);
  assert.equal(restored.hooks.Stop.length, 2);
  assert.deepEqual(restored.hooks.CustomEvent, initial.hooks.CustomEvent);
  assert.equal((await getIntegrationStatus(f.options)).canDisconnect, false);
});

test('setup and repeated setup are idempotent without an existing status line', async t => {
  const f = await fixture(t, { permissions: { allow: ['Read'] } });
  await connectIntegration(f.options);
  const first = await f.read();
  await connectIntegration(f.options);
  assert.deepEqual(await f.read(), first);
  await disconnectIntegration(f.options);
  assert.deepEqual(await f.read(), { permissions: { allow: ['Read'] } });
});

test('moved app reports a repairable connection and preserves original commands through repair/disconnect', async t => {
  const initial = { statusLine: { type: 'command', command: 'echo original', padding: 2 }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo retained' }] }] } };
  const f = await fixture(t, initial);
  await connectIntegration(f.options);
  const moved = { ...f.options, executablePath: path.join(f.home, 'new app', 'electron') };
  const before = await getIntegrationStatus(moved);
  assert.equal(before.installed, true);
  assert.equal(before.needsRepair, true);
  const repaired = await connectIntegration(moved);
  assert.equal(repaired.needsRepair, false);
  const settings = await f.read();
  assert.equal(settings.statusLine.command, workerCommand('usage', f.config, moved));
  const oldCommand = workerCommand('activity', f.config, f.options);
  const newCommand = workerCommand('activity', f.config, moved);
  for (const event of EVENTS) {
    const hooks = settings.hooks[event].flatMap(group => group.hooks);
    assert.equal(hooks.filter(hook => hook.command === oldCommand).length, 0);
    assert.equal(hooks.filter(hook => hook.command === newCommand).length, 1);
  }
  await disconnectIntegration(moved);
  assert.deepEqual(await f.read(), initial);
});

test('repair preserves user edits to the installed status line', async t => {
  const f = await fixture(t);
  await connectIntegration(f.options);
  const edited = await f.read();
  edited.statusLine.padding = 8;
  await fs.writeFile(path.join(f.config, 'settings.json'), JSON.stringify(edited));
  const moved = { ...f.options, executablePath: path.join(f.home, 'moved', 'electron') };
  await assert.rejects(connectIntegration(moved), /edited after setup/);
  assert.deepEqual(await f.read(), edited);
});

test('configured telemetry reports actual receipt, field availability, and staleness without payloads', async t => {
  const f = await fixture(t);
  const connected = await connectIntegration(f.options);
  assert.equal(connected.installed, true);
  assert.deepEqual(connected.telemetry, { updatedAt: null, hasLimits: false, hasContext: false, stale: false });
  const now = Date.now();
  await runClaudeWorker(['usage', '--config', f.config], { now, stdin: Readable.from([JSON.stringify({ session_id: 'private-session', prompt: 'private prompt', rate_limits: { five_hour: { used_percentage: 0 } }, context_window: { used_percentage: 0 } })]), stdout: output().stream });
  const fresh = await getIntegrationStatus({ ...f.options, now });
  assert.deepEqual(fresh.telemetry, { updatedAt: new Date(now).toISOString(), hasLimits: true, hasContext: true, stale: false });
  assert.equal(JSON.stringify(fresh).includes('private-session'), false);
  assert.equal(JSON.stringify(fresh).includes('private prompt'), false);
  assert.equal((await getIntegrationStatus({ ...f.options, now: now + 300001 })).telemetry.stale, true);
  await runClaudeWorker(['usage', '--config', f.config], { now, stdin: Readable.from(['{}']), stdout: output().stream });
  assert.deepEqual((await getIntegrationStatus({ ...f.options, now })).telemetry, { updatedAt: new Date(now).toISOString(), hasLimits: false, hasContext: false, stale: false });
  const capture = path.join(f.config, 'statusline-usage', 'latest.json');
  await fs.writeFile(capture, JSON.stringify({ schemaVersion: 1, limits: [], updatedAt: new Date(now + 120000).toISOString() }));
  assert.equal((await getIntegrationStatus({ ...f.options, now })).telemetry.updatedAt, null);
  await fs.writeFile(capture, '{invalid');
  assert.equal((await getIntegrationStatus(f.options)).telemetry.updatedAt, null);
});

test('macOS translocated app cannot install temporary worker commands', async t => {
  const f = await fixture(t, { keep: true });
  const options = { ...f.options, platform: 'darwin', executablePath: '/private/var/folders/test/AppTranslocation/random/d/AgentGlance.app/Contents/MacOS/AgentGlance' };
  const status = await getIntegrationStatus(options);
  assert.equal(status.canConnect, false);
  assert.match(status.reason, /Applications/);
  await assert.rejects(connectIntegration(options), /temporary macOS location/);
  assert.deepEqual(await f.read(), { keep: true });
});

test('signed-out and portable installs do not change settings or create manifests', async t => {
  const f = await fixture(t, { keep: true }, false);
  assert.equal((await getIntegrationStatus(f.options)).signedIn, false);
  await assert.rejects(connectIntegration(f.options), /Sign in/);
  await fs.writeFile(path.join(f.config, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } }));
  await assert.rejects(connectIntegration({ ...f.options, portable: true }), /stable application location/);
  assert.deepEqual(await f.read(), { keep: true });
  await assert.rejects(fs.access(path.join(f.config, 'statusline-integration')));
});

test('keychain-only authentication is accepted through an injected safe CLI probe', async t => {
  const f = await fixture(t, {}, false);
  const status = await connectIntegration({ ...f.options, probeAuth: async provider => provider === 'claude' ? { source: 'CLI sign-in', note: 'Authenticated' } : null });
  assert.equal(status.installed, true);
});

test('a working legacy installation is reported and left byte-for-byte unchanged', async t => {
  const command = 'node legacy-bridge.cjs';
  const activity = 'node legacy-activity.cjs';
  const initial = { statusLine: { type: 'command', command }, hooks: Object.fromEntries(EVENTS.map(event => [event, [{ hooks: [{ type: 'command', command: activity }] }]])) };
  const f = await fixture(t, initial);
  for (const directory of ['statusline-usage', 'statusline-activity']) await fs.mkdir(path.join(f.config, directory));
  await fs.writeFile(path.join(f.config, 'statusline-usage', 'manifest.json'), JSON.stringify({ installedCommand: command }));
  await fs.writeFile(path.join(f.config, 'statusline-activity', 'manifest.json'), JSON.stringify({ command: activity }));
  const original = await fs.readFile(path.join(f.config, 'settings.json'), 'utf8');
  const status = await connectIntegration(f.options);
  assert.equal(status.legacy, true);
  assert.equal(status.installed, true);
  assert.equal(await fs.readFile(path.join(f.config, 'settings.json'), 'utf8'), original);
  assert.equal((await getIntegrationStatus({ ...f.options, portable: true })).installed, true);
});

test('disconnect preserves a user-replaced status line and refuses to overwrite in-place edits', async t => {
  const f = await fixture(t);
  await connectIntegration(f.options);
  const edited = await f.read();
  edited.statusLine.padding = 9;
  await fs.writeFile(path.join(f.config, 'settings.json'), JSON.stringify(edited));
  await assert.rejects(disconnectIntegration(f.options), /edited after setup/);
  edited.statusLine = { type: 'command', command: 'my-new-command' };
  await fs.writeFile(path.join(f.config, 'settings.json'), JSON.stringify(edited));
  await disconnectIntegration(f.options);
  assert.deepEqual((await f.read()).statusLine, edited.statusLine);
});

test('commands quote paths on macOS/Linux/Windows, support development, reject unsafe Windows expansion', () => {
  assert.equal(quoteArgument("/home/some one's app", 'linux'), "'/home/some one'\"'\"'s app'");
  const win = workerCommand('usage', 'C:\\Users\\Some User\\.claude', { platform: 'win32', env: {}, executablePath: 'C:\\Program Files\\Statusline.exe', workerPath: 'C:\\Program Files\\resources\\app.asar\\electron\\claude-worker.cjs', isPackaged: true });
  assert.match(win, /^powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand /);
  const decoded = Buffer.from(win.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decoded, /\$env:ELECTRON_RUN_AS_NODE='1'/);
  assert.match(decoded, /; & 'C:\\Program Files\\Statusline.exe'/);
  assert.match(decoded, /'C:\\Program Files\\resources\\app.asar\\electron\\claude-worker.cjs' 'usage'/);
  assert.match(decoded, /'--config' 'C:\\Users\\Some User\\.claude'; exit \$LASTEXITCODE$/);
  const mac = workerCommand('activity', '/Users/a/.claude', { platform: 'darwin', env: {}, executablePath: '/Applications/Statusline.app/Contents/MacOS/Statusline', workerPath: '/Applications/Statusline.app/Contents/Resources/app.asar/electron/claude-worker.cjs', isPackaged: true });
  assert.match(mac, /^env ELECTRON_RUN_AS_NODE=1 /);
  assert.match(mac, /claude-worker\.cjs' 'activity'/);
  assert.match(workerCommand('usage', '/tmp/claude', { platform: 'linux', env: {}, executablePath: '/tmp/electron', isPackaged: false, appPath: '/src/my app' }), /'\/src\/my app\/electron\/claude-worker.cjs'/);
  assert.throws(() => workerCommand('usage', '/tmp/claude', { platform: 'linux', env: {}, executablePath: '/tmp/app', isPackaged: true }), /worker path/i);
  assert.throws(() => quoteArgument('C:\\Users\\%USER%\\App.exe', 'win32'), /manual/);
});

function output() { let text = ''; return { stream: new Writable({ write(chunk, encoding, callback) { text += chunk.toString(); callback(); } }), read: () => text }; }

test('worker caches sanitized context and preserves prior shell output without external runtime dependency', async t => {
  const f = await fixture(t, { statusLine: { type: 'command', command: 'echo preserved-output' } });
  await connectIntegration(f.options);
  const stdout = output();
  await runClaudeWorker(['--statusline-claude-worker', 'usage', '--config', f.config], { stdin: Readable.from([JSON.stringify({ session_id: 'test-session', secret: 'must-not-escape', prompt: 'private prompt', context_window: { context_window_size: 100000, used_percentage: 25, current_usage: { input_tokens: 25000 } } })]), stdout: stdout.stream, stderr: output().stream });
  assert.match(stdout.read(), /preserved-output/);
  const cached = await fs.readFile(path.join(f.config, 'statusline-usage', 'latest.json'), 'utf8');
  assert.equal(JSON.parse(cached).context.usedPercent, 25);
  assert(!cached.includes('must-not-escape'));
  assert(!cached.includes('private prompt'));
  const names = await fs.readdir(path.join(f.config, 'statusline-usage', 'sessions'));
  assert.equal(names.length, 1);
});

test('activity worker remains silent and records sanitized event state', async t => {
  const f = await fixture(t);
  await connectIntegration(f.options);
  const stdout = output();
  const now = Date.now();
  await runClaudeWorker(['activity', '--config', f.config], { now, stdin: Readable.from([JSON.stringify({ session_id: 'test-session', hook_event_name: 'PermissionRequest', prompt: 'private prompt' })]), stdout: stdout.stream });
  assert.equal(stdout.read(), '');
  const files = (await fs.readdir(path.join(f.config, 'statusline-activity'))).filter(name => name.endsWith('.json'));
  const record = JSON.parse(await fs.readFile(path.join(f.config, 'statusline-activity', files[0]), 'utf8'));
  assert.equal(record.state, 'waiting');
  assert.equal(record.prompt, undefined);
  assert.equal(record.updatedAt, new Date(now).toISOString());
});

test('Windows command invokes the actual Electron runtime through PowerShell and preserves worker stdin', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const options = { ...f.options, executablePath: require('electron'), isPackaged: false, appPath: path.resolve(__dirname, '..') };
  await connectIntegration(options);
  const command = workerCommand('usage', f.config, options);
  const result = await new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ stdout, stderr, code }));
    child.stdin.end(JSON.stringify({ context_window: { context_window_size: 100000, used_percentage: 31 } }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'Context 31%');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.config, 'statusline-usage', 'latest.json'), 'utf8')).context.usedPercent, 31);
});

test('real Electron run-as-Node reads stdin without launching the GUI', async t => {
  const f = await fixture(t);
  await connectIntegration(f.options);
  const result = await electronWorker(path.resolve(__dirname, '../electron/claude-worker.cjs'), f.config);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'Context 37%');
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.config, 'statusline-usage', 'latest.json'), 'utf8')).context.usedPercent, 37);
});

test('real Electron run-as-Node loads the packaged ASAR worker', async t => {
  const archive = path.resolve(__dirname, '../release/win-unpacked/resources/app.asar');
  try { await fs.access(archive); } catch { t.skip('No Windows packaging artifact exists in this checkout'); return; }
  const f = await fixture(t);
  await connectIntegration(f.options);
  const result = await electronWorker(path.join(archive, 'electron', 'claude-worker.cjs'), f.config);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'Context 37%');
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.config, 'statusline-usage', 'latest.json'), 'utf8')).context.usedPercent, 37);
});

function electronWorker(workerPath, config) {
  return new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn(require('electron'), [workerPath, 'usage', '--config', config], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ stdout, stderr, code }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ context_window: { context_window_size: 100000, used_percentage: 37 } }));
  });
}
