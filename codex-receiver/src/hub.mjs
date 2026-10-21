// Local hub server: pairing, durable queue, exact-address delivery and ACKs.
//
// Only one adapter connection per role is active at a time; a newer connection
// supersedes the older one so an adapter restart recovers cleanly. Messages are
// delivered only to a connected adapter of the target role and only after the
// target identity stays paired.
import net from 'node:net';
import {
  ROLES,
  STATES,
  createFrameDecoder,
  encodeFrame,
  identityRole,
  isValidIdentity,
  tokenEquals,
  validateEnvelope,
} from './protocol.mjs';

const HELLO_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 32;
const PUMP_INTERVAL_MS = 2_000;

function iso(ms) {
  return new Date(ms).toISOString();
}

function backoffMs(attempts) {
  return Math.min(2_000 * Math.max(attempts, 1), 30_000);
}

/** Deferral backoff for a session that is not live yet (cold session). */
function deferBackoffMs(deferrals) {
  return Math.min(2_000 * 2 ** Math.max(deferrals - 1, 0), 30_000);
}

export class BridgeHub {
  #store;
  #token;
  #host;
  #port;
  #ackTimeoutMs;
  #maxAttempts;
  #logger;
  #server = null;
  #startedAt = null;
  #clients = new Map(); // role -> connection
  #connections = new Set();
  #pending = new Map(); // msg_id -> { role, timer }
  #pump = null;
  #stopping = false;

  constructor(options) {
    this.#store = options.store;
    this.#token = options.token;
    this.#host = options.host ?? '127.0.0.1';
    this.#port = options.port ?? 0;
    this.#ackTimeoutMs = options.ackTimeoutMs ?? 10_000;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#logger = options.logger ?? (() => {});
  }

  get port() {
    const address = this.#server?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  get startedAt() {
    return this.#startedAt;
  }

  get connections() {
    return this.#clients.size;
  }

