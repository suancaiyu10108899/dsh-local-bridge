// DSH host plugin for the Local Agent Bridge.
//
// Loaded by the DSH host as a Cordis plugin (profile patch insert row, file URL).
// Responsibilities:
//   1. keep a connection to the local hub (retrying, event-driven, no model work);
//   2. deliver inbound peer messages to the exact live DSH session via
//      Agent.followup after validating that the durable inbox event was written;
//   3. register model-facing bridge tools (bridge_send/bridge_status/bridge_targets).
//
// Native DSH format v4 requires a producer-owned source kind; `plugin` is retired
// and rejected. This plugin uses the producer-owned kind `local-agent-bridge/dsh`.
import fs from 'node:fs';
import path from 'node:path';
import { HubClient } from '../../src/client.mjs';
import { createHubService } from '../../src/hub-service.mjs';
import { collectServiceStatus } from '../../src/service-status.mjs';
import { RUNTIME_DIR, loadConfig, readToken } from '../../src/runtime.mjs';

export const name = 'local-agent-bridge';
export const inject = ['agents', 'tools'];

export const SOURCE_KIND = 'local-agent-bridge/dsh';
export const DURABLE_EVENT = 'agent/inbox/spliced';
const DEFAULT_DURABLE_TIMEOUT_MS = 5_000;
const RECONNECT_DELAY_MS = 3_000;
const PLUGIN_LOG_FILE = path.join(RUNTIME_DIR, 'dsh-plugin', 'plugin.log');
const PLUGIN_LOG_MAX_BYTES = 512 * 1024;

/** Best-effort file log: the host's stderr is not readable while diagnosing. */
function appendPluginLog(event, detail) {
  try {
    fs.mkdirSync(path.dirname(PLUGIN_LOG_FILE), { recursive: true });
    const stat = fs.statSync(PLUGIN_LOG_FILE, { throwIfNoEntry: false });
    if (stat !== undefined && stat.size > PLUGIN_LOG_MAX_BYTES) {
      fs.renameSync(PLUGIN_LOG_FILE, `${PLUGIN_LOG_FILE}.1`);
    }
    fs.appendFileSync(PLUGIN_LOG_FILE, `${JSON.stringify({ ts: new Date().toISOString(), event, ...detail })}\n`, 'utf8');
  } catch {
    /* diagnostics must never break delivery */
  }
}

function freezeDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    value.forEach(freezeDeep);
  } else {
    Object.values(value).forEach(freezeDeep);
  }
  return Object.freeze(value);
}

/**
 * Build one immutable user-role message with a producer-owned source.
 * @param {object} input inbound hub message
 * @param {(input: object) => object} createUserMessage native factory when available
 * @returns {object} message ready for Agent.followup
 */
export function buildPeerMessage(input, createUserMessage) {
  const content = [{ type: 'text', text: String(input.text) }];
  const origin = input?.meta !== undefined && input.meta !== null && typeof input.meta === 'object' ? input.meta.origin : undefined;
  const source = {
    kind: SOURCE_KIND,
    peer: input.from,
    msg_id: input.msg_id,
    via: 'local-hub',
    ...(typeof origin === 'string' && origin.length > 0 ? { origin } : {}),
  };
  if (typeof createUserMessage === 'function') {
    return createUserMessage({ content, source });
  }
  return freezeDeep({
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content,
    source,
  });
}

/**
 * Wait until the injected message is present in a durable session event.
 * A timeout means "not confirmed", never "not delivered".
 * @param {{ctx: object, sessionId: string, messageId: string, timeoutMs?: number}} options
 * @returns {Promise<boolean>}
 */
