'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cliEnvironment, resolveCli, probeCliAuth } = require('../electron/platform-runtime.cjs');
const noDirs = async () => [];

test('macOS GUI PATH finds Homebrew and native user CLIs without running a shell', async () => {
  const options = { platform:'darwin', home:'/Users/A Person', env:{ PATH:'/usr/bin:/bin' }, readdir:noDirs, isExecutable:async filename => filename === '/opt/homebrew/bin/codex' || filename === '/Users/A Person/.local/bin/claude' };
  assert.equal((await resolveCli('codex', options)).command, '/opt/homebrew/bin/codex');
  assert.equal((await resolveCli('claude', options)).command, '/Users/A Person/.local/bin/claude');
  assert((await cliEnvironment(options)).PATH.includes('/Users/A Person/.local/bin'));
});

test('Linux GUI launch discovers nvm Node and passes its bin directory to shebang CLIs', async () => {
  const options = { platform:'linux', home:'/home/alice', env:{ PATH:'/usr/bin' }, readdir:async () => ['v20.1.0','v22.5.0'].map(name => ({ name, isDirectory:() => true })), isExecutable:async filename => filename === '/home/alice/.nvm/versions/node/v22.5.0/bin/codex' };
  const cli = await resolveCli('codex', options);
  assert.equal(cli.command, '/home/alice/.nvm/versions/node/v22.5.0/bin/codex');
  assert(cli.env.PATH.includes('/home/alice/.nvm/versions/node/v22.5.0/bin'));
  assert(!cli.env.PATH.includes(';'));
});

test('macOS desktop-bundled Codex resolves without a separately installed shell CLI', async () => {
  const result = await resolveCli('codex', { platform:'darwin', home:'/Users/test', env:{ PATH:'/usr/bin' }, readdir:noDirs, isExecutable:async filename => filename === '/Applications/Codex.app/Contents/Resources/codex' });
  assert.equal(result.command, '/Applications/Codex.app/Contents/Resources/codex');
});

test('Windows paths derive from the current user and npm shims use structured Node invocation', async () => {
  const home = 'C:\\Users\\Other User';
  const native = 'C:\\Users\\Other User\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe';
  const options = { platform:'win32', home, env:{ Path:'C:\\Tools' }, isExecutable:async filename => filename === native };
  assert.equal((await resolveCli('codex', options)).command, native);
  const script = 'C:\\Users\\Other User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
  const npm = await resolveCli('codex', { ...options, isExecutable:async filename => filename === script || filename === 'C:\\Tools\\node.exe' });
  assert.equal(npm.command, 'C:\\Tools\\node.exe');
  assert.deepEqual(npm.args, [script]);
  assert(npm.env.Path.includes(';'));
});

test('macOS Keychain detection delegates to official auth status and returns no credential or account fields', async () => {
  const result = await probeCliAuth('claude', { platform:'darwin', home:'/Users/test', env:{ CLAUDE_CONFIG_DIR:'/Users/test/custom' }, readdir:noDirs, isExecutable:async () => false, run:async (command,args,options) => {
    assert.equal(command, 'claude');
    assert.deepEqual(args, ['auth','status','--json']);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, '/Users/test/custom');
    assert.equal(options.timeout, 6000);
    assert.equal(options.windowsHide, true);
    return { stdout:JSON.stringify({ loggedIn:true, authMethod:'claude.ai', email:'SECRET_EMAIL', accessToken:'SECRET_TOKEN' }) };
  } });
  assert.equal(result.source, 'CLI sign-in');
  assert(!JSON.stringify(result).includes('SECRET'));
});

test('Codex keyring status is reduced to evidence; failures and logged-out states never leak stderr', async () => {
  const options = { platform:'linux', home:'/home/test', env:{}, readdir:noDirs, isExecutable:async () => false };
  const yes = await probeCliAuth('codex', { ...options, run:async (command,args) => { assert.deepEqual(args,['login','status']); return { stdout:'', stderr:'Logged in using ChatGPT\n' }; } });
  assert.equal(yes.source, 'CLI sign-in');
  assert.equal(await probeCliAuth('codex', { ...options, run:async () => ({ stderr:'Not logged in' }) }), null);
  assert.equal(await probeCliAuth('claude', { ...options, run:async () => { throw new Error('SECRET_TOKEN'); } }), null);
});
