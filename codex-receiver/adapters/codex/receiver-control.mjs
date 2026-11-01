// Owner-operated lifecycle. Production uses one locator and companion membership;
// explicit isolated/manual compatibility never changes a shared host or Hub.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROJECT_ROOT, writeJsonAtomic } from '../../src/runtime.mjs';
import { readJsonSafe } from '../../src/health.mjs';
import { withHubClient } from '../../src/client.mjs';
import { membershipPath, readMembership, registerMembershipEnable, registerMembershipDisable } from '../../src/membership.mjs';
import { validateReceiverConfig, UUID_RE, recordModelReceipt } from './queue-inbox.mjs';
import { ownBinding } from './daily-receiver.mjs';
import { removeStartup } from './receiver-startup.mjs';
import { resolveVerifiedCli, refreshInstalledCli } from './installed-cli.mjs';
import { preparationContext, receiverInstallation, receiverHubOptions } from './receiver-context.mjs';
import { inspectReceiverProcess, recoverReceiverLock, receiverIds } from './receiver-identity.mjs';
import { readReceiverCodeIdentity } from './receiver-code.mjs';
import { receiverGuidance, receiverErrorCode } from './receiver-guidance.mjs';
import { receiverSenderPolicy } from './client-peer.mjs';
import { readClientReply, postClientReply } from './client-reply.mjs';
import { adoptLegacyReceiver } from './legacy-adoption.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function ownerRequired(thread) {
  if (!UUID_RE.test(thread ?? '') || process.env.CODEX_THREAD_ID !== thread) throw new Error('OWNER_THREAD_MISMATCH');
}
export function readConfig(file) { return { ...JSON.parse(fs.readFileSync(file, 'utf8')), config_path: path.resolve(file) }; }
const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

