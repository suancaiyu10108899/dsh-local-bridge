import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeDirFor } from '../src/runtime.mjs';

test('neutral install app resolves its runtime from the matching locator', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-runtime-dir-'));
  try {
    const localAppData = path.join(root, 'LocalAppData');
    const appRoot = path.join(localAppData, 'LocalAgentBridge', 'app', 'v');
    const liveRuntime = path.join(root, 'live-runtime');
    fs.mkdirSync(appRoot, { recursive: true });
    fs.mkdirSync(path.join(localAppData, 'LocalAgentBridge'), { recursive: true });
    fs.writeFileSync(path.join(localAppData, 'LocalAgentBridge', 'installation.json'), JSON.stringify({
      v: 1, installation_id: 'i', instance_id: 'n', active_version: 'v', app_root: appRoot,
      runtime_root: liveRuntime, hub_owner_kind: 'COMPANION_OWNED', protocol_version: 1, state_schema: 1,
    }));
    assert.equal(runtimeDirFor({ projectRoot: appRoot, env: { LOCALAPPDATA: localAppData } }), path.resolve(liveRuntime));
    assert.equal(runtimeDirFor({ projectRoot: path.join(root, 'other-app'), env: { LOCALAPPDATA: localAppData } }), path.join(root, 'other-app', '.local', 'runtime'));
    assert.equal(runtimeDirFor({ projectRoot: appRoot, env: { LOCALAPPDATA: localAppData, LAB_BRIDGE_RUNTIME_DIR: path.join(root, 'override') } }), path.join(root, 'override'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});