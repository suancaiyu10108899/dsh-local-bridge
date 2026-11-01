// Target-scoped polling is local transport work, never empty-queue model polling.
// Does not register a role-wide adapter or own any shared host's lifecycle.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withHubClient } from '../../src/client.mjs';
import { writeJsonAtomic } from '../../src/runtime.mjs';
import { membershipPath, readMembership } from '../../src/membership.mjs';
import { QueueInbox, idleState, validateReceiverConfig, messageDecision } from './queue-inbox.mjs';
import { readLifecycle } from './queue-receiver.mjs';
import { refreshInstalledCli } from './installed-cli.mjs';
import { bindingFingerprint } from './installed-cli.mjs';
import { receiverInstallation, receiverHubOptions } from './receiver-context.mjs';
import { claimReceiverProcess } from './receiver-identity.mjs';
import { LOADED_RECEIVER_CODE, receiverCodeUnchanged } from './receiver-code.mjs';
import { receiverGuidance } from './receiver-guidance.mjs';
import { clientRequestsSupported, clientDispatchHooks, postClientOutcome } from './client-dispatch.mjs';

const execute = promisify(execFile);
export const binaryHash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export async function ownBinding(config) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(config.state_db, { readOnly: true });
  try {
    const r = db.prepare('SELECT id,rollout_path,cwd,archived FROM threads WHERE id=?').get(config.thread_id);
    const normalize = (s) => path.resolve(s).replace(/^\\\\\?\\/, '').toLowerCase();
    if (!r || r.archived || normalize(r.rollout_path) !== normalize(config.rollout_path) ||
        normalize(r.cwd) !== normalize(config.workspace)) throw new Error('BINDING_CHANGED_OR_ARCHIVED');
    return r;
  } finally { db.close(); }
}

