# Development

Use **Node.js 24** and npm; CI uses Node 24. Work on the native operating system you intend to package. Windows has been exercised locally, and version 2.1.2 passed [all five native CI targets](https://github.com/Ricko-Shaha/AgentGlance/actions/runs/36695269874). Linux checks cover X11/Openbox; pure Wayland remains unverified. See [Installation](INSTALLATION.md) for end-user setup.

The source repository is [Ricko-Shaha/AgentGlance](https://github.com/Ricko-Shaha/AgentGlance). AgentGlance retains the existing `STATUSLINE_*` environment-variable names and `statusline-*` Claude integration directory names for compatibility with earlier Statusline installations. Use those existing names in commands; do not substitute an `AGENTGLANCE_` prefix.

## Run from source

```sh
npm ci
npm run dev
```

The development launcher starts Vite on loopback and Electron, then cleans up its child processes on exit. `npm run dev:web` runs the browser preview on `127.0.0.1`. Keep it local: the development status API exposes local assistant observations and is not a remotely authenticated service.

```sh
npm run build
npm start
```

Build runs TypeScript checking and creates `dist/`; start opens the built interface in Electron. Normal development launches can read the current user's assistant state. Use the fixture tests below for isolated verification.

## Project layout

| Location | Purpose |
| --- | --- |
| `src/` | React toolbar, task lists, usage details, styling |
| `electron/main.cjs`, `electron/preload.cjs` | Native window behavior and restricted renderer bridge |
| `electron/providers.cjs` | Local authentication and process detection |
| `electron/*-usage.cjs`, `electron/*-tasks.cjs`, `electron/*-activity.cjs` | Provider-specific observations |
| `electron/claude-integration.cjs`, `electron/claude-worker.cjs` | Reversible setup and bundled telemetry worker |
| `scripts/` | Development, packaging, icons, and optional legacy setup |
| `tests/` | Fixture unit tests and browser/native smoke tests |
| `assets/` | Application icon and attributed provider logos |

## Verify changes

```sh
npm test
npm run build
npm run test:desktop
```

Unit tests use test fixtures. Source desktop smoke installs a fixture backend before app startup, checks the Electron bridge and native window behavior, and writes screenshots under `artifacts/`. It does not need your assistant account. A graphical desktop is required.

For browser layout checks, run `npm run dev:web` in another terminal, then:

```sh
node tests/ui-smoke.cjs
```

This script uses the installed Microsoft Edge channel and injects fixture data. `STATUSLINE_TEST_URL` can select a different loopback preview URL. It is a separate local check, not a prerequisite assumed by every CI platform.

### Packaged checks

```sh
npm run dist:unpacked
```

On your personal machine, packaged smoke requires an explicit live-data opt-in. In PowerShell:

```powershell
$env:STATUSLINE_SMOKE_LIVE = '1'
npm run test:packaged
Remove-Item Env:STATUSLINE_SMOKE_LIVE
```

On macOS/Linux:

```sh
STATUSLINE_SMOKE_LIVE=1 npm run test:packaged
```

Live smoke reads local assistant state; screenshots may contain task titles. Do not publish those artifacts without review. `STATUSLINE_NATIVE_INPUT=1` additionally enables the Windows native pointer checks and moves the pointer during the test.

Packaged fixture mode instead requires `STATUSLINE_SMOKE_ISOLATED_HOST=1` on a fresh CI host. That flag is an assertion that the host is isolated, not a sandbox for an existing personal account. Do not use it to bypass the live-data guard on your own machine. `STATUSLINE_TEST_EXECUTABLE` selects an explicit packaged executable; `--arch` selects the expected unpacked architecture.

### Linux desktop tests

CI installs the Playwright Chromium system dependencies plus Xvfb, Xauth, X11 utilities, Openbox, FUSE 2 support, and RPM tooling. It preserves Electron's sandbox and prepares the sandbox helper on the isolated runner. Do not work around launch failures by disabling the sandbox.

Run under a working X11 desktop, or use:

```sh
STATUSLINE_TEST_X11=1 xvfb-run --auto-servernum --server-args='-screen 0 1280x1024x24' bash scripts/linux-desktop-test.sh npm run test:desktop
```

The helper starts Openbox, waits for its readiness signal, and cleans it up on exit. Xvfb alone lacks the window manager needed for positioning, minimization, and pinning checks.

## Package

```sh
npm run dist             # Native host formats and architecture
npm run dist:win         # Windows x64 portable + NSIS installer
npm run dist:mac         # Native Mac architecture: DMG + ZIP
npm run dist:linux       # Native Linux architecture: AppImage + DEB
```

Outputs go to `release/`. Add `-- --arch x64` or `-- --arch arm64` to a macOS/Linux packaging command to select the target. Windows currently targets x64 only. The helper rejects foreign operating-system builds. A locally installed Electron distribution is reused only if its package version, actual executable version, platform, and architecture match the requested runtime. Otherwise electron-builder resolves the correct target distribution.

For an already built interface, `node scripts/package.cjs --platform win --arch x64` skips rebuilding `dist/`. `--dir` creates an unpacked application; `--target` selects one supported format. The helper regenerates the code-drawn icons before packaging.

DEB packaging requires a real project homepage. Set `STATUSLINE_PROJECT_HOMEPAGE` to the actual repository/project URL for a local build; CI derives it from its GitHub repository. To build without DEB metadata, use `npm run dist:linux -- --target AppImage`.

Windows packages are unsigned. macOS uses ad-hoc signing without Developer ID or notarization. No automated publishing or update service is configured.

## CI

The [desktop workflow](../.github/workflows/desktop.yml) runs unit tests, builds, source desktop smoke, native packaging, and packaged smoke on Windows x64, macOS x64/arm64, and Linux x64/arm64. Linux runs under Xvfb/Openbox. It uploads package and screenshot artifacts; it does not publish GitHub Releases. A configured job is not evidence of a successful native run.

## Legacy Claude setup commands

The installed app's **Connect Claude** action is the normal user flow. These source-tree commands remain available for earlier Node-based installations:

```sh
npm run claude:connect
npm run claude:disconnect
npm run claude:activity:connect
npm run claude:activity:disconnect
```

They change the current user's Claude settings and use the Node runtime that launches them. They are not test commands. Use fixture directories for development, preserve existing settings, and disconnect an observer through the same setup mechanism that owns it. See [Privacy](PRIVACY.md) and [Contributing](../CONTRIBUTING.md).
