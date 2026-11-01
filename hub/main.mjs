// Hub process entry point: `node hub/main.mjs`.
//
// Production wiring reads the installation locator first and derives STATE,
// TOKEN, config and server-info from the SAME locator.runtime_root. The legacy
// default runtime is used only when no locator exists; an explicit runtime
// override that conflicts with a locator is rejected instead of silently
// mixing queues/tokens from another runtime.
import fs from 'node:fs';
import path from 'node:path';
import {
  RUNTIME_DIR,
  ensureRuntimeDirs,
  ensureToken,
  loadConfig,
  runtimePaths,
  writeJsonAtomic,
} from '../src/runtime.mjs';
import { defaultInstallationRoot, installationPaths, readInstallation } from '../src/installation.mjs';
import { HubStore } from '../src/store.mjs';
import { BridgeHub } from '../src/hub.mjs';
import { createTargetBindingStamper } from '../src/target-binding.mjs';
import { computeCodeIdentity, hostIdentityMetadata, writeComponentIdentity } from '../src/code-identity.mjs';
import { fileURLToPath } from 'node:url';

const logger = (event, detail) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail });
  process.stdout.write(`${line}\n`);
};

const codeIdentity = computeCodeIdentity({
  rootDir: path.resolve(import.meta.dirname, '..'),
  component: 'hub',
  entry: fileURLToPath(import.meta.url),
});
const codeIdentityMetadata = hostIdentityMetadata(codeIdentity);
if (codeIdentity.status !== 'OBSERVED') logger('hub/code-identity-unverified', { reasons: codeIdentity.reasons });
else logger('hub/code-identity-loaded', { source_sha256: codeIdentity.source_sha256, entry: codeIdentity.entry, release_channel: codeIdentity.release_channel });

function resolveInstallationRuntime() {
  const installationRoot = typeof process.env.LAB_BRIDGE_INSTALLATION_ROOT === 'string' && process.env.LAB_BRIDGE_INSTALLATION_ROOT.length > 0
    ? path.resolve(process.env.LAB_BRIDGE_INSTALLATION_ROOT)
    : defaultInstallationRoot();
  const locatorPath = installationPaths(installationRoot).locator;
  if (!fs.existsSync(locatorPath)) {
    const runtimeDir = typeof process.env.LAB_BRIDGE_RUNTIME_DIR === 'string' && process.env.LAB_BRIDGE_RUNTIME_DIR.length > 0
      ? path.resolve(process.env.LAB_BRIDGE_RUNTIME_DIR)
      : RUNTIME_DIR;
    return { installationRoot, locatorPath, installation: null, runtimeDir };
  }
  const installation = readInstallation({ root: installationRoot, required: true });
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const explicitInstallation = typeof process.env.LAB_BRIDGE_INSTALLATION_ROOT === 'string' && process.env.LAB_BRIDGE_INSTALLATION_ROOT.length > 0;
  // A source checkout must not silently adopt the default installed snapshot's
  // runtime. Only an app-root match (or explicit installation root) binds it.
  if (!explicitInstallation && path.resolve(installation.app_root) !== projectRoot) {
    const runtimeDir = typeof process.env.LAB_BRIDGE_RUNTIME_DIR === 'string' && process.env.LAB_BRIDGE_RUNTIME_DIR.length > 0
      ? path.resolve(process.env.LAB_BRIDGE_RUNTIME_DIR)
      : RUNTIME_DIR;
    return { installationRoot, locatorPath, installation: null, runtimeDir, ignoredLocator: true };
  }
  const override = process.env.LAB_BRIDGE_RUNTIME_DIR;
  if (typeof override === 'string' && override.length > 0 && path.resolve(override) !== installation.runtime_root) {
    throw new Error(`RUNTIME_INSTANCE_CONFLICT: LAB_BRIDGE_RUNTIME_DIR ${path.resolve(override)} conflicts with locator runtime_root ${installation.runtime_root}`);
  }
  return { installationRoot, locatorPath, installation, runtimeDir: installation.runtime_root };
}

const runtimeContext = resolveInstallationRuntime();
const paths = runtimePaths(runtimeContext.runtimeDir);
ensureRuntimeDirs({ runtimeDir: runtimeContext.runtimeDir });
writeComponentIdentity({ runtimeDir: runtimeContext.runtimeDir, component: 'hub', identity: codeIdentity });
const config = loadConfig({ runtimeDir: runtimeContext.runtimeDir });
const token = ensureToken({ runtimeDir: runtimeContext.runtimeDir });

const store = new HubStore({
  stateFile: paths.stateFile,
  eventsFile: paths.eventsFile,
  maxTerminalRecords: config.max_terminal_records,
  maxMessages: config.max_messages,
}).load();

const targetBinding = runtimeContext.installation === null
  ? null
  : createTargetBindingStamper({
      installation: runtimeContext.installation,
      runtimeRoot: runtimeContext.installation.runtime_root,
      locatorPath: runtimeContext.locatorPath,
      log: logger,
    });

if (targetBinding !== null) {
  logger('hub/target-binding-enabled', {
    installation_id: runtimeContext.installation.installation_id,
    instance_id: runtimeContext.installation.instance_id,
    locator: runtimeContext.locatorPath,
    runtime_dir: runtimeContext.runtimeDir,
  });
} else {
  logger('hub/target-binding-disabled', { reason: 'installation locator missing; legacy unstamped mode', runtime_dir: runtimeContext.runtimeDir });
}

const hub = new BridgeHub({
  store,
  token,
  host: config.host,
  port: config.port,
  ackTimeoutMs: config.ack_timeout_ms,
  maxAttempts: config.max_delivery_attempts,
  targetBinding,
  installation: runtimeContext.installation,
  codeIdentity: codeIdentityMetadata,
  runtimeRoot: runtimeContext.runtimeDir,
  logger,
});

let address;
try {
  address = await hub.start();
} catch (error) {
  if (error?.code === 'EADDRINUSE') {
    logger('hub/port-in-use', { host: config.host, port: config.port, hint: 'another hub may already be running; run `node bin/lab-bridge.mjs check`' });
    process.exitCode = 1;
  } else {
    logger('hub/start-failed', { message: String(error?.stack ?? error) });
    process.exitCode = 1;
  }
  address = undefined;
}

if (address !== undefined) {
  writeJsonAtomic(paths.serverInfoFile, {
    pid: process.pid,
    host: config.host,
    port: address.port,
    address: address.address,
    server_id: store.serverId,
    started_at: hub.startedAt,
    node: process.version,
    package_version: codeIdentity.package_version,
    code_identity: codeIdentityMetadata,
    state_file: paths.stateFile,
    token_file: paths.tokenFile,
    installation_id: runtimeContext.installation?.installation_id ?? null,
    instance_id: runtimeContext.installation?.instance_id ?? null,
    protocol_version: runtimeContext.installation?.protocol_version ?? null,
    runtime_root: runtimeContext.runtimeDir,
    capabilities: { target_binding_epoch: targetBinding !== null },
  });
  logger('hub/ready', { address: address.address, server_id: store.serverId, pid: process.pid, runtime_dir: runtimeContext.runtimeDir });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger('hub/stopping', { signal });
    try {
      await hub.stop();
    } finally {
      try {
        fs.rmSync(paths.serverInfoFile, { force: true });
      } catch {
        /* best effort */
      }
      logger('hub/stopped', {});
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
