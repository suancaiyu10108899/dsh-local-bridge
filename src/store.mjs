// Durable hub state: pairing targets, message records, delivery attempts.
// One JSON snapshot (atomic replace) plus an append-only audit log.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATES, canTransition, identityRole } from './protocol.mjs';
import { writeJsonAtomic } from './runtime.mjs';

const RETRYABLE_STATES = new Set([STATES.QUEUED, STATES.DELIVERY_UNKNOWN]);

export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.details = details;
  }
}

export class HubStore {
  #stateFile;
  #eventsFile;
  #now;
  #maxTerminal;
  #maxMessages;
  #state;

  constructor(options) {
    this.#stateFile = options.stateFile;
    this.#eventsFile = options.eventsFile;
    this.#now = options.now ?? (() => Date.now());
    this.#maxTerminal = options.maxTerminalRecords ?? 2_000;
    this.#maxMessages = options.maxMessages ?? 10_000;
    this.#state = null;
  }

  get stateFile() {
    return this.#stateFile;
  }

  get serverId() {
    return this.#state.server_id;
  }

  load() {
    fs.mkdirSync(path.dirname(this.#stateFile), { recursive: true });
    if (fs.existsSync(this.#stateFile)) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(this.#stateFile, 'utf8'));
      } catch (error) {
        throw new StoreError('state-corrupt', `hub state file is unreadable: ${this.#stateFile}`, { cause: String(error) });
      }
      if (parsed?.v !== 1 || typeof parsed.messages !== 'object' || !Array.isArray(parsed.order)) {
        throw new StoreError('state-unsupported', `hub state file has an unsupported shape: ${this.#stateFile}`);
      }
      this.#state = parsed;
    } else {
      this.#state = {
        v: 1,
        server_id: `hub-${crypto.randomUUID()}`,
        created_at: new Date(this.#now()).toISOString(),
        seq: 0,
        messages: {},
        order: [],
        targets: {},
      };
      this.#save();
      this.#event('hub/state-created', {});
    }
    this.#refreshServerId();
    return this;
  }

  #refreshServerId() {
    if (typeof this.#state.server_id !== 'string' || this.#state.server_id.length === 0) {
      this.#state.server_id = `hub-${crypto.randomUUID()}`;
    }
  }

  #save() {
    writeJsonAtomic(this.#stateFile, this.#state);
  }

  #assertLoaded() {
    if (this.#state === null) throw new StoreError('state-not-loaded', 'HubStore.load() must run first');
  }

  #event(type, detail) {
    try {
      fs.appendFileSync(this.#eventsFile, `${JSON.stringify({ ts: new Date(this.#now()).toISOString(), type, ...detail })}\n`, 'utf8');
    } catch {
      /* audit log failure must not break delivery; state snapshot is authoritative */
    }
  }

  /** Record a pairing target (session/thread/operator identity). */
  addTarget(identity, { label = '', host = '', enabled = true } = {}) {
    this.#assertLoaded();
    const role = identityRole(identity);
    if (role === undefined || role === 'cli') {
      throw new StoreError('target-invalid', `cannot pair identity "${identity}"`);
    }
    const existing = this.#state.targets[identity];
    this.#state.targets[identity] = {
      identity,
      role,
      label: label || existing?.label || '',
      host: host || existing?.host || '',
      enabled,
      added_at: existing?.added_at ?? new Date(this.#now()).toISOString(),
      updated_at: new Date(this.#now()).toISOString(),
    };
    this.#save();
    this.#event('pairing/added', { identity, role, enabled });
    return this.#state.targets[identity];
  }

  removeTarget(identity) {
    this.#assertLoaded();
    const existing = this.#state.targets[identity];
    if (existing === undefined) return false;
    existing.enabled = false;
    existing.updated_at = new Date(this.#now()).toISOString();
    this.#save();
    this.#event('pairing/disabled', { identity });
    return true;
  }

  listTargets() {
    this.#assertLoaded();
    return Object.values(this.#state.targets)
      .map((target) => ({ ...target }))
      .sort((a, b) => a.identity.localeCompare(b.identity));
  }

  isPairedTarget(identity) {
    this.#assertLoaded();
    const target = this.#state.targets[identity];
    return target !== undefined && target.enabled === true;
  }

  roleOfPairedTarget(identity) {
    this.#assertLoaded();
    const target = this.#state.targets[identity];
    return target?.enabled === true ? target.role : undefined;
  }

  /**
   * Accept one validated envelope.
   * @returns {{record: object, duplicate: boolean} | {conflict: true, existing: object}}
   */
  enqueue(envelope) {
    this.#assertLoaded();
    const now = this.#now();
    const existing = this.#state.messages[envelope.msg_id];
    if (existing !== undefined) {
      const same = existing.from === envelope.from
        && existing.to === envelope.to
        && existing.kind === envelope.kind
        && existing.text === envelope.text;
      if (same) return { record: { ...existing }, duplicate: true };
      return { conflict: true, existing: { ...existing } };
    }
    const liveCount = this.#state.order.length - this.#terminalCount();
    if (liveCount >= this.#maxMessages) {
      throw new StoreError('queue-full', `hub holds ${liveCount} live messages; raise max_messages or drain the queue`);
    }
    this.#state.seq += 1;
    const record = {
      msg_id: envelope.msg_id,
      seq: this.#state.seq,
      from: envelope.from,
      to: envelope.to,
      from_role: identityRole(envelope.from),
      to_role: identityRole(envelope.to),
      kind: envelope.kind,
      text: envelope.text,
      meta: envelope.meta ?? {},
      created_at: envelope.created_at ?? new Date(now).toISOString(),
      accepted_at: new Date(now).toISOString(),
      expires_at: new Date(now + envelope.ttl_ms).toISOString(),
      ttl_ms: envelope.ttl_ms,
      state: STATES.QUEUED,
      attempts: 0,
      last_error: null,
      last_attempt_at: null,
      delivered_at: null,
      delivery_unknown_since: null,
    };
    this.#state.messages[record.msg_id] = record;
    this.#state.order.push(record.msg_id);
    this.#save();
    this.#event('message/accepted', { msg_id: record.msg_id, from: record.from, to: record.to });
    return { record: { ...record }, duplicate: false };
  }

  getMessage(msgId) {
    this.#assertLoaded();
    const record = this.#state.messages[msgId];
    return record === undefined ? undefined : { ...record };
  }

  listMessages({ to, from, state, limit = 50 } = {}) {
    this.#assertLoaded();
    const rows = [];
    for (const msgId of this.#state.order) {
      const record = this.#state.messages[msgId];
      if (record === undefined) continue;
      if (to !== undefined && record.to !== to) continue;
      if (from !== undefined && record.from !== from) continue;
      if (state !== undefined && record.state !== state) continue;
      rows.push({ ...record });
    }
    if (rows.length > limit) rows.splice(0, rows.length - limit);
    return rows;
  }

  /** Messages a role's connected adapter should (re)try, in acceptance order. */
  deliverableForRole(role) {
    this.#assertLoaded();
    const now = this.#now();
    const rows = [];
    for (const msgId of this.#state.order) {
      const record = this.#state.messages[msgId];
      if (record === undefined || record.to_role !== role) continue;
      if (!RETRYABLE_STATES.has(record.state)) continue;
      if (Date.parse(record.expires_at) <= now) continue;
      if (!this.isPairedTarget(record.to)) continue;
      rows.push({ ...record });
    }
    return rows;
  }

  transition(msgId, toState, patch = {}) {
    this.#assertLoaded();
    const record = this.#state.messages[msgId];
    if (record === undefined) throw new StoreError('message-not-found', `unknown message "${msgId}"`);
    if (!canTransition(record.state, toState)) {
      throw new StoreError('transition-invalid', `cannot move ${msgId} from ${record.state} to ${toState}`);
    }
    record.state = toState;
    Object.assign(record, patch);
    this.#save();
    this.#event(`message/${toState}`, { msg_id: msgId, ...this.#summarize(patch) });
    return { ...record };
  }

  #summarize(patch) {
    const out = {};
    for (const key of ['attempts', 'last_error']) if (patch[key] !== undefined) out[key] = patch[key];
    return out;
  }

  /**
   * Record an active-end consumer (e.g. the Codex side using its own official
   * tools) confirming it took responsibility for a queued message. Used only
   * for roles without a connected adapter.
   * @param {string} msgId
   * @param {{consumer: string, note?: string}} options
   */
  consume(msgId, { consumer, note = '' } = {}) {
    this.#assertLoaded();
    const record = this.#state.messages[msgId];
    if (record === undefined) throw new StoreError('message-not-found', `unknown message "${msgId}"`);
    if (!RETRYABLE_STATES.has(record.state)) {
      throw new StoreError('message-not-consumable', `message ${msgId} is ${record.state}, not queued/delivery_unknown`);
    }
    if (typeof consumer !== 'string' || !consumer.includes(':')) {
      throw new StoreError('consumer-invalid', 'consumer must be a role:id identity');
    }
    const now = this.#now();
    const accepted = this.transition(msgId, STATES.DELIVERING, {
      last_attempt_at: new Date(now).toISOString(),
      next_attempt_at: null,
    });
    const delivered = this.transition(msgId, STATES.DELIVERED, {
      delivered_at: new Date(now).toISOString(),
      consumed_by: consumer,
      consumed_at: new Date(now).toISOString(),
      consume_note: note,
    });
    this.#event('message/consumed', { msg_id: msgId, consumer });
    void accepted;
    return delivered;
  }

  /** Expire TTLs and fail messages whose target is no longer paired. */
  sweep() {
    this.#assertLoaded();
    const now = this.#now();
    let changed = 0;
    for (const msgId of this.#state.order) {
      const record = this.#state.messages[msgId];
      if (record === undefined) continue;
      if (!RETRYABLE_STATES.has(record.state) && record.state !== STATES.DELIVERING) continue;
      if (!this.isPairedTarget(record.to)) {
        record.state = STATES.FAILED;
        record.last_error = 'target-unpaired';
        changed += 1;
        this.#event('message/failed', { msg_id: msgId, last_error: 'target-unpaired' });
        continue;
      }
      if (Date.parse(record.expires_at) <= now) {
        record.state = STATES.EXPIRED;
        changed += 1;
        this.#event('message/expired', { msg_id: msgId });
      }
    }
    if (changed > 0) this.#save();
    const pruned = this.#pruneTerminal();
    return { changed, pruned };
  }

  #terminalCount() {
    let count = 0;
    for (const msgId of this.#state.order) {
      const record = this.#state.messages[msgId];
      if (record !== undefined && (record.state === STATES.FAILED || record.state === STATES.EXPIRED || record.state === STATES.DELIVERED)) count += 1;
    }
    return count;
  }

  #pruneTerminal() {
    const terminal = [];
    for (const msgId of this.#state.order) {
      const record = this.#state.messages[msgId];
      if (record !== undefined && (record.state === STATES.FAILED || record.state === STATES.EXPIRED || record.state === STATES.DELIVERED)) terminal.push(msgId);
    }
    const excess = terminal.length - this.#maxTerminal;
    if (excess <= 0) return 0;
    const drop = new Set(terminal.slice(0, excess));
    this.#state.order = this.#state.order.filter((msgId) => !drop.has(msgId));
    for (const msgId of drop) delete this.#state.messages[msgId];
    this.#save();
    this.#event('message/pruned', { count: drop.size });
    return drop.size;
  }

  summary() {
    this.#assertLoaded();
    const byState = {};
    for (const msgId of this.#state.order) {
      const record = this.#state.messages[msgId];
      if (record === undefined) continue;
      byState[record.state] = (byState[record.state] ?? 0) + 1;
    }
    return {
      server_id: this.#state.server_id,
      created_at: this.#state.created_at,
      seq: this.#state.seq,
      messages: this.#state.order.length,
      by_state: byState,
      targets: this.listTargets(),
    };
  }
}
