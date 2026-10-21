import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_KIND,
  buildPeerMessage,
  confirmDurable,
  createDeliveryHandler,
  dslToJsonSchema,
  fallbackToolDefinition,
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

