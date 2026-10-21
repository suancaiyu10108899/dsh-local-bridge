// Reversible installation of the DSH host plugin into a DSH profile.
//
// The plugin is loaded by the running DSH host from the profile's user patch
// file (cordis.patch.yml) as an `insert` row with a file URL. DSH's HMR applies
// the change without a restart; uninstalling restores the exact previous bytes
// when the file was not edited in between, or removes only our row when it was.
//
// State and backups are scoped per profile path so installing against one
// profile never makes another profile's recorded state look current. The plugin
// URL carries a content hash so reinstalling after a code change loads the new
// module (cache-busting) instead of a stale module URL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT, RUNTIME_DIR } from './runtime.mjs';

export const PLUGIN_ID = 'local-agent-bridge-dsh';
export const PLUGIN_FILE = path.join(PROJECT_ROOT, 'adapters', 'dsh', 'plugin.mjs');
export const PLUGIN_URL = pathToFileURL(PLUGIN_FILE).href;
export const INSTALL_ROOT = path.join(RUNTIME_DIR, 'dsh-plugin');

export class InstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
  }
}

/** Default profile patch path of the running DSH profile. */
export function defaultProfilePath({ env = process.env, home = os.homedir() } = {}) {
  const profileDir = env.DSH_PROFILE_DIR ?? path.join(home, '.dsh', 'profiles', 'desktop');
  return path.join(profileDir, 'cordis.patch.yml');
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase();
}

/** Content-hashed file URL for the current plugin module (cache-busting). */
export function pluginVersionedUrl(file = PLUGIN_FILE) {
  if (!fs.existsSync(file)) throw new InstallError('plugin-missing', `plugin module not found: ${file}`);
  const content = fs.readFileSync(file, 'utf8');
  return `${pathToFileURL(file).href}?v=${sha256(content).slice(0, 12).toLowerCase()}`;
}

/** Stable short key for one profile path (case-insensitive on Windows). */
export function profileKey(profilePath) {
  return sha256(path.resolve(profilePath).toLowerCase()).slice(0, 12);
}

/** Per-profile state file and backup directory. */
export function pathsForProfile(profilePath, { installRoot = INSTALL_ROOT } = {}) {
  const base = path.join(installRoot, `profile-${profileKey(profilePath)}`);
  return {
    stateFile: path.join(base, 'install-state.json'),
    backupDir: path.join(base, 'backups'),
  };
}

export function insertBlock(pluginUrl = PLUGIN_URL) {
  return `- insert:\n    - id: ${PLUGIN_ID}\n      name: '${pluginUrl}'\n`;
}

export const MODULE_WATCH_ID = 'hmr';

/** Roots watched for module hot reload (forward slashes for YAML friendliness). */
export function moduleWatchRoots({ projectRoot = PROJECT_ROOT } = {}) {
  return [projectRoot.replaceAll('\\', '/')];
}

/** Profile row that enables DSH module hot reload for this project. */
export function moduleWatchBlock(roots = moduleWatchRoots()) {
  const list = roots.map((root) => JSON.stringify(root)).join(', ');
  return `- id: ${MODULE_WATCH_ID}\n  config:\n    root: [${list}]\n`;
}

/** Per-profile state file and backup directory for the module-watch row. */
export function watchPathsForProfile(profilePath, { installRoot = INSTALL_ROOT } = {}) {
  const base = path.join(installRoot, `profile-${profileKey(profilePath)}`);
  return {
    stateFile: path.join(base, 'module-watch-state.json'),
    backupDir: path.join(base, 'watch-backups'),
  };
}

