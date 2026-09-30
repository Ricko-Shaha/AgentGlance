'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron: electron, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
(async () => {
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  const profile = await fs.mkdtemp(path.join(root, 'artifacts/signal-profile-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.STATUSLINE_DEV_URL;
  const fixture = process.env.STATUSLINE_SMOKE_LIVE !== '1';
  const packaged = Boolean(env.STATUSLINE_TEST_EXECUTABLE);
  if (fixture && packaged && env.STATUSLINE_SMOKE_ISOLATED_HOST !== '1') {
    throw new Error('Packaged fixture tests require STATUSLINE_SMOKE_ISOLATED_HOST=1 on a fresh CI host. For local packaged checks, explicitly set STATUSLINE_SMOKE_LIVE=1.');
  }
  if (fixture) {
    // No developer credentials or login are needed by desktop CI.
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'KIMI_HOME', 'KIMI_SHARE_DIR', 'KIMI_CODE_HOME']) env[key] = path.join(profile, 'empty-home');
    await fs.mkdir(env.HOME, { recursive: true });
    for (const key of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|OAUTH_TOKEN)$/.test(key)) delete env[key];
  }
  const desktop = await electron.launch({ executablePath: env.STATUSLINE_TEST_EXECUTABLE || require('electron'), args: [...(packaged ? [] : [fixture ? path.join(__dirname, 'desktop-fixture.cjs') : root]), `--user-data-dir=${profile}`, ...(env.STATUSLINE_TEST_X11 === '1' ? ['--ozone-platform=x11'] : [])], cwd: root, env, timeout:30000 });
  const desktopPid = await desktop.evaluate(() => process.pid);
  try {
    assert.equal(path.resolve(await desktop.evaluate(({ app }) => app.getPath('userData'))).toLowerCase(), profile.toLowerCase());
    const page = await desktop.firstWindow();
    if (fixture && packaged) {
      // Packaged Electron rejects Node preloads. Only fresh, explicitly marked
      // CI hosts may install transport doubles after native package startup.
      const { snapshot: fixtureSnapshot } = require('./desktop-fixture.cjs');
      await desktop.evaluate(({ ipcMain, BrowserWindow }, snapshot) => {
        for (const name of ['get-snapshot', 'refresh']) { ipcMain.removeHandler(`statusline:${name}`); ipcMain.handle(`statusline:${name}`, () => snapshot); }
        ipcMain.removeHandler('statusline:get-claude-integration');
        ipcMain.handle('statusline:get-claude-integration', () => ({ signedIn:true, installed:true, usageConnected:true, activityConnected:true, legacy:false, canConnect:false, canDisconnect:false, reason:null }));
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const send = contents.send.bind(contents);
        contents.send = (channel, ...args) => send(channel, ...(channel === 'statusline:snapshot' ? [snapshot] : args));
      }, fixtureSnapshot);
      await page.reload();
    }
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => Boolean(window.statusline));
    assert.deepEqual(await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process })), { require: 'undefined', process: 'undefined' });
    assert.deepEqual(await page.evaluate(() => window.statusline.getPreferences()), { compact: true, alwaysOnTop: true, layout: 'horizontal' });
    const bounds = () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    assert.equal((await bounds()).width, 560); assert.equal((await bounds()).height, 44);
    const snapshot = await page.evaluate(() => window.statusline.getSnapshot());
    if (fixture) assert.equal(snapshot.providers[0]?.authSource, 'Test fixture', 'Test backend must load before app startup');
    for (const p of snapshot.providers) {
      assert.deepEqual(Object.keys(p).sort(), ['activity', 'authSource', 'description', 'detail', 'id', 'lastActivityAt', 'name', 'processCount', 'status', 'tasks', 'usage']);
      for (const task of p.tasks) assert.deepEqual(Object.keys(task).sort(), ['context', 'id', 'label', 'state', 'updatedAt']);
      assert.deepEqual(Object.keys(p.activity).sort(), ['detail', 'source', 'state', 'updatedAt']);
      assert.deepEqual(Object.keys(p.usage).sort(), ['context', 'limits', 'message', 'source', 'stale', 'state', 'updatedAt']);
      for (const l of p.usage.limits) assert.deepEqual(Object.keys(l).sort(), ['id', 'label', 'resetsAt', 'usedPercent']);
    }
    await expect(page.getByTestId('provider-signal')).toHaveCount(snapshot.providers.length, { timeout: 30000 });
    await expect(page.getByTestId('process-light')).toHaveCount(snapshot.providers.length);
    await expect(page.getByTestId('usage-meter')).toHaveCount(snapshot.providers.length * 2);
    await expect(page.locator('[data-kind="context"]')).toHaveCount(0);
    await expect(page.getByTestId('task-context')).toHaveCount(0);
    await expect(page.getByTestId('task-context-toggle')).toHaveCount(snapshot.providers.length);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 560);
    await page.screenshot({ path: 'artifacts/signal-strip.png' });
    for (const toggle of await page.getByTestId('task-context-toggle').all()) {
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
    await expect.poll(async () => (await bounds()).height).toBe(292);
    await expect(page.getByTestId('task-context')).toHaveCount(snapshot.providers.reduce((count, provider) => count + provider.tasks.length, 0));
    await page.screenshot({ path: 'artifacts/signal-expanded.png' });
    console.log('Rendered providers:', JSON.stringify(snapshot.providers.map(provider => ({ name: provider.name, processes: provider.processCount, sessions: provider.tasks.length, ...(fixture ? { firstSessions: provider.tasks.slice(0, 4).map(task => task.label) } : {}) }))));
    await page.getByTestId('usage-meter').first().click();
    await expect.poll(async () => (await bounds()).height).toBe(580);
    await page.getByTitle('Close details').click();
    await expect.poll(async () => (await bounds()).height).toBe(292);
    for (const toggle of await page.getByTestId('task-context-toggle').all()) await toggle.click();
    await expect.poll(async () => (await bounds()).height).toBe(44);
    await page.getByTestId('usage-meter').first().click();
    await expect.poll(async () => (await bounds()).height).toBe(332);
    await page.getByTitle('Close details').click();
    await expect.poll(async () => (await bounds()).height).toBe(44);
    await page.getByTitle('Vertical layout', { exact: true }).click();
    await expect.poll(async () => (await bounds()).width).toBe(320);
    assert.equal((await bounds()).height, 500);
    await page.screenshot({ path: 'artifacts/signal-vertical.png' });
    await page.getByTitle('Horizontal layout', { exact: true }).click();
    await expect.poll(async () => (await bounds()).height).toBe(44);
    await page.getByTitle('How to read the signals').click();
    await expect(page.getByTestId('claude-connection')).toBeVisible();
    await expect.poll(async () => (await bounds()).height).toBe(332);
    await page.getByTitle('Close signal guide').click();
    await expect.poll(async () => (await bounds()).height).toBe(44);
    for (const value of [false, true]) {
      await page.getByTitle('Always on top', { exact: true }).click();
      assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), value);
    }
    assert.equal(await page.evaluate(async () => { try { await window.statusline.openProvider('https://untrusted.invalid'); return false; } catch { return true; } }), true);
    await page.getByTitle('Minimize', { exact: true }).click();
    await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
    await desktop.evaluate(({ app }) => app.emit('second-instance'));
    await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false);
    await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    // A topmost widget must not remain underneath the taskbar after a drag.
    const workArea = await desktop.evaluate(({ BrowserWindow, screen }) => screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds()).workArea);
    const beforeDrop = await bounds();
    await page.evaluate(async ({ before, area }) => {
      const start = { x: before.x + 12, y: before.y + 20 };
      await window.statusline.startWindowDrag(start);
      await window.statusline.moveWindowDrag({ x: start.x, y: area.y + area.height + 20 });
      await window.statusline.endWindowDrag();
    }, { before: beforeDrop, area: workArea });
    await expect.poll(async () => { const b = await bounds(); return b.y + b.height; }).toBe(workArea.y + workArea.height);
    assert.equal((await bounds()).height, 44, 'Taskbar recovery must preserve the compact height');
    // Restoring and display changes must also recover a window left off-screen.
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await desktop.evaluate(({ BrowserWindow, screen }) => {
      BrowserWindow.getAllWindows()[0].setPosition(100000, 100000);
      screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea']);
    });
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false, 'Display recovery must respect an explicitly hidden widget');
    await desktop.evaluate(({ app }) => app.emit('second-instance'));
    const recovered = await desktop.evaluate(({ BrowserWindow, screen }) => { const b = BrowserWindow.getAllWindows()[0].getBounds(); return { bounds: b, area: screen.getDisplayMatching(b).workArea }; });
    assert.ok(recovered.bounds.x >= recovered.area.x && recovered.bounds.y >= recovered.area.y && recovered.bounds.x + recovered.bounds.width <= recovered.area.x + recovered.area.width && recovered.bounds.y + recovered.bounds.height <= recovered.area.y + recovered.area.height, 'Restored widget must fit inside an attached display work area');
    await page.evaluate(() => window.statusline.refresh());
    assert.deepEqual(errors, []);
    if (process.env.STATUSLINE_NATIVE_INPUT === '1') {
      // CDP clicks bypass Windows non-client hit testing. Exercise the real
      // desktop input path to catch draggable regions swallowing controls.
      const cli = process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : 'orca');
      const pid = await desktop.evaluate(() => process.pid);
      await desktop.evaluate(({ BrowserWindow, screen }) => {
        const area = screen.getPrimaryDisplay().workArea;
        BrowserWindow.getAllWindows()[0].setPosition(area.x + 240, area.y + 140);
      });
      const runComputer = async argumentsText => {
        const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', `& '${cli.replace(/'/g, "''")}' computer ${argumentsText} --app pid:${pid} --json`], { windowsHide: true, timeout: 30000 });
        const response = JSON.parse(stdout);
        assert.equal(response.ok, true, stdout);
        return response.result;
      };
      const state = await runComputer('get-app-state --restore-window');
      assert.ok(state.screenshot?.path, 'Native screenshot confirms target window');
      const grip = await page.getByTestId('drag-grip').boundingBox();
      for (const point of [
        { x: Math.round(grip.x + grip.width / 2), y: Math.round(grip.y + grip.height / 2) },
        { x: 21, y: 22 },
      ]) {
        const before = await bounds();
        const [from, to] = await desktop.evaluate(({ screen }, points) => points.map(point => screen.dipToScreenPoint(point)), [{ x: before.x + point.x, y: before.y + point.y }, { x: before.x + point.x - 80, y: before.y + point.y + 40 }]);
        await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'native-drag.ps1'), '-TargetPid', String(pid), '-FromScreenX', String(from.x), '-FromScreenY', String(from.y), '-ToScreenX', String(to.x), '-ToScreenY', String(to.y)], { windowsHide: true, timeout: 15000 });
        const after = await bounds();
        assert.ok(Math.abs(after.x - (before.x - 80)) < 12 && Math.abs(after.y - (before.y + 40)) < 12, `Native drag must move the window: ${JSON.stringify({ before, after })}`);
        assert.equal(after.height, before.height, 'Dragging must not toggle an accordion');
      }
      const taskbarArea = await desktop.evaluate(({ BrowserWindow, screen }) => screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds()).workArea);
      const dragBounds = await bounds();
      const startPoint = { x: dragBounds.x + Math.round(grip.x + grip.width / 2), y: dragBounds.y + Math.round(grip.y + grip.height / 2) };
      const [taskbarFrom, taskbarTo] = await desktop.evaluate(({ screen }, points) => points.map(point => screen.dipToScreenPoint(point)), [startPoint, { x: startPoint.x, y: taskbarArea.y + taskbarArea.height + 10 }]);
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'native-drag.ps1'), '-TargetPid', String(pid), '-FromScreenX', String(taskbarFrom.x), '-FromScreenY', String(taskbarFrom.y), '-ToScreenX', String(taskbarTo.x), '-ToScreenY', String(taskbarTo.y)], { windowsHide: true, timeout: 15000 });
      await expect.poll(async () => { const b = await bounds(); return b.y + b.height; }).toBe(taskbarArea.y + taskbarArea.height);
      assert.equal((await bounds()).height, 44, 'Dropping over the real taskbar must not resize the widget');
      // Verify the recovered edge placement, then test close independently at the center.
      await runComputer('get-app-state --restore-window');
      await desktop.evaluate(({ BrowserWindow, screen }) => { const area = screen.getPrimaryDisplay().workArea; BrowserWindow.getAllWindows()[0].setPosition(area.x + 240, area.y + 140); });
      await runComputer('get-app-state --restore-window');
      const button = await page.getByTitle('Close widget', { exact: true }).boundingBox();
      try {
        await runComputer(`click --window-id ${state.snapshot.window.id} --x ${Math.round(button.x + button.width / 2)} --y ${Math.round(button.y + button.height / 2)}`);
      } catch (error) {
        // A successful close can hide the app before Orca takes its post-click
        // snapshot. The native visibility assertion below verifies the effect.
        if (!['app_not_found', 'window_not_found'].includes(JSON.parse(error.stdout || '{}').error?.code)) throw error;
      }
    } else {
      await page.getByTitle('Close widget', { exact: true }).click();
    }
    await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    console.log(`Desktop smoke passed: ${snapshot.providers.length} providers, per-session context, detail resizing, layouts, pinning, close visibility, and isolated IPC.`);
  } catch (error) {
    console.error('Desktop smoke failed before teardown:', error);
    throw error;
  } finally {
    let timer;
    try {
      await Promise.race([desktop.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Desktop teardown timed out')), 5000); })]);
    } catch {
      // Kill only the test Electron PID captured immediately after launch.
      if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(desktopPid), '/T', '/F'], { windowsHide:true, timeout:5000 }).catch(() => {});
      else { try { process.kill(desktopPid, 'SIGKILL'); } catch { /* Already exited. */ } }
    } finally { clearTimeout(timer); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
