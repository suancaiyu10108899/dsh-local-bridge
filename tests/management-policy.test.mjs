import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_SESSIONS_PER_OPERATION,
  DEFAULT_MAX_WORKSPACES_PER_OPERATION,
  ManagementPolicyError,
  OperationLedger,
  assertNonExecutingApi,
  describeDeclaredOrigin,
  loadApproval,
  resolveSafeTarget,
} from '../src/management-policy.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lab-policy-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function baseApproval(root, extra = {}) {
  return {
    approvalId: 'approval-1',
    approvedBy: 'human-local',
    allowExecution: false,
    expiresAt: Date.now() + 60_000,
    allowRoots: [root],
    maxWorkspacesPerOperation: 1,
    maxSessionsPerOperation: 3,
    ...extra,
  };
}

test('approval scope loads with bounded defaults and rejects expired/missing/execution-enabled files', () => {
  const root = tempDir();
  const approvalFile = path.join(root, 'approval.json');
  writeJson(approvalFile, baseApproval(root));
  const scope = loadApproval(approvalFile);
  assert.equal(scope.approvedBy, 'human-local');
  assert.equal(scope.maxWorkspacesPerOperation, DEFAULT_MAX_WORKSPACES_PER_OPERATION);
  assert.equal(scope.maxSessionsPerOperation, DEFAULT_MAX_SESSIONS_PER_OPERATION);
  assert.equal(scope.allowExecution, false);

  writeJson(approvalFile, baseApproval(root, { expiresAt: Date.now() - 1 }));
  assert.throws(() => loadApproval(approvalFile), (error) => error.code === 'policy-approval-expired');
  assert.throws(() => loadApproval(path.join(root, 'missing.json')), (error) => error.code === 'policy-approval-missing');
  writeJson(approvalFile, baseApproval(root, { allowExecution: true }));
  assert.throws(() => loadApproval(approvalFile), (error) => error.code === 'policy-approval-invalid');
});

test('resolveSafeTarget accepts only canonical paths inside the approved allowlist', () => {
  const base = tempDir();
  const root = path.join(base, 'managed');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'sub'));
  fs.mkdirSync(path.join(base, 'outside'));
  const allowRoots = [root];
  assert.equal(resolveSafeTarget(path.join(root, 'sub'), { allowRoots }), fs.realpathSync.native(path.join(root, 'sub')));
  assert.equal(resolveSafeTarget(path.join(root, 'future'), { allowRoots }).endsWith('future'), true);
  assert.throws(() => resolveSafeTarget(path.join(base, 'outside'), { allowRoots }), (error) => error.code === 'policy-path-outside-allowlist');
  assert.throws(() => resolveSafeTarget(`${root}${path.sep}..${path.sep}outside`, { allowRoots }), (error) => error.code === 'policy-path-outside-allowlist');
  assert.throws(() => resolveSafeTarget('relative/path', { allowRoots }), (error) => error.code === 'policy-unsafe-path');
  assert.throws(() => resolveSafeTarget(`${root}\u0000`, { allowRoots }), (error) => error.code === 'policy-unsafe-path');
});

test('resolveSafeTarget rejects a junction/symlink component that redirects inside-looking paths', (t) => {
  const base = tempDir();
  const root = path.join(base, 'managed');
  fs.mkdirSync(path.join(root, 'real'), { recursive: true });
  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(path.join(root, 'real'), link, 'junction');
  } catch {
    t.skip('symlink/junction creation not permitted in this environment');
    return;
  }
  assert.throws(
    () => resolveSafeTarget(path.join(link, 'child'), { allowRoots: [root] }),
    (error) => error.code === 'policy-unsafe-path' && /symlink|junction/.test(error.message),
  );
});

test('operation ledger replays identical operations idempotently and refuses request mismatches', () => {
  const dir = tempDir();
  const file = path.join(dir, 'ledger.json');
  const ledger = new OperationLedger({ file, now: () => 1_000 });
  const first = ledger.begin({ operationId: 'op-1', kind: 'create', request: { workspacePath: 'D:/x' } });
  assert.equal(first.replay, false);
  assert.throws(() => ledger.begin({ operationId: 'op-1', kind: 'create', request: { workspacePath: 'D:/x' } }), (error) => error.code === 'policy-operation-in-progress');
  ledger.complete({ operationId: 'op-1', result: { workspaceId: 'ws-1' } });
  const replay = ledger.begin({ operationId: 'op-1', kind: 'create', request: { workspacePath: 'D:/x' } });
  assert.equal(replay.replay, true);
  assert.equal(replay.record.result.workspaceId, 'ws-1');
  assert.throws(
    () => ledger.begin({ operationId: 'op-1', kind: 'create', request: { workspacePath: 'D:/y' } }),
    (error) => error.code === 'policy-operation-mismatch',
  );
});

