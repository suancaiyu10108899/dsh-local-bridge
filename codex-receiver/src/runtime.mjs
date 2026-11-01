// Runtime locations and hub configuration for the Local Agent Bridge.
// Everything mutable lives under <project>/.local/runtime for source checkouts,
// or under $DSH_HOME/local-agent-bridge/runtime when installed as a DSH bundle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolve the mutable runtime directory.
 *
 * - Explicit `LAB_BRIDGE_RUNTIME_DIR` wins.
 * - A source checkout keeps runtime inside the project's `.local/runtime`.
 * - An installed DSH bundle lives under a profile's node_modules; using its
 *   package directory would put state inside node_modules and lose it on an
 *   upgrade, so installed packages use $DSH_HOME/local-agent-bridge/runtime.
 */
export function runtimeDirFor({ projectRoot = PROJECT_ROOT, env = process.env, homedir = os.homedir() } = {}) {
  const override = env.LAB_BRIDGE_RUNTIME_DIR;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  const installed = projectRoot.split(path.sep).includes('node_modules');
  if (!installed) return path.join(projectRoot, '.local', 'runtime');
  const dshHome = env.DSH_HOME !== undefined && env.DSH_HOME.length > 0
    ? path.resolve(env.DSH_HOME)
    : path.join(homedir, '.dsh');
  return path.join(dshHome, 'local-agent-bridge', 'runtime');
}

export const RUNTIME_DIR = runtimeDirFor();

/** All mutable paths derived from one explicit runtime root. */
export function runtimePaths(runtimeDir = RUNTIME_DIR) {
  const resolved = path.resolve(runtimeDir);
  const hubDir = path.join(resolved, 'hub');
  return {
    runtimeDir: resolved,
    hubDir,
    stateFile: path.join(hubDir, 'state.json'),
    eventsFile: path.join(hubDir, 'events.jsonl'),
    tokenFile: path.join(hubDir, 'token'),
    configFile: path.join(hubDir, 'config.json'),
    serverInfoFile: path.join(hubDir, 'server.json'),
    ownerLockFile: path.join(hubDir, 'hub-owner.json'),
  };
}

const DEFAULT_PATHS = runtimePaths(RUNTIME_DIR);
export const HUB_DIR = DEFAULT_PATHS.hubDir;
export const STATE_FILE = DEFAULT_PATHS.stateFile;
export const EVENTS_FILE = DEFAULT_PATHS.eventsFile;
export const TOKEN_FILE = DEFAULT_PATHS.tokenFile;
export const CONFIG_FILE = DEFAULT_PATHS.configFile;
export const SERVER_INFO_FILE = DEFAULT_PATHS.serverInfoFile;

export const DEFAULT_CONFIG = Object.freeze({
  v: 1,
  host: '127.0.0.1',
  port: 47831,
  // Delivery is retried with backoff while the target adapter is connected.
  ack_timeout_ms: 10_000,
  max_delivery_attempts: 5,
  // Terminal records are pruned from state.json once this many are kept.
  max_terminal_records: 2_000,
  max_messages: 10_000,
});

export function ensureRuntimeDirs({ runtimeDir = RUNTIME_DIR } = {}) {
  fs.mkdirSync(runtimePaths(runtimeDir).hubDir, { recursive: true, mode: 0o700 });
}

/** Load hub config, creating defaults on first run. */
export function loadConfig({ runtimeDir = RUNTIME_DIR } = {}) {
  ensureRuntimeDirs({ runtimeDir });
  const paths = runtimePaths(runtimeDir);
  if (!fs.existsSync(paths.configFile)) {
    const config = { ...DEFAULT_CONFIG };
    writeJsonAtomic(paths.configFile, config);
    return config;
  }
  const parsed = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
  return { ...DEFAULT_CONFIG, ...parsed };
}

/** Load or create the shared local pairing token (user-only file). */
export function ensureToken({ runtimeDir = RUNTIME_DIR } = {}) {
  ensureRuntimeDirs({ runtimeDir });
  const paths = runtimePaths(runtimeDir);
  if (fs.existsSync(paths.tokenFile)) {
    const token = fs.readFileSync(paths.tokenFile, 'utf8').trim();
    if (token.length >= 32) return token;
    throw new Error(`token file is unusable (too short): ${paths.tokenFile}`);
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(paths.tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

export function readToken({ runtimeDir = RUNTIME_DIR } = {}) {
  const paths = runtimePaths(runtimeDir);
  if (!fs.existsSync(paths.tokenFile)) {
    throw new Error(`pairing token missing at ${paths.tokenFile}; start the hub once to create it`);
  }
  const token = fs.readFileSync(paths.tokenFile, 'utf8').trim();
  if (token.length < 32) throw new Error(`token file is unusable: ${paths.tokenFile}`);
  return token;
}

const WINDOWS_TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const TRANSIENT_RENAME_DELAYS_MS = [10, 25, 50, 100, 200];

function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* bounded sync fallback */ }
  }
}

/**
 * Replace an existing destination via rename. On Windows, short-lived EPERM/
 * EACCES/EBUSY can occur while the old file is still mapped/open. Retry only
 * the same temp/destination pair; never delete/replace the destination as a
 * shortcut and never reset any restart budget.
 */
export function renameAtomicWithRetry(temp, destination, {
  rename = fs.renameSync,
  sleep = sleepSync,
  platform = process.platform,
  delays = TRANSIENT_RENAME_DELAYS_MS,
} = {}) {
  const transient = platform === 'win32';
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(temp, destination);
      return { attempts: attempt + 1 };
    } catch (error) {
      const retryable = transient && WINDOWS_TRANSIENT_RENAME_CODES.has(error?.code) && attempt < delays.length;
      if (!retryable) throw error;
      sleep(delays[attempt]);
    }
  }
}

export function writeJsonAtomic(file, value, { rename = fs.renameSync, sleep = sleepSync, platform = process.platform } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameAtomicWithRetry(tmp, file, { rename, sleep, platform });
}

/** Endpoint details for clients of the hub. */
export function hubEndpoint(config) {
  return { host: config.host, port: config.port, address: `${config.host}:${config.port}` };
}