export async function dailyTick({ config: c, inbox, hubOptions, executeNative, lifecycle = readLifecycle, beforeSubmit = () => true }) {
  if (!c.enabled) return { status: 'DISABLED', reason_code: 'DISABLED_BY_OWNER' };
  const pendingClientUncertain = Object.values(inbox.data.entries).filter((entry) =>
    entry.status === 'UNCERTAIN' && entry.client_request_id && !entry.client_outcome_reported_at);
  if (inbox.hasUncertainty() && !pendingClientUncertain.length) return { status: 'PAUSED_UNCERTAIN', reason_code: 'NATIVE_OUTCOME_UNCERTAIN' };
  const events = lifecycle(c.rollout_path);
  const idle = idleState(events, c.idle_settle_ms, inbox.now());
  const unconfirmed = Object.values(inbox.data.entries).filter((e) => e.status === 'NATIVE_QUEUED' && !e.hub_consumed_at && !e.hub_finalized_at);
  if (idle !== 'idle' && !unconfirmed.length && !pendingClientUncertain.length) return { status: 'WAITING_FOR_TARGET_IDLE', reason_code: idle.toUpperCase() };
  if (idle === 'idle' && !unconfirmed.length && !pendingClientUncertain.length && (inbox.remaining() <= 0 || !inbox.due())) {
    return { status: inbox.remaining() <= 0 ? 'RATE_LIMITED' : 'WAITING_COOLDOWN', reason_code: 'ROLLING_BUDGET_OR_COOLDOWN', next_eligible_at: inbox.nextEligibleAt() };
  }
  const options = hubOptions ?? receiverHubOptions(c);
  return withHubClient({ ...options, role: 'cli', identity: 'cli:operator' }, async (q) => {
    if (c.installation_id) {
      const welcome = q.welcomeInfo;
      if (!welcome || welcome.protocol_version !== 1 || welcome.installation_id !== c.installation_id || welcome.instance_id !== c.instance_id ||
          welcome.capabilities?.target_binding_epoch !== true) {
        return { status: 'PAUSED_PROTOCOL_BINDING_REQUIRED', reason_code: 'HUB_INSTANCE_OR_BINDING_CAPABILITY_UNVERIFIED' };
      }
    }
    if ((await q.roles()).includes('codex')) return { status: 'BLOCKED_OTHER_ADAPTER', reason_code: 'LEGACY_ROLE_ADAPTER_CONNECTED' };
    const target = `codex:${c.thread_id}`, targets = await q.targets();
    if (pendingClientUncertain.length) {
      if (!clientRequestsSupported(q)) return { status: 'PAUSED_CLIENT_PROTOCOL_REQUIRED', reason_code: 'CLIENT_REQUEST_PROTOCOL_REQUIRED' };
      for (const entry of pendingClientUncertain) {
        const outcome = await postClientOutcome(q, c, entry);
        entry.client_outcome_reported_at = new Date(inbox.now()).toISOString();
        if (['NATIVE_QUEUED', 'DELIVERED', 'REPLY_READY'].includes(outcome.state) && typeof outcome.native_queue_id === 'string') {
          entry.reconciled_from = 'UNCERTAIN'; entry.status = 'NATIVE_QUEUED';
          entry.native_queue_id = outcome.native_queue_id; entry.accepted_at = outcome.native_outcome_at ?? entry.client_outcome_reported_at;
          entry.native_outcome_evidence = 'HUB_ORIGINAL_REQUEST_LEASE_RECEIPT';
          unconfirmed.push(entry);
        }
        inbox.save();
      }
    }
    if (inbox.hasUncertainty()) return { status: 'PAUSED_UNCERTAIN', reason_code: 'NATIVE_OUTCOME_UNCERTAIN' };
    if (!targets.some((t) => t.enabled && t.identity === target)) return { status: 'PAUSED_PAIRING_REVOKED', reason_code: 'TARGET_UNPAIRED' };
    for (const entry of unconfirmed) {
      if (entry.client_request_id) {
        if (!clientRequestsSupported(q)) return { status: 'PAUSED_CLIENT_PROTOCOL_REQUIRED', reason_code: 'CLIENT_REQUEST_PROTOCOL_REQUIRED' };
        await postClientOutcome(q, c, entry);
        entry.client_outcome_reported_at = new Date(inbox.now()).toISOString(); inbox.save();
      }
      const m = await q.status(entry.msg_id);
      if (m?.to !== target) continue;
      if (['queued', 'delivery_unknown'].includes(m.state)) {
        await q.consume(m.msg_id, { consumer: target, note: `Native queue accepted as ${entry.native_queue_id}; model receipt separate.` });
      }
      if (entry.client_request_id) {
        entry.hub_state = m?.state ?? 'record-pruned'; entry.hub_finalized_at = new Date(inbox.now()).toISOString();
        if (['queued', 'delivery_unknown', 'delivered'].includes(m?.state)) entry.hub_consumed_at = entry.hub_finalized_at;
      } else { entry.hub_consumed_at = new Date(inbox.now()).toISOString(); entry.hub_state = m?.state ?? 'record-pruned'; }
      inbox.save();
    }
    if (idle !== 'idle') return { status: 'WAITING_FOR_TARGET_IDLE', reason_code: idle.toUpperCase() };
    if (inbox.remaining() <= 0 || !inbox.due()) return { status: 'RATE_LIMITED', reason_code: 'ROLLING_BUDGET_OR_COOLDOWN', next_eligible_at: inbox.nextEligibleAt() };
    const messages = [...await q.statusList({ to: target, state: 'queued', limit: 100 }),
      ...await q.statusList({ to: target, state: 'delivery_unknown', limit: 100 })]
      .filter((m, i, all) => all.findIndex((x) => x.msg_id === m.msg_id) === i)
      .sort((a, b) => Date.parse(a.accepted_at ?? a.created_at) - Date.parse(b.accepted_at ?? b.created_at));
    const deferrals = inbox.clientDeferrals ??= new Map();
    for (const [id, until] of deferrals) if (until <= inbox.now()) deferrals.delete(id);
    const m = messages.find((candidate) => messageDecision(candidate, c, targets, inbox.now()) === 'eligible' &&
      !deferrals.has(candidate.msg_id) && (candidate.from_role !== 'client' || clientRequestsSupported(q)));
    if (!m) {
      const blocked = messages.filter((candidate) => ['binding-epoch-missing', 'binding-epoch-mismatch'].includes(messageDecision(candidate, c, targets, inbox.now()))).length;
      const clientBlocked = !clientRequestsSupported(q) && messages.some((candidate) => candidate.from_role === 'client' && messageDecision(candidate, c, targets, inbox.now()) === 'eligible');
      return { status: clientBlocked ? 'PAUSED_CLIENT_PROTOCOL_REQUIRED' : blocked ? 'PAUSED_BINDING_BACKLOG' : 'ONLINE_IDLE',
        reason_code: clientBlocked ? 'CLIENT_REQUEST_PROTOCOL_REQUIRED' : blocked ? 'BINDING_EPOCH_REVIEW_REQUIRED' : messages.length ? 'NO_ELIGIBLE_MESSAGE' : null,
        queued_messages: messages.length, binding_review_messages: blocked };
    }
    if (idleState(lifecycle(c.rollout_path), c.idle_settle_ms, inbox.now()) !== 'idle' || !beforeSubmit()) return { status: 'WAITING_FOR_TARGET_IDLE', reason_code: 'BUSY_OR_DISABLED_BEFORE_SUBMIT' };
    if ((await q.roles()).includes('codex')) return { status: 'BLOCKED_OTHER_ADAPTER', reason_code: 'LEGACY_ROLE_ADAPTER_CONNECTED' };
    const freshTargets = await q.targets();
    const pre = { at: new Date(inbox.now()).toISOString(), msg_id: m.msg_id, idle_events: lifecycle(c.rollout_path).slice(-2) };
    writeJsonAtomic(path.join(c.runtime_dir, 'last-dispatch.json'), pre);
    const hooks = m.from_role === 'client' ? clientDispatchHooks({ client: q, config: c, message: m, now: inbox.now,
      isReady: () => idleState(lifecycle(c.rollout_path), c.idle_settle_ms, inbox.now()) === 'idle' && beforeSubmit() }) : undefined;
    const result = await inbox.submit(m, freshTargets, executeNative ?? ((cli, args) => execute(cli, args, {
      cwd: c.workspace, windowsHide: true, timeout: 8000, maxBuffer: 65536
    })), hooks);
    if (result.status === 'NATIVE_QUEUED') {
      if (m.from_role === 'client') {
        const entry = inbox.entry(m.msg_id); entry.client_outcome_reported_at = new Date(inbox.now()).toISOString(); inbox.save();
      }
      const current = await q.status(m.msg_id);
      if (current?.to === target && ['queued', 'delivery_unknown'].includes(current.state)) {
        await q.consume(m.msg_id, { consumer: target, note: `Native queue accepted as ${result.native_queue_id}; model processing not implied.` });
      }
      const entry = inbox.entry(m.msg_id);
      if (m.from_role === 'client' && !['queued', 'delivery_unknown', 'delivered'].includes(current?.state)) {
        entry.hub_state = current?.state ?? 'record-pruned'; entry.hub_finalized_at = new Date(inbox.now()).toISOString();
      } else entry.hub_consumed_at = new Date(inbox.now()).toISOString();
      inbox.save();
      return { status: 'NATIVE_QUEUED_NOT_MODEL_PROOF', reason_code: null, msg_id: m.msg_id, native_queue_id: result.native_queue_id };
    }
    if (m.from_role === 'client' && result.status === 'UNCERTAIN') {
      const entry = inbox.entry(m.msg_id); entry.client_outcome_reported_at = new Date(inbox.now()).toISOString(); inbox.save();
    }
    if (m.from_role === 'client' && result.status === 'DEFERRED') {
      deferrals.set(m.msg_id, inbox.now() + 30000);
      return { status: 'WAITING_CLIENT_AUTHORIZATION', reason_code: result.reason,
        msg_id: m.msg_id, next_eligible_at: new Date(inbox.now() + 30000).toISOString() };
    }
    return { status: result.status === 'UNCERTAIN' ? 'PAUSED_UNCERTAIN' : 'ONLINE_IDLE',
      reason_code: result.status === 'UNCERTAIN' ? 'NATIVE_OUTCOME_UNCERTAIN' : result.reason };
  });
}

