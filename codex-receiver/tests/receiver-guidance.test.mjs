import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { receiverGuidance, receiverErrorCode } from '../adapters/codex/receiver-guidance.mjs';

test('pairing, worker health, native acceptance and model report remain separate evidence', () => {
  const idle = receiverGuidance({ status: 'ONLINE_IDLE', running: true, healthy: true });
  assert.equal(idle.evidence.receiver_healthy, true);
  assert.equal(idle.evidence.native_queue_accepted, null);
  assert.equal(idle.evidence.model_receipt_reported, null);
  const pending = receiverGuidance({ status: 'PENDING_COMPANION', running: false, healthy: false, last_error: 'RECEIVER_NOT_RUNNING' });
  assert.equal(pending.blocked_step, 'WAIT_FOR_VERIFIED_WORKER');
  assert.equal(pending.evidence.model_receipt_reported, null);
  assert.equal(receiverGuidance({ status: 'PREPARED_DISABLED' }).blocked_step, 'OWNER_ENABLE');
  assert.equal(receiverGuidance({ status: 'DISABLED', reason_code: 'CLI_BINARY_CHANGED' }).blocked_step, 'OWNER_ENABLE');
  const queued = receiverGuidance({ status: 'NATIVE_QUEUED_NOT_MODEL_PROOF', native_queue_id: 'fixture-native-id' });
  assert.equal(queued.evidence.native_queue_accepted, true);
  assert.equal(queued.evidence.model_receipt_reported, null);
  const receipt = { status: 'MODEL_RECEIVED', msg_id: 'fixture-message-id', receiving_turn_id: crypto.randomUUID(),
    native_queue_id: 'fixture-native-id', evidence_grade: 'MODEL_REPORTED; correlate with native thread' };
  assert.equal(receiverGuidance(receipt).evidence.model_receipt_reported, true);
  const manual = receiverGuidance({ ...receipt, native_queue_id: null, delivery_route: 'MANUAL_ACTIVE_TURN' });
  assert.equal(manual.evidence.model_receipt_reported, true);
  assert.equal(manual.evidence.native_queue_accepted, null);
  assert.equal(receiverGuidance({ ...receipt, receiving_turn_id: 'not-a-turn' }).evidence.model_receipt_reported, null);
  assert.equal(receiverGuidance({ status: 'MODEL_RECEIVED' }).evidence.model_receipt_reported, null);
});

test('uncertainty and identity review never suggest an automatic enable or resend', () => {
  const configPath = path.join(os.tmpdir(), 'receiver & quoted config.json');
  for (const code of ['NATIVE_OUTCOME_UNCERTAIN', 'LOCK_IDENTITY_OR_BINDING_UNKNOWN', 'RECEIVER_START_UNCONFIRMED_NO_RETRY']) {
    const hint = receiverGuidance({ code }, { configPath });
    assert.ok(hint.next_steps.length > 0);
    assert.equal(hint.next_commands.some((c) => c.argv.includes('enable')), false);
    assert.equal(hint.next_commands.every((c) => c.effect === 'READ_ONLY'), true);
    assert.equal(hint.next_commands[0].argv.at(-1), path.resolve(configPath));
  }
  assert.equal(receiverGuidance({ code: 'NATIVE_OUTCOME_UNCERTAIN' }).retry_policy, 'NO_RESUBMIT_REVIEW_REQUIRED');
  assert.equal(receiverGuidance({ status: 'RATE_LIMITED' }).retry_policy, 'WAIT_UNTIL_ELIGIBLE');
});

