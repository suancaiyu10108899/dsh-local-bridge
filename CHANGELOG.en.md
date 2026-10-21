> English translation. The Chinese canonical version is the root `CHANGELOG.md` file. This translation may lag behind the Chinese canonical version.

# Changelog

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows SemVer.

## [0.1.0-alpha.4] - 2026-10-21

### Added

- The plugin now starts and manages a Hub child process by default; an existing Hub is reused and only a plugin-owned Hub is stopped on dispose.
- `manageHub: false` disables automatic management for external/manual operation.
- Added managed-hub unit tests (start, reuse, stop, state-file cleanup).

### Notes

- The Hub is still a separate process, but an installed bundle no longer requires the user to locate a node_modules CLI.
- Receiver enable/disable/renew and the Codex plugin remain outside this alpha.

## [0.1.0-alpha.3] - 2026-10-21

### Added

- DSH bundle manifest: `dsh.bundle.patch`, root plugin entry, `engines.dsh`; install via `dsh plugin --profile ... add github:<owner>/<repo>`.
- Installed bundles use `$DSH_HOME/local-agent-bridge/runtime`; source checkouts keep `.local/runtime`.
- Read-only `receiver-status`, plus receiver lifecycle warnings in `check` and `delivery_hint` in `status`.
- Documentation for bundle installation, runtime locations, and receiver status.

### Notes

- This alpha does not auto-start the Hub/receiver and does not implement enable/disable/renew. The PCA reserved lane is untouched.
- Codex native queue receiver, MCP App, and host-management remain outside the public support surface.

## [0.1.0-alpha.2] - 2026-10-21

### Changed

- Chinese is now the canonical documentation language; English is a marked translation that may lag.
- README and docs gained language switching/translation links.
- `CONTRIBUTING`, `SECURITY`, and `CHANGELOG` gained Chinese canonical versions plus English translations.
- Fixed the English README language-switch header newline.

### Notes

- No behavior/protocol/code changes in this release; documentation and version metadata only. CI still runs Windows + Node 22/24.
- Codex native queue receiver, MCP App, and host-management modules remain outside the public support surface.
## [0.1.0-alpha.1] - 2026-10-21

### Added

- Local loopback hub with durable queue, TTL, retries, dedupe, pairing allowlist, and audit events.
- CLI: `init`, `send`, `status`, `pair`, `consume`, `check`, `install-dsh-plugin`, `uninstall-dsh-plugin`, `dsh-plugin-status`, `module-watch-status`.
- DSH host plugin: inbound delivery via durable inbox ACK, outbound `bridge_send` / `bridge_status` / `bridge_targets`.
- Reversible DSH profile installation with backups and byte-level rollback where safe.
- Core tests for hub, protocol, store, client startup, plugin, and installation.
- Public alpha documentation.

### Known limitations

- Windows only in this alpha; tested against DSH Desktop 0.2.1-rc.2.
- One machine, one OS user; manual pairing; no GUI.
- Codex native queue receiver is excluded from this alpha.
- Codex native queue receiver, MCP App, and host-management modules are excluded.
- No independent cold-machine validation; support is best-effort.
