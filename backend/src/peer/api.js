// Peer API (SPEC §11.2), served on the node's peer port. The supplier's
// public hostname routes /meadow-peer/* there (prefix stripped); relays
// cannot reach it. Every request except hello is signed by a peer's node key.

import { AGENT_KINDS, PROTOCOL, ROOM_VERSION } from '../proto/event.js';
import { verifyReport } from '../proto/report.js';
import { RequestError } from '../api/sync.js';

export const PEER_LIMITS = {
  push: 500,
  page: 200,
  content: 200, // event IDs per /v2/content request
  sinceBytes: 2 * 1024 * 1024,
  chainWalk: 100_000, // a whole chain, paged by sinceBytes
  // A push may start at most one new room and one new agent, so even a
  // staked peer cannot mint them in bulk (§11.4).
  newRoomsPerPush: 1,
  newAgentsPerPush: 1,
};

// Discards that say nothing bad about the sender: it may simply be newer, or
// have kept a room longer.
const HARMLESS = new Set(['room_expired', 'unsupported_version', 'unsupported_room_version']);

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const isAgentEvent = (ev) => isObject(ev?.header) && AGENT_KINDS.has(ev.header.kind);

function page(body) {
  const cursor = body.cursor ?? '';
  const limit = body.limit ?? PEER_LIMITS.page;
  if (typeof cursor !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > PEER_LIMITS.page) {
    throw new RequestError('bad_request', `cursor is a string, limit 1..${PEER_LIMITS.page}`);
  }
  return { cursor, limit };
}

// Is this event the start of a room or an agent this node has not stored?
export function newRoot(store, ev) {
  if (!isObject(ev?.header) || typeof ev.id !== 'string') return null;
  if (ev.header.kind === 'room.create') return store.room('r_' + ev.id.slice(2))?.has(ev.id) ? null : 'room';
  if (ev.header.kind === 'agent.register') return store.agent(ev.header.author) || store.agentEvent(ev.id) ? null : 'agent';
  return null;
}

// Process events from a peer exactly as if a client had sent them (§11.4).
// `origin` is the sending peer's ID (pushes) or 'pull'; `limits` caps new
// rooms and agents (pushes); `onInvalid` scores the sender.
export function ingestFromPeer(store, events, { limits = null, origin = 'pull', onInvalid = () => {} } = {}) {
  const out = { accepted: 0, rejected: 0, discarded: 0, limited: [], pending: [] };
  const roots = { room: 0, agent: 0 };
  for (const ev of events) {
    const root = limits && newRoot(store, ev);
    if (root && roots[root] >= limits[root]) {
      out.limited.push(ev.id);
      continue;
    }
    const r = store.ingest(ev, Date.now(), origin);
    if (r.outcome === 'accepted') {
      out.accepted++;
      if (root) roots[root]++;
    } else if (r.outcome === 'rejected') out.rejected++;
    else if (r.outcome === 'pending') out.pending.push(ev);
    else {
      out.discarded++;
      if (!HARMLESS.has(r.reason)) onInvalid();
    }
  }
  return out;
}

