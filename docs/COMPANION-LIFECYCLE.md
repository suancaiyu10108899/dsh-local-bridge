# DSH companion lifecycle

Status: local experimental. A DSH host may ensure one background companion that owns the local Hub and explicitly enabled receivers. It does not add a Windows boot task; opening DSH may start it, and DSH closing must not stop it.

## What starts what

- Installed `COMPANION_OWNED` installation: DSH plugin startup calls `ensureBootstrap()` once, fire-and-forget. If no verified owner exists, it starts one detached `companion/main.mjs`; if one exists, it attaches/reuses it. It never starts a second Hub/token/runtime.
- `COMPANION_OWNED` requirement: an existing installation locator/runtime is required. Legacy runtimes without a locator keep the existing in-process Hub-service fallback; bootstrap never invents a locator/token for them.
- `DSH_PLUGIN_OWNED`, `EXTERNAL_UNMANAGED`, `MANUAL`: bootstrap is attach/stop-only; it does not spawn a companion or take Hub ownership.
- No new Windows startup Task and no public port are created.

## Explicit lifecycle CLI

```powershell
$inst = 'D:/path/to/local-agent-bridge-install'
$rt = 'D:/path/to/current/hub-data'

node bin/lab-bridge.mjs companion status --installation $inst --runtime $rt
node bin/lab-bridge.mjs companion start  --installation $inst --runtime $rt
node bin/lab-bridge.mjs companion stop   --installation $inst --runtime $rt --reason 'owner explicit stop'
```

- `start` is the explicit path (`ensureBootstrap({explicitStart:true})`); it may clear a prior explicit-stop marker.
- `stop` writes a persistent explicit-stop marker and the existing `desired-state.json` signal first, then re-verifies the exact owner identity before signalling. It preserves runtime/token/config/messages/ledger/window/rate and never deletes a stale lock.
- After explicit stop, a later DSH startup's plain `ensureBootstrap()` does not auto-resume; use `companion start`/explicit clear to resume.
- Startup budget: the existing shared 3-starts/10-minute outer budget is charged; corrupt/exhausted budget pauses and requires review. No budget reset is performed by bootstrap.
- Unknown/unverified owner, incomplete identity, lineage mismatch, foreign Hub instance, runtime/env conflict, corrupt guard/launch/stop state: pause/review, never pidAlive-only takeover.

## Preserved data

Companion/Hub/receivers use the existing runtime and Hub token. Existing messages, ledger, windows, rate limits, no-login choices and explicitly enabled receivers are preserved. DSH host close only removes the host's in-memory connection; the detached companion/Hub continues. An explicit stop is the intended way to stop bridge processes.

## Limits

Alpha.7 installed COMPANION_OWNED cutover, existing-runtime reuse and explicit owner-enabled worker recovery have been exercised locally. The current DSH host has not loaded the new plugin; subsequent host open/close validation and real cloud dot business acceptance remain unverified. No Windows Task/login entry is created, 48h endurance is not claimed, and legacy manual Hub processes are not silently migrated.
## DSH startup and receiver opt-in semantics

- The DSH plugin calls `ensureBootstrap({reason:'DSH_START'})` once at host startup. If a verified owner exists it attaches; otherwise it may start one detached companion (COMPANION_OWNED, existing locator only). It does not create a new token/runtime or a Windows Task.
- `DSH_START` also resumes an **already explicitly enabled** receiver (`desired_state=ENABLED`, `enabled=true`, `owner_opt_in=true`) even when its persisted `launch.logon_eligible` is false. No-login opt-out only limits Windows logon autostart; opening DSH is a user action and must not be treated as an opt-out of the receiver.
- Explicit stop (`explicit-stop.json` / `desired-state STOPPED`), disabled membership, owner-opt-out, corrupt policy/launch state and unverified identity still block startup. DSH_START never clears explicit stop, never adds/removes a Windows login task, and never re-enables a disabled receiver.
- The companion launches the existing receiver worker/recovery path; it does not use receiver-service takeover or a second owner. Explicit stop now waits briefly for desired-state graceful shutdown (so the Hub child stops too) before a fallback signal.
- Manual legacy Hub ownership is preserved: no live process is silently migrated or killed. Runtime messages/ledger/token stay in place; profile backup is separate.

## Rollback/handover

Use the offline client rollback helper before an older Hub can see newer client records. Never restore an old whole-runtime state snapshot or copy the token. See [CLIENT-ROLLBACK.md](CLIENT-ROLLBACK.md).
