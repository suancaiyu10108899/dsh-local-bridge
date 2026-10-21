// Minimal conversation-loop guardrails for multi-agent message chains.
//
// Scope: isolated policy + tests only. No live multi-round
// conversation is started, no adapter/plugin is changed, and no model is prompted.
//
// Policy summary:
//   - auto-reply defaults to OFF; a model-originated reply is never admitted unless
//     the chain was explicitly started by a human with autoReply: true.
//   - ACKs are recorded but never wake a model and never count as a model turn.
//   - every model message must carry correlation (parentMsgId already in the chain);
//     uncorrelated traffic is rejected instead of being treated as a fresh instruction.
//   - duplicate msg_id is a re-entry: admitted=false, reentry=true (callers must not
//     re-enqueue it as a new instruction).
//   - a chain closes at an explicit model-turn quota (default 4) or wall-clock quota
//     (default 120s); humans can close it earlier.
//   - state is serializable (durable correlation/dedup across process restarts) with
//     a bounded seen-id set.
export const DEFAULT_MAX_MODEL_TURNS = 4;
export const DEFAULT_MAX_CHAIN_MS = 120_000;
export const DEFAULT_MAX_SEEN_IDS = 256;

export class GuardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
    this.details = details;
  }
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GuardError('guard-invalid-argument', `${field} must be a non-empty string`);
  }
  return value;
}

function chainView(chain) {
  return Object.freeze({
    chainId: chain.chainId,
    rootMsgId: chain.rootMsgId,
    humanInitiated: chain.humanInitiated,
    autoReply: chain.autoReply,
    createdAt: chain.createdAt,
    modelTurns: chain.modelTurns,
    maxModelTurns: chain.maxModelTurns,
    maxChainMs: chain.maxChainMs,
    seenCount: chain.seenMsgIds.size,
    closedReason: chain.closedReason,
    closedAt: chain.closedAt,
  });
}

export class ConversationGuard {
  #chains = new Map();
  #maxModelTurns;
  #maxChainMs;
  #maxSeenIds;
  #now;

  constructor({ maxModelTurns = DEFAULT_MAX_MODEL_TURNS, maxChainMs = DEFAULT_MAX_CHAIN_MS, maxSeenIds = DEFAULT_MAX_SEEN_IDS, now = Date.now } = {}) {
    if (!Number.isSafeInteger(maxModelTurns) || maxModelTurns < 1) throw new GuardError('guard-invalid-config', 'maxModelTurns must be a positive integer');
    if (!Number.isSafeInteger(maxChainMs) || maxChainMs < 1) throw new GuardError('guard-invalid-config', 'maxChainMs must be a positive integer');
    if (!Number.isSafeInteger(maxSeenIds) || maxSeenIds < 2) throw new GuardError('guard-invalid-config', 'maxSeenIds must be >= 2');
    if (typeof now !== 'function') throw new GuardError('guard-invalid-config', 'now must be a function');
    this.#maxModelTurns = maxModelTurns;
    this.#maxChainMs = maxChainMs;
    this.#maxSeenIds = maxSeenIds;
    this.#now = now;
  }

