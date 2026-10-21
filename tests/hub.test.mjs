import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HubStore } from '../src/store.mjs';
import { BridgeHub } from '../src/hub.mjs';
import { HubClient } from '../src/client.mjs';
import { STATES } from '../src/protocol.mjs';

const TOKEN = 'test-token-'.padEnd(64, 'x');
const HOST = '127.0.0.1';

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-hub-'));
  return { dir, stateFile: path.join(dir, 'state.json'), eventsFile: path.join(dir, 'events.jsonl') };
}

async function startHub(t, { ackTimeoutMs = 5_000, maxAttempts = 5, paths = tempPaths() } = {}) {
  const store = new HubStore({ stateFile: paths.stateFile, eventsFile: paths.eventsFile }).load();
  const hub = new BridgeHub({ store, token: TOKEN, host: HOST, port: 0, ackTimeoutMs, maxAttempts });
  const address = await hub.start();
  t.after(async () => {
    await hub.stop();
  });
  return { hub, store, address, paths };
}

function makeClient(addr, role, identity, token = TOKEN) {
  return new HubClient({ host: HOST, port: addr.port, token, role, identity });
}

async function connectAll(t, addr) {
  const cli = makeClient(addr, 'cli', 'cli:operator');
  const dsh = makeClient(addr, 'dsh', 'dsh:host-test');
  const codex = makeClient(addr, 'codex', 'codex:host-test');
  await Promise.all([cli.connect(), dsh.connect(), codex.connect()]);
  t.after(async () => {
    await Promise.allSettled([cli.close(), dsh.close(), codex.close()]);
  });
  return { cli, dsh, codex };
}

