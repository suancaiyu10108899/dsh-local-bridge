// Exact client admission is an additional owner choice; it never changes the
// existing DSH sender identity or grants a client an operator/adapter role.
import { isValidMessageId } from '../../src/protocol.mjs';

export const DOT_CLIENT_RE = /^client:dot-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DSH_SENDER_RE = /^dsh:session-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function receiverSenderPolicy(config) {
  const daily = config.v === 2 && config.mode === 'daily';
  const senders = config.allowed_senders;
  const clients = config.allowed_clients ?? [];
  const limit = daily ? 8 : 1;
  if (!Array.isArray(senders) || !Array.isArray(clients) ||
      senders.some((id) => typeof id !== 'string' || !DSH_SENDER_RE.test(id)) ||
      clients.some((id) => typeof id !== 'string' || !DOT_CLIENT_RE.test(id)) ||
      (!daily && clients.length !== 0) || new Set(clients).size !== clients.length ||
      senders.length + clients.length < 1 || senders.length + clients.length > limit) {
    throw new Error('receiver-identity-invalid');
  }
  return { senders, clients };
}

export function clientRequestContext(message) {
  const requestId = message.meta?.client_request_id;
  if (message.from_role !== 'client' || !DOT_CLIENT_RE.test(message.from ?? '') || !isValidMessageId(requestId)) {
    throw new Error('client-request-envelope-invalid');
  }
  // A client cannot redirect its reply to a third party using message metadata.
  return { client_request_id: requestId, client_identity: message.from, reply_to: message.from };
}