test('ledger rejects non-management operation kinds and corrupt state', () => {
  const dir = tempDir();
  const file = path.join(dir, 'ledger.json');
  const ledger = new OperationLedger({ file });
  assert.throws(() => ledger.begin({ operationId: 'op-x', kind: 'prompt', request: {} }), (error) => error.code === 'policy-operation-not-allowed');
  writeJson(file, { v: 99 });
  assert.throws(() => new OperationLedger({ file }), (error) => error.code === 'policy-ledger-corrupt');
});

test('ownership requires created or explicitly adopted IDs', () => {
  const dir = tempDir();
  const ledger = new OperationLedger({ file: path.join(dir, 'ledger.json') });
  ledger.recordCreated({ kind: 'workspace', id: 'ws-own' });
  ledger.recordCreated({ kind: 'session', id: 'session-own' });
  assert.equal(ledger.assertOwned({ kind: 'workspace', id: 'ws-own' }).owned, true);
  assert.equal(ledger.assertOwned({ kind: 'session', id: 'session-own' }).owned, true);
  assert.throws(() => ledger.assertOwned({ kind: 'session', id: 'session-foreign' }), (error) => error.code === 'policy-id-not-owned');
  ledger.adopt({ kind: 'session', id: 'session-adopted', approvedBy: 'human-local' });
  const adopted = ledger.assertOwned({ kind: 'session', id: 'session-adopted' });
  assert.equal(adopted.adopted, true);
  assert.throws(() => ledger.adopt({ kind: 'session', id: 'x' }), (error) => error.code === 'policy-invalid-argument');
});

test('conservative creation limits: one workspace and up to three blank sessions per operation', () => {
  const dir = tempDir();
  const ledger = new OperationLedger({ file: path.join(dir, 'ledger.json') });
  const scope = { maxWorkspacesPerOperation: 1, maxSessionsPerOperation: 3 };
  assert.deepEqual(ledger.assertCreateLimits({ workspaces: 1, sessions: 3, scope }), { workspaces: 1, sessions: 3, maxWorkspaces: 1, maxSessions: 3 });
  assert.throws(() => ledger.assertCreateLimits({ workspaces: 2, sessions: 0, scope }), (error) => error.code === 'policy-count-limit');
  assert.throws(() => ledger.assertCreateLimits({ workspaces: 0, sessions: 4, scope }), (error) => error.code === 'policy-count-limit');
});

test('ledger state persists across instances (durable operation-ID ledger)', () => {
  const dir = tempDir();
  const file = path.join(dir, 'ledger.json');
  const first = new OperationLedger({ file });
  first.begin({ operationId: 'op-persist', kind: 'create', request: { path: 'D:/p' } });
  first.recordCreated({ kind: 'workspace', id: 'ws-persist' });
  first.complete({ operationId: 'op-persist', result: { workspaceId: 'ws-persist' } });
  const second = new OperationLedger({ file });
  assert.equal(second.assertOwned({ kind: 'workspace', id: 'ws-persist' }).owned, true);
  const replay = second.begin({ operationId: 'op-persist', kind: 'create', request: { path: 'D:/p' } });
  assert.equal(replay.replay, true);
});

test('declared origin is descriptive only and never expands authorization', () => {
  const base = tempDir();
  const root = path.join(base, 'managed');
  fs.mkdirSync(root);
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  const origin = describeDeclaredOrigin('codex:11111111-1111-4111-8111-111111111111');
  assert.equal(origin.grantsAuthority, false);
  assert.equal(origin.declaredOrigin.startsWith('codex:'), true);
  // Even an approval carrying a declared origin cannot reach outside its allowRoots.
  const approvalFile = path.join(base, 'approval.json');
  writeJson(approvalFile, baseApproval(root, { declaredOrigin: 'codex:11111111-1111-4111-8111-111111111111' }));
  const scope = loadApproval(approvalFile);
  assert.equal(scope.declaredOrigin.startsWith('codex:'), true);
  assert.throws(() => resolveSafeTarget(outside, { allowRoots: scope.allowRoots }), (error) => error.code === 'policy-path-outside-allowlist');
});

test('management API surface must stay non-executing', () => {
  assert.deepEqual(assertNonExecutingApi({ create() {}, list() {}, delete() {} }).allowed, ['create', 'list', 'delete']);
  assert.throws(() => assertNonExecutingApi({ create() {}, prompt() {} }), (error) => error.code === 'policy-execution-not-allowed');
  assert.throws(() => assertNonExecutingApi({}), (error) => error.code === 'policy-invalid-api');
});

void ManagementPolicyError;

