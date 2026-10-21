import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConversationGuard,
  DEFAULT_MAX_CHAIN_MS,
  DEFAULT_MAX_MODEL_TURNS,
  GuardError,
} from '../src/conversation-guard.mjs';

function guardWithClock(start = 1_000_000) {
  let now = start;
  const guard = new ConversationGuard({ now: () => now });
  return { guard, advance: (ms) => { now += ms; return now; }, now: () => now };
}

test('auto-reply defaults to OFF: a model reply is never admitted unless the human opted in', async () => {
  const { guard } = guardWithClock();
  guard.startChain({ chainId: 'c1', rootMsgId: 'm-root' });
  const result = guard.admit({ chainId: 'c1', msgId: 'm-model-1', parentMsgId: 'm-root' });
  assert.equal(result.admit, false);
  assert.equal(result.reason, 'auto-reply-disabled');
  assert.equal(result.wake, false);
});

test('ACK never wakes a model and never consumes a model turn', async () => {
  const { guard } = guardWithClock();
  guard.startChain({ chainId: 'c1', rootMsgId: 'm-root', autoReply: true });
  const ack = guard.admitAck({ chainId: 'c1', msgId: 'm-ack-1' });
  assert.equal(ack.admit, true);
  assert.equal(ack.wake, false);
  assert.equal(ack.countTurn, false);
  assert.equal(guard.snapshot('c1').modelTurns, 0);
});

test('duplicate msg_id is a re-entry: not delivered and flagged as reentry', async () => {
  const { guard } = guardWithClock();
  guard.startChain({ chainId: 'c1', rootMsgId: 'm-root', autoReply: true });
  const first = guard.admit({ chainId: 'c1', msgId: 'm-1', parentMsgId: 'm-root' });
  assert.equal(first.admit, true);
  const replay = guard.admit({ chainId: 'c1', msgId: 'm-1', parentMsgId: 'm-root' });
  assert.equal(replay.admit, false);
  assert.equal(replay.reason, 'duplicate-message');
  assert.equal(replay.reentry, true);
  assert.equal(replay.deliver, false);
});

test('model messages require a correlation parent that exists in the chain', async () => {
  const { guard } = guardWithClock();
  guard.startChain({ chainId: 'c1', rootMsgId: 'm-root', autoReply: true });
  const missing = guard.admit({ chainId: 'c1', msgId: 'm-1' });
  assert.equal(missing.admit, false);
  assert.equal(missing.reason, 'missing-correlation');
  const unknownParent = guard.admit({ chainId: 'c1', msgId: 'm-2', parentMsgId: 'm-not-seen' });
  assert.equal(unknownParent.admit, false);
  assert.equal(unknownParent.reason, 'missing-correlation');
});

test('model-turn quota closes the chain after the default four model turns', async () => {
  const { guard } = guardWithClock();
  guard.startChain({ chainId: 'c1', rootMsgId: 'm-root', autoReply: true });
  let parent = 'm-root';
  for (let index = 1; index <= DEFAULT_MAX_MODEL_TURNS; index += 1) {
    const turned = guard.admit({ chainId: 'c1', msgId: `m-${index}`, parentMsgId: parent });
    assert.equal(turned.admit, true, `turn ${index} should be admitted`);
    parent = `m-${index}`;
  }
  const over = guard.admit({ chainId: 'c1', msgId: 'm-over', parentMsgId: parent });
  assert.equal(over.admit, false);
  assert.equal(over.reason, 'turn-quota');
  assert.equal(guard.snapshot('c1').closedReason, 'turn-quota');
});

test('wall-clock quota closes the chain at the configured 120s boundary', async () => {
  const { guard, advance } = guardWithClock();
  guard.startChain({ chainId: 'c1', rootMsgId: 'm-root', autoReply: true });
  advance(DEFAULT_MAX_CHAIN_MS + 1);
  const late = guard.admit({ chainId: 'c1', msgId: 'm-late', parentMsgId: 'm-root' });
  assert.equal(late.admit, false);
  assert.equal(late.reason, 'time-quota');
  assert.equal(guard.snapshot('c1').closedReason, 'time-quota');
});

