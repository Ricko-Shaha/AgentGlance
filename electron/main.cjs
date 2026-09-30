'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getSnapshot } = require('./providers.cjs');
const { getIntegrationStatus, connectIntegration, disconnectIntegration } = require('./claude-integration.cjs');

// XWayland supplies the positioning and pinning APIs a floating widget needs.
const linux = process.platform === 'linux';
const nativeWayland = linux && Boolean(process.env.WAYLAND_DISPLAY) && !process.env.DISPLAY;
if (linux && process.env.DISPLAY) app.commandLine.appendSwitch('ozone-platform', 'x11');
const capabilities = Object.freeze({
  manualDrag: !nativeWayland,
  layouts: !nativeWayland,
  pin: !nativeWayland,
  message: nativeWayland ? 'This Wayland session uses a standard window. Move and resize it with your desktop controls. A floating, pinnable strip is available with XWayland.' : null,
});

app.setName('AgentGlance');
app.setAppUserModelId('app.agentglance.desktop');

const PROVIDER_URLS = Object.freeze({
  codex: 'https://chatgpt.com/codex',
  claude: 'https://claude.ai/',
  kimi: 'https://www.kimi.com/',
  gemini: 'https://gemini.google.com/',
  opencode: 'https://opencode.ai/',
  qwen: 'https://qwen.ai/',
  glm: 'https://z.ai/',
  deepseek: 'https://www.deepseek.com/',
});
const preferences = { compact: true, alwaysOnTop: true, layout: 'horizontal' };
let mainWindow;
let tray;
let quitting = false;
let refreshTimer;
let latestSnapshot;
let pendingSnapshot;
let preferencesPath;
let rendererUrl;
let windowDrag;
let taskContextOpen = false;
let detailsOpen = false;

function horizontalHeight() {
  return (taskContextOpen ? 292 : 44) + (detailsOpen ? 288 : 0);
}

function resizePanels() {
  if (nativeWayland || preferences.layout !== 'horizontal') return;
  mainWindow.setBounds(boundedSize({ ...mainWindow.getBounds(), height: horizontalHeight() }), true);
}

function dragPoint(value) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y) || Math.abs(value.x) > 1000000 || Math.abs(value.y) > 1000000) throw new TypeError('Invalid drag point');
  return { x: value.x, y: value.y };
}

function readPreferences() {
  preferencesPath = path.join(app.getPath('userData'), 'preferences.json');
  try {
    // Carry forward the old app's preferences on the first renamed launch.
    // Explicit test profiles remain isolated from a user's previous install.
    const source = !fs.existsSync(preferencesPath) && !app.commandLine.hasSwitch('user-data-dir')
      ? path.join(app.getPath('appData'), 'Statusline', 'preferences.json') : preferencesPath;
    const saved = JSON.parse(fs.readFileSync(source, 'utf8'));
    preferences.compact = true;
    preferences.alwaysOnTop = saved.alwaysOnTop === true;
    preferences.layout = saved.layout === 'vertical' ? 'vertical' : 'horizontal';
  } catch { /* The first launch uses defaults; malformed preferences are ignored. */ }
  if (nativeWayland) { preferences.layout = 'vertical'; preferences.alwaysOnTop = false; }
}

