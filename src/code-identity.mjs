// Actual program/build identity for Hub and the DSH plugin.
//
// Only program files are hashed (package.json, entry, the component's source
// directories). Tokens, queues, profiles, state and message data are never
// opened here. The source SHA is a local provenance fingerprint, not a release
// signature; a git checkout is explicitly DEV_UNRELEASED.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from './runtime.mjs';

export const CODE_IDENTITY_SCHEMA_VERSION = 1;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function walkMjs(root, relDir, files) {
  const dir = path.join(root, relDir);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'tests') continue;
      walkMjs(root, rel, files);
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.add(rel.replaceAll('\\', '/'));
    }
  }
}

function readReleaseChannel(rootDir) {
  const gitMarker = path.join(rootDir, '.git');
  if (fs.existsSync(gitMarker)) return { channel: 'DEV_UNRELEASED', released: false, reason: 'source-checkout' };
  return { channel: 'UNVERIFIED_RELEASE', released: false, reason: 'no-release-manifest' };
}

/**
 * Compute a deterministic identity for one component. Missing/incomplete
 * program input is UNVERIFIED, never silently treated as a match.
 */
export function computeCodeIdentity({ rootDir, component, entry, now = Date.now() } = {}) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) throw new TypeError('rootDir must be absolute');
  if (typeof component !== 'string' || component.length === 0) throw new TypeError('component is required');
  if (typeof entry !== 'string' || !path.isAbsolute(entry)) throw new TypeError('entry must be absolute');
  const root = path.resolve(rootDir);
  const entryPath = path.resolve(entry);
  const files = new Set();
  files.add('package.json');
  files.add(path.relative(root, entryPath).replaceAll('\\', '/'));
  walkMjs(root, 'src', files);
  if (component === 'hub') walkMjs(root, 'hub', files);
  if (component === 'dsh-plugin') walkMjs(root, 'adapters/dsh', files);
  const records = [];
  const reasons = [];
  for (const rel of [...files].sort()) {
    const absolute = path.resolve(root, rel);
    if (!absolute.startsWith(`${root}${path.sep}`) && absolute !== root) continue;
    let content;
    try {
      content = fs.readFileSync(absolute);
    } catch {
      reasons.push(`MISSING_${rel}`);
      continue;
    }
    records.push({ path: rel, bytes: content.length, sha256: sha256(content) });
  }
  const packageFile = path.join(root, 'package.json');
  let packageVersion = null;
  let packageName = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    packageVersion = typeof pkg.version === 'string' ? pkg.version : null;
    packageName = typeof pkg.name === 'string' ? pkg.name : null;
  } catch {
    reasons.push('PACKAGE_JSON_UNREADABLE');
  }
  const entryRecord = records.find((record) => record.path === path.relative(root, entryPath).replaceAll('\\', '/'));
  if (entryRecord === undefined) reasons.push('ENTRY_NOT_HASHED');
  const release = readReleaseChannel(root);
  const digestInput = JSON.stringify(records.map(({ path: rel, bytes, sha256: hash }) => ({ path: rel, bytes, sha256: hash })));
  return {
    schema_version: CODE_IDENTITY_SCHEMA_VERSION,
    status: reasons.length === 0 && entryRecord !== undefined ? 'OBSERVED' : 'UNVERIFIED',
    component,
    package_name: packageName,
    package_version: packageVersion,
    entry: entryPath,
    entry_sha256: entryRecord?.sha256 ?? null,
    source_sha256: reasons.length === 0 ? sha256(digestInput) : null,
    files: records,
    loaded_at: new Date(now).toISOString(),
    node_version: process.version,
    platform: process.platform,
    release_channel: release.channel,
    released: release.released,
    release_reason: release.reason,
    reasons,
  };
}

export function componentIdentityFile(runtimeDir, component) {
  const safe = component.replaceAll(/[^a-z0-9_-]/gi, '-');
  return path.join(runtimeDir, component === 'hub' ? 'hub' : 'dsh-plugin', `${safe}-identity.json`);
}

export function writeComponentIdentity({ runtimeDir, component, identity }) {
  const file = componentIdentityFile(runtimeDir, component);
  writeJsonAtomic(file, identity);
  return { written: true, path: file, source_sha256: identity?.source_sha256 ?? null };
}

export function readComponentIdentity({ runtimeDir, component }) {
  const file = componentIdentityFile(runtimeDir, component);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value?.schema_version === CODE_IDENTITY_SCHEMA_VERSION ? value : null;
  } catch {
    return null;
  }
}

function summary(identity) {
  if (identity === null || identity === undefined) {
    return { status: 'UNVERIFIED', package_version: null, source_sha256: null, entry: null, loaded_at: null, release_channel: null };
  }
  return {
    status: identity.source_sha256 ? 'OBSERVED' : 'UNVERIFIED',
    package_version: identity.package_version ?? null,
    source_sha256: identity.source_sha256 ?? null,
    entry: identity.entry ?? null,
    loaded_at: identity.loaded_at ?? null,
    release_channel: identity.release_channel ?? null,
    released: identity.released === true,
  };
}

/**
 * Compare locator-declared, currently-installed and actually-running identities.
 * Missing old fields => UNVERIFIED. A version/hash divergence => PENDING_RELOAD,
 * never "same instance implies the new implementation is running".
 */
export function compareCodeIdentities({ declared = null, installed = null, running = null } = {}) {
  const declaredView = summary(declared);
  const installedView = summary(installed);
  const runningView = summary(running);
  const mismatches = [];
  const comparePair = (left, right, prefix) => {
    if (left.package_version !== null && right.package_version !== null && left.package_version !== right.package_version) mismatches.push(`${prefix}_VERSION`);
    if (left.source_sha256 !== null && right.source_sha256 !== null && left.source_sha256 !== right.source_sha256) mismatches.push(`${prefix}_SOURCE_HASH`);
  };
  comparePair(installedView, runningView, 'INSTALLED_VS_RUNNING');
  comparePair(declaredView, installedView, 'DECLARED_VS_INSTALLED');
  let verdict;
  if (runningView.status !== 'OBSERVED' || installedView.status !== 'OBSERVED') verdict = 'UNVERIFIED';
  else if (mismatches.length > 0) verdict = 'PENDING_RELOAD';
  else if (declaredView.status !== 'OBSERVED') verdict = 'UNVERIFIED';
  else verdict = 'MATCH';
  return {
    schema_version: CODE_IDENTITY_SCHEMA_VERSION,
    verdict,
    mismatches,
    locator_declared: declaredView,
    installed_program: installedView,
    running_identity: runningView,
    release_channel: installedView.release_channel,
    released: installedView.released,
    requires_reload: verdict === 'PENDING_RELOAD',
    same_instance_is_not_version_proof: true,
  };
}

export function hostIdentityMetadata(identity) {
  if (identity === null || typeof identity !== 'object') return null;
  return {
    schema_version: CODE_IDENTITY_SCHEMA_VERSION,
    component: identity.component ?? null,
    package_version: identity.package_version ?? null,
    source_sha256: identity.source_sha256 ?? null,
    entry: identity.entry ?? null,
    entry_sha256: identity.entry_sha256 ?? null,
    loaded_at: identity.loaded_at ?? null,
    node_version: identity.node_version ?? null,
    release_channel: identity.release_channel ?? null,
    released: identity.released === true,
  };
}