test('human close stops the chain and is idempotent', async () => {
  const { guard } = guardWithClock();
  guard.startChain({ chainId: 'c1', rootMsgId: 'm-root', autoReply: true });
  const closed = guard.close('c1', 'closed-by-human');
  assert.equal(closed.closedReason, 'closed-by-human');
  const again = guard.close('c1', 'ignored');
  assert.equal(again.closedReason, 'closed-by-human');
  const after = guard.admit({ chainId: 'c1', msgId: 'm-after', parentMsgId: 'm-root' });
  assert.equal(after.admit, false);
});

test('state round-trips durably: correlation, dedup and turn count survive', async () => {
  const { guard, now } = guardWithClock();
  guard.startChain({ chainId: 'c1', rootMsgId: 'm-root', autoReply: true });
  guard.admit({ chainId: 'c1', msgId: 'm-1', parentMsgId: 'm-root' });
  const restored = ConversationGuard.fromJSON(JSON.parse(JSON.stringify(guard.toJSON())), { now });
  const snapshot = restored.snapshot('c1');
  assert.equal(snapshot.modelTurns, 1);
  assert.equal(snapshot.autoReply, true);
  const replay = restored.admit({ chainId: 'c1', msgId: 'm-1', parentMsgId: 'm-root' });
  assert.equal(replay.reentry, true);
  const next = restored.admit({ chainId: 'c1', msgId: 'm-2', parentMsgId: 'm-1' });
  assert.equal(next.admit, true);
});

test('an uncorrelated human follow-up does not become a fresh model instruction', async () => {
  const { guard } = guardWithClock();
  guard.startChain({ chainId: 'c1', rootMsgId: 'm-root', autoReply: true });
  // A human-origin message may open a turn only with correlation as well.
  const humanUncorrelated = guard.admit({ chainId: 'c1', msgId: 'm-human-1', origin: 'human' });
  assert.equal(humanUncorrelated.admit, true, 'human messages are allowed without parent correlation');
  const modelFresh = guard.admit({ chainId: 'c1', msgId: 'm-model-x', parentMsgId: 'm-human-1' });
  assert.equal(modelFresh.admit, true);
  // Replayed input is a re-entry, never re-enqueued as a fresh instruction.
  const replay = guard.admit({ chainId: 'c1', msgId: 'm-human-1', origin: 'human' });
  assert.equal(replay.admit, false);
  assert.equal(replay.reentry, true);
});

test('invalid configuration, unknown chains and empty ids are explicit errors', async () => {
  assert.throws(() => new ConversationGuard({ maxModelTurns: 0 }), (error) => error instanceof GuardError && error.code === 'guard-invalid-config');
  const guard = new ConversationGuard();
  assert.throws(() => guard.snapshot('missing'), (error) => error.code === 'guard-unknown-chain');
  assert.throws(() => guard.startChain({ chainId: '', rootMsgId: 'm-root' }), (error) => error.code === 'guard-invalid-argument');
  guard.startChain({ chainId: 'c1', rootMsgId: 'm-root' });
  assert.throws(() => guard.startChain({ chainId: 'c1', rootMsgId: 'm-root' }), (error) => error.code === 'guard-chain-exists');
});

test('seen-id set is bounded while recent dedup still works', async () => {
  const { guard } = guardWithClock();
  const small = new ConversationGuard({ maxSeenIds: 3, maxModelTurns: 10, now: () => 1_000_000 });
  small.startChain({ chainId: 'c1', rootMsgId: 'm-root', autoReply: true });
  let parent = 'm-root';
  for (let index = 1; index <= 5; index += 1) {
    small.admit({ chainId: 'c1', msgId: `m-${index}`, parentMsgId: parent });
    parent = `m-${index}`;
  }
  const recent = small.admit({ chainId: 'c1', msgId: 'm-5', parentMsgId: parent });
  assert.equal(recent.reentry, true);
  assert.equal(guard.list().length, 0);
  assert.ok(small.toJSON().chains[0].seenMsgIds.length <= 3);
});
