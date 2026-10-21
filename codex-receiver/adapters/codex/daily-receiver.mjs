// Target-scoped polling is local transport work, never empty-queue model polling.
// Does not register a role-wide adapter or own any shared host's lifecycle.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withHubClient } from '../../src/client.mjs';
import { loadConfig, readToken, writeJsonAtomic } from '../../src/runtime.mjs';
import { QueueInbox, idleState, validateReceiverConfig, messageDecision } from './queue-inbox.mjs';
import { readLifecycle } from './queue-receiver.mjs';
import { refreshInstalledCli } from './installed-cli.mjs';

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
  if (inbox.hasUncertainty()) return { status: 'PAUSED_UNCERTAIN', reason_code: 'NATIVE_OUTCOME_UNCERTAIN' };
  const events = lifecycle(c.rollout_path);
  const idle = idleState(events, c.idle_settle_ms, inbox.now());
  const unconfirmed = Object.values(inbox.data.entries).filter((e) => e.status === 'NATIVE_QUEUED' && !e.hub_consumed_at);
  if (idle !== 'idle' && !unconfirmed.length) return { status: 'WAITING_FOR_TARGET_IDLE', reason_code: idle.toUpperCase() };
  if (idle === 'idle' && !unconfirmed.length && (inbox.remaining() <= 0 || !inbox.due())) {
    return { status: inbox.remaining() <= 0 ? 'RATE_LIMITED' : 'WAITING_COOLDOWN', reason_code: 'ROLLING_BUDGET_OR_COOLDOWN', next_eligible_at: inbox.nextEligibleAt() };
  }
  const options = hubOptions ?? { ...loadConfig(), token: readToken() };
  return withHubClient({ ...options, role: 'cli', identity: 'cli:operator' }, async (q) => {
    if ((await q.roles()).includes('codex')) return { status: 'BLOCKED_OTHER_ADAPTER', reason_code: 'LEGACY_ROLE_ADAPTER_CONNECTED' };
    const target = `codex:${c.thread_id}`, targets = await q.targets();
    if (!targets.some((t) => t.enabled && t.identity === target)) return { status: 'PAUSED_PAIRING_REVOKED', reason_code: 'TARGET_UNPAIRED' };
    for (const entry of unconfirmed) {
      const m = await q.status(entry.msg_id);
      if (m?.to !== target) continue;
      if (['queued', 'delivery_unknown'].includes(m.state)) {
        await q.consume(m.msg_id, { consumer: target, note: `Native queue accepted as ${entry.native_queue_id}; model receipt separate.` });
      }
      entry.hub_consumed_at = new Date(inbox.now()).toISOString(); entry.hub_state = m?.state ?? 'record-pruned'; inbox.save();
    }
    if (idle !== 'idle') return { status: 'WAITING_FOR_TARGET_IDLE', reason_code: idle.toUpperCase() };
    if (inbox.remaining() <= 0 || !inbox.due()) return { status: 'RATE_LIMITED', reason_code: 'ROLLING_BUDGET_OR_COOLDOWN', next_eligible_at: inbox.nextEligibleAt() };
    const messages = [...await q.statusList({ to: target, state: 'queued', limit: 100 }),
      ...await q.statusList({ to: target, state: 'delivery_unknown', limit: 100 })]
      .filter((m, i, all) => all.findIndex((x) => x.msg_id === m.msg_id) === i)
      .sort((a, b) => Date.parse(a.accepted_at ?? a.created_at) - Date.parse(b.accepted_at ?? b.created_at));
    const m = messages.find((candidate) => messageDecision(candidate, c, targets, inbox.now()) === 'eligible');
    if (!m) return { status: 'ONLINE_IDLE', reason_code: messages.length ? 'NO_ELIGIBLE_MESSAGE' : null, queued_messages: messages.length };
    if (idleState(lifecycle(c.rollout_path), c.idle_settle_ms, inbox.now()) !== 'idle' || !beforeSubmit()) return { status: 'WAITING_FOR_TARGET_IDLE', reason_code: 'BUSY_OR_DISABLED_BEFORE_SUBMIT' };
    if ((await q.roles()).includes('codex')) return { status: 'BLOCKED_OTHER_ADAPTER', reason_code: 'LEGACY_ROLE_ADAPTER_CONNECTED' };
    const freshTargets = await q.targets();
    const pre = { at: new Date(inbox.now()).toISOString(), msg_id: m.msg_id, idle_events: lifecycle(c.rollout_path).slice(-2) };
    writeJsonAtomic(path.join(c.runtime_dir, 'last-dispatch.json'), pre);
    const result = await inbox.submit(m, freshTargets, executeNative ?? ((cli, args) => execute(cli, args, {
      cwd: c.workspace, windowsHide: true, timeout: 8000, maxBuffer: 65536
    })));
    if (result.status === 'NATIVE_QUEUED') {
      const current = await q.status(m.msg_id);
      if (current?.to === target && ['queued', 'delivery_unknown'].includes(current.state)) {
        await q.consume(m.msg_id, { consumer: target, note: `Native queue accepted as ${result.native_queue_id}; model processing not implied.` });
      }
      const entry = inbox.entry(m.msg_id); entry.hub_consumed_at = new Date(inbox.now()).toISOString(); inbox.save();
      return { status: 'NATIVE_QUEUED_NOT_MODEL_PROOF', reason_code: null, msg_id: m.msg_id, native_queue_id: result.native_queue_id };
    }
    return { status: result.status === 'UNCERTAIN' ? 'PAUSED_UNCERTAIN' : 'ONLINE_IDLE',
      reason_code: result.status === 'UNCERTAIN' ? 'NATIVE_OUTCOME_UNCERTAIN' : result.reason };
  });
}

