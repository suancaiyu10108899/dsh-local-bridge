// Build a bounded owner-reported reply from this target's existing native
// submission evidence. This helper does not send, enable, consume, or grant.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isValidMessageId } from '../../src/protocol.mjs';
import { UUID_RE, validateReceiverConfig, messageKey, messageFingerprint } from './queue-inbox.mjs';
import { clientRequestContext } from './client-peer.mjs';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel.length > 0 && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};

function evidenceJson(root, name) {
  const file = path.join(root, name);
  try {
    if (!fs.lstatSync(file).isFile() || !inside(fs.realpathSync(root), fs.realpathSync(file))) fail('CLIENT_REPLY_EVIDENCE_UNAVAILABLE');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { fail('CLIENT_REPLY_EVIDENCE_UNAVAILABLE'); }
}

export function readClientReply(config, { requestId, turnId, bodyFile, threadId = process.env.CODEX_THREAD_ID } = {}) {
  const c = validateReceiverConfig(config);
  if (c.mode !== 'daily') fail('CLIENT_REPLY_DAILY_REQUIRED');
  if (threadId !== c.thread_id || !UUID_RE.test(threadId ?? '')) fail('OWNER_THREAD_MISMATCH');
  if (!isValidMessageId(requestId) || !UUID_RE.test(turnId ?? '')) fail('CLIENT_REPLY_ARGUMENTS_INVALID');
  const ledger = evidenceJson(c.runtime_dir, 'ledger.json');
  if (ledger?.v !== 1 || !ledger.entries || Array.isArray(ledger.entries)) fail('CLIENT_REPLY_EVIDENCE_UNAVAILABLE');
  const matches = Object.values(ledger.entries).filter((entry) => entry.client_request_id === requestId);
  if (matches.length !== 1) fail(matches.length ? 'CLIENT_REPLY_REQUEST_AMBIGUOUS' : 'CLIENT_REPLY_REQUEST_NOT_FOUND');
  const entry = matches[0];
  if (entry.status !== 'NATIVE_QUEUED' || !isValidMessageId(entry.native_queue_id) ||
      entry.window_id !== c.window_id || !isValidMessageId(entry.msg_id)) fail('CLIENT_REPLY_NATIVE_RECEIPT_REQUIRED');
  const message = evidenceJson(c.runtime_dir, messageKey(entry.msg_id) + '.message.json');
  let context;
  try { context = clientRequestContext(message); } catch { fail('CLIENT_REPLY_REQUEST_MISMATCH'); }
  if (message.msg_id !== entry.msg_id || message.to !== 'codex:' + c.thread_id ||
      context.client_request_id !== requestId || context.client_identity !== entry.client_identity ||
      context.reply_to !== entry.reply_to || messageFingerprint(message) !== entry.fingerprint) fail('CLIENT_REPLY_REQUEST_MISMATCH');
  const replyRoot = path.join(c.runtime_dir, 'replies');
  const absolute = typeof bodyFile === 'string' && bodyFile.length ? path.resolve(bodyFile) : '';
  if (!absolute || !inside(replyRoot, absolute)) fail('CLIENT_REPLY_FILE_OUTSIDE_TARGET');
  let bytes;
  try {
    if (!fs.lstatSync(replyRoot).isDirectory() || !fs.lstatSync(absolute).isFile() ||
        !inside(fs.realpathSync(replyRoot), fs.realpathSync(absolute)) ||
        !inside(fs.realpathSync(c.runtime_dir), fs.realpathSync(absolute))) fail('CLIENT_REPLY_FILE_OUTSIDE_TARGET');
    if (fs.statSync(absolute).size > c.max_text_bytes) fail('CLIENT_REPLY_TOO_LARGE');
    bytes = fs.readFileSync(absolute);
  } catch (error) {
    if (error.code?.startsWith('CLIENT_REPLY_')) throw error;
    fail('CLIENT_REPLY_FILE_UNAVAILABLE');
  }
  if (bytes.length > c.max_text_bytes) fail('CLIENT_REPLY_TOO_LARGE');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('CLIENT_REPLY_UTF8_REQUIRED'); }
  if (text.includes('\u0000')) fail('CLIENT_REPLY_UTF8_REQUIRED');
  if (!text.trim()) fail('CLIENT_REPLY_EMPTY');
  return { client_request_id: requestId, msg_id: entry.msg_id, target: 'codex:' + c.thread_id,
    reply_to: context.reply_to, text, text_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    native_queue_id: entry.native_queue_id, receiving_turn_id: turnId,
    evidence_grade: 'MODEL_REPORTED_OWNER_CONTEXT_CORROBORATED; not independent host or cloud authentication' };
}

export async function postClientReply(client, payload) {
  if (client.welcomeInfo?.capabilities?.client_requests_v1 !== true) fail('CLIENT_REQUEST_PROTOCOL_REQUIRED');
  const response = await client.request({ type: 'client-reply', client_identity: payload.reply_to,
    client_request_id: payload.client_request_id, target_identity: payload.target,
    request_msg_id: payload.msg_id, turn_id: payload.receiving_turn_id,
    body: payload.text, body_sha256: payload.text_sha256 });
  if (response?.type !== 'client-reply-result' || response.ok !== true) {
    const code = typeof response?.code === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(response.code) ? response.code : 'CLIENT_REPLY_NOT_CONFIRMED';
    fail(code);
  }
  if (response.request?.request_id !== payload.client_request_id ||
      response.request?.target_identity !== payload.target || response.request?.client_identity !== payload.reply_to ||
      response.request?.request_msg_id !== payload.msg_id ||
      !isValidMessageId(response.reply?.reply_msg_id) || response.reply.body_sha256 !== payload.text_sha256 ||
      response.reply.bytes !== Buffer.byteLength(payload.text, 'utf8') || !UUID_RE.test(response.reply.turn_id ?? '') ||
      response.idempotent !== true && response.reply.turn_id !== payload.receiving_turn_id) fail('CLIENT_REPLY_RECEIPT_MISMATCH');
  return { action: 'CLIENT_REPLY_RECORDED', status: 'CLIENT_REPLY_RECORDED', client_request_id: payload.client_request_id, msg_id: payload.msg_id,
    target: payload.target, reply_to: payload.reply_to, receiving_turn_id: response.reply.turn_id, invoking_turn_id: payload.receiving_turn_id,
    native_queue_id: payload.native_queue_id, reply_msg_id: response.reply.reply_msg_id,
    body_sha256: payload.text_sha256, body_bytes: response.reply.bytes, idempotent: response.idempotent === true,
    evidence_grade: payload.evidence_grade };
}
