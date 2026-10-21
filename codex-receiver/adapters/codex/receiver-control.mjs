// Owner-operated lifecycle. Only prepare/enable in the actual target thread.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROJECT_ROOT, writeJsonAtomic } from '../../src/runtime.mjs';
import { pidAlive, readJsonSafe } from '../../src/health.mjs';
import { validateReceiverConfig, UUID_RE, recordModelReceipt } from './queue-inbox.mjs';
import { ownBinding, binaryHash } from './daily-receiver.mjs';
import { recoverOwnLock } from './receiver-service.mjs';
import { installStartup, removeStartup } from './receiver-startup.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execute = promisify(execFile);
export function ownerRequired(thread) {
  if (!UUID_RE.test(thread ?? '') || process.env.CODEX_THREAD_ID !== thread) throw new Error('OWNER_THREAD_MISMATCH');
}
export function readConfig(file) { return { ...JSON.parse(fs.readFileSync(file, 'utf8')), config_path: path.resolve(file) }; }

export function receiverStatus(file, now = Date.now()) {
  const c = readConfig(file), stored = readJsonSafe(path.join(c.runtime_dir, 'status.json')) ?? {};
  const lock = readJsonSafe(path.join(c.runtime_dir, 'receiver.lock'));
  const serviceLock = readJsonSafe(path.join(c.runtime_dir, 'service.lock'));
  const serviceRunning = !!serviceLock && serviceLock.thread_id === c.thread_id && pidAlive(serviceLock.pid);
  const running = !!lock && lock.thread_id === c.thread_id && pidAlive(lock.pid);
  const heartbeat = Date.parse(stored.heartbeat_at ?? stored.at);
  const healthy = running && stored.instance_id === lock.instance_id && stored.pid === lock.pid &&
    Number.isFinite(heartbeat) && now - heartbeat < 60000;
  let status = stored.status ?? 'NOT_STARTED';
  if (!c.enabled) status = running ? 'STOP_REQUESTED' : 'DISABLED';
  else if (!running) status = serviceRunning ? 'RECOVERING_WORKER' : c.mode === 'daily' ? 'OFFLINE' : Date.parse(c.expires_at) <= now ? 'EXPIRED' : 'OFFLINE';
  else if (!healthy) status = 'UNRESPONSIVE';
  const ledger = readJsonSafe(path.join(c.runtime_dir, 'ledger.json'));
  const used = c.mode === 'daily' ? Object.values(ledger?.entries ?? {}).filter((e) => Date.parse(e.attempted_at) > now - 3600000).length : stored.used_native_submissions ?? null;
  return { ...stored, schema_version: 2, mode: c.mode ?? 'bounded', enabled: c.enabled, status, running, healthy,
    thread_id: c.thread_id, window_id: c.window_id, transport: c.transport ?? 'legacy-role-push',
    expires_at: c.mode === 'daily' ? null : c.expires_at, pid: running ? lock.pid : null,
    max_native_submissions: c.mode === 'daily' ? null : c.max_native_submissions,
    used_native_submissions: used, remaining_native_submissions: c.mode === 'daily' ? Math.max(0, c.rate_limit.max_submissions - used) : stored.remaining_native_submissions ?? null,
    service_pid: serviceRunning ? serviceLock.pid : null, service_running: serviceRunning,
    startup_enabled: readJsonSafe(path.join(c.runtime_dir, 'startup.json'))?.enabled === true,
    rate_limit: c.rate_limit ?? null, last_error: running ?
      (/^(PAUSED|BACKOFF|BLOCKED)/.test(status) ? stored.reason_code ?? stored.last_error ?? null : null) :
      c.enabled ? 'RECEIVER_NOT_RUNNING' : null };
}

