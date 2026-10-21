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
export const HUB_DIR = path.join(RUNTIME_DIR, 'hub');
export const STATE_FILE = path.join(HUB_DIR, 'state.json');
export const EVENTS_FILE = path.join(HUB_DIR, 'events.jsonl');
export const TOKEN_FILE = path.join(HUB_DIR, 'token');
export const CONFIG_FILE = path.join(HUB_DIR, 'config.json');
export const SERVER_INFO_FILE = path.join(HUB_DIR, 'server.json');

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

export function ensureRuntimeDirs() {
  fs.mkdirSync(HUB_DIR, { recursive: true, mode: 0o700 });
}

/** Load hub config, creating defaults on first run. */
export function loadConfig() {
  ensureRuntimeDirs();
  if (!fs.existsSync(CONFIG_FILE)) {
    const config = { ...DEFAULT_CONFIG };
    writeJsonAtomic(CONFIG_FILE, config);
    return config;
  }
  const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  return { ...DEFAULT_CONFIG, ...parsed };
}

/** Load or create the shared local pairing token (user-only file). */
export function ensureToken() {
  ensureRuntimeDirs();
  if (fs.existsSync(TOKEN_FILE)) {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (token.length >= 32) return token;
    throw new Error(`token file is unusable (too short): ${TOKEN_FILE}`);
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

export function readToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    throw new Error(`pairing token missing at ${TOKEN_FILE}; start the hub once to create it`);
  }
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (token.length < 32) throw new Error(`token file is unusable: ${TOKEN_FILE}`);
  return token;
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** Endpoint details for clients of the hub. */
export function hubEndpoint(config) {
  return { host: config.host, port: config.port, address: `${config.host}:${config.port}` };
}
