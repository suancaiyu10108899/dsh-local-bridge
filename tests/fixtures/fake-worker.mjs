import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const output = process.env.FAKE_WORKER_OUT;
const statusPath = process.env.FAKE_WORKER_STATUS;
const args = process.argv.slice(2);
const nonce = args[1] ?? null;
const record = {
  pid: process.pid,
  args,
  thread: process.env.CODEX_THREAD_ID ?? null,
  cwd: process.cwd(),
};
if (output) fs.writeFileSync(output, JSON.stringify(record));

let realIdentity = null;
if (process.env.FAKE_WORKER_REAL_IDENTITY === '1') {
  try {
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${process.pid}"; if ($p) { [pscustomobject]@{ created_at = $p.CreationDate.ToUniversalTime().ToString('o'); exe_path = $p.ExecutablePath } | ConvertTo-Json -Compress }`;
    const parsed = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5_000 }).trim());
    realIdentity = { created_at: parsed.created_at, exe_path: parsed.exe_path, entry_path: path.resolve(import.meta.filename) };
  } catch {
    realIdentity = null;
  }
}

function writeStatus() {
  if (!statusPath) return;
  const status = {
    schema_version: 3,
    installation_id: process.env.FAKE_WORKER_INSTALLATION_ID ?? null,
    instance_id: process.env.FAKE_WORKER_INSTANCE_ID ?? null,
    thread_id: process.env.FAKE_WORKER_THREAD_ID ?? null,
    binding_epoch: process.env.FAKE_WORKER_BINDING_EPOCH ?? null,
    worker_nonce: nonce,
    enabled: true,
    status: process.env.FAKE_WORKER_STATUS_STATE ?? 'ONLINE_IDLE',
    heartbeat_at: new Date(Date.now() + Number(process.env.FAKE_WORKER_HEARTBEAT_OFFSET_MS ?? 0)).toISOString(),
    pid: process.pid,
    owner_process: {
      pid: process.pid,
      created_at: realIdentity?.created_at ?? process.env.FAKE_WORKER_CREATED_AT ?? null,
      exe_realpath: realIdentity?.exe_path ?? process.env.FAKE_WORKER_EXE ?? null,
      entry_realpath: realIdentity?.entry_path ?? process.env.FAKE_WORKER_ENTRY ?? null,
      config_path: args[0] ?? null,
      nonce,
      thread_id: process.env.FAKE_WORKER_THREAD_ID ?? null,
    },
  };
  fs.writeFileSync(statusPath, JSON.stringify(status));
}
writeStatus();
const statusTimer = setInterval(writeStatus, 25);
statusTimer.unref?.();

// Cooperative stop marker used by the companion when identity is UNKNOWN.
const stopPath = statusPath ? path.join(path.dirname(statusPath), 'stop') : null;
if (stopPath) {
  const stopTimer = setInterval(() => {
    if (fs.existsSync(stopPath)) process.exit(0);
  }, 50);
  stopTimer.unref?.();
}

const exitMs = Number(process.env.FAKE_WORKER_EXIT_MS ?? 0);
if (exitMs > 0) {
  setTimeout(() => process.exit(0), exitMs);
} else {
  setInterval(() => {}, 1000);
}
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
