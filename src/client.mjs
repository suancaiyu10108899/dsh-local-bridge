// Hub client used by the CLI and the host adapters.
// One TCP connection, length-prefixed JSON frames, request/response correlation
// plus a delivery callback for adapter connections.
import net from 'node:net';
import { createFrameDecoder, encodeFrame } from './protocol.mjs';

export class HubClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HubClientError';
    this.code = code;
    this.details = details;
  }
}

export class HubClient {
  #host;
  #port;
  #token;
  #role;
  #identity;
  #logger;
  #socket = null;
  #decoder = createFrameDecoder();
  #nextRequestId = 1;
  #pending = new Map();
  #deliveryHandler = null;
  #frameHandlers = new Map();
  #closeHandlers = new Set();
  #welcome = null;
  #welcomeWaiter = null;
  #closed = false;

  constructor(options) {
    this.#host = options.host ?? '127.0.0.1';
    this.#port = options.port;
    this.#token = options.token;
    this.#role = options.role;
    this.#identity = options.identity;
    this.#logger = options.logger ?? (() => {});
  }

  get identity() {
    return this.#identity;
  }

  get role() {
    return this.#role;
  }

  get welcome() {
    return this.#welcome;
  }

  get closed() {
    return this.#closed;
  }

  /** Connect, authenticate with the pairing token, resolve once welcomed. */
  async connect({ timeoutMs = 5_000 } = {}) {
    if (this.#socket !== null) throw new HubClientError('already-connected', 'client is already connected');
    const socket = net.createConnection({ host: this.#host, port: this.#port });
    this.#socket = socket;
    socket.setNoDelay(true);
    const welcome = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new HubClientError('welcome-timeout', `hub did not welcome us within ${timeoutMs}ms`));
        socket.destroy();
      }, timeoutMs);
      timer.unref?.();
      this.#welcomeWaiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => {
      this.#failAll(new HubClientError('connection-error', String(error)));
      this.#welcomeWaiter?.reject(new HubClientError('connection-error', String(error)));
      this.#welcomeWaiter = null;
    });
    socket.on('close', () => {
      this.#closed = true;
      this.#failAll(new HubClientError('connection-closed', 'hub connection closed'));
      this.#welcomeWaiter?.reject(new HubClientError('connection-closed', 'hub connection closed before welcome'));
      this.#welcomeWaiter = null;
      for (const handler of this.#closeHandlers) {
        try {
          handler();
        } catch {
          /* a close observer must not break the others */
        }
      }
    });
    const connected = new Promise((resolve, reject) => {
      const onConnect = () => {
        socket.off('error', onError);
        socket.write(encodeFrame({
          type: 'hello',
          v: 1,
          role: this.#role,
          identity: this.#identity,
          token: this.#token,
        }));
        resolve();
      };
      const onError = (error) => {
        socket.off('connect', onConnect);
        reject(new HubClientError('connect-failed', `cannot reach hub at ${this.#host}:${this.#port}: ${error.code ?? error.message}`));
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
    // Observe both phases immediately: a socket error rejects both, and waiting
    // for TCP first would leave the welcome rejection orphaned on failure.
    const [, response] = await Promise.all([connected, welcome]);
    return response;
  }

  #onData(chunk) {
    let frames;
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      this.#failAll(new HubClientError(error.code ?? 'frame-invalid', error.message));
      this.#socket?.destroy();
      return;
    }
    for (const frame of frames) this.#onFrame(frame);
  }

  #onFrame(frame) {
    if (frame?.type === 'welcome') {
      this.#welcome = frame;
      this.#welcomeWaiter?.resolve(frame);
      this.#welcomeWaiter = null;
      return;
    }
    if (frame?.type === 'error' && frame.code === 'auth-failed') {
      this.#welcomeWaiter?.reject(new HubClientError('auth-failed', frame.message ?? 'pairing token rejected'));
      this.#welcomeWaiter = null;
      return;
    }
    if (frame?.type === 'deliver') {
      this.#deliveryHandler?.(frame.message, {
        ack: (result) => this.ack(frame.message.msg_id, result),
      });
      return;
    }
    const requestId = frame?.request_id;
    if (typeof requestId === 'string' && this.#pending.has(requestId)) {
      const pending = this.#pending.get(requestId);
      this.#pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(frame);
      return;
    }
    const handler = this.#frameHandlers.get(frame?.type);
    if (handler !== undefined) {
      handler(frame);
      return;
    }
    this.#logger('client/unmatched-frame', { type: frame?.type });
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  /** Register the adapter delivery callback. */
  onDelivery(handler) {
    this.#deliveryHandler = handler;
  }

  onFrame(type, handler) {
    this.#frameHandlers.set(type, handler);
  }

  /** Observe connection loss (called once per established or failed socket). */
  onClose(handler) {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  /** Send one request frame and wait for its correlated response. */
  request(frame, { timeoutMs = 10_000 } = {}) {
    const requestId = `r-${this.#nextRequestId++}`;
    const value = { ...frame, request_id: requestId };
    return new Promise((resolve, reject) => {
      if (this.#socket === null || this.#socket.destroyed) {
        reject(new HubClientError('not-connected', 'client is not connected'));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new HubClientError('request-timeout', `no response to ${frame.type} within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(requestId, { resolve, reject, timer });
      this.#socket.write(encodeFrame(value));
    });
  }

  async sendMessage(envelope, options = {}) {
    const response = await this.request({ type: 'send', message: envelope }, options);
    if (response.type === 'rejected') throw new HubClientError(response.code ?? 'send-rejected', response.message ?? 'message rejected', response);
    return response;
  }

  async status(msgId, options = {}) {
    const response = await this.request({ type: 'status-query', msg_id: msgId }, options);
    if (response.type === 'status-missing') return undefined;
    return response.message;
  }

  async statusList(filter = {}, options = {}) {
    const response = await this.request({ type: 'status-query', filter }, options);
    return response.messages ?? [];
  }

  async targets(options = {}) {
    const response = await this.request({ type: 'targets-query' }, options);
    return response.targets ?? [];
  }

  /** Connected adapter roles (dsh / codex). */
  async roles(options = {}) {
    const response = await this.request({ type: 'roles-query' }, options);
    return response.roles ?? [];
  }

  async pairAdd(identity, { label = '', host = '' } = {}, options = {}) {
    const response = await this.request({ type: 'pair-add', identity, label, host }, options);
    if (response.ok !== true) throw new HubClientError(response.code ?? 'pair-failed', response.message ?? 'pairing failed', response);
    return response.target;
  }

  async pairRemove(identity, options = {}) {
    const response = await this.request({ type: 'pair-remove', identity }, options);
    return response.ok === true;
  }

  /** Record an active-end consumer (role without a connected adapter). */
  async consume(msgId, { consumer = 'cli:operator', note = '' } = {}, options = {}) {
    const response = await this.request({ type: 'consume', msg_id: msgId, consumer, note }, options);
    if (response.ok !== true) throw new HubClientError(response.code ?? 'consume-failed', response.message ?? 'consume failed', response);
    return response.message;
  }

  /** Confirm one inbound delivery. */
  ack(msgId, { ok, code, detail, retryable } = {}) {
    if (this.#socket === null || this.#socket.destroyed) return;
    this.#socket.write(encodeFrame({ type: 'ack', msg_id: msgId, ok: ok !== false, code, detail, retryable }));
  }

  async close() {
    if (this.#socket !== null) {
      this.#socket.destroy();
      this.#socket = null;
    }
  }
}

/** One-shot CLI connection: connect, run a callback, always close. */
export async function withHubClient(options, run) {
  const client = new HubClient(options);
  try {
    await client.connect({ timeoutMs: options.connectTimeoutMs ?? 5_000 });
    return await run(client);
  } finally {
    await client.close();
  }
}
