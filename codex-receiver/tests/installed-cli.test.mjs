import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveVerifiedCli, refreshInstalledCli } from '../adapters/codex/installed-cli.mjs';

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const compatible = async () => ({ help: 'Usage: codex queue --thread UUID --message TEXT', version: 'codex-cli 0.163.0-alpha.11.2' });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-cli-'));
  t.after(() => {
    const absolute = path.resolve(dir);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('lab-cli-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const root = path.join(dir, 'OpenAI', 'Codex', 'bin');
  fs.mkdirSync(root, { recursive: true });
  const install = (id, text = 'inert test fixture, never execute') => {
    const folder = path.join(root, id); fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'codex.exe'); fs.writeFileSync(file, text); return file;
  };
  const cli = install('aaaaaaaaaaaaaaaa');
  const config = { v: 2, cli, cli_sha256: digest(cli), cli_install_root: root, allow_installed_cli_refresh: true,
    thread_id: crypto.randomUUID(), window_id: crypto.randomUUID(), binding_epoch: crypto.randomUUID(),
    installation_id: crypto.randomUUID(), instance_id: crypto.randomUUID(), enabled: true,
    workspace: path.join(dir, 'workspace'), rollout_path: path.join(dir, 'rollout.jsonl'), state_db: path.join(dir, 'state.sqlite'),
    runtime_dir: path.join(dir, 'runtime'), allowed_senders: ['dsh:session-11111111-1111-4111-8111-111111111111'],
    rate_limit: { max_submissions: 11, window_ms: 3600000 }, start_at_logon: false };
  fs.mkdirSync(config.runtime_dir); const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(config));
  return { dir, root, cli, config, file, install };
}

test('a valid pin wins over other installed versions and untrusted PATH entries', async (t) => {
  const f = fixture(t), other = f.install('bbbbbbbbbbbbbbbb', 'other version'); const calls = [];
  const found = await resolveVerifiedCli(f.config, { envPath: path.dirname(other) + path.delimiter + f.dir,
    inspect: async (file) => { calls.push(file); return compatible(); } });
  assert.equal(found.cli, fs.realpathSync(f.cli)); assert.deepEqual(calls, [fs.realpathSync(f.cli)]);
  assert.equal(found.cli_sha256, f.config.cli_sha256);
});

test('removed pin resolves only one already-installed same-root replacement', async (t) => {
  const f = fixture(t); fs.unlinkSync(f.cli); const next = f.install('bbbbbbbbbbbbbbbb', 'updated fixture');
  const found = await resolveVerifiedCli(f.config, { envPath: path.join(f.dir, 'untrusted'), inspect: compatible });
  assert.equal(found.cli, fs.realpathSync(next)); assert.equal(found.cli_sha256, digest(next));
  assert.equal(fs.readFileSync(next, 'utf8'), 'updated fixture');
});

test('multiple installed candidates pause without inspecting or using mtimes', async (t) => {
  const f = fixture(t); fs.unlinkSync(f.cli); const a = f.install('bbbbbbbbbbbbbbbb'); const b = f.install('cccccccccccccccc');
  fs.utimesSync(b, new Date(), new Date(Date.now() + 100000)); let calls = 0;
  await assert.rejects(resolveVerifiedCli(f.config, { envPath: '', inspect: async () => { calls++; return compatible(); } }), /CLI_SELECTION_AMBIGUOUS/);
  assert.equal(calls, 0);
  const selected = await resolveVerifiedCli(f.config, { envPath: path.dirname(a), inspect: compatible });
  assert.equal(selected.cli, fs.realpathSync(a));
  await assert.rejects(resolveVerifiedCli(f.config, { envPath: [path.dirname(a), path.dirname(b)].join(path.delimiter), inspect: compatible }), /AMBIGUOUS/);
});

test('outside-root PATH binaries are never inspected, even when named codex.exe', async (t) => {
  const f = fixture(t); fs.unlinkSync(f.cli); const rogue = path.join(f.dir, 'codex.exe'); fs.writeFileSync(rogue, 'never execute'); let calls = 0;
  await assert.rejects(resolveVerifiedCli(f.config, { envPath: f.dir, inspect: async () => { calls++; return compatible(); } }), /NO_COMPATIBLE_INSTALLED_CLI/);
  assert.equal(calls, 0);
  await assert.rejects(resolveVerifiedCli({ ...f.config, cli: rogue }, { inspect: compatible }), /CLI_INSTALL_ROOT_UNSUPPORTED/);
});

test('a same-prefix sibling directory is outside the recorded install root', async (t) => {
  const f = fixture(t); const sibling = f.root + '-other'; fs.mkdirSync(sibling); const rogue = path.join(sibling, 'codex.exe'); fs.writeFileSync(rogue, 'inert');
  await assert.rejects(resolveVerifiedCli({ ...f.config, cli: rogue }, { inspect: compatible }), /CLI_INSTALL_ROOT_UNSUPPORTED/);
});

test('a junction to an outside-root candidate pauses before inspection', async (t) => {
  const f = fixture(t); fs.unlinkSync(f.cli); const outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'codex.exe'), 'inert');
  const link = path.join(f.root, 'bbbbbbbbbbbbbbbb'); fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  let calls = 0;
  await assert.rejects(resolveVerifiedCli(f.config, { envPath: link, inspect: async () => { calls++; return compatible(); } }), /CLI_CANDIDATE_OUTSIDE_INSTALL_ROOT/);
  assert.equal(calls, 0);
});

