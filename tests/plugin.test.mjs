import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_KIND,
  buildPeerMessage,
  confirmDurable,
  createDeliveryHandler,
  dslToJsonSchema,
  fallbackToolDefinition,
  registerTools,
  startHubLoop,
} from '../adapters/dsh/plugin.mjs';

function fakeHubMessage(overrides = {}) {
  return {
    v: 1,
    msg_id: 'm-peer-1',
    from: 'codex:11111111-1111-4111-8111-111111111111',
    to: 'dsh:session-22222222-2222-4222-8222-222222222222',
    kind: 'text',
    text: 'hello from a peer',
    ...overrides,
  };
}

function makeFakeCtx({ agents = new Map() } = {}) {
  const listeners = new Map();
  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) current.splice(index, 1);
      };
    },
    agents: {
      get(id) {
        return agents.get(id);
      },
    },
  };
  const emit = (event, ...args) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
  };
  return { ctx, emit, listeners };
}

test('source kind is a producer-owned kind accepted by native format v4', () => {
  assert.equal(typeof SOURCE_KIND, 'string');
  assert.notEqual(SOURCE_KIND.length, 0);
  assert.notEqual(SOURCE_KIND, 'plugin');
  assert.equal(SOURCE_KIND, 'local-agent-bridge/dsh');
});

test('buildPeerMessage creates a frozen user message with peer attribution', () => {
  const message = buildPeerMessage(fakeHubMessage(), undefined);
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, SOURCE_KIND);
  assert.equal(message.source.peer, 'codex:11111111-1111-4111-8111-111111111111');
  assert.equal(message.source.msg_id, 'm-peer-1');
  assert.equal(message.content[0].type, 'text');
  assert.equal(message.content[0].text, 'hello from a peer');
  assert.match(message.id, /^[0-9a-f-]{36}$/);
  assert.equal(Object.isFrozen(message), true);
  assert.equal(Object.isFrozen(message.content[0]), true);
});

test('buildPeerMessage prefers the native factory when provided', () => {
  const seen = [];
  const factory = (input) => {
    seen.push(input);
    return { id: 'native-id', role: 'user', ...input };
  };
  const message = buildPeerMessage(fakeHubMessage({ text: 'native path' }), factory);
  assert.equal(message.id, 'native-id');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].content[0].text, 'native path');
  assert.equal(seen[0].source.kind, SOURCE_KIND);
});

test('buildPeerMessage carries a declared peer origin in source metadata', () => {
  const message = buildPeerMessage(fakeHubMessage({ meta: { source: 'cli', origin: 'codex:thread-1' } }), undefined);
  assert.equal(message.source.peer, 'codex:11111111-1111-4111-8111-111111111111');
  assert.equal(message.source.origin, 'codex:thread-1');
  const plain = buildPeerMessage(fakeHubMessage(), undefined);
  assert.equal(Object.hasOwn(plain.source, 'origin'), false);
});

