// Companion-owned Hub lifecycle and owner lease.
//
// Only COMPANION_OWNED may start/reuse a Hub. The companion acquires the exact
// installation/instance owner generation first, writes Hub process status, and
// releases only its own lease. External/plugin/manual modes are connect-only or
// report NOT_HUB_OWNER; they never fall back to spawning a Hub.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { HubClient } from './client.mjs';
import { createRestartPolicy } from './restart-policy.mjs';
import { readRestartSnapshot, writeRestartSnapshotAtomic } from './restart-state.mjs';
import { runtimePaths, writeJsonAtomic } from './runtime.mjs';
import { createServiceState, readServiceState, updateServiceState, writeServiceStateAtomic } from './service-state.mjs';
import {
  acquireHubOwner,
  heartbeatHubOwner,
  hubOwnerLockFile,
  inspectHubOwner,
  releaseHubOwner,
} from './hub-owner.mjs';
import { readOwnerLock } from './process-identity.mjs';
import { readProcessIdentity, sameProcess } from './process-identity.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HUB_COMPONENT = 'hub';
const GENERATION_VERSION = 1;

/** Only an explicit provider PROCESS_NOT_FOUND is proof of death here. */
function isProvablyDead(identity) {
  return identity !== null && identity !== undefined && identity.alive === false &&
    (identity.unavailable_reason === 'PROCESS_NOT_FOUND' || identity.code === 'PROCESS_NOT_FOUND');
}

function waitForExit(handle, timeoutMs) {
  return new Promise((resolve) => {
    if (handle.exitCode !== null) { resolve(true); return; }
    const timer = setTimeout(() => {
      handle.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    handle.once('exit', onExit);
  });
}

export class CompanionHubError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CompanionHubError';
    this.code = code;
    this.details = details;
  }
}

function desiredStateFor(runtimeDir) {
  const file = path.join(runtimeDir, 'desired-state.json');
  if (!fs.existsSync(file)) return { state: 'RUNNING' };
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { state: 'INVALID', code: 'DESIRED_STATE_INVALID' };
    if (value.desired_state === 'STOPPED') return { state: 'STOPPED' };
    if (value.desired_state === 'RUNNING' || value.desired_state === undefined) return { state: 'RUNNING' };
    return { state: 'INVALID', code: 'DESIRED_STATE_INVALID' };
  } catch {
    return { state: 'INVALID', code: 'DESIRED_STATE_INVALID' };
  }
}

async function defaultProbeHub({ runtimeDir, installation, token }) {
  const runtime = runtimePaths(runtimeDir);
  let config;
  try { config = JSON.parse(fs.readFileSync(runtime.configFile, 'utf8')); } catch { return { state: 'ABSENT' }; }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) return { state: 'ABSENT' };
  const client = new HubClient({ host: config.host ?? '127.0.0.1', port: config.port, token, role: 'cli', identity: 'cli:operator' });
  try {
    await client.connect({ timeoutMs: 2_000 });
    const info = client.welcomeInfo;
    const codeIdentity = client.welcome?.server?.code_identity ?? null;
    if (info.protocol_version !== installation.protocol_version ||
        info.installation_id !== installation.installation_id ||
        info.instance_id !== installation.instance_id) return { state: 'FOREIGN', info, code_identity: codeIdentity };
    return { state: 'SAME', info, code_identity: codeIdentity };
  } catch (error) {
    return { state: 'UNREACHABLE', code: error?.code ?? 'HUB_PROBE_FAILED' };
  } finally {
    await client.close();
  }
}