test('disabled refresh rejects missing or changed pins before inspection', async (t) => {
  const f = fixture(t); let calls = 0; const inspect = async () => { calls++; return compatible(); };
  fs.writeFileSync(f.cli, 'changed');
  await assert.rejects(resolveVerifiedCli({ ...f.config, allow_installed_cli_refresh: false }, { inspect }), /CLI_BINARY_CHANGED/);
  fs.unlinkSync(f.cli); f.install('bbbbbbbbbbbbbbbb');
  await assert.rejects(resolveVerifiedCli({ ...f.config, allow_installed_cli_refresh: false }, { inspect }), /CLI_BINARY_CHANGED/);
  assert.equal(calls, 0);
});

test('unsupported help, non-vendor version and inspection failures never update config', async (t) => {
  for (const info of [{ help: '--thread-local --message', version: 'codex-cli 1.2.3' },
    { help: '--thread --message-file', version: 'codex-cli 1.2.3' }, { help: '--thread --message', version: 'other-cli 1.2.3' }]) {
    const f = fixture(t), before = fs.readFileSync(f.file, 'utf8');
    await assert.rejects(refreshInstalledCli(f.config, f.file, { inspect: async () => info }), /CLI_QUEUE_UNSUPPORTED/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(fs.existsSync(f.file + '.cli-refresh.lock'), false);
  }
  const f = fixture(t);
  await assert.rejects(resolveVerifiedCli(f.config, { inspect: async () => { throw new Error('fixture inspection failed'); } }), /CLI_INSPECTION_FAILED/);
});

test('binary replacement during inspection pauses rather than pinning the replacement', async (t) => {
  const f = fixture(t), before = fs.readFileSync(f.file, 'utf8');
  await assert.rejects(refreshInstalledCli(f.config, f.file, { inspect: async () => { fs.writeFileSync(f.cli, 'changed during inspection'); return compatible(); } }), /CLI_CHANGED_DURING_INSPECTION/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('refresh preserves all binding, budget, startup, ledger and future metadata', async (t) => {
  const f = fixture(t); const config = { ...f.config, future_binding_policy: { approval: 'explicit', epoch: 7 } };
  fs.writeFileSync(f.file, JSON.stringify(config)); fs.unlinkSync(f.cli); const next = f.install('bbbbbbbbbbbbbbbb', 'new fixture');
  const ledger = path.join(config.runtime_dir, 'ledger.json'); const ledgerText = '{"entries":{"existing":{"status":"NATIVE_QUEUED"}}}'; fs.writeFileSync(ledger, ledgerText);
  await refreshInstalledCli(config, f.file, { inspect: compatible, envPath: '' });
  const after = JSON.parse(fs.readFileSync(f.file));
  assert.equal(after.cli, fs.realpathSync(next)); assert.equal(after.cli_sha256, digest(next));
  for (const key of ['thread_id', 'window_id', 'binding_epoch', 'installation_id', 'instance_id', 'workspace',
    'rollout_path', 'runtime_dir', 'state_db', 'enabled', 'start_at_logon']) assert.equal(after[key], f.config[key]);
  assert.deepEqual(after.allowed_senders, f.config.allowed_senders); assert.equal(after.rate_limit.max_submissions, 11);
  assert.deepEqual(after.future_binding_policy, { approval: 'explicit', epoch: 7 }); assert.equal(fs.readFileSync(ledger, 'utf8'), ledgerText);
  assert.equal(fs.readdirSync(f.dir).filter((name) => name.startsWith('config.json.cli-backup-')).length, 1);
  const audit = JSON.parse(fs.readFileSync(path.join(config.runtime_dir, 'cli-refresh.jsonl'), 'utf8').trim());
  assert.equal(audit.binding_changed, false); assert.equal(audit.software_installed, false);
});

test('concurrent owner edits of any protected field are never overwritten by refresh', async (t) => {
  for (const patch of [{ enabled: false }, { rate_limit: { max_submissions: 2, window_ms: 3600000 } },
    { binding_epoch: crypto.randomUUID() }, { instance_id: crypto.randomUUID() }, { workspace: path.join(os.tmpdir(), 'other-workspace') },
    { future_binding_policy: 'changed-by-owner' }]) {
    const f = fixture(t); let edited;
    await assert.rejects(refreshInstalledCli(f.config, f.file, { inspect: async () => {
      edited = JSON.stringify({ ...f.config, ...patch }); fs.writeFileSync(f.file, edited); return compatible();
    } }), /BINDING_CONFIG_CHANGED/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), edited); assert.equal(fs.existsSync(f.file + '.cli-refresh.lock'), false);
  }
});

test('a second refresh cannot race the first or delete its lock', async (t) => {
  const f = fixture(t); const sentinel = JSON.stringify({ nonce: 'another-owner' }); fs.writeFileSync(f.file + '.cli-refresh.lock', sentinel);
  await assert.rejects(refreshInstalledCli(f.config, f.file, { inspect: compatible }), /CLI_REFRESH_LOCKED_REVIEW_REQUIRED/);
  assert.equal(fs.readFileSync(f.file + '.cli-refresh.lock', 'utf8'), sentinel);
});

test('read-only resolution never creates a config, audit log, or backup', async (t) => {
  const f = fixture(t); fs.unlinkSync(f.file); const before = fs.readdirSync(f.dir).sort();
  await resolveVerifiedCli(f.config, { inspect: compatible });
  assert.deepEqual(fs.readdirSync(f.dir).sort(), before); assert.deepEqual(fs.readdirSync(f.config.runtime_dir), []);
});
