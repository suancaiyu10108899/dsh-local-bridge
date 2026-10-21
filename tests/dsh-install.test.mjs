import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  PLUGIN_ID,
  PLUGIN_URL,
  defaultProfilePath,
  disableModuleWatch,
  enableModuleWatch,
  insertBlock,
  installPlugin,
  markerPresent,
  moduleWatchBlock,
  moduleWatchStatus,
  pathsForProfile,
  pluginStatus,
  pluginVersionedUrl,
  removeInsertBlock,
  sha256,
  uninstallPlugin,
  watchPathsForProfile,
} from '../src/dsh-install.mjs';

const BASE = '# dsh profile user patch\n- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n  config:\n    preference: light\n';

function fixture(base = BASE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-install-'));
  const profilePath = path.join(dir, 'cordis.patch.yml');
  fs.writeFileSync(profilePath, base, 'utf8');
  const watch = watchPathsForProfile(profilePath, { installRoot: path.join(dir, 'runtime-install') });
  return {
    dir,
    profilePath,
    runtimeDir: path.join(dir, 'runtime'),
    stateFile: path.join(dir, 'state', 'install-state.json'),
    backupDir: path.join(dir, 'backups'),
    watchStateFile: watch.stateFile,
    watchBackupDir: watch.backupDir,
    base,
  };
}

test('module watch enable appends one hmr row and disable restores exact bytes', () => {
  const f = fixture();
  const enabled = enableModuleWatch({
    profilePath: f.profilePath,
    stateFile: f.watchStateFile,
    backupDir: f.watchBackupDir,
    now: new Date('2026-10-20T10:00:00Z'),
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.alreadyPresent, false);
  assert.equal(enabled.watched, true);
  assert.equal(enabled.beforeSha256, sha256(f.base));
  const content = fs.readFileSync(f.profilePath, 'utf8');
  assert.equal(content.includes(moduleWatchBlock()), true);
  assert.equal((content.match(/- id:\s*hmr/g) ?? []).length, 1);
  assert.equal(content.startsWith(f.base), true);
  assert.equal(fs.readFileSync(enabled.backupPath, 'utf8'), f.base);

  const again = enableModuleWatch({ profilePath: f.profilePath, stateFile: f.watchStateFile, backupDir: f.watchBackupDir });
  assert.equal(again.alreadyPresent, true);
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), content);

  const disabled = disableModuleWatch({ profilePath: f.profilePath, stateFile: f.watchStateFile, backupDir: f.watchBackupDir });
  assert.equal(disabled.restoredFromBackup, true);
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), f.base);
  assert.equal(moduleWatchStatus({ profilePath: f.profilePath, stateFile: f.watchStateFile }).watched, false);
});

test('disabling module watch after an external edit removes only the hmr row', () => {
  const f = fixture();
  enableModuleWatch({ profilePath: f.profilePath, stateFile: f.watchStateFile, backupDir: f.watchBackupDir });
  const edited = `${fs.readFileSync(f.profilePath, 'utf8')}- id: ui-settings\n  name: "@deepseek-ai/dsh-client-ui-settings"\n`;
  fs.writeFileSync(f.profilePath, edited, 'utf8');
  const disabled = disableModuleWatch({ profilePath: f.profilePath, stateFile: f.watchStateFile, backupDir: f.watchBackupDir });
  assert.equal(disabled.restoredFromBackup, false);
  assert.equal(disabled.surgical, true);
  const content = fs.readFileSync(f.profilePath, 'utf8');
  assert.equal(content.includes(moduleWatchBlock()), false);
  assert.equal(content.includes('ui-settings'), true);
  assert.equal(content.startsWith(f.base), true);
});

test('enable module watch refuses a conflicting existing hmr row', () => {
  const f = fixture(`${BASE}\n- id: hmr\n  config:\n    root: ["D:/elsewhere"]\n`);
  assert.throws(
    () => enableModuleWatch({ profilePath: f.profilePath, stateFile: f.watchStateFile, backupDir: f.watchBackupDir }),
    (error) => error.code === 'watch-row-conflict',
  );
});

