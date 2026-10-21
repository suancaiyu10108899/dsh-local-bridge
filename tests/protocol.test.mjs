import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  STATES,
  canTransition,
  createFrameDecoder,
  dshIdentity,
  encodeFrame,
  identityRole,
  isValidIdentity,
  newMessageId,
  tokenEquals,
  validateEnvelope,
} from '../src/protocol.mjs';

function baseEnvelope(overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    msg_id: 'm-abc-1',
    from: 'dsh:session-test',
    to: 'codex:thread-test',
    kind: 'text',
    text: 'hello',
    ...overrides,
  };
}

test('identity helpers parse and reject identities', () => {
  assert.equal(identityRole('dsh:session-a'), 'dsh');
  assert.equal(identityRole('codex:11111111-1111-4111-8111-111111111111'), 'codex');
  assert.equal(identityRole('cli:operator'), 'cli');
  assert.equal(identityRole('nope'), undefined);
  assert.equal(identityRole(''), undefined);
  assert.equal(isValidIdentity('dsh:session-22222222-2222-4222-8222-222222222222'), true);
  assert.equal(isValidIdentity('dsh:'), false);
  assert.equal(isValidIdentity('unknown:thing'), false);
  assert.equal(dshIdentity('session-x'), 'dsh:session-x');
});

test('validateEnvelope accepts a well-formed message and fills defaults', () => {
  const result = validateEnvelope(baseEnvelope());
  assert.equal(result.ok, true);
  assert.equal(result.envelope.msg_id, 'm-abc-1');
  assert.equal(result.envelope.ttl_ms, 24 * 60 * 60 * 1000);
  assert.equal(result.envelope.kind, 'text');
  assert.equal(typeof result.envelope.created_at, 'string');
  const generated = validateEnvelope(baseEnvelope({ msg_id: undefined }));
  assert.equal(generated.ok, true);
  assert.match(generated.envelope.msg_id, /^m-/);
});

test('validateEnvelope rejects malformed messages with explicit codes', () => {
  const cases = [
    [{ v: 2 }, 'version-unsupported'],
    [{ to: 'codex:' }, 'target-invalid'],
    [{ from: 'bogus' }, 'source-invalid'],
    [{ to: 'cli:operator' }, 'target-invalid'],
    [{ kind: 'image' }, 'kind-unsupported'],
    [{ text: '   ' }, 'text-empty'],
    [{ text: 42 }, 'text-empty'],
    [{ text: 'x'.repeat(65 * 1024) }, 'text-too-large'],
    [{ msg_id: 'has space' }, 'msg-id-invalid'],
    [{ msg_id: '-leading' }, 'msg-id-invalid'],
    [{ ttl_ms: 0 }, 'ttl-invalid'],
    [{ ttl_ms: 31 * 24 * 60 * 60 * 1000 }, 'ttl-invalid'],
    [{ meta: [] }, 'meta-invalid'],
  ];
  for (const [patch, code] of cases) {
    const result = validateEnvelope(baseEnvelope(patch));
    assert.equal(result.ok, false, `${JSON.stringify(patch)} should be rejected`);
    assert.equal(result.code, code, `${JSON.stringify(patch)} -> ${result.code}`);
  }
});

test('newMessageId produces valid unique ids', () => {
  const a = newMessageId();
  const b = newMessageId();
  assert.notEqual(a, b);
  assert.equal(validateEnvelope(baseEnvelope({ msg_id: a })).ok, true);
});

test('frame encoding round-trips through incremental decoding', () => {
  const values = [
    { type: 'hello', v: 1, role: 'dsh', identity: 'dsh:host-a', token: 't' },
    { type: 'deliver', message: baseEnvelope() },
    { type: 'ack', msg_id: 'm-abc-1', ok: true },
  ];
  const encoded = Buffer.concat(values.map((value) => encodeFrame(value)));
  const decoder = createFrameDecoder();
  const frames = [];
  for (let i = 0; i < encoded.length; i += 7) {
    frames.push(...decoder.push(encoded.subarray(i, i + 7)));
  }
  assert.deepEqual(frames, values);
  assert.equal(decoder.pendingBytes(), 0);
});

test('frame decoder rejects oversized and invalid frames', () => {
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(9 * 1024 * 1024, 0);
  assert.throws(() => createFrameDecoder().push(oversized), /frame length/);

  const badJson = Buffer.concat([Buffer.from([5, 0, 0, 0]), Buffer.from('not-json!')]);
  assert.throws(() => createFrameDecoder().push(badJson), /valid JSON/);
});

test('token comparison is exact and rejects empty', () => {
  assert.equal(tokenEquals('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(tokenEquals('a'.repeat(64), 'a'.repeat(63) + 'b'), false);
  assert.equal(tokenEquals('', ''), false);
  assert.equal(tokenEquals('abc', 'abcdef'), false);
});

test('message state machine only allows declared transitions', () => {
  assert.equal(canTransition(STATES.QUEUED, STATES.DELIVERING), true);
  assert.equal(canTransition(STATES.DELIVERING, STATES.DELIVERED), true);
  assert.equal(canTransition(STATES.DELIVERING, STATES.DELIVERY_UNKNOWN), true);
  assert.equal(canTransition(STATES.DELIVERY_UNKNOWN, STATES.DELIVERING), true);
  assert.equal(canTransition(STATES.QUEUED, STATES.DELIVERED), false);
  assert.equal(canTransition(STATES.DELIVERED, STATES.FAILED), false);
  assert.equal(canTransition(STATES.FAILED, STATES.QUEUED), false);
  assert.equal(canTransition('bogus', STATES.QUEUED), false);
});