function appendBlock(content, block) {
  const separator = content.length === 0 ? '' : content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${separator}${block}`;
}

function watchRowPresent(content) {
  return new RegExp(`^\\s*- id:\\s*${MODULE_WATCH_ID}\\s*$`, 'm').test(content);
}

function resolveWatchPaths({ profilePath, stateFile, backupDir }) {
  const defaults = watchPathsForProfile(profilePath);
  return {
    stateFile: stateFile ?? defaults.stateFile,
    backupDir: backupDir ?? defaults.backupDir,
  };
}

/** Report module-watch row presence/ownership without changing anything. */
export function moduleWatchStatus({ profilePath = defaultProfilePath(), stateFile, backupDir, roots } = {}) {
  const resolved = resolveWatchPaths({ profilePath, stateFile, backupDir });
  const exists = fs.existsSync(profilePath);
  const content = exists ? fs.readFileSync(profilePath, 'utf8') : '';
  const block = moduleWatchBlock(roots);
  const state = readState(resolved.stateFile);
  const forThisProfile = stateMatchesProfile(state, profilePath);
  const currentSha = exists ? sha256(content) : undefined;
  const rootMatch = /^\s*root:\s*\[(.*?)\]\s*$/m.exec(content);
  return {
    profilePath,
    profileExists: exists,
    profileSha256: currentSha,
    block,
    stateFile: resolved.stateFile,
    state: forThisProfile ? state : null,
    controlled: forThisProfile && currentSha === state.afterSha256,
    recordedBackupConsistent: forThisProfile && currentSha === state.afterSha256,
    watched: exists && content.includes(block),
    rowPresent: exists && watchRowPresent(content),
    root: rootMatch?.[1] ?? undefined,
  };
}

/**
 * Add the module-watch row (idempotent). Refuses to touch a profile that
 * already carries an unrelated `hmr` row, so we never silently rewrite an
 * external user edit; use --dry-run/status to inspect first.
 */
export function enableModuleWatch({ profilePath = defaultProfilePath(), stateFile, backupDir, roots, now = new Date() } = {}) {
  const resolved = resolveWatchPaths({ profilePath, stateFile, backupDir });
  if (!fs.existsSync(profilePath)) throw new InstallError('profile-missing', `DSH profile patch not found: ${profilePath}`);
  const content = fs.readFileSync(profilePath, 'utf8');
  const block = moduleWatchBlock(roots);
  if (content.includes(block)) {
    return { ok: true, alreadyPresent: true, ...moduleWatchStatus({ profilePath, stateFile: resolved.stateFile, backupDir: resolved.backupDir, roots }) };
  }
  if (watchRowPresent(content)) {
    throw new InstallError('watch-row-conflict', `profile already contains an ${MODULE_WATCH_ID} row with a different config: ${profilePath}; inspect it before enabling bridge module watch`);
  }
  fs.mkdirSync(resolved.backupDir, { recursive: true });
  const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backupPath = path.join(resolved.backupDir, `cordis.patch.watch.${stamp}.yml`);
  fs.writeFileSync(backupPath, content, 'utf8');
  const beforeSha256 = sha256(content);
  const next = appendBlock(content, block);
  fs.writeFileSync(profilePath, next, 'utf8');
  if (!fs.readFileSync(profilePath, 'utf8').includes(block)) {
    throw new InstallError('watch-unverified', `module-watch row missing after write: ${profilePath}`);
  }
  const afterSha256 = sha256(fs.readFileSync(profilePath, 'utf8'));
  writeState(resolved.stateFile, {
    profilePath,
    watchBlock: block,
    roots: roots ?? moduleWatchRoots(),
    beforeSha256,
    afterSha256,
    backupPath,
    enabledAt: now.toISOString(),
    node: process.version,
  });
  return {
    ok: true,
    alreadyPresent: false,
    beforeSha256,
    afterSha256,
    backupPath,
    ...moduleWatchStatus({ profilePath, stateFile: resolved.stateFile, backupDir: resolved.backupDir, roots }),
  };
}

/** Remove the module-watch row, restoring exact bytes when nothing else changed. */
export function disableModuleWatch({ profilePath = defaultProfilePath(), stateFile, backupDir, roots } = {}) {
  const resolved = resolveWatchPaths({ profilePath, stateFile, backupDir });
  if (!fs.existsSync(profilePath)) return { ok: true, alreadyRemoved: true, profileExists: false };
  const content = fs.readFileSync(profilePath, 'utf8');
  const block = moduleWatchBlock(roots);
  const state = readState(resolved.stateFile);
  const forThisProfile = stateMatchesProfile(state, profilePath);
  if (!content.includes(block)) {
    return {
      ok: true,
      alreadyRemoved: true,
      ...moduleWatchStatus({ profilePath, stateFile: resolved.stateFile, backupDir: resolved.backupDir, roots }),
    };
  }
  if (forThisProfile && sha256(content) === state.afterSha256 && fs.existsSync(state.backupPath)) {
    const backup = fs.readFileSync(state.backupPath, 'utf8');
    if (sha256(backup) !== state.beforeSha256) {
      throw new InstallError('backup-corrupt', `module-watch backup SHA256 mismatch: ${state.backupPath}`);
    }
    fs.writeFileSync(profilePath, backup, 'utf8');
    const restoredSha = sha256(fs.readFileSync(profilePath, 'utf8'));
    if (restoredSha !== state.beforeSha256) {
      throw new InstallError('restore-unverified', `restored file SHA256 mismatch: ${profilePath}`);
    }
    fs.rmSync(resolved.stateFile, { force: true });
    return {
      ok: true,
      restoredFromBackup: true,
      surgical: false,
      beforeSha256: sha256(content),
      afterSha256: restoredSha,
      backupPath: state.backupPath,
      ...moduleWatchStatus({ profilePath, stateFile: resolved.stateFile, backupDir: resolved.backupDir, roots }),
    };
  }
  const idx = content.indexOf(block);
  const before = content.slice(0, idx).replace(/\r?\n\r?\n$/, '\n');
  const after = content.slice(idx + block.length);
  const stripped = `${before}${after}`.replace(/\r?\n$/, '\n');
  fs.writeFileSync(profilePath, stripped, 'utf8');
  if (fs.readFileSync(profilePath, 'utf8').includes(block)) {
    throw new InstallError('uninstall-unverified', `module-watch row still present after removal: ${profilePath}`);
  }
  fs.rmSync(resolved.stateFile, { force: true });
  return {
    ok: true,
    restoredFromBackup: false,
    surgical: true,
    beforeSha256: sha256(content),
    afterSha256: sha256(stripped),
    note: 'file changed since enable (or no matching record); only the bridge module-watch row was removed (other edits preserved)',
    ...moduleWatchStatus({ profilePath, stateFile: resolved.stateFile, backupDir: resolved.backupDir, roots }),
  };
}

export function markerPresent(content) {
  return new RegExp(`^\\s*- id:\\s*${PLUGIN_ID}\\s*$`, 'm').test(content);
}

function rowUrl(content) {
  const match = new RegExp(`^\\s*- id:\\s*${PLUGIN_ID}\\s*$`, 'm').exec(content);
  if (match === null) return undefined;
  const after = content.slice(match.index);
  const nameMatch = /^\s*name:\s*'([^']+)'\s*$/m.exec(after);
  return nameMatch?.[1];
}

/**
 * Remove the insert row we added, preserving every other byte of the file.
 * Returns undefined when the row is not present.
 */
export function removeInsertBlock(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => new RegExp(`^\\s*- id:\\s*${PLUGIN_ID}\\s*$`).test(line));
  if (markerIndex < 0) return undefined;
  let start = -1;
  for (let i = markerIndex - 1; i >= 0; i -= 1) {
    if (/^\s*- insert:\s*$/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  const baseIndent = lines[start].match(/^\s*/)[0].length;
  let end = markerIndex;
  for (let i = markerIndex + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') break;
    const indent = lines[i].match(/^\s*/)[0].length;
    if (indent > baseIndent) end = i;
    else break;
  }
  let removeFrom = start;
  while (removeFrom > 0 && lines[removeFrom - 1].trim() === '') removeFrom -= 1;
  lines.splice(removeFrom, end - removeFrom + 1);
  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeState(stateFile, value) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function resolvePaths({ profilePath, stateFile, backupDir }) {
  const defaults = pathsForProfile(profilePath);
  return {
    stateFile: stateFile ?? defaults.stateFile,
    backupDir: backupDir ?? defaults.backupDir,
  };
}

function stateMatchesProfile(state, profilePath) {
  return state !== undefined && path.resolve(state.profilePath ?? '') === path.resolve(profilePath);
}

function appendRow(content, pluginUrl) {
  const separator = content.length === 0 ? '' : content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${separator}${insertBlock(pluginUrl)}`;
}

