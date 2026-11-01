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
import { ensureBootstrap } from '../../src/companion-bootstrap.mjs';
import { collectServiceStatus } from '../../src/service-status.mjs';
import { computeCodeIdentity, readComponentIdentity, writeComponentIdentity } from '../../src/code-identity.mjs';
import { PROJECT_ROOT, RUNTIME_DIR, loadConfig, readToken } from '../../src/runtime.mjs';
import { defaultInstallationRoot, installationPaths, readInstallation } from '../../src/installation.mjs';
import { fileURLToPath } from 'node:url';

export const name = 'local-agent-bridge';
export const inject = ['agents', 'tools'];

export const SOURCE_KIND = 'local-agent-bridge/dsh';
export const DURABLE_EVENT = 'agent/inbox/spliced';
const DEFAULT_DURABLE_TIMEOUT_MS = 5_000;
const RECONNECT_DELAY_MS = 3_000;
const PLUGIN_LOG_MAX_BYTES = 512 * 1024;

function pluginLogFile(runtimeDir) {
  return path.join(runtimeDir, 'dsh-plugin', 'plugin.log');
}

/** Resolve every plugin data path from the matching installation locator. */
export function resolvePluginRuntime({ env = process.env, projectRoot = PROJECT_ROOT } = {}) {
  const explicitInstallation = typeof env.LAB_BRIDGE_INSTALLATION_ROOT === 'string' && env.LAB_BRIDGE_INSTALLATION_ROOT.length > 0;
  const installationRoot = explicitInstallation ? path.resolve(env.LAB_BRIDGE_INSTALLATION_ROOT) : defaultInstallationRoot({ env });
  const locator = installationPaths(installationRoot).locator;
  if (fs.existsSync(locator)) {
    const installation = readInstallation({ root: installationRoot, required: true });
    if (path.resolve(installation.app_root) === path.resolve(projectRoot)) {
      const ambient = typeof env.LAB_BRIDGE_RUNTIME_DIR === 'string' && env.LAB_BRIDGE_RUNTIME_DIR.length > 0
        ? path.resolve(env.LAB_BRIDGE_RUNTIME_DIR) : null;
      if (ambient !== null && ambient !== path.resolve(installation.runtime_root)) {
        const error = new Error(`ambient LAB_BRIDGE_RUNTIME_DIR ${ambient} conflicts with installation runtime_root ${installation.runtime_root}`);
        error.code = 'RUNTIME_INSTANCE_CONFLICT';
        throw error;
      }
      return { runtimeDir: path.resolve(installation.runtime_root), installationRoot, installation, source: 'installation' };
    }
    if (explicitInstallation) {
      const error = new Error(`explicit installation app_root ${installation.app_root} does not match plugin app root ${projectRoot}`);
      error.code = 'PLUGIN_APP_ROOT_MISMATCH';
      throw error;
    }
  }
  const ambient = typeof env.LAB_BRIDGE_RUNTIME_DIR === 'string' && env.LAB_BRIDGE_RUNTIME_DIR.length > 0
    ? path.resolve(env.LAB_BRIDGE_RUNTIME_DIR) : null;
  return { runtimeDir: ambient ?? RUNTIME_DIR, installationRoot, installation: null, source: ambient === null ? 'source' : 'ambient' };
}

