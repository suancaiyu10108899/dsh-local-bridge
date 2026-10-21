> English translation. The Chinese canonical version is the root `CONTRIBUTING.md` file. This translation may lag behind the Chinese canonical version.

# Contributing

Thanks for looking. This is an early alpha; small, focused contributions are most useful.

## Before you start

- Read the README and the "Limitations" section.
- For a bug, open an issue first with:
  - what you expected;
  - what happened;
  - steps to reproduce;
  - OS, Node version, DSH version;
  - the relevant error text **without tokens, `.local/` contents, or personal paths**.
- For a feature, open a short issue describing the user problem before writing code. Large unsolicited PRs may be declined to keep the alpha scope small.

## Development setup

```powershell
node --version   # 22 or 24
node --test
```

The test suite uses temporary directories and does not require a running hub or a real DSH profile. Do not commit `.local/`, logs, tokens, or machine-specific paths.

## Pull requests

1. Keep the change small and focused.
2. Add or update tests for behavior changes.
3. Update `CHANGELOG.md` for user-visible changes.
4. Run `node --test` and make sure it passes.
5. Describe the change and the limitation/risk it introduces.

## Scope rules

- This alpha supports DSH-side messaging only.
- Do not add Codex native queue receiver, MCP App, multi-target, unattended service, or GUI claims without a separate design discussion.
- "Delivered" means the target conversation received the message and a model turn started; do not redefine it as "task completed".

## Support expectations

Best-effort, no SLA. Response may take weeks. Please be patient and keep discussions technical.
