// Shared installation locator for the Local Agent Bridge.
//
// One user-level installation describes the canonical program/data roots, the
// active instance and the Hub ownership mode. It must never contain the Hub
// pairing token or message content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const INSTALLATION_SCHEMA_VERSION = 1;

export const HUB_OWNER_MODES = Object.freeze([
  'COMPANION_OWNED',
  'DSH_PLUGIN_OWNED',
  'EXTERNAL_UNMANAGED',
  'MANUAL',
]);

export class InstallationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InstallationError';
    this.code = code;
    this.details = details;
  }
}

/** Default user-level installation root; an explicit root always wins in callers. */
export function defaultInstallationRoot({ env = process.env, homedir = os.homedir() } = {}) {
  const localAppData = typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.length > 0
    ? env.LOCALAPPDATA
    : path.join(homedir, 'AppData', 'Local');
  return path.join(localAppData, 'LocalAgentBridge');
}

/** Stable paths derived from an installation root. Does not create anything. */
export function installationPaths(root = defaultInstallationRoot()) {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    locator: path.join(resolved, 'installation.json'),
    appRoot: path.join(resolved, 'app'),
    dataRoot: path.join(resolved, 'data'),
    runtimeRoot: path.join(resolved, 'data', 'runtime'),
    membershipsDir: path.join(resolved, 'data', 'memberships'),
  };
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InstallationError('INSTALLATION_INVALID', `${field} must be a non-empty string`, { field });
  }
  return value;
}

function requireAbsolutePath(value, field) {
  requireNonEmptyString(value, field);
  if (!path.isAbsolute(value)) {
    throw new InstallationError('INSTALLATION_INVALID', `${field} must be an absolute path`, { field });
  }
  return path.resolve(value);
}

/** Validate and normalize an installation record without reading/writing files. */
export function validateInstallation(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InstallationError('INSTALLATION_INVALID', 'installation must be an object');
  }
  const v = value.v ?? INSTALLATION_SCHEMA_VERSION;
  if (v !== INSTALLATION_SCHEMA_VERSION) {
    throw new InstallationError('INSTALLATION_SCHEMA_UNSUPPORTED', `unsupported installation schema: ${String(v)}`, { v });
  }
  const ownerMode = value.hub_owner_kind;
  if (!HUB_OWNER_MODES.includes(ownerMode)) {
    throw new InstallationError('INSTALLATION_INVALID', 'hub_owner_kind is not supported', { field: 'hub_owner_kind' });
  }
  if (!Number.isInteger(value.protocol_version) || value.protocol_version < 1) {
    throw new InstallationError('INSTALLATION_INVALID', 'protocol_version must be a positive integer', { field: 'protocol_version' });
  }
  if (!Number.isInteger(value.state_schema) || value.state_schema < 1) {
    throw new InstallationError('INSTALLATION_INVALID', 'state_schema must be a positive integer', { field: 'state_schema' });
  }
  if (value.component_versions !== undefined && (value.component_versions === null || typeof value.component_versions !== 'object' || Array.isArray(value.component_versions))) {
    throw new InstallationError('INSTALLATION_INVALID', 'component_versions must be an object', { field: 'component_versions' });
  }
  if (value.profiles !== undefined && !Array.isArray(value.profiles)) {
    throw new InstallationError('INSTALLATION_INVALID', 'profiles must be an array', { field: 'profiles' });
  }
  return {
    v: INSTALLATION_SCHEMA_VERSION,
    installation_id: requireNonEmptyString(value.installation_id, 'installation_id'),
    instance_id: requireNonEmptyString(value.instance_id, 'instance_id'),
    active_version: requireNonEmptyString(value.active_version, 'active_version'),
    app_root: requireAbsolutePath(value.app_root, 'app_root'),
    runtime_root: requireAbsolutePath(value.runtime_root, 'runtime_root'),
    hub_owner_kind: ownerMode,
    protocol_version: value.protocol_version,
    state_schema: value.state_schema,
    component_versions: value.component_versions === undefined ? {} : { ...value.component_versions },
    profiles: value.profiles === undefined ? [] : [...value.profiles],
    last_verified: typeof value.last_verified === 'string' ? value.last_verified : new Date().toISOString(),
  };
}

