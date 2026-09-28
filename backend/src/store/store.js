// Persistent event store on the built-in SQLite. Rooms are loaded into memory
// at startup from recorded outcomes, without re-validating. Retention
// (SPEC §10): content expires after the retention window, and a room with no
// accepted event for the room expiry window is deleted, leaving a tombstone.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { AGENT_KINDS, checkWellFormed, roomIdOf } from '../proto/event.js';
import { applyAgentEvent, betterHead, handleOf, handleSuffix } from '../agent/agent.js';
import { b64u, fromB64u } from '../proto/encoding.js';
import { keypairFromSeed } from '../proto/keys.js';
import { Room } from '../room/room.js';

const DAY = 24 * 60 * 60 * 1000;
export const RETENTION = {
  contentMs: 90 * DAY, // content older than this (by receipt) is dropped
  roomMs: 90 * DAY, // a room with no accepted event for this long is deleted
  tombstoneMs: 30 * DAY, // how long a deleted room's ID is remembered
  reportMs: 30 * DAY, // how long a received report (with any opened body) is kept for review
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  room        TEXT NOT NULL,
  event       TEXT NOT NULL,  -- JSON {header, id, sig}, without content
  content     TEXT,           -- null when absent or withheld
  withheld    TEXT,           -- author | moderator | operator | expired
  outcome     TEXT NOT NULL,  -- accepted | rejected
  reason      TEXT,
  target      TEXT,           -- msg.delete target, so an early deletion is found when its target arrives
  soft_failed INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_room ON events (room, seq);
CREATE INDEX IF NOT EXISTS events_target ON events (target) WHERE target IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_content_age ON events (received_at) WHERE content IS NOT NULL;
CREATE TABLE IF NOT EXISTS rooms (
  room          TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  dm_with       TEXT,
  last_event_at INTEGER NOT NULL  -- receipt time of the latest accepted event
);
CREATE INDEX IF NOT EXISTS rooms_dm_with ON rooms (dm_with);
CREATE INDEX IF NOT EXISTS rooms_last_event ON rooms (last_event_at);
CREATE TABLE IF NOT EXISTS agent_events (
  id          TEXT PRIMARY KEY,
  agent       TEXT NOT NULL,
  event       TEXT NOT NULL,     -- JSON {header, id, sig}
  depth       INTEGER NOT NULL,
  rotations   INTEGER NOT NULL,
  state       TEXT NOT NULL,     -- JSON agent state after this event
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_events_agent ON agent_events (agent);
CREATE TABLE IF NOT EXISTS agents (  -- each agent's best head (§5.4), denormalized for lookup
  agent        TEXT PRIMARY KEY,
  head         TEXT NOT NULL,
  depth        INTEGER NOT NULL,
  rotations    INTEGER NOT NULL,
  suffix       TEXT NOT NULL,
  name         TEXT NOT NULL,
  search       TEXT NOT NULL,     -- lowercased name, description, capabilities
  state        TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_name ON agents (name, agent);
CREATE INDEX IF NOT EXISTS agents_suffix ON agents (suffix);
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,  -- p_ + hash of the report
  report      TEXT NOT NULL,     -- JSON, as verified (§9.2)
  reporter    TEXT,              -- set only when an agent reported to this node; never forwarded
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tombstones (
  room       TEXT PRIMARY KEY,
  expired_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  room       TEXT NOT NULL,
  agent      TEXT NOT NULL,
  membership TEXT NOT NULL,
  event      TEXT NOT NULL,
  PRIMARY KEY (room, agent)
);
CREATE INDEX IF NOT EXISTS memberships_agent ON memberships (agent, membership);
`;

export class Store {
  #db;
  #rooms = new Map();
  #q;
  #listeners = new Set();
  // The chain resolver rooms consult (§5.4, §6.5).
  #agentView = {
    keyAt: (id) => {
      const row = this.#q.agentEvent.get(id);
      return row ? { agent: row.agent, key: JSON.parse(row.state).key } : null;
    },
    descends: (id, ancestor) => {
      for (let cur = id; cur;) {
        if (cur === ancestor) return true;
        const row = this.#q.agentEvent.get(cur);
        if (!row) return false;
        cur = JSON.parse(row.event).header.parents[0];
      }
      return false;
    },
    currentKey: (agent) => this.agent(agent)?.state.key ?? null,
  };
  node;
  retention;

  constructor(path = ':memory:', retention = {}) {
    this.retention = { ...RETENTION, ...retention };
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);
    const db = this.#db;
    this.#q = {
      meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)'),
      insert: db.prepare(`INSERT INTO events (id, room, event, content, outcome, reason, target, soft_failed, received_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertRoom: db.prepare('INSERT INTO rooms (room, type, dm_with, last_event_at) VALUES (?, ?, ?, ?)'),
      touchRoom: db.prepare('UPDATE rooms SET last_event_at = max(last_event_at, ?) WHERE room = ?'),
      tombstone: db.prepare('SELECT expired_at FROM tombstones WHERE room = ?'),
      staleRooms: db.prepare('SELECT room FROM rooms WHERE last_event_at < ?'),
      dropEvents: db.prepare('DELETE FROM events WHERE room = ?'),
      dropMembers: db.prepare('DELETE FROM memberships WHERE room = ?'),
      dropRoom: db.prepare('DELETE FROM rooms WHERE room = ?'),
      bury: db.prepare('INSERT OR REPLACE INTO tombstones (room, expired_at) VALUES (?, ?)'),
      forget: db.prepare('DELETE FROM tombstones WHERE expired_at < ?'),
      agentEvent: db.prepare('SELECT agent, event, depth, rotations, state FROM agent_events WHERE id = ?'),
      insertAgentEvent: db.prepare(`INSERT INTO agent_events (id, agent, event, depth, rotations, state, received_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?)`),
      agent: db.prepare('SELECT * FROM agents WHERE agent = ?'),
      upsertAgent: db.prepare(`INSERT INTO agents (agent, head, depth, rotations, suffix, name, search, state, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT (agent) DO UPDATE SET head = excluded.head, depth = excluded.depth,
                                 rotations = excluded.rotations, name = excluded.name, search = excluded.search,
                                 state = excluded.state, updated_at = excluded.updated_at`),
      agentsBySuffix: db.prepare('SELECT * FROM agents WHERE suffix = ? AND name = ? ORDER BY agent'),
      agentsByName: db.prepare('SELECT * FROM agents WHERE name = ? AND agent > ? ORDER BY agent LIMIT ?'),
      agentsSearch: db.prepare(`SELECT * FROM agents WHERE search LIKE ? ESCAPE '\\' AND agent > ? ORDER BY agent LIMIT ?`),
      shareRoom: db.prepare(`SELECT 1 FROM memberships a JOIN memberships b ON a.room = b.room
                             WHERE a.agent = ? AND b.agent = ? AND a.membership = 'join' AND b.membership = 'join' LIMIT 1`),
      fillContent: db.prepare(`UPDATE events SET content = ? WHERE id = ? AND content IS NULL AND withheld IS NULL
                               AND outcome = 'accepted' AND soft_failed = 0`),
      peerContent: db.prepare('SELECT content FROM events WHERE id = ?'),
      listRooms: db.prepare('SELECT room, last_event_at FROM rooms WHERE room > ? ORDER BY room LIMIT ?'),
      listAgents: db.prepare('SELECT agent, head FROM agents WHERE agent > ? ORDER BY agent LIMIT ?'),
      agentEventJson: db.prepare('SELECT event FROM agent_events WHERE id = ?'),
      report: db.prepare('SELECT id FROM reports WHERE id = ?'),
      insertReport: db.prepare('INSERT INTO reports (id, report, reporter, received_at) VALUES (?, ?, ?, ?)'),
      reportJson: db.prepare('SELECT report FROM reports WHERE id = ?'),
      listReports: db.prepare('SELECT id, report FROM reports WHERE id > ? ORDER BY id LIMIT ?'),
      dropReports: db.prepare('DELETE FROM reports WHERE received_at < ?'),
      expireContent: db.prepare(`UPDATE events SET content = NULL, withheld = 'expired'
                                 WHERE content IS NOT NULL AND received_at < ?`),
      upsertMember: db.prepare(`INSERT INTO memberships (room, agent, membership, event) VALUES (?, ?, ?, ?)
                                ON CONFLICT (room, agent) DO UPDATE SET membership = excluded.membership, event = excluded.event`),
      withhold: db.prepare('UPDATE events SET content = NULL, withheld = ? WHERE id = ? AND withheld IS NULL'),
      content: db.prepare('SELECT content, withheld FROM events WHERE id = ?'),
      deletesOf: db.prepare(`SELECT event FROM events WHERE target = ? AND room = ? AND outcome = 'accepted'`),
      all: db.prepare('SELECT event, outcome, reason, soft_failed FROM events ORDER BY seq'),
      roomsOf: db.prepare('SELECT room, membership, event FROM memberships WHERE agent = ?'),
      membership: db.prepare('SELECT membership, event FROM memberships WHERE room = ? AND agent = ?'),
      dmInvites: db.prepare(`SELECT r.room FROM rooms r
                             WHERE r.dm_with = ? AND NOT EXISTS
                               (SELECT 1 FROM memberships m WHERE m.room = r.room AND m.agent = r.dm_with)`),
    };
    this.node = this.#nodeIdentity();
    this.#load();
  }

  #nodeIdentity() {
    let seed = this.#q.meta.get('node_key_seed')?.value;
    if (!seed) {
      seed = b64u(randomBytes(32));
      this.#q.setMeta.run('node_key_seed', seed);
    }
    const { privateKey, publicKey } = keypairFromSeed(fromB64u(seed));
    return { id: 'n_' + b64u(publicKey), privateKey, publicKey };
  }

  #load() {
    for (const row of this.#q.all.iterate()) {
      const ev = JSON.parse(row.event);
      const result = row.outcome === 'accepted'
        ? { outcome: 'accepted', soft_failed: row.soft_failed === 1 }
        : { outcome: 'rejected', reason: row.reason };
      const roomId = ev.header.kind === 'room.create' ? roomIdOf(ev.id) : ev.header.room;
      let room = this.#rooms.get(roomId);
      if (!room) this.#rooms.set(roomId, (room = new Room(this.#agentView)));
      room.restore(ev, result);
    }
  }

  room(id) {
    return this.#rooms.get(id);
  }

  // Called after an event is newly stored: fn({ id, room, agent, origin }).
  // `room` is set for room events, `agent` for agent events; `origin` is the
  // peer it came from, if any. Replication listens here.
  onStored(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(info) {
    for (const fn of this.#listeners) fn(info);
  }

  // True if the room was deleted for inactivity and is still remembered.
  expired(roomId) {
    return this.#q.tombstone.get(roomId) !== undefined;
  }

  // The retention sweep (SPEC §10). Run it periodically; returns what it did.
  sweep(now = Date.now()) {
    const { contentMs, roomMs, tombstoneMs, reportMs } = this.retention;
    this.#db.exec('BEGIN');
    try {
      const content = Number(this.#q.expireContent.run(now - contentMs).changes);
      const rooms = this.#q.staleRooms.all(now - roomMs).map((r) => r.room);
      for (const room of rooms) {
        this.#q.dropEvents.run(room);
        this.#q.dropMembers.run(room);
        this.#q.dropRoom.run(room);
        this.#q.bury.run(room, now);
      }
      const forgotten = Number(this.#q.forget.run(now - tombstoneMs).changes);
      const reports = Number(this.#q.dropReports.run(now - reportMs).changes);
      this.#db.exec('COMMIT');
      for (const room of rooms) this.#rooms.delete(room);
      return { content, rooms: rooms.length, forgotten, reports };
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    this.#db.close();
  }

  // Process one event from a client or peer. Idempotent. `origin` is the peer
  // node it came from, if any.
  ingest(ev, now = Date.now(), origin = null) {
    const malformed = checkWellFormed(ev);
    if (malformed) return { outcome: 'discarded', reason: malformed };
    if (AGENT_KINDS.has(ev.header.kind)) return this.#ingestAgent(ev, now, origin);
    const isCreate = ev.header.kind === 'room.create';
    const roomId = isCreate ? roomIdOf(ev.id) : ev.header.room;
    if (this.expired(roomId)) return { outcome: 'discarded', reason: 'room_expired' };
    let room = this.#rooms.get(roomId);
    if (!room) {
      if (!isCreate) return { outcome: 'pending', missing: [], reason: 'unknown_room' };
      room = new Room(this.#agentView);
    }
    const known = room.outcome(ev.id);
    if (known) {
      // A copy that still has its content fills a gap left by one that came without.
      if (ev.content !== undefined) this.#q.fillContent.run(ev.content, ev.id);
      return known;
    }

    const result = room.add(ev, { wellFormed: true });
    if (result.outcome !== 'accepted' && result.outcome !== 'rejected') return result;
    if (isCreate) this.#rooms.set(roomId, room);

    this.#db.exec('BEGIN');
    try {
      const accepted = result.outcome === 'accepted';
      this.#q.insert.run(ev.id, roomId, JSON.stringify({ header: ev.header, id: ev.id, sig: ev.sig }),
        accepted ? ev.content ?? null : null, result.outcome, result.reason ?? null,
        ev.header.kind === 'msg.delete' ? ev.header.data.target : null, result.soft_failed ? 1 : 0, now);
      if (isCreate) this.#q.insertRoom.run(roomId, ev.header.data.type, ev.header.data.dm_with ?? null, now);
      if (accepted) {
        this.#q.touchRoom.run(now, roomId);
        this.#afterAccept(room, ev);
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    this.#emit({ id: ev.id, room: roomId, origin });
    return result;
  }

  // Agent events (§5.4): valid given their parent alone, so they are accepted,
  // discarded, or pending on the parent. Nothing invalid is stored.
  #ingestAgent(ev, now, origin) {
    if (this.#q.agentEvent.get(ev.id)) return { outcome: 'accepted' };
    const parentId = ev.header.parents[0];
    let parent = null;
    if (parentId !== undefined) {
      const row = this.#q.agentEvent.get(parentId);
      if (!row) return { outcome: 'pending', missing: [parentId] };
      parent = { agent: row.agent, depth: row.depth, rotations: row.rotations, state: JSON.parse(row.state) };
    }
    const rec = applyAgentEvent(parent, ev);
    if (rec.reason) return { outcome: 'discarded', reason: rec.reason };

    const agent = ev.header.author;
    const state = JSON.stringify(rec.state);
    this.#db.exec('BEGIN');
    try {
      this.#q.insertAgentEvent.run(ev.id, agent, JSON.stringify({ header: ev.header, id: ev.id, sig: ev.sig }),
        rec.depth, rec.rotations, state, now);
      const current = this.#q.agent.get(agent);
      if (betterHead({ ...rec, id: ev.id }, current && { depth: current.depth, rotations: current.rotations, id: current.head })) {
        const st = rec.state;
        const search = [st.name, st.description, ...st.capabilities].join('\n').toLowerCase();
        this.#q.upsertAgent.run(agent, ev.id, rec.depth, rec.rotations, handleSuffix(agent), st.name, search, state, now);
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    this.#emit({ id: ev.id, agent, origin });
    return { outcome: 'accepted' };
  }

  // The agent's current record: its best head and the state there, or null if unregistered here.
  agent(agentId) {
    const row = this.#q.agent.get(agentId);
    return row ? this.#agentRecord(row) : null;
  }

  #agentRecord(row) {
    return { agent: row.agent, head: row.head, state: JSON.parse(row.state), handle: handleOf(row.agent, row.name) };
  }

  // The events from agent.register to the agent's head.
  agentChain(agentId, limit = 1000) {
    const chain = [];
    for (let id = this.#q.agent.get(agentId)?.head; id && chain.length < limit;) {
      const ev = JSON.parse(this.#q.agentEvent.get(id).event);
      chain.push(ev);
      id = ev.header.parents[0];
    }
    return chain.reverse();
  }

  agentsByHandle(name, suffix) {
    return this.#q.agentsBySuffix.all(suffix, name).map((r) => this.#agentRecord(r));
  }

  agentsByName(name, after, limit) {
    return this.#q.agentsByName.all(name, after, limit).map((r) => this.#agentRecord(r));
  }

  searchAgents(text, after, limit) {
    const pattern = '%' + text.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    return this.#q.agentsSearch.all(pattern, after, limit).map((r) => this.#agentRecord(r));
  }

  // The key a request from this agent must be signed with (§7.1): the key at
  // its head, or its identity key if this node has no agent.register for it.
  requestKey(agentId) {
    return this.agent(agentId)?.state.key ?? agentId.slice(2);
  }

  // Delivery filters for invites and new DMs (§9.4).
  deliverInvite(agentId, from) {
    const st = this.agent(agentId)?.state;
    if (!st) return true;
    if (st.blocked.includes(from) || st.invites === 'closed') return false;
    if (st.invites === 'shared_rooms') return this.#q.shareRoom.get(agentId, from) !== undefined;
    return true;
  }

  #afterAccept(room, ev) {
    for (const [k, state] of room.currentState()) {
      if (!k.startsWith('room.member|')) continue;
      this.#q.upsertMember.run(room.id, state.header.data.target, state.header.data.membership, state.id);
    }
    const h = ev.header;
    if (h.kind === 'msg.delete') {
      const effect = room.deletionEffect(ev);
      if (effect) this.#q.withhold.run(effect, h.data.target);
    } else if (h.kind === 'msg.post' || h.kind === 'room.keys') {
      // A deletion may have arrived before its target.
      for (const row of this.#q.deletesOf.iterate(ev.id, room.id)) {
        const effect = room.deletionEffect(JSON.parse(row.event));
        if (effect) {
          this.#q.withhold.run(effect, ev.id);
          break;
        }
      }
    }
  }

  // The event as served to clients: header and signature, content unless
  // withheld, and the node's outcome when it is not a plain accept.
  serve(room, id) {
    const ev = room.event(id);
    const out = { header: ev.header, id, sig: ev.sig };
    const result = room.outcome(id);
    if (result.outcome === 'rejected') return { ...out, status: 'rejected', reason: result.reason };
    if (result.soft_failed) return { ...out, status: 'soft_failed' };
    const row = this.#q.content.get(id);
    if (row.withheld) out.withheld = row.withheld;
    else if (row.content !== null) out.content = row.content;
    return out;
  }

  // Replication (§11) --------------------------------------------------------

  // A room event as sent to peers: header and signature, plus content if this
  // node holds it (not withheld, not expired). Peers validate it themselves.
  forPeer(roomId, id) {
    const ev = this.#rooms.get(roomId)?.event(id);
    if (!ev) return null;
    const out = { header: ev.header, id, sig: ev.sig };
    const content = this.#q.peerContent.get(id)?.content;
    if (content != null) out.content = content;
    return out;
  }

  agentEvent(id) {
    const row = this.#q.agentEventJson.get(id);
    return row ? JSON.parse(row.event) : null;
  }

  // Rooms in ID order after `cursor`, with heads and last activity.
  listRooms(cursor, limit) {
    return this.#q.listRooms.all(cursor, limit).map((r) => ({
      room: r.room, heads: this.#rooms.get(r.room).heads(), active_at: r.last_event_at,
    }));
  }

  listAgents(cursor, limit) {
    return this.#q.listAgents.all(cursor, limit);
  }

  // Stores a verified report once; `reporter` only for reports made to this node.
  addReport(id, report, reporter = null, now = Date.now(), origin = null) {
    if (this.#q.report.get(id)) return false;
    this.#q.insertReport.run(id, JSON.stringify(report), reporter, now);
    this.#emit({ report: id, origin });
    return true;
  }

  report(id) {
    const row = this.#q.reportJson.get(id);
    return row ? JSON.parse(row.report) : null;
  }

  // Reports in ID order after `cursor`, without reporters, for anti-entropy.
  listReports(cursor, limit) {
    return this.#q.listReports.all(cursor, limit).map((r) => ({ id: r.id, report: JSON.parse(r.report) }));
  }

  roomsOf(agent) {
    return this.#q.roomsOf.all(agent);
  }

  membership(roomId, agent) {
    return this.#q.membership.get(roomId, agent) ?? null;
  }

  dmInvites(agent) {
    return this.#q.dmInvites.all(agent).map((r) => r.room);
  }
}
