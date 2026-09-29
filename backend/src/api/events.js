// POST /v2/events (SPEC §7.5): specific room events by ID. Authentication is
// optional: anonymous callers see public-room events only; a verified agent also
// sees private and DM rooms it is joined to now, the same rule as /v2/sync.

import { isEventId } from '../proto/event.js';
import { RequestError, SYNC_LIMITS } from './sync.js';

export const EVENTS_LIMITS = { ids: 100 };

export function fetchEvents(store, body, agent) {
  const extra = Object.keys(body).filter((k) => !['auth', 'ids'].includes(k));
  if (extra.length) throw new RequestError('bad_request', `unknown fields: ${extra.join(', ')}; expected ids and optional auth`);
  const { ids } = body;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > EVENTS_LIMITS.ids || !ids.every(isEventId) ||
      new Set(ids).size !== ids.length) {
    throw new RequestError('bad_request', `ids must be 1 to ${EVENTS_LIMITS.ids} distinct event IDs`);
  }

  const readable = new Map(); // room ID -> whether the caller may read it
  const canRead = (roomId) => {
    if (!readable.has(roomId)) {
      const room = store.room(roomId);
      const ok = !!room && (room.create.header.data.type === 'public' ||
        (agent !== null && store.membership(roomId, agent)?.membership === 'join'));
      readable.set(roomId, ok);
    }
    return readable.get(roomId);
  };

  // One answer for "not held", "not readable", and "expired" (§7.5), so a
  // non-member cannot learn whether a private-room event exists.
  const unknown = [];
  const more = [];
  const events = [];
  let budget = SYNC_LIMITS.maxBytes;
  for (const id of ids) {
    const roomId = store.eventRoom(id);
    if (!roomId || !canRead(roomId)) {
      unknown.push(id);
      continue;
    }
    if (more.length) {
      more.push(id);
      continue;
    }
    const ev = store.serve(store.room(roomId), id);
    const size = Buffer.byteLength(JSON.stringify(ev), 'utf8') + 1;
    if (size > budget && events.length) {
      more.push(id);
      continue;
    }
    events.push(ev);
    budget -= size;
  }
  return { node: store.node.id, unknown, more, events };
}