/** Read the locator. Missing locator returns null unless `required` is true. */
export function readInstallation({ root, env = process.env, required = false } = {}) {
  const paths = installationPaths(root ?? defaultInstallationRoot({ env }));
  if (!fs.existsSync(paths.locator)) {
    if (required) throw new InstallationError('INSTALLATION_MISSING', `installation locator missing: ${paths.locator}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(paths.locator, 'utf8'));
  } catch (error) {
    throw new InstallationError('INSTALLATION_INVALID', `cannot parse installation locator: ${paths.locator}`, { cause: String(error?.message ?? error) });
  }
  return validateInstallation(parsed);
}

/** Atomically write a locator; tokens and message content are rejected. */
export function writeInstallationAtomic({ root, installation }) {
  const forbidden = ['token', 'hub_token', 'messages', 'text'];
  if (installation !== null && typeof installation === 'object') {
    for (const key of forbidden) {
      if (Object.hasOwn(installation, key)) {
        throw new InstallationError('INSTALLATION_FORBIDDEN_FIELD', `forbidden field in installation: ${key}`, { field: key });
      }
    }
  }
  const normalized = validateInstallation(installation);
  const paths = installationPaths(root);
  fs.mkdirSync(paths.root, { recursive: true });
  const temp = `${paths.locator}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, paths.locator);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
  return { ...normalized };
}

/** Create a fresh installation record and write it. Used by installers/tests. */
export function createInstallation({
  root,
  activeVersion = '0.0.0-dev',
  hubOwnerKind = 'MANUAL',
  runtimeRoot,
  protocolVersion = 1,
  stateSchema = 1,
  componentVersions = {},
  profiles = [],
} = {}) {
  const paths = installationPaths(root);
  const installation = {
    v: INSTALLATION_SCHEMA_VERSION,
    installation_id: crypto.randomUUID(),
    instance_id: crypto.randomUUID(),
    active_version: activeVersion,
    app_root: path.join(paths.root, 'app', activeVersion),
    runtime_root: path.resolve(runtimeRoot ?? paths.runtimeRoot),
    hub_owner_kind: hubOwnerKind,
    protocol_version: protocolVersion,
    state_schema: stateSchema,
    component_versions: { ...componentVersions },
    profiles: [...profiles],
    last_verified: new Date().toISOString(),
  };
  return writeInstallationAtomic({ root: paths.root, installation });
}

/**
 * Resolve the runtime root. Production callers must pass an installation.
 * Explicit overrides are permitted only for isolated/dev runs and never
 * silently select a different instance when an installation is already bound.
 */
export function resolveRuntime({ installation, explicit, env = process.env, allowIsolatedOverride = false } = {}) {
  const override = explicit ?? (env.LAB_BRIDGE_RUNTIME_DIR === undefined || env.LAB_BRIDGE_RUNTIME_DIR === ''
    ? undefined
    : env.LAB_BRIDGE_RUNTIME_DIR);
  if (installation !== undefined && installation !== null) {
    const normalized = validateInstallation(installation);
    if (override !== undefined) {
      if (!allowIsolatedOverride) {
        throw new InstallationError('RUNTIME_INSTANCE_CONFLICT', 'explicit runtime conflicts with the bound installation instance', {
          installation_runtime_root: normalized.runtime_root,
          explicit_runtime_root: path.resolve(override),
        });
      }
      return { runtimeRoot: path.resolve(override), source: 'explicit-isolated', installation: normalized };
    }
    return { runtimeRoot: normalized.runtime_root, source: 'installation', installation: normalized };
  }
  if (override !== undefined) {
    return { runtimeRoot: path.resolve(override), source: 'explicit-dev', installation: null };
  }
  throw new InstallationError('INSTALLATION_MISSING', 'no installation and no explicit isolated runtime');
}
