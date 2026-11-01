// One reversible HKCU Run VALUE, never an existing key or other application's value.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../src/runtime.mjs';

const exec = promisify(execFile);
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const quotePS = (s) => `'${s.replaceAll("'", "''")}'`;
export function startupPlan(c, configFile, node = process.execPath) {
  const script = `& ${quotePS(node)} ${quotePS(fileURLToPath(new URL('./receiver-service.mjs', import.meta.url)))} ${quotePS(path.resolve(configFile))}`;
  return { key: KEY, name: `LocalAgentBridge-${c.thread_id}`,
    command: `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "${script.replaceAll('"', '\\"')}"`,
    readable_launch: script, config_path: path.resolve(configFile), thread_id: c.thread_id };
}
export async function queryStartupRegistryValue(plan, execute = exec) {
  if (plan.key !== KEY || !/^LocalAgentBridge-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(plan.name ?? '')) throw new Error('STARTUP_ENTRY_CONFLICT');
  // Presence is structured, not inferred from a localized reg.exe diagnostic.
  const script = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ErrorActionPreference = 'Stop'", '$key = $null', 'try {',
    "  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run', $false)",
    `  $name = ${quotePS(plan.name)}`,
    "  if ($null -eq $key -or -not ($key.GetValueNames() -contains $name)) {",
    "    [pscustomobject]@{ state = 'ABSENT' } | ConvertTo-Json -Compress",
    '  } else {',
    "    [pscustomobject]@{ state = 'PRESENT'; kind = $key.GetValueKind($name).ToString(); value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } | ConvertTo-Json -Compress",
    '  }', '} catch {',
    "  [pscustomobject]@{ state = 'ERROR' } | ConvertTo-Json -Compress",
    '} finally { if ($null -ne $key) { $key.Dispose() } }',
  ].join('\n');
  let result;
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    result = JSON.parse(stdout.trim());
  } catch { throw new Error('STARTUP_REGISTRY_READ_FAILED'); }
  if (result?.state === 'ABSENT') return null;
  if (result?.state === 'PRESENT' && result.kind === 'String' && typeof result.value === 'string') return result.value;
  throw new Error(result?.state === 'PRESENT' ? 'STARTUP_ENTRY_CONFLICT' : 'STARTUP_REGISTRY_READ_FAILED');
}
export const windowsRegistry = {
  get: queryStartupRegistryValue,
  async set(plan) { await exec('reg.exe', ['ADD', plan.key, '/v', plan.name, '/t', 'REG_SZ', '/d', plan.command, '/f'], { windowsHide: true }); },
  async remove(plan) { await exec('reg.exe', ['DELETE', plan.key, '/v', plan.name, '/f'], { windowsHide: true }); }
};
export async function installStartup(c, file, registry = windowsRegistry) {
  const plan = startupPlan(c, file), record = path.join(c.runtime_dir, 'startup.json');
  const previous = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : null;
  if (previous && (previous.thread_id !== c.thread_id || previous.key !== KEY || previous.name !== plan.name)) throw new Error('STARTUP_ENTRY_CONFLICT');
  const actual = await registry.get(plan);
  if (actual !== null && actual !== plan.command && actual !== previous?.command) throw new Error('STARTUP_ENTRY_CONFLICT');
  if (actual !== plan.command) await registry.set(plan);
  writeJsonAtomic(record, { ...plan, enabled: true, installed_at: new Date().toISOString() });
  return { enabled: true, scope: 'CURRENT_USER_LOGON', name: plan.name, command: plan.readable_launch };
}
export async function removeStartup(c, registry = windowsRegistry) {
  const record = path.join(c.runtime_dir, 'startup.json');
  if (!fs.existsSync(record)) return { enabled: false, action: 'NOT_INSTALLED' };
  const original = fs.readFileSync(record), plan = JSON.parse(original.toString('utf8'));
  if (plan.thread_id !== c.thread_id || plan.key !== KEY || plan.name !== `LocalAgentBridge-${c.thread_id}`) throw new Error('STARTUP_ENTRY_CONFLICT');
  const actual = await registry.get(plan);
  if (!fs.readFileSync(record).equals(original)) throw new Error('STARTUP_ENTRY_CHANGED');
  if (actual !== null && actual !== plan.command) throw new Error('STARTUP_ENTRY_CONFLICT');
  if (actual !== null) await registry.remove(plan);
  if (!fs.readFileSync(record).equals(original)) throw new Error('STARTUP_ENTRY_CHANGED');
  writeJsonAtomic(record, { ...plan, enabled: false, removed_at: new Date().toISOString() });
  return { enabled: false, action: 'REMOVED' };
}
