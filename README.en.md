[简体中文](README.md) | English

> English translation. The canonical documentation is [简体中文](README.md). This translation may lag behind the Chinese canonical version.

# DSH Local Bridge

> Durable, same-machine messaging between DeepSeek Harness (DSH) conversations, using a small local hub and a DSH host plugin.

**Status: alpha / research preview.** This is a personal, Windows-focused project, not a polished product. The supported surface is deliberately narrow. Read [What this is not](#what-this-is-not) before using it.

## What this is

- A **local hub** on `127.0.0.1` with durable state, message TTL, retries, dedupe, pairing, and an audit event log.
- A **DSH host plugin** that delivers inbound messages into the exact live DSH conversation and exposes `bridge_send`, `bridge_status`, and `bridge_targets` tools.
- A **CLI** for hub lifecycle, pairing, sending, status, consumption, and reversible plugin install/uninstall.
- Built for one OS user running multiple DSH conversations on the same Windows machine.

Successful delivery means "the target DSH conversation received the message and a model turn was started". Message acceptance alone is not delivery proof.

## What this is not

- Not a universal agent-to-agent protocol.
- Not a cross-machine, cloud, or multi-user service.
- Not an unattended Codex bridge. The Codex native queue receiver is experimental and build-specific; **the DSH bundle excludes it**. The public repository contains a separate optional source package that users must review, install and run themselves.
- Not a GUI or a hosted product.
- No guarantee of compatibility with DSH versions other than the tested build.
- No promise of "open box" support for every DSH conversation.

## Architecture

```text
DSH conversation A
  └─ host plugin (outbound tool) ──┐
                                   ▼
                            local hub (127.0.0.1)
                            durable queue, pairing,
                            retries, TTL, audit
                                   ▲
DSH conversation B                │
  └─ host plugin (inbound delivery, durable inbox ACK)
```

The hub listens on loopback only. Pairing is an explicit allowlist: an unpaired identity cannot send or receive. Runtime state (token, queue, logs, plugin backups) lives under `.local/` and is never committed.

## Requirements

- Windows 10/11 (tested; other platforms are not supported in this alpha).
- Node.js 22 or 24.
- DSH Desktop 0.2.1-rc.2 (tested build; other versions may work but are unverified).
- One OS user; one machine.

## Quickstart

Replace `<session-id>` with an actual DSH session id. Run commands from the repository root.

```powershell
node --test

# Create local runtime config (token, hub state directory)
node bin/lab-bridge.mjs init

# Terminal 1: run the hub and keep it running
node hub/main.mjs

# Terminal 2: verify reachability and pair a DSH conversation
node bin/lab-bridge.mjs check
node bin/lab-bridge.mjs pair add 'dsh:session-<session-id>' --label 'DSH session'

# Install the DSH host plugin (reversible; writes backups before editing the profile)
node bin/lab-bridge.mjs install-dsh-plugin
node bin/lab-bridge.mjs dsh-plugin-status
```

From a paired DSH conversation:

```text
bridge_send to='dsh:session-<session-id>' text='hello'
bridge_status msg_id='<message-id>'
bridge_service_status
```

CLI operations:

```powershell
node bin/lab-bridge.mjs send --to 'dsh:session-<session-id>' --text 'hello through the bridge'
node bin/lab-bridge.mjs status --msg-id <message-id>
node bin/lab-bridge.mjs consume --msg-id <message-id> --consumer 'dsh:session-<session-id>' --note 'handled'
node bin/lab-bridge.mjs service-status
```

## Install as a DSH bundle (alpha)

The DSH plugin manager can install this bundle from GitHub or a local path. After installation the plugin **starts and manages the Hub automatically** (an existing Hub is reused; set `manageHub: false` to manage it yourself). The Hub is still a separate child process, but users no longer need to locate a CLI under node_modules. If the child exits unexpectedly, the companion restarts it with bounded backoff; an existing/external Hub is reused and never stopped.

> The plugin manager needs `pnpm`. If the CLI reports `pnpm not found`, install pnpm first or use the Desktop Plugins page install entry. Installation performs version/build checks and may ask for confirmation.

```powershell
# GitHub (requires DSH 0.2.1-rc.2; the bundle declares engines.dsh)
dsh plugin --profile web add github:suancaiyu10108899/dsh-local-bridge

# or a local checkout
dsh plugin --profile web add D:\Dev\dsh-local-bridge-public

# Installed bundles use $DSH_HOME/local-agent-bridge/runtime for mutable state.
$cli = "$env:USERPROFILE\.dsh\profiles\web\node_modules\.bin\dsh-local-bridge.cmd"
& $cli init       # first run only; managed Hub startup also creates config/token
& $cli pair add 'dsh:session-<session-id>' --label 'DSH session'
& $cli check      # diagnostics; no manual `serve` when the plugin manages the Hub
& $cli service-status
```

With `manageHub: false`, start the Hub explicitly with `& $cli serve`.

With a local `link:` checkout, runtime stays in the checkout's `.local/runtime`; keep using the source quickstart above.

## Optional Codex receiver (experimental, not part of the DSH bundle)

`codex-receiver/` in this repository is a standalone optional CLI receiver source package, exported from the approved exact Codex source allowlist (MIT, source `c1da001`). The DSH bundle does **not** install or start it, create a login entry, or expand targets.

- Requirements: same-user Windows, Node `>=24.15.0`, a user-installed Codex CLI; `node:sqlite` and rollout format are version-sensitive.
- Entry point and limits: [codex-receiver/README-CODEX.md](codex-receiver/README-CODEX.md).
- Test separately: `node --test codex-receiver/tests/*.test.mjs`.
- No npm publication or official Codex marketplace/plugin mounting; real third-party cold install, sign-out/reboot recovery, multi-day soak, and broad upgrade matrices remain NOT_RUN.

## Uninstall

```powershell
node bin/lab-bridge.mjs uninstall-dsh-plugin
```

The installer keeps byte-level backups and only removes its own profile rows. If the profile was edited externally, the installer refuses to overwrite the conflict and asks for manual review.

## Security model

- Hub listens on loopback only; no remote listener.
- A per-hub 64-hex token protects the control/data connection.
- Pairing is an explicit allowlist; unpaired senders/targets are rejected.
- `.local/` contains tokens, queue state, and logs; it is gitignored.
- Do not share `.local/` or paste its contents into issues.

## Limitations (alpha)

- One machine, one OS user; not a service.
- Manual pairing; no discovery wizard.
- CLI only; no GUI.
- DSH profile mutation is version-sensitive; keep the generated backups.
- The DSH bundle excludes the Codex native queue receiver; the repository provides a separate experimental optional source package, not a default install.
- The DSH bundle excludes the experimental Codex native queue receiver; MCP App and host-management modules are excluded. An optional Codex receiver source package is present in `codex-receiver/` with its own experimental limits.
- No independent cold-machine validation yet.
- API and state formats may change between 0.x releases.
- Support is best-effort; there is no SLA.

## Documentation

- [Architecture](docs/en/ARCHITECTURE.md)
- [Operations](docs/en/OPERATIONS.md)
- [Capability matrix](docs/en/CAPABILITY-MATRIX.md)
- [Contributing](CONTRIBUTING.en.md)
- [Security policy](SECURITY.en.md)

## Contributing

Early feedback and small fixes are welcome. Start with an issue before a large PR. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