/** Report the current plugin installation state without changing anything. */
export function pluginStatus({ profilePath = defaultProfilePath(), stateFile, backupDir } = {}) {
  const resolved = resolvePaths({ profilePath, stateFile, backupDir });
  const exists = fs.existsSync(profilePath);
  const content = exists ? fs.readFileSync(profilePath, 'utf8') : '';
  const state = readState(resolved.stateFile);
  const forThisProfile = stateMatchesProfile(state, profilePath);
  const marker = exists && markerPresent(content);
  const currentSha = exists ? sha256(content) : undefined;
  const desiredUrl = PLUGIN_URL;
  return {
    profilePath,
    profileExists: exists,
    profileSha256: currentSha,
    installed: marker,
    markerPresent: marker,
    rowUrl: exists ? rowUrl(content) : undefined,
    desiredPluginUrl: desiredUrl,
    urlMatches: marker && content.includes(`name: '${desiredUrl}'`),
    stateFile: resolved.stateFile,
    state: forThisProfile ? state : null,
    recordedBackupConsistent: forThisProfile && currentSha === state.afterSha256,
    pluginUrl: PLUGIN_URL,
    pluginFileExists: fs.existsSync(PLUGIN_FILE),
  };
}

/**
 * Install or upgrade the plugin row. Idempotent: a second call for the same
 * plugin content only reports state.
 */
