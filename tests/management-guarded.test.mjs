import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGuardedManagement } from '../src/management-guarded.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lab-guarded-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fixture() {
  const base = tempDir();
  const allowRoot = path.join(base, 'managed');
  fs.mkdirSync(allowRoot, { recursive: true });
  const approvalFile = path.join(base, 'approval.json');
  writeJson(approvalFile, {
    approvalId: 'guarded-approval-1',
    approvedBy: 'human-local',
    allowExecution: false,
    expiresAt: Date.now() + 60_000,
    allowRoots: [allowRoot],
    maxWorkspacesPerOperation: 1,
    maxSessionsPerOperation: 3,
  });
  const calls = [];
  const api = {
    async createWorkspace(request) {
      calls.push(['createWorkspace', request]);
      return { workspaceId: `ws-${calls.length}`, created: true, workspace: { workspaceId: `ws-${calls.length}`, path: request.path } };
    },
    async createSession(request) {
      calls.push(['createSession', request]);
      return { sessionId: `session-${calls.length}`, agentPreset: 'standard' };
    },
    async archiveSession(request) {
      calls.push(['archiveSession', request]);
      return { archived: true, sessionId: request.sessionId, archivedSessionIds: [request.sessionId] };
    },
    async deleteWorkspace(request) {
      calls.push(['deleteWorkspace', request]);
      return { deleted: true, workspaceId: request.workspaceId };
    },
  };
  return {
    base,
    allowRoot,
    approvalFile,
    ledgerFile: path.join(base, 'ledger.json'),
    calls,
    api,
    guard: createGuardedManagement({ api, approvalFile, ledgerFile: path.join(base, 'ledger.json') }),
  };
}

test('createWorkspace canonicalizes inside the allowlist and records ownership', async () => {
  const f = fixture();
  const result = await f.guard.createWorkspace({ operationId: 'op-ws-1', path: path.join(f.allowRoot, 'new project') });
  assert.equal(result.created, true);
  assert.equal(result.workspaceId, 'ws-1');
  assert.equal(f.calls[0][0], 'createWorkspace');
  assert.equal(path.isAbsolute(f.calls[0][1].path), true);
  assert.equal(f.calls[0][1].path.endsWith('new project'), true);
  assert.equal(f.calls[0][1].path.startsWith(fs.realpathSync.native(f.allowRoot)), true);
  const ledger = JSON.parse(fs.readFileSync(f.ledgerFile, 'utf8'));
  assert.equal(ledger.createdWorkspaces.includes(result.workspaceId), true);
  assert.equal(ledger.operations['op-ws-1'].status, 'completed');
});

test('createWorkspace rejects a path outside the allowlist and records a failed operation', async () => {
  const f = fixture();
  const outside = path.join(f.base, 'outside');
  fs.mkdirSync(outside);
  await assert.rejects(f.guard.createWorkspace({ operationId: 'op-ws-outside', path: outside }), (error) => error.code === 'policy-path-outside-allowlist');
  assert.equal(f.calls.length, 0);
  const ledger = JSON.parse(fs.readFileSync(f.ledgerFile, 'utf8'));
  assert.equal(ledger.operations['op-ws-outside'].status, 'failed');
});

test('replaying the same operation returns the prior result without calling the api twice', async () => {
  const f = fixture();
  const first = await f.guard.createWorkspace({ operationId: 'op-replay', path: path.join(f.allowRoot, 'p') });
  const callsAfterFirst = f.calls.length;
  const replay = await f.guard.createWorkspace({ operationId: 'op-replay', path: path.join(f.allowRoot, 'p') });
  assert.equal(replay.replayed, true);
  assert.equal(replay.workspaceId, first.workspaceId);
  assert.equal(f.calls.length, callsAfterFirst);
});

test('blank sessions require an owned workspace and enforce the per-operation session bound', async () => {
  const f = fixture();
  const workspace = await f.guard.createWorkspace({ operationId: 'op-ws-for-sessions', path: path.join(f.allowRoot, 'p') });
  await assert.rejects(
    f.guard.createBlankSessions({ operationId: 'op-foreign', workspaceId: 'ws-foreign', count: 1 }),
    (error) => error.code === 'policy-id-not-owned',
  );
  const created = await f.guard.createBlankSessions({ operationId: 'op-sessions', workspaceId: workspace.workspaceId, count: 3 });
  assert.equal(created.sessions.length, 3);
  await assert.rejects(
    f.guard.createBlankSessions({ operationId: 'op-sessions-2', workspaceId: workspace.workspaceId, count: 4 }),
    (error) => error.code === 'policy-count-limit',
  );
});

