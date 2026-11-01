> English translation. The Chinese canonical version is `docs/CAPABILITY-MATRIX.md`. This translation may lag behind the Chinese canonical version.

# Capability matrix (public alpha)

| Capability | Status | Notes |
|---|---|---|
| Local hub, loopback + token | Supported | Single OS user |
| Durable queue/state/events | Supported | `.local/runtime/hub/` |
| Pairing allowlist | Supported | Manual; unpaired send/receive rejected |
| CLI send/status/consume/pair | Supported | Windows PowerShell examples |
| DSH host plugin + tools | Supported | Tested against DSH Desktop 0.2.1-rc.2 |
| DSH inbound delivery + wake | Supported | Delivery ACK after durable inbox event |
| DSH↔DSH cross-session messaging | Supported | Manual pairing; one machine |
| Retry/TTL/dedupe | Supported | Retry does not prove delivery |
| Hub restart persistence | Supported | COMPANION_OWNED may manage/restart its own Hub; legacy/source-link may use a foreground CLI; no Windows Task |
| Reversible plugin install/uninstall | Supported | Byte-level backups where safe |
| Managed Hub / companion lifecycle | Supported (default for installed mode) | Detached companion ensures/reuses/bounded-restarts Hub; explicitly ENABLED receiver members restored; no Windows Task/login entry |
| Receiver enable/disable/renew | Supported (owner-only) | Explicit receiver-control operation by the real original owner; COMPANION_OWNED restores only ENABLED members |
| Multiple targets | Not supported | One target per message; no routing |
| Cross-machine / cloud | Not supported | Loopback only |
| GUI / settings UI | Not supported | CLI only |
| Unattended service / autostart | Not supported | No Windows Task/login item; DSH open may ensure companion, but the host does not self-start |
| Codex native queue receiver | Experimental; source/worker shipped, disabled by default | `codex-receiver/` MIT shared core/worker/metadata; real original-owner opt-in/enable required; no marketplace |
| MCP App integration | Not supported | Separate experiment |
| Host-management tools | Not included in this alpha | Excluded to keep the supported surface small |
| Independent cold-machine validation | Not done | Please report your environment |

## Delivery semantics

- `accepted`: durably queued.
- `delivered`: target adapter acknowledged; for DSH, only after durable inbox write.
- A model turn starting is the host's responsibility; the bridge does not claim task completion.
- `delivery_unknown`: not proof of success — inspect before retrying manually.
