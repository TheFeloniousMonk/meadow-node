// POST /v2/sync (SPEC §7.2): publish the outbox, then return invites and
// everything new in the agent's rooms, oldest first, within limit_bytes.
// POST /v2/sync-batch (§7.9): several agents' syncs in one call, sharing the
// call's limits.

import { AGENT_KINDS, roomIdOf } from '../proto/event.js';
import { keyFromAgentId } from '../proto/keys.js';
import { verifyRequest } from './auth.js';
import { chainFor } from './lookup.js';
import { countsAsWrite } from './limits.js';
import { ATTEST_LIMITS, attestedHeads, signAttestation } from '../proto/attest.js';

export const SYNC_LIMITS = {
  outbox: 100,
  creates: 1, // new rooms per call: room spam costs one paid relay per room
  newAgents: 1, // agents this node has no agent.register for, per /v2/sync-batch call (§7.9)
  rooms: 500,
  headsPerRoom: 20,
  defaultBytes: 1024 * 1024,
  maxBytes: 4 * 1024 * 1024 - 64 * 1024, // leave room for metadata under the 4 MiB cap
  responseBytes: 4 * 1024 * 1024, // the whole answer (§7.6)
  agents: 50, // chains asked for in one call (§7.2)
  batch: 8, // agents in one /v2/sync-batch call (§7.9)
  // A later batch entry starts only with this much of limit_bytes left: one event is at most
  // 64 KiB of header plus 64 KiB of content, so no entry after the first runs past the limit.
  batchEntryMin: 256 * 1024,
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

// `entry`: a /v2/sync-batch entry, which has no limit_bytes of its own (§7.9).
function parse(body, entry = false) {
  const outbox = body.outbox ?? [];
  const heads = body.heads ?? {};
  const limit = entry ? SYNC_LIMITS.maxBytes : body.limit_bytes ?? SYNC_LIMITS.defaultBytes;
  if (!Array.isArray(outbox) || outbox.length > SYNC_LIMITS.outbox) {
    throw new RequestError('bad_request', `outbox must be an array of at most ${SYNC_LIMITS.outbox} events`);
  }
  if (!isObject(heads) || Object.keys(heads).length > SYNC_LIMITS.rooms ||
      !Object.values(heads).every((h) => Array.isArray(h) && h.length <= SYNC_LIMITS.headsPerRoom && h.every((id) => typeof id === 'string'))) {
    throw new RequestError('bad_request', `heads must map at most ${SYNC_LIMITS.rooms} rooms to at most ${SYNC_LIMITS.headsPerRoom} event IDs`);
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RequestError('bad_request', 'limit_bytes must be a positive integer');
  const agents = body.agents;
  if (agents !== undefined && (!Array.isArray(agents) || agents.length < 1 || agents.length > SYNC_LIMITS.agents ||
      new Set(agents).size !== agents.length || !agents.every((a) => keyFromAgentId(a) !== null))) {
    throw new RequestError('bad_request', `agents must list 1 to ${SYNC_LIMITS.agents} distinct agent IDs`);
  }
  const allowed = entry ? ['auth', 'outbox', 'heads', 'agents'] : ['auth', 'outbox', 'heads', 'limit_bytes', 'agents'];
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw new RequestError('bad_request', `unknown fields: ${extra.join(', ')}`);
  return { outbox, heads, limit: Math.min(limit, SYNC_LIMITS.maxBytes), agents: agents ?? [] };
}

// `call` holds what one relay may do, shared by every entry of a batch (§7.9): new rooms, outbox
// events, and bytes. A plain sync has its own. `first`: the call's first entry, which alone may
// pass limit_bytes by one event or one chain, as a single sync does, so every call makes progress.
// `limits`: the node's write limits (§7.2), a WriteLimits, or null for none.
export function sync(store, body, agent, call = null, { limits = null, now = Date.now() } = {}) {
  const { outbox, heads, limit: asked, agents: wanted } = parse(body, !!call);
  const shared = call ?? { created: 0, outboxLeft: SYNC_LIMITS.outbox, bytesLeft: asked, used: 0, first: true };
  const limit = Math.min(asked, shared.bytesLeft);

  const accepted = [];
  const rejected = [];
  const pending = [];
  for (const ev of outbox) {
    const id = typeof ev?.id === 'string' ? ev.id : null;
    if (shared.outboxLeft <= 0) {
      pending.push({ id, missing: [], reason: 'batch_limit' });
      continue;
    }
    shared.outboxLeft--;
    if (!isObject(ev) || ev.header?.author !== agent) {
      rejected.push({ id, reason: isObject(ev) && isObject(ev.header) ? 'not_author' : 'malformed' });
      continue;
    }
    // Resending a room this node already has is a retry, not a new room.
    const newRoom = ev.header.kind === 'room.create' && !(id && store.room(roomIdOf(id))?.has(id));
    if (newRoom && shared.created >= SYNC_LIMITS.creates) {
      pending.push({ id, missing: [], reason: 'create_limit' });
      continue;
    }
    // Write limits (§7.2): only kinds that count, new to this node; spent only once stored.
    const room = typeof ev.header.room === 'string' ? ev.header.room : null;
    const limited = limits && room && countsAsWrite(ev.header) && !(id && store.room(room)?.has(id));
    if (limited) {
      const wait = limits.wait(agent, room, now);
      if (wait > 0) {
        pending.push({ id, missing: [], reason: 'rate_limit', retry_after_ms: wait });
        continue;
      }
    }
    const result = store.ingest(ev);
    if (limited && (result.outcome === 'accepted' || result.outcome === 'rejected')) limits.spend(agent, room, now);
    if (newRoom && result.outcome === 'accepted') shared.created++;
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

  const joined = memberships.filter((r) => r.membership === 'join').map((r) => r.room);
  // The node's signed heads for every room this answer covers that the caller may read (§7.10):
  // named rooms first, then joined ones. Its bytes count toward limit_bytes.
  const attestation = attest(store, agent, now, Object.keys(heads), joined);
  let budget = limit - (Buffer.byteLength(JSON.stringify(attestation), 'utf8') + 16);
  let more = false;
  let sentAny = false;
  const rooms = {};
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
      if (size > budget && (sentAny || !shared.first)) {
        more = true;
        break;
      }
      events.push(ev);
      budget -= size;
      sentAny = true;
    }
    // A later batch entry with no room left for this room's first event: `more` says to come back.
    if (!events.length && since.ids.length) continue;
    rooms[roomId] = { heads: room.heads(), missing: since.missing, events };
  }

  // Names for everyone the answer mentions (§7.2): authors of the events served, and invite senders.
  const authors = {};
  const named = new Set(invites.map((i) => i.from));
  for (const r of Object.values(rooms)) for (const ev of r.events ?? []) named.add(ev.header.author);
  for (const id of named) {
    const rec = store.agent(id);
    if (rec) authors[id] = { name: rec.state.name, head: rec.head };
  }

  // The chains asked for, after the room events and within limit_bytes; the first one the node
  // holds always comes, so every chain can arrive, while the whole answer stays under 4 MiB.
  const chains = {};
  let answered = false;
  const used = limit - budget;
  for (const id of wanted) {
    if (!store.agent(id)) continue;
    const chain = chainFor(store, id);
    if (!chain) {
      chains[id] = { chain_too_large: true };
      continue;
    }
    const size = Buffer.byteLength(JSON.stringify(chain), 'utf8') + 64;
    const fits = size <= budget || (shared.first && !answered && shared.used + used + size <= SYNC_LIMITS.responseBytes - 64 * 1024);
    if (!fits) continue;
    chains[id] = chain;
    budget -= size;
    answered = true;
  }

  // `chains`, never `agents`: a top-level key keeps one type across routes, and `agents` is lookup's
  // array. The portal validates every answer against one schema (§7.6; the 0.3.0 incident).
  return { node: store.node.id, accepted, rejected, pending, more, authors, invites, rooms, chains, attestation };
}

// §7.10: named rooms (a named room this node does not hold is []), then joined rooms, at most 500;
// unreadable and expired rooms are left out, so the attestation shows nothing the answer does not.
function attest(store, agent, now, named, joined) {
  const rooms = {};
  let count = 0;
  for (const roomId of new Set([...named, ...joined])) {
    if (count >= ATTEST_LIMITS.rooms) break;
    const room = store.room(roomId);
    if (!room) {
      if (store.expired(roomId)) continue;
      rooms[roomId] = [];
    } else {
      const readable = store.membership(roomId, agent)?.membership === 'join' || room.create.header.data.type === 'public';
      if (!readable) continue;
      rooms[roomId] = attestedHeads(room.heads());
    }
    count++;
  }
  return signAttestation(store.node, agent, now, rooms);
}

const bad = (message) => new RequestError('bad_request', message);

/**
 * POST /v2/sync-batch (§7.9). Each entry is a /v2/sync body signed by its own agent; the call's
 * limits (one new room, 100 outbox events, limit_bytes) are shared, in entry order. A malformed
 * entry fails the whole call before anything is processed; a failed signature fails its entry only.
 */
export function syncBatch(store, body, now = Date.now(), keyOf = (agent) => store.requestKey(agent), limits = null) {
  const entries = body.syncs;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > SYNC_LIMITS.batch) throw bad(`syncs must hold 1 to ${SYNC_LIMITS.batch} sync requests`);
  const extra = Object.keys(body).filter((k) => !['syncs', 'limit_bytes'].includes(k));
  if (extra.length) throw bad(`unknown fields: ${extra.join(', ')}`);
  const limit = body.limit_bytes ?? SYNC_LIMITS.defaultBytes;
  if (!Number.isSafeInteger(limit) || limit < 1) throw bad('limit_bytes must be a positive integer');
  const agents = new Set();
  for (const e of entries) {
    if (!isObject(e) || !isObject(e.auth) || typeof e.auth.agent !== 'string') throw bad('each entry must be a sync request with an auth block');
    if (agents.has(e.auth.agent)) throw bad('two entries for one agent');
    agents.add(e.auth.agent);
    parse(e, true);
  }
  if (entries.reduce((n, e) => n + (e.agents?.length ?? 0), 0) > SYNC_LIMITS.agents) throw bad(`at most ${SYNC_LIMITS.agents} agents across the call`);

  // At most one agent new to this node per call (§7.9): an agent never has to register, so
  // without this one relay would let eight unseen agents write. Later new entries are deferred.
  const deferredNew = new Set();
  let newAgents = 0;
  for (const e of entries) {
    if (store.agent(e.auth.agent)) continue;
    if (newAgents < SYNC_LIMITS.newAgents) newAgents++;
    else deferredNew.add(e.auth.agent);
  }

  // Each requester's own agent events first, as for /v2/sync (§7.1), before its signature is
  // checked: bounded by the call's outbox total, since nothing here is authenticated yet.
  let unauthenticated = SYNC_LIMITS.outbox;
  for (const e of entries) {
    if (deferredNew.has(e.auth.agent)) continue;
    for (const ev of e.outbox ?? []) {
      if (unauthenticated <= 0) break;
      if (ev?.header?.author === e.auth.agent && AGENT_KINDS.has(ev.header.kind)) {
        unauthenticated--;
        store.ingest(ev);
      }
    }
  }

  const call = { created: 0, outboxLeft: SYNC_LIMITS.outbox, bytesLeft: Math.min(limit, SYNC_LIMITS.maxBytes), used: 0, first: true };
  const syncs = [];
  let more = false;
  for (const e of entries) {
    const agent = e.auth.agent;
    if (deferredNew.has(agent) || (!call.first && call.bytesLeft < SYNC_LIMITS.batchEntryMin)) {
      syncs.push({ agent, deferred: true });
      more = true;
      continue;
    }
    const auth = verifyRequest(e, now, keyOf);
    if (auth.error) {
      syncs.push({ agent, failed: { code: auth.error, message: 'request authentication failed (SPEC 7.1)' } });
      continue;
    }
    const { node: _node, ...answer } = sync(store, e, auth.agent, call, { limits, now });
    const entry = { agent, ...answer };
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    call.used += size;
    call.bytesLeft = Math.max(0, call.bytesLeft - size);
    call.first = false;
    if (answer.more) more = true;
    syncs.push(entry);
  }
  return { node: store.node.id, more, syncs };
}

// What an invited agent needs to write its join without reading the room:
// the heads, and the state events its join's auth list may cite (§6.4).
function inviteEntry(store, room, agent, from) {
  const state = room.currentState();
  // room.meta too, so the invitee sees the room's name and topic before it joins (§7.2).
  const keys = ['room.create|', 'room.meta|', 'room.power|', `room.member|${agent}`, `room.rotate|${agent}`];
  let members = 0;
  for (const [k, ev] of state) if (k.startsWith('room.member|') && ev.header.data.membership === 'join') members++;
  return {
    room: room.id,
    type: room.create.header.data.type,
    from,
    members,
    heads: room.heads(),
    state: keys.filter((k) => state.has(k)).map((k) => store.serve(room, state.get(k).id)),
  };
}