export async function prepareDaily({ senders, cli, configPath, stateDb, runtimeRoot, perHour = 6,
  inspectCli = (file) => execute(file, ['queue', '--help'], { windowsHide: true, timeout: 10000, maxBuffer: 65536 }) }) {
  const thread = process.env.CODEX_THREAD_ID; ownerRequired(thread);
  const state = stateDb ?? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'state_5.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(state, { readOnly: true });
  let row;
  try { row = db.prepare('SELECT id,rollout_path,cwd,archived FROM threads WHERE id=?').get(thread); } finally { db.close(); }
  if (!row || row.archived) throw new Error('BINDING_CHANGED_OR_ARCHIVED');
  const runtime = runtimeRoot ?? path.join(PROJECT_ROOT, '.local', 'runtime', 'codex', thread);
  const file = configPath ?? path.join(runtime, 'receiver-config.json');
  const previous = fs.existsSync(file) ? readConfig(file) : null;
  if (previous && previous.thread_id !== thread) throw new Error('OWNER_TARGET_MISMATCH');
  const cliPath = path.resolve(cli ?? previous?.cli ?? '');
  if (!cli && !previous?.cli) throw new Error('CLI_PATH_REQUIRED');
  const allowed = [...new Set(senders ?? previous?.allowed_senders ?? [])].sort();
  if (previous?.mode === 'daily' && JSON.stringify([...previous.allowed_senders].sort()) === JSON.stringify(allowed) &&
      previous.cli === cliPath && previous.rate_limit?.max_submissions === perHour && previous.rollout_path === row.rollout_path &&
      previous.workspace === row.cwd) return { config_path: path.resolve(file), status: 'ALREADY_CONFIGURED', config: previous };
  const lock = readJsonSafe(path.join(runtime, 'receiver.lock'));
  if (lock && pidAlive(lock.pid)) throw new Error('DISABLE_BEFORE_RECONFIGURE');
  const help = await inspectCli(cliPath);
  if (!help.stdout.includes('--thread') || !help.stdout.includes('--message')) throw new Error('CLI_QUEUE_UNSUPPORTED');
  const c = { v: 2, mode: 'daily', transport: 'target-pull', enabled: false, thread_id: thread, allowed_senders: allowed,
    cli: cliPath, cli_sha256: binaryHash(cliPath), workspace: row.cwd, rollout_path: row.rollout_path,
    state_db: path.resolve(state), runtime_dir: path.resolve(runtime), activated_at: new Date().toISOString(), expires_at: null,
    window_id: crypto.randomUUID(), max_native_submissions: null, rate_limit: { max_submissions: perHour, window_ms: 3600000 },
    min_interval_ms: 30000, idle_settle_ms: 3000, poll_interval_ms: 2000, max_text_bytes: 12000, accept_backlog: true,
    allow_installed_cli_refresh: true, cli_install_root: path.dirname(path.dirname(cliPath)),
    binding_grade: 'HOST_ENV_SELF_REPORT + LOCAL_STATE_CORROBORATION; same-user owner opt-in, not independent host authentication' };
  validateReceiverConfig(c);
  if (previous) fs.copyFileSync(file, `${file}.backup-${Date.now()}`);
  writeJsonAtomic(file, c);
  return { status: 'PREPARED_DISABLED', config_path: path.resolve(file), config: c };
}

