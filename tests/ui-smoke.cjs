const { chromium, expect } = require('@playwright/test');
const now = new Date().toISOString();
const fiveHourReset = new Date(Date.parse(now) + 90 * 60000).toISOString();
const weeklyReset = new Date(Date.parse(now) + (3 * 24 + 6) * 3600000).toISOString();
const usage = (limits, context = null) => ({ state: 'partial', limits, context, updatedAt: now, stale: false, message: null, source: 'Test fixture' });
const provider = (id, name, data) => ({ id, name, description: '', status: 'running', authSource: 'Local sign-in', processCount: 1, lastActivityAt: null, detail: '', usage: data, activity: { state: id === 'codex' ? 'occupied' : 'free', detail: 'Fixture activity', source: 'Fixture', updatedAt: now } });
const snapshot = { checkedAt: now, scanDurationMs: 1, platform: 'win32', providers: [
  provider('codex', 'Codex', usage([{ id: 'primary', label: 'Weekly', usedPercent: 0, resetsAt: weeklyReset }])),
  provider('claude', 'Claude', usage([{ id: 'five_hour', label: '5-hour', usedPercent: 74, resetsAt: fiveHourReset }, { id: 'seven_day', label: 'Weekly', usedPercent: 100, resetsAt: now }])),
] };
snapshot.providers[0].tasks = [
  { id: 'codex-one', label: 'Implement compact assistant toolbar', state: 'occupied', updatedAt: now, context: { usedTokens: 20000, maxTokens: 100000, usedPercent: 20 } },
  { id: 'codex-two', label: 'Check account usage reset timestamps', state: 'free', updatedAt: now, context: { usedTokens: 0, maxTokens: 100000, usedPercent: 0 } },
  ...Array.from({ length: 5 }, (_, index) => ({ id: `codex-agent-${index}`, label: `Review assistant task ${index}`, state: 'unknown', updatedAt: now, context: null })),
];
snapshot.providers[1].tasks = [{ id: 'claude-one', label: 'Review operating system support', state: 'free', updatedAt: now, context: { usedTokens: 710000, maxTokens: null, usedPercent: null } }];

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 560, height: 44 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const geometry = () => page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  try {
    // Leave headroom for the clock-install RPC before freezing fixture time.
    await page.clock.install({ time: new Date(Date.parse(now) - 60000) });
    await page.clock.pauseAt(new Date(now));
    await page.route('**/api/status', route => route.fulfill({ json: snapshot }));
    await page.goto(process.env.STATUSLINE_TEST_URL || 'http://127.0.0.1:5173');
    const cards = page.getByTestId('provider-signal');
    await expect(cards).toHaveCount(2);
    const codexCard = cards.filter({ has: page.getByRole('button', { name: /^Codex: / }) });
    const claudeCard = cards.filter({ has: page.getByRole('button', { name: /^Claude: / }) });
    const codex = codexCard.getByTestId('usage-meter');
    const claude = claudeCard.getByTestId('usage-meter');
    const codexToggle = codexCard.getByTestId('task-context-toggle');
    const claudeToggle = claudeCard.getByTestId('task-context-toggle');
    await expect(codexCard.getByTestId('process-light')).toHaveAttribute('data-state', 'red');
    await expect(claudeCard.getByTestId('process-light')).toHaveAttribute('data-state', 'green');
    await expect(codex.nth(0)).toHaveAttribute('data-state', 'unknown');
    await expect(codex.nth(0)).toHaveAttribute('data-level', 'unknown');
    await expect(codex.nth(1)).toHaveAttribute('data-level', 'green');
    await expect(codex.nth(1).locator('.meter-value')).toHaveText('0%');
    await expect(claude.nth(0)).toHaveAttribute('data-level', 'yellow');
    await expect(claude.nth(1)).toHaveAttribute('data-level', 'red');
    await expect(claude.nth(1).locator('.meter-value')).toHaveText('100%');
    await expect(page.locator('.usage-ring')).toHaveCount(4);
    for (const ring of await page.locator('.usage-ring').all()) {
      await expect(ring).toBeVisible();
      const bounds = await ring.boundingBox();
      expect(bounds.width).toBe(28);
      expect(bounds.height).toBe(28);
    }
    await expect(page.locator('[data-kind="context"]')).toHaveCount(0);
    await expect(page.getByTestId('task-context')).toHaveCount(0);
    await expect(codexToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(claudeToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(codexCard.getByTestId('task-count')).toBeHidden();
    await expect(claudeCard.getByTestId('process-count')).toBeHidden();
    expect(await geometry()).toEqual({ width: 560, height: 44 });

    // Compact reset countdowns stay visible in the 44px toolbar; hover and details retain exact times.
    await expect(codex.nth(0).getByTestId('usage-reset')).toHaveAttribute('data-reset-state', 'unavailable');
    await expect(codex.nth(0)).toHaveAttribute('aria-label', /Reset time unavailable/);
    await expect(codex.nth(1).getByTestId('usage-reset')).toBeVisible();
    await expect(codex.nth(1).getByTestId('compact-reset-countdown')).toHaveText('↻ 3d 6h');
    await expect(claude.nth(0).getByTestId('compact-reset-countdown')).toHaveText('↻ 1h 30m');
    await expect(claude.nth(1).getByTestId('compact-reset-countdown')).toHaveText('↻ Due');
    await expect(codex.nth(0).getByTestId('compact-reset-countdown')).toHaveText('↻ —');
    for (const countdown of await page.getByTestId('compact-reset-countdown').all()) {
      await expect(countdown).toBeVisible();
      const box = await countdown.boundingBox();
      expect(box.y + box.height).toBeLessThanOrEqual(44);
    }
    await expect(claude.nth(0).getByTestId('reset-countdown')).toHaveText('Resets in 1h 30m');
    await expect(claude.nth(0)).toHaveAttribute('title', /Resets in 1h 30m/);
    await expect(claude.nth(0).locator('time')).toHaveAttribute('datetime', fiveHourReset);
    await expect(claude.nth(1).getByTestId('usage-reset')).toHaveAttribute('data-reset-state', 'due');
    await expect(claude.nth(1)).toHaveAttribute('title', /Reset due/);
    await page.screenshot({ path: 'artifacts/toolbar-collapsed-fixture.png' });
    await page.clock.fastForward(60000);
    await expect(claude.nth(0)).toHaveAttribute('title', /Resets in 1h 29m/);
    await expect(claude.nth(0).getByTestId('compact-reset-countdown')).toHaveText('↻ 1h 29m');
    await claude.nth(0).click();
    await page.setViewportSize({ width: 560, height: 292 });
    await expect(page.locator('.details')).toContainText('Resets in 1h 29m');
    await expect(page.locator('.details')).toContainText('Reset due');
    const localReset = await page.evaluate(date => new Date(date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), fiveHourReset);
    await expect(page.locator('.details')).toContainText(localReset);
    await page.getByTitle('How to read the signals').click();
    await page.setViewportSize({ width: 560, height: 332 });
    await expect(page.locator('.help-panel')).toBeVisible();
    await expect(page.locator('.details')).toHaveCount(0);
    await claude.nth(0).click();
    await expect(page.locator('.details')).toBeVisible();
    await expect(page.locator('.help-panel')).toHaveCount(0);
    await page.getByTitle('Close details').click();
    await page.setViewportSize({ width: 560, height: 44 });

    // Exercise both sides of each inclusive color threshold, and verify the rendered SVG stroke.
    const colors = { green: 'rgb(114, 217, 156)', yellow: 'rgb(228, 207, 104)', orange: 'rgb(235, 163, 104)', red: 'rgb(238, 119, 127)' };
    for (const [value, level] of [[49.9, 'green'], [50, 'yellow'], [74.9, 'yellow'], [75, 'orange'], [89.9, 'orange'], [90, 'red'], [100, 'red']]) {
      snapshot.providers[1].usage.limits[0].usedPercent = value;
      await page.getByTitle('Refresh usage').click();
      await expect(claude.nth(0)).toHaveAttribute('data-level', level);
      expect(await claude.nth(0).locator('.ring-value').evaluate(node => getComputedStyle(node).stroke)).toBe(colors[level]);
      await expect(claudeCard.getByTestId('process-light')).toHaveAttribute('data-state', 'green');
    }

    await codexToggle.focus();
    await page.keyboard.press('Enter');
    await page.setViewportSize({ width: 560, height: 292 });
    await expect(codexToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(claudeToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(claudeCard.getByTestId('task-context')).toHaveCount(0);
    await claudeToggle.click();
    await expect(codexCard.getByTestId('task-context')).toHaveCount(7);
    await expect(codexCard.getByTestId('task-count')).toHaveText('7');
    await expect(codexCard.getByTestId('process-count')).toHaveText('1 process');
    await expect(claudeCard.getByTestId('task-context')).toHaveCount(1);
    await expect(codexCard.locator('[data-task-id="codex-one"]')).toContainText('20%');
    await expect(codexCard.locator('[data-task-id="codex-two"]')).toContainText('0%');
    await expect(claudeCard.getByTestId('task-context')).toContainText('710k tokens · capacity unavailable');
    await expect(claudeCard.getByTestId('task-context')).toHaveAttribute('data-context-state', 'unknown');
    expect(await geometry()).toEqual({ width: 560, height: 292 });
    const taskList = codexCard.locator('.task-list');
    expect(await taskList.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await expect(page.locator('img.provider-logo')).toHaveCount(2);
    for (const img of await page.locator('img.provider-logo').all()) expect(await img.evaluate(node => node.complete && node.naturalWidth > 0)).toBe(true);
    await page.screenshot({ path: 'artifacts/toolbar-expanded-fixture.png' });

    snapshot.providers[0].activity.state = 'waiting';
    snapshot.providers[1].activity.state = 'unknown';
    snapshot.providers[1].status = 'unknown';
    await page.getByTitle('Refresh usage').click();
    await expect(codexCard.getByTestId('process-light')).toHaveAttribute('data-state', 'amber');
    await expect(claudeCard.getByTestId('process-light')).toHaveAttribute('data-state', 'unknown');
    await expect(claudeCard.getByTestId('process-count')).toHaveText('Processes unknown');
    await expect(codexToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(claudeToggle).toHaveAttribute('aria-expanded', 'true');
    await codexToggle.click();
    await expect(codexCard.getByTestId('task-context')).toHaveCount(0);
    await expect(claudeCard.getByTestId('task-context')).toHaveCount(1);
    await claudeToggle.click();
    await page.setViewportSize({ width: 560, height: 44 });
    await expect(page.getByTestId('task-context')).toHaveCount(0);

    // More signed-in providers scroll inside the strip; native width must not grow.
    for (const [id, name] of [['kimi', 'Kimi'], ['gemini', 'Gemini'], ['opencode', 'OpenCode'], ['qwen', 'Qwen'], ['glm', 'GLM'], ['deepseek', 'DeepSeek']]) {
      const shared = ['glm', 'deepseek'].includes(id);
      snapshot.providers.push({ ...provider(id, name, { state: 'unavailable', limits: [], context: null, source: 'Not connected', updatedAt: null, message: 'Usage reporting is not available yet.', stale: false }), status: shared ? 'unknown' : 'idle', activity: { state: shared ? 'unknown' : 'free', detail: 'Fixture activity', source: 'Fixture', updatedAt: null }, tasks: [] });
    }
    await page.getByTitle('Refresh usage').click();
    await expect(cards).toHaveCount(8);
    for (const img of await page.locator('img.provider-logo').all()) expect(await img.evaluate(node => node.complete && node.naturalWidth > 0)).toBe(true);
    const signals = page.locator('.signals');
    expect(await signals.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    expect(await geometry()).toEqual({ width: 560, height: 44 });
    const lastLight = cards.last().getByTestId('process-light');
    await lastLight.scrollIntoViewIfNeeded();
    await expect(lastLight).toBeInViewport();
    await expect(lastLight).toHaveAttribute('data-state', 'unknown');
    const headingOverlap = await cards.last().evaluate(node => {
      const heading = node.querySelector('.provider-heading').getBoundingClientRect();
      const meters = node.querySelector('.usage-meters').getBoundingClientRect();
      return heading.right > meters.left;
    });
    expect(headingOverlap).toBe(false);
    await expect(page.getByTitle('Refresh usage')).toBeInViewport();
    expect(await signals.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    await cards.last().getByTestId('task-context-toggle').click();
    await page.setViewportSize({ width: 560, height: 292 });
    await expect(cards.last().locator('.tasks-empty')).toHaveText('No task context observed yet');

    await cards.last().getByTestId('task-context-toggle').click();
    await page.getByTitle('Vertical layout', { exact: true }).click();
    await page.setViewportSize({ width: 44, height: 560 });
    expect(await geometry()).toEqual({ width: 44, height: 560 });
    expect(await signals.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await expect(page.getByTitle('Horizontal layout', { exact: true })).toBeInViewport();
    await expect(page.getByTitle('Refresh usage')).toBeInViewport();
    await cards.last().getByTestId('task-context-toggle').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/vertical-rail-fixture.png' });
    await cards.last().getByTestId('task-context-toggle').click();
    await page.setViewportSize({ width: 360, height: 560 });
    const drawer = page.getByTestId('vertical-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.tasks-empty')).toHaveText('No task context observed yet');
    expect((await drawer.boundingBox()).x).toBeGreaterThanOrEqual(44);
    expect(await geometry()).toEqual({ width: 360, height: 560 });
    await codexToggle.scrollIntoViewIfNeeded();
    await codexToggle.click();
    await expect(drawer.getByTestId('task-context')).toHaveCount(snapshot.providers[0].tasks.length);
    await expect(cards.last().getByTestId('task-context-toggle')).toHaveAttribute('aria-expanded', 'false');
    await page.screenshot({ path: 'artifacts/vertical-drawer-fixture.png' });
    await codex.nth(0).click();
    await expect(page.getByTestId('task-context')).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 44, height: 560 });
    await expect(drawer).toBeHidden();
    expect(await geometry()).toEqual({ width: 44, height: 560 });
    await page.getByTitle('Horizontal layout', { exact: true }).click();
    await page.setViewportSize({ width: 560, height: 44 });

    await page.unroute('**/api/status');
    await page.route('**/api/status', route => route.fulfill({ json: { ...snapshot, providers: [] } }));
    await page.reload();
    await expect(page.locator('.empty-state')).toContainText('No signed-in assistants');
    await expect(page.getByTestId('provider-signal')).toHaveCount(0);
    await page.unroute('**/api/status');
    await page.route('**/api/status', route => route.fulfill({ status: 503, json: {} }));
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('unavailable');
    expect(errors).toEqual([]);
    console.log('UI smoke passed: 560x44 toolbar, circular usage and threshold colors, independent activity, accessible reset details/countdown, collapsed per-task context, 292px expansion, provider scrolling, real logos, and error states.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
