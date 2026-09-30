'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getSnapshot, processProvider, scanProcesses } = require('../electron/providers.cjs');
const NOW = Date.UTC(2026, 8, 29);

async function fixture(t, files = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'statusline-provider-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(home, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return { home, env: {}, now: NOW, processes: [] };
}

test('only positive credential evidence appears, never mere configs or running processes', async t => {
  const options = await fixture(t, {
    '.codex/config.toml': 'model = "test"',
    '.claude/.credentials.json': { mcpOAuth: { server: { accessToken: 'mcp-secret' } } },
    '.kimi/config.toml': 'model = "kimi"',
    '.gemini/oauth_creds.json': { account: 'someone@example.test' },
    '.local/share/opencode/auth.json': { empty: { type: 'api', key: '' } },
  });
  options.processes = [{ name: 'codex.exe', pid: 890123 }];
  assert.deepEqual((await getSnapshot(options)).providers, []);
});

test('all supported credentials produce sanitized idle cards', async t => {
  const secret = 'private-token-must-never-escape';
  const options = await fixture(t, {
    '.codex/auth.json': { tokens: { access_token: secret, refresh_token: secret } },
    '.claude/.credentials.json': { claudeAiOauth: { accessToken: secret, expiresAt: NOW + 60000 } },
    '.kimi/credentials/kimi-code.json': { access_token: secret, expires_at: (NOW + 60000) / 1000 },
    '.gemini/oauth_creds.json': { refresh_token: secret },
    '.local/share/opencode/auth.json': { anthropic: { type: 'oauth', access: secret, refresh: secret, expires: NOW + 60000 } },
  });
  const snapshot = await getSnapshot(options);
  assert.deepEqual(snapshot.providers.map(p => p.id), ['codex', 'claude', 'kimi', 'gemini', 'opencode']);
  assert(snapshot.providers.every(p => p.status === 'idle' && p.lastActivityAt === null && p.processCount === 0));
  assert(!JSON.stringify(snapshot).includes(secret));
  assert(!JSON.stringify(snapshot).includes(options.home));
  assert.equal(snapshot.checkedAt, new Date(NOW).toISOString());
});

test('expired credentials without a refresh credential are hidden', async t => {
  const options = await fixture(t, {
    '.claude/.credentials.json': { claudeAiOauth: { accessToken: 'expired', refreshToken: 'also-expired', expiresAt: NOW - 1, refreshTokenExpiresAt: NOW - 1 } },
    '.gemini/oauth_creds.json': { access_token: 'expired', expiry_date: NOW - 1 },
    '.kimi/credentials/kimi-code.json': { access_token: 'expired', expires_at: NOW / 1000 - 1 },
  });
  assert.deepEqual((await getSnapshot(options)).providers, []);
});

test('expired access with usable refresh is disclosed without refreshing', async t => {
  const options = await fixture(t, {
    '.claude/.credentials.json': { claudeAiOauth: { accessToken: 'expired', refreshToken: 'can-refresh', expiresAt: NOW - 1 } },
  });
  const [provider] = (await getSnapshot(options)).providers;
  assert.match(provider.detail, /Access token expired; a refresh credential is present/);
  assert.equal(provider.status, 'idle');
});

test('API credential is labeled separately from account sign-in', async t => {
  const options = await fixture(t, {
    '.codex/auth.json': { OPENAI_API_KEY: 'local-api-key' },
    '.local/share/opencode/auth.json': { openai: { type: 'api', key: 'local-key' } },
  });
  assert((await getSnapshot(options)).providers.every(p => p.authSource === 'Local API credential'));
});

test('malformed and oversized credentials fail closed', async t => {
  const options = await fixture(t, {
    '.codex/auth.json': '{ invalid',
    '.claude/.credentials.json': { claudeAiOauth: { accessToken: 'x'.repeat(300000) } },
    '.gemini/oauth_creds.json': 'null',
  });
  assert.deepEqual((await getSnapshot(options)).providers, []);
});

test('custom credential homes and Kimi Code directory are supported', async t => {
  const options = await fixture(t, {
    'custom/auth.json': { tokens: { access_token: 'example' } },
    '.kimi-code/credentials/kimi-code.json': { access_token: 'example' },
  });
  options.env.CODEX_HOME = path.join(options.home, 'custom');
  assert.deepEqual((await getSnapshot(options)).providers.map(p => p.id), ['codex', 'kimi']);
});

