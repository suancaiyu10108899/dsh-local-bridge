// Resolve installed CLI files inside the explicitly recorded vendor root.
// No downloads, outside-root PATH execution, mtime guesses, or queue submissions.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeJsonAtomic } from '../../src/runtime.mjs';

const execute = promisify(execFile);
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const CLI_FIELDS = new Set(['cli', 'cli_sha256', 'cli_version', 'cli_install_root', 'cli_install_root_realpath',
  'last_cli_refresh_at', 'config_path']);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative.length > 0 && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stable(value[key])]));
}

// Protect every non-CLI field, including future binding/installation fields.
export function bindingFingerprint(config) {
  return JSON.stringify(stable(Object.fromEntries(Object.entries(config).filter(([key]) => !CLI_FIELDS.has(key)))));
}

function installRoot(config) {
  if (!path.isAbsolute(config.cli ?? '') || !/^codex(?:\.exe)?$/i.test(path.basename(config.cli))) fail('CLI_INSTALL_ROOT_UNSUPPORTED');
  const root = path.resolve(config.cli_install_root ?? path.dirname(path.dirname(config.cli)));
  if (path.basename(root).toLowerCase() !== 'bin' || path.basename(path.dirname(root)).toLowerCase() !== 'codex' ||
      !inside(root, path.resolve(config.cli))) fail('CLI_INSTALL_ROOT_UNSUPPORTED');
  let realRoot;
  try {
    if (!fs.statSync(root).isDirectory()) fail('CLI_INSTALL_ROOT_UNSUPPORTED');
    realRoot = fs.realpathSync(root);
  } catch (error) {
    if (error.code === 'CLI_INSTALL_ROOT_UNSUPPORTED') throw error;
    fail('CLI_INSTALL_ROOT_MISSING');
  }
  if (!samePath(root, realRoot)) fail('CLI_INSTALL_ROOT_REPARSE_REVIEW_REQUIRED');
  if (config.cli_install_root_realpath && !samePath(realRoot, config.cli_install_root_realpath)) fail('CLI_INSTALL_ROOT_CHANGED');
  return { root, realRoot, name: path.basename(config.cli) };
}

function checkedCandidate(file, roots) {
  const absolute = path.resolve(file);
  if (!inside(roots.root, absolute)) fail('CLI_CANDIDATE_OUTSIDE_INSTALL_ROOT');
  const real = fs.realpathSync(absolute);
  if (!inside(roots.realRoot, real)) fail('CLI_CANDIDATE_OUTSIDE_INSTALL_ROOT');
  if (!/^codex(?:\.exe)?$/i.test(path.basename(real)) || !fs.statSync(real).isFile()) fail('CLI_CANDIDATE_INVALID');
  return real;
}

async function inspectInstalled(file) {
  const options = { windowsHide: true, timeout: 10000, maxBuffer: 65536 };
  const help = (await execute(file, ['queue', '--help'], options)).stdout;
  const version = (await execute(file, ['--version'], options)).stdout.trim();
  return { help, version };
}

function versionSupported(version) {
  return typeof version === 'string' && /^codex-cli\s+\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?\s*$/.test(version);
}

function compatible(info) {
  const help = info?.help ?? info?.stdout;
  return typeof help === 'string' && /(?:^|\s)--thread(?:\s|=|$)/.test(help) &&
    /(?:^|\s)--message(?:\s|=|$)/.test(help) && versionSupported(info?.version);
}

/** The same resolver is used by prepare, cold enable, worker and read-only doctor.
 * Prefer a verifiable pin. After removal require one in-root PATH hint, or exactly
 * one installed candidate. Ambiguity pauses instead of guessing by file age.
 */
