// Receiver-specific use of the shared process/owner-lock primitives. PID alone
// is never sufficient, and old/unknown locks are left for explicit review.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonSafe } from '../../src/health.mjs';
import { readProcessIdentity, sameProcess, isOwnerAlive, acquireOwnerLock, heartbeatOwnerLock, releaseOwnerLock } from '../../src/process-identity.mjs';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const paths = (config, component) => ({
  lock: path.join(config.runtime_dir, component === 'service' ? 'service.lock' : 'receiver.lock'),
  status: path.join(config.runtime_dir, component === 'service' ? 'service-status.json' : 'status.json'),
});

export function receiverIds(config) {
  return { installation_id: config.installation_id ?? 'legacy-manual', instance_id: config.instance_id ?? config.window_id };
}

function lockBelongs(lock, config, configFile, component) {
  const ids = receiverIds(config);
  return lock?.installation_id === ids.installation_id && lock?.instance_id === ids.instance_id &&
    lock.thread_id === config.thread_id && lock.owner_component === 'codex-' + component &&
    (config.binding_epoch === undefined || lock.binding_epoch === config.binding_epoch) &&
    samePath(lock.config_path, configFile) && typeof lock.nonce === 'string' && typeof lock.owner_process?.created_at === 'string';
}

export async function inspectReceiverProcess(config, configFile, component = 'worker', { provider, now = Date.now() } = {}) {
  const file = paths(config, component).lock, lock = readJsonSafe(file);
  if (!fs.existsSync(file)) return { status: 'ABSENT', lock: null, running: false };
  if (!lockBelongs(lock, config, configFile, component)) return { status: 'UNKNOWN', lock, running: null, reason_codes: ['LOCK_BINDING_OR_IDENTITY_UNKNOWN'] };
  const health = await isOwnerAlive({ lock, provider, now });
  return { ...health, lock, running: health.status === 'ALIVE' || health.status === 'UNRESPONSIVE' ? true : health.status === 'DEAD' ? false : null };
}

async function lockTransaction(config, configFile, component, operation) {
  const file = paths(config, component).lock + '.transaction', nonce = crypto.randomUUID();
  fs.mkdirSync(config.runtime_dir, { recursive: true });
  try { fs.writeFileSync(file, JSON.stringify({ nonce, pid: process.pid, thread_id: config.thread_id,
    config_path: path.resolve(configFile) }), { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') fail('LOCK_RECOVERY_REVIEW_REQUIRED');
    throw error;
  }
  try { return await operation(); }
  finally {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).nonce === nonce) fs.unlinkSync(file); } catch { /* never remove another transaction */ }
  }
}

async function recoverUnlocked(config, configFile, component, options) {
  const file = paths(config, component).lock;
  if (!fs.existsSync(file)) return 0;
  const state = await inspectReceiverProcess(config, configFile, component, options);
  if (state.status !== 'DEAD') fail(state.status === 'UNKNOWN' ? 'LOCK_REVIEW_REQUIRED' : 'LOCK_HELD_OR_UNRESPONSIVE');
  // A dead/reused PID is not signalled. Archive only our own exact record.
  const current = readJsonSafe(file);
  if (!current || current.nonce !== state.lock.nonce) fail('LOCK_CHANGED_DURING_REVIEW');
  fs.renameSync(file, file + '.stale-' + Date.now() + '-' + crypto.randomUUID());
  return state.lock.owner_epoch ?? 0;
}

export async function recoverReceiverLock(config, configFile, component = 'worker', options = {}) {
  return lockTransaction(config, configFile, component, () => recoverUnlocked(config, configFile, component, options));
}

export async function claimReceiverProcess(config, configFile, component = 'worker', { provider, nonce = crypto.randomUUID(), now = Date.now() } = {}) {
  return lockTransaction(config, configFile, component, async () => {
  const filePaths = paths(config, component);
  const previousEpoch = await recoverUnlocked(config, configFile, component, { provider, now });
  const identity = await readProcessIdentity(process.pid, { provider });
  if (!identity.available || sameProcess(identity, identity).verdict !== 'SAME' || !identity.exe_path || !identity.entry_path) fail('PROCESS_IDENTITY_UNAVAILABLE');
  const previousStatus = readJsonSafe(filePaths.status);
  const lastEpoch = Number.isSafeInteger(previousStatus?.owner_epoch) && previousStatus.owner_epoch > 0 ? previousStatus.owner_epoch : 0;
  const epoch = Math.max(previousEpoch, lastEpoch) + 1;
  const ids = receiverIds(config);
  const lock = { v: 1, ...ids, mode: config.hub_owner_kind ?? 'MANUAL', owner_component: 'codex-' + component,
    owner_epoch: epoch, binding_epoch: config.binding_epoch ?? null, thread_id: config.thread_id, config_path: path.resolve(configFile), nonce, pid: process.pid,
    worker_nonce: component === 'worker' ? nonce : null,
    owner_process: { pid: process.pid, created_at: identity.created_at, exe_realpath: identity.exe_path,
      entry_realpath: identity.entry_path, config_path: path.resolve(configFile) } };
  const result = await acquireOwnerLock({ file: filePaths.lock, lock, now });
  if (!result.ok) fail(result.code ?? 'LOCK_HELD');
  return { lock: result.lock, file: filePaths.lock, identity,
    heartbeat: (at = Date.now()) => {
      const result = heartbeatOwnerLock({ file: filePaths.lock, nonce, now: at });
      if (!result.ok) fail(result.code ?? 'LOCK_LOST');
      return result;
    },
    release: () => releaseOwnerLock({ file: filePaths.lock, nonce }),
    statusFields: { schema_version: 3, ...ids, owner_epoch: epoch, binding_epoch: config.binding_epoch ?? null, nonce, worker_nonce: component === 'worker' ? nonce : null,
      pid: process.pid, process_created_at: identity.created_at, exe_realpath: identity.exe_path,
      entry_realpath: identity.entry_path, owner_process: { ...lock.owner_process }, config_path: path.resolve(configFile) } };
  });
}
