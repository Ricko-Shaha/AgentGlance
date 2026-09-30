# Security

AgentGlance reads local assistant metadata and can use existing authentication for supported read-only usage requests. Security-sensitive areas include credential parsing, process detection, IPC, local development endpoints, packaged workers, and reversible Claude configuration changes. See [Privacy](docs/PRIVACY.md) for the data flow.

## Reporting a vulnerability

If this repository offers **Security → Report a vulnerability**, use that private reporting flow. Otherwise, open a minimal public issue asking the maintainer to establish a private reporting channel. Do not post working credentials, personal transcripts, private task titles, or exploit details that expose another user's data in that initial issue.

Provide the affected version, platform, impact, and a minimal reproduction using synthetic data through the agreed channel. There is no published response-time commitment or bug-bounty program.

## Security expectations

- Keep credential handling in the backend; do not expose secrets or raw session data through IPC or logs.
- Preserve renderer sandboxing, context isolation, navigation restrictions, and validated IPC inputs.
- Bound file reads and subprocess/network operations; reject untrusted redirect destinations for authenticated requests.
- Make configuration changes explicit, reversible, and limited to owned integration entries.
- Treat the development preview as a local tool; do not expose it on a public network.

Windows packages currently lack publisher signing; macOS packages lack Developer ID signing and notarization. Version 2.1.1 passed native build and desktop checks on Windows, macOS and Linux; these checks do not provide publisher signing or notarization. These limitations should remain visible rather than being bypassed through disabled operating-system protections.

No long-term support or security-backport schedule is promised. Reports should identify the affected revision and, where practical, whether the issue reproduces with the current source.
