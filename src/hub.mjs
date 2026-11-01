// Local hub server: pairing, durable queue, exact-address delivery and ACKs.
//
// Only one adapter connection per role is active at a time; a newer connection
// supersedes the older one so an adapter restart recovers cleanly. Messages are
// delivered only to a connected adapter of the target role and only after the
// target identity stays paired.
import net from 'node:net';
import { CLIENT_ID_RE, authenticateClientGrant, beginClientRequest, cancelClientRequest, getClientRequest, loadClientGrant, markClientRequestDelivered, markClientRequestQueued, markClientRequestUncertain, claimClientRequest, beginClientSubmit, recordClientOutcome, recordClientReply, resumeClientReply, expireStaleClientSubmissions, expireUnsubmittedClientRequests } from './client-access.mjs';
import { newMessageId } from './protocol.mjs';
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
  #targetBinding;
  #codeIdentity = null;
  #installationId = null;
  #instanceId = null;
  #protocolVersion = null;
  #ownerMode = null;
  #logger;
  #runtimeRoot = null;
  #clientConnections = new Set();
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
    this.#targetBinding = typeof options.targetBinding === 'function' ? options.targetBinding : null;
    this.#installationId = typeof options.installation?.installation_id === 'string' ? options.installation.installation_id : null;
    this.#instanceId = typeof options.installation?.instance_id === 'string' ? options.installation.instance_id : null;
    this.#protocolVersion = Number.isInteger(options.installation?.protocol_version) ? options.installation.protocol_version : null;
    this.#codeIdentity = options.codeIdentity ?? null;
    this.#ownerMode = typeof options.installation?.hub_owner_kind === 'string' ? options.installation.hub_owner_kind : null;
    this.#logger = options.logger ?? (() => {});
    this.#runtimeRoot = typeof options.runtimeRoot === 'string' ? options.runtimeRoot : null;
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
    if (client.role === 'client') {
      this.#handleClientFrame(client, frame);
      return;
    }
    switch (frame?.type) {
      case 'send':
        this.#handleSend(client, frame);
        break;
      case 'client-reply':
        this.#handleClientReply(client, frame);
        break;
      case 'client-request-claim':
      case 'client-claim':
        this.#handleClientRequestClaim(client, frame);
        break;
      case 'client-request-begin':
      case 'client-begin-submit':
        this.#handleClientRequestBegin(client, frame);
        break;
      case 'client-request-outcome':
      case 'client-outcome':
        this.#handleClientRequestOutcome(client, frame);
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
    if (frame.role === 'client') {
      if (!CLIENT_ID_RE.test(frame.identity)) {
        this.#failHandshake(client.socket, 'identity-invalid', 'client identity must be client:dot-<uuid>');
        return;
      }
      if (this.#runtimeRoot === null) {
        this.#failHandshake(client.socket, 'client-unavailable', 'client grants are not enabled for this Hub');
        return;
      }
      try {
        client.grant = authenticateClientGrant({
          runtimeDir: this.#runtimeRoot,
          grantId: frame.grant_id,
          clientIdentity: frame.identity,
          credential: frame.token,
        });
      } catch (error) {
        this.#log('hub/client-auth-rejected', { code: error?.code ?? 'client-auth-failed' });
        this.#failHandshake(client.socket, 'client-auth-failed', 'scoped client credential rejected');
        return;
      }
    } else if (!tokenEquals(frame.token, this.#token)) {
      this.#log('hub/auth-rejected', { role: frame.role });
      this.#failHandshake(client.socket, 'auth-failed', 'pairing token mismatch');
      return;
    }
    client.role = frame.role;
    client.identity = frame.identity;
    client.capabilities = frame.capabilities !== null && typeof frame.capabilities === 'object'
      ? { ...frame.capabilities } : {};
    client.authed = true;
    if (frame.role === 'client') {
      this.#clientConnections.add(client);
    } else if (frame.role === 'dsh' || frame.role === 'codex') {
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
      ...(frame.role === 'client' ? {
        role: 'client',
        grant_id: client.grant.grant_id,
        targets: client.grant.targets,
        mailbox: client.grant.mailbox,
        expires_at: client.grant.expires_at,
      } : {}),
      installation_id: this.#installationId,
      instance_id: this.#instanceId,
      protocol_version: this.#protocolVersion,
      owner_mode: this.#ownerMode,
      capabilities: {
        target_binding_epoch: this.#targetBinding !== null
          && this.#installationId !== null
          && this.#instanceId !== null,
        client_requests_v1: this.#runtimeRoot !== null,
      },
      server: {
        server_id: this.#store.serverId,
        started_at: this.#startedAt,
        installation_id: this.#installationId,
        instance_id: this.#instanceId,
        protocol_version: this.#protocolVersion,
        owner_mode: this.#ownerMode,
        code_identity: this.#codeIdentity,
        capabilities: {
          target_binding_epoch: this.#targetBinding !== null
            && this.#installationId !== null
            && this.#instanceId !== null,
          client_requests_v1: this.#runtimeRoot !== null,
        },
      },
      now: iso(Date.now()),
    });
    this.#log('hub/client-connected', { role: client.role, identity: client.identity });
    if (frame.role === 'dsh' || frame.role === 'codex') this.#deliverRole(frame.role);
  }

  #reject(client, requestId, code, message, extra = {}) {
    this.#send(client, { type: 'rejected', request_id: requestId, code, message, ...extra });
  }

  #clientReject(client, requestId, code, message, extra = {}) {
    this.#send(client, { type: 'client-rejected', request_id: requestId, code, message, ...extra });
  }

  #handleClientFrame(client, frame) {
    if (frame?.type === 'ping') {
      this.#send(client, { type: 'pong', request_id: frame.request_id, now: iso(Date.now()) });
      return;
    }
    if (!['client-request', 'client-status', 'client-resume', 'client-cancel'].includes(frame?.type)) {
      this.#clientReject(client, frame?.request_id, 'client-forbidden', `client cannot use frame type "${String(frame?.type)}"`);
      return;
    }
    let grant;
    try {
      grant = loadClientGrant({ runtimeDir: this.#runtimeRoot, grantId: client.grant.grant_id });
      client.grant = grant;
    } catch (error) {
      this.#clientReject(client, frame.request_id, error?.code ?? 'client-grant-invalid', String(error?.message ?? error));
      return;
    }
    if (frame.type === 'client-request') this.#handleClientRequest(client, frame, grant);
    else if (frame.type === 'client-status') this.#handleClientStatus(client, frame, grant);
    else if (frame.type === 'client-resume') this.#handleClientResume(client, frame, grant);
    else this.#handleClientCancel(client, frame, grant);
  }

  #handleClientRequest(client, frame, grant) {
    const requestId = frame.client_request_id;
    const target = frame.to;
    let requestCreated = false;
    try {
      if (!this.#store.listTargets().some((item) => item.identity === target && item.enabled === true)) {
        this.#clientReject(client, frame.request_id, 'client-target-unpaired', 'target must be an enabled paired target');
        return;
      }
      const started = beginClientRequest({
        runtimeDir: this.#runtimeRoot, grant, clientIdentity: client.identity,
        requestId, target, text: frame.text, ttlMs: frame.ttl_ms,
      });
      if (started.idempotent) {
        this.#send(client, { type: 'client-accepted', request_id: frame.request_id, client_request_id: requestId,
          msg_id: started.request.msg_id, state: started.request.state, idempotent: true, expires_at: started.request.expires_at });
        return;
      }
      requestCreated = true;
      const msgId = newMessageId();
      const ttlMs = Math.max(1_000, Math.min(
        Number.isSafeInteger(frame.ttl_ms) ? frame.ttl_ms : grant.ttl_ms,
        grant.ttl_ms,
        Math.max(1_000, Date.parse(started.request.expires_at) - Date.now()),
      ));
      let envelope = {
        v: 1, msg_id: msgId, from: client.identity, to: target, kind: 'text', text: frame.text,
        ttl_ms: ttlMs,
        meta: {
          source: 'client',
          client_request_id: requestId,
          client_identity: client.identity,
          client_grant_id: grant.grant_id,
          client_target: target,
          client_expires_at: started.request.expires_at,
          reply_to: client.identity,
        },
      };
      if (this.#targetBinding !== null) {
        const bound = this.#targetBinding(envelope);
        if (bound === null || typeof bound !== 'object' || bound.ok !== true) {
          const error = new Error(bound?.message ?? 'target binding could not be resolved');
          error.code = bound?.code ?? 'target-binding-failed';
          throw error;
        }
        envelope = bound.envelope;
      }
      const result = this.#store.enqueue(envelope);
      const queued = markClientRequestQueued({ runtimeDir: this.#runtimeRoot, clientIdentity: client.identity, requestId, msgId, targetBindingEpoch: envelope.meta?.target_binding_epoch ?? null });
      this.#send(client, { type: 'client-accepted', request_id: frame.request_id, client_request_id: requestId,
        msg_id: msgId, state: queued.request.state, idempotent: result.duplicate, expires_at: queued.request.expires_at });
      this.#log('client/request-queued', { request_id: requestId, msg_id: msgId, to: target });
      this.#deliverRole(identityRole(target));
    } catch (error) {
      // Only a request this call actually created may be moved to UNCERTAIN.
      // Authorization/scope/conflict rejections must not mutate an existing      // legal request owned by the same client identity.
      if (requestCreated === true) {
        try { markClientRequestUncertain({ runtimeDir: this.#runtimeRoot, clientIdentity: client.identity, requestId, code: error?.code ?? 'client-request-failed' }); } catch { /* best effort */ }
      }
      this.#clientReject(client, frame.request_id, error?.code ?? 'client-request-failed', String(error?.message ?? error));
    }
  }

  #handleClientStatus(client, frame, grant) {
    try {
      this.#expireClientRequests();
      const { request } = getClientRequest({ runtimeDir: this.#runtimeRoot, clientIdentity: client.identity, requestId: frame.client_request_id, grantId: grant.grant_id });
      this.#send(client, { type: 'client-status', request_id: frame.request_id, request });
    } catch (error) {
      this.#clientReject(client, frame.request_id, error?.code ?? 'client-status-failed', String(error?.message ?? error));
    }
  }

  #handleClientResume(client, frame, grant) {
    try {
      this.#expireClientRequests();
      const result = resumeClientReply({ runtimeDir: this.#runtimeRoot, clientIdentity: client.identity, requestId: frame.client_request_id, grantId: grant.grant_id });
      this.#send(client, { type: 'client-resume', request_id: frame.request_id, state: result.state, reply: result.reply });
    } catch (error) {
      this.#clientReject(client, frame.request_id, error?.code ?? 'client-resume-failed', String(error?.message ?? error));
    }
  }

  #handleClientCancel(client, frame, grant) {
    try {
      const result = cancelClientRequest({ runtimeDir: this.#runtimeRoot, clientIdentity: client.identity, requestId: frame.client_request_id, grantId: grant.grant_id });
      this.#send(client, { type: 'client-cancel', request_id: frame.request_id, request: result.request });
    } catch (error) {
      this.#clientReject(client, frame.request_id, error?.code ?? 'client-cancel-failed', String(error?.message ?? error));
    }
  }

  #clientControlAllowed(client, frame) {
    if (client.role === 'cli') return true;
    return client.role === 'dsh' && typeof frame?.target_identity === 'string' && frame.target_identity.startsWith('dsh:');
  }

  #handleClientReply(client, frame) {
    if (!this.#clientControlAllowed(client, frame)) {
      this.#reject(client, frame.request_id, 'forbidden', 'only the local operator/receiver or the owning DSH target may record a client reply');
      return;
    }
    try {
      const result = recordClientReply({
        runtimeDir: this.#runtimeRoot,
        clientIdentity: frame.client_identity,
        requestId: frame.client_request_id,
        targetIdentity: frame.target_identity,
        requestMsgId: frame.request_msg_id ?? frame.msg_id,
        turnId: frame.turn_id,
        body: frame.body,
        bodySha256: frame.body_sha256,
      });
      this.#send(client, { type: 'client-reply-result', request_id: frame.request_id, ok: true, idempotent: result.idempotent === true,
        request: { ...result.request, request_msg_id: result.request.msg_id }, reply: { reply_msg_id: result.reply.reply_msg_id, body_sha256: result.reply.body_sha256, bytes: result.reply.bytes, turn_id: result.reply.turn_id } });
      this.#log('client/reply-recorded', { request_id: frame.client_request_id, reply_msg_id: result.reply.reply_msg_id });
    } catch (error) {
      this.#send(client, { type: 'client-reply-result', request_id: frame.request_id, ok: false,
        code: error?.code ?? 'client-reply-failed', message: String(error?.message ?? error) });
    }
  }

  #finalizeClientNotSubmitted(request, reason) {
    const msgId = request?.msg_id;
    if (typeof msgId !== 'string' || msgId.length === 0) return { finalized: false, code: 'NO_REQUEST_MESSAGE' };
    const record = this.#store.getMessage(msgId);
    if (record === undefined) return { finalized: false, code: 'MESSAGE_MISSING' };
    if (record.state === STATES.FAILED || record.state === STATES.DELIVERED || record.state === STATES.EXPIRED) {
      return { finalized: false, code: `MESSAGE_${record.state.toUpperCase()}`, state: record.state };
    }
    try {
      this.#store.transition(msgId, STATES.FAILED, {
        last_error: 'client-not-submitted',
        client_outcome_reason: String(reason ?? 'native-not-submitted').slice(0, 200),
        next_attempt_at: null,
      });
    } catch (error) {
      this.#log('client/not-submitted-finalize-failed', { msg_id: msgId, code: error?.code ?? null });
      return { finalized: false, code: error?.code ?? 'TRANSITION_FAILED' };
    }
    const pending = this.#pending.get(msgId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.#pending.delete(msgId);
    }
    this.#log('client/not-submitted-finalized', { msg_id: msgId, reason: String(reason ?? '') });
    return { finalized: true, state: STATES.FAILED };
  }

  #verifyClientTargetAtSubmit(request) {
    if (!this.#store.isPairedTarget(request.target_identity)) {
      return { ok: false, code: 'client-begin-target-unpaired', message: 'target is no longer paired/enabled at the native submit boundary' };
    }
    if (this.#targetBinding !== null) {
      let bound;
      try {
        bound = this.#targetBinding({ v: 1, to: request.target_identity });
      } catch (error) {
        return { ok: false, code: error?.code ?? 'client-begin-target-binding-failed', message: String(error?.message ?? error) };
      }
      if (bound === null || typeof bound !== 'object' || bound.ok !== true) {
        return { ok: false, code: bound?.code ?? 'client-begin-target-binding-failed', message: bound?.message ?? 'target binding cannot be resolved at begin' };
      }
      const currentEpoch = bound.envelope?.meta?.target_binding_epoch ?? null;
      if (request.target_binding_epoch !== null && currentEpoch !== null
          && request.target_binding_epoch !== currentEpoch) {
        return { ok: false, code: 'client-begin-target-epoch-mismatch', message: 'target binding epoch changed since request' };
      }
    }
    return { ok: true };
  }
  #clientRpcView(request) {
    return {
      request_id: request.request_id,
      client_request_id: request.request_id,
      request_msg_id: request.msg_id,
      msg_id: request.msg_id,
      client_identity: request.client_identity,
      target_identity: request.target_identity,
      grant_id: request.grant_id,
      state: request.state,
      expires_at: request.expires_at,
      body_sha256: request.body_sha256,
      submitted_at: request.submitted_at ?? null,
      submission_deadline_at: request.submission_deadline_at ?? null,
      native_queue_id: request.native_queue_id ?? null,
      lease: request.claim ?? null,
    };
  }

  #handleClientRequestClaim(client, frame) {
    if (!this.#clientControlAllowed(client, frame)) {
      this.#reject(client, frame.request_id, 'forbidden', 'only the local operator/receiver or the owning DSH target may claim a client request');
      return;
    }
    const canonical = frame.type === 'client-claim';
    try {
      if (typeof frame.target_identity !== 'string' || !this.#store.isPairedTarget(frame.target_identity)) {
        const error = new Error('target must be a paired target');
        error.code = 'client-target-unpaired';
        throw error;
      }
      const result = claimClientRequest({
        runtimeDir: this.#runtimeRoot, clientIdentity: frame.client_identity, requestId: frame.client_request_id,
        targetIdentity: frame.target_identity, requestMsgId: frame.request_msg_id ?? frame.msg_id,
        leaseMs: Number.isSafeInteger(frame.claim_lease_ms) ? frame.claim_lease_ms : undefined,
        ownerIdentity: frame.owner_identity, receiverNonce: frame.receiver_nonce,
        bindingEpoch: frame.binding_epoch ?? null,
      });
      const view = this.#clientRpcView(result.request);
      const claim = result.request.claim;
      const lease = claim === null ? null : {
        id: claim.lease_id, fencing_token: claim.fencing_token,
        expires_at: claim.expires_at, owner_identity: claim.owner_identity,
      };
      if (canonical) {
        this.#send(client, { type: 'client-claim-result', request_id: frame.request_id, ok: true, request: view, lease });
      } else {
        this.#send(client, { type: 'client-request-claimed', request_id: frame.request_id,
          client_request_id: view.client_request_id, client_identity: view.client_identity,
          target_identity: view.target_identity, msg_id: view.msg_id,
          request_body_sha256: view.body_sha256, expires_at: view.expires_at,
          state: view.state, claim });
      }
    } catch (error) {
      if (canonical) {
        this.#send(client, { type: 'client-claim-result', request_id: frame.request_id, ok: false, code: error?.code ?? 'client-claim-failed', message: String(error?.message ?? error) });
      } else {
        this.#clientReject(client, frame.request_id, error?.code ?? 'client-claim-failed', String(error?.message ?? error));
      }
    }
  }

  #handleClientRequestBegin(client, frame) {
    if (!this.#clientControlAllowed(client, frame)) {
      this.#reject(client, frame.request_id, 'forbidden', 'only the local operator/receiver or the owning DSH target may begin a client request');
      return;
    }
    const canonical = frame.type === 'client-begin-submit';
    try {
      if (canonical && (typeof frame.request_msg_id !== 'string' || typeof frame.target_identity !== 'string')) {
        const error = new Error('request_msg_id and target_identity are required');
        error.code = 'client-begin-fields-required';
        throw error;
      }
      const stored = getClientRequest({ runtimeDir: this.#runtimeRoot, clientIdentity: frame.client_identity, requestId: frame.client_request_id });
      const targetCheck = this.#verifyClientTargetAtSubmit(stored.request);
      if (targetCheck.ok !== true) {
        const error = new Error(targetCheck.message ?? 'target binding failed at begin');
        error.code = targetCheck.code;
        throw error;
      }
      const result = beginClientSubmit({
        runtimeDir: this.#runtimeRoot, clientIdentity: frame.client_identity, requestId: frame.client_request_id,
        leaseId: frame.lease_id, fencingToken: frame.fencing_token,
        requestMsgId: frame.request_msg_id ?? frame.msg_id ?? null,
        targetIdentity: frame.target_identity ?? null,
        verifyTarget: (request) => this.#verifyClientTargetAtSubmit(request),
      });
      const view = this.#clientRpcView(result.request);
      const lease = result.request.claim === null ? null : {
        id: result.request.claim.lease_id, fencing_token: result.request.claim.fencing_token,
        expires_at: result.request.claim.expires_at, owner_identity: result.request.claim.owner_identity,
      };
      if (canonical) {
        this.#send(client, { type: 'client-begin-submit-result', request_id: frame.request_id, ok: true, request: view, lease });
      } else {
        this.#send(client, { type: 'client-request-begun', request_id: frame.request_id,
          client_request_id: view.client_request_id, client_identity: view.client_identity,
          target_identity: view.target_identity, msg_id: view.msg_id,
          state: view.state, submitted_at: view.submitted_at,
          lease_id: result.request.claim?.lease_id ?? null, fencing_token: result.request.claim?.fencing_token ?? null });
      }
    } catch (error) {
      if (canonical) {
        this.#send(client, { type: 'client-begin-submit-result', request_id: frame.request_id, ok: false, code: error?.code ?? 'client-begin-failed', message: String(error?.message ?? error) });
      } else {
        this.#clientReject(client, frame.request_id, error?.code ?? 'client-begin-failed', String(error?.message ?? error));
      }
    }
  }

  #handleClientRequestOutcome(client, frame) {
    if (!this.#clientControlAllowed(client, frame)) {
      this.#reject(client, frame.request_id, 'forbidden', 'only the local operator/receiver or the owning DSH target may report a client outcome');
      return;
    }
    const canonical = frame.type === 'client-outcome';
    try {
      if (canonical && (typeof frame.request_msg_id !== 'string' || typeof frame.target_identity !== 'string')) {
        const error = new Error('request_msg_id and target_identity are required');
        error.code = 'client-outcome-fields-required';
        throw error;
      }
      const result = recordClientOutcome({
        runtimeDir: this.#runtimeRoot, clientIdentity: frame.client_identity, requestId: frame.client_request_id,
        outcome: frame.status ?? frame.outcome, nativeQueueId: frame.native_queue_id ?? null,
        leaseId: frame.lease_id ?? null, fencingToken: frame.fencing_token ?? null, code: frame.reason ?? frame.code ?? null,
        requestMsgId: frame.request_msg_id ?? frame.msg_id ?? null, targetIdentity: frame.target_identity ?? null,
      });
      const view = this.#clientRpcView(result.request);
      const finalization = result.request.state === 'NOT_SUBMITTED'
        ? this.#finalizeClientNotSubmitted(result.request, frame.reason ?? frame.code)
        : null;
      if (canonical) {
        this.#send(client, { type: 'client-outcome-result', finalization, request_id: frame.request_id, ok: true, request: view, status: view.state });
      } else {
        this.#send(client, { type: 'client-request-outcome', request_id: frame.request_id, ok: true,
          client_request_id: view.client_request_id, state: view.state,
          native_queue_id: view.native_queue_id ?? null, native_outcome_at: result.request.native_outcome_at ?? null });
      }
      this.#log('client/request-outcome', { request_id: frame.client_request_id, state: result.request.state });
    } catch (error) {
      if (canonical) {
        this.#send(client, { type: 'client-outcome-result', request_id: frame.request_id, ok: false, code: error?.code ?? 'client-outcome-failed', message: String(error?.message ?? error) });
      } else {
        this.#clientReject(client, frame.request_id, error?.code ?? 'client-outcome-failed', String(error?.message ?? error));
      }
    }
  }

  #expireClientRequests() {
    let result;
    try { result = expireStaleClientSubmissions({ runtimeDir: this.#runtimeRoot, now: Date.now() }); }
    catch (error) { this.#log('client/submission-expiry-failed', { code: error?.code ?? null }); return; }
    for (const row of result.expired) {
      const record = this.#store.getMessage(row.msg_id);
      if (record === undefined) continue;
      if ([STATES.FAILED, STATES.DELIVERED, STATES.EXPIRED].includes(record.state)) continue;
      try {
        this.#store.transition(row.msg_id, STATES.FAILED, {
          last_error: 'client-submission-uncertain', client_outcome_reason: 'submission-outcome-timeout', next_attempt_at: null,
        });
      } catch { /* best effort */ }
      const pending = this.#pending.get(row.msg_id);
      if (pending !== undefined) { clearTimeout(pending.timer); this.#pending.delete(row.msg_id); }
      this.#log('client/submission-uncertain', { request_id: row.request_id, msg_id: row.msg_id });
    }
    let queuedExpiry;
    try { queuedExpiry = expireUnsubmittedClientRequests({ runtimeDir: this.#runtimeRoot, now: Date.now() }); }
    catch (error) { this.#log('client/request-expiry-failed', { code: error?.code ?? null }); return; }
    for (const row of queuedExpiry.expired) {
      const record = this.#store.getMessage(row.msg_id);
      if (record !== undefined && ![STATES.FAILED, STATES.DELIVERED, STATES.EXPIRED].includes(record.state)) {
        try { this.#store.transition(row.msg_id, STATES.EXPIRED, { last_error: 'client-request-expired', next_attempt_at: null }); } catch { /* best effort */ }
      }
      const pending = this.#pending.get(row.msg_id);
      if (pending !== undefined) { clearTimeout(pending.timer); this.#pending.delete(row.msg_id); }
      this.#log('client/request-expired', { request_id: row.request_id, msg_id: row.msg_id });
    }
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
    let envelope = validation.envelope;
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
    if (this.#targetBinding !== null) {
      let bound;
      try {
        bound = this.#targetBinding(envelope);
      } catch (error) {
        this.#reject(client, frame.request_id, error?.code ?? 'target-binding-failed', String(error?.message ?? error));
        return;
      }
      if (bound === null || typeof bound !== 'object' || bound.ok !== true) {
        this.#reject(client, frame.request_id, bound?.code ?? 'target-binding-failed', bound?.message ?? 'target binding could not be resolved');
        return;
      }
      envelope = bound.envelope;
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
      if (record.meta?.client_request_id && record.meta?.client_identity) {
        try { markClientRequestDelivered({ runtimeDir: this.#runtimeRoot, clientIdentity: record.meta.client_identity, requestId: record.meta.client_request_id }); }
        catch (error) { this.#log('client/request-state-write-failed', { request_id: record.meta.client_request_id, code: error?.code ?? null }); }
      }
      this.#log('message/delivered', { msg_id: msgId, to: record.to });
      return;
    }
    const code = typeof frame.code === 'string' && frame.code.length > 0 ? frame.code : 'delivery-failed';
    if (record.meta?.client_request_id && record.meta?.client_identity && frame.no_native === true && frame.retryable !== false) {
      const deferrals = (record.deferrals ?? 0) + 1;
      this.#store.transition(msgId, STATES.DELIVERY_UNKNOWN, {
        last_error: code, attempts: Math.max(1, record.attempts - 1), deferrals,
        next_attempt_at: iso(Date.now() + deferBackoffMs(deferrals)),
      });
      this.#log('client/request-deferred-before-native', { msg_id: msgId, code });
      return;
    }
    if (record.meta?.client_request_id && record.meta?.client_identity) {
      // Scoped client requests are one-shot: a failed/ambiguous delivery is
      // UNCERTAIN and is never automatically resubmitted.
      this.#store.transition(msgId, STATES.FAILED, { last_error: code });
      try { markClientRequestUncertain({ runtimeDir: this.#runtimeRoot, clientIdentity: record.meta.client_identity, requestId: record.meta.client_request_id, code }); }
      catch (error) { this.#log('client/request-state-write-failed', { request_id: record.meta.client_request_id, code: error?.code ?? null }); }
      this.#log('client/request-uncertain', { msg_id: msgId, code });
      return;
    }
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
      // A restricted client request must be claimed/target-pulled by the
      // receiver, never role-pushed to a legacy codex adapter. The old
      // DSH->Codex role-delivery path remains unchanged.
      // A restricted client request may only be role-pushed to a DSH adapter
      // that negotiated the client gate. Old adapters keep receiving legacy
      // DSH traffic, but new client work stays queued until a capable plugin
      // connects and target-pulls it.
      if (role === 'dsh' && message.from_role === 'client' && client.capabilities?.client_requests_v1 !== true) continue;
      if (role === 'codex' && message.from_role === 'client') continue;
      if (this.#pending.has(message.msg_id)) continue;
      if (message.next_attempt_at !== null && message.next_attempt_at !== undefined && Date.parse(message.next_attempt_at) > now) continue;
      if (message.attempts >= this.#maxAttempts) {
        this.#store.transition(message.msg_id, STATES.FAILED, { last_error: 'delivery-attempts-exhausted' });
        if (message.meta?.client_request_id && message.meta?.client_identity) {
          try { markClientRequestUncertain({ runtimeDir: this.#runtimeRoot, clientIdentity: message.meta.client_identity, requestId: message.meta.client_request_id, code: 'delivery-attempts-exhausted' }); }
          catch { /* best effort */ }
        }
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
    if (record.meta?.client_request_id && record.meta?.client_identity) {
      this.#store.transition(msgId, STATES.FAILED, { last_error: 'client-ack-timeout' });
      try { markClientRequestUncertain({ runtimeDir: this.#runtimeRoot, clientIdentity: record.meta.client_identity, requestId: record.meta.client_request_id, code: 'client-ack-timeout' }); }
      catch (error) { this.#log('client/request-state-write-failed', { request_id: record.meta.client_request_id, code: error?.code ?? null }); }
      this.#log('client/request-uncertain', { msg_id: msgId, code: 'client-ack-timeout' });
      return;
    }
    this.#store.transition(msgId, STATES.DELIVERY_UNKNOWN, {
      last_error: 'ack-timeout',
      next_attempt_at: iso(Date.now() + backoffMs(record.attempts)),
    });
    this.#log('message/delivery-unknown', { msg_id: msgId, code: 'ack-timeout', attempts: record.attempts });
  }

  #onClose(client) {
    clearTimeout(client.authTimer);
    this.#connections.delete(client);
    this.#clientConnections.delete(client);
    if (client.role !== undefined && (client.role === 'dsh' || client.role === 'codex') && this.#clients.get(client.role) === client) {
      this.#clients.delete(client.role);
      this.#log('hub/client-disconnected', { role: client.role, identity: client.identity });
      for (const [msgId, pending] of [...this.#pending.entries()]) {
        if (pending.role !== client.role) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(msgId);
        const record = this.#store.getMessage(msgId);
        if (record === undefined || record.state !== STATES.DELIVERING) continue;
        if (record.meta?.client_request_id && record.meta?.client_identity) {
          try {
            this.#store.transition(msgId, STATES.FAILED, { last_error: 'adapter-disconnected' });
            markClientRequestUncertain({ runtimeDir: this.#runtimeRoot, clientIdentity: record.meta.client_identity, requestId: record.meta.client_request_id, code: 'adapter-disconnected' });
          } catch { /* another transition already settled it */ }
          continue;
        }
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
    this.#expireClientRequests();
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