test('confirmDurable resolves true only for the injected message in a durable event', async () => {
  const { ctx, emit } = makeFakeCtx();
  const pending = confirmDurable({ ctx, sessionId: 'session-a', messageId: 'msg-7', timeoutMs: 1_000 });
  emit('session/event', { id: 'session-other' }, { type: 'agent/inbox/spliced', data: { inserted: [{ id: 'msg-7' }] } });
  emit('session/event', { id: 'session-a' }, { type: 'turn/start', data: { turn: 1 } });
  emit('session/event', { id: 'session-a' }, { type: 'agent/inbox/spliced', data: { inserted: [{ id: 'msg-8' }] } });
  let settled;
  void pending.then((value) => {
    settled = value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, undefined, 'must not settle for unrelated events');
  emit('session/event', { id: 'session-a' }, { type: 'agent/inbox/spliced', data: { inserted: [{ id: 'msg-7' }] } });
  assert.equal(await pending, true);
});

test('confirmDurable resolves false on timeout', async () => {
  const { ctx } = makeFakeCtx();
  const result = await confirmDurable({ ctx, sessionId: 'session-a', messageId: 'msg-x', timeoutMs: 20 });
  assert.equal(result, false);
});

test('delivery handler injects, waits for durability and acks ok', async () => {
  const followed = [];
  const agents = new Map();
  const { ctx, emit } = makeFakeCtx({ agents });
  agents.set('session-a', {
    followup(message) {
      followed.push(message);
      emit('session/event', { id: 'session-a' }, { type: 'agent/inbox/spliced', data: { inserted: [message] } });
    },
  });
  const acked = [];
  const handler = createDeliveryHandler({ ctx, makeMessage: (msg) => buildPeerMessage(msg, undefined), log: () => {} });
  await handler(fakeHubMessage({ to: 'dsh:session-a' }), { ack: (result) => acked.push(result) });
  assert.equal(followed.length, 1);
  assert.equal(acked.length, 1);
  assert.equal(acked[0].ok, true);
  assert.equal(acked[0].detail.session_id, 'session-a');
  assert.equal(acked[0].detail.message_id, followed[0].id);
});

test('delivery handler nacks unknown sessions as retryable and wrong roles as final', async () => {
  const { ctx } = makeFakeCtx();
  const acked = [];
  const handler = createDeliveryHandler({ ctx, makeMessage: (msg) => buildPeerMessage(msg, undefined), log: () => {} });

  await handler(fakeHubMessage({ to: 'dsh:session-missing' }), { ack: (result) => acked.push(result) });
  assert.deepEqual(acked[0], { ok: false, code: 'session-not-live', retryable: true });

  await handler(fakeHubMessage({ to: 'codex:thread-1' }), { ack: (result) => acked.push(result) });
  assert.deepEqual(acked[1], { ok: false, code: 'target-role-mismatch', retryable: false });
});

test('delivery handler refuses to claim success when durability is not observed', async () => {
  const agents = new Map();
  const { ctx } = makeFakeCtx({ agents });
  agents.set('session-a', { followup() { /* no durable event */ } });
  const acked = [];
  const handler = createDeliveryHandler({
    ctx,
    makeMessage: (msg) => buildPeerMessage(msg, undefined),
    log: () => {},
    durableTimeoutMs: 30,
  });
  await handler(fakeHubMessage({ to: 'dsh:session-a' }), { ack: (result) => acked.push(result) });
  assert.deepEqual(acked[0], { ok: false, code: 'durability-unconfirmed', retryable: false });
});

test('dslToJsonSchema converts the small parameter DSL to the supported schema subset', () => {
  const schema = dslToJsonSchema({
    to: { type: 'string', required: true, description: 'target' },
    text: { type: 'string', required: true },
    limit: { type: 'number', description: 'max' },
  });
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['to', 'text']);
  assert.deepEqual(schema.properties.to, { type: 'string', description: 'target' });
  assert.deepEqual(schema.properties.limit, { type: 'number', description: 'max' });
  assert.deepEqual(dslToJsonSchema({}), { type: 'object', properties: {} });
});

test('fallbackToolDefinition matches the ctx.tools.register contract and delegates execute', async () => {
  const spec = {
    name: 'bridge_targets',
    description: 'list targets',
    parameters: { limit: { type: 'number' } },
    async execute(args, exec) {
      return { ok: true, args, session: exec?.session ?? null };
    },
  };
  const definition = fallbackToolDefinition(spec);
  assert.equal(definition.name, 'bridge_targets');
  assert.equal(definition.description, 'list targets');
  assert.equal(definition.parameters.type, 'object');
  assert.equal(definition.output.schema.type, 'object');
  assert.equal(typeof definition.output.render, 'function');
  const rendered = definition.output.render({}, { ok: true, count: 2 });
  assert.deepEqual(rendered, [{ type: 'text', text: '{"ok":true,"count":2}' }]);
  const result = await definition.execute({ limit: 5 }, { session: 's-1' });
  assert.deepEqual(result, { ok: true, args: { limit: 5 }, session: 's-1' });
});

function fakeHubClient(behaviour = {}) {
  const client = {
    identity: 'dsh:host-test',
    welcome: { server: { server_id: 'hub-test' } },
    closed: false,
    connectCalls: 0,
    onDeliveryHandler: null,
    closeHandlers: [],
    async connect() {
      client.connectCalls += 1;
      if (behaviour.failFirst !== undefined && client.connectCalls <= behaviour.failFirst) {
        throw new Error('connect-refused');
      }
    },
    async close() {
      client.closed = true;
      client.triggerClose();
    },
    onDelivery(handler) {
      client.onDeliveryHandler = handler;
    },
    onFrame() {},
    onClose(handler) {
      client.closeHandlers.push(handler);
      return () => {
        const index = client.closeHandlers.indexOf(handler);
        if (index >= 0) client.closeHandlers.splice(index, 1);
      };
    },
    triggerClose() {
      for (const handler of [...client.closeHandlers]) handler();
    },
  };
  return client;
}

