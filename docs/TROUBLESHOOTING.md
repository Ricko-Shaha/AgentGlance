# Troubleshooting

These steps apply to AgentGlance **2.1.2**. See [Installation](INSTALLATION.md), [Using AgentGlance](USAGE.md), and the [project overview](../README.md) for normal setup and behavior.

## The widget disappeared

**Minimize** keeps a taskbar or Dock entry. Restore it from there.

The **×** button normally hides the widget to the tray; the hidden window may no longer appear on the taskbar. Click the AgentGlance tray icon, choose **Show AgentGlance** from its menu, or open the same application shortcut again. A second launch restores the existing instance. If a tray cannot be created, closing exits the application instead, so launching it again starts a new instance.

On Windows, check the tray's hidden-icons overflow. On Linux, some desktops do not display tray icons even when an app creates one; launching the application again remains a recovery route. On macOS, use the Dock or **AgentGlance → Show AgentGlance**.

Since version 2.0.2, the app moves the widget back inside the usable desktop after dragging ends, restoring the window, or a display change. Reopen it after disconnecting a monitor or changing taskbar placement. To stop the app completely, choose **Quit AgentGlance** from its tray menu; hiding it leaves monitoring running.

## Dragging, pinning, or layout switching behaves differently

Drag the grip or an empty toolbar area. Buttons, task lists, and details panels have their own interactions and do not start a window drag. Screen edges and taskbars bound its final position.