export function confirmDurable({ ctx, sessionId, messageId, timeoutMs = DEFAULT_DURABLE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let dispose;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        dispose?.();
      } catch {
        /* listener already gone */
      }
      resolve(value);
    };
    const listener = (session, event) => {
      if (event?.type !== DURABLE_EVENT) return;
      if (session?.id !== undefined && session.id !== sessionId) return;
      const inserted = event?.data?.inserted;
      if (!Array.isArray(inserted)) return;
      if (inserted.some((message) => message?.id === messageId)) finish(true);
    };
    dispose = ctx.on('session/event', listener);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Create the hub delivery handler for this DSH host.
 * ACK is sent only after the durable inbox event is observed.
 * @param {object} options
 * @returns {(message: object, delivery: {ack: Function}) => Promise<void>}
 */
export function createDeliveryHandler({ ctx, makeMessage, log = () => {}, durableTimeoutMs = DEFAULT_DURABLE_TIMEOUT_MS }) {
  return async function deliver(message, delivery) {
    const target = String(message?.to ?? '');
    if (!target.startsWith('dsh:')) {
      delivery.ack({ ok: false, code: 'target-role-mismatch', retryable: false });
      return;
    }
    const sessionId = target.slice('dsh:'.length);
    const agent = ctx.agents.get(sessionId);
    if (agent === undefined || agent === null) {
      log('dsh-plugin/session-not-live', { sessionId, msg_id: message.msg_id });
      delivery.ack({ ok: false, code: 'session-not-live', retryable: true });
      return;
    }
    const peerMessage = makeMessage(message);
    const durable = confirmDurable({ ctx, sessionId, messageId: peerMessage.id, timeoutMs: durableTimeoutMs });
    try {
      agent.followup(peerMessage);
    } catch (error) {
      log('dsh-plugin/followup-failed', { sessionId, msg_id: message.msg_id, message: String(error) });
      delivery.ack({ ok: false, code: 'followup-failed', retryable: false });
      return;
    }
    const confirmed = await durable;
    if (!confirmed) {
      log('dsh-plugin/durability-unconfirmed', { sessionId, msg_id: message.msg_id });
      delivery.ack({ ok: false, code: 'durability-unconfirmed', retryable: false });
      return;
    }
    log('dsh-plugin/delivered', { sessionId, msg_id: message.msg_id, message_id: peerMessage.id });
    delivery.ack({ ok: true, detail: { session_id: sessionId, message_id: peerMessage.id } });
  };
}

/**
 * Start the hub connection loop. Reconnects forever with a fixed delay; it does
 * not touch any model. Returns a disposer.
 * @param {{clientFactory: Function, onDelivery: Function, onClient?: Function, log?: Function, delayMs?: number}} options
 */
export function startHubLoop({ clientFactory, onDelivery, onClient = () => {}, log = () => {}, delayMs = RECONNECT_DELAY_MS }) {
  let stopped = false;
  let current = null;
  let retryTimer = null;

  const schedule = () => {
    if (stopped) return;
    retryTimer = setTimeout(() => void connect(), delayMs);
    retryTimer.unref?.();
  };
  const connect = async () => {
    if (stopped) return;
    let client;
    try {
      client = clientFactory();
      await client.connect();
      if (stopped) {
        await client.close().catch(() => {});
        return;
      }
      current = client;
      client.onDelivery(onDelivery);
      client.onFrame('error', (frame) => log('dsh-plugin/hub-error-frame', { code: frame.code }));
      client.onClose?.(() => {
        if (stopped || current !== client) return;
        current = null;
        onClient(null);
        log('dsh-plugin/hub-connection-lost', { identity: client.identity });
        schedule();
      });
      onClient(client);
      log('dsh-plugin/hub-connected', { identity: client.identity, server: client.welcome?.server?.server_id });
    } catch (error) {
      if (client !== undefined) await client.close().catch(() => {});
      current = null;
      onClient(null);
      log('dsh-plugin/hub-connect-failed', { message: String(error?.message ?? error) });
      schedule();
    }
  };
  void connect();
  return async () => {
    stopped = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (current !== null) await current.close().catch(() => {});
    current = null;
    onClient(null);
  };
}

