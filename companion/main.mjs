#!/usr/bin/env node
// COMPANION_OWNED entry point: read the installation locator, discover target
// membership files under installation.runtime_root and own the target workers
// directly. This process does not start an independent Hub/receiver service and
// does not install any startup task.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultInstallationRoot, installationPaths, readInstallation } from '../src/installation.mjs';
import { createCompanion } from '../src/companion.mjs';
import { createCompanionHub } from '../src/companion-hub.mjs';

function parseArgs(argv) {
  const opts = {
    installationRoot: undefined,
    workerEntry: undefined,
    reason: 'MANUAL_START',
    poll: true,
    pollMs: 2_000,
    hub: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${token}`);
      i += 1;
      return value;
    };
    if (token === '--installation') opts.installationRoot = path.resolve(next());
    else if (token === '--worker-entry') opts.workerEntry = path.resolve(next());
    else if (token === '--reason') opts.reason = next();
    else if (token === '--poll-ms') opts.pollMs = Number(next());
    else if (token === '--no-poll') opts.poll = false;
    else if (token === '--no-hub') opts.hub = false;
    else if (token === '--help' || token === '-h') {
      process.stdout.write('usage: companion/main.mjs [--installation ROOT] [--worker-entry FILE] [--reason USER_ENABLE|LOGON_AUTOSTART|RECOVERY|MANUAL_START] [--poll-ms N] [--no-poll] [--no-hub]\n');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  if (!Number.isFinite(opts.pollMs) || opts.pollMs < 250) throw new Error('--poll-ms must be >= 250');
  return opts;
}

const defaultWorkerEntry = fileURLToPath(new URL('../codex-receiver/adapters/codex/daily-receiver.mjs', import.meta.url));
const defaultHubEntry = fileURLToPath(new URL('../hub/main.mjs', import.meta.url));

let activeCompanion = null;
let activeCompanionHub = null;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const installationRoot = opts.installationRoot ?? defaultInstallationRoot();
  const installation = readInstallation({ root: installationRoot, required: true });
  const paths = installationPaths(installationRoot);
  const workerEntry = opts.workerEntry ?? defaultWorkerEntry;
  const log = (event, detail) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...detail })}\n`);
  let companion = null;
  let companionHub = null;
  let shutdownMain = null;
  const requestShutdown = (reason, code) => {
    void shutdownMain?.(reason, code);
  };
  companionHub = opts.hub
    ? createCompanionHub({
        installation,
        runtimeRoot: installation.runtime_root,
        locatorPath: paths.locator,
        hubEntry: defaultHubEntry,
        env: process.env,
        log,
        onDesiredStop: async () => requestShutdown('DESIRED_STOPPED', 0),
        onDesiredInvalid: async () => requestShutdown('DESIRED_STATE_INVALID', 2),
      })
    : null;
  activeCompanionHub = companionHub;
  if (companionHub !== null) {
    const hubStatus = await companionHub.start();
    log('companion-hub/status', hubStatus);
    if (hubStatus.lifecycle !== 'READY') {
      throw Object.assign(new Error(`HUB_NOT_READY:${hubStatus.lifecycle}`), { code: hubStatus.lifecycle });
    }
  }
  companion = createCompanion({
    installation,
    runtimeRoot: installation.runtime_root,
    locatorPath: paths.locator,
    workerEntry,
    autoPoll: opts.poll,
    pollIntervalMs: opts.pollMs,
    env: process.env,
    log,
  });
  activeCompanion = companion;

  const print = () => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event: 'companion/status', ...companion.status(), hub: companionHub?.status() ?? null })}\n`);
  companion.start({ reason: opts.reason });
  print();

  let stopping = false;
  let keepalive = null;
  const desiredFile = path.join(installation.runtime_root, 'desired-state.json');
  const readDesired = () => {
    if (!fs.existsSync(desiredFile)) return 'RUNNING';
    try {
      const value = JSON.parse(fs.readFileSync(desiredFile, 'utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'INVALID';
      return value.desired_state === 'RUNNING' || value.desired_state === 'STOPPED' ? value.desired_state : 'INVALID';
    } catch {
      return 'INVALID';
    }
  };
  const shutdown = async (reason, code = 0) => {
    if (stopping) return;
    stopping = true;
    if (keepalive !== null) { clearInterval(keepalive); keepalive = null; }
    log('companion/shutdown', { reason, code });
    try { await companion.stop(); } catch { /* best effort */ }
    try { if (companionHub !== null) await companionHub.stop(); } catch { /* best effort */ }
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event: 'companion/stopped', reason })}\n`);
    process.exit(code);
  };
  shutdownMain = shutdown;

  // Foreground keepalive: the companion is a long-lived local lifecycle owner,
  // not a one-shot starter. This ref'ed timer is the main lifetime; it also
  // observes explicit global STOP/INVALID and shuts down cleanly.
  keepalive = setInterval(() => {
    if (stopping) return;
    const desired = readDesired();
    if (desired === 'STOPPED') { void shutdown('DESIRED_STOPPED', 0); return; }
    if (desired === 'INVALID') { void shutdown('DESIRED_STATE_INVALID', 2); }
  }, Math.max(250, Math.min(opts.pollMs, 2_000)));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
}

main().catch(async (error) => {
  // A failed startup after Hub spawn must not leave a half-started Hub child
  // alive and let bootstrap misread it as an owned/recovered companion.
  try { if (activeCompanion !== null) await activeCompanion.stop(); } catch { /* best effort */ }
  try { if (activeCompanionHub !== null) await activeCompanionHub.stop(); } catch { /* best effort */ }
  process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code ?? 'COMPANION_START_FAILED', message: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
});
