// Independent same-user process. No model/daemon/host lifecycle management.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { HubClient, withHubClient } from '../../src/client.mjs';
import { loadConfig, readToken, writeJsonAtomic } from '../../src/runtime.mjs';
import { QueueInbox, idleState, validateReceiverConfig, recordModelReceipt } from './queue-inbox.mjs';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readLifecycle(file) {
  const size = fs.statSync(file).size, start = Math.max(0, size - 262144);
  const buffer = Buffer.alloc(size - start), fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
  const lines = buffer.toString('utf8').split('\n');
  if (start) lines.shift();
  lines.pop();
  const events = [];
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(e.payload?.type)) {
      events.push({ type: e.payload.type, turn_id: e.payload.turn_id, timestamp: e.timestamp });
    }
  }
  return events;
}

export async function runReceiver(configPath, { hubOptions, executeNative } = {}) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const c = validateReceiverConfig({ ...JSON.parse(raw), config_path: path.resolve(configPath) });
  if (!c.enabled) throw new Error('receiver-disabled');
  if (process.env.CODEX_THREAD_ID !== c.thread_id) throw new Error('current-host-thread-mismatch');
  const cliMatches = () => createHash('sha256').update(fs.readFileSync(c.cli)).digest('hex') === c.cli_sha256;
  if (!cliMatches()) throw new Error('cli-changed');
  fs.mkdirSync(c.runtime_dir, { recursive: true });
  const lock = path.join(c.runtime_dir, 'receiver.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), window_id: c.window_id }), { flag: 'wx' });
  let client = null, done = false, phase = '', lastCheck = 0;
  const pending = new Map();
  const state = (status, extra = {}) => {
    if (status === phase && !Object.keys(extra).length) return;
    phase = status;
    writeJsonAtomic(path.join(c.runtime_dir, 'status.json'), { at: new Date().toISOString(), pid: process.pid,
      status, thread_id: c.thread_id, window_id: c.window_id, expires_at: c.expires_at, ...extra });
  };
  const disconnect = async () => { const old = client; client = null; if (old) await old.close(); pending.clear(); };
  const signal = () => { done = true; };
  process.on('SIGTERM', signal); process.on('SIGINT', signal);
  try {
    const inbox = new QueueInbox(c);
    if (inbox.hasUncertainty()) throw new Error('uncertain-native-submission-review-required');
    const options = hubOptions ?? { ...loadConfig(), token: readToken() };
    state('STARTED', { mode: 'BOUNDED_SINGLE_TARGET', max_native_submissions: c.max_native_submissions });
    while (!done && Date.now() < Date.parse(c.expires_at)) {
      if (fs.existsSync(path.join(c.runtime_dir, 'stop'))) break;
      const current = fs.readFileSync(configPath, 'utf8');
      if (current !== raw) {
        if (JSON.parse(current).enabled === false) break;
        throw new Error('config-changed-restart-required');
      }
      if (inbox.remaining() <= 0) { state('WINDOW_QUOTA_REACHED'); break; }
      const events = readLifecycle(c.rollout_path);
      if (idleState(events, c.idle_settle_ms) !== 'idle' || !inbox.due()) {
        await disconnect();
        state('WAITING_FOR_TARGET_IDLE_OR_COOLDOWN');
        await sleep(500); continue;
      }
      if (!client) {
        const pre = await withHubClient({ ...options, role: 'cli', identity: 'cli:operator' }, async (q) =>
          ({ roles: await q.roles(), targets: await q.targets() }));
        if (pre.roles.includes('codex')) throw new Error('another-codex-adapter-connected');
        const codexTargets = pre.targets.filter((t) => t.enabled && t.role === 'codex');
        if (codexTargets.length !== 1 || codexTargets[0].identity !== `codex:${c.thread_id}`) throw new Error('receiver-target-not-exclusive');
        if (!pre.targets.some((t) => t.enabled && c.allowed_senders.includes(t.identity))) throw new Error('source-pairing-revoked');
        const next = new HubClient({ ...options, role: 'codex', identity: `codex:${c.thread_id}` });
        next.onDelivery((m, context) => { if (!pending.has(m.msg_id)) pending.set(m.msg_id, { message: m, context }); });
        next.onClose(() => { if (client === next) { client = null; pending.clear(); } });
        await next.connect(); client = next;
        state('ONLINE_IDLE', { idle_events: events.slice(-2) });
      }
      const delivery = pending.values().next().value;
      if (delivery) {
        // Recheck busy state, pairing, binary and config immediately before dispatch.
        if (idleState(readLifecycle(c.rollout_path), c.idle_settle_ms) !== 'idle') { await disconnect(); continue; }
        if (fs.readFileSync(configPath, 'utf8') !== raw || fs.existsSync(path.join(c.runtime_dir, 'stop'))) break;
        if (!cliMatches()) throw new Error('cli-changed');
        const targets = await client.targets();
        writeJsonAtomic(path.join(c.runtime_dir, 'last-dispatch.json'), { at: new Date().toISOString(),
          msg_id: delivery.message.msg_id, idle_events: readLifecycle(c.rollout_path).slice(-2) });
        const result = await inbox.submit(delivery.message, targets, executeNative ?? ((cli, args) => exec(cli, args, {
          cwd: c.workspace, windowsHide: true, timeout: 8000, maxBuffer: 65536
        })));
        pending.delete(delivery.message.msg_id);
        if (result.status === 'NATIVE_QUEUED') {
          delivery.context.ack({ ok: true });
          // FIFO round-trip lets the Hub persist its ACK before we close the socket.
          const hub = await client.status(delivery.message.msg_id);
          state('NATIVE_QUEUED_NOT_MODEL_PROOF', { msg_id: result.msg_id, native_queue_id: result.native_queue_id,
            replay: result.replay, hub_state: hub?.state });
          await disconnect();
        } else if (result.status === 'REJECTED') {
          delivery.context.ack({ ok: false, retryable: false, code: result.reason });
        } else if (result.status === 'UNCERTAIN') {
          // Disconnect without ACK; leave delivery_unknown, retain durable claim, halt.
          throw new Error('uncertain-native-submission-review-required');
        } else { await disconnect(); }
      }
      lastCheck = Date.now();
      await sleep(250);
    }
    state(phase === 'WINDOW_QUOTA_REACHED' ? phase : Date.now() >= Date.parse(c.expires_at) ? 'EXPIRED' : 'STOPPED');
  } catch (error) {
    state('HALTED_REVIEW_REQUIRED', { error: error.message, last_check_at: lastCheck });
    throw error;
  } finally {
    await disconnect();
    process.off('SIGTERM', signal); process.off('SIGINT', signal);
    fs.unlinkSync(lock);
  }
}

export function receiverCommand(argv) {
  const [command, configPath, msgId, turnId] = argv;
  if (!configPath) throw new Error('usage: queue-receiver.mjs start|status|stop|receipt CONFIG [MSG_ID TURN_ID]');
  const c = { ...JSON.parse(fs.readFileSync(configPath, 'utf8')), config_path: path.resolve(configPath) };
  if (command === 'start') return runReceiver(configPath);
  if (command === 'status') {
    const file = path.join(c.runtime_dir, 'status.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { status: 'NOT_STARTED' };
  }
  if (command === 'stop') {
    fs.mkdirSync(c.runtime_dir, { recursive: true });
    fs.writeFileSync(path.join(c.runtime_dir, 'stop'), new Date().toISOString());
    return { status: 'STOP_REQUESTED' };
  }
  if (command === 'receipt') return recordModelReceipt(c, msgId, turnId, process.env.CODEX_THREAD_ID);
  throw new Error('unknown-receiver-command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => receiverCommand(process.argv.slice(2))).then((value) => {
    if (value !== undefined) console.log(JSON.stringify(value, null, 2));
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