const OUTPUT_SCHEMA_JSON = Object.freeze({ type: 'object', additionalProperties: true });

/** Convert our small parameter DSL to the supported JSON Schema subset. */
export function dslToJsonSchema(parameters = {}) {
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(parameters)) {
    const node = { type: spec.type };
    if (typeof spec.description === 'string') node.description = spec.description;
    properties[name] = node;
    if (spec.required === true) required.push(name);
  }
  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Replicate the `defineTool` definition shape without importing the package.
 * Used when the host does not expose `@deepseek-ai/dsh-tools` to a file-URL
 * plugin; `ctx.tools.register` accepts the same definition object.
 */
export function fallbackToolDefinition(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: dslToJsonSchema(spec.parameters),
    output: {
      schema: OUTPUT_SCHEMA_JSON,
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args, exec) {
      return spec.execute(args, exec);
    },
  };
}

function registerTools({ ctx, defineTool, identity, getClient, getServiceStatus }) {
  const buildTool = (spec) => (defineTool !== undefined ? defineTool(spec) : fallbackToolDefinition(spec));
  const requireClient = () => {
    const client = getClient();
    if (client === null || client.closed) throw new Error('bridge hub is not connected yet');
    return client;
  };
  ctx.tools.register(buildTool({
    name: 'bridge_send',
    description: 'Send a text message through the local DSH<->Codex bridge hub to a paired peer identity. Use bridge_targets first to see paired targets.',
    parameters: {
      to: { type: 'string', required: true, description: 'Target identity, e.g. codex:<threadId>.' },
      text: { type: 'string', required: true, description: 'Message text.' },
      msg_id: { type: 'string', description: 'Optional idempotency key for safe retries.' },
    },
    output: { schema: { type: 'json' } },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id;
      if (typeof sessionId !== 'string') return { ok: false, code: 'no-session', message: 'bridge_send requires a session context' };
      let client;
      try {
        client = requireClient();
      } catch (error) {
        return { ok: false, code: 'hub-disconnected', message: error.message };
      }
      try {
        const accepted = await client.sendMessage({
          v: 1,
          from: `dsh:${sessionId}`,
          to: args.to,
          kind: 'text',
          text: args.text,
          ...(args.msg_id === undefined ? {} : { msg_id: args.msg_id }),
          meta: { source: 'dsh-agent-tool', peer: identity },
        });
        return { ok: true, ...accepted, from: `dsh:${sessionId}`, to: args.to };
      } catch (error) {
        return { ok: false, code: error.code ?? 'send-failed', message: error.message };
      }
    },
  }));
  ctx.tools.register(buildTool({
    name: 'bridge_status',
    description: 'Read bridge delivery state for one message id, or the recent queued/recent messages addressed to this session.',
    parameters: {
      msg_id: { type: 'string', description: 'Optional message id. Omit for a recent list for this session.' },
      limit: { type: 'number', description: 'Maximum recent records (default 20, max 100).' },
    },
    output: { schema: { type: 'json' } },
    async execute(args, exec) {
      let client;
      try {
        client = requireClient();
      } catch (error) {
        return { ok: false, code: 'hub-disconnected', message: error.message };
      }
      const sessionId = exec?.agent?.session?.id;
      try {
        if (typeof args.msg_id === 'string' && args.msg_id.length > 0) {
          const record = await client.status(args.msg_id);
          return { ok: true, message: record ?? null };
        }
        const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
        const messages = await client.statusList({ to: `dsh:${sessionId}`, limit });
        return { ok: true, count: messages.length, messages };
      } catch (error) {
        return { ok: false, code: error.code ?? 'status-failed', message: error.message };
      }
    },
  }));
  ctx.tools.register(buildTool({
    name: 'bridge_targets',
    description: 'List paired bridge targets (exact identities) that this project may message.',
    parameters: {},
    output: { schema: { type: 'json' } },
    async execute() {
      let client;
      try {
        client = requireClient();
      } catch (error) {
        return { ok: false, code: 'hub-disconnected', message: error.message };
      }
      try {
        const targets = await client.targets();
        return { ok: true, targets };
      } catch (error) {
        return { ok: false, code: error.code ?? 'targets-failed', message: error.message };
      }
    },
  }));
  ctx.tools.register(buildTool({
    name: 'bridge_service_status',
    description: 'Read-only status of the local bridge companion: managed Hub process, Hub health, connection state, and optional receiver windows. Does not start, stop, renew or modify anything.',
    parameters: {},
    output: { schema: { type: 'json' } },
    async execute() {
      try {
        return { ok: true, ...getServiceStatus() };
      } catch (error) {
        return { ok: false, code: error.code ?? 'service-status-failed', message: String(error?.message ?? error) };
      }
    },
  }));
}