export async function receiverStatus(file, now = Date.now(), { identityProvider } = {}) {
  const c = readConfig(file), installation = receiverInstallation(c);
  const stored = readJsonSafe(path.join(c.runtime_dir, 'status.json')) ?? {};
  const serviceStored = readJsonSafe(path.join(c.runtime_dir, 'service-status.json')) ?? {};
  const [worker, service] = await Promise.all([
    inspectReceiverProcess(c, file, 'worker', { provider: identityProvider, now }),
    inspectReceiverProcess(c, file, 'service', { provider: identityProvider, now }),
  ]);
  const stamp = Date.parse(stored.heartbeat_at ?? stored.at);
  const healthy = worker.status === 'ALIVE' && stored.nonce === worker.lock?.nonce &&
    stored.pid === worker.lock?.owner_process?.pid && stored.thread_id === c.thread_id &&
    stored.binding_epoch === (c.binding_epoch ?? null) &&
    Number.isFinite(stamp) && stamp <= now + 2000 && now - stamp < 60000;
  let status = stored.status ?? 'NOT_STARTED';
  if (worker.status === 'UNKNOWN' || service.status === 'UNKNOWN') status = 'IDENTITY_REVIEW_REQUIRED';
  else if (!c.enabled) status = worker.running || service.running ? 'STOP_REQUESTED' : 'DISABLED';
  else if (c.mode !== 'daily' && Date.parse(c.expires_at) <= now) status = 'EXPIRED';
  else if (worker.running && !healthy) status = 'UNRESPONSIVE';
  else if (!worker.running && serviceStored.status === 'HALTED') status = 'HALTED_WORKER_RESTARTS';
  else if (!worker.running) status = service.running ? 'RECOVERING_WORKER'
    : installation?.hub_owner_kind === 'COMPANION_OWNED' ? 'PENDING_COMPANION' : 'OFFLINE';
  const ledgerFile = path.join(c.runtime_dir, 'ledger.json'), ledger = readJsonSafe(ledgerFile);
  const ledgerValid = !fs.existsSync(ledgerFile) || !!ledger && ledger.v === 1 &&
    ledger.entries && typeof ledger.entries === 'object' && !Array.isArray(ledger.entries);
  const used = !ledgerValid ? null : c.mode === 'daily'
    ? Object.values(ledger?.entries ?? {}).filter((entry) => Date.parse(entry.attempted_at) > now - 3600000).length
    : stored.used_native_submissions ?? null;
  const ids = receiverIds(c);
  const installedCode = readReceiverCodeIdentity();
  const versionState = worker.running === false ? 'NOT_RUNNING' : worker.running === null || !stored.code_identity?.readable || !installedCode.readable ? 'UNKNOWN'
    : stored.code_identity.code_sha256 === installedCode.code_sha256 ? 'MATCH' : 'PENDING_RELOAD';
  if (healthy && versionState === 'PENDING_RELOAD') status = 'PENDING_RELOAD';
  const adoptionPending = ['legacy-adoption.transaction', 'legacy-adoption.recovery.lock'].some((name) => fs.existsSync(path.join(c.runtime_dir, name)));
  const recoveryPending = adoptionPending || ['receiver.lock.transaction', 'service.lock.transaction'].some((name) => fs.existsSync(path.join(c.runtime_dir, name)));
  if (adoptionPending) status = 'LEGACY_ADOPTION_REVIEW_REQUIRED';
  else if (recoveryPending && !worker.running && !service.running) status = 'LOCK_RECOVERY_REVIEW_REQUIRED';
  const result = { ...stored, schema_version: 3, ...ids, mode: c.mode ?? 'bounded', enabled: c.enabled, status,
    recovery_transaction_present: recoveryPending, adoption_recovery_present: adoptionPending,
    running: worker.running, healthy: healthy && versionState !== 'PENDING_RELOAD', process_healthy: healthy,
    installed_code_identity: installedCode, running_code_identity: stored.code_identity ?? null, version_state: versionState,
    declared_installation_version: installation?.active_version ?? null,
    process_identity_status: worker.status, service_identity_status: service.status,
    process_verified_at: new Date(now).toISOString(), installation_bound: !!installation,
    thread_id: c.thread_id, window_id: c.window_id, binding_epoch: c.binding_epoch ?? null,
    transport: c.transport ?? 'legacy-role-push', expires_at: c.mode === 'daily' ? null : c.expires_at,
    pid: worker.running ? worker.lock.owner_process.pid : null, worker_nonce: worker.lock?.nonce ?? null,
    max_native_submissions: c.mode === 'daily' ? null : c.max_native_submissions,
    ledger_valid: ledgerValid, used_native_submissions: used,
    remaining_native_submissions: used === null ? null : c.mode === 'daily' ? Math.max(0, c.rate_limit.max_submissions - used) : stored.remaining_native_submissions ?? null,
    service_pid: service.running ? service.lock.owner_process.pid : null, service_running: service.running,
    service_owner: installation?.hub_owner_kind === 'COMPANION_OWNED' ? 'companion' : 'legacy-manual-supervisor',
    startup_enabled: c.start_at_logon ?? readJsonSafe(path.join(c.runtime_dir, 'startup.json'))?.enabled === true,
    rate_limit: c.rate_limit ?? null, cli_version: c.cli_version ?? null,
    last_error: !ledgerValid ? 'LEDGER_INVALID' : status === 'PENDING_RELOAD' ? 'RECEIVER_CODE_CHANGED_RELOAD_REQUIRED'
      : adoptionPending ? 'LEGACY_ADOPTION_REVIEW_REQUIRED'
      : status === 'LOCK_RECOVERY_REVIEW_REQUIRED' ? 'LOCK_RECOVERY_REVIEW_REQUIRED'
      : status === 'IDENTITY_REVIEW_REQUIRED' ? 'LOCK_IDENTITY_OR_BINDING_UNKNOWN'
      : status === 'HALTED_WORKER_RESTARTS' ? serviceStored.reason_code ?? 'WORKER_RESTART_LIMIT'
      : /^(PAUSED|BACKOFF|BLOCKED|UNRESPONSIVE)/.test(status) ? stored.reason_code ?? stored.last_error ?? status
      : c.enabled && !worker.running ? 'RECEIVER_NOT_RUNNING' : null };
  return { ...result, guidance: receiverGuidance(result, { configPath: file }) };
}