export async function runDaily(configPath, { hubOptions, executeNative, checkBinding = ownBinding, lifecycle = readLifecycle, cliOptions = {}, identityProvider,
  now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), instanceId = crypto.randomUUID() } = {}) {
  const c = validateReceiverConfig({ ...JSON.parse(fs.readFileSync(configPath, 'utf8')), config_path: path.resolve(configPath) }, now());
  if (c.mode !== 'daily' || !c.enabled) throw new Error('DAILY_RECEIVER_NOT_ENABLED');
  const installation = receiverInstallation(c);
  if (installation) {
    if (installation.hub_owner_kind !== 'COMPANION_OWNED' || !c.owner_opt_in || !c.binding_epoch) throw new Error('PERSISTED_OWNER_OPT_IN_REQUIRED');
    if (process.env.CODEX_THREAD_ID) throw new Error('BACKGROUND_WORKER_CONTEXT_NOT_SANITIZED');
  } else if (process.env.CODEX_THREAD_ID && process.env.CODEX_THREAD_ID !== c.thread_id) throw new Error('OWNER_THREAD_MISMATCH');
  await checkBinding(c);
  fs.mkdirSync(c.runtime_dir, { recursive: true });
  await refreshInstalledCli(c, configPath, { verifyCapabilities: false, ...cliOptions });
  if (!c.enabled) return;
  const lease = await claimReceiverProcess(c, configPath, 'worker', { provider: identityProvider, nonce: instanceId, now: now() });
  let inbox;
  let done = false, backoff = 0, retryAt = 0, lastState = '', lastHeartbeat = 0, lastArchive = 0, lastCodeCheck = 0, pausedReason = null, stopReason = 'DISABLED_BY_OWNER';
  let cliStamp = fs.statSync(c.cli);
  const binaryUnchanged = async () => {
    if (!fs.existsSync(c.cli)) {
      await refreshInstalledCli(c, configPath, cliOptions);cliStamp = fs.statSync(c.cli);return true;
    }
    const next = fs.statSync(c.cli);
    if (next.size === cliStamp.size && next.mtimeMs === cliStamp.mtimeMs && next.ino === cliStamp.ino) return true;
    if (binaryHash(c.cli) !== c.cli_sha256) {
      await refreshInstalledCli(c, configPath, cliOptions);cliStamp = fs.statSync(c.cli);return true;
    }
    cliStamp = next; return true;
  };
  const onTerm = () => { done = true; stopReason = 'SIGTERM_STOP_REQUESTED'; };
  const onInt = () => { done = true; stopReason = 'SIGINT_STOP_REQUESTED'; };
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  const enabled = () => {
    if (fs.existsSync(path.join(c.runtime_dir, 'stop'))) { stopReason = 'STOP_FILE_PRESENT'; return false; }
    const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (current.enabled !== true || (installation && current.owner_opt_in !== true)) return false;
    if (bindingFingerprint(current) !== bindingFingerprint(c)) throw new Error('BINDING_CONFIG_CHANGED');
    if (current.cli !== c.cli || current.cli_sha256 !== c.cli_sha256) throw new Error('CLI_CONFIG_CHANGED_REVIEW_REQUIRED');
    if (installation) {
      receiverInstallation(current);
      const member = readMembership(membershipPath(installation.runtime_root, 'codex:' + c.thread_id));
      if (!member || member.desired_state !== 'ENABLED' || !member.enabled) return false;
      if (member.target !== 'codex:' + c.thread_id || member.installation_id !== c.installation_id || member.instance_id !== c.instance_id ||
          member.binding_epoch !== c.binding_epoch || !member.owner_opt_in || path.resolve(member.config_path) !== path.resolve(configPath)) throw new Error('MEMBERSHIP_BINDING_MISMATCH');
    }
    return true;
  };
  const publish = (result) => {
    const signature = JSON.stringify(result);
    if (signature === lastState && now() - lastHeartbeat < 15000) return;
    lastState = signature; lastHeartbeat = now();
    const stamp = new Date(now()).toISOString();
    lease.heartbeat(now());
    writeJsonAtomic(path.join(c.runtime_dir, 'status.json'), { ...lease.statusFields, at: stamp, updated_at: stamp, heartbeat_at: stamp,
      mode: 'daily', transport: 'target-pull', enabled: !done, cli_version: c.cli_version ?? null, binding_epoch: c.binding_epoch ?? null,
      code_identity: LOADED_RECEIVER_CODE,
      thread_id: c.thread_id, window_id: c.window_id, expires_at: null, max_native_submissions: null,
      used_native_submissions: inbox?.rollingEntries().length ?? 0, remaining_native_submissions: inbox ? Math.max(0, inbox.remaining()) : c.rate_limit.max_submissions,
      rate_limit: c.rate_limit, last_error: /^(PAUSED|BACKOFF|BLOCKED)/.test(result.status) ? result.reason_code ?? null : null,
      ...result, guidance: receiverGuidance(result, { configPath }) });
  };
  try {
    inbox = new QueueInbox(c, { now });
    publish({ status: 'STARTED', reason_code: null });
    while (!done) {
      try {
        if (!enabled()) break;
        if (pausedReason) { publish({ status: 'PAUSED_REVIEW_REQUIRED', reason_code: pausedReason }); await wait(c.poll_interval_ms); continue; }
        if (now() - lastCodeCheck > 15000) {
          if (!receiverCodeUnchanged()) throw new Error('RECEIVER_CODE_CHANGED_RELOAD_REQUIRED');
          lastCodeCheck = now();
        }
        if (now() - lastArchive > 60000) { inbox.archiveExpired(); lastArchive = now(); }
        if (now() < retryAt) { publish({ status: 'BACKOFF_HUB', reason_code: 'HUB_UNREACHABLE', next_retry_at: new Date(retryAt).toISOString() }); await wait(Math.min(1000, retryAt - now())); continue; }
        await checkBinding(c);
        if (!await binaryUnchanged()) { publish({ status: 'PAUSED_BINARY_CHANGED', reason_code: 'CLI_BINARY_CHANGED' }); await wait(1000); continue; }
        const result = await dailyTick({ config: c, inbox, hubOptions, executeNative, lifecycle, beforeSubmit: () => {
          if (!enabled()) return false;
          if (!receiverCodeUnchanged()) throw new Error('RECEIVER_CODE_CHANGED_RELOAD_REQUIRED');
          if (binaryHash(c.cli) !== c.cli_sha256) throw new Error('CLI_BINARY_CHANGED');
          return true;
        } });
        backoff = 0; retryAt = 0; publish(result);
      } catch (error) {
        if (error.name === 'HubClientError' || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)) {
          backoff = Math.min(backoff ? backoff * 2 : 1000, 30000); retryAt = now() + backoff;
          publish({ status: 'BACKOFF_HUB', reason_code: 'HUB_UNREACHABLE', next_retry_at: new Date(retryAt).toISOString() });
        } else { pausedReason = error.code ?? error.message; publish({ status: 'PAUSED_REVIEW_REQUIRED', reason_code: pausedReason }); }
      }
      await wait(c.poll_interval_ms);
    }
    done = true; publish({ status: 'DISABLED', reason_code: stopReason, enabled: false, last_exit: { code: 0, signal: null, reason: stopReason } });
  } catch (error) {
    done = true; publish({ status: 'HALTED', reason_code: error.code ?? error.message, enabled: false,
      last_exit: { code: 1, signal: null, reason: error.code ?? error.message } });
    throw error;
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
    lease.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDaily(process.argv[2], { instanceId: process.argv[3] ?? crypto.randomUUID() }).catch((error) => {
    console.error(error.message); process.exitCode = 1;
  });
}
