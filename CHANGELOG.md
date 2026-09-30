# Changelog

This records notable source changes. A version entry does not imply that GitHub Releases or every platform's binary package has been published.

## 2.1.1

- Make the floating vertical layout a 44-pixel rail with task, usage, and Info drawers opening to the right; keep expanded panels inside the display's usable area. Pure Wayland retains its framed compositor-managed window.
- Correct dependency lockfile consistency for fresh installs and CI setup. Native macOS/Linux validation remains pending.

## 2.1.0

- Rename the application from Statusline to AgentGlance and establish the public `Ricko-Shaha/AgentGlance` repository. Retain legacy `STATUSLINE_*` environment variables and `statusline-*` Claude integration directories for compatibility.
- Import existing Statusline preferences on the first renamed launch without changing the old preference file.
- Add local GLM and DeepSeek API-credential detection through supported OpenCode configurations or exact official Claude-compatible endpoints. Shared-client activity remains unknown; no quota or task feed is claimed.
- Add Qwen Code API-credential and native/official-entrypoint process detection. Quota and task-context integrations remain unavailable.
- Add installation, usage, provider, troubleshooting, development, privacy, contribution, and security documentation.

## 2.0.2

- Keep the widget inside the usable desktop after dragging, restoring, and display changes, avoiding taskbar and screen-edge loss.
- Preserve taskbar/Dock minimization and shortcut/tray recovery for the existing window.

## 2.0.1

- Refine the compact toolbar's reset countdowns and exact-time hover details.
- Keep quota reset information accessible alongside the compact usage rings.

## 2.0.0

- Introduce the compact 44-pixel toolbar with side-by-side circular usage meters and expandable per-provider task context.
- Add installed-app Claude telemetry setup using a bundled worker, preserving existing status-line commands and hooks.
- Configure Windows portable/installer, macOS Intel/Apple Silicon, and Linux x64/arm64 packaging with native CI jobs. macOS/Linux native validation remains pending.