test('running process count and failed scan semantics are honest', async t => {
  const options = await fixture(t, { '.codex/auth.json': { tokens: { access_token: 'example' } } });
  options.processes = [{ Name: 'codex.exe', ProcessId: 890122 }, { Name: 'codex.exe', ProcessId: 890123 }];
  const [running] = (await getSnapshot(options)).providers;
  assert.equal(running.status, 'running');
  assert.equal(running.processCount, 2);
  assert.match(running.detail, /does not indicate active generation/);
  options.processes = null;
  assert.equal((await getSnapshot(options)).providers[0].status, 'unknown');
});

test('process matching ignores prompts, wrappers, electron children and own pid', () => {
  const matches = [
    [{ name: 'codex.exe', pid: 890123 }, 'codex'],
    [{ name: 'node.exe', command: '"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"' }, 'claude'],
    [{ name: 'python.exe', command: 'python.exe -m kimi_cli' }, 'kimi'],
    [{ name: 'node', command: 'node /npm/@openai/codex/bin/codex.js' }, 'codex'],
    [{ name: 'node', command: 'node /npm/@google/gemini-cli/dist/index.js' }, 'gemini'],
    [{ name: 'node.exe', command: 'node.exe app.js "fix @openai/codex/bin/codex.js"' }, null],
    [{ name: 'powershell.exe', command: 'powershell.exe -Command codex' }, null],
    [{ name: 'my-codex.exe', command: 'my-codex.exe' }, null],
    [{ name: 'codex.exe', command: 'codex.exe --type=renderer' }, null],
    [{ name: 'codex.exe', pid: process.pid }, null],
    [{ name: 'electron.exe', command: 'electron.exe D:/codex/statusline' }, null],
  ];
  for (const [input, expected] of matches) assert.equal(processProvider(input), expected, JSON.stringify(input));
});

test('POSIX runtime flags are parsed conservatively before matching known CLI entry points', () => {
  assert.equal(processProvider({name:'node',command:'node --no-warnings --max-old-space-size=8192 /usr/lib/node_modules/@openai/codex/bin/codex.js'}), 'codex');
  assert.equal(processProvider({name:'node',command:'node --require /tmp/setup.js /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'}), 'claude');
  assert.equal(processProvider({name:'node',command:'node -e "require(\"@openai/codex/bin/codex.js\")"'}), null);
  assert.equal(processProvider({name:'python3.13',command:'python3.13 -u -m kimi_cli'}), 'kimi');
  assert.equal(processProvider({name:'node',argv:['node','/Users/Some Person/npm/@google/gemini-cli/dist/index.js']}), 'gemini');
  assert.equal(processProvider({name:'node',command:'node --max-old-space-size 8192 /usr/local/bin/codex'}), 'codex');
  assert.equal(processProvider({name:'node',command:'node /home/user/.nvm/versions/node/v22.5.0/bin/gemini'}), 'gemini');
  assert.equal(processProvider({name:'node',command:'node /home/user/project/bin/codex'}), null);
});

test('macOS process table joins PID columns without splitting paths containing spaces', async () => {
  const processes = await scanProcesses('darwin', async (command,args) => {
    assert.equal(command, '/bin/ps');
    return { stdout: args.at(-1) === 'pid=,comm=' ? ' 11 /Applications/Claude Code.app/Contents/MacOS/claude\n 12 /usr/local/bin/node\n' : ' 11 /Applications/Claude Code.app/Contents/MacOS/claude\n 12 node --no-warnings /usr/lib/@openai/codex/bin/codex.js\n' };
  });
  assert.deepEqual(processes.map(processProvider), ['claude','codex']);
  assert.equal(processes[0].pid, 11);
});

test('credential-store-only sign-ins are included via sanitized CLI evidence on macOS and Linux', async t => {
  const options = await fixture(t);
  for (const platform of ['darwin','linux']) {
    const result = await getSnapshot({ ...options, platform, probeAuth:async (id, config) => {
      assert.equal(config.platform, platform);
      return id === 'claude' ? {source:'CLI sign-in',note:'Local authenticated account.'} : null;
    } });
    assert.deepEqual(result.providers.map(p => p.id), ['claude']);
    assert.equal(result.providers[0].authSource, 'CLI sign-in');
  }
});

