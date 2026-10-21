> English translation. The Chinese canonical version is the root `CHANGELOG.md` file. This translation may lag behind the Chinese canonical version.

# Changelog

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows SemVer.

## [codex-receiver-v0.1.0-alpha.1] - 2026-10-22

### Added

- Added the optional experimental `codex-receiver/` CLI receiver source package to the existing public repository (not part of the DSH bundle; no auto-start/login/target expansion).
- Exact export approval: direct human approval, MIT; source pinned to `c1da0015ab46e0ea9b6be154428c94c69d7d42ad`; 7 Codex modules + 2 sanitized tests + documentation/manifest/LICENSE.
- Public integration baseline is `dsh-local-bridge` alpha.6 (`04e6993`); public `src/` is **not overwritten**; the in-package `src/` is only the optional package's alpha.6 dependency baseline.
- Tests: optional package 23/23 PASS (Node 24.15); root DSH suite 82/82 PASS; CI adds a Node 24.15 optional-package job.

### Notes

- No npm publication, official Codex marketplace/plugin mounting, or new repository; no probe/MCP manifest.
- Real third-party cold install, sign-out/reboot recovery, multi-day soak, and broad upgrade matrices remain NOT_RUN; no turnkey claim.
- Historical executor-cell FAIL and sender-fixture escaping failure remain preserved; raw logs are not published.

## [0.1.0-alpha.6] - 2026-10-21

### Added

- Bounded-backoff auto-restart of the managed Hub child after an unexpected exit (1s→2s→5s→10s→30s, up to 10 attempts); only the plugin-owned Hub is restarted, external Hubs are reused and never stopped.
- Read-only `service-status` CLI and `bridge_service_status` DSH tool: Hub health, connection state, managed-Hub restart count/next retry/last exit, receiver status.
- Companion health/recovery documentation.

### Notes

- Lifecycle resilience and read-only visibility only; message protocol, pairing, and receiver behavior are unchanged.
- After the retry cap the status exposes `auto_restart_halted` instead of retrying forever.
- Codex is still not publicly exported.

## [0.1.0-alpha.5] - 2026-10-21

### Added

- Read-only receiver status now tolerates daily mode: `mode=daily`, `enabled`, and `expires_at=null` are not treated as expired; rolling submission counters, `next_eligible_at`, heartbeat/pidAlive, and reason codes are exposed.
- Recognizes `BACKOFF`, `RATE_LIMITED`, `PAUSED_UNCERTAIN`, and `DISABLED`; `RATE_LIMITED` is described as a delay, not termination.
- `check` reports receiver status per paired Codex target; a legacy global codex adapter conflict is visible but never stopped or replaced.
- `status` delivery hints cover daily/rate-limited/backoff/paused states.
- Tests cover daily null expiry, rolling counters, rate limit/backoff/pause, multiple receivers, and legacy compatibility.

### Notes

- Read-only DSH integration only; no receiver implementation, start, renewal, or PCA reserved-lane edit.
- No automatic ACK/reply; the receiver lifecycle itself remains PCA-lane work.

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
