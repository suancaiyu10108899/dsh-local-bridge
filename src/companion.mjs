// Companion-owned worker management (COMPANION_OWNED mode).
//
// The companion is the sole restart owner for target workers. It spawns the
// target's daily-receiver entry directly; it never invokes receiver-service.mjs
// as a second supervisor. All state is local and no model call is made here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRestartPolicy } from './restart-policy.mjs';
import { listMemberships, targetKey } from './membership.mjs';
import { readProcessIdentity, sameProcess } from './process-identity.mjs';
import { readRestartSnapshot, restartSnapshotPath, writeRestartSnapshotAtomic } from './restart-state.mjs';

export const COMPANION_SCHEMA_VERSION = 1;

export class CompanionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CompanionError';
    this.code = code;
    this.details = details;
  }
}

/** Remove ambient process-location hints; the target config carries its binding. */
export function sanitizeWorkerEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.CODEX_THREAD_ID;
  // The companion is itself launched with LAB_BRIDGE_RUNTIME_DIR set for its
  // own Hub. A target worker with a bound installation rejects that override
  // as RUNTIME_INSTANCE_CONFLICT; never let it leak into the child.
  delete env.LAB_BRIDGE_RUNTIME_DIR;
  delete env.LAB_BRIDGE_INSTALLATION_ROOT;
  return env;
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function expectedThread(target) {
  return typeof target === 'string' && target.startsWith('codex:') ? target.slice('codex:'.length) : null;
}

