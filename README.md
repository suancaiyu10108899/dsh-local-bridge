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
- Not an unattended Codex bridge. The Codex native queue receiver is experimental, build-specific, and **excluded from this alpha**.
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
```

CLI operations:

```powershell
node bin/lab-bridge.mjs send --to 'dsh:session-<session-id>' --text 'hello through the bridge'
node bin/lab-bridge.mjs status --msg-id <message-id>
node bin/lab-bridge.mjs consume --msg-id <message-id> --consumer 'dsh:session-<session-id>' --note 'handled'
```

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
- Codex native queue receiver is excluded from this alpha.
- Experimental Codex native queue receiver, MCP App, and host-management modules are excluded from this alpha.
- No independent cold-machine validation yet.
- API and state formats may change between 0.x releases.
- Support is best-effort; there is no SLA.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Operations](docs/OPERATIONS.md)
- [Capability matrix](docs/CAPABILITY-MATRIX.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Contributing

Early feedback and small fixes are welcome. Start with an issue before a large PR. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