test('CLI install enables module watch and uninstall restores the exact original bytes', () => {
  const f = fixture();
  const cli = path.join(process.cwd(), 'bin', 'lab-bridge.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--profile', f.profilePath], {
    encoding: 'utf8',
    env: { ...process.env, LAB_BRIDGE_RUNTIME_DIR: f.runtimeDir },
  });

  const installedRun = run('install-dsh-plugin');
  assert.equal(installedRun.status, 0, installedRun.stderr);
  const installed = JSON.parse(installedRun.stdout);
  assert.equal(installed.installed, true);
  assert.equal(installed.moduleWatch.watched, true);
  const installedContent = fs.readFileSync(f.profilePath, 'utf8');
  assert.equal(installedContent.includes(moduleWatchBlock()), true);
  assert.equal(markerPresent(installedContent), true);

  const watchStatusRun = run('module-watch-status');
  assert.equal(watchStatusRun.status, 0, watchStatusRun.stderr);
  assert.equal(JSON.parse(watchStatusRun.stdout).watched, true);

  const removedRun = run('uninstall-dsh-plugin');
  assert.equal(removedRun.status, 0, removedRun.stderr);
  const removed = JSON.parse(removedRun.stdout);
  assert.equal(removed.restoredFromBackup, true);
  assert.equal(removed.moduleWatch.restoredFromBackup, true);
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), f.base);
});

test('status reports an uninstalled profile', () => {
  const f = fixture();
  const status = pluginStatus({ profilePath: f.profilePath, stateFile: f.stateFile });
  assert.equal(status.profileExists, true);
  assert.equal(status.installed, false);
  assert.equal(status.profileSha256, sha256(f.base));
  assert.equal(status.pluginUrl.startsWith('file:///'), true);
});

test('install appends one row, backs up the original and is idempotent', () => {
  const f = fixture();
  const installed = installPlugin({ profilePath: f.profilePath, stateFile: f.stateFile, backupDir: f.backupDir, now: new Date('2026-10-20T10:00:00Z') });
  assert.equal(installed.ok, true);
  assert.equal(installed.alreadyInstalled, false);
  assert.equal(installed.beforeSha256, sha256(f.base));
  assert.notEqual(installed.afterSha256, installed.beforeSha256);

  const content = fs.readFileSync(f.profilePath, 'utf8');
  assert.equal(markerPresent(content), true);
  assert.equal((content.match(new RegExp(PLUGIN_ID, 'g')) ?? []).length, 1);
  assert.equal(content.startsWith(f.base), true);
  assert.equal(fs.readFileSync(installed.backupPath, 'utf8'), f.base);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8').includes(installed.afterSha256), true);

  const second = installPlugin({ profilePath: f.profilePath, stateFile: f.stateFile, backupDir: f.backupDir });
  assert.equal(second.alreadyInstalled, true);
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), content);
});

test('uninstall restores the exact original bytes when nothing else changed', () => {
  const f = fixture();
  installPlugin({ profilePath: f.profilePath, stateFile: f.stateFile, backupDir: f.backupDir });
  const removed = uninstallPlugin({ profilePath: f.profilePath, stateFile: f.stateFile });
  assert.equal(removed.ok, true);
  assert.equal(removed.restoredFromBackup, true);
  assert.equal(removed.surgical, false);
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), f.base);
  assert.equal(sha256(fs.readFileSync(f.profilePath, 'utf8')), sha256(f.base));
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.equal(pluginStatus({ profilePath: f.profilePath, stateFile: f.stateFile }).installed, false);
});

test('uninstall removes only the bridge row when the file was edited afterwards', () => {
  const f = fixture();
  installPlugin({ profilePath: f.profilePath, stateFile: f.stateFile, backupDir: f.backupDir });
  const edited = `${fs.readFileSync(f.profilePath, 'utf8')}- id: ui-settings\n  name: "@deepseek-ai/dsh-client-ui-settings"\n`;
  fs.writeFileSync(f.profilePath, edited, 'utf8');
  const removed = uninstallPlugin({ profilePath: f.profilePath, stateFile: f.stateFile });
  assert.equal(removed.restoredFromBackup, false);
  assert.equal(removed.surgical, true);
  const content = fs.readFileSync(f.profilePath, 'utf8');
  assert.equal(markerPresent(content), false);
  assert.equal(content.includes('ui-settings'), true);
  assert.equal(content.startsWith(f.base), true);
});

test('uninstall without an installed row is a no-op', () => {
  const f = fixture();
  const removed = uninstallPlugin({ profilePath: f.profilePath, stateFile: f.stateFile });
  assert.equal(removed.alreadyRemoved, true);
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), f.base);
});

test('install refuses a missing profile and a missing plugin module', () => {
  const f = fixture();
  assert.throws(
    () => installPlugin({ profilePath: path.join(f.dir, 'missing.yml'), stateFile: f.stateFile, backupDir: f.backupDir }),
    (error) => error.code === 'profile-missing',
  );
});

test('removeInsertBlock preserves CRLF and surrounding content', () => {
  const base = 'a: 1\r\nb: 2\r\n';
  const content = `${base}\r\n${insertBlock().replaceAll('\n', '\r\n')}`;
  const stripped = removeInsertBlock(content);
  assert.equal(stripped, base);
  assert.equal(stripped.includes('\r\n'), true);
});