function envelope(overrides = {}) {
  return {
    v: 1,
    msg_id: 'm-test-1',
    from: 'dsh:session-1',
    to: 'codex:thread-1',
    kind: 'text',
    text: 'hello from dsh',
    ...overrides,
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 4_000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('paired exact delivery reaches delivered after an adapter ACK', async (t) => {
  const { address } = await startHub(t);
  const { cli, dsh, codex } = await connectAll(t, address);
  await cli.pairAdd('dsh:session-1', { label: 'DSH test session' });
  await cli.pairAdd('codex:thread-1', { label: 'Codex test thread' });

  const received = [];
  codex.onDelivery((message, delivery) => {
    received.push(message);
    delivery.ack({ ok: true });
  });

  const accepted = await dsh.sendMessage(envelope());
  assert.equal(accepted.type, 'accepted');
  assert.equal(accepted.state, STATES.QUEUED);
  await waitFor(() => received.length === 1, { label: 'codex delivery' });
  assert.equal(received[0].text, 'hello from dsh');
  assert.equal(received[0].msg_id, 'm-test-1');
  assert.equal(received[0].from, 'dsh:session-1');
  await waitFor(async () => (await cli.status('m-test-1'))?.state === STATES.DELIVERED, { label: 'delivered state' });
});

test('unpaired targets and unpaired senders are rejected without enqueue', async (t) => {
  const { address } = await startHub(t);
  const { cli, dsh } = await connectAll(t, address);
  await cli.pairAdd('dsh:session-1');
  await cli.pairAdd('codex:thread-1');

  await assert.rejects(
    dsh.sendMessage(envelope({ to: 'codex:thread-unknown' })),
    (error) => error.code === 'target-unpaired',
  );
  await assert.rejects(
    dsh.sendMessage(envelope({ from: 'dsh:session-unpaired' })),
    (error) => error.code === 'source-unpaired',
  );
  await assert.rejects(
    dsh.sendMessage(envelope({ to: 'cli:operator' })),
    (error) => error.code === 'rejected' || error.details?.type === 'rejected',
  );
  assert.equal((await cli.statusList({ limit: 50 })).length, 0);
});

test('messages queue while the target adapter is absent and deliver on connect', async (t) => {
  const { address } = await startHub(t);
  const cli = makeClient(address, 'cli', 'cli:operator');
  const dsh = makeClient(address, 'dsh', 'dsh:host-test');
  t.after(async () => {
    await Promise.allSettled([cli.close(), dsh.close()]);
  });
  await Promise.all([cli.connect(), dsh.connect()]);
  await cli.pairAdd('dsh:session-1');
  await cli.pairAdd('codex:thread-1');

  const accepted = await dsh.sendMessage(envelope({ msg_id: 'm-queued-1' }));
  assert.equal(accepted.type, 'accepted');
  const queued = await cli.status('m-queued-1');
  assert.equal(queued.state, STATES.QUEUED);

  const codex = makeClient(address, 'codex', 'codex:host-test');
  t.after(async () => {
    await codex.close();
  });
  const received = [];
  codex.onDelivery((message, delivery) => {
    received.push(message);
    delivery.ack({ ok: true });
  });
  await codex.connect();
  await waitFor(() => received.length === 1, { label: 'delivery after connect' });
  await waitFor(async () => (await cli.status('m-queued-1'))?.state === STATES.DELIVERED, { label: 'delivered state' });
});

test('duplicate msg_id is idempotent and conflicting content is rejected', async (t) => {
  const { address } = await startHub(t);
  const { cli, dsh, codex } = await connectAll(t, address);
  await cli.pairAdd('dsh:session-1');
  await cli.pairAdd('codex:thread-1');
  let deliveries = 0;
  codex.onDelivery((_message, delivery) => {
    deliveries += 1;
    delivery.ack({ ok: true });
  });

  const first = await dsh.sendMessage(envelope({ msg_id: 'm-dup-1' }));
  assert.equal(first.duplicate, false);
  await waitFor(() => deliveries === 1, { label: 'first delivery' });
  const second = await dsh.sendMessage(envelope({ msg_id: 'm-dup-1' }));
  assert.equal(second.duplicate, true);
  await sleep(100);
  assert.equal(deliveries, 1);
  await assert.rejects(
    dsh.sendMessage(envelope({ msg_id: 'm-dup-1', text: 'changed text' })),
    (error) => error.code === 'msg-id-conflict',
  );
  assert.equal((await cli.statusList({ limit: 50 })).length, 1);
});

test('retryable nack becomes visible delivery_unknown and is retried', async (t) => {
  const { address } = await startHub(t, { ackTimeoutMs: 5_000 });
  const { cli, dsh, codex } = await connectAll(t, address);
  await cli.pairAdd('dsh:session-1');
  await cli.pairAdd('codex:thread-1');
  let attempts = 0;
  codex.onDelivery((_message, delivery) => {
    attempts += 1;
    if (attempts === 1) {
      delivery.ack({ ok: false, code: 'codex-busy', retryable: true });
      return;
    }
    delivery.ack({ ok: true });
  });

  await dsh.sendMessage(envelope({ msg_id: 'm-retry-1' }));
  await waitFor(async () => (await cli.status('m-retry-1'))?.state === STATES.DELIVERY_UNKNOWN, { label: 'delivery_unknown state' });
  const unknown = await cli.status('m-retry-1');
  assert.equal(unknown.last_error, 'codex-busy');
  assert.equal(unknown.attempts, 1);
  await waitFor(() => attempts >= 2, { timeoutMs: 8_000, label: 'retry attempt' });
  await waitFor(async () => (await cli.status('m-retry-1'))?.state === STATES.DELIVERED, { timeoutMs: 8_000, label: 'delivered after retry' });
});

test('adapter disconnect during an unacknowledged delivery stays visible and redelivers', async (t) => {
  const { address } = await startHub(t, { ackTimeoutMs: 200 });
  const { cli, dsh, codex } = await connectAll(t, address);
  await cli.pairAdd('dsh:session-1');
  await cli.pairAdd('codex:thread-1');
  codex.onDelivery(() => {
    /* never ack: simulate a hung adapter */
  });
  await dsh.sendMessage(envelope({ msg_id: 'm-hung-1' }));
  await waitFor(async () => (await cli.status('m-hung-1'))?.state === STATES.DELIVERY_UNKNOWN, { label: 'ack timeout visible' });
  const unknown = await cli.status('m-hung-1');
  assert.equal(unknown.last_error, 'ack-timeout');
  await codex.close();

  const replacement = makeClient(address, 'codex', 'codex:host-test');
  t.after(async () => {
    await replacement.close();
  });
  const received = [];
  replacement.onDelivery((message, delivery) => {
    received.push(message);
    delivery.ack({ ok: true });
  });
  await replacement.connect();
  await waitFor(() => received.length === 1, { timeoutMs: 8_000, label: 'redelivery after reconnect' });
  await waitFor(async () => (await cli.status('m-hung-1'))?.state === STATES.DELIVERED, { timeoutMs: 8_000, label: 'delivered after reconnect' });
});

test('a second adapter of the same role supersedes the first', async (t) => {
  const { hub, address } = await startHub(t);
  const first = makeClient(address, 'dsh', 'dsh:host-first');
  t.after(async () => {
    await first.close();
  });
  await first.connect();
  const second = makeClient(address, 'dsh', 'dsh:host-second');
  t.after(async () => {
    await second.close();
  });
  await second.connect();
  await waitFor(() => first.closed === true, { label: 'first adapter closed' });
  assert.deepEqual(hub.connectedRoles(), ['dsh']);
});

test('wrong pairing token is rejected', async (t) => {
  const { address } = await startHub(t);
  const impostor = makeClient(address, 'dsh', 'dsh:host-impostor', 'wrong-token');
  t.after(async () => {
    await impostor.close();
  });
  await assert.rejects(
    impostor.connect(),
    (error) => error.code === 'auth-failed' || error.code === 'connection-closed',
  );
});

test('hub restart recovers queued messages and pairing state', async (t) => {
  const paths = tempPaths();
  const { address, hub } = await startHub(t, { paths });
  const cli = makeClient(address, 'cli', 'cli:operator');
  const dsh = makeClient(address, 'dsh', 'dsh:host-test');
  t.after(async () => {
    await Promise.allSettled([cli.close(), dsh.close()]);
  });
  await Promise.all([cli.connect(), dsh.connect()]);
  await cli.pairAdd('dsh:session-1');
  await cli.pairAdd('codex:thread-1');
  await dsh.sendMessage(envelope({ msg_id: 'm-restart-1' }));
  const queued = await cli.status('m-restart-1');
  assert.equal(queued.state, STATES.QUEUED);
  await hub.stop();
  await Promise.allSettled([cli.close(), dsh.close()]);

  const store2 = new HubStore({ stateFile: paths.stateFile, eventsFile: paths.eventsFile }).load();
  const hub2 = new BridgeHub({ store: store2, token: TOKEN, host: HOST, port: 0, ackTimeoutMs: 5_000 });
  const address2 = await hub2.start();
  t.after(async () => {
    await hub2.stop();
  });

  const cli2 = makeClient(address2, 'cli', 'cli:operator');
  const codex2 = makeClient(address2, 'codex', 'codex:host-test');
  t.after(async () => {
    await Promise.allSettled([cli2.close(), codex2.close()]);
  });
  const received = [];
  codex2.onDelivery((message, delivery) => {
    received.push(message);
    delivery.ack({ ok: true });
  });
  await Promise.all([cli2.connect(), codex2.connect()]);
  await waitFor(() => received.length === 1, { label: 'delivery after hub restart' });
  await waitFor(async () => (await cli2.status('m-restart-1'))?.state === STATES.DELIVERED, { label: 'delivered after restart' });
  assert.equal(received[0].msg_id, 'm-restart-1');
});

test('adapter cannot change pairing and gets a correlated error', async (t) => {
  const { address } = await startHub(t);
  const { dsh } = await connectAll(t, address);
  const response = await dsh.request({ type: 'pair-add', identity: 'codex:thread-9', label: 'sneaky' });
  assert.equal(response.type, 'error');
  assert.equal(response.code, 'forbidden');
});

test('roles-query reports connected adapter roles', async (t) => {
  const { address } = await startHub(t);
  const { cli, codex } = await connectAll(t, address);
  const roles = await cli.roles();
  assert.deepEqual([...roles].sort(), ['codex', 'dsh']);
  await codex.close();
  await waitFor(async () => !(await cli.roles()).includes('codex'), { label: 'codex role removal' });
});

test('operator can consume a message for a role without a connected adapter', async (t) => {
  const { address } = await startHub(t);
  const cli = makeClient(address, 'cli', 'cli:operator');
  const dsh = makeClient(address, 'dsh', 'dsh:host-test');
  t.after(async () => {
    await Promise.allSettled([cli.close(), dsh.close()]);
  });
  await Promise.all([cli.connect(), dsh.connect()]);
  await cli.pairAdd('dsh:session-1');
  await cli.pairAdd('codex:thread-1');
  await dsh.sendMessage(envelope({ msg_id: 'm-consume-1' }));
  const queued = await cli.status('m-consume-1');
  assert.equal(queued.state, STATES.QUEUED);

  const consumed = await cli.consume('m-consume-1', { consumer: 'codex:thread-1', note: 'delivered by active Codex consumer' });
  assert.equal(consumed.state, STATES.DELIVERED);
  assert.equal(consumed.consumed_by, 'codex:thread-1');
  assert.equal(consumed.consume_note, 'delivered by active Codex consumer');
  await assert.rejects(
    cli.consume('m-consume-1', { consumer: 'codex:thread-1' }),
    (error) => error.code === 'message-not-consumable',
  );
});

test('consume is refused while the target adapter is connected', async (t) => {
  const { address } = await startHub(t);
  const { cli, dsh, codex } = await connectAll(t, address);
  await cli.pairAdd('dsh:session-1');
  await cli.pairAdd('codex:thread-1');
  codex.onDelivery((_message, delivery) => delivery.ack({ ok: true }));
  await dsh.sendMessage(envelope({ msg_id: 'm-consume-2' }));
  await waitFor(async () => (await cli.status('m-consume-2'))?.state === STATES.DELIVERED, { label: 'auto delivery' });
  await assert.rejects(
    cli.consume('m-consume-2', { consumer: 'codex:thread-1' }),
    (error) => error.code === 'message-not-consumable' || error.code === 'adapter-connected',
  );
});

test('session-not-live nacks defer a cold-session message without exhausting attempts', async (t) => {
  const { address } = await startHub(t, { maxAttempts: 2, ackTimeoutMs: 5_000 });
  const { cli, dsh } = await connectAll(t, address);
  await cli.pairAdd('dsh:session-cold');
  dsh.onDelivery((_message, delivery) => delivery.ack({ ok: false, code: 'session-not-live', retryable: true }));

  await cli.sendMessage({
    v: 1,
    msg_id: 'm-cold-defer-1',
    from: 'cli:operator',
    to: 'dsh:session-cold',
    kind: 'text',
    text: 'deliver when the session is attached',
  });

  const first = await waitFor(async () => {
    const record = await cli.status('m-cold-defer-1');
    return record !== undefined && (record.deferrals ?? 0) >= 1 ? record : undefined;
  }, { label: 'first deferral' });
  assert.equal(first.state, STATES.DELIVERY_UNKNOWN);
  assert.equal(first.last_error, 'session-not-live');

  const later = await waitFor(async () => {
    const record = await cli.status('m-cold-defer-1');
    return record !== undefined && (record.deferrals ?? 0) >= 2 ? record : undefined;
  }, { timeoutMs: 9_000, label: 'second deferral' });
  assert.equal(later.state, STATES.DELIVERY_UNKNOWN, 'cold session must stay queued, not fail');
  assert.equal(later.attempts <= 2, true, 'deferrals must not consume the attempt budget');
  assert.equal(later.last_error, 'session-not-live');
});
