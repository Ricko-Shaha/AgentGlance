'use strict';

// Credentials are reduced to sign-in evidence. Usage readers return only
// numeric telemetry; raw credentials and conversation content never reach IPC.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { probeCliAuth } = require('./platform-runtime.cjs');
const MAX_CREDENTIAL_BYTES = 256 * 1024;
const DEFINITIONS = [
  ['codex', 'Codex', 'OpenAI'], ['claude', 'Claude', 'Anthropic'],
  ['kimi', 'Kimi', 'Moonshot AI'], ['gemini', 'Gemini', 'Google'],
  ['opencode', 'OpenCode', 'Connected providers'],
  ['qwen', 'Qwen', 'Qwen Code'], ['glm', 'GLM', 'Z.ai'],
  ['deepseek', 'DeepSeek', 'DeepSeek'],
];
const present = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

async function readJson(filename) {
  let handle;
  try {
    handle = await fs.open(filename, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) return null;
    // Fixed-size read prevents a growing file bypassing the size limit.
    const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > MAX_CREDENTIAL_BYTES) return null;
    const data = JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8').replace(/^\uFEFF/, ''));
    return object(data) ? data : null;
  } catch { return null; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e11 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function oauth(access, refresh, expires, now, refreshExpires) {
  const accessExpiry = timestamp(expires);
  const refreshExpiry = timestamp(refreshExpires);
  const usableRefresh = present(refresh) && (refreshExpiry === null || refreshExpiry > now);
  const usableAccess = present(access) && (accessExpiry === null || accessExpiry > now);
  if (!usableAccess && !usableRefresh) return null;
  return {
    source: 'Local sign-in',
    note: accessExpiry !== null && accessExpiry <= now
      ? 'Access token expired; a refresh credential is present. Sign-in has not been verified online.'
      : 'Local sign-in credentials found. Sign-in has not been verified online.',
  };
}

function codexAuth(data, now) {
  if (!data) return null;
  const tokens = data.tokens;
  if (object(tokens)) {
    const result = oauth(tokens.access_token, tokens.refresh_token, tokens.expires_at, now);
    if (result) return result;
  }
  return present(data.OPENAI_API_KEY) ? apiAuth() : null;
}
function apiAuth() { return { source: 'Local API credential', note: 'An API credential is configured locally; validity has not been verified online.' }; }
function claudeAuth(data, now) {
  const token = data?.claudeAiOauth;
  return object(token) ? oauth(token.accessToken, token.refreshToken, token.expiresAt, now, token.refreshTokenExpiresAt) : null;
}
function standardAuth(data, now) {
  return data ? oauth(data.access_token, data.refresh_token, data.expires_at ?? data.expiry_date, now) : null;
}
function opencodeAuth(data, now) {
  if (!data) return null;
  for (const entry of Object.values(data)) {
    if (!object(entry)) continue;
    if (entry.type === 'oauth') {
      const auth = oauth(entry.access, entry.refresh, entry.expires, now);
      if (auth) return auth;
    }
    if (entry.type === 'api' && present(entry.key) && entry.key !== 'opencode-oauth-dummy-key') return apiAuth();
  }
  return null;
}

// Shared model providers have no distinct executable to attribute safely.
const SHARED_PROVIDERS = new Set(['glm', 'deepseek']);
const configuredKey = value => present(value) && !/\$\{|\{env:/.test(value) && value !== 'opencode-oauth-dummy-key';
function configuredApi(source) { return { ...apiAuth(), source }; }
function qwenAuth(settings, env) {
  if (!object(settings)) return null;
  const auth = settings.security?.auth;
  // The upstream quickstart explicitly retires Qwen OAuth on April 15, 2026.
  // An old oauth_creds.json alone is not current API configuration evidence.
  if (auth?.selectedType === 'qwen-oauth') return null;
  if (configuredKey(auth?.apiKey)) return configuredApi('Qwen Code API credential');
  const selected = auth?.selectedType;
  const providers = settings.modelProviders;
  if (!present(selected) || !object(providers) || !Array.isArray(providers[selected])) return null;
  const allowed = ['openai', 'anthropic', 'gemini', 'vertex-ai'];
  if (!allowed.includes(selected) && !allowed.includes(settings.providerProtocol?.[selected])) return null;
  const model = settings.model?.name;
  for (const entry of providers[selected].slice(0, 128)) {
    if (!object(entry) || !present(entry.id) || (present(model) && entry.id !== model)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.envKey || '')) continue;
    const key = Object.hasOwn(env, entry.envKey) ? env[entry.envKey] : settings.env?.[entry.envKey];
    if (configuredKey(key)) return configuredApi('Qwen Code API credential');
  }
  return null;
}
function customClaudeProvider(config) {
  if (!object(config) || !configuredKey(config.ANTHROPIC_AUTH_TOKEN ?? config.ANTHROPIC_API_KEY)) return null;
  try {
    const url = new URL(config.ANTHROPIC_BASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
    const endpoint = url.pathname.replace(/\/$/, '');
    if (url.hostname === 'api.z.ai' && endpoint === '/api/anthropic') return 'glm';
    if (url.hostname === 'api.deepseek.com' && endpoint === '/anthropic') return 'deepseek';
  } catch { /* Only exact official endpoints provide provider evidence. */ }
  return null;
}

async function findAuth(home, env, now, options = {}) {
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const kimiHome = env.KIMI_SHARE_DIR || path.join(home, '.kimi');
  const kimiCodeHome = env.KIMI_CODE_HOME || path.join(home, '.kimi-code');
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const qwenHome = !present(env.QWEN_HOME) ? path.join(home, '.qwen') : env.QWEN_HOME === '~' ? home : /^~[/\\]/.test(env.QWEN_HOME) ? path.join(home, env.QWEN_HOME.slice(2)) : env.QWEN_HOME;
  const candidates = [
    ['codex', path.join(codexHome, 'auth.json'), codexAuth],
    ['claude', path.join(claudeHome, '.credentials.json'), claudeAuth],
    ['kimi', path.join(kimiHome, 'credentials', 'kimi-code.json'), standardAuth],
    ['kimi', path.join(kimiCodeHome, 'credentials', 'kimi-code.json'), standardAuth],
    ['gemini', path.join(home, '.gemini', 'oauth_creds.json'), standardAuth],
    ['opencode', path.join(dataHome, 'opencode', 'auth.json'), opencodeAuth],
  ];
  // Newer Kimi Code names managed provider credential files dynamically.
  // Read only the credential directory itself, never its MCP subdirectory.
  try {
    const names = await fs.readdir(path.join(kimiCodeHome, 'credentials'), { withFileTypes: true });
    for (const name of names.slice(0, 32)) {
      if (name.isFile() && /^(?:managed[-_:])?kimi[-_]code.*\.json$/i.test(name.name)) {
        candidates.push(['kimi', path.join(kimiCodeHome, 'credentials', name.name), standardAuth]);
      }
    }
  } catch { /* Not installed, no readable credentials, or keychain-only. */ }
  const found = await Promise.all(candidates.map(async ([id, filename, parser]) => [id, parser(await readJson(filename), now)]));
  const result = new Map();
  for (const [id, auth] of found) if (auth && !result.has(id)) result.set(id, auth);
  const [qwenSettings, claudeSettings, connectedAuth] = await Promise.all([
    readJson(path.join(qwenHome, 'settings.json')),
    readJson(path.join(claudeHome, 'settings.json')),
    readJson(path.join(dataHome, 'opencode', 'auth.json')),
  ]);
  const qwen = qwenAuth(qwenSettings, env);
  if (qwen) result.set('qwen', qwen);
  for (const config of [claudeSettings?.env, env]) {
    const id = customClaudeProvider(config);
    if (id) result.set(id, configuredApi('Claude Code provider credential'));
  }
  for (const [id, keys] of [
    ['glm', ['zai', 'zai-coding-plan', 'zhipuai', 'zhipuai-coding-plan']],
    ['deepseek', ['deepseek']],
  ]) {
    if (keys.some(key => connectedAuth?.[key]?.type === 'api' && configuredKey(connectedAuth[key].key))) {
      result.set(id, configuredApi('OpenCode provider credential'));
    }
  }
  // Credential-store-only installs have no auth.json. Ask the installed CLI
  // using its documented read-only status command, never a login/generation.
  if (!Object.hasOwn(options, 'processes') || options.probeAuth || options.allowAuthProbe === true) {
    await Promise.all(['codex', 'claude'].filter(id => !result.has(id)).map(async id => {
      const auth = await (options.probeAuth || probeCliAuth)(id, { home, env, now, platform:options.platform });
      if (auth) result.set(id, auth);
    }));
  }
  return result;
}

const basename = value => String(value || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
function processProvider(entry) {
  if (!entry || Number(entry.pid ?? entry.ProcessId) === process.pid) return null;
  const name = basename(entry.name ?? entry.Name ?? entry.executable ?? entry.ExecutablePath);
  const command = String(entry.command ?? entry.CommandLine ?? '');
  if (/\s--type(?:=|\s)/.test(command)) return null; // Electron/Chromium child processes.
  const native = { 'codex': 'codex', 'codex.exe': 'codex', 'claude': 'claude', 'claude.exe': 'claude', 'kimi': 'kimi', 'kimi.exe': 'kimi', 'kimi-code': 'kimi', 'kimi-code.exe': 'kimi', 'gemini': 'gemini', 'gemini.exe': 'gemini', 'opencode': 'opencode', 'opencode.exe': 'opencode', 'qwen': 'qwen', 'qwen.exe': 'qwen' };
  if (native[name]) return native[name];
  // Inspect only a runtime's entry point, not arbitrary user prompt arguments.
  if (!/^(?:node|nodejs|bun|python(?:3(?:\.\d+)?)?)(?:\.exe)?$/.test(name)) return null;
  const args = Array.isArray(entry.argv) ? entry.argv : command.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(token => token.replace(/^(["'])(.*)\1$/, '$2')) || [];
  let index = 1;
  while (index < args.length && args[index].startsWith('-')) {
    const flag = args[index];
    if (flag === '--') { index++; break; }
    if (['-e', '--eval', '-p', '--print', '-c'].includes(flag) || /^--(?:eval|print)=/.test(flag)) return null;
    if (/python/.test(name) && flag === '-m') return /^(kimi_cli|kimi_code)(?:\.__main__)?$/.test(args[index+1] || '') ? 'kimi' : null;
    if (['-r','--require','--import','--loader','--experimental-loader','--max-old-space-size','--stack-size'].includes(flag)) index += 2;
    else if (/^(?:--(?:no-warnings|enable-source-maps|expose-gc)|--(?:max-old-space-size|stack-size|inspect(?:-brk)?)=\S+|-[uBIOq])$/.test(flag)) index++;
    else return null; // Unknown option arity: do not match a prompt argument.
  }
  const script = (args[index] || '').replace(/\\/g, '/').toLowerCase();
  // npm/Python shebang launchers often retain the bin symlink in argv rather
  // than the package's real entry point. Match only recognized install roots.
  const wrapper = script.match(/(?:^\/(?:usr\/(?:local\/)?bin|opt\/homebrew\/bin)|\/(?:\.local|\.npm-global|\.bun|\.volta)\/bin|\/\.nvm\/versions\/node\/v[\d.]+\/bin)\/(codex|claude|gemini|opencode|kimi|qwen)$/);
  if (wrapper) return wrapper[1];
  if (/(?:^|\/)@openai\/codex\/bin\/codex\.js$/.test(script)) return 'codex';
  if (/(?:^|\/)@anthropic-ai\/claude-code\/cli\.js$/.test(script)) return 'claude';
  if (/(?:^|\/)@google\/gemini-cli\/(?:dist\/)?(?:index|bundle\/gemini)\.js$/.test(script)) return 'gemini';
  if (/(?:^|\/)opencode-ai\/bin\/opencode$/.test(script)) return 'opencode';
  if (/(?:^|\/)@qwen-code\/qwen-code\/(?:scripts\/cli-entry|(?:dist\/)?cli)\.js$/.test(script)) return 'qwen';
  if (/(?:^|\/)kimi(?:-code)?(?:\.exe)?$/.test(script) && /python/.test(name)) return 'kimi';
  return null;
}

async function procArgv(pid) {
  let file;
  try {
    file = await fs.open(`/proc/${pid}/cmdline`, 'r');
    const buffer = Buffer.alloc(32768);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (!bytesRead || bytesRead === buffer.length) return null;
    return buffer.subarray(0, bytesRead).toString('utf8').split('\0').filter(Boolean);
  } catch { return null; }
  finally { await file?.close().catch(() => {}); }
}

async function scanProcesses(platform = process.platform, execute = run, readArgv = procArgv) {
  if (platform === 'win32') {
    const script = "$ErrorActionPreference='Stop'; $names=@('codex.exe','claude.exe','kimi.exe','kimi-code.exe','gemini.exe','opencode.exe','qwen.exe','node.exe','nodejs.exe','bun.exe','python.exe','python3.exe','python3.12.exe','python3.13.exe','python3.14.exe'); $items=@(Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name } | Select-Object ProcessId,Name,CommandLine); ConvertTo-Json -InputObject $items -Compress";
    const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 7000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
    const parsed = JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  // Separate columns preserve executable paths containing spaces on macOS.
  const [names, commands] = await Promise.all(['pid=,comm=', 'pid=,args='].map(columns => execute('/bin/ps', ['-axww', '-o', columns], { timeout:5000, maxBuffer:2*1024*1024, encoding:'utf8' })));
  const parse = stdout => new Map(stdout.split('\n').flatMap(line => { const match = line.trim().match(/^(\d+)\s+(.+)$/); return match ? [[Number(match[1]), match[2]]] : []; }));
  const commandMap = parse(commands.stdout);
  const records = [...parse(names.stdout)].map(([pid, name]) => ({ pid, name, command:commandMap.get(pid) || '' }));
  if (platform === 'linux') {
    // procfs retains argument boundaries that `ps args` cannot represent when
    // an executable or package path contains spaces. Never return argv to IPC.
    await Promise.all(records.filter(row => /^(?:node|nodejs|bun|python(?:3(?:\.\d+)?)?)$/.test(basename(row.name))).slice(0, 256).map(async row => {
      const argv = await readArgv(row.pid);
      if (Array.isArray(argv)) row.argv = argv;
    }));
  }
  return records;
}

/** Test options are dependency injection, never IPC/user-controlled input. */
async function getSnapshot(options = {}) {
  const start = performance.now();
  const now = options.now ?? Date.now();
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const [authResult, processResult] = await Promise.allSettled([
    findAuth(home, env, now, options),
    Object.hasOwn(options, 'processes') ? Promise.resolve(options.processes) : scanProcesses(platform),
  ]);
  const auth = authResult.status === 'fulfilled' ? authResult.value : new Map();
  const processKnown = processResult.status === 'fulfilled' && Array.isArray(processResult.value);
  const counts = new Map();
  if (processKnown) for (const entry of processResult.value) {
    const id = processProvider(entry);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const providers = DEFINITIONS.filter(([id]) => auth.has(id)).map(([id, name, description]) => {
    const shared = SHARED_PROVIDERS.has(id);
    const processCount = shared ? 0 : counts.get(id) || 0;
    const status = shared || !processKnown ? 'unknown' : processCount ? 'running' : 'idle';
    const state = shared ? 'Configured through a shared CLI; processes and activity cannot be attributed to this provider.' : !processKnown ? 'Process status is unavailable.' : processCount ? 'A local process is running; this does not indicate active generation.' : 'No local process detected.';
    return { id, name, description, status, authSource: auth.get(id).source, processCount, lastActivityAt: null, detail: `${state} ${auth.get(id).note}` };
  });
  await Promise.all(providers.map(async (provider) => {
    provider.activity = {
      state: provider.status === 'idle' ? 'free' : 'unknown',
      detail: provider.status === 'idle' ? 'No assistant process is open; ready for a new session.' : 'Waiting for an observed activity event. An open process does not prove the assistant is busy.',
      updatedAt: new Date(now).toISOString(), source: 'Local process detection',
    };
    if (SHARED_PROVIDERS.has(provider.id)) provider.activity = {
      state:'unknown', detail:'Activity cannot be attributed to this model provider through its shared CLI.',
      updatedAt:null, source:'Shared CLI configuration',
    };
    if (provider.status !== 'running' || Object.hasOwn(options, 'processes')) return;
    try {
      if (provider.id === 'codex') provider.activity = await require('./codex-activity.cjs').readCodexActivity({ home, env, processCount: provider.processCount });
      else if (provider.id === 'claude') provider.activity = await require('./claude-activity.cjs').readClaudeActivity({ home, env, processCount: provider.processCount });
    } catch { /* An unavailable activity feed remains explicitly unknown. */ }
  }));
  await Promise.all(providers.map(async (provider) => {
    provider.tasks = [];
    if (Object.hasOwn(options, 'processes')) return;
    try {
      if (provider.id === 'codex') provider.tasks = await require('./codex-tasks.cjs').readCodexTasks({ home, env, now });
      else if (provider.id === 'claude') {
        const activePids = processKnown ? processResult.value.filter(entry => processProvider(entry) === 'claude').map(entry => Number(entry.pid ?? entry.ProcessId)).filter(Number.isInteger) : undefined;
        provider.tasks = await require('./claude-tasks.cjs').readClaudeTasks({ home, env, now, activePids });
      }
    } catch { /* Unavailable per-session metadata remains an empty task list. */ }
  }));
  if (options.includeUsage !== false && !Object.hasOwn(options, 'processes')) {
    await Promise.all(providers.map(async (provider) => {
      try {
        if (provider.id === 'codex') provider.usage = await require('./codex-usage.cjs').readCodexUsage({ home, env, platform });
        else if (provider.id === 'claude') provider.usage = await require('./claude-usage.cjs').readClaudeUsage({ home, env, platform });
        else provider.usage = { state: 'unavailable', limits: [], context: null, source: 'Not connected', updatedAt: null, message: `${provider.name} usage reporting is not available yet.`, stale: false };
      } catch {
        provider.usage = { state: 'unavailable', limits: [], context: null, source: 'Unavailable', updatedAt: null, message: 'Usage could not be read. Try refreshing after signing in.', stale: false };
      }
    }));
  }
  return { providers, checkedAt: new Date(now).toISOString(), scanDurationMs: Math.round(performance.now() - start), platform };
}

module.exports = { getSnapshot, processProvider, scanProcesses };
