import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { BridgeHub } from '../src/hub.mjs';
import { HubClient } from '../src/client.mjs';
import { HubStore } from '../src/store.mjs';
import { readReceiverStatuses } from '../src/receiver-status.mjs';
import { installationPaths, writeInstallationAtomic } from '../src/installation.mjs';
import { runtimePaths, writeJsonAtomic } from '../src/runtime.mjs';
import {
  createOnboardingRequest,
  discoverOnboarding,
  getOnboardingRequest,
  listOnboardingRequests,
  recordManualOnboardingReceipt,
  retryOnboardingRequest,
  revokeOnboardingRequest,
} from '../src/manual-onboarding.mjs';

const SOURCE = 'dsh:session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET = 'codex:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THREAD = TARGET.slice('codex:'.length);
const MESSAGE_ID = 'm-v19-manual-onboarding-001';

function tempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-onboarding-'));
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  return { root, runtime };
}

function validId() {
  return `onb-test-${crypto.randomUUID()}`;
}

test('explicit legacy runtime persists a source-unpaired request without pairing or token/content leakage', async () => {
  const { root, runtime } = tempRuntime();
  try {
    const artifact = path.join(root, 'outbox', 'request.json');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify({ from: SOURCE, to: TARGET, text: 'PRIVATE CHAT MUST NOT PERSIST' }));
    const requestId = validId();
    const result = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, requestId,
      userAuthorized: true, requestedBy: 'user:fixture', authorizedBy: 'user:fixture',
      originArtifact: artifact,
    });
    assert.equal(result.ok, true);
    assert.equal(result.request.request_state, 'UNKNOWN');
    assert.equal(result.request.installation_id, null);
    assert.equal(result.request.instance_id, null);
    assert.equal(result.request.generation.source, 'LEGACY_UNVERIFIED');
    assert.equal(result.request.guidance.code, 'HUB_DISCOVERY_UNAVAILABLE');
    assert.equal(result.request.source_identity, SOURCE);
    assert.equal(result.request.target_identity, TARGET);
    assert.equal(result.request.origin_artifact.sha256, crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'));
    assert.equal(result.request.observations.source_pair.enabled, false);
    assert.equal(result.request.observations.target_pair.enabled, false);
    const file = path.join(runtime, 'onboarding', 'requests', `${requestId}.json`);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes('PRIVATE CHAT MUST NOT PERSIST'), false);
    assert.equal(text.includes('SECRET_TOKEN_SHOULD_NOT_PERSIST'), false);
    assert.equal(fs.existsSync(path.join(runtime, 'onboarding', 'requests', `${requestId}.lock`)), false);

    const idempotent = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, requestId,
      userAuthorized: true, requestedBy: 'user:fixture', authorizedBy: 'user:fixture',
      originArtifact: artifact,
    });
    assert.equal(idempotent.idempotent, true);
    await assert.rejects(
      createOnboardingRequest({
        runtimeDir: runtime, source: SOURCE, target: 'codex:99999999-9999-4999-8999-999999999999', requestId,
        userAuthorized: true, originArtifact: artifact,
      }),
      (error) => error.code === 'ONBOARD_REQUEST_ID_CONFLICT',
    );

    const retried = await retryOnboardingRequest({ runtimeDir: runtime, requestId });
    assert.equal(retried.request.origin_artifact.sha256, result.request.origin_artifact.sha256);
    assert.equal(retried.request.history.length >= 2, true);
    const listed = await listOnboardingRequests({ runtimeDir: runtime });
    assert.equal(listed.count, 1);
    const status = await getOnboardingRequest({ runtimeDir: runtime, requestId });
    assert.equal(status.request.request_state, 'UNKNOWN');
    const revoked = await revokeOnboardingRequest({ runtimeDir: runtime, requestId, reason: 'fixture cleanup' });
    assert.equal(revoked.request.request_state, 'REVOKED');
    assert.equal((await getOnboardingRequest({ runtimeDir: runtime, requestId })).request.history.some((event) => event.action === 'REVOKED'), true);
    await assert.rejects(
      retryOnboardingRequest({ runtimeDir: runtime, requestId }),
      (error) => error.code === 'ONBOARD_REQUEST_REVOKED',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing consent persists WAITING_OWNER_CONSENT and can be declared later without pair/enable', async () => {
  const { root, runtime } = tempRuntime();
  try {
    const requestId = validId();
    const pending = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, requestId,
      userAuthorized: false, requestedBy: 'cli:operator',
    });
    assert.equal(pending.request.request_state, 'WAITING_OWNER_CONSENT');
    assert.equal(pending.request.authorization.user_authorized, false);
    assert.equal(pending.request.authorization.authorized_by, null);
    assert.equal(pending.request.guidance.code, 'REQUEST_WAITING_OWNER_CONSENT');
    assert.equal(fs.existsSync(path.join(runtime, 'onboarding', 'requests', `${requestId}.json`)), true);
    const beforeTargets = pending.request.observations.target_pair.enabled;
    const declared = await retryOnboardingRequest({
      runtimeDir: runtime, requestId,
      userAuthorized: true, authorizedBy: 'user:manual-consent',
    });
    assert.equal(declared.request.authorization.user_authorized, true);
    assert.equal(declared.request.authorization.authorized_by, 'user:manual-consent');
    assert.equal(declared.request.observations.target_pair.enabled, beforeTargets);
    assert.equal(declared.request.history.some((event) => event.action === 'OWNER_CONSENT_DECLARED'), true);
    const beforeRevoke = JSON.stringify(declared.request.observations.target_pair);
    const revoked = await revokeOnboardingRequest({ runtimeDir: runtime, requestId, reason: 'no longer needed' });
    assert.equal(revoked.request.request_state, 'REVOKED');
    assert.equal(JSON.stringify(revoked.request.observations.target_pair), beforeRevoke);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('read-only Hub discovery observes pairs and owner opt-in without changing pair state', async () => {
  const { root, runtime } = tempRuntime();
  const runtimePathsValue = runtimePaths(runtime);
  const store = new HubStore({ stateFile: runtimePathsValue.stateFile, eventsFile: runtimePathsValue.eventsFile }).load();
  store.addTarget(SOURCE);
  store.addTarget(TARGET);
  const token = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({
    store, token, host: '127.0.0.1', port: 0,
    installation: {
      installation_id: 'install-onboarding', instance_id: 'instance-onboarding', protocol_version: 1,
      hub_owner_kind: 'COMPANION_OWNED',
    },
  });
  const address = await hub.start();
  try {
    writeJsonAtomic(runtimePathsValue.configFile, { v: 1, host: '127.0.0.1', port: address.port });
    fs.writeFileSync(runtimePathsValue.tokenFile, `${token}\n`, 'utf8');
    const beforeTargets = JSON.stringify(store.listTargets());
    const discovery = await discoverOnboarding({ runtimeRoot: runtime });
    assert.equal(discovery.read_only, true);
    assert.equal(discovery.hub.reachable, true);
    assert.equal(discovery.targets.some((target) => target.identity === SOURCE && target.enabled === true), true);
    assert.equal(JSON.stringify(store.listTargets()), beforeTargets);

    const request = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, userAuthorized: true,
      requestedBy: 'user:fixture', authorizedBy: 'user:fixture', requestId: validId(),
    });
    assert.equal(request.request.request_state, 'WAITING_OWNER_OPT_IN');
    assert.equal(request.request.observations.target_pair.enabled, true);
    assert.equal(request.request.observations.membership.state, 'ABSENT');
    assert.equal(request.request.observations.guidance.code, 'REQUEST_WAITING_OWNER_OPT_IN');
    const beforeRevokeTargets = JSON.stringify(store.listTargets());
    await revokeOnboardingRequest({ runtimeDir: runtime, requestId: request.request.request_id, reason: 'fixture' });
    assert.equal(JSON.stringify(store.listTargets()), beforeRevokeTargets);
  } finally {
    await hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('message_id reads existing MODEL_REPORTED receipt but never claims native/rollout or received', async () => {
  const { root, runtime } = tempRuntime();
  const configDir = path.join(runtime, 'codex', THREAD);
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'receiver-config.json');
  const key = crypto.createHash('sha256').update(MESSAGE_ID).digest('hex');
  fs.writeFileSync(configPath, JSON.stringify({ thread_id: THREAD, runtime_dir: configDir }));
  fs.writeFileSync(path.join(configDir, `${key}.model-receipt.json`), JSON.stringify({
    status: 'MODEL_RECEIVED',
    msg_id: MESSAGE_ID,
    thread_id: THREAD,
    native_queue_id: 'native-fixture-1',
    receiving_turn_id: 'turn-fixture-1',
    evidence_grade: 'MODEL_REPORTED; correlate with native read_thread and rollout for wake acceptance',
  }));
  try {
    const request = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, messageId: MESSAGE_ID,
      userAuthorized: true, requestId: validId(),
    });
    assert.equal(request.request.model_receipt.status, 'MODEL_REPORTED');
    assert.equal(request.request.model_receipt.model_status, 'MODEL_REPORTED');
    assert.equal(request.request.model_receipt.received_confirmed, false);
    assert.equal(request.request.model_receipt.native_correlation, 'UNVERIFIED');
    assert.equal(request.request.model_receipt.rollout_correlation, 'UNVERIFIED');
    assert.equal(request.request.request_state, 'UNKNOWN');
    const noMessage = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, userAuthorized: true, requestId: validId(),
    });
    assert.equal(noMessage.request.model_receipt.status, 'UNKNOWN');
    assert.equal(noMessage.request.model_receipt.code, 'NO_MESSAGE_ID');

    // status refreshes the existing receipt without mutating request history.
    const laterMessage = 'm-v19-manual-onboarding-later';
    const laterRequest = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, messageId: laterMessage,
      userAuthorized: true, requestId: validId(),
    });
    const laterKey = crypto.createHash('sha256').update(laterMessage).digest('hex');
    fs.writeFileSync(path.join(configDir, `${laterKey}.model-receipt.json`), JSON.stringify({
      status: 'MODEL_RECEIVED', msg_id: laterMessage, thread_id: THREAD,
      native_queue_id: 'native-fixture-2', receiving_turn_id: 'turn-fixture-2',
      evidence_grade: 'MODEL_REPORTED; correlate with native read_thread and rollout',
    }));
    const beforeStatus = fs.readFileSync(laterRequest.request_file);
    const refreshed = await getOnboardingRequest({ runtimeDir: runtime, requestId: laterRequest.request.request_id });
    assert.equal(refreshed.live_observation.model_receipt.status, 'MODEL_REPORTED');
    assert.equal(refreshed.live_observation.model_receipt.received_confirmed, false);
    assert.equal(fs.readFileSync(laterRequest.request_file).equals(beforeStatus), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manual active-turn receipt verifies native thread and Hub route, never consumes or claims native acceptance', async () => {
  const { root, runtime } = tempRuntime();
  const runtimePathsValue = runtimePaths(runtime);
  const store = new HubStore({ stateFile: runtimePathsValue.stateFile, eventsFile: runtimePathsValue.eventsFile }).load();
  store.addTarget(SOURCE);
  store.addTarget(TARGET);
  const messageId = 'm-manual-receipt-fixture';
  store.enqueue({ v: 1, msg_id: messageId, from: SOURCE, to: TARGET, kind: 'text', text: 'fixture', ttl_ms: 86400000 });
  const token = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token, host: '127.0.0.1', port: 0 });
  const address = await hub.start();
  const previousThread = process.env.CODEX_THREAD_ID;
  try {
    writeJsonAtomic(runtimePathsValue.configFile, { v: 1, host: '127.0.0.1', port: address.port });
    fs.writeFileSync(runtimePathsValue.tokenFile, `${token}\n`, 'utf8');
    const request = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, messageId,
      userAuthorized: true, requestId: validId(),
    });
    const turnId = '123e4567-e89b-42d3-a456-426614174000';
    process.env.CODEX_THREAD_ID = THREAD;
    const receipt = await recordManualOnboardingReceipt({
      runtimeDir: runtime, requestId: request.request.request_id, messageId, turnId,
    });
    assert.equal(receipt.request.manual_receipt.route, 'MANUAL_ACTIVE_TURN');
    assert.equal(receipt.request.manual_receipt.model_status, 'MODEL_REPORTED_MANUAL');
    assert.equal(receipt.request.manual_receipt.native_accepted, 'UNKNOWN');
    assert.equal(receipt.request.manual_receipt.idle_wake, 'NOT_CLAIMED');
    assert.equal(receipt.request.manual_receipt.received_confirmed, false);
    assert.equal(receipt.request.manual_receipt.native_thread_id_verified, true);
    const verifyClient = new HubClient({ host: '127.0.0.1', port: address.port, token, role: 'cli', identity: 'cli:operator' });
    await verifyClient.connect();
    const after = await verifyClient.status(messageId);
    await verifyClient.close();
    assert.equal(after.state, 'queued');
    assert.equal(fs.existsSync(path.join(runtime, 'codex', THREAD, `${crypto.createHash('sha256').update(messageId).digest('hex')}.model-receipt.json`)), false);

    process.env.CODEX_THREAD_ID = '00000000-0000-4000-8000-000000000000';
    await assert.rejects(recordManualOnboardingReceipt({
      runtimeDir: runtime, requestId: request.request.request_id, messageId, turnId,
    }), (error) => error.code === 'ONBOARD_RECEIPT_OWNER_THREAD_MISMATCH');
    const still = await getOnboardingRequest({ runtimeDir: runtime, requestId: request.request.request_id, refresh: false });
    assert.equal(still.request.manual_receipt.route, 'MANUAL_ACTIVE_TURN');

    const wrongMessage = 'm-manual-receipt-wrong-route';
    store.enqueue({ v: 1, msg_id: wrongMessage, from: 'dsh:session-other', to: TARGET, kind: 'text', text: 'wrong route', ttl_ms: 86400000 });
    const wrongRequest = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, messageId: wrongMessage,
      userAuthorized: true, requestId: validId(),
    });
    process.env.CODEX_THREAD_ID = THREAD;
    await assert.rejects(recordManualOnboardingReceipt({
      runtimeDir: runtime, requestId: wrongRequest.request.request_id, messageId: wrongMessage, turnId,
    }), (error) => error.code === 'ONBOARD_RECEIPT_ROUTE_MISMATCH');
    const wrongAfter = await getOnboardingRequest({ runtimeDir: runtime, requestId: wrongRequest.request.request_id, refresh: false });
    assert.equal(wrongAfter.request.manual_receipt, undefined);
  } finally {
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
    await hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('manual legacy config owner_opt_in is observed without companion membership; v2 health is not promoted', async () => {
  const { root, runtime } = tempRuntime();
  const runtimePathsValue = runtimePaths(runtime);
  const store = new HubStore({ stateFile: runtimePathsValue.stateFile, eventsFile: runtimePathsValue.eventsFile }).load();
  store.addTarget(SOURCE);
  store.addTarget(TARGET);
  const token = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token, host: '127.0.0.1', port: 0 });
  const address = await hub.start();
  try {
    writeJsonAtomic(runtimePathsValue.configFile, { v: 1, host: '127.0.0.1', port: address.port });
    fs.writeFileSync(runtimePathsValue.tokenFile, `${token}\n`, 'utf8');
    const configDir = path.join(runtime, 'codex', THREAD);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'receiver-config.json'), JSON.stringify({
      thread_id: THREAD, runtime_dir: configDir, hub_runtime_root: runtime,
      owner_opt_in: true, enabled: true, mode: 'daily', allowed_senders: [SOURCE],
      installation_id: 'install-x', instance_id: 'instance-x',
    }));
    let request = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, userAuthorized: true, requestId: validId(),
    });
    assert.equal(request.request.request_state, 'WAITING_TARGET');
    assert.equal(request.request.observations.target_config.owner_opt_in, true);
    assert.equal(request.request.observations.target_config.hub_root_matches, true);
    assert.equal(request.request.observations.target_config.evidence_grade, 'MANUAL_LEGACY_HUB_CONFIG_OWNER_OPT_IN');
    assert.equal(request.request.observations.membership.state, 'ABSENT');

    fs.writeFileSync(path.join(configDir, 'status.json'), JSON.stringify({
      schema_version: 2, thread_id: THREAD, status: 'ONLINE_IDLE', phase: 'online-idle',
      enabled: true, mode: 'daily', expires_at: null, heartbeat_at: new Date().toISOString(),
      pid: process.pid,
    }));
    request = await retryOnboardingRequest({ runtimeDir: runtime, requestId: request.request.request_id });
    assert.equal(request.request.observations.receiver.schema_version, 2);
    assert.equal(request.request.observations.receiver.evidence_grade, 'LEGACY_V2_NO_V3_IDENTITY');
    assert.notEqual(request.request.observations.receiver.state, 'ACTIVE');
    assert.equal(request.request.request_state, 'WAITING_TARGET');
  } finally {
    await hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unmarked legacy metadata stays null/UNVERIFIED and stored snapshot does not override fresh status', async () => {
  const { root, runtime } = tempRuntime();
  const runtimePathsValue = runtimePaths(runtime);
  const store = new HubStore({ stateFile: runtimePathsValue.stateFile, eventsFile: runtimePathsValue.eventsFile }).load();
  store.addTarget(SOURCE);
  store.addTarget(TARGET);
  const token = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token, host: '127.0.0.1', port: 0 });
  const address = await hub.start();
  try {
    writeJsonAtomic(runtimePathsValue.configFile, { v: 1, host: '127.0.0.1', port: address.port });
    fs.writeFileSync(runtimePathsValue.tokenFile, `${token}\n`, 'utf8');
    const storedRequest = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, userAuthorized: true, requestId: validId(),
    });
    assert.equal(storedRequest.request.request_state, 'WAITING_OWNER_OPT_IN');
    const configDir = path.join(runtime, 'codex', THREAD);
    const configPath = path.join(configDir, 'receiver-config.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      thread_id: THREAD, runtime_dir: configDir, hub_runtime_root: runtime,
      enabled: true, mode: 'daily', allowed_senders: [SOURCE],
    }));
    fs.writeFileSync(path.join(configDir, 'status.json'), JSON.stringify({
      schema_version: 2, thread_id: THREAD, status: 'ONLINE_IDLE', phase: 'online-idle',
      enabled: true, mode: 'daily', expires_at: null, heartbeat_at: new Date().toISOString(), pid: process.pid,
    }));
    const configBefore = fs.readFileSync(configPath);
    const storedFileBefore = fs.readFileSync(storedRequest.request_file);
    const status = await getOnboardingRequest({ runtimeDir: runtime, requestId: storedRequest.request.request_id });
    assert.equal(status.stored_state, 'WAITING_OWNER_OPT_IN');
    assert.equal(status.current_state, 'OBSERVED_LEGACY_UNVERIFIED');
    assert.equal(status.current_guidance.code, 'REQUEST_LEGACY_OBSERVED_UNVERIFIED');
    assert.equal(fs.readFileSync(storedRequest.request_file).equals(storedFileBefore), true);
    assert.equal(fs.readFileSync(configPath).equals(configBefore), true);

    const observed = status.live_observation?.observations;
    assert.equal(observed.target_config.owner_opt_in, null);
    assert.equal(observed.target_config.owner_opt_in_present, false);
    assert.equal(observed.target_config.metadata_support, 'UNSUPPORTED_LEGACY_FIELDS');
    assert.equal(observed.target_config.metadata_unsupported, true);
    assert.equal(observed.target_config.enabled, true);
    assert.equal(observed.target_config.source_allowed_by_target, true);
    assert.equal(observed.receiver.state, 'LEGACY_UNVERIFIED');
    assert.equal(observed.receiver.active, null);
    assert.equal(observed.receiver.process_active, null);
    assert.equal(observed.receiver.deliverable_now, null);
    assert.equal(observed.receiver.reported.status, 'ONLINE_IDLE');
    assert.equal(observed.receiver.reported_online_idle, true);
    assert.equal(observed.receiver.verified_process.state, 'UNVERIFIED');

    const retried = await retryOnboardingRequest({ runtimeDir: runtime, requestId: storedRequest.request.request_id });
    assert.equal(retried.request.request_state, 'OBSERVED_LEGACY_UNVERIFIED');
    assert.equal(retried.request.observations.target_config.owner_opt_in, null);
    assert.equal(fs.readFileSync(configPath).equals(configBefore), true);
    assert.equal(retried.request.history.some((event) => event.action === 'RETRY_OBSERVED'), true);

    fs.writeFileSync(configPath, JSON.stringify({
      thread_id: THREAD, runtime_dir: configDir, hub_runtime_root: runtime,
      owner_opt_in: false, enabled: true, mode: 'daily', allowed_senders: [SOURCE],
    }));
    const explicitFalse = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, userAuthorized: true, requestId: validId(),
    });
    assert.equal(explicitFalse.request.request_state, 'WAITING_OWNER_OPT_IN');
    assert.equal(explicitFalse.request.observations.target_config.owner_opt_in, false);
    fs.writeFileSync(configPath, JSON.stringify({
      thread_id: THREAD, runtime_dir: configDir, hub_runtime_root: runtime,
      owner_opt_in: false, enabled: false, mode: 'daily', allowed_senders: [SOURCE],
    }));
    const explicitDisabled = await retryOnboardingRequest({ runtimeDir: runtime, requestId: explicitFalse.request.request_id });
    assert.equal(explicitDisabled.request.request_state, 'WAITING_OWNER_OPT_IN');
    assert.equal(explicitDisabled.request.observations.target_config.enabled, false);

    fs.writeFileSync(configPath, JSON.stringify({
      thread_id: THREAD, runtime_dir: configDir, hub_runtime_root: runtime,
      owner_opt_in: true, enabled: false, mode: 'daily', allowed_senders: [SOURCE],
    }));
    const explicitOwnerDisabled = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, userAuthorized: true, requestId: validId(),
    });
    assert.equal(explicitOwnerDisabled.request.request_state, 'WAITING_OWNER_ENABLE');
    assert.equal(explicitOwnerDisabled.request.observations.target_config.enabled, false);
  } finally {
    await hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('target allowed_senders gates readiness and disabled owner state waits for manual enable', async () => {
  const { root, runtime } = tempRuntime();
  const runtimePathsValue = runtimePaths(runtime);
  const store = new HubStore({ stateFile: runtimePathsValue.stateFile, eventsFile: runtimePathsValue.eventsFile }).load();
  store.addTarget(SOURCE);
  store.addTarget(TARGET);
  const token = crypto.randomBytes(32).toString('hex');
  const hub = new BridgeHub({ store, token, host: '127.0.0.1', port: 0 });
  const address = await hub.start();
  const other = 'dsh:session-other-authorized';
  try {
    writeJsonAtomic(runtimePathsValue.configFile, { v: 1, host: '127.0.0.1', port: address.port });
    fs.writeFileSync(runtimePathsValue.tokenFile, `${token}\n`, 'utf8');
    const configDir = path.join(runtime, 'codex', THREAD);
    const configPath = path.join(configDir, 'receiver-config.json');
    fs.mkdirSync(configDir, { recursive: true });
    const baseConfig = {
      thread_id: THREAD, runtime_dir: configDir, hub_runtime_root: runtime,
      owner_opt_in: true, enabled: true, mode: 'daily', allowed_senders: [other],
    };
    fs.writeFileSync(configPath, JSON.stringify(baseConfig));
    const originalConfig = fs.readFileSync(configPath);
    let request = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, userAuthorized: true, requestId: validId(),
    });
    assert.equal(request.request.request_state, 'WAITING_TARGET_ALLOWLIST');
    assert.equal(request.request.observations.source_allowed_by_target, false);
    assert.deepEqual(request.request.observations.target_config.allowed_senders, [other]);
    assert.equal(fs.readFileSync(configPath).equals(originalConfig), true);

    fs.writeFileSync(configPath, JSON.stringify({ ...baseConfig, enabled: false, allowed_senders: [SOURCE, other] }));
    const disabledBefore = fs.readFileSync(configPath);
    request = await retryOnboardingRequest({ runtimeDir: runtime, requestId: request.request.request_id });
    assert.equal(request.request.request_state, 'WAITING_OWNER_ENABLE');
    assert.equal(request.request.guidance.code, 'REQUEST_WAITING_OWNER_ENABLE');
    assert.equal(request.request.observations.source_allowed_by_target, true);
    assert.equal(fs.readFileSync(configPath).equals(disabledBefore), true);

    fs.writeFileSync(configPath, JSON.stringify({ ...baseConfig, enabled: true, allowed_senders: [SOURCE, other] }));
    request = await retryOnboardingRequest({ runtimeDir: runtime, requestId: request.request.request_id });
    assert.notEqual(request.request.request_state, 'OBSERVED_READY');
    assert.deepEqual(request.request.observations.target_config.allowed_senders, [SOURCE, other]);
    assert.equal(request.request.observations.source_allowed_by_target, true);

    fs.writeFileSync(path.join(configDir, 'status.json'), JSON.stringify({
      schema_version: 2, thread_id: THREAD, status: 'RATE_LIMITED', phase: 'rate-limited',
      enabled: true, mode: 'daily', expires_at: null, heartbeat_at: new Date().toISOString(),
      pid: process.pid,
      guidance: {
        code: 'RECEIVER_RATE_LIMIT_FIXTURE', blocked_step: 'wait_quota',
        message_zh: 'fixture rate limit', next_steps: ['wait'], retry_policy: 'MANUAL',
        raw_secret: 'SHOULD_NOT_LEAK',
      },
    }));
    request = await retryOnboardingRequest({ runtimeDir: runtime, requestId: request.request.request_id });
    assert.equal(request.request.guidance.code, 'RECEIVER_RATE_LIMIT_FIXTURE');
    assert.equal(request.request.guidance.blocked_step, 'wait_quota');
    assert.equal(request.request.observations.receiver.guidance.message_zh, 'fixture rate limit');
    const summary = readReceiverStatuses({ runtimeDir: runtime });
    assert.equal(summary.receivers[0].guidance.raw_secret, undefined);
    assert.equal(summary.receivers[0].guidance.code, 'RECEIVER_RATE_LIMIT_FIXTURE');
    fs.writeFileSync(path.join(configDir, 'status.json'), JSON.stringify({
      schema_version: 2, thread_id: THREAD, status: 'RATE_LIMITED', phase: 'rate-limited',
      enabled: true, mode: 'daily', expires_at: null, heartbeat_at: new Date().toISOString(), pid: process.pid,
    }));
    request = await retryOnboardingRequest({ runtimeDir: runtime, requestId: request.request.request_id });
    assert.equal(request.request.request_state, 'WAITING_TARGET');
    assert.equal(request.request.guidance.code, 'RECEIVER_RATE_LIMITED');
    assert.equal(request.request.guidance.blocked_step, 'receiver_rate_limit');
    assert.equal(request.request.observations.receiver.deliverable_now, null);
    assert.match(request.request.guidance.message_zh, /rate-limited/);
    fs.writeFileSync(path.join(configDir, 'status.json'), JSON.stringify({
      schema_version: 2, thread_id: THREAD, status: 'PAUSED_UNCERTAIN', phase: 'paused-uncertain',
      enabled: true, mode: 'daily', expires_at: null, heartbeat_at: new Date().toISOString(), pid: process.pid,
    }));
    request = await retryOnboardingRequest({ runtimeDir: runtime, requestId: request.request.request_id });
    assert.equal(request.request.guidance.code, 'RECEIVER_PAUSED_UNCERTAIN');
    assert.equal(request.request.guidance.blocked_step, 'receiver_uncertain_review');
    fs.writeFileSync(path.join(configDir, 'status.json'), JSON.stringify({
      schema_version: 2, thread_id: THREAD, status: 'HALTED', phase: 'halted', reason_code: 'CLI_PIN_MISSING',
      enabled: true, mode: 'daily', expires_at: null, heartbeat_at: new Date().toISOString(), pid: process.pid,
    }));
    request = await retryOnboardingRequest({ runtimeDir: runtime, requestId: request.request.request_id });
    assert.equal(request.request.guidance.code, 'RECEIVER_CLI_PAUSED');
    assert.equal(request.request.guidance.blocked_step, 'receiver_cli_paused');
  } finally {
    await hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('non-loopback Hub config is refused before token use; installation mismatch blocks success', async () => {
  const { root, runtime } = tempRuntime();
  const paths = installationPaths(path.join(root, 'installation'));
  fs.mkdirSync(paths.runtimeRoot, { recursive: true });
  const install = writeInstallationAtomic({
    root: path.join(root, 'installation'),
    installation: {
      v: 1, installation_id: 'install-a', instance_id: 'instance-a', active_version: '0.1.0-test',
      app_root: path.join(root, 'app'), runtime_root: runtime, hub_owner_kind: 'MANUAL',
      protocol_version: 1, state_schema: 1,
    },
  });
  try {
    writeJsonAtomic(runtimePaths(runtime).configFile, { v: 1, host: '192.0.2.10', port: 47831 });
    fs.writeFileSync(runtimePaths(runtime).tokenFile, `${'c'.repeat(64)}\n`, 'utf8');
    const discovery = await discoverOnboarding({ runtimeRoot: runtime });
    assert.equal(discovery.hub.reachable, false);
    assert.equal(discovery.hub.code, 'HUB_NON_LOOPBACK');

    writeJsonAtomic(runtimePaths(runtime).configFile, { v: 1, host: '127.0.0.1', port: 47831 });
    const hub = new BridgeHub({
      store: new HubStore({ stateFile: runtimePaths(runtime).stateFile, eventsFile: runtimePaths(runtime).eventsFile }).load(),
      token: 'd'.repeat(64), host: '127.0.0.1', port: 0,
      installation: { installation_id: 'install-b', instance_id: 'instance-b', protocol_version: 1 },
    });
    const address = await hub.start();
    fs.writeFileSync(runtimePaths(runtime).tokenFile, `${'d'.repeat(64)}\n`, 'utf8');
    writeJsonAtomic(runtimePaths(runtime).configFile, { v: 1, host: '127.0.0.1', port: address.port });
    try {
      const mismatch = await discoverOnboarding({
        runtimeRoot: runtime, installation: install, locatorPath: paths.locator, resolution: 'locator',
      });
      assert.equal(mismatch.hub.compatible, false);
      assert.equal(mismatch.hub.code, 'HUB_INSTANCE_MISMATCH');
      const request = await createOnboardingRequest({ runtimeDir: runtime, installationRoot: path.join(root, 'installation'), source: SOURCE, target: TARGET, userAuthorized: true, requestId: validId() });
      assert.equal(request.request.request_state, 'BLOCKED');
      assert.equal(request.request.guidance.code, 'HUB_INSTANCE_MISMATCH');
    } finally {
      await hub.stop();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('request_id Windows device names and onboarding path junctions fail closed', async () => {
  const { root, runtime } = tempRuntime();
  try {
    await assert.rejects(createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, userAuthorized: true, requestId: 'CON',
    }), (error) => error.code === 'ONBOARD_REQUEST_ID_DEVICE_NAME');
    await assert.rejects(createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, userAuthorized: true, requestId: 'NUL',
    }), (error) => error.code === 'ONBOARD_REQUEST_ID_DEVICE_NAME');

    const outside = path.join(root, 'outside-requests');
    fs.mkdirSync(outside, { recursive: true });
    const onboarding = path.join(runtime, 'onboarding');
    try {
      fs.symlinkSync(outside, onboarding, 'junction');
    } catch {
      fs.rmSync(onboarding, { recursive: true, force: true });
      fs.symlinkSync(outside, onboarding, 'dir');
    }
    await assert.rejects(createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, userAuthorized: true, requestId: validId(),
    }), (error) => {
      assert.equal(typeof error.details.request_id, 'string');
      assert.equal(error.details.persisted, false);
      assert.equal(typeof error.details.blocked_step, 'string');
      assert.equal(error.details.retryable_same_request_id, true);
      return error.code === 'ONBOARD_PATH_REPARSE' || error.code === 'ONBOARD_PATH_OUTSIDE';
    });
    assert.equal(fs.existsSync(path.join(outside, 'requests')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('explicit runtime stores first welcome tuple and blocks a later instance change without overwrite', async () => {
  const { root, runtime } = tempRuntime();
  const runtimePathsValue = runtimePaths(runtime);
  const storeA = new HubStore({ stateFile: runtimePathsValue.stateFile, eventsFile: runtimePathsValue.eventsFile }).load();
  storeA.addTarget(SOURCE);
  storeA.addTarget(TARGET);
  const token = 'e'.repeat(64);
  const hubA = new BridgeHub({
    store: storeA, token, host: '127.0.0.1', port: 0,
    installation: { installation_id: 'install-a', instance_id: 'instance-a', protocol_version: 1, hub_owner_kind: 'MANUAL' },
  });
  const addressA = await hubA.start();
  let hubB;
  try {
    writeJsonAtomic(runtimePathsValue.configFile, { v: 1, host: '127.0.0.1', port: addressA.port });
    fs.writeFileSync(runtimePathsValue.tokenFile, `${token}\n`, 'utf8');
    const request = await createOnboardingRequest({
      runtimeDir: runtime, source: SOURCE, target: TARGET, userAuthorized: true, requestId: validId(),
    });
    assert.equal(request.request.installation_id, 'install-a');
    assert.equal(request.request.instance_id, 'instance-a');
    assert.equal(request.request.generation.source, 'HUB_WELCOME');
    const requestFile = request.request_file;
    const before = fs.readFileSync(requestFile);

    await hubA.stop();
    const storeB = new HubStore({ stateFile: runtimePathsValue.stateFile, eventsFile: runtimePathsValue.eventsFile }).load();
    storeB.addTarget(SOURCE);
    storeB.addTarget(TARGET);
    hubB = new BridgeHub({
      store: storeB, token, host: '127.0.0.1', port: 0,
      installation: { installation_id: 'install-b', instance_id: 'instance-b', protocol_version: 1, hub_owner_kind: 'MANUAL' },
    });
    const addressB = await hubB.start();
    writeJsonAtomic(runtimePathsValue.configFile, { v: 1, host: '127.0.0.1', port: addressB.port });
    const status = await getOnboardingRequest({ runtimeDir: runtime, requestId: request.request.request_id });
    assert.equal(status.live_observation.request_state, 'BLOCKED');
    assert.equal(status.live_observation.guidance.code, 'ONBOARD_INSTANCE_DRIFT');
    assert.equal(status.live_observation.observations.generation.expected.installation_id, 'install-a');
    const driftMessage = 'm-drift-manual-receipt';
    storeB.enqueue({ v: 1, msg_id: driftMessage, from: SOURCE, to: TARGET, kind: 'text', text: 'drift', ttl_ms: 86400000 });
    const previousThread = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = THREAD;
    try {
      await assert.rejects(recordManualOnboardingReceipt({
        runtimeDir: runtime, requestId: request.request.request_id, messageId: driftMessage,
        turnId: '123e4567-e89b-42d3-a456-426614174000',
      }), (error) => error.code === 'ONBOARD_INSTANCE_DRIFT'
        && error.details.request_id === request.request.request_id
        && error.details.blocked_step === 'verify_generation'
        && error.details.persisted === true);
    } finally {
      if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
    }
    await assert.rejects(
      retryOnboardingRequest({ runtimeDir: runtime, requestId: request.request.request_id }),
      (error) => error.code === 'ONBOARD_INSTANCE_DRIFT'
        && error.details.request_id === request.request.request_id
        && error.details.blocked_step === 'verify_generation'
        && error.details.persisted === true,
    );
    assert.equal(fs.readFileSync(requestFile).equals(before), true);
  } finally {
    if (hubB !== undefined) await hubB.stop();
    try { await hubA.stop(); } catch { /* already stopped */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('create lock failure exposes request_id, blocked_step and non-persisted status', async () => {
  const { root, runtime } = tempRuntime();
  try {
    const requestId = validId();
    const requestsDir = path.join(runtime, 'onboarding', 'requests');
    fs.mkdirSync(requestsDir, { recursive: true });
    fs.writeFileSync(path.join(requestsDir, `${requestId}.lock`), '{}', 'utf8');
    await assert.rejects(
      createOnboardingRequest({ runtimeDir: runtime, source: SOURCE, target: TARGET, userAuthorized: true, requestId }),
      (error) => error.code === 'ONBOARD_REQUEST_BUSY'
        && error.details.request_id === requestId
        && error.details.blocked_step === 'acquire_request_lock'
        && error.details.persisted === false
        && error.details.retryable_same_request_id === true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('explicit runtime and locator conflict fail closed; multi-runtime requests do not mix', async () => {
  const one = tempRuntime();
  const two = tempRuntime();
  try {
    const install = path.join(one.root, 'installation');
    const paths = installationPaths(install);
    fs.mkdirSync(paths.runtimeRoot, { recursive: true });
    writeInstallationAtomic({
      root: install,
      installation: {
        v: 1, installation_id: 'install-one', instance_id: 'instance-one',
        active_version: '0.1.0-test', app_root: path.join(install, 'app'),
        runtime_root: paths.runtimeRoot, hub_owner_kind: 'MANUAL',
        protocol_version: 1, state_schema: 1,
      },
    });
    await assert.rejects(
      createOnboardingRequest({
        runtimeDir: two.runtime, installationRoot: install,
        source: SOURCE, target: TARGET, userAuthorized: true,
      }),
      (error) => error.code === 'ONBOARD_RUNTIME_CONFLICT',
    );
    const requestId = validId();
    await createOnboardingRequest({
      runtimeDir: one.runtime, source: SOURCE, target: TARGET, userAuthorized: true, requestId,
    });
    const other = await listOnboardingRequests({ runtimeDir: two.runtime });
    assert.equal(other.count, 0);
    await assert.rejects(
      getOnboardingRequest({ runtimeDir: two.runtime, requestId }),
      (error) => error.code === 'ONBOARD_REQUEST_NOT_FOUND',
    );
  } finally {
    fs.rmSync(one.root, { recursive: true, force: true });
    fs.rmSync(two.root, { recursive: true, force: true });
  }
});
test('CLI onboard request/status/revoke works with an explicit legacy runtime', () => {
  const { root, runtime } = tempRuntime();
  try {
    const requestId = validId();
    const cli = path.resolve(import.meta.dirname, '..', 'bin', 'lab-bridge.mjs');
    let result = spawnSync(process.execPath, [
      cli, 'onboard', 'request',
      '--runtime', runtime,
      '--source', SOURCE,
      '--target', TARGET,
      '--user-authorized',
      '--request-id', requestId,
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const created = JSON.parse(result.stdout);
    assert.equal(created.ok, true);
    assert.equal(created.request.request_state, 'UNKNOWN');
    assert.equal(created.request.authorization.user_authorized, true);

    const consentId = validId();
    result = spawnSync(process.execPath, [
      cli, 'onboard', 'request', '--runtime', runtime, '--source', SOURCE, '--target', TARGET, '--request-id', consentId,
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).request.request_state, 'WAITING_OWNER_CONSENT');
    result = spawnSync(process.execPath, [cli, 'onboard', 'retry', consentId, '--runtime', runtime, '--user-authorized'], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).request.authorization.user_authorized, true);

    result = spawnSync(process.execPath, [cli, 'onboard', 'status', requestId, '--runtime', runtime], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).request.request_id, requestId);

    result = spawnSync(process.execPath, [cli, 'onboard', 'revoke', requestId, '--runtime', runtime, '--reason', 'fixture'], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).request.request_state, 'REVOKED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});