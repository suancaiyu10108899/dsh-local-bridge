> English translation. The Chinese canonical version is `docs/ARCHITECTURE.md`. This translation may lag behind the Chinese canonical version.

# Architecture

This document describes the public alpha architecture. It intentionally covers only the DSH-side bridge.

## Components

1. **Hub** (`src/hub.mjs`, `hub/main.mjs`)
   - TCP server bound to `127.0.0.1`.
   - Token-authenticated messages.
   - Durable state in `.local/runtime/hub/` (`state.json`, `events.jsonl`).
   - Per-message lifecycle: `queued` → `delivering` → `delivered` / `delivery_unknown` / `failed` / `expired`.
   - Retries with backoff, dedupe by message id, TTL expiry, pairing allowlist.
   - Delivers only to a connected adapter of the target role when the target identity is paired and enabled.

2. **DSH host plugin** (`adapters/dsh/plugin.mjs`)
   - Cordis module loaded by a profile patch.
   - Registers outbound tools (`bridge_send`, `bridge_status`, `bridge_targets`) with the host.
   - Receives inbound deliveries from the hub and calls the host's `agent.followup` for the exact live DSH session.
   - Waits for the durable inbox event (`agent/inbox/spliced`) before acknowledging delivery.
   - Reconnects every few seconds if the hub is unavailable; an optional hub must never crash the host.

3. **CLI** (`bin/lab-bridge.mjs`)
   - `init`, `check`, `send`, `status`, `pair`, `consume`.
   - Reversible profile installation: `install-dsh-plugin`, `uninstall-dsh-plugin`, `dsh-plugin-status`, `module-watch-status`.

## Delivery semantics

- Hub acceptance (`accepted`) only means the message is durably queued.
- `delivered` means the target adapter acknowledged; for DSH it is sent only after the durable inbox event is observed.
- Starting a model turn is a property of the host's `agent.followup`; the bridge reports delivery, not task completion.
- A cold/unloaded DSH session returns a retryable `session-not-live` result; the message stays queued instead of consuming attempts.
- `delivery_unknown` means the hub cannot prove delivery; do not pretend it succeeded.

## Trust boundary

- Loopback-only listener; no remote HTTP/WS API.
- Bearer token in `.local/`; never commit it.
- Pairing is the authorization allowlist. Identity strings are local identifiers, not cryptographic identities.
- The plugin runs inside the DSH host process; profile edits are made only by the installer, with backups.

## State layout

```text
.local/
  runtime/
    hub/        # config, token, state.json, events.jsonl
    dsh-plugin/ # install backups, module-watch state, plugin.log
```

`.local/` is gitignored and is the only place runtime secrets/state should live.

## Non-goals for this alpha

- Codex native queue receiver and MCP App experiments.
- Multi-target routing, cross-machine transport, multi-user isolation.
- Background service installation or GUI.
- Strong identity/authentication beyond the local token and pairing allowlist.