export async function prepareDaily({ senders, clients, cli, configPath, stateDb, runtimeRoot, installationRoot, manualRuntimeRoot, perHour, inspectCli, cliOptions = {} }) {
  const thread = process.env.CODEX_THREAD_ID; ownerRequired(thread);
  const context = preparationContext({ thread, installationRoot, runtimeRoot, manualRuntimeRoot });
  const runtime = context.runtime, file = configPath ?? path.join(runtime, 'receiver-config.json');
  if ((context.installation || context.source === 'manual-legacy') && !samePath(file, path.join(runtime, 'receiver-config.json'))) throw new Error('RECEIVER_CONFIG_PATH_CONFLICT');
  const previous = fs.existsSync(file) ? readConfig(file) : null;
  if (previous && ['legacy-adoption.transaction', 'legacy-adoption.recovery.lock'].some((n) => fs.existsSync(path.join(previous.runtime_dir, n)))) throw new Error('LEGACY_ADOPTION_REVIEW_REQUIRED');
  if (previous && previous.thread_id !== thread) throw new Error('OWNER_TARGET_MISMATCH');
  if (previous && !samePath(previous.runtime_dir, runtime)) throw new Error('RUNTIME_INSTANCE_CONFLICT');
  if (previous?.installation_id) receiverInstallation(previous);
  if (previous && context.source === 'manual-legacy' && (previous.runtime_mode !== 'MANUAL_LEGACY_HUB' ||
      !samePath(previous.hub_runtime_root ?? '', context.hubRuntimeRoot))) throw new Error('LEGACY_CONFIG_REQUIRES_EXISTING_TOOL');
  if (previous && context.installation && !previous.installation_id) throw new Error('LEGACY_ADOPTION_REQUIRES_EXPLICIT_MIGRATION');
  const state = stateDb ?? previous?.state_db ?? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'state_5.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(state, { readOnly: true });
  let row;
  try { row = db.prepare('SELECT id,rollout_path,cwd,archived FROM threads WHERE id=?').get(thread); } finally { db.close(); }
  if (!row || row.archived) throw new Error('BINDING_CHANGED_OR_ARCHIVED');
  if (!cli && !previous?.cli) throw new Error('CLI_PATH_REQUIRED');
  const desiredPerHour = perHour ?? previous?.rate_limit?.max_submissions ?? 6;
  if (!Number.isSafeInteger(desiredPerHour) || desiredPerHour < 1 || desiredPerHour > 60) throw new Error('RECEIVER_RATE_LIMIT_INVALID');
  const allowed = [...new Set(senders ?? previous?.allowed_senders ?? [])].sort();
  const allowedClients = [...new Set(clients ?? previous?.allowed_clients ?? [])].sort();
  try { receiverSenderPolicy({ v: 2, mode: 'daily', allowed_senders: allowed, allowed_clients: allowedClients }); }
  catch { throw new Error('RECEIVER_SENDERS_INVALID'); }
  const options = { ...cliOptions, ...(inspectCli ? { inspect: inspectCli } : {}) };
  const oldCli = previous?.cli;
  const info = previous ? await refreshInstalledCli(previous, file, { ...options,
    ...(cli && !samePath(cli, previous.cli) ? { preferredCli: cli } : {}) }) :
    await resolveVerifiedCli({ cli: path.resolve(cli), allow_installed_cli_refresh: true }, options);
  if (previous?.mode === 'daily' && JSON.stringify([...previous.allowed_senders].sort()) === JSON.stringify(allowed) &&
      JSON.stringify([...(previous.allowed_clients ?? [])].sort()) === JSON.stringify(allowedClients) &&
      previous.rate_limit?.max_submissions === desiredPerHour && previous.rollout_path === row.rollout_path &&
      previous.workspace === row.cwd && samePath(previous.state_db, state)) {
    return { config_path: path.resolve(file), status: 'ALREADY_CONFIGURED', cli_refreshed: oldCli !== info.cli, config: previous };
  }
  if (previous) {
    const health = await receiverStatus(file);
    if (health.running !== false || health.service_running !== false) throw new Error('DISABLE_BEFORE_RECONFIGURE');
  }
  const installationFields = context.installation ? {
    installation_root: context.installationRoot, installation_id: context.installation.installation_id,
    locator_path: path.join(context.installationRoot, 'installation.json'),
    instance_id: context.installation.instance_id, hub_runtime_root: context.installation.runtime_root,
    hub_owner_kind: context.installation.hub_owner_kind, runtime_mode: 'INSTALLATION',
  } : context.source === 'manual-legacy' ? { runtime_mode: 'MANUAL_LEGACY_HUB', hub_runtime_root: context.hubRuntimeRoot }
    : { runtime_mode: 'EXPLICIT_ISOLATED_MANUAL' };
  const c = { ...previous, ...installationFields, v: 2, mode: 'daily', transport: 'target-pull', enabled: false,
    thread_id: thread, allowed_senders: allowed, ...info, workspace: row.cwd, rollout_path: row.rollout_path,
    ...(clients !== undefined || previous?.allowed_clients !== undefined ? { allowed_clients: allowedClients } : {}),
    state_db: path.resolve(state), runtime_dir: path.resolve(runtime),
    activated_at: previous?.activated_at ?? new Date().toISOString(), expires_at: null,
    window_id: previous?.window_id ?? crypto.randomUUID(), binding_epoch: crypto.randomUUID(),
    owner_opt_in: false, start_at_logon: previous?.start_at_logon ?? false,
    max_native_submissions: null, rate_limit: { max_submissions: desiredPerHour, window_ms: 3600000 },
    min_interval_ms: previous?.min_interval_ms ?? 30000, idle_settle_ms: previous?.idle_settle_ms ?? 3000,
    poll_interval_ms: previous?.poll_interval_ms ?? 2000, max_text_bytes: previous?.max_text_bytes ?? 12000, accept_backlog: true,
    allow_installed_cli_refresh: previous?.allow_installed_cli_refresh ?? true,
    binding_grade: 'HOST_ENV_SELF_REPORT + LOCAL_STATE_CORROBORATION; same-user owner opt-in, not independent host authentication' };
  delete c.config_path;
  validateReceiverConfig(c);
  if (context.installation) receiverInstallation({ ...c, config_path: path.resolve(file) });
  if (previous && context.installation) {
    const member = readMembership(membershipPath(context.installation.runtime_root, 'codex:' + thread));
    if (member) {
      if (member.installation_id !== context.installation.installation_id || member.instance_id !== context.installation.instance_id ||
          member.binding_epoch !== previous.binding_epoch || !samePath(member.config_path, file)) throw new Error('MEMBERSHIP_BINDING_MISMATCH');
      registerMembershipDisable({ root: context.installation.runtime_root, target: member.target });
    }
  }
  if (previous) fs.copyFileSync(file, file + '.backup-' + Date.now());
  writeJsonAtomic(file, c);
  return { status: 'PREPARED_DISABLED', config_path: path.resolve(file), config: c };
}

