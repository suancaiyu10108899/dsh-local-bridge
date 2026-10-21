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
| Hub restart persistence | Supported | Foreground process; no service |
| Reversible plugin install/uninstall | Supported | Byte-level backups where safe |
| Multiple targets | Not supported | One target per message; no routing |
| Cross-machine / cloud | Not supported | Loopback only |
| GUI / settings UI | Not supported | CLI only |
| Unattended service / autostart | Not supported | Manual start |
| Codex native queue receiver | Experimental, excluded | Build-specific; separate lane |
| MCP App integration | Not supported | Separate experiment |
| Host-management tools | Not included in this alpha | Excluded to keep the supported surface small |
| Independent cold-machine validation | Not done | Please report your environment |

## Delivery semantics

- `accepted`: durably queued.
- `delivered`: target adapter acknowledged; for DSH, only after durable inbox write.
- A model turn starting is the host's responsibility; the bridge does not claim task completion.
- `delivery_unknown`: not proof of success — inspect before retrying manually.