export async function resolveVerifiedCli(config, { inspect = inspectInstalled, envPath = process.env.PATH ?? '', verifyCapabilities = true } = {}) {
  const roots = installRoot(config);
  let selected;
  if (fs.existsSync(config.cli)) {
    selected = checkedCandidate(config.cli, roots);
  } else {
    if (config.allow_installed_cli_refresh === false) fail('CLI_BINARY_CHANGED');
    const hints = [...new Set(envPath.split(path.delimiter).filter(Boolean)
      .map((dir) => path.resolve(dir, roots.name)).filter((file) => inside(roots.root, file) && fs.existsSync(file))
      .map((file) => checkedCandidate(file, roots)))];
    if (hints.length > 1) fail('CLI_SELECTION_AMBIGUOUS');
    if (hints.length === 1) selected = hints[0];
    else {
      const candidates = [...new Set(fs.readdirSync(roots.root, { withFileTypes: true })
        .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && /^[a-f0-9]{8,64}$/i.test(entry.name))
        .map((entry) => path.join(roots.root, entry.name, roots.name)).filter((file) => fs.existsSync(file))
        .map((file) => checkedCandidate(file, roots)))].sort();
      if (!candidates.length) fail('NO_COMPATIBLE_INSTALLED_CLI');
      if (candidates.length !== 1) fail('CLI_SELECTION_AMBIGUOUS');
      selected = candidates[0];
    }
  }
  const before = hash(selected);
  if (config.cli_sha256 && before !== config.cli_sha256 && config.allow_installed_cli_refresh === false) fail('CLI_BINARY_CHANGED');
  let info;
  // A worker can reuse capabilities already checked by its owner for this exact
  // binary hash. Missing/changed pins always undergo the complete inspection.
  const cached = !verifyCapabilities && before === config.cli_sha256 && samePath(selected, config.cli) && versionSupported(config.cli_version);
  if (cached) info = { version: config.cli_version };
  else {
    try { info = await inspect(selected); } catch { fail('CLI_INSPECTION_FAILED'); }
    if (!compatible(info)) fail('CLI_QUEUE_UNSUPPORTED');
  }
  // A replacement during help/version must not become the new trusted pin.
  if (!samePath(checkedCandidate(selected, { ...roots, root: roots.realRoot }), selected) || hash(selected) !== before) {
    fail('CLI_CHANGED_DURING_INSPECTION');
  }
  return { cli: selected, cli_sha256: before, cli_version: info.version.trim(),
    cli_install_root: roots.root, cli_install_root_realpath: roots.realRoot };
}

export const discoverInstalledCli = resolveVerifiedCli;

export async function refreshInstalledCli(config, configPath, options = {}) {
  const file = path.resolve(configPath), lockFile = file + '.cli-refresh.lock', nonce = crypto.randomUUID();
  let locked = false;
  try {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, nonce, config_path: file }), { flag: 'wx' });
      locked = true;
    } catch (error) {
      if (error.code === 'EEXIST') fail('CLI_REFRESH_LOCKED_REVIEW_REQUIRED');
      throw error;
    }
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    const binding = bindingFingerprint(config);
    if (bindingFingerprint(original) !== binding) fail('BINDING_CONFIG_CHANGED');
    for (const key of ['cli', 'cli_sha256', 'cli_version', 'cli_install_root', 'cli_install_root_realpath']) {
      if (original[key] !== config[key]) fail('CLI_REFRESH_CONFLICT');
    }
    const candidateConfig = options.preferredCli ? { ...config, cli: path.resolve(options.preferredCli), cli_sha256: undefined,
      cli_install_root: path.dirname(path.dirname(path.resolve(options.preferredCli))), cli_install_root_realpath: undefined,
      allow_installed_cli_refresh: true } : config;
    const replacement = await resolveVerifiedCli(candidateConfig, options);
    const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (bindingFingerprint(latest) !== binding) fail('BINDING_CONFIG_CHANGED');
    for (const key of ['cli', 'cli_sha256', 'cli_version', 'cli_install_root', 'cli_install_root_realpath']) {
      if (latest[key] !== original[key]) fail('CLI_REFRESH_CONFLICT');
    }
    if (hash(replacement.cli) !== replacement.cli_sha256) fail('CLI_CHANGED_DURING_INSPECTION');
    const changed = Object.entries(replacement).some(([key, value]) => latest[key] !== value);
    if (changed) {
      const at = new Date().toISOString();
      fs.copyFileSync(file, file + '.cli-backup-' + Date.now() + '-' + nonce);
      writeJsonAtomic(file, { ...latest, ...replacement, last_cli_refresh_at: at });
      fs.mkdirSync(config.runtime_dir, { recursive: true });
      fs.appendFileSync(path.join(config.runtime_dir, 'cli-refresh.jsonl'), JSON.stringify({ at,
        action: 'VALIDATED_INSTALLED_CLI_REFRESH', old: { cli: original.cli, cli_sha256: original.cli_sha256 },
        replacement, software_installed: false, binding_changed: false }) + '\n');
    }
    Object.assign(config, replacement, { enabled: latest.enabled });
    return replacement;
  } finally {
    if (locked) {
      try { if (JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce === nonce) fs.unlinkSync(lockFile); } catch { /* own stale lock requires review */ }
    }
  }
}
