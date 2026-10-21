> English translation. The Chinese canonical version is `docs/OPERATIONS.md`. This translation may lag behind the Chinese canonical version.

# Operations

## Install / first run

```powershell
node --version        # 22 or 24
node --test
node bin/lab-bridge.mjs init
node hub/main.mjs     # terminal 1
node bin/lab-bridge.mjs check   # terminal 2
```

`init` creates `.local/runtime/hub/` with a token and empty state. Keep the hub running while using the bridge.

## Pairing

Pairing is required in both directions. A paired identity is allowed to send and receive.

```powershell
node bin/lab-bridge.mjs pair add 'dsh:session-<session-id>' --label 'DSH session'
node bin/lab-bridge.mjs pair list
```

To remove:

```powershell
node bin/lab-bridge.mjs pair remove 'dsh:session-<session-id>'
```

Use exact session ids. The CLI rejects unpaired senders and targets.

## Send / inspect

```powershell
node bin/lab-bridge.mjs send --to 'dsh:session-<session-id>' --text 'hello'
node bin/lab-bridge.mjs status --msg-id <message-id>
node bin/lab-bridge.mjs status --to 'dsh:session-<session-id>' --limit 10
```

`send` from the CLI uses the `cli` operator role. To declare (not impersonate) a source, use `--origin`; `--from codex:...` is intentionally rejected.

## Consume

If a recipient handles a message outside the plugin (for example, an active agent consumes it with official tools), record it:

```powershell
node bin/lab-bridge.mjs consume --msg-id <message-id> --consumer 'dsh:session-<session-id>' --note 'handled by host tool'
```

Consumption records responsibility; it does not itself prove the model processed the content.

## DSH plugin install / status / uninstall

```powershell
node bin/lab-bridge.mjs install-dsh-plugin
node bin/lab-bridge.mjs dsh-plugin-status
node bin/lab-bridge.mjs module-watch-status
node bin/lab-bridge.mjs uninstall-dsh-plugin
```

- Installation backs up the profile before adding the project's rows.
- Uninstall restores byte-for-byte when the file was not externally modified; otherwise it removes only the project's rows and reports a conflict.
- A different existing `hmr` row causes a `watch-row-conflict`; review manually instead of forcing.

## Hub lifecycle

- The hub is a foreground CLI process; there is no service/autostart in this alpha.
- State is durable across hub restarts.
- If the hub is down, the DSH plugin retries and the host keeps running. Starting the hub later is safe.

## Backup and recovery

Back up `.local/runtime/hub/` if you want to preserve queued messages and audit events. The token lives there too; treat backups as secrets.

Do not edit `state.json`/`events.jsonl` by hand while the hub is running.

## Troubleshooting

| Symptom | Check |
|---|---|
| `check` cannot reach hub | Is `node hub/main.mjs` running? Is the port free? |
| `source-unpaired` | Pair the sender identity (`pair add`), not just the target. |
| `target-unpaired` | Pair and enable the target identity. |
| `session-not-live` | The DSH conversation is not open/loaded; the message stays queued and is retried. |
| Plugin tools missing | Is the plugin installed and loaded? Check `dsh-plugin-status` and the plugin log. |
| Plugin install conflict | Profile was edited externally; follow the reported conflict instead of forcing. |
| Host crashed at startup without hub | This alpha should tolerate a missing hub; report with version/logs (no token). |

## Upgrade

1. Stop the hub and the host.
2. Keep a copy of `.local/`.
3. Update code.
4. Run `node --test`.
5. Start the host, then the hub.
6. Re-run `check` and `dsh-plugin-status`.

There is no automated migration in this alpha; state formats may change between 0.x versions.
