# Supported providers

AgentGlance discovers supported local credentials under the current operating-system user. You authenticate in the assistant's own CLI; there is no widget sign-in form. A browser-only login, installed executable, or running process is not enough to add a card. Discovery does not make a generation request or validate every stored API key against a server.

The [README capability table](../README.md#provider-support) distinguishes connection detection from usage, activity and task-context support. Unavailable values stay unavailable. A subscription's five-hour or weekly limit is not interchangeable with API credit balance or tokens used in one task.

## Configuration locations

`~` means your operating-system home directory. Environment overrides must be available to the widget process; variables set in a different terminal are not automatically inherited by an already running desktop app.

| Card | Local connection evidence | Supported path override |
| --- | --- | --- |
| Codex | `~/.codex/auth.json`; installed CLI authentication status if no usable file is found | `CODEX_HOME` |
| Claude | `~/.claude/.credentials.json`; installed CLI authentication status if no usable file is found | `CLAUDE_CONFIG_DIR` |
| Kimi | Supported JSON credentials under `~/.kimi/credentials` and `~/.kimi-code/credentials` | `KIMI_SHARE_DIR`, `KIMI_CODE_HOME` |
| Gemini | `~/.gemini/oauth_creds.json` | Default home location |
| OpenCode | `~/.local/share/opencode/auth.json` | `XDG_DATA_HOME` |
| Qwen | `~/.qwen/settings.json`, selected API configuration and its credential | `QWEN_HOME` |
| GLM / DeepSeek | Named OpenCode API credentials or supported Claude provider configuration | `XDG_DATA_HOME`, `CLAUDE_CONFIG_DIR`, inherited provider environment |

These are the locations currently read by this implementation, not a claim to support every authentication method offered by each CLI. Codex and Claude credential-store authentication is queried through their own read-only CLI status commands; the widget does not extract keychain secrets. Those probes may be cached for a minute.

## Codex and Claude Code

Codex account windows come from its installed app server's read-only rate-limit method, cached for two minutes. Labels follow reported window durations; a primary window is not assumed to mean five hours. Per-task context comes from that session's token metadata. Saved thread titles provide task names.

Claude prefers its documented status-line telemetry for account usage, reset times and context capacity. **Info → Claude telemetry → Connect Claude** installs usage and activity observers from a stable installed app. A read-only account request provides a fallback where suitable credentials are available; the fallback endpoint is internal and may change. Without status-line context, session metadata can provide input/cache token counts while capacity remains unknown. See [installation](INSTALLATION.md#connect-claude-telemetry) and [privacy](PRIVACY.md).

Both task lists can contain retained or completed sessions and observed agents. They are not a one-to-one process list. Raw prompts and directory names are not substituted for missing saved titles.

## Kimi, Gemini and OpenCode

Supported credentials add a card, and recognized local CLI processes provide a process count. Without a task lifecycle integration, an open process has unknown activity; no detected process means free. Account limits, reset times and per-task context are not implemented for these cards.

An OpenCode card represents the client. A GLM or DeepSeek card represents a configured model provider inside a supported client, so both can appear without implying two active tasks.

## Qwen Code

Qwen Code detection reads user-level settings. It recognizes the selected API provider and model, resolving a configured `envKey` from the widget's inherited environment or Qwen's settings `env` object. It also recognizes a legacy direct `security.auth.apiKey`. Missing keys, inactive-model keys, unresolved placeholders, and configuration without a credential do not qualify.

Project-specific settings, arbitrary environment files and every external credential manager are not scanned. Configure and verify Qwen Code in its own CLI, then launch the widget with the same environment. The Qwen card identifies the **Qwen Code client**, which may be configured to use a third-party model.

Legacy OAuth-only caches are not accepted: the current [official Qwen quickstart](https://github.com/QwenLM/qwen-code/blob/main/docs/users/quickstart.md) says Qwen OAuth was discontinued on April 15, 2026. Follow Qwen's current [authentication guide](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) for API configuration.

Actual Qwen CLI processes are detected on Windows, macOS and Linux. Activity while running, account quotas, resets and task context remain unavailable.

## GLM / Z.ai and DeepSeek

The widget recognizes these OpenCode API credential entries:

| Card | Entry names in OpenCode `auth.json` |
| --- | --- |
| GLM | `zai`, `zai-coding-plan`, `zhipuai`, `zhipuai-coding-plan` |
| DeepSeek | `deepseek` |

It also recognizes Claude Code's user settings `env` object or environment inherited by the widget when a credential (`ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`) accompanies the exact official endpoint:

| Card | `ANTHROPIC_BASE_URL` |
| --- | --- |
| GLM | `https://api.z.ai/api/anthropic` |
| DeepSeek | `https://api.deepseek.com/anthropic` |

See the providers' own setup instructions: [Z.ai with Claude Code](https://docs.z.ai/devpack/tool/claude) and [DeepSeek with Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/). AgentGlance reads existing configuration; it does not change which model your CLI uses.

These cards show **unknown activity and process attribution**, because a shared Claude or OpenCode process does not identify the model provider currently handling a task. They do not duplicate the client's activity, account allowance or task context. Five-hour/weekly quotas, resets, balances and task context are not implemented for these model-provider cards.

Custom proxies and other endpoints are not inferred from a similar hostname or model name. If a connection is missing, consult [Troubleshooting](TROUBLESHOOTING.md#an-assistant-does-not-appear).
