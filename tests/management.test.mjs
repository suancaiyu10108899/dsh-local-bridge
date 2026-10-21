import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ManagementError,
  archiveSession,
  createSession,
  createWorkspace,
  deleteWorkspace,
  listSessions,
  resolveHostService,
} from '../src/management.mjs';

function mockCtx(services = {}) {
  return { ...services };
}

test('createSession calls the host controller with the exact request and returns the real id', async () => {
  const calls = [];
  const ctx = mockCtx({
    sessionController: {
      async create(request) {
        calls.push(request);
        return { sessionId: 'session-created-1', agentPreset: 'default' };
      },
    },
  });
  const result = await createSession(ctx, { workspaceId: 'ws-1' });
  assert.deepEqual(calls, [{ workspaceId: 'ws-1' }]);
  assert.equal(result.sessionId, 'session-created-1');
  assert.equal(result.agentPreset, 'default');
  assert.deepEqual(result.request, { workspaceId: 'ws-1' });
});

test('createSession rejects a bad controller response and never invents an id', async () => {
  const ctx = mockCtx({ sessionController: { async create() { return {}; } } });
  await assert.rejects(createSession(ctx), (error) => error.code === 'management-bad-response');
});

test('createSession surfaces a missing host service with a stable code', async () => {
  await assert.rejects(createSession({}), (error) => error.code === 'management-service-missing');
});

test('createSession validates request fields before calling the host', async () => {
  let called = false;
  const ctx = mockCtx({ sessionController: { async create() { called = true; return { sessionId: 'x' }; } } });
  await assert.rejects(createSession(ctx, { cwd: 42 }), (error) => error.code === 'management-invalid-request');
  await assert.rejects(
    createSession(ctx, { workspaceId: 'ws-1', cwd: 'D:/Dev/example' }),
    (error) => error.code === 'management-invalid-request' && /not both/.test(error.message),
  );
  assert.equal(called, false);
});

test('listSessions passes the cursor and returns summaries without activating agents', async () => {
  const calls = [];
  const ctx = mockCtx({
    sessionController: {
      async list(request, signal) {
        calls.push({ request, signal });
        return { items: [{ sessionId: 'a' }, { sessionId: 'b' }] };
      },
    },
  });
  const result = await listSessions(ctx, { cursor: 'c1' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].request, { cursor: 'c1' });
  assert.equal(result.count, 2);
  assert.deepEqual(result.items.map((item) => item.sessionId), ['a', 'b']);
});

test('createWorkspace validates absolute paths and returns the created workspace id', async () => {
  const calls = [];
  const ctx = mockCtx({
    workspaceController: {
      async create(request) {
        calls.push(request);
        return { workspace: { workspaceId: 'ws-9', path: request.path }, created: true };
      },
    },
  });
  const result = await createWorkspace(ctx, { path: 'D:/Dev/new-workspace' });
  assert.deepEqual(calls, [{ path: 'D:/Dev/new-workspace' }]);
  assert.equal(result.workspaceId, 'ws-9');
  assert.equal(result.created, true);
  await assert.rejects(createWorkspace(ctx, { path: 'relative/dir' }), (error) => error.code === 'management-invalid-request');
});

test('deleteWorkspace and archiveSession call the documented host methods', async () => {
  const calls = [];
  const ctx = mockCtx({
    workspaceController: {
      async delete(request) {
        calls.push(['delete', request]);
        return { deleted: true };
      },
      async archiveSession(request) {
        calls.push(['archiveSession', request]);
        return { archivedSessionIds: [request.sessionId] };
      },
    },
  });
  const deleted = await deleteWorkspace(ctx, { workspaceId: 'ws-9' });
  assert.equal(deleted.deleted, true);
  const archived = await archiveSession(ctx, { sessionId: 'session-1', stopActivity: true });
  assert.equal(archived.archived, true);
  assert.deepEqual(calls, [
    ['delete', { workspaceId: 'ws-9' }],
    ['archiveSession', { sessionId: 'session-1', stopActivity: true }],
  ]);
});

test('resolveHostService prefers the non-strict Cordis reflect lookup and reports missing services', () => {
  const viaReflect = resolveHostService({
    reflect: { get: (name, strict) => (strict === false && name === 'sessionController' ? { via: 'reflect' } : undefined) },
  }, 'sessionController');
  assert.equal(viaReflect.via, 'reflect');
  assert.equal(resolveHostService({ sessionController: { create() {} } }, 'sessionController').create instanceof Function, true);
  assert.equal(resolveHostService({ service: (name) => (name === 'sessionController' ? { via: 'service' } : undefined) }, 'sessionController').via, 'service');
  assert.equal(resolveHostService({ get: (name) => (name === 'workspaceController' ? { via: 'get' } : undefined) }, 'workspaceController').via, 'get');
  assert.throws(() => resolveHostService({}, 'sessionController'), (error) => error instanceof ManagementError && error.code === 'management-service-missing');
  assert.throws(
    () => resolveHostService({ get: () => { throw new Error('cannot get property "x" without inject'); } }, 'sessionController'),
    (error) => error.code === 'management-service-missing',
  );
});
