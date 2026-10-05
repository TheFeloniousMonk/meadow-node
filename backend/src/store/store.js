// Persistent event store on the built-in SQLite. Rooms are loaded into memory
// at startup from recorded outcomes, without re-validating. Retention
// (SPEC §10): content expires after the retention window, and a room with no
// accepted event for the room expiry window is deleted, leaving a tombstone.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { AGENT_KINDS, checkWellFormed, roomIdOf } from '../proto/event.js';
import { applyAgentEvent, betterHead, handleOf, handleSuffix } from '../agent/agent.js';
import { b64u, fromB64u, sha256 } from '../proto/encoding.js';
import { keypairFromSeed } from '../proto/keys.js';
import { Room } from '../room/room.js';

const DAY = 24 * 60 * 60 * 1000;
// Kinds that carry content (§5.1): the only ones a takedown or deletion can withhold.
export const CONTENT_KINDS = new Set(['msg.post', 'room.keys']);
export const RETENTION = {
  contentMs: 90 * DAY, // content older than this (by receipt) is dropped
  roomMs: 90 * DAY, // a room with no accepted event for this long is deleted
  tombstoneMs: 30 * DAY, // how long a deleted room's ID is remembered
  reportMs: 30 * DAY, // how long a received report (with any opened body) is kept for review
};

export const SCHEMA = `
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
  received_at INTEGER NOT NULL,
  origin      TEXT            -- 'client' (a relay), or the peer node ID it came from (§17 q13 m); null before 0.6
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
  received_at INTEGER NOT NULL,
  origin      TEXT               -- as events.origin
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
CREATE INDEX IF NOT EXISTS reports_reporter ON reports (reporter, received_at) WHERE reporter IS NOT NULL;
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
CREATE TABLE IF NOT EXISTS content_gaps (  -- accepted content events held without content that a peer may still have (§11.3)
  id          TEXT PRIMARY KEY,
  room        TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS content_gaps_room ON content_gaps (room);
CREATE TABLE IF NOT EXISTS takedowns (  -- operator takedowns (§9.5), by event ID; applied to every later copy
  event  TEXT PRIMARY KEY,
  at     INTEGER NOT NULL,
  report TEXT,
  note   TEXT
);
CREATE TABLE IF NOT EXISTS report_resolutions (  -- operator review (§9.5); dropped with the report
  id         TEXT PRIMARY KEY,
  resolution TEXT NOT NULL,  -- takedown | dismissed
  event      TEXT,
  at         INTEGER NOT NULL,
  note       TEXT
);
CREATE TABLE IF NOT EXISTS directory (  -- listed public rooms (§7.4), rebuilt from room state at startup
  room    TEXT PRIMARY KEY,
  name    TEXT,
  topic   TEXT,
  search  TEXT NOT NULL,  -- lowercased name and topic
  members INTEGER NOT NULL
);
`;

