# Using AgentGlance

AgentGlance is a local desktop widget for assistant activity and usage. [Install it](INSTALLATION.md), sign in through your supported assistants, and open the app. It only displays providers with detected local authentication evidence. See [Provider support](PROVIDERS.md) for the available integrations.

## Toolbar controls

The horizontal toolbar starts at **560 × 44 pixels**. Additional providers may need more horizontal space; the layout can scroll. Drag its grip or empty background to move it. After a drop, restore, or display change, the widget stays inside the usable desktop.

| Control | Action |
| --- | --- |
| Rotation arrow | Switch horizontal/vertical layout |
| Pin | Toggle always on top |
| Refresh | Read the latest available status |
| Info | Show explanations and Claude telemetry setup |
| Provider's chevron | Expand or collapse its task context list |
| Usage ring | Open that provider's usage details |
| Minus | Minimize to the taskbar or Dock |
| × | Hide to the tray; exit if a tray could not be created |

Hover over controls for their labels and over a usage ring for reset details. Escape closes the usage or Info panel. In the horizontal layout, task lists expand independently and scroll separately. The horizontal window grows to 292 pixels high while a task list is open; usage details or Info add 288 pixels.

The vertical layout is a **44-pixel-wide rail**, similar in width to a desktop taskbar. Selecting tasks, usage details, or Info opens one **316-pixel drawer to the right**, making the window 360 pixels wide. The rail keeps its left edge in place when there is room. Near the screen edge, the app moves enough to keep the entire drawer in the usable desktop. Closing all panels restores the compact widget's original position in either layout. Dragging an expanded widget moves that remembered position too. The rail's height fits the assistant cards and controls, up to 560 pixels; longer lists scroll.

To recover a hidden widget, select **Show AgentGlance** from the tray or open the application shortcut again. **Quit AgentGlance** in the tray menu exits fully. On pure Wayland without an X11 display, a framed vertical window replaces the toolbar and pin/layout controls are unavailable; see [Installation](INSTALLATION.md#display-server-behavior).

## Activity and usage are different

The light surrounding a provider logo summarizes observed activity:

| Color | Activity |
| --- | --- |
| Green | Free |
| Red | Occupied, working |
| Yellow | Waiting for input or approval |
| Gray | Unknown or stale observation |

An open process is not sufficient evidence of work. Codex uses recorded task lifecycle events; Claude uses activity hooks. If multiple observed Claude sessions are present, a waiting session takes priority. Providers without an attributable activity feed can remain unknown.

The adjacent **5h** and **Week** rings show the percentage of account quota **used**. Their colors are green below 50%, yellow from 50%, orange from 75%, and red from 90%. These thresholds do not change the activity light.

A dash means unavailable, not zero. An asterisk marks an older observation. Small countdowns appear under reported quota rings; hover for the exact local reset time. Countdowns update every 30 seconds. A passed timestamp says the reset is due while awaiting a newer report. Missing reset timestamps and unsupported quota windows are not guessed.

Status refreshes automatically about every five seconds, but authenticated account-usage requests are cached for about two minutes. Refresh does not bypass every cache or force the assistant to produce telemetry.

## Task context

Open an assistant's chevron to see saved task/session titles, activity, observed time, token counts, and available context capacity. Each row's context belongs to that session. It is not account quota or a cumulative lifetime token total.

Some sessions expose token counts without a known maximum, so a percentage cannot be calculated. Claude's status-line bridge supplies the emitting session's reported capacity. No capacity is guessed from the model name.

Process count and observed session count measure different things. Historical or completed sessions can remain visible, and an assistant may use several processes. Active sessions are prioritized within bounded discovery. Explicit agent sessions can appear separately. Titles come from saved task names or agent descriptions; missing names appear as **Untitled session**, not raw prompts or directory names.

## Claude telemetry

In a stable installed copy, open **Info → Claude telemetry → Connect Claude**. This preserves existing status-line commands and adds local activity hooks. New observations arrive when Claude next emits relevant events; reopen a session if it has not reloaded settings. No separate Node installation is needed for the bundled worker.

**Configured** confirms saved settings. **Receiving status-line updates** confirms recent data, with its timestamp and whether usage limits and context were reported. **Last update** indicates an older observation. These diagnostics refresh every five seconds while Info is open. Use an interactive Claude session; `claude -p` does not emit status-line updates. If you move the installed app, **Repair connection** updates its owned command paths when needed.

Portable Windows builds and Linux AppImages cannot install this connection. Use an installed package instead. Existing working legacy connections are recognized. Disconnect before moving or removing the installed application; see [Installation](INSTALLATION.md#updating-and-removing-agentglance).

If a provider or measurement is missing, start with [Troubleshooting](TROUBLESHOOTING.md). For what the app reads and stores, see [Privacy](PRIVACY.md).
