# Contributing

Start with the [README](README.md), [development guide](docs/DEVELOPMENT.md), and [provider support](docs/PROVIDERS.md). Keep changes focused and explain the user-visible problem they solve.

## Before a pull request

1. Reproduce the issue with synthetic data where possible.
2. Make the change without modifying your real assistant credentials or settings as part of a test.
3. Run `npm test` and `npm run build`. Run the relevant browser or native smoke test for UI/window changes.
4. Update documentation when provider capabilities, configuration, or behavior changes.
5. Describe the before/after behavior, validation performed, and platforms you actually tested.

Use meaningful tests for changed parsing, attribution, privacy boundaries, or native behavior. A Windows result does not validate macOS/Linux behavior; distinguish configured support from a successful native check.

## Provider changes

Use official provider documentation or source to justify detected authentication formats and API behavior. Never infer a working state from a process count alone, assign a shared client process to an account without evidence, or substitute guessed quota/context values for unavailable data. Keep each task's context attached to its own session.

Use synthetic credentials and transcripts in fixtures. Preserve existing status-line commands and hooks when changing Claude integration, and test restore behavior. Never log or return credentials, raw command lines, or conversation transcripts to the UI.

## Repository hygiene

Do not commit build output, release executables, local screenshots with private task names, logs, dependency directories, credential files, or personal environment settings. Review changes before committing even when an ignore rule exists. Provider assets need attribution in the appropriate assets documentation; do not assume third-party marks are covered by application licensing.

A useful issue includes the app version, OS/architecture, package type, reproduction steps, and expected versus observed behavior. Redact sensitive material. For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) rather than posting an exploit with private data in a public issue.