test('defaultProfilePath honours DSH_PROFILE_DIR', () => {
  const custom = path.join('C:', 'custom-profile');
  assert.equal(
    defaultProfilePath({ env: { DSH_PROFILE_DIR: custom }, home: 'C:/Users/example' }),
    path.join(custom, 'cordis.patch.yml'),
  );
  assert.equal(
    defaultProfilePath({ env: {}, home: 'C:/Users/example' }),
    path.join('C:/Users/example', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
  );
});

test('CLI install/status/uninstall round-trips against an explicit profile', () => {
  const f = fixture();
  const cli = path.join(process.cwd(), 'bin', 'lab-bridge.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--profile', f.profilePath], {
    encoding: 'utf8',
    env: { ...process.env, LAB_BRIDGE_RUNTIME_DIR: f.runtimeDir },
  });

  const installedRun = run('install-dsh-plugin');
  assert.equal(installedRun.status, 0, installedRun.stderr);
  const installed = JSON.parse(installedRun.stdout);
  assert.equal(installed.ok, true);
  assert.equal(installed.installed, true);
  assert.equal(installed.stateFile.startsWith(f.runtimeDir), true, 'CLI must keep install state inside the overridden runtime dir');

  const statusRun = run('dsh-plugin-status');
  assert.equal(statusRun.status, 0, statusRun.stderr);
  assert.equal(JSON.parse(statusRun.stdout).installed, true);

  const removedRun = run('uninstall-dsh-plugin');
  assert.equal(removedRun.status, 0, removedRun.stderr);
  assert.equal(JSON.parse(removedRun.stdout).restoredFromBackup, true);
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), f.base);
});

test('default install state is scoped per profile path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-install-scope-'));
  const a = pathsForProfile('C:/profiles/a/cordis.patch.yml', { installRoot: root });
  const b = pathsForProfile('C:/profiles/b/cordis.patch.yml', { installRoot: root });
  assert.notEqual(a.stateFile, b.stateFile);
  assert.notEqual(a.backupDir, b.backupDir);
  assert.equal(a.stateFile.includes('profile-'), true);

  const foreignState = path.join(root, 'foreign.json');
  fs.writeFileSync(foreignState, JSON.stringify({
    profilePath: 'C:/profiles/a/cordis.patch.yml',
    afterSha256: 'AAAA',
    beforeSha256: 'BBBB',
    backupPath: path.join(root, 'missing.yml'),
  }), 'utf8');
  const f = fixture('# b\n');
  const status = pluginStatus({ profilePath: f.profilePath, stateFile: foreignState });
  assert.equal(status.state, null, 'state recorded for another profile must be ignored');
  assert.equal(status.recordedBackupConsistent, false);
});

test('install uses the plain plugin file URL and the versioned helper is stable', () => {
  const versioned = pluginVersionedUrl();
  assert.match(versioned, /^file:\/\/\/.*plugin\.mjs\?v=[0-9a-f]{12}$/);
  assert.equal(versioned, pluginVersionedUrl(), 'stable for unchanged content');
  const f = fixture();
  const installed = installPlugin({ profilePath: f.profilePath, stateFile: f.stateFile, backupDir: f.backupDir });
  assert.equal(installed.rowUrl, PLUGIN_URL);
  assert.equal(installed.urlMatches, true);
  assert.equal(fs.readFileSync(f.profilePath, 'utf8').includes(`name: '${PLUGIN_URL}'`), true);
  assert.equal(fs.readFileSync(f.profilePath, 'utf8').includes('?v='), false);
});

test('reinstall with a different plugin URL upgrades the row without duplicating it', () => {
  const f = fixture();
  const first = installPlugin({
    profilePath: f.profilePath,
    stateFile: f.stateFile,
    backupDir: f.backupDir,
    pluginUrl: 'file:///D:/tmp/plugin.mjs?v=aaaaaaaaaaaa',
  });
  assert.equal(first.upgraded, false);
  const second = installPlugin({
    profilePath: f.profilePath,
    stateFile: f.stateFile,
    backupDir: f.backupDir,
    pluginUrl: 'file:///D:/tmp/plugin.mjs?v=bbbbbbbbbbbb',
  });
  assert.equal(second.upgraded, true);
  assert.equal(second.rowUrl, 'file:///D:/tmp/plugin.mjs?v=bbbbbbbbbbbb');
  const content = fs.readFileSync(f.profilePath, 'utf8');
  assert.equal((content.match(new RegExp(PLUGIN_ID, 'g')) ?? []).length, 1);
  assert.equal(content.includes('aaaaaaaaaaaa'), false);
  assert.equal(second.backupPath, first.backupPath, 'upgrade keeps the original pre-install backup');
  assert.equal(fs.readFileSync(second.backupPath, 'utf8'), f.base);
});