function normalizePath(value) {
  let resolved;
  try { resolved = fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value); }
  catch { resolved = path.resolve(value); }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function createCompanion({
  installation,
  runtimeRoot,
  workerEntry,
  nodeExecutable = process.execPath,
  spawnProcess = spawn,
  env = process.env,
  workerCwd,
  stateRoot,
  locatorPath,
  log = () => {},
  now = Date.now,
  autoPoll = false,
  pollIntervalMs = 2_000,
  restartDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000],
  maxRestartAttempts = 10,
  stableMs = 5 * 60_000,
  failureWindowMs = 10 * 60_000,
  healthPollMs = 1_000,
  processProvider,
  policyWriter = writeRestartSnapshotAtomic,
} = {}) {
  if (installation === null || typeof installation !== 'object') throw new CompanionError('INSTALLATION_REQUIRED', 'companion requires an installation record');
  if (installation.hub_owner_kind !== 'COMPANION_OWNED') throw new CompanionError('COMPANION_MODE_REQUIRED', 'companion only manages workers in COMPANION_OWNED mode');
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)) throw new CompanionError('RUNTIME_ROOT_REQUIRED', 'runtimeRoot must be absolute');
  if (typeof workerEntry !== 'string' || workerEntry.length === 0) throw new CompanionError('WORKER_ENTRY_REQUIRED', 'workerEntry is required');
  const cwd = workerCwd ?? installation.app_root;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new CompanionError('WORKER_CWD_INVALID', 'workerCwd must be absolute');
  const resolvedStateRoot = stateRoot ?? path.join(runtimeRoot, 'companion');
  if (!path.isAbsolute(resolvedStateRoot)) throw new CompanionError('STATE_ROOT_INVALID', 'stateRoot must be absolute');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(resolvedStateRoot, { recursive: true });

  const targets = new Map();
  let pollTimer = null;
  let stopped = false;

  function normalizePath(value) {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
  const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' &&
    normalizePath(left) === normalizePath(right);

  function inspectWorkerOrphan(state, membership) {
    if (state.config === null || typeof state.config.runtime_dir !== 'string') return null;
    const lockPath = path.join(state.config.runtime_dir, 'receiver.lock');
    if (!fs.existsSync(lockPath)) return null;
    let lock;
    try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return { exists: true, invalid: true, lockPath }; }
    const valid = lock?.v === 1 &&
      lock.installation_id === installation.installation_id &&
      lock.instance_id === installation.instance_id &&
      lock.thread_id === state.config.thread_id &&
      lock.owner_component === 'codex-worker' &&
      lock.binding_epoch === (state.config.binding_epoch ?? null) &&
      samePath(lock.config_path, membership.config_path) &&
      typeof lock.nonce === 'string' && Number.isInteger(lock.pid) &&
      Number.isInteger(lock.owner_process?.pid) && lock.owner_process.pid === lock.pid &&
      typeof lock.owner_process?.created_at === 'string' &&
      typeof lock.owner_process?.exe_realpath === 'string' &&
      typeof lock.owner_process?.entry_realpath === 'string';
    return { exists: true, invalid: !valid, lock, lockPath, statusPath: path.join(state.config.runtime_dir, 'status.json') };
  }

  function statusMatchesLock(status, lock) {
    if (status === null || typeof status !== 'object') return false;
    const heartbeat = Date.parse(status.heartbeat_at ?? status.at);
    return status.pid === lock.pid &&
      (status.worker_nonce === lock.nonce || status.nonce === lock.nonce) &&
      status.binding_epoch === (lock.binding_epoch ?? null) &&
      status.enabled === true &&
      Number.isFinite(heartbeat) && heartbeat <= now() + 5_000 && now() - heartbeat <= 60_000 &&
      !/PAUSED|BACKOFF|HALTED|DISABLED|STOPPED/.test(String(status.status ?? ''));
  }

  async function archiveDeadWorkerLock(orphan) {
    const txFile = `${orphan.lockPath}.transaction`;
    let handle;
    try {
      fs.mkdirSync(path.dirname(txFile), { recursive: true });
      handle = fs.openSync(txFile, 'wx', 0o600);
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() }), 'utf8');
    } catch {
      return false;
    } finally { if (handle !== undefined) try { fs.closeSync(handle); } catch { /* best effort */ } }
    try {
      const current = JSON.parse(fs.readFileSync(orphan.lockPath, 'utf8'));
      if (current.nonce !== orphan.lock.nonce) return false;
      fs.renameSync(orphan.lockPath, `${orphan.lockPath}.stale-${now()}-${crypto.randomUUID()}`);
      return true;
    } catch {
      return false;
    } finally {
      try { fs.rmSync(txFile, { force: true }); } catch { /* best effort */ }
    }
  }

  async function reconcileWorkerOrphan(state, membership, orphan) {
    if (stopped || state.stopping) return;
    if (orphan.invalid === true) {
      state.orphanPending = false;
      state.lifecycle = 'ORPHAN_REVIEW';
      state.last_error = 'ORPHAN_LOCK_INVALID';
      log('companion/worker-orphan-review', { target: state.target, code: state.last_error });
      return;
    }
    let actual = null;
    try { actual = await readProcessIdentity(orphan.lock.owner_process.pid, { provider: processProvider }); }
    catch { actual = null; }
    const expected = {
      pid: orphan.lock.pid,
      created_at: orphan.lock.owner_process.created_at,
      exe_path: orphan.lock.owner_process.exe_realpath,
      entry_path: orphan.lock.owner_process.entry_realpath,
    };
    const comparison = actual === null ? { verdict: 'UNKNOWN' } : sameProcess(actual, expected);
    if (actual?.alive === true && comparison.verdict === 'SAME') {
      let status = null;
      try { status = JSON.parse(fs.readFileSync(orphan.statusPath, 'utf8')); } catch { status = null; }
      if (!statusMatchesLock(status, orphan.lock)) {
        state.orphanPending = false;
        state.lifecycle = 'ORPHAN_HEALTH_REVIEW';
        state.last_error = 'ORPHAN_STATUS_NOT_VERIFIED';
        log('companion/worker-orphan-health-review', { target: state.target, pid: orphan.lock.pid });
        return;
      }
      state.adopted = true;
      state.orphanPending = false;
      state.child = null;
      state.pid = orphan.lock.pid;
      state.workerNonce = orphan.lock.nonce;
      state.statusPath = orphan.statusPath;
      state.identityProof = { ...expected, nonce: orphan.lock.nonce };
      state.lifecycle = 'ADOPTED_ORPHAN';
      state.last_error = null;
      state.healthVerified = false;
      state.healthySince = null;
      state.stable = false;
      log('companion/worker-adopted', { target: state.target, pid: orphan.lock.pid, nonce: orphan.lock.nonce });
      scheduleHealthCheck(state);
      return;
    }
    if (actual !== null && actual.alive === false) {
      const archived = await archiveDeadWorkerLock(orphan);
      state.orphanPending = false;
      state.pid = null;
      if (!archived) {
        state.lifecycle = 'ORPHAN_REVIEW';
        state.last_error = 'ORPHAN_LOCK_ARCHIVE_FAILED';
        return;
      }
      log('companion/worker-dead-lock-archived', { target: state.target, pid: orphan.lock.pid });
      syncMembership(membership, { reason: 'RECOVERY' });
      return;
    }
    state.orphanPending = false;
    state.lifecycle = 'ORPHAN_REVIEW';
    state.last_error = actual === null ? 'ORPHAN_IDENTITY_UNKNOWN' : `ORPHAN_IDENTITY_${comparison.verdict}`;
    log('companion/worker-orphan-review', { target: state.target, code: state.last_error });
  }

  function launchStateFile(target) {
    return path.join(resolvedStateRoot, 'launch', `${targetKey(target)}.json`);
  }

  function readLaunchState(target) {
    const file = launchStateFile(target);
    if (!fs.existsSync(file)) return { ok: true, state: { last_registration_nonce: null, logon_eligible: false, updated_at: null } };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        ok: true,
        state: {
          last_registration_nonce: typeof parsed.last_registration_nonce === 'string' ? parsed.last_registration_nonce : null,
          logon_eligible: parsed.logon_eligible === true,
          updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
        },
      };
    } catch (error) {
      return { ok: false, code: 'LAUNCH_STATE_CORRUPT', detail: String(error?.message ?? error), state: null };
    }
  }

  function writeLaunchState(target, state) {
    const file = launchStateFile(target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}
`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    }
  }

  function persistPolicy(state) {
    if (state.policyCorrupt || state.policyPersistFailed) return false;
    try {
      policyWriter(state.policyFile, state.policy.snapshot());
      return true;
    } catch (error) {
      state.policyPersistFailed = true;
      state.lifecycle = 'HALTED';
      state.last_error = `RESTART_STATE_WRITE_FAILED:${String(error?.message ?? error)}`;
      cancelRestart(state);
      clearStableTimer(state);
      clearHealthTimer(state);
      log('companion/restart-state-write-failed', { target: state.target, message: state.last_error });
      return false;
    }
  }

  function stateFor(target) {
    if (!targets.has(target)) {
      const policyFile = restartSnapshotPath(resolvedStateRoot, targetKey(target));
      let snapshot = null;
      let policyCorrupt = false;
      try {
        snapshot = readRestartSnapshot(policyFile);
      } catch (error) {
        policyCorrupt = true;
        log('companion/restart-state-read-failed', { target, code: error?.code ?? 'RESTART_STATE_CORRUPT', message: String(error?.message ?? error) });
      }
      const policy = createRestartPolicy({
        delaysMs: restartDelaysMs,
        maxAttempts: maxRestartAttempts,
        stableMs,
        failureWindowMs,
        now,
        snapshot: policyCorrupt
          ? {
              attempts: maxRestartAttempts,
              failures: maxRestartAttempts,
              halted: true,
              stable_since: null,
              last_failure_at: null,
              next_retry_at: null,
              last_reason_code: 'RESTART_STATE_CORRUPT',
              failure_times: [],
            }
          : snapshot,
      });
      const launchRead = readLaunchState(target);
      targets.set(target, {
        target,
        membership: null,
        child: null,
        pid: null,
        lifecycle: launchRead.ok ? 'DISCOVERED' : 'HALTED',
        start_reason: null,
        restart_count: 0,
        last_exit: null,
        last_error: launchRead.ok ? null : launchRead.code,
        policy,
        policyFile,
        policyCorrupt,
        policyPersistFailed: false,
        launch: launchRead.ok ? launchRead.state : null,
        launchValid: launchRead.ok,
        restartTimer: null,
        stableTimer: null,
        healthTimer: null,
        healthVerified: false,
        healthySince: null,
        lastHealthAt: null,
        stable: false,
        workerNonce: null,
        statusPath: null,
        config: null,
        identityProof: null,
        stopVerified: false,
        stopPromise: null,
        stopUnconfirmed: false,
        stopping: false,
        orphanPending: false,
        adopted: false,
      });
    }
    return targets.get(target);
  }

  function cancelRestart(state) {
    if (state.restartTimer !== null) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
  }

  function clearStableTimer(state) {
    if (state.stableTimer !== null) {
      clearTimeout(state.stableTimer);
      state.stableTimer = null;
    }
  }

  function armStableTimer(state) {
    clearStableTimer(state);
    state.stableTimer = setTimeout(() => {
      state.stableTimer = null;
      const snapshot = state.policy.recordStable({ at: now() });
      if (!persistPolicy(state)) return;
      log('companion/stable-window', { target: state.target, attempts: snapshot.attempts });
    }, stableMs);
    state.stableTimer.unref?.();
  }


  function clearHealthTimer(state) {
    if (state.healthTimer !== null) {
      clearTimeout(state.healthTimer);
      state.healthTimer = null;
    }
  }

  function invalidateHealth(state, code) {
    clearHealthTimer(state);
    state.healthVerified = false;
    state.healthySince = null;
    state.stable = false;
    state.policy.recordUnhealthy();
    if (!persistPolicy(state)) return;
    if (code !== undefined) state.last_error = code;
  }

  async function checkWorkerHealth(state) {
    if (stopped || state.stopping || (state.child === null && state.adopted !== true) || state.statusPath === null) return;
    let status;
    try {
      status = JSON.parse(fs.readFileSync(state.statusPath, 'utf8'));
    } catch {
      invalidateHealth(state, 'WORKER_STATUS_MISSING');
      scheduleHealthCheck(state);
      return;
    }
    const heartbeatMs = Date.parse(status?.heartbeat_at);
    const heartbeatFuture = Number.isFinite(heartbeatMs) && heartbeatMs > now() + 5_000;
    const fresh = Number.isFinite(heartbeatMs) && !heartbeatFuture && now() - heartbeatMs <= 60_000;
    const owner = status?.owner_process !== null && status?.owner_process !== undefined && typeof status.owner_process === 'object' ? status.owner_process : {};
    const expected = {
      pid: Number.isInteger(status.pid) ? status.pid : (Number.isInteger(owner.pid) ? owner.pid : null),
      created_at: typeof status.process_created_at === 'string' ? status.process_created_at : (typeof owner.created_at === 'string' ? owner.created_at : null),
      exe_path: typeof status.exe_path === 'string' ? status.exe_path : (typeof owner.exe_path === 'string' ? owner.exe_path : (typeof owner.exe_realpath === 'string' ? owner.exe_realpath : null)),
      entry_path: typeof status.entry_path === 'string' ? status.entry_path : (typeof owner.entry_path === 'string' ? owner.entry_path : (typeof owner.entry_realpath === 'string' ? owner.entry_realpath : null)),
    };
    const bindingEpoch = status?.binding_epoch ?? owner.binding_epoch;
    const pidMatches = Number.isInteger(status?.pid) && state.pid !== null && status.pid === state.pid;
    const validStatus = status.schema_version === 3 &&
      status.installation_id === installation.installation_id &&
      status.instance_id === installation.instance_id &&
      (status.worker_nonce === state.workerNonce || status.nonce === state.workerNonce || owner.nonce === state.workerNonce) &&
      bindingEpoch === state.membership?.binding_epoch &&
      pidMatches &&
      status.enabled === true &&
      !/PAUSED|BACKOFF|HALTED|DISABLED|STOPPED/.test(String(status.status ?? '')) &&
      fresh && Number.isInteger(expected.pid) && expected.created_at !== null && expected.exe_path !== null && expected.entry_path !== null;
    if (!validStatus) {
      let reason = 'WORKER_HEALTH_INVALID';
      if (heartbeatFuture) reason = 'WORKER_HEARTBEAT_FUTURE';
      else if (!pidMatches) reason = 'WORKER_PID_MISMATCH';
      else if (bindingEpoch !== state.membership?.binding_epoch) reason = 'WORKER_BINDING_EPOCH_MISMATCH';
      invalidateHealth(state, reason);
      scheduleHealthCheck(state);
      return;
    }
    const actual = await readProcessIdentity(expected.pid, { provider: processProvider });
    const comparison = sameProcess(actual, expected);
    if (comparison.verdict !== 'SAME') {
      invalidateHealth(state, 'WORKER_IDENTITY_' + comparison.verdict);
      scheduleHealthCheck(state);
      return;
    }
    if (state.healthVerified !== true) {
      log('companion/worker-healthy', { target: state.target, pid: state.pid, worker_nonce: state.workerNonce });
    }
    if (state.identityProof === null) {
      state.identityProof = {
        pid: expected.pid,
        created_at: expected.created_at,
        exe_path: expected.exe_path,
        entry_path: expected.entry_path,
        nonce: state.workerNonce,
      };
    }
    state.healthVerified = true;
    state.last_error = null;
    if (state.healthySince === null) state.healthySince = now();
    state.policy.recordHealthy({ at: now() });
    if (now() - state.healthySince >= stableMs) {
      state.policy.recordStable({ at: now() });
      state.stable = true;
    }
    if (!persistPolicy(state)) return;
    scheduleHealthCheck(state);
  }

  function scheduleHealthCheck(state) {
    clearHealthTimer(state);
    state.healthTimer = setTimeout(() => {
      state.healthTimer = null;
      void checkWorkerHealth(state);
    }, healthPollMs);
    state.healthTimer.unref?.();
  }
  function cooperativeStop(state, reason, detail = 'STOP_UNCONFIRMED_IDENTITY') {
    state.stopUnconfirmed = true;
    state.lifecycle = 'STOP_UNCONFIRMED';
    state.last_error = detail;
    try {
      if (state.statusPath !== null) {
        fs.mkdirSync(path.dirname(state.statusPath), { recursive: true });
        fs.writeFileSync(path.join(path.dirname(state.statusPath), 'stop'), 'stop\n', 'utf8');
      }
    } catch { /* cooperative marker is best effort */ }
    log('companion/worker-stop-cooperative', { target: state.target, reason, detail });
  }

  function stopWorker(state, reason = 'STOP_REQUESTED') {
    state.stopping = true;
    cancelRestart(state);
    clearStableTimer(state);
    clearHealthTimer(state);
    state.lifecycle = reason;
    if (state.adopted === true) {
      if (state.stopPromise !== null) return state.stopPromise;
      const pid = state.pid;
      const runtimeDir = state.config?.runtime_dir;
      state.stopPromise = (async () => {
        if (typeof runtimeDir !== 'string') {
          cooperativeStop(state, reason, 'STOP_UNCONFIRMED_NO_RUNTIME');
          return;
        }
        try { fs.writeFileSync(path.join(runtimeDir, 'stop'), new Date(now()).toISOString()); }
        catch { cooperativeStop(state, reason, 'STOP_REQUEST_WRITE_FAILED'); return; }
        const deadline = now() + 10_000;
        while (now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          let actual;
          try { actual = await readProcessIdentity(pid, { provider: processProvider }); }
          catch { actual = { pid, alive: false, available: false }; }
          if (actual.alive === false) {
            state.stopVerified = true;
            state.adopted = false;
            state.pid = null;
            state.lifecycle = 'STOPPED';
            log('companion/worker-stop-cooperative-confirmed', { target: state.target, pid });
            return;
          }
        }
        cooperativeStop(state, reason, 'STOP_COOPERATIVE_TIMEOUT');
      })().finally(() => { state.stopPromise = null; });
      return state.stopPromise;
    }
    const child = state.child;
    if (child === null || child.exitCode !== null) return Promise.resolve();
    if (state.stopPromise !== null) return state.stopPromise;
    const proof = state.identityProof;
    if (proof === null || proof.nonce !== state.workerNonce) {
      cooperativeStop(state, reason, 'STOP_UNCONFIRMED_NO_IDENTITY_PROOF');
      return Promise.resolve();
    }
    state.lifecycle = 'STOP_PENDING';
    state.stopPromise = (async () => {
      let actual;
      try {
        actual = await readProcessIdentity(proof.pid, { provider: processProvider });
      } catch (error) {
        actual = { pid: proof.pid, alive: false, available: false, unavailable_reason: String(error?.message ?? error) };
      }
      if (state.child !== child || child.exitCode !== null) {
        // The child exited while the fresh identity read was in flight.
        return;
      }
      const comparison = sameProcess(actual, proof);
      if (actual.alive !== true || comparison.verdict !== 'SAME') {
        cooperativeStop(state, reason, `STOP_UNCONFIRMED_IDENTITY_${comparison.verdict}`);
        return;
      }
      state.stopVerified = true;
      state.lifecycle = 'STOPPING';
      try {
        child.kill('SIGTERM');
      } catch (error) {
        state.last_error = `SIGNAL_FAILED:${String(error?.message ?? error)}`;
      }
    })().finally(() => {
      state.stopPromise = null;
    });
    return state.stopPromise;
  }

  function scheduleFailure(state, code) {
    clearStableTimer(state);
    const snapshot = state.policy.recordFailure({ at: now(), code });
    if (!persistPolicy(state)) return;
    state.restart_count += 1;
    if (snapshot.halted) {
      state.lifecycle = 'HALTED';
      state.last_error = snapshot.last_reason_code;
      log('companion/worker-halted', { target: state.target, attempts: snapshot.attempts });
      return;
    }
    state.lifecycle = 'BACKOFF';
    const delay = snapshot.next_retry_at === null
      ? restartDelaysMs[0]
      : Math.max(0, Date.parse(snapshot.next_retry_at) - now());
    log('companion/worker-backoff', { target: state.target, delay, attempts: snapshot.attempts });
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      if (stopped || state.stopping) return;
      if (state.policy.snapshot().halted) {
        state.lifecycle = 'HALTED';
        return;
      }
      if (state.membership?.desired_state !== 'ENABLED' || state.membership?.enabled !== true) return;
      startWorker(state, state.membership, 'RECOVERY');
    }, delay);
    state.restartTimer.unref?.();
  }

  function handleWorkerFailure(state, code, detail = null) {
    if (state.child === null && state.stopping) return;
    state.child = null;
    state.pid = null;
    if (detail !== null) state.last_error = detail;
    if (stopped) {
      state.lifecycle = 'STOPPED';
      return;
    }
    scheduleFailure(state, code);
  }

  function startWorker(state, membership, startReason) {
    if (stopped || state.policyCorrupt || state.policyPersistFailed || state.child !== null || state.restartTimer !== null) return;
    if (state.policy.snapshot().halted) {
      state.lifecycle = 'HALTED';
      return;
    }
    state.membership = membership;
    state.stopping = false;
    state.stopUnconfirmed = false;
    state.stopVerified = false;
    state.stopPromise = null;
    state.identityProof = null;
    state.start_reason = startReason;
    state.lifecycle = 'STARTING';
    state.config = state.config;
    const nonce = crypto.randomUUID();
    state.workerNonce = nonce;
    state.healthVerified = false;
    state.healthySince = null;
    state.stable = false;
    state.statusPath = path.join(state.config.runtime_dir, 'status.json');
    const args = [workerEntry, membership.config_path, nonce];
    const child = spawnProcess(nodeExecutable, args, {
      cwd,
      env: sanitizeWorkerEnv(env),
      windowsHide: true,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    state.child = child;
    state.pid = child.pid ?? null;
    state.lifecycle = 'RUNNING';
    state.last_error = null;
    state.last_stderr = null;
    if (child.stderr !== null && child.stderr !== undefined) {
      child.stderr.setEncoding?.('utf8');
      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        state.last_stderr = `${state.last_stderr ?? ''}${text}`.slice(-4_096);
      });
    }
    log('companion/worker-started', {
      target: membership.target,
      pid: child.pid,
      start_reason: startReason,
      config_path: membership.config_path,
    });
    scheduleHealthCheck(state);
    child.once('error', (error) => {
      state.last_error = String(error?.message ?? error);
      log('companion/worker-error', { target: membership.target, message: state.last_error });
      if (state.child === child) handleWorkerFailure(state, 'spawn-error', state.last_error);
    });
    child.once('exit', (code, signal) => {
      if (state.child !== child) return;
      state.last_exit = { code: code ?? null, signal: signal ?? null, at: new Date(now()).toISOString() };
      state.child = null;
      state.pid = null;
      if (state.stopping || stopped) {
        state.lifecycle = state.stopUnconfirmed === true ? 'STOP_UNCONFIRMED' : 'STOPPED';
        log('companion/worker-stopped', { target: membership.target, code, signal });
        return;
      }
      log('companion/worker-exit', { target: membership.target, code, signal, stderr: state.last_stderr ?? null });
      state.last_error = state.last_stderr === null ? null : `worker stderr: ${state.last_stderr.slice(-500)}`;
      scheduleFailure(state, `exit:${code ?? signal ?? 'unknown'}`);
    });
  }

  function validateConfigTarget(state, membership) {
    if (!fs.existsSync(membership.config_path)) return { ok: false, code: 'CONFIG_PATH_MISSING' };
    let config;
    try {
      config = JSON.parse(fs.readFileSync(membership.config_path, 'utf8'));
    } catch (error) {
      return { ok: false, code: 'CONFIG_INVALID', detail: String(error?.message ?? error) };
    }
    const thread = expectedThread(membership.target);
    if (thread === null) return { ok: false, code: 'UNSUPPORTED_TARGET' };
    if (config.thread_id !== thread) return { ok: false, code: 'CONFIG_TARGET_MISMATCH' };
    if (config.installation_id !== installation.installation_id) return { ok: false, code: 'CONFIG_INSTALLATION_MISMATCH' };
    if (config.instance_id !== installation.instance_id) return { ok: false, code: 'CONFIG_INSTANCE_MISMATCH' };
    if (config.binding_epoch !== membership.binding_epoch) return { ok: false, code: 'CONFIG_BINDING_EPOCH_MISMATCH' };
    if (config.enabled !== true) return { ok: false, code: 'CONFIG_DISABLED' };
    if (config.owner_opt_in !== true) return { ok: false, code: 'CONFIG_OWNER_OPT_IN_MISSING' };
    if (typeof config.runtime_dir !== 'string' || !path.isAbsolute(config.runtime_dir)) return { ok: false, code: 'CONFIG_RUNTIME_INVALID' };
    if (isPathInside(installation.runtime_root, config.runtime_dir) !== true) return { ok: false, code: 'CONFIG_RUNTIME_OUTSIDE_INSTALL' };
    if (isPathInside(installation.runtime_root, membership.config_path) !== true) return { ok: false, code: 'CONFIG_PATH_OUTSIDE_INSTALL' };
    const locator = config.locator_path ?? config.locator;
    if (typeof locator !== 'string' || !path.isAbsolute(locator)) return { ok: false, code: 'CONFIG_LOCATOR_MISSING' };
    if (locatorPath !== undefined && normalizePath(locator) !== normalizePath(locatorPath)) return { ok: false, code: 'CONFIG_LOCATOR_MISMATCH' };
    return { ok: true, config };
  }

  function syncMembership(membership, { reason = 'USER_ENABLE' } = {}) {
    const state = stateFor(membership.target);
    const previousEpoch = state.membership?.binding_epoch ?? null;
    state.membership = membership;
    if (state.launchValid !== true) {
      stopWorker(state, 'LAUNCH_STATE_CORRUPT');
      state.lifecycle = 'HALTED';
      state.last_error = 'LAUNCH_STATE_CORRUPT';
      return;
    }
    if (membership.installation_id !== installation.installation_id || membership.instance_id !== installation.instance_id) {
      stopWorker(state, 'TARGET_UNKNOWN');
      state.lifecycle = 'TARGET_UNKNOWN';
      state.last_error = 'INSTALLATION_OR_INSTANCE_MISMATCH';
      return;
    }
    if (membership.receiver_kind !== 'daily') {
      state.lifecycle = 'LEGACY_MANUAL';
      return;
    }
    if (membership.desired_state !== 'ENABLED' || membership.enabled !== true || membership.owner_opt_in !== true) {
      stopWorker(state, 'DISABLED');
      state.lifecycle = 'DISABLED';
      return;
    }
    if (previousEpoch !== null && previousEpoch !== membership.binding_epoch) {
      stopWorker(state, 'BINDING_EPOCH_CHANGED');
      state.lifecycle = 'TARGET_PAUSED';
      state.last_error = 'BINDING_EPOCH_CHANGED';
      return;
    }

    const newRegistration = state.launch.last_registration_nonce !== membership.registration_nonce;
    let logonEligible = state.launch.logon_eligible === true;
    if (reason === 'LOGON_AUTOSTART') {
      logonEligible = membership.start_at_logon === true;
    } else if (reason === 'USER_ENABLE' || reason === 'MANUAL_START' || newRegistration) {
      logonEligible = true;
    }
    const nextLaunch = {
      last_registration_nonce: membership.registration_nonce,
      logon_eligible: logonEligible,
      updated_at: new Date(now()).toISOString(),
    };
    try {
      writeLaunchState(state.target, nextLaunch);
      state.launch = nextLaunch;
    } catch (error) {
      state.launchValid = false;
      stopWorker(state, 'LAUNCH_STATE_WRITE_FAILED');
      state.lifecycle = 'HALTED';
      state.last_error = `LAUNCH_STATE_WRITE_FAILED:${String(error?.message ?? error)}`;
      return;
    }
    if (!logonEligible && reason !== 'DSH_START') {
      if (state.child === null && state.restartTimer === null) state.lifecycle = 'PAUSED_LOGON_OPT_OUT';
      return;
    }
    if (!logonEligible && reason === 'DSH_START') {
      // no-login only gates Windows logon autostart; opening DSH with an
      // already explicit enabled/owner-opt-in receiver may still resume it.
      log('companion/dsh-start-login-opt-out', { target: state.target });
    }

    const configCheck = validateConfigTarget(state, membership);
    if (configCheck.ok !== true) {
      stopWorker(state, 'TARGET_PAUSED');
      state.lifecycle = 'TARGET_PAUSED';
      state.last_error = configCheck.code;
      return;
    }
    if (state.policyPersistFailed) {
      state.lifecycle = 'HALTED';
      state.last_error = state.last_error ?? 'RESTART_STATE_WRITE_FAILED';
      return;
    }
    if (state.policy.snapshot().halted) {
      if (state.child !== null) stopWorker(state, 'HALTED');
      state.lifecycle = 'HALTED';
      return;
    }
    state.config = configCheck.config;
    if (state.adopted === true) return;
    if (state.orphanPending === true) return;
    if (state.child === null && state.restartTimer === null) {
      const orphan = inspectWorkerOrphan(state, membership);
      if (orphan !== null) {
        state.orphanPending = true;
        state.pid = orphan.lock?.pid ?? null;
        state.lifecycle = 'ORPHAN_RECOVERY_PENDING';
        void reconcileWorkerOrphan(state, membership, orphan);
        return;
      }
      startWorker(state, membership, reason);
    }
  }

  /** Discover memberships and reconcile child workers. */
  function syncOnce({ reason = 'USER_ENABLE' } = {}) {
    if (stopped) return status();
    const listing = listMemberships(runtimeRoot);
    const seen = new Set();
    for (const membership of listing.memberships) {
      seen.add(membership.target);
      const state = stateFor(membership.target);
      syncMembership(membership, { reason: state.child === null ? reason : 'RECOVERY' });
    }
    for (const state of targets.values()) {
      if (!seen.has(state.target)) {
        stopWorker(state, 'MEMBERSHIP_MISSING');
        state.lifecycle = 'TARGET_UNKNOWN';
        state.last_error = 'MEMBERSHIP_MISSING';
      }
    }
    return status();
  }

  function start({ reason = 'LOGON_AUTOSTART' } = {}) {
    stopped = false;
    syncOnce({ reason });
    if (autoPoll && pollTimer === null) {
      pollTimer = setInterval(() => syncOnce({ reason: 'RECOVERY' }), pollIntervalMs);
      pollTimer.unref?.();
    }
    return status();
  }

  /** Explicit operator reset of a halted policy; no automatic outer-layer reset. */
  function resetTarget(target) {
    const state = stateFor(target);
    cancelRestart(state);
    clearStableTimer(state);
    if (state.child !== null) stopWorker(state, 'RESET');
    state.policy.reset({ at: now() });
    if (!persistPolicy(state)) return;
    state.lifecycle = 'RESET';
    return status();
  }

  async function stop() {
    stopped = true;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    const stopWaits = [];
    for (const state of targets.values()) {
      const pending = stopWorker(state, 'STOPPED');
      if (pending !== undefined) stopWaits.push(pending);
    }
    await Promise.allSettled(stopWaits);
    const exitWaits = [];
    for (const state of targets.values()) {
      const child = state.child;
      if (child !== null && child.exitCode === null) exitWaits.push(waitForChildExit(child, 2_000));
    }
    await Promise.allSettled(exitWaits);
    return status();
  }

  function status() {
    const result = {
      schema_version: COMPANION_SCHEMA_VERSION,
      installation_id: installation.installation_id,
      instance_id: installation.instance_id,
      running: !stopped,
      targets: {},
    };
    for (const [target, state] of targets) {
      const policy = state.policy.snapshot();
      result.targets[target] = {
        target,
        lifecycle: state.lifecycle,
        pid: state.pid,
        start_reason: state.start_reason,
        restart_count: state.restart_count,
        last_exit: state.last_exit,
        last_error: state.last_error,
        last_stderr: state.last_stderr ?? null,
        desired_state: state.membership?.desired_state ?? null,
        binding_epoch: state.membership?.binding_epoch ?? null,
        restart_attempts: policy.attempts,
        halted: policy.halted,
        policy_corrupt: state.policyCorrupt === true,
        policy_persist_failed: state.policyPersistFailed === true,
        stop_verified: state.stopVerified === true,
        stop_unconfirmed: state.stopUnconfirmed === true,
        stop_pending: state.stopPromise !== null,
        adopted: state.adopted === true,
        orphan_pending: state.orphanPending === true,
        next_retry_at: policy.next_retry_at,
        health_verified: state.healthVerified,
        healthy_since: state.healthySince === null ? null : new Date(state.healthySince).toISOString(),
        stable: state.stable,
      };
    }
    return result;
  }

  return { syncOnce, start, stop, resetTarget, status };
}
