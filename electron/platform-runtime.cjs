'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const authCache = new Map();

async function cliEnvironment(options = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const separator = platform === 'win32' ? ';' : ':';
  const dirs = [p.join(home, '.local', 'bin'), p.join(home, '.bun', 'bin'), p.join(home, '.volta', 'bin'), p.join(home, '.npm-global', 'bin')];
  if (platform === 'win32') {
    dirs.push(p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin'));
    dirs.push(p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'npm'));
    dirs.push(p.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', p.join(home, '.asdf', 'shims'), p.join(home, '.local', 'share', 'mise', 'shims'));
    const nvm = p.join(env.NVM_DIR || p.join(home, '.nvm'), 'versions', 'node');
    try {
      const versions = await (options.readdir || fs.readdir)(nvm, { withFileTypes: true });
      for (const entry of versions.filter(e => e.isDirectory() && /^v\d/.test(e.name)).sort((a,b) => b.name.localeCompare(a.name, undefined, { numeric:true })).slice(0, 4)) dirs.push(p.join(nvm, entry.name, 'bin'));
    } catch { /* No nvm install. */ }
  }
  const key = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  const paths = [...new Set([...(env[key] || '').split(separator), ...dirs].filter(value => value && p.isAbsolute(value)))];
  return { ...env, [key]: paths.join(separator) };
}

async function resolveCli(name, options = {}) {
  if (!['codex', 'claude', 'node'].includes(name)) throw new Error('Unsupported CLI');
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const p = platform === 'win32' ? path.win32 : path.posix;
  const env = await cliEnvironment(options);
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  const dirs = env[pathKey].split(platform === 'win32' ? ';' : ':');
  const exists = options.isExecutable || (async filename => { try { await fs.access(filename, platform === 'win32' ? constants.F_OK : constants.X_OK); return (await fs.stat(filename)).isFile(); } catch { return false; } });
  const executable = platform === 'win32' ? `${name}.exe` : name;
  for (const dir of dirs) {
    const candidate = p.join(dir, executable);
    if (await exists(candidate)) return { command:candidate, args:[], env };
  }
  if (platform === 'darwin' && name === 'codex') {
    // Official retained compatibility bundle path documented by OpenAI.
    for (const root of ['/Applications', p.join(home, 'Applications')]) {
      const candidate = p.join(root, 'Codex.app', 'Contents', 'Resources', 'codex');
      if (await exists(candidate)) return { command:candidate, args:[], env };
    }
  }
  // npm's Windows .cmd shims require a shell. Invoke their actual JS entry point
  // with Node instead, keeping arguments structured and shell-free.
  if (platform === 'win32' && name !== 'node') {
    const relative = name === 'codex' ? ['@openai', 'codex', 'bin', 'codex.js'] : ['@anthropic-ai', 'claude-code', 'cli.js'];
    const npmRoots = [...dirs.map(dir => p.join(dir, 'node_modules')), p.join(options.env?.APPDATA || p.join(home, 'AppData', 'Roaming'), 'npm', 'node_modules')];
    for (const root of npmRoots) {
      const script = p.join(root, ...relative);
      if (await exists(script)) {
        const node = await resolveCli('node', { ...options, env });
        return { command:node.command, args:[script], env:node.env };
      }
    }
  }
  return { command:executable, args:[], env };
}

// Official read-only status commands let each CLI access its own credential
// store, including macOS Keychain and Linux keyrings. Raw output never escapes.
async function probeCliAuth(name, options = {}) {
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const key = [name, options.platform ?? process.platform, options.home ?? os.homedir(), env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.PATH ?? env.Path].join('|');
  if (!options.run) {
    const cached = authCache.get(key);
    if (cached && now >= cached.at && now - cached.at < 60000) return cached.promise;
  }
  const promise = (async () => {
    try {
      const cli = await resolveCli(name, options);
      const args = name === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'];
      const output = await (options.run || run)(cli.command, [...cli.args, ...args], { env:cli.env, cwd:options.home ?? os.homedir(), windowsHide:true, timeout:6000, maxBuffer:65536, encoding:'utf8' });
      if (name === 'claude') {
        const status = JSON.parse(output.stdout);
        if (status.loggedIn !== true) return null;
        return { source:status.authMethod === 'api_key' ? 'CLI API credential' : 'CLI sign-in', note:'Claude reports authenticated. Account details and credentials stay local.' };
      }
      const text = `${output.stdout || ''}\n${output.stderr || ''}`;
      if (!/^Logged in using /im.test(text)) return null;
      return { source:/logged in using api key/i.test(text) ? 'CLI API credential' : 'CLI sign-in', note:'Codex reports authenticated. Account details and credentials stay local.' };
    } catch { return null; }
  })();
  if (!options.run) {
    if (authCache.size >= 32) authCache.delete(authCache.keys().next().value);
    authCache.set(key, { at:now, promise });
  }
  return promise;
}

module.exports = { cliEnvironment, resolveCli, probeCliAuth };