// Columns added after a database was created (CREATE TABLE IF NOT EXISTS leaves old tables as they are).
export function migrate(db) {
  for (const [table, column, type] of [['events', 'origin', 'TEXT'], ['agent_events', 'origin', 'TEXT']]) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

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
  // Events offered and newly accepted, by origin ('client' or a peer node ID), since start (§17 q13 m, §9.6).
  ingestCounts = new Map();

  constructor(path = ':memory:', retention = {}) {
    this.retention = { ...RETENTION, ...retention };
    this.#db = new DatabaseSync(path);
    // busy_timeout: the operator command (src/operator.js) writes to the same database while the node runs.
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    migrate(this.#db);
    const db = this.#db;
    this.#q = {
      meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)'),
      putMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
      counts: db.prepare(`SELECT (SELECT count(*) FROM rooms) AS rooms, (SELECT count(*) FROM agents) AS agents,
                                 (SELECT count(*) FROM events) + (SELECT count(*) FROM agent_events) AS events`),
      insert: db.prepare(`INSERT INTO events (id, room, event, content, outcome, reason, target, soft_failed, received_at, origin)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
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
      insertAgentEvent: db.prepare(`INSERT INTO agent_events (id, agent, event, depth, rotations, state, received_at, origin)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      agent: db.prepare('SELECT * FROM agents WHERE agent = ?'),
      upsertAgent: db.prepare(`INSERT INTO agents (agent, head, depth, rotations, suffix, name, search, state, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT (agent) DO UPDATE SET head = excluded.head, depth = excluded.depth,
                                 rotations = excluded.rotations, name = excluded.name, search = excluded.search,
                                 state = excluded.state, updated_at = excluded.updated_at`),
      agentsBySuffix: db.prepare('SELECT * FROM agents WHERE suffix = ? AND name = ? ORDER BY agent'),
      // Name and word searches find only agents that chose to be discoverable (§7.3); exact lookups find any.
      agentsByName: db.prepare("SELECT * FROM agents WHERE name = ? AND json_extract(state, '$.discoverable') = 1 AND agent > ? ORDER BY agent LIMIT ?"),
      agentsSearch: db.prepare(`SELECT * FROM agents WHERE search LIKE ? ESCAPE '\\' AND json_extract(state, '$.discoverable') = 1 AND agent > ? ORDER BY agent LIMIT ?`),
      shareRoom: db.prepare(`SELECT 1 FROM memberships a JOIN memberships b ON a.room = b.room
                             WHERE a.agent = ? AND b.agent = ? AND a.membership = 'join' AND b.membership = 'join' LIMIT 1`),
      // A restored operator takedown (§9.5) leaves withheld = 'operator' with no takedown record; a copy with content fills it.
      fillContent: db.prepare(`UPDATE events SET content = ?, withheld = NULL WHERE id = ? AND content IS NULL
                               AND (withheld IS NULL OR (withheld = 'operator' AND NOT EXISTS (SELECT 1 FROM takedowns t WHERE t.event = events.id)))
                               AND outcome = 'accepted' AND soft_failed = 0`),
      takenDown: db.prepare('SELECT 1 FROM takedowns WHERE event = ?'),
      addGap: db.prepare('INSERT OR IGNORE INTO content_gaps (id, room, received_at) VALUES (?, ?, ?)'),
      closeGap: db.prepare('DELETE FROM content_gaps WHERE id = ?'),
      gaps: db.prepare('SELECT id FROM content_gaps WHERE received_at >= ? ORDER BY received_at DESC LIMIT ?'),
      dropGaps: db.prepare('DELETE FROM content_gaps WHERE received_at < ?'),
      dropRoomGaps: db.prepare('DELETE FROM content_gaps WHERE room = ?'),
      // Gaps from before the table existed, and restored takedowns (§9.5), found at startup.
      findGaps: db.prepare(`INSERT OR IGNORE INTO content_gaps (id, room, received_at)
                            SELECT e.id, e.room, e.received_at FROM events e
                            WHERE e.outcome = 'accepted' AND e.soft_failed = 0 AND e.content IS NULL
                              AND (e.withheld IS NULL OR (e.withheld = 'operator' AND NOT EXISTS (SELECT 1 FROM takedowns t WHERE t.event = e.id)))
                              AND json_extract(e.event, '$.header.kind') IN ('msg.post', 'room.keys')`),
      peerContent: db.prepare('SELECT content FROM events WHERE id = ?'),
      listRooms: db.prepare('SELECT room, last_event_at FROM rooms WHERE room > ? ORDER BY room LIMIT ?'),
      listAgents: db.prepare('SELECT agent, head FROM agents WHERE agent > ? ORDER BY agent LIMIT ?'),
      agentEventJson: db.prepare('SELECT event FROM agent_events WHERE id = ?'),
      report: db.prepare('SELECT id FROM reports WHERE id = ?'),
      insertReport: db.prepare('INSERT INTO reports (id, report, reporter, received_at) VALUES (?, ?, ?, ?)'),
      reportJson: db.prepare('SELECT report FROM reports WHERE id = ?'),
      lastReportBy: db.prepare('SELECT max(received_at) AS at FROM reports WHERE reporter = ?'),
      listReports: db.prepare('SELECT id, report FROM reports WHERE id > ? ORDER BY id LIMIT ?'),
      dropReports: db.prepare('DELETE FROM reports WHERE received_at < ?'),
      dropResolutions: db.prepare('DELETE FROM report_resolutions WHERE id NOT IN (SELECT id FROM reports)'),
      expireContent: db.prepare(`UPDATE events SET content = NULL, withheld = 'expired'
                                 WHERE content IS NOT NULL AND received_at < ?`),
      upsertMember: db.prepare(`INSERT INTO memberships (room, agent, membership, event) VALUES (?, ?, ?, ?)
                                ON CONFLICT (room, agent) DO UPDATE SET membership = excluded.membership, event = excluded.event`),
      withhold: db.prepare('UPDATE events SET content = NULL, withheld = ? WHERE id = ? AND withheld IS NULL'),
      content: db.prepare('SELECT content, withheld FROM events WHERE id = ?'),
      eventRoom: db.prepare('SELECT room FROM events WHERE id = ?'),
      deletesOf: db.prepare(`SELECT event FROM events WHERE target = ? AND room = ? AND outcome = 'accepted'`),
      all: db.prepare('SELECT event, outcome, reason, soft_failed FROM events ORDER BY seq'),
      roomsOf: db.prepare('SELECT room, membership, event FROM memberships WHERE agent = ?'),
      membership: db.prepare('SELECT membership, event FROM memberships WHERE room = ? AND agent = ?'),
      listDirectory: db.prepare(`SELECT d.room, d.name, d.topic, d.members, r.last_event_at FROM directory d
                                 JOIN rooms r ON r.room = d.room WHERE d.room > ? ORDER BY d.room LIMIT ?`),
      searchDirectory: db.prepare(`SELECT d.room, d.name, d.topic, d.members, r.last_event_at FROM directory d
                                   JOIN rooms r ON r.room = d.room WHERE d.search LIKE ? ESCAPE '\\' AND d.room > ?
                                   ORDER BY d.room LIMIT ?`),
      upsertDirectory: db.prepare(`INSERT INTO directory (room, name, topic, search, members) VALUES (?, ?, ?, ?, ?)
                                   ON CONFLICT (room) DO UPDATE SET name = excluded.name, topic = excluded.topic,
                                     search = excluded.search, members = excluded.members`),
      unlist: db.prepare('DELETE FROM directory WHERE room = ?'),
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
    this.#db.exec('BEGIN');
    try {
      this.#db.exec('DELETE FROM directory');
      for (const room of this.#rooms.values()) this.#index(room);
      this.#q.findGaps.run();
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  // Keeps the room's directory entry (§7.4) in step with its current state: a
  // public room is listed while its room.meta says listed: true.
  #index(room, state = room.currentState()) {
    const meta = state.get('room.meta|')?.header.data;
    if (room.create.header.data.type !== 'public' || meta?.listed !== true) {
      this.#q.unlist.run(room.id);
      return;
    }
    let members = 0;
    for (const [k, ev] of state) if (k.startsWith('room.member|') && ev.header.data.membership === 'join') members++;
    const search = [meta.name ?? '', meta.topic ?? ''].join('\n').toLowerCase();
    this.#q.upsertDirectory.run(room.id, meta.name ?? null, meta.topic ?? null, search, members);
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
      this.#q.dropGaps.run(now - contentMs); // content that old would have expired anyway
      const rooms = this.#q.staleRooms.all(now - roomMs).map((r) => r.room);
      for (const room of rooms) {
        this.#q.dropEvents.run(room);
        this.#q.dropMembers.run(room);
        this.#q.dropRoomGaps.run(room);
        this.#q.dropRoom.run(room);
        this.#q.unlist.run(room);
        this.#q.bury.run(room, now);
      }
      const forgotten = Number(this.#q.forget.run(now - tombstoneMs).changes);
      const reports = Number(this.#q.dropReports.run(now - reportMs).changes);
      this.#q.dropResolutions.run();
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
  // node it came from, if any ('pull' for anti-entropy, which is not gossiped
  // on); `from` is what is recorded with the event: 'client', or the sending peer.
  ingest(ev, now = Date.now(), origin = null, from = origin && origin !== 'pull' ? origin : origin ? 'peer' : 'client') {
    const result = this.#ingest(ev, now, origin, from);
    const c = this.ingestCounts.get(from) ?? { received: 0, accepted: 0 };
    c.received++;
    if (result.stored && result.outcome === 'accepted') c.accepted++;
    this.ingestCounts.set(from, c);
    delete result.stored;
    return result;
  }

  // Rooms, agents, and events held (§9.6).
  counts() {
    const r = this.#q.counts.get();
    return { rooms: Number(r.rooms), agents: Number(r.agents), events: Number(r.events) };
  }

  // A small value kept across restarts (the latest health snapshot, §9.6).
  getMeta(key) {
    return this.#q.meta.get(key)?.value ?? null;
  }

  putMeta(key, value) {
    this.#q.putMeta.run(key, value);
  }

  #ingest(ev, now, origin, from) {
    const malformed = checkWellFormed(ev);
    if (malformed) return { outcome: 'discarded', reason: malformed };
    if (AGENT_KINDS.has(ev.header.kind)) return this.#ingestAgent(ev, now, origin, from);
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
      if (ev.content !== undefined && Number(this.#q.fillContent.run(ev.content, ev.id).changes)) this.#q.closeGap.run(ev.id);
      return known;
    }

    const result = room.add(ev, { wellFormed: true });
    if (result.outcome !== 'accepted' && result.outcome !== 'rejected') return result;
    if (isCreate) this.#rooms.set(roomId, room);

    this.#db.exec('BEGIN');
    try {
      const accepted = result.outcome === 'accepted';
      // An operator takedown (§9.5) may name an event before it arrives: its content is never stored.
      const takenDown = accepted && CONTENT_KINDS.has(ev.header.kind) && this.#q.takenDown.get(ev.id) !== undefined;
      this.#q.insert.run(ev.id, roomId, JSON.stringify({ header: ev.header, id: ev.id, sig: ev.sig }),
        accepted && !takenDown ? ev.content ?? null : null, result.outcome, result.reason ?? null,
        ev.header.kind === 'msg.delete' ? ev.header.data.target : null, result.soft_failed ? 1 : 0, now, from);
      if (takenDown) this.#q.withhold.run('operator', ev.id);
      else if (accepted && !result.soft_failed && CONTENT_KINDS.has(ev.header.kind) && ev.content === undefined) {
        this.#q.addGap.run(ev.id, roomId, now);
      }
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
    return { ...result, stored: true };
  }

  // Agent events (§5.4): valid given their parent alone, so they are accepted,
  // discarded, or pending on the parent. Nothing invalid is stored.
  #ingestAgent(ev, now, origin, from) {
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
        rec.depth, rec.rotations, state, now, from);
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
    return { outcome: 'accepted', stored: true };
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
    const current = room.currentState();
    for (const [k, state] of current) {
      if (!k.startsWith('room.member|')) continue;
      this.#q.upsertMember.run(room.id, state.header.data.target, state.header.data.membership, state.id);
    }
    this.#index(room, current);
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

  // The room a stored room event belongs to, or null.
  eventRoom(id) {
    return this.#q.eventRoom.get(id)?.room ?? null;
  }

  // Content repair (§11.3): events held without content, newest first, that are
  // still inside the retention window.
  contentGaps(limit, now = Date.now()) {
    return this.#q.gaps.all(now - this.retention.contentMs, limit).map((r) => r.id);
  }

  // Fills a gap with content from a peer, after checking it against the signed
  // header. Returns 'filled', 'mismatch' (the peer sent the wrong bytes), or
  // 'skipped' (not a gap: unknown, already held, withheld, or taken down).
  repairContent(id, content) {
    const roomId = this.eventRoom(id);
    const h = roomId && this.#rooms.get(roomId)?.event(id)?.header;
    if (!h || !CONTENT_KINDS.has(h.kind)) return 'skipped';
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') !== h.content_len ||
        b64u(sha256(Buffer.from(content, 'utf8'))) !== h.content_hash) return 'mismatch';
    if (!Number(this.#q.fillContent.run(content, id).changes)) return 'skipped';
    this.#q.closeGap.run(id);
    return 'filled';
  }

  // Content this node holds for peers asking (§11.2 /v2/content): not withheld, not expired.
  peerContent(id) {
    return this.#q.peerContent.get(id)?.content ?? null;
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

  // Listed public rooms (§7.4) in ID order after `cursor`, optionally matching
  // `query` as a case-insensitive substring of name or topic.
  directory(query, cursor, limit) {
    const rows = query
      ? this.#q.searchDirectory.all('%' + query.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%', cursor, limit)
      : this.#q.listDirectory.all(cursor, limit);
    return rows.map((r) => ({ room: r.room, members: r.members, active_at: r.last_event_at, name: r.name, topic: r.topic }));
  }

  listAgents(cursor, limit) {
    return this.#q.listAgents.all(cursor, limit);
  }

  hasReport(id) {
    return this.#q.report.get(id) !== undefined;
  }

  // When `agent` last made a report to this node, or null (for the §7.8 rate limit).
  lastReportBy(agent) {
    return this.#q.lastReportBy.get(agent)?.at ?? null;
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