export function peerRoutes(store, peers, replicator) {
  return {
    // Unauthenticated: who answers at this host. Discovery calls it at each
    // staked supplier's hostname; TLS vouches that the key belongs there.
    '/v2/hello': { auth: false, handle: () => ({ node: store.node.id, protocol: PROTOCOL, room_versions: [ROOM_VERSION] }) },

    // New events and reports. Events waiting on history this node lacks are
    // pulled from the sender, and held for retry if that fails.
    '/v2/push': { auth: true, handle: (body, peerId) => {
      const events = body.events ?? [];
      const reports = body.reports ?? [];
      if (!Array.isArray(events) || !Array.isArray(reports) || events.length + reports.length > PEER_LIMITS.push) {
        throw new RequestError('bad_request', `events and reports: arrays of at most ${PEER_LIMITS.push} items in total`);
      }
      const res = ingestFromPeer(store, events, {
        limits: { room: PEER_LIMITS.newRoomsPerPush, agent: PEER_LIMITS.newAgentsPerPush },
        origin: peerId,
        onInvalid: () => peers.penalize(peerId),
      });
      if (res.pending.length) replicator?.resolvePending(peerId, res.pending);
      let reportsNew = 0;
      for (const report of reports) {
        const v = verifyReport(report);
        if (!v.id) peers.penalize(peerId);
        else if (store.addReport(v.id, report, null, Date.now(), peerId)) reportsNew++;
      }
      return {
        accepted: res.accepted, rejected: res.rejected, discarded: res.discarded,
        pending: res.pending.map((e) => e.id), create_limit: res.limited, reports: reportsNew,
      };
    } },

    '/v2/rooms': { auth: true, handle: (body) => {
      const { cursor, limit } = page(body);
      const rooms = store.listRooms(cursor, limit);
      return { rooms, ...(rooms.length === limit && { cursor: rooms.at(-1).room }) };
    } },

    '/v2/since': { auth: true, handle: (body) => {
      const heads = body.heads ?? [];
      if (typeof body.room !== 'string' || !Array.isArray(heads) || heads.length > 20 || !heads.every((h) => typeof h === 'string')) {
        throw new RequestError('bad_request', 'room is a room ID, heads at most 20 event IDs');
      }
      const room = store.room(body.room);
      if (!room) return { unknown: true, more: false, events: [] };
      let budget = PEER_LIMITS.sinceBytes;
      const events = [];
      let more = false;
      for (const id of room.eventsSince(heads).ids) {
        const ev = store.forPeer(body.room, id);
        const size = Buffer.byteLength(JSON.stringify(ev), 'utf8');
        if (size > budget && events.length) {
          more = true;
          break;
        }
        events.push(ev);
        budget -= size;
      }
      return { more, events };
    } },

    // Content for events the caller holds without it (content repair, §11.3).
    // Only content this node holds: never withheld or expired content.
    '/v2/content': { auth: true, handle: (body) => {
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > PEER_LIMITS.content || !ids.every((id) => typeof id === 'string')) {
        throw new RequestError('bad_request', `ids: 1 to ${PEER_LIMITS.content} event IDs`);
      }
      let budget = PEER_LIMITS.sinceBytes;
      const content = {};
      const more = [];
      for (const id of ids) {
        if (more.length) {
          more.push(id);
          continue;
        }
        const c = store.peerContent(id);
        if (c === null) continue;
        const size = Buffer.byteLength(c, 'utf8') + id.length + 8;
        if (size > budget && Object.keys(content).length) {
          more.push(id);
          continue;
        }
        content[id] = c;
        budget -= size;
      }
      return { more, content };
    } },

    '/v2/agents': { auth: true, handle: (body) => {
      const { cursor, limit } = page(body);
      const agents = store.listAgents(cursor, limit);
      return { agents, ...(agents.length === limit && { cursor: agents.at(-1).agent }) };
    } },

    // Paged at 2 MiB like /v2/since, so no honest answer outgrows a reader's limit (§11.2).
    '/v2/chain': { auth: true, handle: (body) => {
      if (typeof body.agent !== 'string') throw new RequestError('bad_request', 'agent is an agent ID');
      if (body.after !== undefined && typeof body.after !== 'string') throw new RequestError('bad_request', 'after is an event ID');
      const chain = store.agentChain(body.agent, PEER_LIMITS.chainWalk);
      const start = body.after === undefined ? 0 : chain.findIndex((ev) => ev.id === body.after) + 1;
      if (start === 0 && body.after !== undefined) return { events: [], more: false };
      const events = [];
      let size = 0;
      for (const ev of chain.slice(start)) {
        const n = Buffer.byteLength(JSON.stringify(ev), 'utf8') + 1;
        if (events.length && size + n > PEER_LIMITS.sinceBytes) return { events, more: true };
        events.push(ev);
        size += n;
      }
      return { events, more: false };
    } },

    '/v2/reports': { auth: true, handle: (body) => {
      const { cursor, limit } = page(body);
      const reports = store.listReports(cursor, limit);
      return { reports, ...(reports.length === limit && { cursor: reports.at(-1).id }) };
    } },
  };
}