/** Cordis plugin entry. */
export async function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const log = (event, detail) => {
    appendPluginLog(event, detail);
    try {
      process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), plugin: name, event, ...detail })}\n`);
    } catch {
      /* ignore logging failures */
    }
  };

  const base = loadConfig();
  const hubOptions = {
    host: config.hubHost ?? base.host,
    port: config.hubPort ?? base.port,
  };

  // One visible managed companion: the plugin owns the Hub child unless the
  // user explicitly manages the Hub themselves. An already-running Hub is
  // reused and never killed by this plugin.
  const managedHub = config.manageHub === false ? null : createHubService({ log });
  if (managedHub !== null) {
    void managedHub.ensureStarted()
      .then((result) => log('dsh-plugin/hub-service-ready', result))
      .catch((error) => log('dsh-plugin/hub-service-failed', {
        code: error?.code ?? 'hub-service-failed',
        message: String(error?.message ?? error),
      }));
  }

  // Native factories are loaded lazily so a missing/renamed package only
  // disables that convenience, not inbound delivery.
  let createUserMessage;
  let defineTool;
  try {
    ({ createUserMessage } = await import('@deepseek-ai/dsh-llm'));
  } catch (error) {
    log('dsh-plugin/create-user-message-missing', { message: String(error?.message ?? error) });
  }
  try {
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
  } catch (error) {
    log('dsh-plugin/define-tool-missing', { message: String(error?.message ?? error) });
  }

  const makeMessage = (message) => buildPeerMessage(message, createUserMessage);
  const identity = `dsh:host:${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const deliveryHandler = createDeliveryHandler({ ctx, makeMessage, log });

  let currentClient = null;
  const disposeHub = startHubLoop({
    clientFactory: () => new HubClient({
      host: hubOptions.host,
      port: hubOptions.port,
      token: process.env.LAB_BRIDGE_TOKEN ?? readToken(),
      role: 'dsh',
      identity,
      logger: (event, detail) => log(`client/${event}`, detail),
    }),
    onDelivery: deliveryHandler,
    onClient: (client) => {
      currentClient = client;
    },
    log,
  });
  ctx.effect(() => disposeHub, 'local-agent-bridge.hub');
  if (managedHub !== null) {
    ctx.effect(() => async () => {
      await managedHub.stop();
    }, 'local-agent-bridge.hub-service');
  }

  // Tools are registered even when the native package import failed: the
  // fallback definition reproduces the same ctx.tools.register contract.
  try {
    registerTools({
      ctx,
      defineTool,
      identity,
      getClient: () => currentClient,
      getServiceStatus: () => ({
        ...collectServiceStatus({ runtimeDir: RUNTIME_DIR }),
        manage_hub_enabled: managedHub !== null,
        hub_client_connected: currentClient !== null && currentClient.closed !== true,
        managed_hub: managedHub === null ? null : managedHub.status(),
      }),
    });
    log('dsh-plugin/tools-registered', { identity, nativeDefineTool: defineTool !== undefined });
  } catch (error) {
    log('dsh-plugin/tool-registration-failed', { message: String(error?.message ?? error) });
  }
}
