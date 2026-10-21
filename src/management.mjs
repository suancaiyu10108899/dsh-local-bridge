// T5 host management — isolated, opt-in host-control helpers.
//
// These functions wrap the DSH Host Cordis services documented in the extracted
// 0.2.1-rc.2 packages:
//   - ctx.sessionController.create(request: SessionCreateRequest): SessionCreateValue
//     request { workspaceId?, cwd?, sessionId?, agentPreset? } -> { sessionId, agentPreset? }
//   - ctx.sessionController.list(request: SessionListRequest, signal): SessionListValue
//     request { cursor? } -> { items: SessionSummary[] }
//   - ctx.workspaceController.create(request: WorkspaceCreateRequest): WorkspaceCreateValue
//     request { path } -> { workspace: { workspaceId, path, title, ... }, created }
//   - ctx.workspaceController.delete(request: WorkspaceDeleteRequest): WorkspaceDeleteValue
//     request { workspaceId } -> { deleted: true }
//
// The module is intentionally NOT imported by the running DSH plugin: activating
// host management live changes the user's conversation/workspace UI, so it stays
// isolated until explicitly approved. Tests use mock contexts.
export const HOST_SESSION_CONTROLLER = 'sessionController';
export const HOST_WORKSPACE_CONTROLLER = 'workspaceController';

export class ManagementError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ManagementError';
    this.code = code;
    this.details = details;
  }
}

/** Resolve a Cordis Host service from a plugin context without assuming one accessor. */
export function resolveHostService(ctx, name) {
  if (ctx === undefined || ctx === null) throw new ManagementError('management-context-missing', 'a host context is required');
  // Cordis only exposes injected services as ctx properties; ctx.reflect.get(name, false)
  // is the documented non-strict lookup used by the framework itself.
  if (ctx.reflect !== undefined && ctx.reflect !== null && typeof ctx.reflect.get === 'function') {
    try {
      const reflected = ctx.reflect.get(name, false);
      if (reflected !== undefined && reflected !== null) return reflected;
    } catch {
      /* fall through to the other accessors */
    }
  }
  if (typeof ctx.get === 'function') {
    try {
      const viaGet = ctx.get(name, false);
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    } catch {
      /* fall through */
    }
  }
  if (typeof ctx.service === 'function') {
    try {
      const viaService = ctx.service(name);
      if (viaService !== undefined && viaService !== null) return viaService;
    } catch {
      /* fall through */
    }
  }
  try {
    const direct = ctx[name];
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    /* non-injected property access throws in Cordis */
  }
  throw new ManagementError('management-service-missing', `host service "${name}" is not composed in this host`);
}

function optionalString(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManagementError('management-invalid-request', `${field} must be a non-empty string when provided`);
  }
  return value;
}

/**
 * Create a blank conversation (no prompt, no execution) via the host controller.
 * Creation and execution stay separate: the returned session exists but runs no turn.
 * @returns {Promise<{sessionId: string, agentPreset?: string, request: object}>}
 */
export async function createSession(ctx, { workspaceId, cwd, sessionId, agentPreset } = {}) {
  const controller = resolveHostService(ctx, HOST_SESSION_CONTROLLER);
  if (typeof controller.create !== 'function') {
    throw new ManagementError('management-service-missing', 'sessionController.create is unavailable in this host build');
  }
  if (workspaceId !== undefined && cwd !== undefined) {
    throw new ManagementError('management-invalid-request', 'session.create accepts workspaceId or cwd, not both');
  }
  const request = {
    ...(optionalString(workspaceId, 'workspaceId') === undefined ? {} : { workspaceId }),
    ...(optionalString(cwd, 'cwd') === undefined ? {} : { cwd }),
    ...(optionalString(sessionId, 'sessionId') === undefined ? {} : { sessionId }),
    ...(optionalString(agentPreset, 'agentPreset') === undefined ? {} : { agentPreset }),
  };
  const value = await controller.create(request);
  if (value === undefined || value === null || typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
    throw new ManagementError('management-bad-response', 'sessionController.create did not return a sessionId', { value });
  }
  return {
    sessionId: value.sessionId,
    ...(typeof value.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
    request,
  };
}

/** List persisted conversation summaries without activating any Agent. */
export async function listSessions(ctx, { cursor } = {}) {
  const controller = resolveHostService(ctx, HOST_SESSION_CONTROLLER);
  if (typeof controller.list !== 'function') {
    throw new ManagementError('management-service-missing', 'sessionController.list is unavailable in this host build');
  }
  const request = optionalString(cursor, 'cursor') === undefined ? {} : { cursor };
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(15_000)
    : undefined;
  const value = await controller.list(request, signal);
  if (value === undefined || value === null || !Array.isArray(value.items)) {
    throw new ManagementError('management-bad-response', 'sessionController.list did not return items', { value });
  }
  return { count: value.items.length, items: value.items };
}

/** Create a workspace (project) row backed by an absolute path. */
export async function createWorkspace(ctx, { path: workspacePath } = {}) {
  const controller = resolveHostService(ctx, HOST_WORKSPACE_CONTROLLER);
  if (typeof controller.create !== 'function') {
    throw new ManagementError('management-service-missing', 'workspaceController.create is unavailable in this host build');
  }
  const requestPath = optionalString(workspacePath, 'path');
  if (requestPath === undefined) throw new ManagementError('management-invalid-request', 'path is required');
  if (!(requestPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(requestPath))) {
    throw new ManagementError('management-invalid-request', 'path must be absolute');
  }
  const value = await controller.create({ path: requestPath });
  if (value === undefined || value === null || typeof value.workspace?.workspaceId !== 'string') {
    throw new ManagementError('management-bad-response', 'workspaceController.create did not return a workspace id', { value });
  }
  return {
    workspaceId: value.workspace.workspaceId,
    created: value.created === true,
    workspace: value.workspace,
  };
}

/** Delete a workspace row (does not delete the directory contents). */
export async function deleteWorkspace(ctx, { workspaceId } = {}) {
  const controller = resolveHostService(ctx, HOST_WORKSPACE_CONTROLLER);
  if (typeof controller.delete !== 'function') {
    throw new ManagementError('management-service-missing', 'workspaceController.delete is unavailable in this host build');
  }
  const id = optionalString(workspaceId, 'workspaceId');
  if (id === undefined) throw new ManagementError('management-invalid-request', 'workspaceId is required');
  const value = await controller.delete({ workspaceId: id });
  return { deleted: value?.deleted === true, workspaceId: id };
}

/** Archive a session (stopActivity defaults to false, matching the host contract). */
export async function archiveSession(ctx, { sessionId, stopActivity = false } = {}) {
  const controller = resolveHostService(ctx, HOST_WORKSPACE_CONTROLLER);
  if (typeof controller.archiveSession !== 'function') {
    throw new ManagementError('management-service-missing', 'workspaceController.archiveSession is unavailable in this host build');
  }
  const id = optionalString(sessionId, 'sessionId');
  if (id === undefined) throw new ManagementError('management-invalid-request', 'sessionId is required');
  // The host service takes one request object: { sessionId, stopActivity? }.
  const value = await controller.archiveSession({ sessionId: id, ...(stopActivity === true ? { stopActivity: true } : {}) });
  const archivedSessionIds = Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds : [];
  return { archived: archivedSessionIds.includes(id), sessionId: id, archivedSessionIds, value };
}