test('archive/delete require owned IDs and pass stopActivity=false', async () => {
  const f = fixture();
  const workspace = await f.guard.createWorkspace({ operationId: 'op-own', path: path.join(f.allowRoot, 'p') });
  const sessions = await f.guard.createBlankSessions({ operationId: 'op-own-s', workspaceId: workspace.workspaceId, count: 1 });
  await assert.rejects(
    f.guard.archiveOwnedSession({ operationId: 'op-foreign-s', sessionId: 'session-foreign' }),
    (error) => error.code === 'policy-id-not-owned',
  );
  const archived = await f.guard.archiveOwnedSession({ operationId: 'op-archive', sessionId: sessions.sessions[0].sessionId });
  assert.equal(archived.archived, true);
  assert.equal(archived.stopActivity, false);
  assert.deepEqual(f.calls.filter((call) => call[0] === 'archiveSession').at(-1)[1], { sessionId: sessions.sessions[0].sessionId, stopActivity: false });
  const deleted = await f.guard.deleteOwnedWorkspace({ operationId: 'op-delete', workspaceId: workspace.workspaceId });
  assert.equal(deleted.deleted, true);
  await assert.rejects(
    f.guard.deleteOwnedWorkspace({ operationId: 'op-delete-foreign', workspaceId: 'ws-foreign' }),
    (error) => error.code === 'policy-id-not-owned',
  );
});

test('an expired approval blocks every operation', async () => {
  const f = fixture();
  const approval = JSON.parse(fs.readFileSync(f.approvalFile, 'utf8'));
  approval.expiresAt = Date.now() - 1;
  writeJson(f.approvalFile, approval);
  await assert.rejects(f.guard.createWorkspace({ operationId: 'op-expired', path: path.join(f.allowRoot, 'p') }), (error) => error.code === 'policy-approval-expired');
  assert.equal(f.calls.length, 0);
});

test('api surfaces exposing execution methods are refused at construction', () => {
  assert.throws(
    () => createGuardedManagement({
      api: { createWorkspace() {}, createSession() {}, archiveSession() {}, deleteWorkspace() {}, prompt() {} },
      approvalFile: 'x',
      ledgerFile: 'y',
    }),
    (error) => error.code === 'policy-execution-not-allowed',
  );
});

test('api failures leave a failed operation record and do not fake success', async () => {
  const base = tempDir();
  const allowRoot = path.join(base, 'managed');
  fs.mkdirSync(allowRoot);
  const approvalFile = path.join(base, 'approval.json');
  writeJson(approvalFile, { approvalId: 'a', approvedBy: 'human-local', allowExecution: false, expiresAt: Date.now() + 60_000, allowRoots: [allowRoot] });
  const ledgerFile = path.join(base, 'ledger.json');
  const guard = createGuardedManagement({
    api: {
      createWorkspace: async () => {
        throw Object.assign(new Error('host create failed'), { code: 'host-failure' });
      },
      createSession: async () => ({}),
      archiveSession: async () => ({}),
      deleteWorkspace: async () => ({}),
    },
    approvalFile,
    ledgerFile,
  });
  await assert.rejects(guard.createWorkspace({ operationId: 'op-host-fail', path: path.join(allowRoot, 'p') }), (error) => error.code === 'host-failure');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.equal(ledger.operations['op-host-fail'].status, 'failed');
  assert.equal(ledger.operations['op-host-fail'].error.code, 'host-failure');
});

test('status reports approval validity and ledger counts', async () => {
  const f = fixture();
  const before = f.guard.status();
  assert.equal(before.approvalValid, true);
  await f.guard.createWorkspace({ operationId: 'op-status', path: path.join(f.allowRoot, 'p') });
  const after = f.guard.status();
  assert.equal(after.createdWorkspaces, 1);
  assert.equal(after.operations, 1);
});