// Explicit adoption is performed by the original target owner, never inferred
// from an old enabled flag. It starts no process and preserves the old ledger.
export async function adoptLegacyDaily(file, options = {}) {
  return adoptLegacyReceiver(file, options);
}

export async function enableDaily(file, { loginStartup, cliOptions = {}, identityProvider } = {}) {
  const c = validateReceiverConfig(readConfig(file)); ownerRequired(c.thread_id);
  if (['legacy-adoption.transaction', 'legacy-adoption.recovery.lock'].some((n) => fs.existsSync(path.join(c.runtime_dir, n)))) throw new Error('LEGACY_ADOPTION_REVIEW_REQUIRED');
  if (c.mode !== 'daily') throw new Error('PREPARE_DAILY_FIRST');
  const installation = receiverInstallation(c);
  await ownBinding(c);
  await refreshInstalledCli(c, file, cliOptions);
  if (installation) {
    if (installation.hub_owner_kind !== 'COMPANION_OWNED') throw new Error('RECEIVER_REQUIRES_COMPANION_MODE');
    if (!UUID_RE.test(c.binding_epoch ?? '')) throw new Error('BINDING_EPOCH_REQUIRED');
    const before = await receiverStatus(file, Date.now(), { identityProvider });
    if (before.running === null || before.service_running === null) throw new Error('LOCK_REVIEW_REQUIRED');
    if (before.service_running) throw new Error('LEGACY_SUPERVISOR_REQUIRES_HANDOVER');
    if (before.running && !before.healthy) throw new Error('EXISTING_RECEIVER_UNRESPONSIVE_NO_REPLACEMENT');
    if (before.running && !c.enabled) throw new Error('WAIT_FOR_DISABLE_TO_FINISH');
    const existingMember = readMembership(membershipPath(installation.runtime_root, 'codex:' + c.thread_id));
    if (existingMember && (existingMember.installation_id !== c.installation_id || existingMember.instance_id !== c.instance_id ||
        !samePath(existingMember.config_path, file))) throw new Error('MEMBERSHIP_BINDING_MISMATCH');
    if (existingMember && existingMember.binding_epoch !== c.binding_epoch && existingMember.desired_state === 'ENABLED') throw new Error('MEMBERSHIP_EPOCH_HANDOVER_REQUIRED');
    const stop = path.join(c.runtime_dir, 'stop'); if (fs.existsSync(stop)) fs.unlinkSync(stop);
    const updated = { ...c, config_path: undefined, enabled: true, owner_opt_in: true,
      owner_opt_in_at: c.owner_opt_in_at ?? new Date().toISOString(),
      start_at_logon: typeof loginStartup === 'boolean' ? loginStartup : c.start_at_logon ?? false };
    writeJsonAtomic(file, updated);
    const membership = registerMembershipEnable({ root: installation.runtime_root, installation_id: installation.installation_id,
      instance_id: installation.instance_id, target: 'codex:' + c.thread_id, binding_epoch: c.binding_epoch,
      config_path: path.resolve(file), owner_opt_in_at: updated.owner_opt_in_at, start_at_logon: updated.start_at_logon });
    const status = await receiverStatus(file, Date.now(), { identityProvider });
    return { ...status, status: status.healthy ? status.status : 'PENDING_COMPANION',
      action: 'ENABLE_REGISTERED', desired_state: 'ENABLED', start_reason: 'USER_ENABLE',
      membership_path: membership.file, worker_state: status.healthy ? 'RUNNING' : 'PENDING',
      reason_code: status.healthy ? null : 'NO_VERIFIED_COMPANION_WORKER', background_spawned: false };
  }
  if (loginStartup === true) throw new Error('LEGACY_STARTUP_REQUIRES_MIGRATION');
  const current = await receiverStatus(file, Date.now(), { identityProvider });
  if (current.running) {
    if (!current.healthy) throw new Error('EXISTING_RECEIVER_UNRESPONSIVE_NO_REPLACEMENT');
    if (!c.enabled) throw new Error('WAIT_FOR_DISABLE_TO_FINISH');
    return { ...current, action: 'ALREADY_RUNNING' };
  }
  if (current.running === null || current.service_running === null) throw new Error('LOCK_REVIEW_REQUIRED');
  if (current.service_running) return { ...current, action: 'WORKER_RECOVERING' };
  if (current.status === 'HALTED_WORKER_RESTARTS') return { ...current, action: 'HALTED_REVIEW_REQUIRED' };
  await recoverReceiverLock(c, file, 'worker', { provider: identityProvider });
  await recoverReceiverLock(c, file, 'service', { provider: identityProvider });
  const stop = path.join(c.runtime_dir, 'stop'); if (fs.existsSync(stop)) fs.unlinkSync(stop);
  writeJsonAtomic(file, { ...c, config_path: undefined, enabled: true,
    ...(c.runtime_mode === 'MANUAL_LEGACY_HUB' ? { owner_opt_in: true, owner_opt_in_at: c.owner_opt_in_at ?? new Date().toISOString() } : {}) });
  const nonce = crypto.randomUUID();
  const out = fs.openSync(path.join(c.runtime_dir, 'stdout.log'), 'a'), err = fs.openSync(path.join(c.runtime_dir, 'stderr.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('./receiver-service.mjs', import.meta.url)), path.resolve(file), nonce], {
      cwd: PROJECT_ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, err],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { fs.closeSync(out); fs.closeSync(err); }
  const deadline = Date.now() + 16000;
  while (Date.now() < deadline) {
    const status = await receiverStatus(file, Date.now(), { identityProvider });
    if (status.worker_nonce === nonce && status.healthy) return { ...status, action: 'ENABLED' };
    if (child.exitCode !== null) throw new Error('RECEIVER_START_FAILED_SEE_STDERR');
    await wait(200);
  }
  throw new Error('RECEIVER_START_UNCONFIRMED_NO_RETRY');
}

export async function disableDaily(file, { identityProvider } = {}) {
  const c = readConfig(file); ownerRequired(c.thread_id);
  const installation = receiverInstallation(c);
  writeJsonAtomic(file, { ...c, config_path: undefined, enabled: false });
  fs.writeFileSync(path.join(c.runtime_dir, 'stop'), new Date().toISOString());
  if (installation) {
    const member = readMembership(membershipPath(installation.runtime_root, 'codex:' + c.thread_id));
    if (member) {
      if (member.installation_id !== installation.installation_id || member.instance_id !== installation.instance_id ||
          member.binding_epoch !== c.binding_epoch || !samePath(member.config_path, file)) throw new Error('MEMBERSHIP_BINDING_MISMATCH');
      registerMembershipDisable({ root: installation.runtime_root, target: 'codex:' + c.thread_id });
    }
  }
  const deadline = Date.now() + 12000;
  let status = await receiverStatus(file, Date.now(), { identityProvider });
  while ((status.running !== false || status.service_running !== false) && Date.now() < deadline) {
    await wait(200);
    status = await receiverStatus(file, Date.now(), { identityProvider });
  }
  if (!installation) await removeStartup(c);
  const stopped = status.running === false && status.service_running === false;
  return { ...status, action: stopped ? 'DISABLED' : 'DISABLE_REQUESTED_UNCONFIRMED',
    stop_confirmed: stopped, desired_state: 'DISABLED' };
}

// Diagnostic inspection never writes or enables a target.
export async function inspectDaily(file, { cliOptions = {}, identityProvider } = {}) {
  const c = validateReceiverConfig(readConfig(file)); receiverInstallation(c); await ownBinding(c);
  const proposed = await resolveVerifiedCli(c, cliOptions);
  return { ...await receiverStatus(file, Date.now(), { identityProvider }), cli_compatible: true,
    cli_repair_required: c.cli !== proposed.cli || c.cli_sha256 !== proposed.cli_sha256,
    proposed_cli: proposed, config_changed: false, native_submitted: false };
}
export async function repairDailyCli(file, { cliOptions = {} } = {}) {
  const c = validateReceiverConfig(readConfig(file)); ownerRequired(c.thread_id); receiverInstallation(c); await ownBinding(c);
  if (['legacy-adoption.transaction', 'legacy-adoption.recovery.lock'].some((n) => fs.existsSync(path.join(c.runtime_dir, n)))) throw new Error('LEGACY_ADOPTION_REVIEW_REQUIRED');
  const repaired = await refreshInstalledCli(c, file, cliOptions);
  return { status: 'CLI_REPAIRED', thread_id: c.thread_id, cli: repaired, enabled: c.enabled,
    binding_changed: false, native_submitted: false };
}

export async function replyDailyClient(file, args, { checkBinding = ownBinding, hubOptions, connect = withHubClient } = {}) {
  const c = readConfig(file); ownerRequired(c.thread_id); receiverInstallation(c); await checkBinding(c);
  const payload = readClientReply(c, args);
  return connect({ ...(hubOptions ?? receiverHubOptions(c)), role: 'cli', identity: 'cli:operator' }, async (client) => {
    const result = await postClientReply(client, payload);
    // Remote reply confirmation remains true if the separate local model
    // receipt write fails; never turn a stored answer into "not sent".
    try {
      const receipt = recordModelReceipt(c, payload.msg_id, result.receiving_turn_id, process.env.CODEX_THREAD_ID);
      return { ...result, model_receipt_status: receipt.status };
    } catch {
      return { ...result, model_receipt_status: 'LOCAL_RECEIPT_WRITE_UNCONFIRMED' };
    }
  });
}

async function controlCommand(args) {
  const [command, ...rest] = args;
  if (command === 'prepare') {
    const senders = [], clients = []; let cli, file, perHour, installationRoot, manualRuntimeRoot;
    for (let i = 0; i < rest.length; i += 2) {
      if (!rest[i + 1]) throw new Error('PREPARE_OPTION_VALUE_REQUIRED');
      if (rest[i] === '--sender') senders.push(rest[i + 1]);
      else if (rest[i] === '--client-sender') clients.push(rest[i + 1]);
      else if (rest[i] === '--cli') cli = rest[i + 1];
      else if (rest[i] === '--config') file = rest[i + 1];
      else if (rest[i] === '--per-hour') perHour = Number(rest[i + 1]);
      else if (rest[i] === '--installation-root') installationRoot = rest[i + 1];
      else if (rest[i] === '--manual-runtime') manualRuntimeRoot = rest[i + 1];
      else throw new Error('UNKNOWN_PREPARE_OPTION');
    }
    return prepareDaily({ senders: senders.length ? senders : undefined, clients: clients.length ? clients : undefined,
      cli, configPath: file, perHour, installationRoot, manualRuntimeRoot });
  }
  const [file, msg, turn] = rest;
  if (!file) throw new Error('CONFIG_PATH_REQUIRED');
  if (['adopt', 'adopt-resume', 'adopt-abort'].includes(command)) {
    const options = { resume: command === 'adopt-resume', abort: command === 'adopt-abort' };
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--accept-proven-reuse') options.acceptProvenReuse = true;
      else if (rest[i] === '--installation-root' && rest[i + 1]) options.installationRoot = rest[++i];
      else throw new Error('LEGACY_ADOPTION_INSTALLATION_REQUIRED');
    }
    return adoptLegacyDaily(file, options);
  }
  if (command === 'reply') {
    const options = {};
    for (let i = 1; i < rest.length; i += 2) {
      if (!rest[i + 1]) throw new Error('CLIENT_REPLY_ARGUMENTS_INVALID');
      if (rest[i] === '--request-id') options.requestId = rest[i + 1];
      else if (rest[i] === '--turn-id') options.turnId = rest[i + 1];
      else if (rest[i] === '--body-file') options.bodyFile = rest[i + 1];
      else throw new Error('CLIENT_REPLY_ARGUMENTS_INVALID');
    }
    return replyDailyClient(file, options);
  }
  if (command === 'enable') return enableDaily(file, { loginStartup: rest.includes('--login') ? true : rest.includes('--no-login') ? false : undefined });
  if (command === 'disable' || command === 'stop') return disableDaily(file);
  if (command === 'status') return receiverStatus(file);
  if (command === 'doctor') return inspectDaily(file);
  if (command === 'repair-cli') return repairDailyCli(file);
  if (command === 'renew') {
    const c = readConfig(file); ownerRequired(c.thread_id);
    if (c.mode !== 'daily') throw new Error('PREPARE_DAILY_FIRST');
    return { status: 'RENEWAL_NOT_REQUIRED', mode: 'daily', expires_at: null };
  }
  if (command === 'receipt') return recordModelReceipt(readConfig(file), msg, turn, process.env.CODEX_THREAD_ID);
  throw new Error('UNKNOWN_RECEIVER_COMMAND');
}

export async function control(args) {
  const result = await controlCommand(args);
  return { ...result, guidance: receiverGuidance(result, {
    configPath: result.config_path ?? (args[0] === 'prepare' ? undefined : args[1]),
  }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  control(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    const code = receiverErrorCode(error);
    console.error(JSON.stringify({ ok: false, code, guidance: receiverGuidance({ code }, {
      configPath: process.argv[2] === 'prepare' ? undefined : process.argv[3],
    }) })); process.exitCode = 1;
  });
}
