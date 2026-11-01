// Explicit receiver/installation association. These functions never initialize a
// runtime, generate a token, start a Hub, or choose a runtime from module paths.
import fs from 'node:fs';
import path from 'node:path';
import { defaultInstallationRoot, readInstallation, resolveRuntime } from '../../src/installation.mjs';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
function projectedRealPath(file) {
  let existing = path.resolve(file); const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) fail('RUNTIME_PATH_UNRESOLVED');
    missing.unshift(path.basename(existing)); existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

function verifyReceiverDirectory(root, directory) {
  if (!inside(projectedRealPath(root), projectedRealPath(directory))) fail('RUNTIME_INSTANCE_CONFLICT');
}

export function preparationContext({ thread, installationRoot, runtimeRoot, manualRuntimeRoot }) {
  if (manualRuntimeRoot !== undefined) {
    if (installationRoot !== undefined || runtimeRoot !== undefined || !path.isAbsolute(manualRuntimeRoot)) fail('RUNTIME_INSTANCE_CONFLICT');
    if (fs.existsSync(path.join(defaultInstallationRoot(), 'installation.json'))) fail('MANUAL_RUNTIME_REQUIRES_LEGACY_HUB');
    const root = path.resolve(manualRuntimeRoot);
    if (process.env.LAB_BRIDGE_RUNTIME_DIR && !samePath(root, process.env.LAB_BRIDGE_RUNTIME_DIR)) fail('RUNTIME_INSTANCE_CONFLICT');
    let hub;
    try {
      if (!samePath(root, fs.realpathSync(root))) fail('MANUAL_RUNTIME_REPARSE_REVIEW_REQUIRED');
      hub = JSON.parse(fs.readFileSync(path.join(root, 'hub', 'config.json'), 'utf8'));
      if (!fs.statSync(path.join(root, 'hub', 'token')).isFile()) fail('MANUAL_HUB_RUNTIME_NOT_READY');
    } catch (error) {
      if (error.code === 'MANUAL_RUNTIME_REPARSE_REVIEW_REQUIRED') throw error;
      fail('MANUAL_HUB_RUNTIME_NOT_READY');
    }
    if (hub.host !== '127.0.0.1' || !Number.isInteger(hub.port) || hub.port < 1 || hub.port > 65535) fail('HUB_CONFIG_INVALID');
    const runtime = path.join(root, 'codex', thread);
    verifyReceiverDirectory(root, runtime);
    return { installation: null, installationRoot: null, runtime, hubRuntimeRoot: root, source: 'manual-legacy' };
  }
  if (runtimeRoot !== undefined) {
    if (installationRoot !== undefined || !path.isAbsolute(runtimeRoot)) fail('RUNTIME_INSTANCE_CONFLICT');
    return { installation: null, installationRoot: null, runtime: path.resolve(runtimeRoot), source: 'explicit-isolated' };
  }
  const root = path.resolve(installationRoot ?? defaultInstallationRoot());
  const installation = readInstallation({ root, required: true });
  // Ambient overrides cannot silently redirect an installed receiver.
  const resolved = resolveRuntime({ installation });
  const runtime = path.join(resolved.runtimeRoot, 'codex', thread);
  verifyReceiverDirectory(resolved.runtimeRoot, runtime);
  return { installation, installationRoot: root, runtime, source: 'installation' };
}

export function receiverInstallation(config) {
  const bound = config.installation_root !== undefined || config.installation_id !== undefined || config.instance_id !== undefined;
  if (!bound) {
    if (config.runtime_mode === 'MANUAL_LEGACY_HUB') {
      const context = preparationContext({ thread: config.thread_id, manualRuntimeRoot: config.hub_runtime_root });
      if (!samePath(context.runtime, config.runtime_dir)) fail('RUNTIME_INSTANCE_CONFLICT');
      if (config.config_path && !samePath(config.config_path, path.join(context.runtime, 'receiver-config.json'))) fail('RECEIVER_CONFIG_PATH_CONFLICT');
    }
    return null; // Existing experimental/manual configs are identified explicitly by callers.
  }
  if (!path.isAbsolute(config.installation_root ?? '')) fail('RECEIVER_INSTALLATION_REQUIRED');
  const installation = readInstallation({ root: config.installation_root, required: true });
  if (installation.installation_id !== config.installation_id || installation.instance_id !== config.instance_id) fail('RECEIVER_INSTANCE_MISMATCH');
  const runtime = resolveRuntime({ installation }).runtimeRoot;
  const expected = path.join(runtime, 'codex', config.thread_id);
  if (!samePath(expected, config.runtime_dir) || !samePath(runtime, config.hub_runtime_root ?? runtime)) fail('RUNTIME_INSTANCE_CONFLICT');
  if (config.config_path && !samePath(config.config_path, path.join(expected, 'receiver-config.json'))) fail('RECEIVER_CONFIG_PATH_CONFLICT');
  if (config.hub_owner_kind !== installation.hub_owner_kind) fail('HUB_OWNER_MODE_CHANGED');
  verifyReceiverDirectory(runtime, expected);
  return installation;
}

export function receiverHubOptions(config) {
  const installation = receiverInstallation(config);
  const root = installation?.runtime_root ?? config.hub_runtime_root;
  if (!path.isAbsolute(root ?? '')) fail('HUB_RUNTIME_UNBOUND_LEGACY');
  const hub = path.join(root, 'hub');
  let value;
  try { value = JSON.parse(fs.readFileSync(path.join(hub, 'config.json'), 'utf8')); }
  catch { fail('HUB_CONFIG_MISSING_OR_INVALID'); }
  if (value.host !== '127.0.0.1' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) fail('HUB_CONFIG_INVALID');
  let token;
  try { token = fs.readFileSync(path.join(hub, 'token'), 'utf8').trim(); } catch { fail('HUB_TOKEN_MISSING'); }
  if (token.length < 32) fail('HUB_TOKEN_INVALID');
  return { host: value.host, port: value.port, token };
}
