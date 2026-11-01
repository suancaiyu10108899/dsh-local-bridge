# Restricted-client rollback and old-Hub handover

Status: implemented alpha procedure, exercised in isolated audits; live rollback/handover still requires an explicit maintenance window and independent review. The old Hub token is never copied or re-created.

## Invariants

- Stop the new Hub/companion before handing ownership to an older Hub.
- Never restore an older Hub `state.json`/snapshot over the current runtime: it can erase newer client records and make already-submitted requests look re-deliverable.
- Never copy or back up the old Hub token; the original runtime/token stays in place.
- Keep client request/reply files and audit evidence. Quarantine them before old code can see messages; old code must not role-deliver `from_role=client` records.
- Do not claim DOT/cloud delivery from a local mailbox result.

## Pre-handover audit (read-only)

```powershell
$rt = 'D:/path/to/current/hub-data'
node bin/lab-bridge.mjs client rollback-audit --runtime $rt
```

This reports active client messages and request files, their states/hashes, and explicitly states `token_touched:false` and `old_state_snapshot_restored:false`. It does not start or stop a Hub.

## Quarantine (offline, confirmed)

1. Stop new submissions/Hub/companion explicitly (the new companion stop path, not a blind process kill).
2. Run the confirmed offline quarantine. Without `--confirm` it is a plan only.

```powershell
node bin/lab-bridge.mjs client rollback-quarantine --runtime $rt --confirm
```

The helper:

- transitions non-terminal client messages to `failed` with `rollback_quarantined_at` and `rollback_previous_state`;
- marks non-terminal client request records `ROLLBACK_QUARANTINED`, preserving the previous state, request/reply files and body hash;
- writes a separate `clients/rollback-audit-<timestamp>.json` with counts/actions;
- does not read/copy the token, restore a state snapshot, or delete data.

If the audit reports corrupt/unknown files, stop and inspect; do not overwrite them.

## Start older Hub

- Start the old Hub against the **same runtime** only after quarantine confirms no active client messages remain.
- Old Hub does not understand scoped client grants/roles; it must reject/ignore client credentials. It must not be given a copied token or a second runtime.
- Verify no `from_role=client` message is `queued/delivering/delivery_unknown`; verify the new `clients/` directories remain intact.
- Record process identity, command, lock/token path, and audit hashes. Do not claim success merely from `startup.json`.

## Roll-forward

To return to the new version later: start the new companion/Hub on the same runtime, review `ROLLBACK_QUARANTINED` records as terminal evidence, and create fresh client requests. Do not reuse quarantined request IDs or auto-convert them to queued.

## Remaining live gates

Actual handover execution, HKCU Run exact-value verification, token ownership review, and real dot acceptance remain explicit review steps; this document and helper do not perform them.