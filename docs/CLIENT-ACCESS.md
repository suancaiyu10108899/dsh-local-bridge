# Scoped client access（dot / restricted client）

Status: integrated local feature in this alpha source, with Hub/DSH plugin/receiver v2 mailbox support. A local Codex owner-visible MRI request/reply has been validated end to end through the real model mailbox. This is a narrow owner-created client credential path, not a general agent protocol, adapter, or cloud dot delivery guarantee. The currently loaded DSH host has not loaded the new plugin, and real dot cloud business acceptance remains unverified.

## Identity and secret boundary

- Client identity: `client:dot-<uuid>`.
- A client is never `cli:operator`, `dsh:*` or `codex:*`; it never replaces an existing pair/adapter.
- The existing Hub token stays local in the current runtime. It is never copied, printed or given to a client.
- A scoped credential is stored only under `<runtime>/clients/secrets/<grant_id>.secret`; CLI output contains only grant/identity/target IDs and the credential file path.
- Scoped client commands use the Hub endpoint config (host/port) and their own credential. They do not read the admin Hub token.
- A client can only request an explicitly granted, already paired exact `dsh:*`/`codex:*` target. It cannot pair, query global targets/status, consume, or send as another identity.
- The receiver owner separately opts a client in via `allowed_clients` (default empty). A client-only target is allowed for daily target-pull; no DSH sender is invented.

## CLI

```powershell
$rt = 'D:/path/to/current/hub-data'

# Owner creates a scoped grant; the secret is written locally and never printed.
node bin/lab-bridge.mjs client grant --runtime $rt `
  --client 'client:dot-<uuid>' --targets 'codex:<thread-id>' `
  --lease-minutes 2 --ttl-minutes 60 --max-requests 32 --max-submits 16

node bin/lab-bridge.mjs client request --runtime $rt `
  --grant '<grant-id>' --credential-file '<credential-file>' `
  --to 'codex:<thread-id>' --request-id '<request-id>' --text-file '<request.text>'

node bin/lab-bridge.mjs client status --runtime $rt `
  --grant '<grant-id>' --credential-file '<credential-file>' --request-id '<request-id>'
node bin/lab-bridge.mjs client resume --runtime $rt `
  --grant '<grant-id>' --credential-file '<credential-file>' --request-id '<request-id>'
node bin/lab-bridge.mjs client cancel --runtime $rt `
  --grant '<grant-id>' --credential-file '<credential-file>' --request-id '<request-id>'

node bin/lab-bridge.mjs client revoke --runtime $rt --grant '<grant-id>' --reason 'owner stop'
node bin/lab-bridge.mjs client list-grants --runtime $rt
```

Trusted local receiver/operator reply path (admin token, never a client credential):

```powershell
node bin/lab-bridge.mjs client reply --runtime $rt `
  --client 'client:dot-<uuid>' --request-id '<request-id>' `
  --request-msg-id '<request-msg-id>' --target 'codex:<thread-id>' `
  --turn-id '<actual-turn-uuid>' --body-file '<reply.txt>'
```

The receiver v2 `client-reply` frame uses `request_msg_id`; the CLI accepts `--msg-id` as a legacy alias. Reply ACK includes request/target/client IDs, `reply_msg_id`, `body_sha256`, `bytes`, the original actual `turn_id`, and `idempotent`. Same body returns the original reply; different body conflicts. No fabricated turn UUID is accepted.

## Lifecycle

Hub intake and target-native submission are distinct:

1. Hub intake: `SUBMITTING` (persisted before enqueue) → `QUEUED`; `DELIVERED` is a transport compatibility state, not proof the target ran native.
2. Receiver target-pull: `CLAIMED` with a short lease/fence. An unexpired claim cannot be stolen; an expired `CLAIMED` lease can be reclaimed before begin. `SUBMITTING`/`NATIVE_QUEUED`/`UNCERTAIN` never return to queue.
3. Native boundary: `client-begin-submit` atomically checks fresh target pairing/enabled state, `target_binding_epoch`, grant/revoke/expiry and the grant submit budget, then writes conservative `SUBMITTING`. After this boundary cancel/revoke/expiry cannot release/requeue; the receiver persists local SUBMITTING before calling native.
4. Outcomes: `NATIVE_QUEUED` requires a real native queue ID and is idempotent; `UNCERTAIN` never auto-retries; `NOT_SUBMITTED` is terminal for known no-native cases and also finalizes the corresponding Hub message as `failed` with `client-not-submitted` (idempotent, never delivered/requeued).
5. Reply: `REPLY_READY` after the actual target turn. Completed replies do not consume `max_pending` slots.

`client cancel` works while the request is still before the native begin boundary (`QUEUED`, transport `DELIVERED`, or pre-begin `CLAIMED`). It returns `client-cancel-too-late` after begin. A repeated `NOT_SUBMITTED`/cancelled request is not reclaimable.

## v2 receiver control RPC

New Hub welcome:

```json
"capabilities": { "client_requests_v1": true }
```

Local trusted receiver/operator connections use:

- `client-claim` → `client-claim-result`
- `client-begin-submit` → `client-begin-submit-result`
- `client-outcome` → `client-outcome-result`
- `client-reply` → `client-reply-result`

Shared fields: `client_identity`, `client_request_id`, `request_msg_id`, `target_identity`; begin/outcome carry `lease_id`, `fencing_token`. `client_request_id` is the business ID; frame `request_id` is transport correlation only. Old `client-request-*` names are accepted as legacy aliases; new code uses v2. Old Hub without `client_requests_v1` fails closed.

`client → codex` is never role-pushed to a legacy codex adapter; the receiver must target-pull and claim. Legacy DSH → Codex role delivery remains unchanged. DSH client delivery is gated in the plugin: claim and begin happen before `Agent.followup`; `NATIVE_QUEUED` is reported only after durability; known no-native cases report `NOT_SUBMITTED`.

## Receiver owner opt-in

The receiver config keeps its existing DSH `allowed_senders` and may add explicit `allowed_clients`. The target owner enables only exact client identities; default is empty. Existing DSH senders are not replaced, and no client is auto-allowed. Grant total `max_requests`/`max_submits` and `max_pending` prevent unlimited sequential model submissions.

## Rollback / handover

Use:

```powershell
node bin/lab-bridge.mjs client rollback-audit --runtime $rt
node bin/lab-bridge.mjs client rollback-quarantine --runtime $rt --confirm
```

This is offline, stat-only for the token, never copies/hashes token content, never restores an old whole runtime snapshot, and preserves client request/reply evidence. See [CLIENT-ROLLBACK.md](CLIENT-ROLLBACK.md).

Limits: one local Codex MRI request/reply has been validated; real dot cloud acceptance and the new-plugin DSH host load remain unverified. No production cutover or broader cloud dot/V1 business acceptance is claimed.