  async start() {
    this.#startedAt = iso(Date.now());
    this.#server = net.createServer((socket) => this.#onConnection(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.#server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off('error', onError);
        resolve();
      };
      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen(this.#port, this.#host);
    });
    this.#pump = setInterval(() => this.#tick(), PUMP_INTERVAL_MS);
    this.#pump.unref?.();
    this.#tick();
    const address = this.#server.address();
    this.#logger('hub/listening', { address: `${this.#host}:${address.port}`, server_id: this.#store.serverId });
    return { port: address.port, address: `${this.#host}:${address.port}` };
  }

  async stop() {
    this.#stopping = true;
    if (this.#pump !== null) clearInterval(this.#pump);
    this.#pump = null;
    for (const { timer } of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
    for (const client of this.#connections) {
      clearTimeout(client.authTimer);
      client.socket.destroy();
    }
    this.#clients.clear();
    this.#connections.clear();
    if (this.#server !== null) {
      await new Promise((resolve) => this.#server.close(() => resolve()));
      this.#server = null;
    }
  }

  #log(event, detail) {
    try {
      this.#logger(event, detail);
    } catch {
      /* logging must not affect delivery */
    }
  }

  #onConnection(socket) {
    if (this.#connections.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    const client = {
      socket,
      decoder: createFrameDecoder(),
      role: undefined,
      identity: undefined,
      authed: false,
      authTimer: setTimeout(() => this.#failHandshake(socket, 'hello-timeout', 'hello frame not received in time'), HELLO_TIMEOUT_MS),
    };
    client.authTimer.unref?.();
    this.#connections.add(client);
    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = client.decoder.push(chunk);
      } catch (error) {
        this.#failHandshake(socket, error.code ?? 'frame-invalid', error.message);
        return;
      }
      for (const frame of frames) {
        try {
          this.#onFrame(client, frame);
        } catch (error) {
          this.#send(client, { type: 'error', code: error.code ?? 'internal', message: error.message });
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.#onClose(client));
  }

  #failHandshake(socket, code, message) {
    try {
      socket.write(encodeFrame({ type: 'error', code, message }));
    } catch {
      /* peer may be gone */
    }
    socket.destroy();
  }

  #send(client, value) {
    if (client.socket.destroyed || !client.socket.writable) return false;
    try {
      client.socket.write(encodeFrame(value));
      return true;
    } catch {
      return false;
    }
  }

  #onFrame(client, frame) {
    if (!client.authed) {
      this.#handleHello(client, frame);
      return;
    }
    switch (frame?.type) {
      case 'send':
        this.#handleSend(client, frame);
        break;
      case 'ack':
        this.#handleAck(client, frame);
        break;
      case 'status-query':
        this.#handleStatusQuery(client, frame);
        break;
      case 'targets-query':
        this.#send(client, { type: 'targets', request_id: frame.request_id, targets: this.#store.listTargets() });
        break;
      case 'roles-query':
        this.#send(client, { type: 'roles', request_id: frame.request_id, roles: this.connectedRoles() });
        break;
      case 'pair-add':
        this.#handlePairAdd(client, frame);
        break;
      case 'pair-remove':
        this.#handlePairRemove(client, frame);
        break;
      case 'consume':
        this.#handleConsume(client, frame);
        break;
      case 'ping':
        this.#send(client, { type: 'pong', request_id: frame.request_id, now: iso(Date.now()) });
        break;
      default:
        this.#send(client, { type: 'error', code: 'frame-unsupported', message: `unsupported frame type "${String(frame?.type)}"` });
    }
  }

  #handleHello(client, frame) {
    clearTimeout(client.authTimer);
    if (frame?.type !== 'hello') {
      this.#failHandshake(client.socket, 'hello-required', 'first frame must be hello');
      return;
    }
    if (frame.v !== 1) {
      this.#failHandshake(client.socket, 'version-unsupported', 'hello.v must be 1');
      return;
    }
    if (!ROLES.includes(frame.role)) {
      this.#failHandshake(client.socket, 'role-invalid', `role must be one of ${ROLES.join(', ')}`);
      return;
    }
    if (!isValidIdentity(frame.identity) || identityRole(frame.identity) !== frame.role) {
      this.#failHandshake(client.socket, 'identity-invalid', 'identity must match role:id for the declared role');
      return;
    }
    if (!tokenEquals(frame.token, this.#token)) {
      this.#log('hub/auth-rejected', { role: frame.role });
      this.#failHandshake(client.socket, 'auth-failed', 'pairing token mismatch');
      return;
    }
    client.role = frame.role;
    client.identity = frame.identity;
    client.authed = true;
    if (frame.role === 'dsh' || frame.role === 'codex') {
      const previous = this.#clients.get(frame.role);
      if (previous !== undefined && previous !== client) {
        this.#log('hub/adapter-superseded', { role: frame.role, previous: previous.identity, next: client.identity });
        this.#send(previous, { type: 'error', code: 'adapter-superseded', message: `${frame.role} adapter replaced by a newer connection` });
        previous.socket.destroy();
      }
      this.#clients.set(frame.role, client);
    }
    this.#send(client, {
      type: 'welcome',
      ok: true,
      identity: client.identity,
      server: { server_id: this.#store.serverId, started_at: this.#startedAt },
      now: iso(Date.now()),
    });
    this.#log('hub/client-connected', { role: client.role, identity: client.identity });
    if (frame.role === 'dsh' || frame.role === 'codex') this.#deliverRole(frame.role);
  }

  #reject(client, requestId, code, message, extra = {}) {
    this.#send(client, { type: 'rejected', request_id: requestId, code, message, ...extra });
  }

  #handleSend(client, frame) {
    const candidate = frame.message ?? {
      v: frame.v,
      msg_id: frame.msg_id,
      from: frame.from,
      to: frame.to,
      kind: frame.kind,
      text: frame.text,
      ttl_ms: frame.ttl_ms,
      meta: frame.meta,
    };
    const validation = validateEnvelope(candidate);
    if (!validation.ok) {
      this.#reject(client, frame.request_id, validation.code, validation.message);
      return;
    }
    const envelope = validation.envelope;
    if (identityRole(envelope.from) !== client.role) {
      this.#reject(client, frame.request_id, 'source-role-mismatch', `client role ${client.role} cannot send as ${envelope.from}`);
      return;
    }
    if (envelope.from === envelope.to) {
      this.#reject(client, frame.request_id, 'self-target', 'sender and target are the same identity');
      return;
    }
    if (client.role !== 'cli' && !this.#store.isPairedTarget(envelope.from)) {
      this.#reject(client, frame.request_id, 'source-unpaired', `sender ${envelope.from} is not a paired target`);
      return;
    }
    if (!this.#store.isPairedTarget(envelope.to)) {
      this.#reject(client, frame.request_id, 'target-unpaired', `target ${envelope.to} is not paired/enabled`);
      return;
    }
    let result;
    try {
      result = this.#store.enqueue(envelope);
    } catch (error) {
      this.#reject(client, frame.request_id, error.code ?? 'enqueue-failed', error.message);
      return;
    }
    if (result.conflict === true) {
      this.#reject(client, frame.request_id, 'msg-id-conflict', 'msg_id already exists with different content', { msg_id: envelope.msg_id });
      return;
    }
    this.#send(client, {
      type: 'accepted',
      request_id: frame.request_id,
      msg_id: result.record.msg_id,
      state: result.record.state,
      duplicate: result.duplicate,
    });
    this.#log(result.duplicate ? 'message/duplicate' : 'message/accepted', { msg_id: result.record.msg_id, from: result.record.from, to: result.record.to });
    if (!result.duplicate) this.#deliverRole(result.record.to_role);
  }

  #handleAck(client, frame) {
    const msgId = frame?.msg_id;
    if (typeof msgId !== 'string' || msgId.length === 0) {
      this.#send(client, { type: 'error', code: 'ack-invalid', message: 'ack requires msg_id' });
      return;
    }
    const pending = this.#pending.get(msgId);
    if (pending === undefined || pending.role !== client.role) {
      this.#send(client, { type: 'error', code: 'ack-unexpected', message: `no delivery in flight for ${msgId}` });
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(msgId);
    const record = this.#store.getMessage(msgId);
    if (record === undefined || record.state !== STATES.DELIVERING) return;
    if (frame.ok === true) {
      this.#store.transition(msgId, STATES.DELIVERED, { delivered_at: iso(Date.now()) });
      this.#log('message/delivered', { msg_id: msgId, to: record.to });
      return;
    }
    const code = typeof frame.code === 'string' && frame.code.length > 0 ? frame.code : 'delivery-failed';
    const retryable = frame.retryable !== false;
    if (retryable && code === 'session-not-live') {
      // A cold (not yet loaded) session is a deferral, not a failed delivery:
      // keep the message queued without consuming the bounded attempt budget so
      // it can be delivered as soon as the host attaches that session.
      const deferrals = (record.deferrals ?? 0) + 1;
      this.#store.transition(msgId, STATES.DELIVERY_UNKNOWN, {
        last_error: code,
        attempts: Math.max(1, record.attempts - 1),
        deferrals,
        next_attempt_at: iso(Date.now() + deferBackoffMs(deferrals)),
      });
      this.#log('message/deferred-session-not-live', { msg_id: msgId, deferrals, attempts: record.attempts });
      return;
    }
    if (retryable && record.attempts < this.#maxAttempts) {
      this.#store.transition(msgId, STATES.DELIVERY_UNKNOWN, {
        last_error: code,
        next_attempt_at: iso(Date.now() + backoffMs(record.attempts)),
      });
      this.#log('message/delivery-unknown', { msg_id: msgId, code, attempts: record.attempts });
    } else {
      this.#store.transition(msgId, STATES.FAILED, { last_error: code });
      this.#log('message/failed', { msg_id: msgId, code });
    }
  }

  #handleStatusQuery(client, frame) {
    if (typeof frame.msg_id === 'string') {
      const record = this.#store.getMessage(frame.msg_id);
      if (record === undefined) {
        this.#send(client, { type: 'status-missing', request_id: frame.request_id, msg_id: frame.msg_id });
        return;
      }
      this.#send(client, { type: 'status', request_id: frame.request_id, message: record });
      return;
    }
    const filter = frame.filter ?? {};
    const messages = this.#store.listMessages({
      to: filter.to,
      from: filter.from,
      state: filter.state,
      limit: Number.isSafeInteger(filter.limit) ? Math.min(filter.limit, 500) : 50,
    });
    this.#send(client, { type: 'status-list', request_id: frame.request_id, messages });
  }

  #handlePairAdd(client, frame) {
    if (client.role !== 'cli') {
      this.#send(client, { type: 'error', request_id: frame.request_id, code: 'forbidden', message: 'only the cli role may change pairing' });
      return;
    }
    try {
      const target = this.#store.addTarget(frame.identity, { label: frame.label, host: frame.host, enabled: frame.enabled !== false });
      this.#send(client, { type: 'pair-result', request_id: frame.request_id, ok: true, target });
      this.#deliverRole(target.role);
    } catch (error) {
      this.#send(client, { type: 'pair-result', request_id: frame.request_id, ok: false, code: error.code ?? 'pair-failed', message: error.message });
    }
  }

  #handlePairRemove(client, frame) {
    if (client.role !== 'cli') {
      this.#send(client, { type: 'error', request_id: frame.request_id, code: 'forbidden', message: 'only the cli role may change pairing' });
      return;
    }
    const removed = this.#store.removeTarget(frame.identity);
    this.#send(client, { type: 'pair-result', request_id: frame.request_id, ok: removed });
  }

  /**
   * Operator/active-consumer acknowledgement for a role with no connected
   * adapter (v1 Codex side): records who took responsibility for delivery.
   */
  #handleConsume(client, frame) {
    if (client.role !== 'cli') {
      this.#send(client, { type: 'error', request_id: frame.request_id, code: 'forbidden', message: 'only the cli role may consume messages' });
      return;
    }
    const msgId = frame.msg_id;
    const record = typeof msgId === 'string' ? this.#store.getMessage(msgId) : undefined;
    if (record === undefined) {
      this.#send(client, { type: 'consume-result', request_id: frame.request_id, ok: false, code: 'message-not-found', message: `unknown message "${String(msgId)}"` });
      return;
    }
    if (record.to_role === 'dsh' || record.to_role === 'codex') {
      if (this.#clients.has(record.to_role)) {
        this.#send(client, { type: 'consume-result', request_id: frame.request_id, ok: false, code: 'adapter-connected', message: `${record.to_role} adapter is connected and delivers automatically; consume is only for consumer-managed roles` });
        return;
      }
    }
    if (this.#pending.has(msgId)) {
      this.#send(client, { type: 'consume-result', request_id: frame.request_id, ok: false, code: 'delivery-in-flight', message: `message ${msgId} is currently being delivered` });
      return;
    }
    try {
      const updated = this.#store.consume(msgId, {
        consumer: typeof frame.consumer === 'string' ? frame.consumer : 'cli:operator',
        note: typeof frame.note === 'string' ? frame.note : '',
      });
      this.#send(client, { type: 'consume-result', request_id: frame.request_id, ok: true, message: updated });
    } catch (error) {
      this.#send(client, { type: 'consume-result', request_id: frame.request_id, ok: false, code: error.code ?? 'consume-failed', message: error.message });
    }
  }

  #deliverRole(role) {
    if (role !== 'dsh' && role !== 'codex') return;
    const client = this.#clients.get(role);
    if (client === undefined || !client.authed) return;
    const now = Date.now();
    for (const message of this.#store.deliverableForRole(role)) {
      if (this.#pending.has(message.msg_id)) continue;
      if (message.next_attempt_at !== null && message.next_attempt_at !== undefined && Date.parse(message.next_attempt_at) > now) continue;
      if (message.attempts >= this.#maxAttempts) {
        this.#store.transition(message.msg_id, STATES.FAILED, { last_error: 'delivery-attempts-exhausted' });
        continue;
      }
      let updated;
      try {
        this.#store.transition(message.msg_id, STATES.DELIVERING, {
          attempts: message.attempts + 1,
          last_attempt_at: iso(now),
          next_attempt_at: null,
        });
        updated = this.#store.getMessage(message.msg_id);
      } catch {
        continue;
      }
      this.#send(client, { type: 'deliver', message: updated });
      const timer = setTimeout(() => this.#onAckTimeout(role, message.msg_id), this.#ackTimeoutMs);
      timer.unref?.();
      this.#pending.set(message.msg_id, { role, timer });
      this.#log('message/delivery-attempt', { msg_id: message.msg_id, to: message.to, attempts: updated.attempts });
    }
  }

  #onAckTimeout(role, msgId) {
    this.#pending.delete(msgId);
    if (this.#stopping) return;
    const record = this.#store.getMessage(msgId);
    if (record === undefined || record.state !== STATES.DELIVERING) return;
    this.#store.transition(msgId, STATES.DELIVERY_UNKNOWN, {
      last_error: 'ack-timeout',
      next_attempt_at: iso(Date.now() + backoffMs(record.attempts)),
    });
    this.#log('message/delivery-unknown', { msg_id: msgId, code: 'ack-timeout', attempts: record.attempts });
  }

  #onClose(client) {
    clearTimeout(client.authTimer);
    this.#connections.delete(client);
    if (client.role !== undefined && (client.role === 'dsh' || client.role === 'codex') && this.#clients.get(client.role) === client) {
      this.#clients.delete(client.role);
      this.#log('hub/client-disconnected', { role: client.role, identity: client.identity });
      for (const [msgId, pending] of [...this.#pending.entries()]) {
        if (pending.role !== client.role) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(msgId);
        const record = this.#store.getMessage(msgId);
        if (record === undefined || record.state !== STATES.DELIVERING) continue;
        try {
          this.#store.transition(msgId, STATES.DELIVERY_UNKNOWN, {
            last_error: 'adapter-disconnected',
            next_attempt_at: iso(Date.now() + backoffMs(record.attempts)),
          });
        } catch {
          /* another transition already settled it */
        }
      }
    }
  }

  #tick() {
    if (this.#stopping) return;
    try {
      this.#store.sweep();
    } catch (error) {
      this.#log('hub/sweep-error', { message: String(error) });
    }
    for (const role of ['dsh', 'codex']) this.#deliverRole(role);
  }

  /** Test/inspection helper: current in-flight delivery count. */
  get pendingDeliveries() {
    return this.#pending.size;
  }

  /** Test/inspection helper: connected adapter roles. */
  connectedRoles() {
    return [...this.#clients.keys()];
  }
}