test('Linux procfs argument boundaries identify packages installed under home directories with spaces', async () => {
  const rows = await scanProcesses('linux', async (_command,args) => ({ stdout:args.at(-1) === 'pid=,comm=' ? '23 node\n' : '23 node /home/A Person/lib/@openai/codex/bin/codex.js\n' }), async pid => {
    assert.equal(pid, 23);
    return ['node','/home/A Person/lib/@openai/codex/bin/codex.js','PRIVATE PROMPT'];
  });
  assert.equal(processProvider(rows[0]), 'codex');
});

test('Qwen configured model credential is sanitized and attributed only to its actual CLI', async t => {
  const secret = 'qwen-private-key';
  const options = await fixture(t, {
    '.qwen/settings.json': {
      security:{auth:{selectedType:'openai'}}, model:{name:'qwen3-coder-plus'},
      modelProviders:{openai:[{id:'qwen3-coder-plus',envKey:'QWEN_TEST_KEY'}]},
      env:{QWEN_TEST_KEY:secret},
    },
  });
  for (const platform of ['win32','darwin','linux']) {
    options.platform = platform;
    options.processes = [{name:'node',argv:['node','/home/A Person/lib/@qwen-code/qwen-code/scripts/cli-entry.js']}];
    const snapshot = await getSnapshot(options);
    assert.deepEqual(snapshot.providers.map(p => p.id), ['qwen']);
    assert.equal(snapshot.providers[0].processCount, 1);
    assert.equal(snapshot.providers[0].status, 'running');
    assert.equal(snapshot.providers[0].activity.state, 'unknown');
    assert.deepEqual(snapshot.providers[0].tasks, []);
    assert(!JSON.stringify(snapshot).includes(secret));
    assert(!JSON.stringify(snapshot).includes(options.home));
  }
  options.env.QWEN_TEST_KEY = ''; // Environment overrides settings, including an empty value.
  assert.deepEqual((await getSnapshot(options)).providers, []);
  options.env.QWEN_TEST_KEY = 'environment-key';
  assert.equal((await getSnapshot(options)).providers[0].id, 'qwen');
});

test('Qwen config-only, inactive-model credentials and discontinued OAuth-only cache do not prove configured API auth', async t => {
  const options = await fixture(t, {
    '.qwen/oauth_creds.json': {access_token:'cached-legacy',refresh_token:'legacy-refresh',expiry_date:NOW+60000},
    '.qwen/settings.json': {
      security:{auth:{selectedType:'openai'}}, model:{name:'missing-credential-model'},
      modelProviders:{openai:[{id:'other-model',envKey:'QWEN_TEST_KEY'}]}, env:{QWEN_TEST_KEY:'other-key'},
    },
  });
  assert.deepEqual((await getSnapshot(options)).providers, []);
  await fs.writeFile(path.join(options.home,'.qwen/settings.json'), JSON.stringify({security:{auth:{selectedType:'openai',apiKey:'legacy-api-key'}}}));
  assert.equal((await getSnapshot(options)).providers[0].id, 'qwen');
  await fs.writeFile(path.join(options.home,'.qwen/settings.json'), JSON.stringify({security:{auth:{selectedType:'qwen-oauth',apiKey:'unused-key'}}}));
  assert.deepEqual((await getSnapshot(options)).providers, []);
});

test('OpenCode GLM and DeepSeek cards retain unknown shared-CLI attribution', async t => {
  const options = await fixture(t, {
    '.local/share/opencode/auth.json': {deepseek:{type:'api',key:'private-deepseek'},'zai-coding-plan':{type:'api',key:'private-glm'}},
    '.claude/.credentials.json': {claudeAiOauth:{accessToken:'private-claude'}},
  });
  options.processes = [{name:'claude.exe',pid:890100},{name:'opencode.exe',pid:890101}];
  const snapshot = await getSnapshot(options);
  assert.deepEqual(snapshot.providers.map(p=>p.id), ['claude','opencode','glm','deepseek']);
  for (const provider of snapshot.providers.filter(p => ['glm','deepseek'].includes(p.id))) {
    assert.equal(provider.status, 'unknown');
    assert.equal(provider.processCount, 0);
    assert.equal(provider.activity.state, 'unknown');
    assert.equal(provider.authSource, 'OpenCode provider credential');
    assert.match(provider.detail, /cannot be attributed/);
    assert.deepEqual(provider.tasks, []);
  }
  assert(!JSON.stringify(snapshot).includes('private-'));
});

