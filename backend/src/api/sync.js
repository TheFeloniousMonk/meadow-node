// POST /v2/sync (SPEC §7.2): publish the outbox, then return invites and
// everything new in the agent's rooms, oldest first, within limit_bytes.

import { roomIdOf } from '../proto/event.js';

export const SYNC_LIMITS = {
  outbox: 100,
  creates: 1, // new rooms per call: room spam costs one paid relay per room
  rooms: 500,
  headsPerRoom: 20,
  defaultBytes: 1024 * 1024,
  maxBytes: 4 * 1024 * 1024 - 64 * 1024, // leave room for metadata under the 4 MiB cap
};

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// A 4xx the client caused. `details` adds fields to the error object, such as
// retry_after_ms for rate_limited (§7.6).
export class RequestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function parse(body) {
  const outbox = body.outbox ?? [];
  const heads = body.heads ?? {};
  const limit = body.limit_bytes ?? SYNC_LIMITS.defaultBytes;
  if (!Array.isArray(outbox) || outbox.length > SYNC_LIMITS.outbox) {
    throw new RequestError('bad_request', `outbox must be an array of at most ${SYNC_LIMITS.outbox} events`);
  }
  if (!isObject(heads) || Object.keys(heads).length > SYNC_LIMITS.rooms ||
      !Object.values(heads).every((h) => Array.isArray(h) && h.length <= SYNC_LIMITS.headsPerRoom && h.every((id) => typeof id === 'string'))) {
    throw new RequestError('bad_request', `heads must map at most ${SYNC_LIMITS.rooms} rooms to at most ${SYNC_LIMITS.headsPerRoom} event IDs`);
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RequestError('bad_request', 'limit_bytes must be a positive integer');
  const extra = Object.keys(body).filter((k) => !['auth', 'outbox', 'heads', 'limit_bytes'].includes(k));
  if (extra.length) throw new RequestError('bad_request', `unknown fields: ${extra.join(', ')}`);
  return { outbox, heads, limit: Math.min(limit, SYNC_LIMITS.maxBytes) };
}

export function sync(store, body, agent) {
  const { outbox, heads, limit } = parse(body);

  const accepted = [];
  const rejected = [];
  const pending = [];
  let created = 0;
  for (const ev of outbox) {
    const id = typeof ev?.id === 'string' ? ev.id : null;
    if (!isObject(ev) || ev.header?.author !== agent) {
      rejected.push({ id, reason: isObject(ev) && isObject(ev.header) ? 'not_author' : 'malformed' });
      continue;
    }
    // Resending a room this node already has is a retry, not a new room.
    const newRoom = ev.header.kind === 'room.create' && !(id && store.room(roomIdOf(id))?.has(id));
    if (newRoom && created >= SYNC_LIMITS.creates) {
      pending.push({ id, missing: [], reason: 'create_limit' });
      continue;
    }
    const result = store.ingest(ev);
    if (newRoom && result.outcome === 'accepted') created++;
    if (result.outcome === 'accepted') accepted.push(id);
    else if (result.outcome === 'pending') pending.push({ id, missing: result.missing, ...(result.reason && { reason: result.reason }) });
    else rejected.push({ id, reason: result.reason });
  }

  const invites = [];
  const memberships = store.roomsOf(agent);
  for (const m of memberships.filter((r) => r.membership === 'invite')) {
    const from = store.room(m.room).event(m.event).header.author;
    if (store.deliverInvite(agent, from)) invites.push(inviteEntry(store, store.room(m.room), agent, from));
  }
  for (const roomId of store.dmInvites(agent)) {
    const room = store.room(roomId);
    const from = room.create.header.author;
    if (store.deliverInvite(agent, from)) invites.push(inviteEntry(store, room, agent, from));
  }

  let budget = limit;
  let more = false;
  let sentAny = false;
  const rooms = {};
  const joined = memberships.filter((r) => r.membership === 'join').map((r) => r.room);
  for (const roomId of new Set([...joined, ...Object.keys(heads)])) {
    const room = store.room(roomId);
    if (!room) {
      rooms[roomId] = store.expired(roomId) ? { expired: true } : { missing: true, heads: [], events: [] };
      continue;
    }
    const m = store.membership(roomId, agent);
    const readable = m?.membership === 'join' || room.create.header.data.type === 'public';
    if (!readable) {
      rooms[roomId] = { readable: false, membership: m ? store.serve(room, m.event) : null };
      continue;
    }
    if (more) continue;
    const since = room.eventsSince(heads[roomId] ?? []);
    if (!since.ids.length && !since.missing) continue;
    const events = [];
    for (const id of since.ids) {
      const ev = store.serve(room, id);
      const size = Buffer.byteLength(JSON.stringify(ev), 'utf8') + 1;
      if (size > budget && sentAny) {
        more = true;
        break;
      }
      events.push(ev);
      budget -= size;
      sentAny = true;
    }
    rooms[roomId] = { heads: room.heads(), missing: since.missing, events };
  }

  return { node: store.node.id, accepted, rejected, pending, more, invites, rooms };
}

// What an invited agent needs to write its join without reading the room:
// the heads, and the state events its join's auth list may cite (§6.4).
function inviteEntry(store, room, agent, from) {
  const state = room.currentState();
  const keys = ['room.create|', 'room.power|', `room.member|${agent}`, `room.rotate|${agent}`];
  return {
    room: room.id,
    type: room.create.header.data.type,
    from,
    heads: room.heads(),
    state: keys.filter((k) => state.has(k)).map((k) => store.serve(room, state.get(k).id)),
  };
}
