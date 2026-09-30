# Privacy and local data

AgentGlance runs on your computer. It has no analytics service or application account. It reads supported local assistant authentication and session metadata to display providers, activity, task titles, and usage. It is not entirely offline: supported quota readers can contact the assistant's account service.

## What is read

- Supported credential/configuration files and relevant environment settings, reduced to local sign-in or API-credential evidence.
- Process names and bounded command-line information needed to recognize supported assistant entrypoints.
- Bounded session-file sections and supported metadata indexes for saved titles, lifecycle events, token counts, and context capacity.
- AgentGlance's numeric Claude usage observations and activity records, when a bridge is installed.

Reading a session file can encounter transcript content internally. The readers select supported metadata; they do not send the raw transcript to the renderer. Saved task titles are intentionally visible and may themselves contain private information.

Codex and Claude can be asked for their own read-only authentication status when credentials are managed by a system credential store. AgentGlance does not extract keychain secrets. Local API-credential evidence is not a remote validation of that credential.

## Network requests

Codex manages its own authenticated read-only quota request through its installed app server. Claude's documented status-line observations are preferred; a fallback sends an existing Claude access token only to Anthropic's official HTTPS account-usage service. That fallback rejects redirects, uses bounded timeouts, and does not refresh or rewrite OAuth credentials. It uses an internal CLI endpoint that may change.

GLM, DeepSeek, and Qwen detection does not make new provider API calls. Their credentials are recognized locally; account quotas and task feeds are not inferred. Selecting a provider's website action opens an allowlisted official site in your browser.

There is no analytics backend or external font loading. Dependency downloads, package builds, and visiting provider websites have their own network behavior outside the monitoring data flow.

## What is stored or shown

Window preferences are stored in Electron's application-data directory. Claude integration stores a restore manifest and observation caches in its configuration directory. Usage records contain numerical measurements, timestamps, hashed session identifiers, and sanitized labels; activity records contain a session hash, event, state, timestamp, and optional process identifier. Older bridges can retain a project basename. Raw status-line payloads are not cached.

The rename to AgentGlance preserves the Claude directory names `statusline-usage`, `statusline-activity`, and `statusline-integration`, along with `STATUSLINE_*` environment variables, for compatibility. These names do not indicate a separate telemetry service.

The restore manifest retains the previous status-line setting/command so it can be forwarded and restored. Any sensitive values already embedded in that command remain part of the saved configuration; it should not be shared publicly.

The renderer receives provider status, counts, saved task labels, times, and usage/context measurements. Credentials, raw command lines, full session paths, and raw conversation text are not included in status snapshots. The Claude connection status also identifies the configuration directory internally for setup; the app's current UI does not display it as a task label.

## Claude setup changes

Detection alone does not install hooks. **Connect Claude** explicitly adds app-owned status-line/activity observers and saves restoration information. Existing status-line input/output is forwarded and unrelated hooks are preserved. Activity observers are silent and do not approve or reject tool permissions.

**Disconnect Claude** restores owned settings and removes owned hooks, preserving unrelated changes. Conflicting edits can require manual review instead of being overwritten. Disconnect before moving or removing the installed app. Disconnecting or uninstalling does not promise to erase all observation caches or preferences; it does not remove assistant credentials or conversations.

## Your controls

Quit AgentGlance to stop its monitoring process. Merely closing the window usually hides it to the tray. Installed Claude observers can still run when Claude emits events until you disconnect them.

Review screenshots before sharing them: task titles and usage patterns can identify private work. Never upload credential files, restore manifests, raw transcripts, or complete environment dumps. Source fixture tests avoid live accounts; packaged live smoke requires explicit opt-in and can produce screenshots containing real titles. See [Development](DEVELOPMENT.md).

The packaged renderer uses sandboxing, context isolation, no Node integration, and a restricted IPC bridge. These are security boundaries, not a guarantee that the application cannot have vulnerabilities. Report concerns through the guidance in [Security](../SECURITY.md).