export async function enableDaily(file, { loginStartup = false } = {}) {
  const c = validateReceiverConfig(readConfig(file)); ownerRequired(c.thread_id);
  if (c.mode !== 'daily') throw new Error('PREPARE_DAILY_FIRST');
  await ownBinding(c);
  if (binaryHash(c.cli) !== c.cli_sha256) throw new Error('CLI_BINARY_CHANGED');
  const current = receiverStatus(file);
  if (current.running) {
    if (!current.healthy) throw new Error('EXISTING_RECEIVER_UNRESPONSIVE_NO_REPLACEMENT');
    if (!c.enabled) throw new Error('WAIT_FOR_DISABLE_TO_FINISH');
    if (loginStartup) await installStartup(c, file);
    return { ...receiverStatus(file), action: 'ALREADY_RUNNING' };
  }
  if (current.service_running) return { ...current, action: 'WORKER_RECOVERING' };
  const lockPath = path.join(c.runtime_dir, 'receiver.lock');
  if (fs.existsSync(lockPath)) {
    const lock = readJsonSafe(lockPath);
    if (!lock || lock.thread_id !== c.thread_id || pidAlive(lock.pid)) throw new Error('LOCK_REVIEW_REQUIRED');
    fs.renameSync(lockPath, `${lockPath}.stale-${Date.now()}`); // Own file only; never signal a PID.
  }
  recoverOwnLock(path.join(c.runtime_dir, 'service.lock'), c);
  const stop = path.join(c.runtime_dir, 'stop'); if (fs.existsSync(stop)) fs.unlinkSync(stop);
  writeJsonAtomic(file, { ...c, config_path: undefined, enabled: true });
  const instance = crypto.randomUUID();
  const out = fs.openSync(path.join(c.runtime_dir, 'stdout.log'), 'a'), err = fs.openSync(path.join(c.runtime_dir, 'stderr.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('./receiver-service.mjs', import.meta.url)), path.resolve(file), instance], {
      cwd: PROJECT_ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, err]
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { fs.closeSync(out); fs.closeSync(err); }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const status = receiverStatus(file);
    if (status.instance_id === instance && status.running) {
      if (loginStartup) await installStartup(c, file);
      return { ...receiverStatus(file), action: 'ENABLED' };
    }
    if (!pidAlive(child.pid)) throw new Error('RECEIVER_START_FAILED_SEE_STDERR');
    await wait(100);
  }
  throw new Error('RECEIVER_START_UNCONFIRMED_NO_RETRY');
}

export async function disableDaily(file) {
  const c = readConfig(file); ownerRequired(c.thread_id);
  writeJsonAtomic(file, { ...c, config_path: undefined, enabled: false });
  fs.writeFileSync(path.join(c.runtime_dir, 'stop'), new Date().toISOString());
  const deadline = Date.now() + 10000;
  while ((receiverStatus(file).running || receiverStatus(file).service_running) && Date.now() < deadline) await wait(100);
  await removeStartup(c);
  return { ...receiverStatus(file), action: 'DISABLED' };
}

export async function control(args) {
  const [command, ...rest] = args;
  if (command === 'prepare') {
    const senders = []; let cli, file, perHour = 6;
    for (let i = 0; i < rest.length; i += 2) {
      if (rest[i] === '--sender') senders.push(rest[i + 1]);
      else if (rest[i] === '--cli') cli = rest[i + 1];
      else if (rest[i] === '--config') file = rest[i + 1];
      else if (rest[i] === '--per-hour') perHour = Number(rest[i + 1]);
      else throw new Error('UNKNOWN_PREPARE_OPTION');
    }
    return prepareDaily({ senders: senders.length ? senders : undefined, cli, configPath: file, perHour });
  }
  const [file, msg, turn] = rest;
  if (!file) throw new Error('CONFIG_PATH_REQUIRED');
  if (command === 'enable') return enableDaily(file, { loginStartup: rest.includes('--login') });
  if (command === 'disable' || command === 'stop') return disableDaily(file);
  if (command === 'status') return receiverStatus(file);
  if (command === 'renew') {
    const c = readConfig(file); ownerRequired(c.thread_id);
    if (c.mode !== 'daily') throw new Error('PREPARE_DAILY_FIRST');
    return { status: 'RENEWAL_NOT_REQUIRED', mode: 'daily', expires_at: null };
  }
  if (command === 'receipt') return recordModelReceipt(readConfig(file), msg, turn, process.env.CODEX_THREAD_ID);
  throw new Error('UNKNOWN_RECEIVER_COMMAND');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  control(process.argv.slice(2)).then((r) => console.log(JSON.stringify(r, null, 2))).catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.message })); process.exitCode = 1;
  });
}
