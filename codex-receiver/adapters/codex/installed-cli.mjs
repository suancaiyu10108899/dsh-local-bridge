// Discover only already-installed vendor CLI binaries. Never download/update software.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeJsonAtomic } from '../../src/runtime.mjs';

const execute = promisify(execFile);
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function discoverInstalledCli(c, { inspect, envPath = process.env.PATH ?? '' } = {}) {
  const root = path.resolve(c.cli_install_root ?? path.dirname(path.dirname(c.cli)));
  if (path.basename(root).toLowerCase() !== 'bin' || path.basename(path.dirname(root)).toLowerCase() !== 'codex' ||
      !/^codex(?:\.exe)?$/i.test(path.basename(c.cli))) throw new Error('CLI_INSTALL_ROOT_UNSUPPORTED');
  const inside = (file) => { const rel = path.relative(root, path.resolve(file)); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
  const name = path.basename(c.cli), paths = envPath.split(path.delimiter).map((dir) => path.join(dir, name)).filter(inside);
  const directories = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[a-f0-9]{8,64}$/i.test(d.name))
    .map((d) => path.join(root, d.name, name)).filter((p) => fs.existsSync(p)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (fs.existsSync(c.cli)) paths.push(c.cli);
  paths.push(...directories);
  for (const candidate of [...new Set(paths)]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const info = inspect ? await inspect(candidate) : {
        help: (await execute(candidate, ['queue', '--help'], { windowsHide: true, timeout: 10000, maxBuffer: 65536 })).stdout,
        version: (await execute(candidate, ['--version'], { windowsHide: true, timeout: 10000, maxBuffer: 65536 })).stdout.trim()
      };
      if (!info.help.includes('--thread') || !info.help.includes('--message') || !/^codex-cli\s/.test(info.version)) continue;
      return { cli: candidate, cli_sha256: hash(candidate), cli_version: info.version, cli_install_root: root };
    } catch { /* unsupported installed candidate; leave it untouched */ }
  }
  throw new Error('NO_COMPATIBLE_INSTALLED_CLI');
}

export async function refreshInstalledCli(c, configPath, options) {
  if (c.allow_installed_cli_refresh === false) throw new Error('CLI_BINARY_CHANGED');
  const replacement = await discoverInstalledCli(c, options);
  const latest = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (latest.thread_id !== c.thread_id || latest.window_id !== c.window_id ||
      JSON.stringify(latest.allowed_senders) !== JSON.stringify(c.allowed_senders)) throw new Error('BINDING_CONFIG_CHANGED');
  const old = { cli: c.cli, cli_sha256: c.cli_sha256 };
  writeJsonAtomic(configPath, { ...latest, ...replacement, last_cli_refresh_at: new Date().toISOString() });
  fs.appendFileSync(path.join(c.runtime_dir, 'cli-refresh.jsonl'), JSON.stringify({ at: new Date().toISOString(),
    action: 'VALIDATED_INSTALLED_CLI_REFRESH', old, replacement, software_installed: false }) + '\n');
  Object.assign(c, replacement, { enabled: latest.enabled });
  return replacement;
}
