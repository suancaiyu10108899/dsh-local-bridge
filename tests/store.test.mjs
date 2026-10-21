import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HubStore } from '../src/store.mjs';
import { PROTOCOL_VERSION, STATES } from '../src/protocol.mjs';

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-store-'));
  return { dir, stateFile: path.join(dir, 'state.json'), eventsFile: path.join(dir, 'events.jsonl') };
}

function envelope(overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    msg_id: 'm-store-1',
    from: 'dsh:session-a',
    to: 'codex:thread-a',
    kind: 'text',
    text: 'hello store',
    ttl_ms: 60_000,
    created_at: new Date().toISOString(),
    meta: {},
    ...overrides,
  };
}

function newStore(overrides = {}) {
  const paths = tempPaths();
  const clock = { now: Date.now() };
  const store = new HubStore({
    stateFile: paths.stateFile,
    eventsFile: paths.eventsFile,
    now: () => clock.now,
    ...overrides,
  }).load();
  return { store, paths, clock };
}

test('pairing targets are added, listed, disabled and persisted', () => {
  const { store, paths } = newStore();
  store.addTarget('dsh:session-a', { label: 'DSH A' });
  store.addTarget('codex:thread-a', { label: 'Codex A' });
  assert.equal(store.isPairedTarget('dsh:session-a'), true);
  assert.equal(store.roleOfPairedTarget('codex:thread-a'), 'codex');
  assert.equal(store.listTargets().length, 2);
  assert.throws(() => store.addTarget('cli:operator'), /cannot pair/);
  assert.equal(store.removeTarget('codex:thread-a'), true);
  assert.equal(store.isPairedTarget('codex:thread-a'), false);

  const reloaded = new HubStore({ stateFile: paths.stateFile, eventsFile: paths.eventsFile }).load();
  assert.equal(reloaded.isPairedTarget('dsh:session-a'), true);
  assert.equal(reloaded.isPairedTarget('codex:thread-a'), false);
});

test('enqueue dedupes identical msg_id and refuses conflicting reuse', () => {
  const { store } = newStore();
  store.addTarget('dsh:session-a');
  store.addTarget('codex:thread-a');
  const first = store.enqueue(envelope());
  assert.equal(first.duplicate, false);
  assert.equal(first.record.state, STATES.QUEUED);
  const duplicate = store.enqueue(envelope());
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.listMessages({ limit: 10 }).length, 1);
  const conflict = store.enqueue(envelope({ text: 'different text' }));
  assert.equal(conflict.conflict, true);
  assert.equal(store.listMessages({ limit: 10 }).length, 1);
});

test('state transitions are validated and survive reload', () => {
  const { store, paths } = newStore();
  store.addTarget('dsh:session-a');
  store.addTarget('codex:thread-a');
  store.enqueue(envelope());
  assert.throws(() => store.transition('m-store-1', STATES.DELIVERED), /cannot move/);
  store.transition('m-store-1', STATES.DELIVERING, { attempts: 1 });
  store.transition('m-store-1', STATES.DELIVERED, { delivered_at: new Date().toISOString() });
  assert.throws(() => store.transition('m-store-1', STATES.FAILED), /cannot move/);

  const reloaded = new HubStore({ stateFile: paths.stateFile, eventsFile: paths.eventsFile }).load();
  assert.equal(reloaded.getMessage('m-store-1').state, STATES.DELIVERED);
});

test('deliverableForRole only returns live paired messages for that role', () => {
  const { store } = newStore();
  store.addTarget('dsh:session-a');
  store.addTarget('codex:thread-a');
  store.enqueue(envelope({ msg_id: 'm-a1', to: 'codex:thread-a' }));
  store.enqueue(envelope({ msg_id: 'm-a2', to: 'dsh:session-a' }));
  store.enqueue(envelope({ msg_id: 'm-a3', to: 'codex:thread-a' }));
  store.transition('m-a3', STATES.DELIVERING, { attempts: 1 });
  const forCodex = store.deliverableForRole('codex').map((row) => row.msg_id);
  assert.deepEqual(forCodex, ['m-a1']);
  const forDsh = store.deliverableForRole('dsh').map((row) => row.msg_id);
  assert.deepEqual(forDsh, ['m-a2']);
});

test('sweep expires TTL messages and fails messages whose target was unpaired', () => {
  const { store, clock } = newStore();
  store.addTarget('dsh:session-a');
  store.addTarget('codex:thread-a');
  store.enqueue(envelope({ msg_id: 'm-ttl', to: 'dsh:session-a', ttl_ms: 1_000 }));
  store.enqueue(envelope({ msg_id: 'm-unpaired', to: 'codex:thread-a' }));
  clock.now += 2_000;
  store.removeTarget('codex:thread-a');
  const result = store.sweep();
  assert.equal(result.changed, 2);
  assert.equal(store.getMessage('m-ttl').state, STATES.EXPIRED);
  assert.equal(store.getMessage('m-unpaired').state, STATES.FAILED);
  assert.equal(store.getMessage('m-unpaired').last_error, 'target-unpaired');
});

test('terminal record pruning keeps the configured maximum', () => {
  const { store } = newStore({ maxTerminalRecords: 1 });
  store.addTarget('dsh:session-a');
  store.addTarget('codex:thread-a');
  for (const msgId of ['m-p1', 'm-p2', 'm-p3']) {
    store.enqueue(envelope({ msg_id: msgId }));
    store.transition(msgId, STATES.DELIVERING, { attempts: 1 });
    store.transition(msgId, STATES.DELIVERED, { delivered_at: new Date().toISOString() });
  }
  store.sweep();
  assert.equal(store.getMessage('m-p1'), undefined);
  assert.equal(store.getMessage('m-p2'), undefined);
  assert.equal(store.getMessage('m-p3').state, STATES.DELIVERED);
});

test('corrupt or unsupported state file fails loudly instead of silently resetting', () => {
  const paths = tempPaths();
  fs.writeFileSync(paths.stateFile, '{"v":99}', 'utf8');
  assert.throws(
    () => new HubStore({ stateFile: paths.stateFile, eventsFile: paths.eventsFile }).load(),
    /unsupported shape/,
  );
  fs.writeFileSync(paths.stateFile, 'not json', 'utf8');
  assert.throws(
    () => new HubStore({ stateFile: paths.stateFile, eventsFile: paths.eventsFile }).load(),
    /unreadable/,
  );
});
