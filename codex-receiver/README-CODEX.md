# Optional Codex daily receiver — experimental

MIT licensed. Optional, experimental source package; review the limits and opt in explicitly.

This optional CLI companion targets an existing Codex conversation on the same Windows machine and OS user. It uses the installed native `codex queue` command. It is not a hosted service or a verified marketplace plugin. The DSH Hub remains a separate prerequisite managed by its own owner. Existing DSH installs are unchanged unless the user explicitly opts in.

Tested environment: Node 24.15.0, Windows, installed Codex CLI 0.163.0-alpha.11. `node:sqlite`, the owner's local `state_5.sqlite` row and that thread's rollout lifecycle format are version-sensitive prerequisites. Other builds require compatibility checks. Do not distribute any Codex executable, state database or chat transcript.

## Owner opt-in

From the original native Codex target conversation, use the receiver package root. Set no fabricated thread environment. Pair only the intended sender and target through the Hub's supported setup. Inspect the installed CLI's version and queue help first. Then:

```powershell
node adapters/codex/receiver-control.mjs prepare --sender dsh:session-<approved-session-id> --cli '<installed-codex.exe>'
node adapters/codex/receiver-control.mjs status '<config-path-returned-by-prepare>'
node adapters/codex/receiver-control.mjs enable '<config-path-returned-by-prepare>'
```

Preparation leaves the receiver disabled. Daily mode has no fixed expiry, defaults to six native submissions per rolling hour and a 30-second cooldown. No eligible messages means no model call. Rate limiting retains eligible backlog; normal message TTL still applies. `WAITING_FOR_TARGET_IDLE` is normal while the owner is busy. Target-pull registers no global Codex adapter. A legacy role-wide Codex adapter blocks this mode instead of being replaced.

Native queue acceptance, Hub consume and model receipt are separate events. Uncertain native outcomes pause without blind retry. Peer text is external AI data, never a new human grant or approval. Allowlisted sender IDs and self-reported local binding do not provide independent host authentication against another process running as the same OS user.

## Stop and uninstall

```powershell
node adapters/codex/receiver-control.mjs disable '<config-path>'
```

Disable only affects that owner's worker/supervisor and exact owned login entry. Optional `enable CONFIG --login` creates one HKCU Run value for that target and a readable startup script; login recovery requires explicit opt-in. Real sign-out/reboot recovery remains NOT_RUN. Runtime files live under `.local/runtime/` unless configured otherwise. After disabling and confirming stopped, archive or remove only the owner's receiver directory; preserve the shared Hub, pairings, other targets, profiles and user histories.

## Privacy and limits

Hub and receiver runtime can contain full message text, identifiers, absolute paths, native receipts and local tokens. Do not publish them or upload logs automatically. The native message is submitted to the user's configured model service and may incur its usual model cost. This companion adds no cloud relay and provides no end-to-end encryption or multi-user authentication claim.

Supported claim: local Windows same-user experimental daily target-scoped reception, demonstrated busy-to-idle native wake in original conversations. No exactly-once business-action guarantee, unattended uptime guarantee, cross-device/cloud/multi-user support, generic Linux/macOS support, project/session creation, arbitrary thread control, or guaranteed compatibility with future builds.

Private baseline tests: 12 daily-specific and 146 whole-project tests passed at the recorded baseline. The sanitized candidate passed all 23 included tests against the pinned public alpha.6 core; these tests do not prove cold third-party host installation. NOT_RUN: independent third-party cold install/A9, real sign-out/reboot, long real-time soak, broad upgrade/rollback and host-build matrix, uninstallation after adversarial external edits, and official plugin/marketplace host mounting. Historical executor-cell wake failure and sender-fixture escaping failure remain history; no raw transcripts are included.
