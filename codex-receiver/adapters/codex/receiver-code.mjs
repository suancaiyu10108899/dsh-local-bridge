// Actual package bytes, separate from the installation's declared version.
// Runtime configuration, tokens, messages and tests are never part of this hash.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const RECEIVER_PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export function readReceiverCodeIdentity(root = RECEIVER_PACKAGE_ROOT) {
  try {
    const metadata = fs.readFileSync(path.join(root, 'package.json'));
    const version = JSON.parse(metadata.toString('utf8')).version;
    const hash = crypto.createHash('sha256'); hash.update('package.json\0'); hash.update(metadata);
    let count = 0;
    for (const directory of ['adapters/codex', 'src']) {
      for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.name.endsWith('.mjs')) continue;
        if (!entry.isFile()) throw new Error('CODE_SOURCE_LINK_REVIEW_REQUIRED');
        const relative = directory + '/' + entry.name;
        hash.update('\0' + relative + '\0'); hash.update(fs.readFileSync(path.join(root, relative))); count++;
      }
    }
    return { readable: true, package_version: typeof version === 'string' ? version : 'UNKNOWN', code_sha256: hash.digest('hex'),
      source_entry: path.join(root, 'adapters', 'codex', 'daily-receiver.mjs'), source_files: count, node_version: process.version };
  } catch (error) { return { readable: false, reason_code: error.code ?? error.message ?? 'CODE_MANIFEST_UNREADABLE' }; }
}
export const LOADED_RECEIVER_CODE = Object.freeze(readReceiverCodeIdentity());

export function receiverCodeUnchanged() {
  const current = readReceiverCodeIdentity();
  return current.readable && LOADED_RECEIVER_CODE.readable && current.code_sha256 === LOADED_RECEIVER_CODE.code_sha256;
}
