# Changelog

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows SemVer.

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