test('hub loop connects, exposes the client and disposes cleanly', async () => {
  const client = fakeHubClient();
  const seen = [];
  const dispose = startHubLoop({
    clientFactory: () => client,
    onDelivery: () => {},
    onClient: (value) => seen.push(value),
    log: () => {},
    delayMs: 20,
  });
  const deadline = Date.now() + 1_000;
  while ((client.connectCalls === 0 || client.onDeliveryHandler === null) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(client.connectCalls, 1);
  assert.equal(client.onDeliveryHandler instanceof Function, true);
  assert.equal(seen[0], client);
  await dispose();
  assert.equal(seen.at(-1), null);
});

test('hub loop retries after a failed connection attempt', async () => {
  const client = fakeHubClient({ failFirst: 1 });
  const seen = [];
  const dispose = startHubLoop({
    clientFactory: () => client,
    onDelivery: () => {},
    onClient: (value) => seen.push(value),
    log: () => {},
    delayMs: 20,
  });
  const deadline = Date.now() + 2_000;
  while ((client.connectCalls < 2 || !seen.includes(client)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(client.connectCalls >= 2, true);
  assert.equal(seen.includes(client), true);
  await dispose();
  assert.equal(seen.at(-1), null);
});

test('hub loop reconnects after an established connection is lost', async () => {
  const first = fakeHubClient();
  const second = fakeHubClient();
  const pending = [first, second];
  const created = [];
  const seen = [];
  const dispose = startHubLoop({
    clientFactory: () => {
      const client = pending.length > 0 ? pending.shift() : fakeHubClient();
      created.push(client);
      return client;
    },
    onDelivery: () => {},
    onClient: (value) => seen.push(value),
    log: () => {},
    delayMs: 15,
  });
  const deadline = Date.now() + 2_000;
  while (first.onDeliveryHandler === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(seen[0], first);

  first.triggerClose();
  while ((created.length < 2 || !seen.includes(second)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(created.length >= 2, true);
  assert.equal(seen.includes(second), true);
  assert.equal(seen.at(-1), second);
  await dispose();
  assert.equal(seen.at(-1), null);
});


test('client request is claimed and begun before DSH followup, then reports native outcome', async () => {
  const order = [];
  const agents = new Map();
  const { ctx, emit } = makeFakeCtx({ agents });
  agents.set('session-a', {
    followup(message) {
      order.push('followup');
      emit('session/event', { id: 'session-a' }, { type: 'agent/inbox/spliced', data: { inserted: [message] } });
    },
  });
  const fakeClient = {
    closed: false,
    async clientClaim(args) {
      order.push('claim');
      assert.equal(args.clientIdentity, 'client:dot-22222222-2222-4222-8222-222222222222');
      assert.equal(args.targetIdentity, 'dsh:session-a');
      assert.equal(args.requestMsgId, 'm-client-1');
      return { request: { state: 'CLAIMED' }, lease: { id: 'lease-1', fencing_token: 'fence-1' } };
    },
    async clientBegin(args) {
      order.push('begin');
      assert.equal(args.leaseId, 'lease-1');
      assert.equal(args.fencingToken, 'fence-1');
      return { request: { state: 'SUBMITTING' } };
    },
    async clientOutcome(args) {
      order.push(`outcome:${args.outcome}`);
      assert.equal(args.nativeQueueId !== null, true);
      return { ok: true };
    },
  };
  const acked = [];
  const handler = createDeliveryHandler({
    ctx,
    makeMessage: (msg) => buildPeerMessage(msg, undefined),
    log: () => {},
    getClient: () => fakeClient,
  });
  await handler(fakeHubMessage({
    msg_id: 'm-client-1',
    from: 'client:dot-22222222-2222-4222-8222-222222222222',
    to: 'dsh:session-a',
    meta: { client_request_id: 'business-client-1', reply_to: 'client:dot-22222222-2222-4222-8222-222222222222' },
  }), { ack: (result) => acked.push(result) });
  assert.deepEqual(order.slice(0, 3), ['claim', 'begin', 'followup']);
  assert.equal(order[3], 'outcome:NATIVE_QUEUED');
  assert.equal(acked[0].ok, true);
});

test('client gate failure does not inject a DSH followup and is a known no-native ack', async () => {
  const followed = [];
  const agents = new Map();
  const { ctx } = makeFakeCtx({ agents });
  agents.set('session-a', { followup(message) { followed.push(message); } });
  const fakeClient = {
    closed: false,
    async clientClaim() { throw Object.assign(new Error('grant revoked'), { code: 'client-grant-revoked' }); },
  };
  const acked = [];
  const handler = createDeliveryHandler({
    ctx,
    makeMessage: (msg) => buildPeerMessage(msg, undefined),
    log: () => {},
    getClient: () => fakeClient,
  });
  await handler(fakeHubMessage({
    msg_id: 'm-client-2', from: 'client:dot-22222222-2222-4222-8222-222222222222',
    to: 'dsh:session-a', meta: { client_request_id: 'business-client-2' },
  }), { ack: (result) => acked.push(result) });
  assert.equal(followed.length, 0);
  assert.equal(acked[0].ok, false);
  assert.equal(acked[0].no_native, true);
  assert.equal(acked[0].code, 'client-grant-revoked');
});
test('bridge_client_reply uses the DSH session target and a real supplied turn id', async () => {
  const tools = [];
  const calls = [];
  const ctx = { tools: { register(definition) { tools.push(definition); } } };
  const fakeClient = {
    closed: false,
    async clientReply(args) { calls.push(args); return { ok: true, idempotent: false, request: { request_id: args.clientRequestId }, reply: { reply_msg_id: 'reply-1', turn_id: args.turnId } }; },
  };
  registerTools({ ctx, defineTool: undefined, identity: 'dsh:host:test', getClient: () => fakeClient, getServiceStatus: () => ({}) });
  const tool = tools.find((entry) => entry.name === 'bridge_client_reply');
  assert.ok(tool);
  const exec = { agent: { session: { id: 'session-a' } } };
  const blocked = await tool.execute({ client_identity: 'client:dot-22222222-2222-4222-8222-222222222222', client_request_id: 'business-1', request_msg_id: 'm-1', body: 'reply' }, exec);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'turn-id-required');
  const result = await tool.execute({ client_identity: 'client:dot-22222222-2222-4222-8222-222222222222', client_request_id: 'business-1', request_msg_id: 'm-1', turn_id: '44444444-4444-4444-8444-444444444444', body: 'reply' }, exec);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].targetIdentity, 'dsh:session-a');
  assert.equal(calls[0].requestMsgId, 'm-1');
  assert.equal(calls[0].turnId, '44444444-4444-4444-8444-444444444444');
});
test('followup throwing after inbox side effect is UNCERTAIN and is not retried', async () => {
  const followed = [];
  const agents = new Map();
  const { ctx, emit } = makeFakeCtx({ agents });
  agents.set('session-a', {
    followup(message) {
      followed.push(message);
      emit('session/event', { id: 'session-a' }, { type: 'agent/inbox/spliced', data: { inserted: [message] } });
      throw new Error('side effect already applied');
    },
  });
  const outcomes = [];
  const fakeClient = {
    closed: false,
    async clientClaim() { return { request: { state: 'CLAIMED' }, lease: { id: 'lease-t', fencing_token: 'fence-t' } }; },
    async clientBegin() { return { request: { state: 'SUBMITTING' } }; },
    async clientOutcome(args) { outcomes.push(args); return { ok: true }; },
  };
  const acked = [];
  const handler = createDeliveryHandler({
    ctx, makeMessage: (msg) => buildPeerMessage(msg, undefined), log: () => {}, getClient: () => fakeClient,
  });
  await handler(fakeHubMessage({
    msg_id: 'm-client-uncertain-throw', from: 'client:dot-22222222-2222-4222-8222-222222222222',
    to: 'dsh:session-a', meta: { client_request_id: 'business-uncertain-throw' },
  }), { ack: (result) => acked.push(result) });
  assert.equal(followed.length, 1);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, 'UNCERTAIN');
  assert.equal(outcomes[0].nativeQueueId, null);
  assert.equal(acked[0].ok, false);
  assert.equal(acked[0].code, 'followup-uncertain');
  assert.equal(acked[0].retryable, false);
  assert.equal(acked[0].no_native, undefined);
});