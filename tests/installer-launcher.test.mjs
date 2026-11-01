import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  planSchedulerLaunch,
  quoteWindowsArgument,
  writeLauncherArtifact,
} from '../installer/scheduler.mjs';
import { writeInstallationAtomic, installationPaths } from '../src/installation.mjs';

function makeVersion(root, name, marker) {
  const appRoot = path.join(root, 'app', name);
  const companionDir = path.join(appRoot, 'companion');
  fs.mkdirSync(companionDir, { recursive: true });
  fs.writeFileSync(path.join(companionDir, 'main.mjs'), [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)});`,
    'process.exit(0);',
    '',
  ].join('\n'));
  return appRoot;
}

test('stable launcher enforces same-runtime outer budget, current app_root version and safe visible stop', { timeout: 30_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge launcher & test-'));
  try {
    const paths = installationPaths(root);
    const runtime = paths.runtimeRoot;
    fs.mkdirSync(runtime, { recursive: true });
    const v1 = makeVersion(root, 'v1', path.join(root, 'v1.marker'));
    const v2 = makeVersion(root, 'v2', path.join(root, 'v2.marker'));
    const base = {
      v: 1,
      installation_id: 'install-launcher',
      instance_id: 'instance-launcher',
      active_version: 'v1',
      app_root: v1,
      runtime_root: runtime,
      hub_owner_kind: 'COMPANION_OWNED',
      protocol_version: 1,
      state_schema: 1,
    };
    writeInstallationAtomic({ root, installation: base });
    const budgetFile = path.join(runtime, 'companion', 'outer-budget.json');
    const innerFile = path.join(runtime, 'companion', 'hub-restart-state.json');
    fs.mkdirSync(path.dirname(innerFile), { recursive: true });
    fs.writeFileSync(innerFile, 'inner-sentinel', 'utf8');
    const plan = planSchedulerLaunch({
      installationRoot: root,
      runtimeRoot: runtime,
      locatorPath: paths.locator,
      installationId: base.installation_id,
      instanceId: base.instance_id,
      nodeExecutable: process.execPath,
      now: 1_000,
    });
    assert.equal(plan.logon_trigger.enabled, false);
    assert.equal(plan.outer_budget_file, budgetFile);
    assert.equal(plan.launcher.content.includes('locator.app_root'), false); // reads installation.app_root
    assert.match(plan.launcher.content, /installation\.app_root/);
    assert.match(plan.launcher.content, /outer-budget/);
    assert.match(plan.launcher.content, /windowsHide: true/);
    assert.match(plan.xml, /<Arguments>&quot;.*launch-companion\.mjs&quot; --reason MANUAL_START<\/Arguments>/);
    assert.equal(plan.action.executable, process.execPath);
    assert.match(plan.xml, /<Enabled>false<\/Enabled>/);
    writeLauncherArtifact(plan);

    const run = () => spawnSync(process.execPath, [plan.launcher.path], { encoding: 'utf8', windowsHide: true });
    let result = run();
    assert.equal(result.status, 20, result.stderr); // unexpected clean child exit under RUNNING
    const v1Marker = path.join(root, 'v1.marker');
    const start = Date.now();
    while (!fs.existsSync(v1Marker) && Date.now() - start < 5_000) { /* wait for child */ }
    assert.equal(fs.readFileSync(v1Marker, 'utf8'), 'v1');
    assert.equal(JSON.parse(fs.readFileSync(budgetFile, 'utf8')).attempts.length, 1);

    // Version switch: the same stable launcher must resolve the new app_root entry.
    writeInstallationAtomic({ root, installation: { ...base, active_version: 'v2', app_root: v2 } });
    result = run();
    assert.equal(result.status, 20, result.stderr); // unexpected clean child exit under RUNNING
    const v2Marker = path.join(root, 'v2.marker');
    const switchStart = Date.now();
    while (!fs.existsSync(v2Marker) && Date.now() - switchStart < 5_000) { /* wait for child */ }
    assert.equal(fs.readFileSync(v2Marker, 'utf8'), 'v2');
    assert.equal(JSON.parse(fs.readFileSync(budgetFile, 'utf8')).attempts.length, 2);

    // Normal global STOPPED is a normal visible stop, not a crash/start.
    const desired = path.join(runtime, 'desired-state.json');
    fs.writeFileSync(desired, JSON.stringify({ desired_state: 'STOPPED' }));
    const before = fs.readFileSync(budgetFile, 'utf8');
    result = run();
    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(budgetFile, 'utf8'), before);

    fs.rmSync(desired);
    // Broken/null/empty desired-state is fail-closed, not RUNNING.
    for (const raw of ['{broken', 'null', '{}']) {
      fs.writeFileSync(desired, raw);
      fs.rmSync(v2Marker, { force: true });
      const beforeBadDesired = fs.readFileSync(budgetFile, 'utf8');
      result = run();
      assert.notEqual(result.status, 0, `desired ${raw} must not fork`);
      assert.equal(fs.existsSync(v2Marker), false);
      assert.equal(fs.readFileSync(budgetFile, 'utf8'), beforeBadDesired);
    }
    fs.rmSync(desired, { force: true });
    // Exhausted and corrupt budgets fail closed without forking.
    fs.writeFileSync(budgetFile, JSON.stringify({ v: 1, attempts: [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()], updated_at: new Date().toISOString() }));
    const exhaustedMarker = path.join(root, 'v3.marker');
    fs.rmSync(v2Marker, { force: true });
    result = run();
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(v2Marker), false);

    fs.writeFileSync(budgetFile, '{not-json');
    result = run();
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(innerFile, 'utf8'), 'inner-sentinel');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows argument quoting keeps spaces, ampersands and quotes as one argument', () => {
  assert.equal(quoteWindowsArgument('C:\\a b\\main.mjs'), '"C:\\a b\\main.mjs"');
  assert.equal(quoteWindowsArgument('C:\\a&b\\main.mjs'), '"C:\\a&b\\main.mjs"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
});
test('stable launcher waits for child lifecycle and propagates non-zero exit', { timeout: 15_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge launcher foreground-'));
  try {
    const paths = installationPaths(root);
    const app = path.join(root, 'app');
    const companionDir = path.join(app, 'companion');
    fs.mkdirSync(companionDir, { recursive: true });
    const marker = path.join(root, 'started.marker');
    fs.writeFileSync(path.join(companionDir, 'main.mjs'), [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'started');`,
      'setTimeout(() => process.exit(17), 600);',
      '',
    ].join('\n'));
    const runtime = paths.runtimeRoot;
    fs.mkdirSync(runtime, { recursive: true });
    writeInstallationAtomic({
      root,
      installation: {
        v: 1, installation_id: 'install-foreground', instance_id: 'instance-foreground',
        active_version: '0.1.0-test', app_root: app, runtime_root: runtime,
        hub_owner_kind: 'MANUAL', protocol_version: 1, state_schema: 1,
      },
    });
    const plan = planSchedulerLaunch({
      installationRoot: root, runtimeRoot: runtime, locatorPath: paths.locator,
      nodeExecutable: process.execPath, now: 1_000,
    });
    writeLauncherArtifact(plan);
    const started = Date.now();
    const result = spawnSync(process.execPath, plan.action.arguments, { encoding: 'utf8', windowsHide: true });
    const elapsed = Date.now() - started;
    assert.equal(fs.readFileSync(marker, 'utf8'), 'started');
    assert.equal(result.status, 17);
    assert.ok(elapsed >= 500, `wrapper must not exit before child (elapsed=${elapsed})`);
    assert.equal(JSON.parse(fs.readFileSync(plan.outer_budget_file, 'utf8')).attempts.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('unexpected child exit 0 while desired RUNNING is visible and outer recovery is finite', { timeout: 20_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge launcher clean-exit-'));
  try {
    const paths = installationPaths(root);
    const app = path.join(root, 'app');
    fs.mkdirSync(path.join(app, 'companion'), { recursive: true });
    fs.writeFileSync(path.join(app, 'companion', 'main.mjs'), 'process.exit(0);\n');
    const runtime = paths.runtimeRoot;
    fs.mkdirSync(runtime, { recursive: true });
    writeInstallationAtomic({
      root,
      installation: {
        v: 1, installation_id: 'install-clean-exit', instance_id: 'instance-clean-exit',
        active_version: '0.1.0-test', app_root: app, runtime_root: runtime,
        hub_owner_kind: 'MANUAL', protocol_version: 1, state_schema: 1,
      },
    });
    const plan = planSchedulerLaunch({ installationRoot: root, runtimeRoot: runtime, locatorPath: paths.locator, nodeExecutable: process.execPath, now: 1_000 });
    writeLauncherArtifact(plan);
    const run = () => spawnSync(process.execPath, plan.action.arguments, { encoding: 'utf8', windowsHide: true });
    for (let i = 0; i < 3; i += 1) {
      const result = run();
      assert.equal(result.status, 20);
      assert.equal(fs.existsSync(path.join(runtime, 'companion', 'outer-recovery.json')), true);
    }
    const blocked = run();
    assert.equal(blocked.status, 7, 'outer budget must stop further recovery');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});