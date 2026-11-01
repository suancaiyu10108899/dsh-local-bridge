// Read-only installer plan. This module never writes a locator, token, task,
// registry value or live runtime artifact; it only reports what a later,
// explicitly windowed installation step would need to do.
import fs from 'node:fs';
import path from 'node:path';
import { HUB_OWNER_MODES, installationPaths, readInstallation } from '../src/installation.mjs';
import { runtimePaths } from '../src/runtime.mjs';

export const INSTALLER_PLAN_SCHEMA = 'stage-a-installer-plan/1';

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/** Build a deterministic, read-only installation plan. */
export function planInstallation({ installationRoot, now = Date.now() } = {}) {
  if (typeof installationRoot !== 'string' || !path.isAbsolute(installationRoot)) {
    throw new TypeError('installationRoot must be absolute');
  }
  const resolvedRoot = path.resolve(installationRoot);
  const paths = installationPaths(resolvedRoot);
  const locatorPresent = exists(paths.locator);
  let installation = null;
  let locatorError = null;
  if (locatorPresent) {
    try {
      installation = readInstallation({ root: resolvedRoot, required: true });
    } catch (error) {
      locatorError = error?.code ?? 'INSTALLATION_INVALID';
    }
  }
  const runtimeRoot = installation?.runtime_root ?? paths.runtimeRoot;
  const runtime = runtimePaths(runtimeRoot);
  const observed = {
    locator: locatorPresent,
    runtime_root: exists(runtimeRoot),
    state: exists(runtime.stateFile),
    token: exists(runtime.tokenFile),
    config: exists(runtime.configFile),
    server_info: exists(runtime.serverInfoFile),
    owner_lock: exists(runtime.ownerLockFile),
    memberships: exists(path.join(runtimeRoot, 'memberships')),
  };
  const mode = installation?.hub_owner_kind ?? null;
  const actions = [];
  const preconditions = [];
  if (!locatorPresent) {
    actions.push('CREATE_LOCATOR_AFTER_APPROVAL');
    preconditions.push('installation id/instance owner mode must be explicitly chosen');
  } else if (locatorError !== null) {
    actions.push('REPAIR_INVALID_LOCATOR_BEFORE_START');
    preconditions.push(`locator is invalid: ${locatorError}`);
  }
  if (mode !== null && !HUB_OWNER_MODES.includes(mode)) {
    actions.push('FAIL_CLOSED_UNSUPPORTED_OWNER_MODE');
  }
  if (mode === 'EXTERNAL_UNMANAGED') {
    actions.push('CONNECT_ONLY_NEVER_START_OR_KILL_HUB');
    preconditions.push('external owner must be explicitly adopted or handed over');
  } else if (mode !== null) {
    actions.push('ACQUIRE_HUB_OWNER_LEASE_THEN_START_OR_REUSE_HUB');
    preconditions.push('owner lease must prove same installation/instance; no TTL takeover of a live owner');
  }
  if (!observed.token) actions.push('TOKEN_CREATED_BY_NEW_HUB_OR_OWNER_AFTER_WINDOW');
  if (!observed.memberships) actions.push('MEMBERSHIP_DIR_MISSING_NO_WORKER_START');
  return {
    schema: INSTALLER_PLAN_SCHEMA,
    read_only: true,
    generated_at: new Date(now).toISOString(),
    installation_root: resolvedRoot,
    installation_id: installation?.installation_id ?? null,
    instance_id: installation?.instance_id ?? null,
    owner_mode: mode,
    locator_path: paths.locator,
    runtime_root: runtimeRoot,
    observed,
    actions,
    preconditions,
    live_cutover: false,
    notes: [
      'plan only: no locator/token/task/registry/runtime writes',
      'Hub must derive STATE/TOKEN/config/server-info from this same runtime_root',
      'a live cutover requires a separate user window and rollback card',
    ],
  };
}
