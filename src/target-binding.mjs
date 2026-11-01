// Server-side target binding epoch stamps.
//
// The sender must never be trusted for the target generation. On receive, the
// Hub resolves the target's exact membership/config from this installation and
// stamps meta.target_binding_epoch. Legacy targets without an installation
// membership keep the old unstamped behavior; a sender-supplied epoch on a
// legacy target is rejected rather than trusted.
import fs from 'node:fs';
import path from 'node:path';
import { readMembership, membershipPath } from './membership.mjs';

export const TARGET_BINDING_EPOCH_META_KEY = 'target_binding_epoch';

export class TargetBindingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TargetBindingError';
    this.code = code;
    this.details = details;
  }
}

function normalizePath(value) {
  let resolved;
  try { resolved = fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value); }
  catch { resolved = path.resolve(value); }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(root, candidate) {
  const relative = path.relative(normalizePath(root), normalizePath(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function expectedThread(target) {
  return typeof target === 'string' && target.startsWith('codex:') ? target.slice('codex:'.length) : null;
}

function readConfigStrict({ configPath, target, installation, locatorPath, membership }) {
  if (!fs.existsSync(configPath)) return { ok: false, code: 'TARGET_BINDING_CONFIG_MISSING' };
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { ok: false, code: 'TARGET_BINDING_CONFIG_INVALID' };
  }
  const thread = expectedThread(target);
  if (thread === null) return { ok: false, code: 'TARGET_BINDING_TARGET_UNSUPPORTED' };
  if (config.thread_id !== thread) return { ok: false, code: 'TARGET_BINDING_TARGET_MISMATCH' };
  if (config.installation_id !== installation.installation_id) return { ok: false, code: 'TARGET_BINDING_INSTALLATION_MISMATCH' };
  if (config.instance_id !== installation.instance_id) return { ok: false, code: 'TARGET_BINDING_INSTANCE_MISMATCH' };
  if (config.binding_epoch !== membership.binding_epoch) return { ok: false, code: 'TARGET_BINDING_EPOCH_MISMATCH' };
  if (config.enabled !== true) return { ok: false, code: 'TARGET_BINDING_DISABLED' };
  if (config.owner_opt_in !== true) return { ok: false, code: 'TARGET_BINDING_OPT_IN_MISSING' };
  if (typeof config.runtime_dir !== 'string' || !path.isAbsolute(config.runtime_dir)) return { ok: false, code: 'TARGET_BINDING_RUNTIME_INVALID' };
  if (!isPathInside(installation.runtime_root, config.runtime_dir)) return { ok: false, code: 'TARGET_BINDING_RUNTIME_OUTSIDE_INSTALL' };
  if (!isPathInside(installation.runtime_root, configPath)) return { ok: false, code: 'TARGET_BINDING_CONFIG_OUTSIDE_INSTALL' };
  const locator = config.locator_path ?? config.locator;
  if (typeof locator !== 'string' || !path.isAbsolute(locator)) return { ok: false, code: 'TARGET_BINDING_LOCATOR_MISSING' };
  if (normalizePath(locator) !== normalizePath(locatorPath)) return { ok: false, code: 'TARGET_BINDING_LOCATOR_MISMATCH' };
  return { ok: true, config };
}

/**
 * Resolve the exact target binding for one target. This is a server-side read;
 * it never consults sender metadata.
 *
 * @returns {{state:'BOUND', epoch:string, target:string, config_path:string} |
 *           {state:'LEGACY', target:string, reason:string} |
 *           {state:'INVALID', target:string, code:string}}
 */
export function resolveTargetBinding({ runtimeRoot, target, installation, locatorPath }) {
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)) {
    throw new TargetBindingError('TARGET_BINDING_RUNTIME_REQUIRED', 'runtimeRoot must be absolute');
  }
  if (installation === null || typeof installation !== 'object') {
    throw new TargetBindingError('TARGET_BINDING_INSTALLATION_REQUIRED', 'installation is required');
  }
  const membership = readMembership(membershipPath(runtimeRoot, target));
  if (membership === null) return { state: 'LEGACY', target, reason: 'MEMBERSHIP_MISSING' };
  if (membership.installation_id !== installation.installation_id || membership.instance_id !== installation.instance_id) {
    return { state: 'INVALID', target, code: 'TARGET_BINDING_INSTANCE_MISMATCH' };
  }
  if (membership.receiver_kind !== 'daily') return { state: 'LEGACY', target, reason: 'RECEIVER_KIND_LEGACY' };
  if (membership.desired_state !== 'ENABLED' || membership.enabled !== true || membership.owner_opt_in !== true) {
    return { state: 'INVALID', target, code: 'TARGET_BINDING_MEMBERSHIP_DISABLED' };
  }
  const config = readConfigStrict({
    configPath: membership.config_path,
    target,
    installation,
    locatorPath,
    membership,
  });
  if (config.ok !== true) return { state: 'INVALID', target, code: config.code };
  return {
    state: 'BOUND',
    target,
    epoch: membership.binding_epoch,
    config_path: membership.config_path,
    config: config.config,
  };
}

/**
 * Apply the server-resolved binding to an envelope. A sender-supplied epoch is
 * accepted only if it equals the server resolution; the stored value is always
 * the server stamp. Legacy targets stay unstamped and reject self-reported
 * epochs.
 */
export function applyTargetBindingEpoch(envelope, binding) {
  const meta = envelope.meta !== null && typeof envelope.meta === 'object' && !Array.isArray(envelope.meta)
    ? { ...envelope.meta }
    : {};
  const claimed = meta[TARGET_BINDING_EPOCH_META_KEY];
  if (binding.state === 'LEGACY') {
    if (claimed !== undefined) {
      return { ok: false, code: 'target-binding-epoch-untrusted', message: 'sender-supplied target_binding_epoch is not trusted for a legacy target' };
    }
    return { ok: true, envelope, binding };
  }
  if (binding.state !== 'BOUND') {
    return { ok: false, code: 'target-binding-unavailable', message: binding.code ?? 'target binding is unavailable', details: binding };
  }
  if (claimed !== undefined && claimed !== binding.epoch) {
    return { ok: false, code: 'target-binding-epoch-conflict', message: `sender target_binding_epoch does not match this installation binding` };
  }
  meta[TARGET_BINDING_EPOCH_META_KEY] = binding.epoch;
  return { ok: true, envelope: { ...envelope, meta }, binding };
}

/** Build a synchronous receive hook for BridgeHub. */
export function createTargetBindingStamper({ installation, runtimeRoot, locatorPath, log = () => {} }) {
  return function stamp(envelope) {
    if (typeof envelope?.to !== 'string') return { ok: true, envelope };
    let binding;
    try {
      binding = resolveTargetBinding({ runtimeRoot, target: envelope.to, installation, locatorPath });
    } catch (error) {
      log('hub/target-binding-failed', { target: envelope.to, code: error?.code ?? 'TARGET_BINDING_FAILED' });
      return { ok: false, code: 'target-binding-failed', message: String(error?.message ?? error) };
    }
    const applied = applyTargetBindingEpoch(envelope, binding);
    if (!applied.ok) {
      log('hub/target-binding-rejected', { target: envelope.to, code: applied.code, state: binding.state });
    }
    return applied;
  };
}