  /** Start a human-initiated chain. autoReply is explicit opt-in and defaults off. */
  startChain({ chainId, rootMsgId, autoReply = false, now } = {}) {
    const id = requireId(chainId, 'chainId');
    const root = requireId(rootMsgId, 'rootMsgId');
    if (this.#chains.has(id)) throw new GuardError('guard-chain-exists', `chain "${id}" already exists`);
    if (typeof autoReply !== 'boolean') throw new GuardError('guard-invalid-argument', 'autoReply must be a boolean');
    const createdAt = now ?? this.#now();
    const chain = {
      chainId: id,
      rootMsgId: root,
      humanInitiated: true,
      autoReply,
      createdAt,
      modelTurns: 0,
      maxModelTurns: this.#maxModelTurns,
      maxChainMs: this.#maxChainMs,
      seenMsgIds: new Set([root]),
      closedReason: null,
      closedAt: null,
    };
    this.#chains.set(id, chain);
    return { ...chainView(chain), admit: true, deliver: false, wake: false, countTurn: false };
  }

  /** Admit an inbound ACK. Never wakes a model and never consumes a turn. */
  admitAck({ chainId, msgId } = {}) {
    const chain = this.#chain(chainId);
    const id = requireId(msgId, 'msgId');
    if (chain.closedReason !== null) return { admit: false, reason: chain.closedReason, deliver: false, wake: false, countTurn: false };
    const reentry = chain.seenMsgIds.has(id);
    if (!reentry) this.#remember(chain, id);
    return { admit: true, reason: 'ack', reentry, deliver: false, wake: false, countTurn: false };
  }

  /**
   * Admit a message that would wake a model. Model-originated messages must be
   * correlated and are refused unless the human opted into auto-reply.
   * @param {{chainId: string, msgId: string, parentMsgId?: string, origin?: 'human'|'model'}} input
   */
  admit({ chainId, msgId, parentMsgId, origin = 'model', now } = {}) {
    const chain = this.#chain(chainId);
    const id = requireId(msgId, 'msgId');
    if (origin !== 'human' && origin !== 'model') throw new GuardError('guard-invalid-argument', "origin must be 'human' or 'model'");
    const at = now ?? this.#now();

    if (chain.closedReason !== null) return { admit: false, reason: chain.closedReason, deliver: false, wake: false, countTurn: false };
    if (chain.seenMsgIds.has(id)) return { admit: false, reason: 'duplicate-message', reentry: true, deliver: false, wake: false, countTurn: false };
    if (at - chain.createdAt > chain.maxChainMs) {
      this.close(chain.chainId, 'time-quota', at);
      return { admit: false, reason: 'time-quota', deliver: false, wake: false, countTurn: false };
    }
    if (origin === 'model') {
      if (chain.autoReply !== true) return { admit: false, reason: 'auto-reply-disabled', deliver: false, wake: false, countTurn: false };
      if (typeof parentMsgId !== 'string' || parentMsgId.length === 0 || !chain.seenMsgIds.has(parentMsgId)) {
        return { admit: false, reason: 'missing-correlation', deliver: false, wake: false, countTurn: false };
      }
      if (chain.modelTurns >= chain.maxModelTurns) {
        this.close(chain.chainId, 'turn-quota', at);
        return { admit: false, reason: 'turn-quota', deliver: false, wake: false, countTurn: false };
      }
    }
    this.#remember(chain, id);
    if (origin === 'model') chain.modelTurns += 1;
    return {
      admit: true,
      reason: origin === 'model' ? 'model-turn' : 'human-message',
      reentry: false,
      deliver: true,
      wake: true,
      countTurn: origin === 'model',
      modelTurns: chain.modelTurns,
    };
  }

  /** Close a chain early (human stop) or via quota. Idempotent. */
  close(chainId, reason = 'closed-by-human', at) {
    const chain = this.#chain(chainId);
    if (chain.closedReason !== null) return chainView(chain);
    chain.closedReason = typeof reason === 'string' && reason.length > 0 ? reason : 'closed';
    chain.closedAt = at ?? this.#now();
    return chainView(chain);
  }

  snapshot(chainId) {
    return chainView(this.#chain(chainId));
  }

  list() {
    return [...this.#chains.values()].map(chainView);
  }

  #chain(chainId) {
    const id = requireId(chainId, 'chainId');
    const chain = this.#chains.get(id);
    if (chain === undefined) throw new GuardError('guard-unknown-chain', `unknown chain "${id}"`);
    return chain;
  }

  #remember(chain, msgId) {
    chain.seenMsgIds.add(msgId);
    while (chain.seenMsgIds.size > this.#maxSeenIds) {
      const oldest = chain.seenMsgIds.values().next().value;
      chain.seenMsgIds.delete(oldest);
    }
  }

  /** Persist durable correlation/dedup state (Set -> sorted array). */
  toJSON() {
    return {
      v: 1,
      maxModelTurns: this.#maxModelTurns,
      maxChainMs: this.#maxChainMs,
      maxSeenIds: this.#maxSeenIds,
      chains: [...this.#chains.values()].map((chain) => ({
        chainId: chain.chainId,
        rootMsgId: chain.rootMsgId,
        autoReply: chain.autoReply,
        createdAt: chain.createdAt,
        modelTurns: chain.modelTurns,
        closedReason: chain.closedReason,
        closedAt: chain.closedAt,
        seenMsgIds: [...chain.seenMsgIds],
      })),
    };
  }

  static fromJSON(value, { now = Date.now } = {}) {
    if (value === null || typeof value !== 'object' || value.v !== 1 || !Array.isArray(value.chains)) {
      throw new GuardError('guard-invalid-state', 'unsupported or malformed guard state');
    }
    const guard = new ConversationGuard({
      maxModelTurns: value.maxModelTurns,
      maxChainMs: value.maxChainMs,
      maxSeenIds: value.maxSeenIds,
      now,
    });
    for (const entry of value.chains) {
      const chainId = requireId(entry.chainId, 'state.chainId');
      const rootMsgId = requireId(entry.rootMsgId, 'state.rootMsgId');
      if (guard.#chains.has(chainId)) throw new GuardError('guard-invalid-state', `duplicate chain "${chainId}"`);
      if (!Array.isArray(entry.seenMsgIds) || entry.seenMsgIds.length === 0) {
        throw new GuardError('guard-invalid-state', `chain "${chainId}" has no seen ids`);
      }
      guard.#chains.set(chainId, {
        chainId,
        rootMsgId,
        humanInitiated: true,
        autoReply: entry.autoReply === true,
        createdAt: Number(entry.createdAt),
        modelTurns: Number(entry.modelTurns ?? 0),
        maxModelTurns: guard.#maxModelTurns,
        maxChainMs: guard.#maxChainMs,
        seenMsgIds: new Set(entry.seenMsgIds.map((id) => requireId(id, 'state.seenMsgId'))),
        closedReason: entry.closedReason ?? null,
        closedAt: entry.closedAt ?? null,
      });
    }
    return guard;
  }
}