The pin button controls **Always on top**. If it is disabled on Linux, open **Info**: a pure Wayland session without an X11 display uses a framed vertical window with compositor-controlled movement and resizing. Pinning and layout switching are unavailable there. An X11 or XWayland display enables the floating-toolbar behavior. See [Installation](INSTALLATION.md#display-server-behavior).

In the floating vertical layout, the collapsed rail is 44 pixels wide. Tasks and details open in a drawer to its right. If the rail is near a display's right edge, opening that drawer moves the window left enough to keep it visible. This is expected work-area clamping, not a failed drag.

## An assistant does not appear

AgentGlance only displays assistants with supported local sign-in or API-credential evidence. Opening a browser account or starting an unauthenticated process is not enough.

1. Confirm the assistant works in its own local CLI under the same operating-system user.
2. Refresh AgentGlance. Allow up to a minute for cached CLI authentication checks after signing in.
3. If you use a custom configuration directory, start AgentGlance with the same environment settings as that assistant.
4. If the app was already open when you installed a CLI or changed its environment, quit AgentGlance fully and reopen it.

Codex and Claude can report authentication through their own read-only CLI status commands when credentials reside in a system credential store. AgentGlance does not extract keychain secrets. A missing CLI, unavailable credential store, or unsupported configuration can prevent discovery. API credentials are identified separately from account sign-ins; their presence does not imply subscription quota information is available.

Do not copy tokens, credential files, or login links into an issue report. See [Privacy](PRIVACY.md).

## Usage rings show a dash or an older reading

A dash means the percentage is unavailable, not that usage is zero. An asterisk marks a reading retained from an older observation. Account usage and activity are separate: a working assistant can have unavailable quota information.

Codex usage comes through its installed app server. Confirm Codex is authenticated and its CLI is available to AgentGlance. Claude prefers status-line observations; connect telemetry from an installed app and wait for Claude's next update. Read-only account requests are cached for about two minutes, so repeated refresh clicks do not necessarily request new account data immediately. A service or authentication failure can leave usage unavailable or stale.

Kimi, Gemini, OpenCode, Qwen, GLM, and DeepSeek can appear through supported local authentication detection, but their account-usage integrations are not implemented. Their usage rings remain unavailable. Qwen currently requires supported API-key configuration; legacy OAuth-only files do not establish detection. See [Provider support](PROVIDERS.md) for the exact supported configuration sources. AgentGlance also does not substitute an unrelated quota window for a missing five-hour or weekly window.

## Reset times are missing or say the reset is due

Reset times only appear when the provider reports them. A valid percentage does not guarantee a reset timestamp. Hover over a ring for the exact local time or click it for details. Countdown labels update every 30 seconds.

**Reset due · awaiting update** means the last reported timestamp has passed. AgentGlance waits for a new provider observation; it does not invent a new reset time or assume your usage is now zero. A refresh can obtain newer local observations, while account requests still respect their cache interval.

## Activity colors do not match the number of open processes

The provider logo's activity light uses **green for free**, **red for occupied**, **yellow for waiting for input/approval**, and **gray for unknown or stale activity**. An open process alone does not prove it is working. Codex uses task lifecycle observations; Claude uses activity hooks. For an attributable assistant client, no detected running process means free. GLM and DeepSeek can share another client, so their activity remains unknown and a zero process count does not prove that the model is idle.

The adjacent usage rings use their own thresholds: green below 50% used, yellow from 50%, orange from 75%, and red from 90%. A red usage ring does not mean the assistant is working.

If Claude is running but remains gray, connect its telemetry and wait for a new event. Restart a Claude session if it has not loaded the added hooks. When multiple sessions exist, the provider's overall light summarizes them; open the task list to inspect individual states.

## Task count, process count, and context do not agree

They measure different things:

| Display | Meaning |
| --- | --- |
| Process count | Detected local operating-system processes associated with the assistant |
| Observed sessions | Discovered task/session records, including retained or completed sessions and observed agent sessions |
| Task context | Tokens and capacity reported for that particular session |
| Five-hour/weekly usage | Account quota across a provider's reported time window |

A session can outlive its process, and a client or task can involve multiple processes. These counts are not expected to match. Discovery is bounded, so the task list is not an exhaustive process manager or complete conversation archive. Active sessions are prioritized.

Context is never copied from one task to another. A task may have input/cache token counts without a reported maximum capacity; its percentage then remains unavailable. Claude's status-line telemetry can supply capacity and percentage for the session that emits it. AgentGlance does not guess a context limit from a model name.

Task names come from saved titles or explicit agent descriptions. **Untitled session** means a saved title was not found; directory names and raw prompts are not substituted. A newly renamed task may need another local metadata update before the name appears. Observation times help distinguish current information from retained history.

## Connect Claude is unavailable or telemetry stays empty

Read the message under **Info → Claude telemetry**. Common causes are:

- Claude Code has no detectable local sign-in.
- AgentGlance is running from a Windows portable launcher or Linux AppImage. Install it at a stable location first.
- Existing Claude settings have an unsupported structure, changed during setup, or conflict with a previous integration. AgentGlance preserves them instead of overwriting the conflict.

Successful connection does not generate a task or force a provider response. Continue normal Claude work and wait for a status-line or hook event. Reopen the Claude session if it has not reloaded settings. A working legacy bridge is recognized and left in place; it may use the earlier source-tree disconnect commands rather than the desktop app's disconnect button. Those commands are documented in [Development](DEVELOPMENT.md).

If you moved or removed the connected AgentGlance executable, restore the installation at its previous location if possible, disconnect from that running copy, then reconnect from the intended installed location. Avoid replacing an entire Claude settings file to fix one observer: unrelated status-line commands and hooks may need to be retained.

## A downloaded package is missing or cannot launch

Version 2.1.2 passed [native CI builds and desktop checks](https://github.com/Ricko-Shaha/AgentGlance/actions/runs/36695269874) for Windows x64, macOS x64/arm64, and Linux x64/arm64. Linux checks use X11/Openbox; results do not cover every desktop environment or pure Wayland. Download the artifact matching your platform and architecture from a successful run. CI uploads are not automatic GitHub Releases.

Windows builds are unsigned; macOS builds have no Developer ID signature or notarization. Organization policies may block them. Use your organization's supported software process rather than disabling operating-system protections. For Linux AppImages, confirm executable permission and your distribution's AppImage/FUSE support. If available, the DEB package is an alternative on a supported Debian-based desktop.

If an older version still opens, quit AgentGlance from its tray menu, check the shortcut's target, and launch the intended version. Versioned portable filenames require updating manually created shortcuts. See [Installation](INSTALLATION.md#updating-and-removing-agentglance).

## Reporting a problem

Include the AgentGlance version, operating system, CPU architecture, package type, affected assistant, steps to reproduce, and the visible error or unavailable field. For Linux window issues, include whether you use X11, XWayland, or pure Wayland.

Crop or redact screenshots if task titles reveal private work. Do not attach credential files, raw session transcripts, complete environment dumps, or personal configuration directories. The [privacy guide](PRIVACY.md) explains the data boundaries; [Development](DEVELOPMENT.md) covers reproducible fixture-based checks.