test('all documented OpenCode GLM provider IDs and custom XDG data homes are supported', async t => {
  const options = await fixture(t);
  options.env.XDG_DATA_HOME = path.join(options.home,'custom-data');
  const directory = path.join(options.env.XDG_DATA_HOME,'opencode');
  await fs.mkdir(directory,{recursive:true});
  for (const id of ['zai','zai-coding-plan','zhipuai','zhipuai-coding-plan']) {
    await fs.writeFile(path.join(directory,'auth.json'), JSON.stringify({[id]:{type:'api',key:'local-key'}}));
    assert.deepEqual((await getSnapshot(options)).providers.map(p=>p.id), ['opencode','glm']);
  }
});

test('official Claude-compatible endpoints require credentials and reject spoofed hosts', async t => {
  const options = await fixture(t, {'.claude/settings.json':{env:{ANTHROPIC_BASE_URL:'https://api.z.ai/api/anthropic',ANTHROPIC_AUTH_TOKEN:'private-glm-token'}}});
  options.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic/';
  options.env.ANTHROPIC_AUTH_TOKEN = 'private-deepseek-token';
  const snapshot = await getSnapshot(options);
  assert.deepEqual(snapshot.providers.map(p=>p.id), ['glm','deepseek']);
  assert(snapshot.providers.every(p=>p.status==='unknown' && p.authSource==='Claude Code provider credential'));
  assert(!JSON.stringify(snapshot).includes('private-'));
  await fs.writeFile(path.join(options.home,'.claude/settings.json'), '{}');
  for (const endpoint of ['https://api.deepseek.com.evil.test/anthropic','https://api.deepseek.com@evil.test/anthropic','http://api.deepseek.com/anthropic','https://api.deepseek.com/v1','https://api.z.ai/api/anthropic?host=evil','https://api.deepseek.com:8443/anthropic']) {
    options.env.ANTHROPIC_BASE_URL = endpoint;
    assert.deepEqual((await getSnapshot(options)).providers, [], endpoint);
  }
  options.env.ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic';
  options.env.ANTHROPIC_AUTH_TOKEN='';
  assert.deepEqual((await getSnapshot(options)).providers, []);
});

test('Qwen native and npm launchers match; invented model-provider CLIs and prompt strings do not', () => {
  for (const row of [{name:'qwen.exe'}, {name:'qwen'}, {name:'node',command:'node /opt/homebrew/bin/qwen'}, {name:'node',command:'node /npm/@qwen-code/qwen-code/scripts/cli-entry.js'}, {name:'node',command:'node --expose-gc /npm/@qwen-code/qwen-code/dist/cli.js'}]) assert.equal(processProvider(row),'qwen');
  for (const row of [{name:'glm.exe'}, {name:'deepseek'}, {name:'node',command:'node app.js /npm/@qwen-code/qwen-code/scripts/cli-entry.js'}, {name:'node',command:'node /myproject/bin/qwen'}]) assert.equal(processProvider(row),null);
});

test('Qwen custom home is respected and unresolved environment templates are not credentials', async t => {
  const options = await fixture(t, {'custom-qwen/settings.json':{security:{auth:{selectedType:'openai',apiKey:'${MISSING_KEY}'}}}});
  options.env.QWEN_HOME = '~/custom-qwen';
  assert.deepEqual((await getSnapshot(options)).providers, []);
  await fs.writeFile(path.join(options.home,'custom-qwen/settings.json'), JSON.stringify({security:{auth:{selectedType:'openai',apiKey:'configured-key'}}}));
  assert.deepEqual((await getSnapshot(options)).providers.map(p=>p.id), ['qwen']);
});