export function installPlugin({ profilePath = defaultProfilePath(), stateFile, backupDir, now = new Date(), pluginUrl } = {}) {
  const resolved = resolvePaths({ profilePath, stateFile, backupDir });
  if (!fs.existsSync(PLUGIN_FILE)) throw new InstallError('plugin-missing', `plugin module not found: ${PLUGIN_FILE}`);
  if (!fs.existsSync(profilePath)) throw new InstallError('profile-missing', `DSH profile patch not found: ${profilePath}`);
  const desiredUrl = pluginUrl ?? PLUGIN_URL;
  const content = fs.readFileSync(profilePath, 'utf8');
  const marker = markerPresent(content);
  if (marker && content.includes(`name: '${desiredUrl}'`)) {
    return {
      ok: true,
      ...pluginStatus({ profilePath, stateFile: resolved.stateFile, backupDir: resolved.backupDir }),
      alreadyInstalled: true,
    };
  }

  const state = readState(resolved.stateFile);
  const forThisProfile = stateMatchesProfile(state, profilePath);
  const hasReusableBackup = forThisProfile && typeof state.backupPath === 'string' && fs.existsSync(state.backupPath);
  const baseContent = marker ? (removeInsertBlock(content) ?? content) : content;

  fs.mkdirSync(resolved.backupDir, { recursive: true });
  let backupPath;
  let beforeSha256;
  if (hasReusableBackup) {
    backupPath = state.backupPath;
    beforeSha256 = state.beforeSha256;
  } else {
    const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
    backupPath = path.join(resolved.backupDir, `cordis.patch.${stamp}.yml`);
    fs.writeFileSync(backupPath, baseContent, 'utf8');
    beforeSha256 = sha256(baseContent);
  }
  const next = appendRow(baseContent, desiredUrl);
  fs.writeFileSync(profilePath, next, 'utf8');
  const written = fs.readFileSync(profilePath, 'utf8');
  if (!markerPresent(written)) throw new InstallError('install-unverified', `plugin row missing after write: ${profilePath}`);
  const afterSha256 = sha256(written);
  writeState(resolved.stateFile, {
    profilePath,
    pluginUrl: desiredUrl,
    pluginId: PLUGIN_ID,
    beforeSha256,
    afterSha256,
    backupPath,
    installedAt: now.toISOString(),
    node: process.version,
  });
  return {
    ok: true,
    ...pluginStatus({ profilePath, stateFile: resolved.stateFile, backupDir: resolved.backupDir }),
    alreadyInstalled: false,
    upgraded: marker,
    beforeSha256,
    afterSha256,
    backupPath,
  };
}

/**
 * Uninstall the plugin row. Restores the exact backup when possible, otherwise
 * removes only our insert row and keeps unrelated edits.
 */
export function uninstallPlugin({ profilePath = defaultProfilePath(), stateFile, backupDir } = {}) {
  const resolved = resolvePaths({ profilePath, stateFile, backupDir });
  const exists = fs.existsSync(profilePath);
  const content = exists ? fs.readFileSync(profilePath, 'utf8') : '';
  const state = readState(resolved.stateFile);
  const forThisProfile = stateMatchesProfile(state, profilePath);
  if (!markerPresent(content)) {
    return { ok: true, alreadyRemoved: true, ...pluginStatus({ profilePath, stateFile: resolved.stateFile, backupDir: resolved.backupDir }) };
  }
  if (forThisProfile && sha256(content) === state.afterSha256 && fs.existsSync(state.backupPath)) {
    const backup = fs.readFileSync(state.backupPath, 'utf8');
    if (sha256(backup) !== state.beforeSha256) {
      throw new InstallError('backup-corrupt', `backup SHA256 does not match recorded value: ${state.backupPath}`);
    }
    fs.writeFileSync(profilePath, backup, 'utf8');
    const restoredSha = sha256(fs.readFileSync(profilePath, 'utf8'));
    if (restoredSha !== state.beforeSha256) {
      throw new InstallError('restore-unverified', `restored file SHA256 mismatch: ${profilePath}`);
    }
    fs.rmSync(resolved.stateFile, { force: true });
    return {
      ok: true,
      restoredFromBackup: true,
      surgical: false,
      beforeSha256: sha256(content),
      afterSha256: restoredSha,
      backupPath: state.backupPath,
      ...pluginStatus({ profilePath, stateFile: resolved.stateFile, backupDir: resolved.backupDir }),
    };
  }
  const stripped = removeInsertBlock(content);
  if (stripped === undefined) throw new InstallError('marker-shape-unknown', `found plugin id but could not locate its insert block: ${profilePath}`);
  fs.writeFileSync(profilePath, stripped, 'utf8');
  if (markerPresent(fs.readFileSync(profilePath, 'utf8'))) {
    throw new InstallError('uninstall-unverified', `plugin row still present after removal: ${profilePath}`);
  }
  fs.rmSync(resolved.stateFile, { force: true });
  return {
    ok: true,
    restoredFromBackup: false,
    surgical: true,
    beforeSha256: sha256(content),
    afterSha256: sha256(stripped),
    note: 'file changed since install (or no matching install record); only the bridge insert row was removed (other edits preserved)',
    ...pluginStatus({ profilePath, stateFile: resolved.stateFile, backupDir: resolved.backupDir }),
  };
}