test('CLI repair success is not a failure and unpaired failure has a persistent request path', () => {
  const repaired = receiverGuidance({ status: 'CLI_REPAIRED', native_submitted: false });
  assert.equal(repaired.blocked_step, 'RECHECK_OWNER_RECEIVER');
  assert.equal(repaired.evidence.native_queue_accepted, false);
  assert.match(repaired.message_zh, /已修复/);
  const missing = receiverGuidance({ status: 'DISABLED', cli_repair_required: true });
  assert.equal(missing.code, 'CLI_REFRESH_REQUIRED');
  assert.equal(missing.blocked_step, 'VERIFY_INSTALLED_CLI');
  for (const code of ['source-unpaired', 'target-unpaired', 'TARGET_UNPAIRED']) {
    const hint = receiverGuidance({ code });
    assert.equal(hint.blocked_step, 'PAIR_EXACT_PEERS');
    assert.match(hint.next_steps.join('\n'), /onboard request/);
    assert.match(hint.next_steps.join('\n'), /未知来源不默认放行/);
  }
  const secretError = new Error('private credential value MUST_NOT_APPEAR');
  const code = receiverErrorCode(secretError);
  assert.equal(code, 'RECEIVER_OPERATION_FAILED');
  assert.equal(JSON.stringify(receiverGuidance({ code })).includes('MUST_NOT_APPEAR'), false);
  assert.equal(receiverErrorCode(new Error('sk-proj-MUST_NOT_APPEAR')), 'RECEIVER_OPERATION_FAILED');
  assert.equal(receiverErrorCode({ code: 'sk-proj-MUST_NOT_APPEAR' }), 'RECEIVER_OPERATION_FAILED');
  assert.equal(receiverGuidance({ code: 'EPERM' }).blocked_step, 'PERSIST_OWNER_CONFIGURATION');
});

test('real CLI owner mismatch returns stable code and Chinese recovery without changing config', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-guidance-cli-'));
  t.after(() => {
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('lab-guidance-cli-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const file = path.join(root, 'receiver-config.json');
  const before = JSON.stringify({ thread_id: crypto.randomUUID(), enabled: false });
  fs.writeFileSync(file, before);
  const env = { ...process.env }; delete env.CODEX_THREAD_ID;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../adapters/codex/receiver-control.mjs', import.meta.url)), 'disable', file],
    { env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr.trim());
  assert.equal(error.code, 'OWNER_THREAD_MISMATCH');
  assert.equal(error.guidance.blocked_step, 'TARGET_OWNER_CONTEXT');
  assert.match(error.guidance.next_steps.join('\n'), /不要手工设置/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('client failures retain stable codes and never suggest implicit pairing, enable or native replay', () => {
  for (const code of ['CLIENT_REQUEST_PROTOCOL_REQUIRED', 'client-grant-revoked', 'client-submit-gate-required']) {
    assert.equal(receiverErrorCode(new Error(code)), code);
    const hint = receiverGuidance({ code }, { configPath: path.join(os.tmpdir(), 'synthetic-config.json') });
    assert.equal(hint.retry_policy, 'RECHECK_SAME_CLIENT_REQUEST');
    assert.ok(hint.next_commands.every((command) => command.effect === 'READ_ONLY'));
  }
  const unknown = receiverGuidance({ code: 'CLIENT_REPLY_RECEIPT_MISMATCH' });
  assert.equal(unknown.retry_policy, 'NO_RESUBMIT_REVIEW_REQUIRED');
  assert.match(unknown.next_steps.join('\n'), /不要换请求 ID/);
});

test('a confirmed client reply stays confirmed when the separate local receipt write is unknown', () => {
  const result = { status: 'CLIENT_REPLY_RECORDED', client_request_id: 'request-1', msg_id: 'message-1',
    reply_msg_id: 'reply-1', receiving_turn_id: crypto.randomUUID(), native_queue_id: 'native-1',
    evidence_grade: 'MODEL_REPORTED_OWNER_CONTEXT_CORROBORATED', model_receipt_status: 'LOCAL_RECEIPT_WRITE_UNCONFIRMED' };
  const hint = receiverGuidance(result);
  assert.equal(hint.evidence.client_reply_recorded, true); assert.equal(hint.evidence.native_queue_accepted, true);
  assert.equal(hint.evidence.model_receipt_reported, null); assert.equal(hint.blocked_step, null);
  assert.equal(receiverGuidance({ ...result, model_receipt_status: 'MODEL_RECEIVED' }).evidence.model_receipt_reported, true);
  assert.equal(receiverGuidance({ status: 'CLIENT_REPLY_RECORDED' }).evidence.client_reply_recorded, null);
});