/** Best-effort file log: the host's stderr is not readable while diagnosing. */
function appendPluginLog(event, detail, runtimeDir) {
  const file = pluginLogFile(runtimeDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat !== undefined && stat.size > PLUGIN_LOG_MAX_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), event, ...detail })}\n`, 'utf8');
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
    ...(typeof input?.meta?.client_request_id === 'string' ? {
      client_request_id: input.meta.client_request_id,
      client_identity: input.from,
      request_msg_id: input.msg_id,
      reply_to: input.meta.reply_to,
    } : {}),
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
export function createDeliveryHandler({ ctx, makeMessage, log = () => {}, durableTimeoutMs = DEFAULT_DURABLE_TIMEOUT_MS, getClient = () => null, pendingOutcomes = null }) {
  const reportOutcome = async (client, gate, status, nativeQueueId, reason) => {
    try {
      await client.clientOutcome({
        clientIdentity: gate.clientIdentity, clientRequestId: gate.clientRequestId,
        targetIdentity: gate.targetIdentity, requestMsgId: gate.requestMsgId,
        outcome: status, nativeQueueId, leaseId: gate.leaseId, fencingToken: gate.fencingToken, code: reason,
      });
      return { ok: true };
    } catch (error) {
      log('dsh-plugin/client-outcome-failed', { request_id: gate.clientRequestId, status, code: error?.code ?? null });
      if (pendingOutcomes !== null) {
        pendingOutcomes.set(`${gate.clientIdentity}|${gate.clientRequestId}`, {
          clientIdentity: gate.clientIdentity, clientRequestId: gate.clientRequestId,
          targetIdentity: gate.targetIdentity, requestMsgId: gate.requestMsgId,
          outcome: status, nativeQueueId, leaseId: gate.leaseId, fencingToken: gate.fencingToken, code: reason,
        });
      }
      return { ok: false, error };
    }
  };
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
      delivery.ack({ ok: false, code: 'session-not-live', retryable: true, ...(typeof message?.meta?.client_request_id === 'string' ? { no_native: true } : {}) });
      return;
    }
    const clientRequestId = message?.meta?.client_request_id;
    let gate = null;
    let client = null;
    if (typeof clientRequestId === 'string' && clientRequestId.length > 0) {
      client = getClient();
      if (client === null || client.closed) {
        delivery.ack({ ok: false, code: 'client-gate-hub-disconnected', retryable: true, no_native: true });
        return;
      }
      let claimed;
      try {
        claimed = await client.clientClaim({
          clientIdentity: message.from, clientRequestId, targetIdentity: target,
          requestMsgId: message.msg_id, ownerIdentity: target,
          receiverNonce: `dsh:${process.pid}`,
        });
      } catch (error) {
        log('dsh-plugin/client-claim-failed', { sessionId, msg_id: message.msg_id, request_id: clientRequestId, code: error?.code ?? null });
        delivery.ack({ ok: false, code: error?.code ?? 'client-claim-failed', retryable: true, no_native: true });
        return;
      }
      gate = {
        clientIdentity: message.from, clientRequestId, targetIdentity: target,
        requestMsgId: message.msg_id,
        leaseId: claimed.lease?.id, fencingToken: claimed.lease?.fencing_token,
      };
      try {
        await client.clientBegin({
          clientIdentity: gate.clientIdentity, clientRequestId, targetIdentity: target,
          requestMsgId: gate.requestMsgId, leaseId: gate.leaseId, fencingToken: gate.fencingToken,
        });
      } catch (error) {
        log('dsh-plugin/client-begin-failed', { sessionId, msg_id: message.msg_id, request_id: clientRequestId, code: error?.code ?? null });
        await reportOutcome(client, gate, 'NOT_SUBMITTED', null, error?.code ?? 'client-begin-failed');
        delivery.ack({ ok: false, code: error?.code ?? 'client-begin-failed', retryable: false, no_native: true });
        return;
      }
    }
    const peerMessage = makeMessage(message);
    const durable = confirmDurable({ ctx, sessionId, messageId: peerMessage.id, timeoutMs: durableTimeoutMs });
    try {
      agent.followup(peerMessage);
    } catch (error) {
      log('dsh-plugin/followup-failed', { sessionId, msg_id: message.msg_id, message: String(error) });
      // followup may have appended to the native inbox before throwing. Never
      // claim a known no-native outcome and never retry automatically.
      if (gate !== null) await reportOutcome(client, gate, 'UNCERTAIN', null, 'followup-threw-after-invocation');
      delivery.ack({ ok: false, code: 'followup-uncertain', retryable: false });
      return;
    }
    const confirmed = await durable;
    if (!confirmed) {
      log('dsh-plugin/durability-unconfirmed', { sessionId, msg_id: message.msg_id });
      if (gate !== null) await reportOutcome(client, gate, 'UNCERTAIN', null, 'durability-unconfirmed');
      delivery.ack({ ok: false, code: 'durability-unconfirmed', retryable: false });
      return;
    }
    if (gate !== null) {
      await reportOutcome(client, gate, 'NATIVE_QUEUED', peerMessage.id, null);
    }
    log('dsh-plugin/delivered', { sessionId, msg_id: message.msg_id, message_id: peerMessage.id });
    delivery.ack({ ok: true, detail: { session_id: sessionId, message_id: peerMessage.id } });
  };
}
/** Retry pending DSH client outcomes with the same lease/native evidence. */
export async function flushPendingOutcomes(client, pendingOutcomes, log = () => {}) {
  if (client === null || client.closed || pendingOutcomes === null) return;
  for (const [key, item] of pendingOutcomes) {
    try {
      await client.clientOutcome(item);
      pendingOutcomes.delete(key);
      log('dsh-plugin/client-outcome-recovered', { request_id: item.clientRequestId, outcome: item.outcome });
    } catch (error) {
      log('dsh-plugin/client-outcome-retry-failed', { request_id: item.clientRequestId, code: error?.code ?? null });
    }
  }
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

export function registerTools({ ctx, defineTool, identity, getClient, getServiceStatus }) {
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
    name: 'bridge_client_reply',
    description: 'Reply exactly once to a restricted client request delivered to this DSH session. Use the actual client request IDs from the inbound wrapper and the real receiving turn id; never invent a turn UUID.',
    parameters: {
      client_identity: { type: 'string', required: true, description: 'Exact client:dot-<uuid> source identity from the inbound request.' },
      client_request_id: { type: 'string', required: true, description: 'Business client_request_id from the inbound request meta.' },
      request_msg_id: { type: 'string', required: true, description: 'Durable Hub msg_id of the inbound request.' },
      turn_id: { type: 'string', required: true, description: 'Actual receiving DSH turn UUID; do not fabricate one.' },
      body: { type: 'string', required: true, description: 'UTF-8 reply text (bounded).' },
    },
    output: { schema: { type: 'json' } },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id;
      if (typeof sessionId !== 'string') return { ok: false, code: 'no-session', message: 'bridge_client_reply requires a session context' };
      const turnId = typeof args.turn_id === 'string' && args.turn_id.length > 0
        ? args.turn_id
        : (exec?.turn?.id ?? exec?.agent?.turn?.id);
      if (typeof turnId !== 'string' || turnId.length === 0) {
        return { ok: false, code: 'turn-id-required', message: 'actual receiving turn UUID is required; no UUID is fabricated' };
      }
      let client;
      try { client = requireClient(); } catch (error) { return { ok: false, code: 'hub-disconnected', message: error.message }; }
      try {
        const response = await client.clientReply({
          clientIdentity: args.client_identity,
          clientRequestId: args.client_request_id,
          targetIdentity: `dsh:${sessionId}`,
          requestMsgId: args.request_msg_id,
          turnId,
          body: args.body,
        });
        return { ok: true, idempotent: response.idempotent === true, request: response.request, reply: response.reply };
      } catch (error) {
        return { ok: false, code: error.code ?? 'client-reply-failed', message: error.message };
      }
    },
  }));  ctx.tools.register(buildTool({
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
  let pluginRuntime;
  try {
    pluginRuntime = resolvePluginRuntime();
  } catch (error) {
    try {
      process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), plugin: name, event: 'dsh-plugin/runtime-context-rejected', code: error?.code ?? null, message: String(error?.message ?? error) })}\n`);
    } catch { /* ignore logging failure */ }
    return;
  }
  const runtimeDir = pluginRuntime.runtimeDir;
  const log = (event, detail) => {
    appendPluginLog(event, detail, runtimeDir);
    try {
      process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), plugin: name, event, ...detail })}\n`);
    } catch {
      /* ignore logging failures */
    }
  };
  log('dsh-plugin/runtime-context', { runtimeDir, installationRoot: pluginRuntime.installationRoot, source: pluginRuntime.source });

  const pluginIdentity = computeCodeIdentity({
    rootDir: path.resolve(import.meta.dirname, '..', '..'),
    component: 'dsh-plugin',
    entry: fileURLToPath(import.meta.url),
  });
  let pluginIdentityFile = null;
  try {
    pluginIdentityFile = writeComponentIdentity({ runtimeDir, component: 'dsh-plugin', identity: pluginIdentity });
    log(pluginIdentity.status === 'OBSERVED' ? 'dsh-plugin/code-identity-loaded' : 'dsh-plugin/code-identity-unverified', {
      source_sha256: pluginIdentity.source_sha256,
      entry: pluginIdentity.entry,
      package_version: pluginIdentity.package_version,
      release_channel: pluginIdentity.release_channel,
      identity_file: pluginIdentityFile.path,
    });
  } catch (error) {
    log('dsh-plugin/code-identity-write-failed', { message: String(error?.message ?? error) });
  }

  const base = loadConfig({ runtimeDir });
  const hubOptions = {
    host: config.hubHost ?? base.host,
    port: config.hubPort ?? base.port,
  };

  // One background lifecycle owner. An installed COMPANION_OWNED root uses the
  // detached companion bootstrap; legacy runtimes without a locator keep the
  // existing in-process Hub service fallback. Both never own the Hub at once.
  // A persisted explicit-stop marker always wins over DSH startup.
  let bootstrap = null;
  let bootstrapError = false;
  if (config.companionBootstrap !== false && pluginRuntime.installation !== null) {
    try {
      bootstrap = await ensureBootstrap({
        installationRoot: pluginRuntime.installationRoot,
        runtimeDir,
        reason: 'DSH_START',
        env: process.env,
      });
      log('dsh-plugin/companion-bootstrap', {
        decision: bootstrap.decision,
        outcome: bootstrap.outcome,
        ok: bootstrap.ok,
        reason_code: bootstrap.reason_code ?? null,
        explicit_stop_active: bootstrap.explicit_stop_active === true,
      });
    } catch (error) {
      bootstrap = null;
      bootstrapError = true;
      log('dsh-plugin/companion-bootstrap-failed', { message: String(error?.message ?? error) });
    }
  }
  const bootstrapOutcomes = new Set([
    'STARTED_OWNER_VERIFIED', 'STARTED_OWNER_UNCONFIRMED',
    'ATTACHED_VERIFIED_OWNER', 'ATTACHED_LAUNCH_PENDING', 'ATTACHED_EXISTING_HUB', 'IN_FLIGHT',
  ]);
  const bootstrapOwnsLifecycle = bootstrap !== null
    && bootstrap.ok === true
    && bootstrapOutcomes.has(bootstrap.outcome);
  const legacyFallback = !bootstrapOwnsLifecycle && !bootstrapError
    && (bootstrap === null || ['NO_INSTALLATION', 'NOT_MANAGED'].includes(bootstrap.decision));
  const managedHub = config.manageHub === false || !legacyFallback
    ? null
    : createHubService({ log, ownerMode: config.hubOwnerMode, runtimeDir });
  if (managedHub !== null) {
    void managedHub.ensureStarted()
      .then((result) => log(result.ok ? 'dsh-plugin/hub-service-ready' : 'dsh-plugin/hub-not-owner', result))
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
  const pendingClientOutcomes = new Map();
  const deliveryHandler = createDeliveryHandler({ ctx, makeMessage, log, getClient: () => currentClient, pendingOutcomes: pendingClientOutcomes });

  let currentClient = null;
  const disposeHub = startHubLoop({
    clientFactory: () => new HubClient({
      host: hubOptions.host,
      port: hubOptions.port,
      token: readToken({ runtimeDir }),
      role: 'dsh',
      identity,
      capabilities: { client_requests_v1: true },
      logger: (event, detail) => log(`client/${event}`, detail),
    }),
    onDelivery: deliveryHandler,
    onClient: (client) => {
      currentClient = client;
      if (client !== null) void flushPendingOutcomes(client, pendingClientOutcomes, log);
    },
    log,
  });
  ctx.effect(() => disposeHub, 'local-agent-bridge.hub');
  const outcomeRetryTimer = setInterval(() => {
    if (currentClient !== null) void flushPendingOutcomes(currentClient, pendingClientOutcomes, log);
  }, 15_000);
  outcomeRetryTimer.unref?.();
  ctx.effect(() => () => clearInterval(outcomeRetryTimer), 'local-agent-bridge.client-outcomes');
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
        ...collectServiceStatus({ runtimeDir, installationRoot: pluginRuntime.installation === null ? null : pluginRuntime.installationRoot }),
        manage_hub_enabled: managedHub !== null,
        companion_bootstrap: bootstrap === null ? null : {
          decision: bootstrap.decision, outcome: bootstrap.outcome, ok: bootstrap.ok,
          reason_code: bootstrap.reason_code ?? null, explicit_stop_active: bootstrap.explicit_stop_active === true,
        },
        hub_client_connected: currentClient !== null && currentClient.closed !== true,
        managed_hub: managedHub === null ? null : managedHub.status(),
      }),
    });
    log('dsh-plugin/tools-registered', { identity, nativeDefineTool: defineTool !== undefined });
  } catch (error) {
    log('dsh-plugin/tool-registration-failed', { message: String(error?.message ?? error) });
  }
}