function savePreferences() {
  fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
  const temporaryPath = `${preferencesPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(preferences, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryPath, preferencesPath);
}

function appIcon() {
  const bundledIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  if (!bundledIcon.isEmpty()) return bundledIcon;
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const cornerX = Math.max(6 - x, x - 25, 0);
      const cornerY = Math.max(6 - y, y - 25, 0);
      if (cornerX * cornerX + cornerY * cornerY > 36) continue;
      const bar = (x >= 7 && x <= 10 && y >= 14 && y <= 24)
        || (x >= 14 && x <= 17 && y >= 7 && y <= 24)
        || (x >= 21 && x <= 24 && y >= 10 && y <= 24);
      pixels[offset] = bar ? 24 : 106;
      pixels[offset + 1] = bar ? 26 : 245;
      pixels[offset + 2] = bar ? 22 : 195;
      pixels[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

function boundedSize(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    width, height,
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
  };
}

function keepWindowInWorkArea() {
  if (nativeWayland || !mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  const current = mainWindow.getBounds();
  const next = boundedSize(current);
  if (['x', 'y', 'width', 'height'].some(key => current[key] !== next[key])) mainWindow.setBounds(next);
}

function finishWindowDrag() {
  const wasDragging = Boolean(windowDrag);
  windowDrag = undefined;
  // Keep movement free between displays; only settle inside the desktop on drop.
  // Topmost windows can still be obscured by the system taskbar or Dock.
  if (wasDragging) keepWindowInWorkArea();
}

function setCompact(value) {
  if (typeof value !== 'boolean') throw new TypeError('Compact must be a boolean');
  setLayout(value ? 'vertical' : 'horizontal');
}

function setLayout(value) {
  if (value !== 'vertical' && value !== 'horizontal') throw new TypeError('Unknown widget layout');
  if (nativeWayland) throw new Error('Layout is managed by your Wayland desktop.');
  const current = mainWindow.getBounds();
  const width = value === 'vertical' ? 320 : 560;
  const height = value === 'vertical' ? 500 : horizontalHeight();
  mainWindow.setMinimumSize(value === 'vertical' ? 280 : 360, value === 'vertical' ? 240 : 44);
  mainWindow.setBounds(boundedSize({ x: current.x + current.width - width, y: current.y, width, height }), true);
  preferences.layout = value;
  preferences.compact = true;
  savePreferences();
}

async function refreshSnapshot() {
  if (pendingSnapshot) return pendingSnapshot;
  pendingSnapshot = Promise.resolve().then(getSnapshot).then((snapshot) => {
    latestSnapshot = snapshot;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('statusline:snapshot', snapshot);
    }
    return snapshot;
  }).catch((error) => {
    if (!latestSnapshot) throw error;
    // Keep the last successful timestamp and visibly mark cached results unknown.
    latestSnapshot = {
      ...latestSnapshot,
      providers: latestSnapshot.providers.map((provider) => ({
        ...provider,
        status: 'unknown',
        processCount: 0,
        detail: 'Refresh failed. Sign-in information is from the last successful scan; process status is unavailable.',
      })),
    };
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('statusline:snapshot', latestSnapshot);
    return latestSnapshot;
  }).finally(() => { pendingSnapshot = undefined; });
  return pendingSnapshot;
}

function trustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  return event.senderFrame.url.split('#')[0] === rendererUrl.split('#')[0];
}

function registerHandlers() {
  const handle = (channel, handler) => ipcMain.handle(`statusline:${channel}`, (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Untrusted caller');
    return handler(...args);
  });
  handle('get-snapshot', () => latestSnapshot || refreshSnapshot());
  handle('refresh', refreshSnapshot);
  handle('get-preferences', () => ({ ...preferences }));
  handle('get-capabilities', () => capabilities);
  const integrationOptions = () => ({ executablePath: process.execPath, workerPath: path.join(__dirname, 'claude-worker.cjs'), appPath: app.getAppPath(), isPackaged: app.isPackaged, portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE) });
  handle('get-claude-integration', () => getIntegrationStatus(integrationOptions()));
  let integrationPending;
  const changeIntegration = (operation) => {
    if (!integrationPending) integrationPending = operation(integrationOptions()).finally(() => { integrationPending = undefined; });
    return integrationPending;
  };
  handle('connect-claude', () => changeIntegration(connectIntegration));
  handle('disconnect-claude', () => changeIntegration(disconnectIntegration));
  handle('set-compact', setCompact);
  handle('set-layout', setLayout);
  handle('set-details-open', (value) => {
    if (typeof value !== 'boolean') throw new TypeError('Details must be a boolean');
    detailsOpen = value;
    resizePanels();
  });
  handle('set-task-context-open', (value) => {
    if (typeof value !== 'boolean') throw new TypeError('Task context must be a boolean');
    taskContextOpen = value;
    resizePanels();
  });
  handle('set-always-on-top', (value) => {
    if (typeof value !== 'boolean') throw new TypeError('Always on top must be a boolean');
    if (nativeWayland) throw new Error('Pinning is managed by your Wayland desktop.');
    mainWindow.setAlwaysOnTop(value);
    preferences.alwaysOnTop = value;
    savePreferences();
  });
  handle('start-window-drag', (point) => {
    if (nativeWayland) return;
    windowDrag = { cursor: dragPoint(point), bounds: mainWindow.getBounds() };
  });
  handle('move-window-drag', (point) => {
    const cursor = dragPoint(point);
    if (!windowDrag || mainWindow.isMinimized()) return;
    mainWindow.setPosition(
      Math.round(windowDrag.bounds.x + cursor.x - windowDrag.cursor.x),
      Math.round(windowDrag.bounds.y + cursor.y - windowDrag.cursor.y),
    );
  });
  handle('end-window-drag', finishWindowDrag);
  handle('open-provider', async (providerId) => {
    if (typeof providerId !== 'string' || !Object.hasOwn(PROVIDER_URLS, providerId)) throw new Error('Unknown provider');
    await shell.openExternal(PROVIDER_URLS[providerId]);
  });
  handle('minimize', () => mainWindow.minimize());
  handle('close', () => {
    if (tray) mainWindow.hide();
    else app.quit();
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  keepWindowInWorkArea();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(icon) {
  try {
    tray = new Tray(icon.resize({ width: process.platform === 'darwin' ? 18 : 24, height: process.platform === 'darwin' ? 18 : 24 }));
    tray.setToolTip('AgentGlance — your AI workspace');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show AgentGlance', click: showWindow },
      { label: 'Refresh status', click: () => { void refreshSnapshot().catch(() => {}); } },
      { type: 'separator' },
      { label: 'Quit AgentGlance', click: () => app.quit() },
    ]));
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  } catch {
    tray = undefined;
  }
}

async function createWindow() {
  const compact = true;
  const horizontal = preferences.layout === 'horizontal';
  const icon = appIcon();
  mainWindow = new BrowserWindow({
    width: horizontal ? 560 : 320,
    height: horizontal ? horizontalHeight() : 500,
    minWidth: horizontal ? 360 : 280,
    minHeight: horizontal ? 44 : 240,
    title: 'AgentGlance',
    backgroundColor: '#00000000',
    frame: nativeWayland,
    transparent: !nativeWayland,
    hasShadow: true,
    skipTaskbar: false,
    show: false,
    autoHideMenuBar: true,
    alwaysOnTop: preferences.alwaysOnTop,
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  if (compact && !nativeWayland) {
    const area = screen.getPrimaryDisplay().workArea;
    mainWindow.setPosition(area.x + area.width - (horizontal ? 584 : 344), area.y + 72);
  }
  mainWindow.setMenu(null);
  mainWindow.on('blur', finishWindowDrag);
  mainWindow.on('restore', keepWindowInWorkArea);
  mainWindow.on('moved', () => { if (!windowDrag) keepWindowInWorkArea(); });
  if (process.platform === 'win32' && app.isPackaged) {
    const launcher = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    mainWindow.setAppDetails({
      appId: 'app.agentglance.desktop',
      appIconPath: launcher,
      appIconIndex: 0,
      relaunchCommand: `"${launcher}"`,
      relaunchDisplayName: 'AgentGlance',
    });
  }
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = undefined; });
  createTray(icon);
  const devUrl = !app.isPackaged && process.env.STATUSLINE_DEV_URL;
  if (devUrl) {
    const parsed = new URL(devUrl);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('Development server must run on local loopback');
    rendererUrl = parsed.href;
    await mainWindow.loadURL(rendererUrl);
  } else {
    const index = path.join(__dirname, '..', 'dist', 'index.html');
    rendererUrl = pathToFileURL(index).href;
    await mainWindow.loadFile(index);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
    clearInterval(refreshTimer);
  });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
  app.on('activate', showWindow);
  app.whenReady().then(async () => {
    if (process.platform === 'darwin') {
      app.dock.setIcon(appIcon());
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: 'AgentGlance', submenu: [{ label: 'Show AgentGlance', click: showWindow }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]));
    }
    readPreferences();
    registerHandlers();
    await createWindow();
    screen.on('display-added', keepWindowInWorkArea);
    screen.on('display-removed', keepWindowInWorkArea);
    screen.on('display-metrics-changed', keepWindowInWorkArea);
    void refreshSnapshot().catch(() => {});
    refreshTimer = setInterval(() => { void refreshSnapshot().catch(() => {}); }, 5000);
    refreshTimer.unref();
  }).catch((error) => {
    console.error('AgentGlance could not start:', error.message);
    app.quit();
  });
}