export function createCompanionHub({
  installation,
  runtimeRoot,
  locatorPath,
  hubEntry,
  nodeExecutable = process.execPath,
  spawnProcess = spawn,
  env = process.env,
  log = () => {},
  now = Date.now,
  processProvider,
  probeHub = defaultProbeHub,
  startTimeoutMs = 12_000,
  stopTimeoutMs = 10_000,
  autoRestart = true,
  restartDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000],
  maxRestartAttempts = 10,
  stableMs = 5 * 60_000,
  heartbeatMs = 10_000,
  leaseMs = 30_000,
  onDesiredStop,
  onDesiredInvalid,
  policyWriter = writeRestartSnapshotAtomic,
} = {}) {
  if (installation === null || typeof installation !== 'object') throw new CompanionHubError('INSTALLATION_REQUIRED', 'installation is required');
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)) throw new CompanionHubError('RUNTIME_ROOT_REQUIRED', 'runtimeRoot must be absolute');
  if (typeof hubEntry !== 'string' || hubEntry.length === 0) throw new CompanionHubError('HUB_ENTRY_REQUIRED', 'hubEntry is required');
  if (installation.hub_owner_kind !== 'COMPANION_OWNED') {
    // Kept as a constructor-level fact; start() reports NOT_HUB_OWNER.
  }
  const runtime = runtimePaths(runtimeRoot);
  const companionDir = path.join(runtimeRoot, 'companion');
  const stateFile = path.join(companionDir, 'hub-service-state.json');
  const policyFile = path.join(companionDir, 'hub-restart-state.json');
  const generationFile = path.join(companionDir, 'hub-generation.json');
  const ownerLockFile = hubOwnerLockFile(runtimeRoot);
  const recoveryLockFile = `${ownerLockFile}.recovery-lock`;

  let policyCorrupt = false;
  let snapshot = null;
  try {
    snapshot = readRestartSnapshot(policyFile);
  } catch (error) {
    policyCorrupt = true;
    log('companion-hub/restart-state-corrupt', { code: error?.code ?? 'RESTART_STATE_CORRUPT' });
  }
  if (policyCorrupt) {
    snapshot = {
      attempts: maxRestartAttempts,
      failures: maxRestartAttempts,
      halted: true,
      stable_since: null,
      last_failure_at: null,
      next_retry_at: null,
      last_reason_code: 'HUB_RESTART_STATE_CORRUPT',
      failure_times: [],
    };
  }
  const policy = createRestartPolicy({ delaysMs: restartDelaysMs, maxAttempts: maxRestartAttempts, stableMs, snapshot });
  let child = null;
  let childIdentity = null;
  let lastChildIdentity = null;
  let childGeneration = 0;
  let lease = null;
  let stopping = false;
  let stopPromise = null;
  let startPromise = null;
  let heartbeatTimer = null;
  let restartTimer = null;
  let stableTimer = null;
  let lastExit = null;
  let lifecycle = policyCorrupt ? 'HALTED' : 'IDLE';
  let lastError = policyCorrupt ? 'HUB_RESTART_STATE_CORRUPT' : null;
  let ownerEpoch = snapshot?.owner_epoch ?? 0;
  let externalHub = null;
  let desiredStopSeen = false;
  let health = 'UNKNOWN';
  let lastProbeAt = null;
  let healthProbeCount = 0;
  let lastProbeError = null;
  let probeInFlight = false;
  let runningCodeIdentity = null;

  function persistPolicy() {
    if (policyCorrupt) return false;
    try {
      policyWriter(policyFile, policy.snapshot());
      return true;
    } catch (error) {
      policyCorrupt = true;
      lifecycle = 'HALTED';
      lastError = 'HUB_RESTART_STATE_WRITE_FAILED';
      if (stableTimer !== null) { clearTimeout(stableTimer); stableTimer = null; }
      log('companion-hub/restart-state-write-failed', { message: String(error?.message ?? error) });
      return false;
    }
  }

  function readGeneration() {
    try {
      const value = JSON.parse(fs.readFileSync(generationFile, 'utf8'));
      if (value?.v !== GENERATION_VERSION) return null;
      return value;
    } catch {
      return null;
    }
  }

  function writeGeneration(patch) {
    const inheritedChild = (() => {
      try { return readGeneration()?.child ?? null; } catch { return null; }
    })();
    const currentChild = childIdentity === null ? (lastChildIdentity === null ? inheritedChild : lastChildIdentity) : childIdentity;
    const childValue = patch?.child ?? (currentChild === null ? null : {
      pid: currentChild.pid,
      created_at: currentChild.created_at,
      exe_path: currentChild.exe_path,
      entry_path: currentChild.entry_path,
    });
    const value = {
      v: GENERATION_VERSION,
      installation_id: installation.installation_id,
      instance_id: installation.instance_id,
      owner_mode: installation.hub_owner_kind,
      owner_epoch: ownerEpoch,
      owner_nonce: lease?.lock?.nonce ?? null,
      generation: childGeneration,
      child: childValue,
      server_pid: patch?.server_pid ?? null,
      started_at: new Date(now()).toISOString(),
      last_exit: patch?.last_exit ?? lastExit,
    };
    writeJsonAtomic(generationFile, value);
    return value;
  }

  function writeHubState(state, patch = {}) {
    const nonce = lease?.lock?.nonce ?? childIdentity?.nonce ?? crypto.randomUUID();
    writeServiceStateAtomic(stateFile, createServiceState({
      installation_id: installation.installation_id,
      instance_id: installation.instance_id,
      owner_mode: installation.hub_owner_kind,
      component: HUB_COMPONENT,
      pid: patch.pid ?? child?.pid ?? externalHub?.pid ?? null,
      process_created_at: patch.process_created_at ?? childIdentity?.created_at ?? null,
      nonce,
      state,
      reason_code: patch.reason_code ?? null,
      last_heartbeat_at: new Date(now()).toISOString(),
      last_exit: patch.last_exit ?? lastExit,
      next_retry_at: patch.next_retry_at ?? null,
    }));
  }

  function armStableTimer() {
    if (policyCorrupt || lifecycle !== 'READY') return;
    if (stableTimer !== null) { clearTimeout(stableTimer); stableTimer = null; }
    const snap = policy.snapshot();
    if (snap.stable_since === null) return;
    const remaining = Math.max(0, stableMs - (now() - Date.parse(snap.stable_since)));
    if (remaining === 0) {
      policy.recordStable({ at: now() });
      if (!persistPolicy()) {
        writeHubState('HALTED', { reason_code: 'HUB_RESTART_STATE_WRITE_FAILED' });
        return;
      }
      return;
    }
    stableTimer = setTimeout(() => {
      stableTimer = null;
      if (stopping || policyCorrupt || lifecycle !== 'READY') return;
      const current = policy.snapshot();
      if (current.stable_since !== null && now() - Date.parse(current.stable_since) >= stableMs) {
        policy.recordStable({ at: now() });
        if (!persistPolicy()) {
          lifecycle = 'HALTED';
          lastError = 'HUB_RESTART_STATE_WRITE_FAILED';
          writeHubState('HALTED', { reason_code: 'HUB_RESTART_STATE_WRITE_FAILED' });
        }
      }
    }, remaining);
    stableTimer.unref?.();
  }

  function recordReady(pid) {
    if (policyCorrupt) {
      lifecycle = 'HALTED';
      lastError = 'HUB_RESTART_STATE_WRITE_FAILED';
      writeHubState('HALTED', { reason_code: 'HUB_RESTART_STATE_WRITE_FAILED' });
      return false;
    }
    policy.recordHealthy({ at: now() });
    if (!persistPolicy()) {
      writeHubState('HALTED', { reason_code: 'HUB_RESTART_STATE_WRITE_FAILED' });
      return false;
    }
    lifecycle = 'READY';
    health = 'HEALTHY';
    lastProbeAt = now();
    lastProbeError = null;
    lastError = null;
    armStableTimer();
    writeHubState('READY', { pid });
    writeGeneration({ server_pid: pid });
    return true;
  }

  function readToken() {
    try { return fs.readFileSync(runtime.tokenFile, 'utf8').trim(); } catch { return ''; }
  }

  async function recoverAdoptedOwnHubIfDead() {
    if (externalHub?.adopted_own !== true) return false;
    const proof = externalHub.identity_proof;
    if (proof === null || !Number.isInteger(proof.pid)) return false;
    const generation = readGeneration();
    if (generation === null || generation.installation_id !== installation.installation_id ||
        generation.instance_id !== installation.instance_id ||
        generation.child?.pid !== proof.pid || generation.child?.created_at !== proof.created_at ||
        generation.child?.exe_path !== proof.exe_path || generation.child?.entry_path !== proof.entry_path) {
      lifecycle = 'ORPHAN_REVIEW';
      lastError = 'ADOPTED_HUB_LINEAGE_MISMATCH';
      writeHubState('HALTED', { reason_code: lastError });
      return true;
    }
    let actual = null;
    try { actual = await readProcessIdentity(proof.pid, { provider: processProvider }); }
    catch { actual = null; }
    if (!isProvablyDead(actual)) return false; // exception/unknown is not death
    let server = null;
    try { server = JSON.parse(fs.readFileSync(runtime.serverInfoFile, 'utf8')); } catch { server = null; }
    if (server === null || server.pid !== proof.pid) {
      lifecycle = 'ORPHAN_REVIEW';
      lastError = 'ADOPTED_HUB_SERVER_MISMATCH';
      writeHubState('HALTED', { reason_code: lastError });
      return true;
    }
    try { fs.rmSync(runtime.serverInfoFile, { force: true }); } catch { /* best effort */ }
    externalHub = null;
    lifecycle = 'BACKOFF';
    lastError = 'ADOPTED_HUB_EXITED';
    writeHubState('BACKOFF', { reason_code: lastError });
    scheduleRestart('adopted-hub-exit');
    return true;
  }

  async function probeHealthNow() {
    if (probeInFlight || stopping) return;
    probeInFlight = true;
    try {
      const probe = await probeHub({ runtimeDir: runtimeRoot, installation, token: readToken() });
      healthProbeCount += 1;
      lastProbeAt = now();
      if (probe.state === 'SAME') {
        if (!recordReady(child?.pid ?? externalHub?.pid ?? null)) {
          writeHubState('HALTED', { reason_code: 'HUB_RESTART_STATE_WRITE_FAILED' });
        }
        return;
      }
      health = probe.state === 'FOREIGN' ? 'FOREIGN' : 'OFFLINE';
      lastProbeError = probe.code ?? probe.state;
      policy.recordUnhealthy({ at: now() });
      if (!persistPolicy()) {
        writeHubState('HALTED', { reason_code: 'HUB_RESTART_STATE_WRITE_FAILED' });
        return;
      }
      if (stableTimer !== null) { clearTimeout(stableTimer); stableTimer = null; }
      if (probe.state === 'FOREIGN') {
        lifecycle = 'HUB_REVIEW';
        lastError = 'HUB_INSTANCE_MISMATCH';
        writeHubState('HALTED', { reason_code: 'HUB_INSTANCE_MISMATCH' });
        return;
      }
      if (externalHub?.adopted_own === true) {
        const recovered = await recoverAdoptedOwnHubIfDead();
        if (recovered) return;
        lifecycle = 'HUB_UNRESPONSIVE';
        lastError = lastProbeError;
        writeHubState('BACKOFF', { reason_code: 'ADOPTED_HUB_UNRESPONSIVE' });
        return;
      }
      if (externalHub !== null) {
        lifecycle = 'EXTERNAL_OFFLINE';
        lastError = lastProbeError;
        writeHubState('BACKOFF', { reason_code: 'EXTERNAL_HUB_OFFLINE' });
      } else {
        lifecycle = 'HUB_UNRESPONSIVE';
        lastError = lastProbeError;
        writeHubState('BACKOFF', { reason_code: 'HUB_PROBE_LOST' });
      }
    } catch (error) {
      healthProbeCount += 1;
      lastProbeAt = now();
      health = 'OFFLINE';
      lastProbeError = String(error?.message ?? error);
      policy.recordUnhealthy({ at: now() });
      persistPolicy();
      if (stableTimer !== null) { clearTimeout(stableTimer); stableTimer = null; }
      if (externalHub?.adopted_own === true) {
        const recovered = await recoverAdoptedOwnHubIfDead();
        if (recovered) return;
        lifecycle = 'HUB_UNRESPONSIVE';
        lastError = 'HUB_PROBE_FAILED';
        writeHubState('BACKOFF', { reason_code: 'ADOPTED_HUB_UNRESPONSIVE' });
        return;
      }
      lifecycle = externalHub !== null ? 'EXTERNAL_OFFLINE' : 'HUB_UNRESPONSIVE';
      lastError = 'HUB_PROBE_FAILED';
      writeHubState('BACKOFF', { reason_code: 'HUB_PROBE_FAILED' });
    } finally {
      probeInFlight = false;
    }
  }

  async function claimOwner() {
    let recoveryHandle;
    let recoveryNonce;
    try {
      fs.mkdirSync(path.dirname(recoveryLockFile), { recursive: true });
      recoveryNonce = crypto.randomUUID();
      recoveryHandle = fs.openSync(recoveryLockFile, 'wx', 0o600);
      fs.writeFileSync(recoveryHandle, JSON.stringify({ pid: process.pid, nonce: recoveryNonce }), 'utf8');
      fs.fsyncSync(recoveryHandle);
    } catch (error) {
      if (error?.code === 'EEXIST') return { ok: false, code: 'OWNER_RECOVERY_BUSY' };
      return { ok: false, code: 'OWNER_RECOVERY_LOCK_FAILED' };
    } finally {
      if (recoveryHandle !== undefined) {
        try { fs.closeSync(recoveryHandle); } catch { /* best effort */ }
      }
    }
    try {
      const read = await inspectHubOwner({ runtimeDir: runtimeRoot, now: now(), provider: processProvider, ttlMs: leaseMs });
      if (read.ok && read.state === 'ALIVE') {
        return { ok: false, code: 'OWNER_REVIEW_REQUIRED', state: read.state };
      }
      if (read.ok && ['UNRESPONSIVE', 'UNKNOWN'].includes(read.state)) {
        return { ok: false, code: 'OWNER_REVIEW_REQUIRED', state: read.state };
      }
      let previousEpoch = 0;
      if (read.ok && read.state === 'DEAD') {
        const lock = read.lock;
        if (lock?.installation_id !== installation.installation_id || lock?.instance_id !== installation.instance_id ||
            lock?.owner_component !== 'companion' || path.resolve(lock?.owner_process?.config_path ?? '') !== path.resolve(locatorPath ?? '')) {
          return { ok: false, code: 'OWNER_REVIEW_REQUIRED', state: 'DEAD_UNKNOWN_LINEAGE' };
        }
        const current = readOwnerLock(ownerLockFile);
        if (!current.ok || current.lock.nonce !== lock.nonce) return { ok: false, code: 'OWNER_CHANGED_DURING_RECOVERY' };
        const archive = `${ownerLockFile}.stale-${now()}-${crypto.randomUUID()}`;
        fs.renameSync(ownerLockFile, archive);
        previousEpoch = lock.owner_epoch;
        log('companion-hub/dead-owner-archived', { owner_epoch: previousEpoch, archive });
      }
      const identity = await readProcessIdentity(process.pid, { provider: processProvider });
      if (!identity.available || !identity.exe_path || !identity.entry_path) return { ok: false, code: 'OWNER_IDENTITY_UNAVAILABLE' };
      const nonce = crypto.randomUUID();
      const result = await acquireHubOwner({
        runtimeDir: runtimeRoot,
        installation,
        mode: installation.hub_owner_kind,
        owner_component: 'companion',
        owner_process: {
          pid: process.pid,
          created_at: identity.created_at,
          exe_realpath: identity.exe_path,
          entry_realpath: identity.entry_path,
          config_path: locatorPath ?? path.join(runtimeRoot, 'installation.json'),
        },
        owner_epoch: previousEpoch + 1,
        nonce,
        now: now(),
        leaseMs,
        heartbeatMs,
      });
      if (result.ok) {
        lease = result;
        ownerEpoch = result.lock.owner_epoch;
        log('companion-hub/owner-acquired', { owner_epoch: ownerEpoch, nonce });
      }
      return result;
    } finally {
      try {
        const value = JSON.parse(fs.readFileSync(recoveryLockFile, 'utf8'));
        if (value.nonce === recoveryNonce) fs.unlinkSync(recoveryLockFile);
      } catch { /* recovery lock is best effort */ }
    }
  }

  function scheduleRestart(reason) {
    if (!autoRestart || stopping || restartTimer !== null || policyCorrupt) return;
    const snapshotNow = policy.recordFailure({ at: now(), code: reason });
    persistPolicy();
    if (snapshotNow.halted) {
      lifecycle = 'HALTED';
      lastError = 'HUB_RESTART_LIMIT';
      writeHubState('HALTED', { reason_code: 'HUB_RESTART_LIMIT', last_exit: lastExit });
      return;
    }
    const delay = snapshotNow.next_retry_at === null ? 1_000 : Math.max(0, Date.parse(snapshotNow.next_retry_at) - now());
    writeHubState('BACKOFF', { reason_code: reason, next_retry_at: snapshotNow.next_retry_at, last_exit: lastExit });
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      if (stopping) return;
      const desired = desiredStateFor(runtimeRoot);
      if (desired.state !== 'RUNNING') {
        lifecycle = desired.state === 'STOPPED' ? 'STOPPED_DESIRED' : 'HALTED';
        return;
      }
      const started = await ensureHub();
      if (!started.ok) scheduleRestart(started.code ?? 'HUB_RESTART_FAILED');
    }, delay);
    restartTimer.unref?.();
  }

  async function startHubChild() {
    const generation = ++childGeneration;
    const hubEnv = {
      ...env,
      LAB_BRIDGE_INSTALLATION_ROOT: path.dirname(locatorPath ?? path.join(runtimeRoot, 'installation.json')),
      LAB_BRIDGE_RUNTIME_DIR: runtimeRoot,
    };
    let handle;
    try {
      handle = spawnProcess(nodeExecutable, [hubEntry], { cwd: path.dirname(hubEntry), env: hubEnv, windowsHide: true, detached: true, stdio: 'ignore' });
    } catch (error) {
      lastError = `HUB_SPAWN_FAILED:${String(error?.message ?? error)}`;
      writeHubState('BACKOFF', { reason_code: 'HUB_SPAWN_FAILED' });
      scheduleRestart('hub-spawn-error');
      return { ok: false, code: 'HUB_SPAWN_FAILED' };
    }
    if (handle === null || typeof handle !== 'object' || !Number.isInteger(handle.pid)) {
      lastError = 'HUB_SPAWN_FAILED';
      scheduleRestart('hub-spawn-error');
      return { ok: false, code: 'HUB_SPAWN_FAILED' };
    }
    child = handle;
    lifecycle = 'STARTING';
    let resolved = false;
    const clearIfCurrent = (code, signal) => {
      if (stateHandle() === handle) {
        child = null;
        childIdentity = null;
      }
      if (code === undefined) return;
      lastExit = { code: code ?? null, signal: signal ?? null, at: new Date(now()).toISOString(), reason: 'HUB_EXIT', generation };
      writeGeneration({ last_exit: lastExit, server_pid: null, child: lastChildIdentity });
      writeHubState('BACKOFF', { reason_code: 'HUB_EXIT', last_exit: lastExit });
      if (!stopping && !desiredStopSeen) scheduleRestart('hub-exit');
    };
    handle.once('error', (error) => {
      if (stateHandle() !== handle) return;
      lastError = `HUB_SPAWN_ERROR:${String(error?.message ?? error)}`;
      log('companion-hub/spawn-error', { message: lastError });
      child = null;
      childIdentity = null;
      writeHubState('BACKOFF', { reason_code: 'HUB_SPAWN_ERROR' });
      if (!stopping) scheduleRestart('hub-spawn-error');
    });
    handle.once('exit', (code, signal) => {
      if (stateHandle() !== handle) {
        log('companion-hub/old-generation-exit', { code, signal, generation });
        return;
      }
      clearIfCurrent(code, signal);
      log('companion-hub/child-exit', { code, signal, generation });
    });
    try {
      childIdentity = await readProcessIdentity(handle.pid, { provider: processProvider });
    } catch {
      childIdentity = null;
    }
    if (child !== handle) return { ok: false, code: 'HUB_EXITED_DURING_START' };
    if (!childIdentity?.available || !childIdentity.created_at || !childIdentity.exe_path || !childIdentity.entry_path) {
      lastError = 'HUB_IDENTITY_UNAVAILABLE';
      writeHubState('HALTED', { reason_code: 'HUB_IDENTITY_UNAVAILABLE' });
      lifecycle = 'HUB_REVIEW';
      return { ok: false, code: 'HUB_IDENTITY_UNAVAILABLE' };
    }
    lastChildIdentity = {
      pid: childIdentity.pid,
      created_at: childIdentity.created_at,
      exe_path: childIdentity.exe_path,
      entry_path: childIdentity.entry_path,
    };
    writeGeneration({ server_pid: handle.pid });
    writeHubState('STARTING');
    const deadline = now() + startTimeoutMs;
    while (now() < deadline) {
      if (child !== handle) return { ok: false, code: 'HUB_EXITED_DURING_START' };
      const probe = await probeHub({ runtimeDir: runtimeRoot, installation, token: fs.existsSync(runtime.tokenFile) ? fs.readFileSync(runtime.tokenFile, 'utf8').trim() : '' });
      if (probe.state === 'SAME') {
        resolved = true;
        if (!recordReady(handle.pid)) return { ok: false, code: 'HUB_RESTART_STATE_WRITE_FAILED' };
        return { ok: true, pid: handle.pid, info: probe.info };
      }
      if (probe.state === 'FOREIGN') {
        lastError = 'HUB_INSTANCE_MISMATCH';
        lifecycle = 'HUB_REVIEW';
        return { ok: false, code: 'HUB_INSTANCE_MISMATCH' };
      }
      await sleep(100);
    }
    lastError = 'HUB_START_UNCONFIRMED';
    scheduleRestart('hub-start-timeout');
    return { ok: false, code: 'HUB_START_UNCONFIRMED' };
  }

  function stateHandle() {
    return child;
  }

  async function ensureHub() {
    if (stopping) return { ok: false, code: 'STOPPING' };
    if (child !== null && child.exitCode === null) {
      return { ok: false, code: 'HUB_START_PENDING' };
    }
    if (policyCorrupt || policy.snapshot().halted) {
      lifecycle = 'HALTED';
      writeHubState('HALTED', { reason_code: 'HUB_RESTART_HALTED' });
      return { ok: false, code: 'HUB_RESTART_HALTED' };
    }
    const desired = desiredStateFor(runtimeRoot);
    if (desired.state === 'STOPPED') {
      lifecycle = 'STOPPED_DESIRED';
      writeHubState('STOPPED', { reason_code: 'DESIRED_STATE_STOPPED' });
      return { ok: false, code: 'DESIRED_STATE_STOPPED' };
    }
    if (desired.state === 'INVALID') {
      lifecycle = 'HALTED';
      lastError = desired.code;
      writeHubState('HALTED', { reason_code: desired.code });
      return { ok: false, code: desired.code };
    }
    const probe = await probeHub({ runtimeDir: runtimeRoot, installation, token: fs.existsSync(runtime.tokenFile) ? fs.readFileSync(runtime.tokenFile, 'utf8').trim() : '' });
    if (probe.state === 'SAME') {
      const generation = readGeneration();
      let server = null;
      try { server = JSON.parse(fs.readFileSync(runtime.serverInfoFile, 'utf8')); } catch { server = null; }
      let adoptedOwn = false;
      let identityProof = null;
      if (generation !== null && server !== null &&
          generation.installation_id === installation.installation_id &&
          generation.instance_id === installation.instance_id &&
          Number.isInteger(generation.child?.pid) && generation.child.pid === server.pid) {
        let actual = null;
        try { actual = await readProcessIdentity(server.pid, { provider: processProvider }); }
        catch { actual = null; }
        const comparison = actual === null ? { verdict: 'UNKNOWN' } : sameProcess(actual, {
          pid: generation.child.pid,
          created_at: generation.child.created_at,
          exe_path: generation.child.exe_path,
          entry_path: generation.child.entry_path,
        });
        adoptedOwn = actual !== null && actual.alive === true && comparison.verdict === 'SAME';
        if (adoptedOwn) identityProof = { ...generation.child };
      }
      externalHub = {
        reused: true,
        pid: Number.isInteger(server?.pid) ? server.pid : null,
        adopted_own: adoptedOwn,
        identity_proof: identityProof,
        code_identity: probe.code_identity ?? null,
      };
      if (!recordReady(externalHub.pid)) return { ok: false, code: 'HUB_RESTART_STATE_WRITE_FAILED' };
      return { ok: true, reused: true, adopted_own: adoptedOwn, info: probe.info };
    }
    if (probe.state === 'FOREIGN') {
      lifecycle = 'HUB_REVIEW';
      lastError = 'HUB_INSTANCE_MISMATCH';
      writeHubState('HALTED', { reason_code: 'HUB_INSTANCE_MISMATCH' });
      return { ok: false, code: 'HUB_INSTANCE_MISMATCH' };
    }
    if (probe.state === 'UNREACHABLE' && fs.existsSync(runtime.serverInfoFile)) {
      const own = readGeneration();
      let server = null;
      try { server = JSON.parse(fs.readFileSync(runtime.serverInfoFile, 'utf8')); } catch { server = null; }
      const ownServer = own !== null && own.installation_id === installation.installation_id &&
        own.instance_id === installation.instance_id && Number.isInteger(own.child?.pid) &&
        server !== null && server.pid === own.child.pid;
      if (!ownServer) {
        lifecycle = 'ORPHAN_REVIEW';
        lastError = 'ORPHAN_REVIEW_REQUIRED';
        writeHubState('HALTED', { reason_code: 'ORPHAN_REVIEW_REQUIRED', pid: server?.pid ?? null });
        return { ok: false, code: 'ORPHAN_REVIEW_REQUIRED' };
      }
      const recorded = await readProcessIdentity(own.child.pid, { provider: processProvider });
      if (recorded.alive !== false) {
        lifecycle = 'ORPHAN_REVIEW';
        lastError = 'ORPHAN_MAYBE_ALIVE';
        writeHubState('HALTED', { reason_code: 'ORPHAN_MAYBE_ALIVE', pid: own.child.pid });
        return { ok: false, code: 'ORPHAN_MAYBE_ALIVE' };
      }
      // Only our exact dead generation may clean its own stale server record.
      try { fs.rmSync(runtime.serverInfoFile, { force: true }); } catch { /* best effort */ }
      writeGeneration({ last_exit: { code: null, signal: 'SIGKILL', at: new Date(now()).toISOString(), reason: 'OWN_HUB_DEAD' }, server_pid: null });
      log('companion-hub/own-stale-server-cleared', { pid: own.child.pid });
    }
    const started = await startHubChild();
    if (!started.ok) {
      if (policyCorrupt) {
        lifecycle = 'HALTED';
        lastError = 'HUB_RESTART_STATE_WRITE_FAILED';
        writeHubState('HALTED', { reason_code: 'HUB_RESTART_STATE_WRITE_FAILED' });
        return started;
      }
      lifecycle = started.code === 'HUB_INSTANCE_MISMATCH' ? 'HUB_REVIEW' : 'BACKOFF';
      writeHubState(lifecycle === 'BACKOFF' ? 'BACKOFF' : 'HALTED', { reason_code: started.code });
      return started;
    }
    return started;
  }

  async function stopAdoptedOwnHub() {
    const proof = externalHub?.identity_proof ?? readGeneration()?.child ?? null;
    if (proof === null || !Number.isInteger(proof.pid) || typeof proof.created_at !== 'string' ||
        typeof proof.exe_path !== 'string' || typeof proof.entry_path !== 'string') {
      lifecycle = 'STOP_UNCONFIRMED';
      lastError = 'STOP_UNCONFIRMED_NO_ADOPTED_HUB_PROOF';
      writeHubState('STOPPED', { reason_code: lastError });
      return { confirmed: false, stopped: false };
    }
    let actual = null;
    try { actual = await readProcessIdentity(proof.pid, { provider: processProvider }); }
    catch { actual = null; }
    if (isProvablyDead(actual)) {
      externalHub = null;
      return { confirmed: true, stopped: false };
    }
    const comparison = actual?.alive === true ? sameProcess(actual, {
      pid: proof.pid,
      created_at: proof.created_at,
      exe_path: proof.exe_path,
      entry_path: proof.entry_path,
    }) : { verdict: 'UNKNOWN' };
    if (actual?.alive !== true || comparison.verdict !== 'SAME') {
      lifecycle = 'STOP_UNCONFIRMED';
      lastError = `STOP_UNCONFIRMED_ADOPTED_HUB_${comparison.verdict}`;
      writeHubState('STOPPED', { reason_code: lastError });
      return { confirmed: false, stopped: false };
    }
    try { process.kill(proof.pid, 'SIGTERM'); } catch {
      lifecycle = 'STOP_UNCONFIRMED';
      lastError = 'STOP_UNCONFIRMED_ADOPTED_HUB_SIGNAL_FAILED';
      writeHubState('STOPPED', { reason_code: lastError });
      return { confirmed: false, stopped: false };
    }
    const deadline = now() + 10_000;
    while (now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      let current = null;
      try { current = await readProcessIdentity(proof.pid, { provider: processProvider }); }
      catch { current = null; }
      if (isProvablyDead(current)) {
        externalHub = null;
        return { confirmed: true, stopped: true };
      }
    }
    lifecycle = 'STOP_UNCONFIRMED';
    lastError = 'STOP_TIMEOUT_ADOPTED_HUB';
    writeHubState('STOPPED', { reason_code: lastError });
    return { confirmed: false, stopped: false };
  }

  async function stopOwnChild() {
    const handle = child;
    if (handle === null || handle.exitCode !== null) {
      if (externalHub?.adopted_own === true) return stopAdoptedOwnHub();
      child = null;
      childIdentity = null;
      return { confirmed: true, stopped: false };
    }
    const own = readGeneration();
    const expected = own?.child;
    if (expected === null || expected === undefined || !Number.isInteger(expected.pid)) {
      lifecycle = 'STOP_UNCONFIRMED';
      lastError = 'STOP_UNCONFIRMED_NO_GENERATION';
      writeHubState('STOPPED', { reason_code: 'STOP_UNCONFIRMED_NO_GENERATION' });
      return { confirmed: false, stopped: false };
    }
    let actual = null;
    try { actual = await readProcessIdentity(expected.pid, { provider: processProvider }); }
    catch { actual = null; }
    const comparison = actual === null ? { verdict: 'UNKNOWN' } : sameProcess(actual, {
      pid: expected.pid,
      created_at: expected.created_at,
      exe_path: expected.exe_path,
      entry_path: expected.entry_path,
    });
    if (actual === null || actual.alive !== true || comparison.verdict !== 'SAME') {
      lifecycle = 'STOP_UNCONFIRMED';
      lastError = `STOP_UNCONFIRMED_IDENTITY_${comparison.verdict}`;
      writeHubState('STOPPED', { reason_code: lastError });
      return { confirmed: false, stopped: false };
    }
    try {
      handle.kill('SIGTERM');
    } catch (error) {
      lifecycle = 'STOP_UNCONFIRMED';
      lastError = `SIGNAL_FAILED:${String(error?.message ?? error)}`;
      writeHubState('STOPPED', { reason_code: lastError });
      return { confirmed: false, stopped: false };
    }
    const exited = await waitForExit(handle, stopTimeoutMs);
    if (!exited) {
      lifecycle = 'STOP_UNCONFIRMED';
      lastError = 'STOP_TIMEOUT';
      writeHubState('STOPPED', { reason_code: 'STOP_TIMEOUT' });
      return { confirmed: false, stopped: false };
    }
    child = null;
    childIdentity = null;
    return { confirmed: true, stopped: true };
  }

  function stop() {
    // Every caller must await the same in-flight stop. Returning status() here
    // would let companion/main exit while the first stop is still waiting for
    // fresh identity or for the adopted Hub to die.
    if (stopPromise !== null) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      if (heartbeatTimer !== null) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (restartTimer !== null) { clearTimeout(restartTimer); restartTimer = null; }
      if (stableTimer !== null) { clearTimeout(stableTimer); stableTimer = null; }
      const stopped = await stopOwnChild();
      if (stopped.confirmed && lease !== null) {
        releaseHubOwner({ runtimeDir: runtimeRoot, nonce: lease.lock.nonce });
        lease = null;
        writeHubState('STOPPED', { reason_code: 'STOPPED' });
      } else if (!stopped.confirmed) {
        writeHubState('STOPPED', { reason_code: lastError ?? 'STOP_UNCONFIRMED' });
      }
      return status();
    })();
    return stopPromise;
  }

  async function runStart() {
    if (installation.hub_owner_kind !== 'COMPANION_OWNED') {
      lifecycle = 'NOT_HUB_OWNER';
      writeHubState('STOPPED', { reason_code: 'COMPANION_MODE_REQUIRED' });
      return status();
    }
    if (desiredStateFor(runtimeRoot).state === 'STOPPED') {
      lifecycle = 'STOPPED_DESIRED';
      writeHubState('STOPPED', { reason_code: 'DESIRED_STATE_STOPPED' });
      return status();
    }
    if (desiredStateFor(runtimeRoot).state === 'INVALID') {
      lifecycle = 'HALTED';
      lastError = 'DESIRED_STATE_INVALID';
      writeHubState('HALTED', { reason_code: 'DESIRED_STATE_INVALID' });
      return status();
    }
    if (lifecycle === 'READY' && (child !== null || externalHub !== null)) return status();
    if (policyCorrupt || policy.snapshot().halted) {
      lifecycle = 'HALTED';
      writeHubState('HALTED', { reason_code: 'HUB_RESTART_HALTED' });
      return status();
    }
    const claimed = await claimOwner();
    if (!claimed.ok) {
      lifecycle = claimed.code === 'OWNER_REVIEW_REQUIRED' ? 'OWNER_REVIEW_REQUIRED' : 'HUB_REVIEW';
      lastError = claimed.code;
      writeHubState('HALTED', { reason_code: claimed.code });
      return status();
    }
    if (heartbeatTimer === null) {
      heartbeatTimer = setInterval(async () => {
        if (stopping || lease === null) return;
        const desired = desiredStateFor(runtimeRoot);
        if (desired.state === 'STOPPED') {
          if (!desiredStopSeen) {
            desiredStopSeen = true;
            lifecycle = 'STOPPED_DESIRED';
            try { await onDesiredStop?.(); } catch { /* best effort */ }
            void stop();
          }
          return;
        }
        if (desired.state === 'INVALID') {
          lifecycle = 'HALTED';
          lastError = 'DESIRED_STATE_INVALID';
          writeHubState('HALTED', { reason_code: 'DESIRED_STATE_INVALID' });
          try { await onDesiredInvalid?.(); } catch { /* best effort */ }
          return;
        }
        try {
          heartbeatHubOwner({ runtimeDir: runtimeRoot, nonce: lease.lock.nonce, now: now(), ttlMs: leaseMs });
        } catch (error) {
          log('companion-hub/owner-heartbeat-failed', { message: String(error?.message ?? error) });
        }
        await probeHealthNow();
        if (fs.existsSync(stateFile)) updateServiceState(stateFile, { last_heartbeat_at: new Date(now()).toISOString() });
      }, heartbeatMs);
      heartbeatTimer.unref?.();
    }
    await ensureHub();
    return status();
  }

  async function start() {
    if (startPromise !== null) return startPromise;
    startPromise = runStart().finally(() => { startPromise = null; });
    return startPromise;
  }

  function status() {
    return {
      lifecycle,
      owner_mode: installation.hub_owner_kind,
      owner_epoch: ownerEpoch,
      child_pid: child?.pid ?? null,
      reused_external: externalHub?.reused === true,
      adopted_own_hub: externalHub?.adopted_own === true,
      running_code_identity: externalHub?.code_identity ?? runningCodeIdentity ?? null,
      desired_state: desiredStateFor(runtimeRoot).state,
      policy_corrupt: policyCorrupt,
      health,
      last_probe_at: lastProbeAt === null ? null : new Date(lastProbeAt).toISOString(),
      health_probe_count: healthProbeCount,
      last_probe_error: lastProbeError,
      restart_policy: policy.snapshot(),
      last_error: lastError,
      last_exit: lastExit,
      service_state: (() => { try { return readServiceState(stateFile); } catch { return null; } })(),
      generation: readGeneration(),
    };
  }

  return { start, stop, status };
}
