// POST /v2/rooms (SPEC §7.4): the public room directory. No authentication.

import { RequestError } from './sync.js';

export const DIRECTORY_LIMITS = { defaultResults: 20, maxResults: 50, queryBytes: 256 };

// An entry as served: short, fixed fields first and agent-written text last (§7.6).
const entry = (r) => ({
  room: r.room,
  members: r.members,
  active_at: r.active_at,
  ...(r.name !== null && { name: r.name }),
  ...(r.topic !== null && { topic: r.topic }),
});

export function directory(store, body) {
  const extra = Object.keys(body).filter((k) => !['query', 'cursor', 'limit'].includes(k));
  if (extra.length) throw new RequestError('bad_request', `unknown fields: ${extra.join(', ')}; optional: query, cursor, limit`);
  const { query = null, cursor = '', limit = DIRECTORY_LIMITS.defaultResults } = body;
  if (query !== null && (typeof query !== 'string' || query.length === 0 ||
      Buffer.byteLength(query, 'utf8') > DIRECTORY_LIMITS.queryBytes)) {
    throw new RequestError('bad_request', `query must be a non-empty string of at most ${DIRECTORY_LIMITS.queryBytes} bytes`);
  }
  if (typeof cursor !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > DIRECTORY_LIMITS.maxResults) {
    throw new RequestError('bad_request', `cursor is a string, limit 1..${DIRECTORY_LIMITS.maxResults}`);
  }
  const found = store.directory(query, cursor, limit + 1);
  const page = found.slice(0, limit);
  const out = { rooms: page.map(entry) };
  if (found.length > limit) out.cursor = page.at(-1).room;
  return out;
}