export async function runDaily(configPath, { hubOptions, executeNative, checkBinding = ownBinding, lifecycle = readLifecycle,
  now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), instanceId = crypto.randomUUID() } = {}) {
  const c = validateReceiverConfig({ ...JSON.parse(fs.readFileSync(configPath, 'utf8')), config_path: path.resolve(configPath) }, now());
  if (c.mode !== 'daily' || !c.enabled) throw new Error('DAILY_RECEIVER_NOT_ENABLED');
  if (process.env.CODEX_THREAD_ID && process.env.CODEX_THREAD_ID !== c.thread_id) throw new Error('OWNER_THREAD_MISMATCH');
  await checkBinding(c);
  fs.mkdirSync(c.runtime_dir, { recursive: true });
  if (!fs.existsSync(c.cli) || binaryHash(c.cli) !== c.cli_sha256) await refreshInstalledCli(c, configPath);
  if (!c.enabled) return;
  const lock = path.join(c.runtime_dir, 'receiver.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, thread_id: c.thread_id, config_path: path.resolve(configPath), instance_id: instanceId }), { flag: 'wx' });
  let inbox;
  let done = false, backoff = 0, retryAt = 0, lastState = '', lastHeartbeat = 0, lastArchive = 0;
  let cliStamp = fs.statSync(c.cli);
  const binaryUnchanged = async () => {
    if (!fs.existsSync(c.cli)) {
      await refreshInstalledCli(c, configPath);cliStamp = fs.statSync(c.cli);return true;
    }
    const next = fs.statSync(c.cli);
    if (next.size === cliStamp.size && next.mtimeMs === cliStamp.mtimeMs && next.ino === cliStamp.ino) return true;
    if (binaryHash(c.cli) !== c.cli_sha256) {
      await refreshInstalledCli(c, configPath);cliStamp = fs.statSync(c.cli);return true;
    }
    cliStamp = next; return true;
  };
  const signal = () => { done = true; };
  process.on('SIGTERM', signal); process.on('SIGINT', signal);
  const enabled = () => {
    if (fs.existsSync(path.join(c.runtime_dir, 'stop'))) return false;
    const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (current.thread_id !== c.thread_id || current.window_id !== c.window_id || current.cli_sha256 !== c.cli_sha256 ||
        ['workspace', 'rollout_path', 'runtime_dir', 'state_db', 'cli', 'mode'].some((key) => current[key] !== c[key]) ||
        JSON.stringify(current.rate_limit) !== JSON.stringify(c.rate_limit) ||
        JSON.stringify(current.allowed_senders) !== JSON.stringify(c.allowed_senders)) throw new Error('BINDING_CONFIG_CHANGED');
    return current.enabled === true;
  };
  const publish = (result) => {
    const signature = JSON.stringify(result);
    if (signature === lastState && now() - lastHeartbeat < 15000) return;
    lastState = signature; lastHeartbeat = now();
    const stamp = new Date(now()).toISOString();
    writeJsonAtomic(path.join(c.runtime_dir, 'status.json'), { schema_version: 2, at: stamp, updated_at: stamp, heartbeat_at: stamp,
      mode: 'daily', transport: 'target-pull', enabled: !done, pid: process.pid, instance_id: instanceId,
      thread_id: c.thread_id, window_id: c.window_id, expires_at: null, max_native_submissions: null,
      used_native_submissions: inbox?.rollingEntries().length ?? 0, remaining_native_submissions: inbox ? Math.max(0, inbox.remaining()) : c.rate_limit.max_submissions,
      rate_limit: c.rate_limit, last_error: /^(PAUSED|BACKOFF|BLOCKED)/.test(result.status) ? result.reason_code ?? null : null, ...result });
  };
  try {
    inbox = new QueueInbox(c, { now });
    publish({ status: 'STARTED', reason_code: null });
    while (!done) {
      try {
        if (!enabled()) break;
        if (now() - lastArchive > 60000) { inbox.archiveExpired(); lastArchive = now(); }
        if (now() < retryAt) { publish({ status: 'BACKOFF_HUB', reason_code: 'HUB_UNREACHABLE', next_retry_at: new Date(retryAt).toISOString() }); await wait(Math.min(1000, retryAt - now())); continue; }
        await checkBinding(c);
        if (!await binaryUnchanged()) { publish({ status: 'PAUSED_BINARY_CHANGED', reason_code: 'CLI_BINARY_CHANGED' }); await wait(1000); continue; }
        const result = await dailyTick({ config: c, inbox, hubOptions, executeNative, lifecycle, beforeSubmit: () => {
          if (!enabled()) return false;
          if (binaryHash(c.cli) !== c.cli_sha256) throw new Error('CLI_BINARY_CHANGED');
          return true;
        } });
        backoff = 0; retryAt = 0; publish(result);
      } catch (error) {
        if (error.name === 'HubClientError' || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)) {
          backoff = Math.min(backoff ? backoff * 2 : 1000, 30000); retryAt = now() + backoff;
          publish({ status: 'BACKOFF_HUB', reason_code: 'HUB_UNREACHABLE', next_retry_at: new Date(retryAt).toISOString() });
        } else { publish({ status: 'PAUSED_REVIEW_REQUIRED', reason_code: error.message }); }
      }
      await wait(c.poll_interval_ms);
    }
    done = true; publish({ status: 'DISABLED', reason_code: 'DISABLED_BY_OWNER', enabled: false });
  } finally {
    process.off('SIGTERM', signal); process.off('SIGINT', signal);
    fs.unlinkSync(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDaily(process.argv[2], { instanceId: process.argv[3] ?? crypto.randomUUID() }).catch((error) => {
    console.error(error.message); process.exitCode = 1;
  });
}
