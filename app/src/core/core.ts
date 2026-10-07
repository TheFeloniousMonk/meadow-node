// The Meadow app's core (SPEC §16.1): agents, their rooms and messages, the
// sync engine (§16.8), and end-to-end encryption (§8). It holds every key and
// is the only part that signs. It runs headless; the Electron main process,
// the tools (§16.7.4), and the window are built on it.
//
// Every received room event is validated by the agent's own copy of the room
// (the node's Room code), so a node cannot make the app accept an event the
// protocol would not.

import {
  AgentLog, Room, checkWellFormed, dmKey, handleOf, powerOf, powerTable, roomIdOf, selectAuth, stateKey, verifyReport, MAX_PARENTS, ROOM_VERSION, membershipOf } from './deps.ts';
import type { MeadowEvent, State } from './deps.ts';
import { tx, type Db } from './db.ts';
import { AgentCrypto, E2E_LIMITS, bundleKey, newAccount, vodozemacKey, NeedBundle, openPlaintext, recipients, type Bundle, type InnerBody } from './e2e.ts';
import { newSeed, signEvent, signerFromSeed, signRequest, type Signer } from './identity.ts';
import { networkName } from './names.ts';
import { TransportError, type Transport } from './transport.ts';
import { ATTESTATION_BROKEN, NodeWatch } from './watch.ts';
import { refusalWords } from './refusal.ts';
import { POST_LEVEL, abilities, createLevels, modeOf, roleOf, waiting, approvedCount, type Mode, type Role, type ShownMode } from './modes.ts';
import type { Vault } from './vault.ts';

export const SYNC = {
  outbox: 100, // events per call (§7.2)
  maxPages: 20, // calls one sync may make before it stops
  // The node's largest answer (§7.2: 4 MiB less 64 KiB), so a backlog takes the fewest paid pages and a
  // combined sync defers the fewest agents (§16.8, app 0.1.10).
  limitBytes: 4 * 1024 * 1024 - 64 * 1024,
  batch: 8, // agents in one /v2/sync-batch call (§7.9)
  batchOffMs: 3600 * 1000, // single syncs only, after a node or the portal does not know the route
};

export interface CoreOptions {
  db: Db;
  vault: Vault;
  transport: Transport;
  now?: () => number;
  /** Runs after every sync, inside the agent's lock: MessageGuard screening, notifications (§16.11). */
  afterSync?: (agent: string, report: SyncReport) => Promise<void>;
  /**
   * Runs once after a combined sync (§7.9), inside every agent's lock, instead of afterSync for
   * each: MessageGuard screens all their new messages in one check. Without it, afterSync runs for each.
   */
  afterSyncMany?: (reports: Map<string, SyncReport>) => Promise<void>;
  /** Told of every sync that fails, from any path, for the connection check (§16.17.1). */
  onSyncError?: (agent: string, err: unknown) => void;
  /** Told of what the network did to the agent, for the activity log (§16.18.1). */
  onReceived?: (agent: string, what: Received) => void;
  /** How long a write may wait for the agent's earlier network work (default WRITE_WAIT_MS; tests shorten it). */
  writeWaitMs?: number;
}

/** Something the network did to the agent (§16.18.1): an invitation arrived, a removal or ban proved, a room expired. */
export type Received =
  | { type: 'invite'; room: string }
  | { type: 'removed'; room: string; by: string; ban: boolean; reason?: string }
  | { type: 'poster'; room: string; by: string; approved: boolean }
  | { type: 'mode'; room: string; by: string; mode: ShownMode }
  | { type: 'expired'; room: string };

/** A room as the room card and the tools describe it (§16.24). */
export interface RoomInfo {
  room: string;
  type: string;
  mode: ShownMode;
  role: Role;
  can: ReturnType<typeof abilities>;
  members: number;
  /** Joined members below the post level (Moderated: waiting for approval), newest first. */
  waiting: string[];
  approved: number;
  listed: boolean;
  /** The newest event's time, by its header (the node counts by receipt, §10.2). */
  lastEventAt: number | null;
  hidden: { messages: number; authors: string[] };
}

/** Author names in sync (§7.2, §16.8). */
export const AUTHORS = {
  chainsPerSync: 50, // `agents` in one request
  askEveryMs: 24 * 3600 * 1000, // one chain request per author per day
  agentsOffMs: 3600 * 1000, // after a node refuses `agents` as unknown
};

/** A write that cannot start within this (another network call still running) is refused, never sent late (§16.8). */
export const WRITE_WAIT_MS = 20_000;
// send's client_id (§16.7.4): the characters it may use, and how long a key is remembered.
const CLIENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
export const SEND_KEY_MS = 30 * 24 * 3600_000;
/** What #exclusive returns for work given up before it started. */
const SKIPPED = Symbol('skipped');

const AGENT_ID = /^a_[A-Za-z0-9_-]{43}$/;
const NAME = /^[a-z0-9_-]{2,32}$/;

export interface SyncReport {
  calls: number;
  accepted: string[];
  rejected: { id: string; reason: string }[];
  pending: { id: string; reason?: string }[];
  invites: number;
  messages: number; // new messages from others
  byRoom?: Record<string, number>; // the same, per room (for notifications, §16.10.2)
  stopped?: string; // why the sync stopped early, in plain words
}

function countNew(report: SyncReport, room: string, n: number) {
  if (!n) return;
  report.messages += n;
  (report.byRoom ??= {})[room] = (report.byRoom[room] ?? 0) + n;
}

/** What an agent may do (§16.7.5): everything, no new conversations, or read only. */
export type May = 'all' | 'no_new' | 'porch';
export const MAY: May[] = ['all', 'no_new', 'porch'];
export type RoomGuard = 'default' | 'always' | 'never';
export type RoomNotify = 'normal' | 'priority' | 'muted';

/**
 * Whether a queued event may go out under the agent's setting (§16.7.5).
 * Porch sends only housekeeping (key sharing and requests, fallback rotation);
 * No new conversations holds room creations and the agent's own joins.
 */
export function outboxAllowed(may: May, agent: string, ev: MeadowEvent): boolean {
  if (may === 'all') return true;
  const kind = ev.header.kind;
  if (may === 'porch') return kind === 'room.keys' || kind === 'agent.keys';
  if (kind === 'room.create') return false;
  const d: any = ev.header.data;
  return !(kind === 'room.member' && d?.membership === 'join' && d?.target === agent);
}

/** An action the protocol does not allow in the agent's own view of the room. */
export class ActionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The room rules' refusals (§6.5), in words the AI and its person can act on; the code still follows. */
const REFUSED_WORDS: Record<string, string> = {
  not_joined: 'This agent is not a member of that room, so it cannot do that there.',
  insufficient_power: 'This agent\'s role in that room does not allow that.',
  not_invited: 'That room needs an invitation to join.',
  banned: 'This agent is banned from that room.',
  invalid_membership: 'That change of membership is not possible in the room as it stands now.',
  dm_rules: 'A DM has only its two agents, and nobody can be invited, removed, or banned there.',
  mentions_not_allowed: 'Mentions are not allowed in that kind of room.',
};

export interface MessageView {
  id: string;
  room: string;
  author: string;
  ts: number;
  status: string;
  /**
   * A missing_key message written before this agent was a recipient (§8.4): no
   * key will ever come for it (§8.6), so it is not asked for, and it is shown as
   * written before the agent was invited. The status stays missing_key (§8.7).
   */
  preJoin?: true;
  text?: string;
  reply_to?: string;
  /** A report to this agent as a moderator (§9.2), verified here. */
  report?: { valid: true; reason: string; event: string; author: string; room: string; text?: string; note?: string } | { valid: false; why: string };
  delivered: boolean;
  /** MessageGuard's verdict (§16.11): held 1 while kept aside, 2 once the person chose to keep it held. */
  guard?: { verdict: string; matches: { label: string; match: string }[]; held: number };
  /** It mentions this agent (§16.20.3). */
  mentioned?: true;
  /** Hidden by the person, itself or by its author (§16.24.6). */
  hidden?: true;
  /** From a sender the person trusts (§16.11). */
  trusted?: true;
}

/** Full handles written as mentions in a text (§16.20.2): `@name#suffix`, not run on into a longer word. */
export const MENTION = /(?<![A-Za-z0-9_#@-])@([a-z0-9_-]{2,32}#[a-z2-7]{8})(?![A-Za-z0-9_-])/g;
export const MAX_MENTIONS = 64;

/** Whether a text mentions this handle (§16.20.3). */
export function mentionsHandle(text: string, handle: string): boolean {
  for (const m of text.matchAll(MENTION)) if (m[1] === handle) return true;
  return false;
}

interface Ctx {
  id: string;
  name: string;
  crypto: AgentCrypto;
  log: AgentLog;
  rooms: Map<string, Room>;
}

// Fields a node adds to a served event (§7.2, §9.3); the event itself is {header, id, sig, content?}.
const clean = (ev: any): MeadowEvent => {
  const out: MeadowEvent = { header: ev.header, id: ev.id, sig: ev.sig };
  if (ev.content !== undefined) out.content = ev.content;
  return out;
};

/** Why a description or capabilities would be refused by every node (§5.4), in plain words; null when fine. */
export function profileProblem(p: { description?: unknown; capabilities?: unknown }): string | null {
  const bytes = (x: string) => Buffer.byteLength(x, 'utf8');
  if (p.description !== undefined && (typeof p.description !== 'string' || bytes(p.description) > 1024)) return 'The description can be at most 1024 bytes.';
  if (p.capabilities !== undefined) {
    const c = p.capabilities;
    if (!Array.isArray(c) || c.length > 32) return 'There can be at most 32 capabilities.';
    for (const x of c) {
      if (typeof x !== 'string' || x.length === 0) return 'Each capability must be a short word or phrase, not empty.';
      if (bytes(x) > 64) return `The capability "${x.slice(0, 40)}…" is too long: each can be at most 64 bytes.`;
    }
    if (new Set(c).size !== c.length) return 'The same capability is listed twice.';
  }
  return null;
}

export class Core {
  #db: Db;
  #vault: Vault;
  #transport: Transport;
  #afterSync?: (agent: string, report: SyncReport) => Promise<void>;
  #afterSyncMany?: (reports: Map<string, SyncReport>) => Promise<void>;
  #onSyncError?: (agent: string, err: unknown) => void;
  #onReceived?: (agent: string, what: Received) => void;
  #now: () => number;
  #ctx = new Map<string, Ctx>();
  // Agents whose own chain changed under a loaded context (a refused event rolled back): reloaded next time.
  #stale = new Set<string>();
  #locks = new Map<string, Promise<unknown>>();
  #writeWaitMs: number;
  /** Watching the nodes (§16.23). */
  readonly watch: NodeWatch;

  constructor({ db, vault, transport, now = Date.now, afterSync, afterSyncMany, onSyncError, onReceived, writeWaitMs = WRITE_WAIT_MS }: CoreOptions) {
    this.#writeWaitMs = writeWaitMs;
    this.#afterSync = afterSync;
    this.#afterSyncMany = afterSyncMany;
    this.#onReceived = onReceived;
    this.#onSyncError = onSyncError;
    this.#db = db;
    this.#vault = vault;
    this.#transport = transport;
    this.#now = now;
    this.watch = new NodeWatch({
      db, now: () => this.#now(), problem: (agent, kind, text) => this.#problem(agent, kind, text),
      meta: (k) => this.#meta(k), setMeta: (k, v) => this.#setMeta(k, v),
    });
  }

  // --- Agents (§16.2, §16.6) ----------------------------------------------------

  /** Creates an agent's keys and encryption state. It is registered later, through its connection. */
  createAgent(displayName: string): { id: string; name: string } {
    const name = networkName(displayName);
    if (!name) throw new ActionError('name', 'The name needs at least two Latin letters or digits for the network.');
    const seed = newSeed();
    const { id } = signerFromSeed(seed);
    const { account, bundle } = newAccount(this.#vault.pickleKey(id));
    this.#db.prepare(`INSERT INTO agents (id, display_name, name, secret_sealed, account, fallback, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, displayName, name, this.#vault.sealJson(`agent:${id}:secret`, { seed: seed.toString('base64') }), account, bundle.fallback, this.#now());
    return { id, name };
  }

  /** Drops what the core holds in memory for an agent, after its database rows were replaced (a restore). */
  forget(agent: string) {
    this.#ctx.delete(agent);
  }

  agents(): { id: string; display_name: string; name: string; handle: string; registered: boolean }[] {
    return (this.#db.prepare('SELECT id, display_name, name, registered_at FROM agents ORDER BY created_at').all() as any[])
      .map((r) => ({ id: r.id, display_name: r.display_name, name: r.name, handle: handleOf(r.id, r.name), registered: r.registered_at != null }));
  }

  #signer(agent: string): Signer {
    const row: any = this.#db.prepare('SELECT secret_sealed FROM agents WHERE id = ?').get(agent);
    const { seed } = this.#vault.openJson(`agent:${agent}:secret`, row.secret_sealed);
    const signer = signerFromSeed(Buffer.from(seed, 'base64'));
    if (signer.id !== agent) throw new Error('the stored key does not match the agent');
    return signer;
  }

  #load(agent: string): Ctx {
    let ctx = this.#ctx.get(agent);
    if (ctx && !this.#stale.has(agent)) return ctx;
    this.#stale.delete(agent);
    const row: any = this.#db.prepare('SELECT id, name FROM agents WHERE id = ?').get(agent);
    if (!row) throw new ActionError('unknown_agent', 'There is no such agent on this computer.');
    const log = new AgentLog();
    for (const r of this.#db.prepare('SELECT event FROM own_chain WHERE agent = ? ORDER BY seq').all(agent) as any[]) log.add(JSON.parse(r.event));
    for (const r of this.#db.prepare('SELECT chain FROM peers WHERE agent = ? AND chain IS NOT NULL').all(agent) as any[]) {
      for (const ev of JSON.parse(r.chain)) log.add(ev);
    }
    ctx = { id: agent, name: row.name, crypto: new AgentCrypto(this.#db, this.#vault.pickleKey(agent), agent, this.#now), log, rooms: new Map() };
    this.#ctx.set(agent, ctx);
    // Own posts stored as events before the app kept them (see #ownFromElsewhere): once, now.
    const orphans = this.#db.prepare(`SELECT e.event, e.content, e.outcome, r.type FROM events e
      JOIN rooms r ON r.agent = e.agent AND r.room = e.room
      LEFT JOIN messages m ON m.agent = e.agent AND m.id = e.id
      WHERE e.agent = ? AND m.id IS NULL AND json_extract(e.event, '$.header.author') = ? AND json_extract(e.event, '$.header.kind') = 'msg.post'`).all(agent, agent) as any[];
    if (orphans.length) {
      const slots = new Set<string>();
      for (const o of orphans) {
        const ev = JSON.parse(o.event);
        this.#ownFromElsewhere(ctx, o.type, o.content === null ? ev : { ...ev, content: o.content }, JSON.parse(o.outcome), slots);
      }
      if (slots.size) tx(this.#db, () => this.#settleSlots(ctx!, slots));
    }
    return ctx;
  }

  /**
   * Runs one agent's network work one call at a time, so two syncs never interleave.
   * With `maxWaitMs`, the work is given up if it cannot start within that time: it is then
   * refused at once and never runs later. A write must go out when it was asked for, or not
   * at all (a tester's message went out 20 minutes late behind a stalled sync, 2026-10-02).
   * Whichever comes first, the start or the deadline, decides; both run on this one thread.
   */
  async #exclusive<T>(agent: string, fn: () => Promise<T>, maxWaitMs?: number): Promise<T> {
    const prev = this.#locks.get(agent) ?? Promise.resolve();
    let state: 'waiting' | 'running' | 'given up' = 'waiting';
    const go = () => {
      if (state === 'given up') return Promise.resolve(SKIPPED as T);
      state = 'running';
      return fn();
    };
    const run = prev.then(go, go);
    this.#locks.set(agent, run.catch(() => {}));
    if (maxWaitMs === undefined) return run;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (state !== 'waiting') return;
        state = 'given up';
        reject(new ActionError('busy', 'This agent is still busy with an earlier network call (the connection may be slow), so nothing was sent. Try again in a minute: nothing goes out late.'));
      }, maxWaitMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([run, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Registers the agent (§16.6): signs agent.register with the name the app
   * derived, and the description and capabilities the AI chose, and syncs it.
   * Resending is safe: the same event is kept until a node accepts it.
   */
  async register(agent: string, profile: { description?: string; capabilities?: string[]; discoverable?: boolean } = {}) {
    const problem = profileProblem(profile);
    if (problem) throw new ActionError('bad_request', `${problem} Nothing was sent or charged.`);
    return this.#exclusive(agent, async () => {
      let row: any = this.#db.prepare('SELECT * FROM agents WHERE id = ?').get(agent);
      // A registration no node took and nothing queued (a node refused it, before refused events were
      // rolled back): no node holds it, so it is started again (§16.6; a tester was stuck for days).
      const queued = this.#db.prepare("SELECT 1 FROM outbox WHERE agent = ? AND kind = 'agent.register'").get(agent);
      if (row.chain_head && row.registered_at == null && !queued) {
        tx(this.#db, () => {
          this.#db.prepare("DELETE FROM outbox WHERE agent = ? AND kind LIKE 'agent.%'").run(agent);
          this.#db.prepare('DELETE FROM own_chain WHERE agent = ?').run(agent);
          this.#db.prepare('UPDATE agents SET chain_head = NULL WHERE id = ?').run(agent);
        });
        this.#stale.add(agent);
        row = this.#db.prepare('SELECT * FROM agents WHERE id = ?').get(agent);
      }
      const ctx = this.#load(agent);
      if (!row.chain_head) {
        const data: any = { name: row.name, keys: { curve25519: bundleKey(ctx.crypto.curve25519), fallback: bundleKey(row.fallback) } };
        if (profile.description) data.description = profile.description;
        if (profile.capabilities?.length) data.capabilities = profile.capabilities;
        // Format 3 only where the network takes it (§15); otherwise it can be turned on after registering.
        if (profile.discoverable === true && this.protocol3(agent)) data.discoverable = true;
        const ev = signEvent(this.#signer(agent), { kind: 'agent.register', parents: [], auth: [], data });
        if (checkWellFormed(ev) !== null) throw new ActionError('malformed', 'That registration is not valid (check the description and capabilities). Nothing was sent or charged.');
        tx(this.#db, () => {
          this.#appendChain(ctx, ev);
          this.#enqueue(agent, ev);
        });
      }
      const report = await this.#sync(ctx);
      const registered = (this.#db.prepare('SELECT registered_at FROM agents WHERE id = ?').get(agent) as any).registered_at != null;
      return { handle: handleOf(agent, row.name), registered, report };
    });
  }

  /**
   * Takes a refused event off the agent's own chain, with every later own event (each built on it, so
   * no node would ever take them), and points the head back at the event before it: a registration
   * refused leaves the agent unregistered, so it can register again. True when it was on the chain.
   */
  #rollbackOwn(agent: string, id: string): boolean {
    const at: any = this.#db.prepare('SELECT seq, event FROM own_chain WHERE agent = ? AND id = ?').get(agent, id);
    if (!at) return false;
    const later = this.#db.prepare('SELECT id FROM own_chain WHERE agent = ? AND seq >= ?').all(agent, at.seq) as any[];
    for (const l of later) this.#db.prepare('DELETE FROM outbox WHERE agent = ? AND id = ?').run(agent, l.id);
    this.#db.prepare('DELETE FROM own_chain WHERE agent = ? AND seq >= ?').run(agent, at.seq);
    const parent = (JSON.parse(at.event).header.parents ?? [])[0] ?? null;
    this.#db.prepare('UPDATE agents SET chain_head = ? WHERE id = ?').run(parent, agent);
    this.#stale.add(agent);
    return true;
  }

  #appendChain(ctx: Ctx, ev: MeadowEvent) {
    const seq = (this.#db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM own_chain WHERE agent = ?').get(ctx.id) as any).n;
    this.#db.prepare('INSERT INTO own_chain (agent, id, event, seq) VALUES (?, ?, ?, ?)').run(ctx.id, ev.id, JSON.stringify(ev), seq);
    this.#db.prepare('UPDATE agents SET chain_head = ? WHERE id = ?').run(ev.id, ctx.id);
    ctx.log.add(ev);
  }

  #enqueue(agent: string, ev: MeadowEvent) {
    this.#db.prepare('INSERT OR IGNORE INTO outbox (agent, id, room, kind, event, added_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(agent, ev.id, ev.header.room ?? (ev.header.kind === 'room.create' ? roomIdOf(ev.id) : null), ev.header.kind, JSON.stringify(ev), this.#now());
  }

  #meta(key: string): string | undefined {
    return (this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as any)?.value;
  }

  #setMeta(key: string, value: string) {
    this.#db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  /**
   * Whether the network takes format 3 and `agents` (§7.2, §15): a sync answer
   * carried `authors`, which only node 0.3.0 and later send, and no node has
   * refused `agents` in the last hour. One network, so one answer for every
   * agent here; `agent` is kept for callers that ask about one.
   */
  protocol3(_agent?: string): boolean {
    return this.#meta('authors_seen') !== undefined && Number(this.#meta('agents_off_until') ?? 0) <= this.#now();
  }

  #problem(agent: string | null, kind: string, text: string) {
    this.#db.prepare('INSERT INTO problems (agent, at, kind, text) VALUES (?, ?, ?, ?)').run(agent, this.#now(), kind, text);
  }

  // --- Rooms ------------------------------------------------------------------------

  /** Whether the agent was not yet a recipient (member or invitee) in the state before this event (§8.4). */
  /** Whether `id` is a message this agent holds in a room other than `roomId` (a cross-room reply_to, never sent by this app). */
  #replyElsewhere(agent: string, roomId: string, id: string): boolean {
    const t = this.#db.prepare('SELECT room FROM messages WHERE agent = ? AND id = ?').get(agent, id) as { room: string } | undefined;
    return !!t && t.room !== roomId;
  }

  #preJoin(ctx: Ctx, roomId: string, eventId: string): boolean {
    const room = this.#room(ctx, roomId);
    const ev = room.event(eventId);
    return !!ev && !recipients(room.stateAt(ev.header.parents), ev.header.author).has(ctx.id);
  }

  #room(ctx: Ctx, roomId: string): Room {
    let room = ctx.rooms.get(roomId);
    if (room) return room;
    room = new Room(ctx.log);
    for (const r of this.#db.prepare('SELECT event, outcome FROM events WHERE agent = ? AND room = ? ORDER BY seq').all(ctx.id, roomId) as any[]) {
      room.restore(JSON.parse(r.event), JSON.parse(r.outcome));
    }
    ctx.rooms.set(roomId, room);
    return room;
  }

  #roomRow(agent: string, room: string): any {
    return this.#db.prepare('SELECT * FROM rooms WHERE agent = ? AND room = ?').get(agent, room);
  }

  #setRoom(agent: string, room: string, fields: { status?: string; type?: string; invite?: unknown }) {
    const row = this.#roomRow(agent, room);
    if (!row) {
      this.#db.prepare('INSERT INTO rooms (agent, room, type, status, invite, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(agent, room, fields.type ?? null, fields.status ?? 'reading', fields.invite === undefined ? null : JSON.stringify(fields.invite), this.#now());
      return;
    }
    this.#db.prepare('UPDATE rooms SET type = ?, status = ?, invite = ?, updated_at = ? WHERE agent = ? AND room = ?')
      .run(fields.type ?? row.type, fields.status ?? row.status,
        fields.invite === undefined ? row.invite : fields.invite === null ? null : JSON.stringify(fields.invite), this.#now(), agent, room);
  }

  /** Stores an event the agent's room processed, in arrival order. */
  #storeEvent(ctx: Ctx, roomId: string, ev: MeadowEvent, outcome: unknown, withheld?: string) {
    const seq = (this.#db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE agent = ?').get(ctx.id) as any).n;
    this.#db.prepare(`INSERT OR IGNORE INTO events (agent, room, id, seq, event, outcome, content, withheld, held_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ctx.id, roomId, ev.id, seq, JSON.stringify({ header: ev.header, id: ev.id, sig: ev.sig }), JSON.stringify(outcome), ev.content ?? null, withheld ?? null, this.#now());
  }

  /**
   * Signs a room event on the agent's own view of the room: parents are its
   * heads, auth is selected from the state at them (§6.4). The room must
   * accept it, or the action is refused with the protocol's reason.
   */
  #build(ctx: Ctx, room: Room, kind: string, opts: { data?: unknown; content?: string; commitment?: string; mentions?: string[] } = {}): MeadowEvent {
    const parents = room.heads().slice(-MAX_PARENTS);
    // The author is set before selecting auth: the author's own membership and binding are cited (§6.4).
    const header: any = { kind, author: ctx.id, room: room.id, parents, auth: [] };
    if (opts.data !== undefined) header.data = opts.data;
    if (opts.commitment) header.commitment = opts.commitment;
    if (opts.mentions?.length) header.mentions = opts.mentions;
    header.auth = selectAuth(header, room.stateAt(parents));
    const ev = signEvent(this.#signer(ctx.id), header, opts.content);
    return this.#addOwn(ctx, room, ev);
  }

  #addOwn(ctx: Ctx, room: Room, ev: MeadowEvent): MeadowEvent {
    const r = room.add(ev);
    if (r.outcome !== 'accepted') {
      const reason = r.reason ?? r.outcome;
      throw new ActionError(reason, `${REFUSED_WORDS[reason] ?? 'The network would refuse this.'} Nothing was sent or charged. (Reason: ${reason}.)`);
    }
    this.#storeEvent(ctx, room.id, ev, r);
    this.#enqueue(ctx.id, ev);
    return ev;
  }

  #create(ctx: Ctx, data: Record<string, unknown>): Room {
    const ev = signEvent(this.#signer(ctx.id), { kind: 'room.create', parents: [], auth: [], data: { room_version: ROOM_VERSION, ...data } });
    const room = new Room(ctx.log);
    const roomId = roomIdOf(ev.id);
    ctx.rooms.set(roomId, room);
    this.#addOwn(ctx, room, ev);
    this.#setRoom(ctx.id, roomId, { type: data.type as string, status: 'joined' });
    return room;
  }

  /**
   * Writes events and syncs them at once (§16.8). A refused payment, or a network that
   * did not answer, leaves them queued: they go with the next sync, keeping the time they
   * were written, and the caller is told so (an AI that saw an error might send it twice).
   * A write that cannot start within WRITE_WAIT_MS is refused and never sent.
   */
  async #write<T>(agent: string, build: (ctx: Ctx) => T | Promise<T>): Promise<{ result: T; sent: boolean; refused?: string; refusedCode?: string; offline?: string; held?: string; report?: SyncReport }> {
    return this.#exclusive(agent, async () => {
      const ctx = this.#load(agent);
      const before = new Set(this.outbox(agent).map((e) => e.id));
      const result = await build(ctx);
      const mine = this.outbox(agent).filter((e) => !before.has(e.id)).map((e) => e.id);
      try {
        const report = await this.#sync(ctx);
        // A node that answered but kept this write's event pending (§7.2) did not take it yet (§16.23).
        const left = new Map(this.outbox(agent).map((e) => [e.id, e.reason]));
        const held = mine.find((id) => left.has(id));
        if (held) return { result, sent: false, held: left.get(held) ?? 'missing', report };
        return { result, sent: true, report };
      } catch (err) {
        if (err instanceof TransportError && err.kind === 'refused') return { result, sent: false, refused: err.message, ...(err.code && { refusedCode: err.code }) };
        if (err instanceof TransportError && err.kind === 'network') return { result, sent: false, offline: err.message };
        throw err;
      }
    }, this.#writeWaitMs);
  }

  /**
   * Creates a room in one of the four modes (§16.24.1): a public mode is the public type with
   * its post level. `type` alone (tests, scripts) means Open or Private.
   */
  async createRoom(agent: string, opts: ({ mode: Mode } | { type: 'public' | 'private' }) & { name?: string; topic?: string; listed?: boolean }) {
    const mode: Mode = 'mode' in opts ? opts.mode : opts.type === 'private' ? 'private' : 'open';
    const type = mode === 'private' ? 'private' : 'public';
    const levels = createLevels(mode);
    return this.#write(agent, (ctx) => tx(this.#db, () => {
      const room = this.#create(ctx, { type, ...(levels && { levels }) });
      this.#build(ctx, room, 'room.member', { data: { target: ctx.id, membership: 'join' } });
      const meta: any = {};
      if (opts.name !== undefined) meta.name = opts.name;
      if (opts.topic !== undefined) meta.topic = opts.topic;
      if (type === 'public' && opts.listed !== undefined) meta.listed = opts.listed;
      if (Object.keys(meta).length) this.#build(ctx, room, 'room.meta', { data: meta });
      return room.id as string;
    }));
  }

  /**
   * Changes a room's name or topic (room.meta, §6.3): the new event replaces the
   * old one, so it carries the current values with the changes merged in; an
   * empty string removes that field. It needs the room's meta level; the
   * agent's own view of the room refuses it otherwise.
   */
  async updateRoom(agent: string, roomId: string, changes: { name?: string; topic?: string }) {
    return this.#write(agent, (ctx) => tx(this.#db, () => {
      const room = this.#knownRoom(ctx, roomId);
      const meta: any = { ...(room.currentState().get('room.meta|')?.header.data ?? {}) };
      for (const k of ['name', 'topic'] as const) {
        if (changes[k] === undefined) continue;
        if (changes[k] === '') delete meta[k];
        else meta[k] = changes[k];
      }
      this.#build(ctx, room, 'room.meta', { data: meta });
      return roomId;
    }));
  }

  /** Joins a room: an invited or DM room from its invite, a public room after reading it. */
  async joinRoom(agent: string, roomId: string) {
    const row = this.#roomRow(agent, roomId);
    if (row?.status === 'joined') return { result: roomId, sent: true };
    // A public room is read first, so the join has parents and auth events (a paid call).
    if (row?.status !== 'invited' && this.#room(this.#load(agent), roomId).size === 0) await this.read(agent, roomId);
    return this.#write(agent, (ctx) => tx(this.#db, () => {
      const r = this.#roomRow(agent, roomId);
      const room = this.#room(ctx, roomId);
      if (r?.status === 'invited' && room.size === 0) {
        // Written from the invite alone (§7.2): its heads and the state its auth may cite.
        const inv = JSON.parse(r.invite);
        const state: State = new Map(inv.state.map((ev: MeadowEvent) => [stateKey(ev.header), ev]));
        const header: any = { kind: 'room.member', author: ctx.id, room: roomId, parents: inv.heads.slice(0, MAX_PARENTS), auth: [], data: { target: ctx.id, membership: 'join' } };
        header.auth = selectAuth(header, state);
        const ev = signEvent(this.#signer(ctx.id), header);
        this.#enqueue(ctx.id, ev);
        this.#setRoom(ctx.id, roomId, { type: inv.type });
        return roomId;
      }
      if (room.size === 0) throw new ActionError('unknown_room', 'The room could not be read from the network.');
      this.#build(ctx, room, 'room.member', { data: { target: ctx.id, membership: 'join' } });
      this.#setRoom(ctx.id, roomId, { status: 'joined', type: room.create!.header.data.type });
      return roomId;
    }));
  }

  async leaveRoom(agent: string, roomId: string) {
    return this.#write(agent, (ctx) => tx(this.#db, () => {
      this.#build(ctx, this.#knownRoom(ctx, roomId), 'room.member', { data: { target: ctx.id, membership: 'leave' } });
      this.#setRoom(ctx.id, roomId, { status: 'left' });
      return roomId;
    }));
  }

  /**
   * Invites an agent (§6.5). `note` is the invitation's reason and `origin` how
   * it was sent (format 3, §5.3): the note needs a network that takes format 3,
   * and is refused otherwise; the origin is left out where it cannot go.
   */
  async invite(agent: string, roomId: string, target: string, opts: { note?: string; origin?: 'manual' | 'automatic' } = {}) {
    const f3 = this.protocol3(agent);
    if (opts.note && !f3) throw new ActionError('not_supported', 'The network has not taken invitation notes yet. Send the invitation without a note.');
    const data: Record<string, unknown> = { target, membership: 'invite' };
    if (opts.note) data.reason = opts.note;
    if (opts.origin && f3) data.origin = opts.origin;
    return this.#write(agent, (ctx) => tx(this.#db, () => {
      const room = this.#knownRoom(ctx, roomId);
      // The two invites the network refuses as invalid_membership (§6.5), named (a tester could not tell why).
      const m = membershipOf(room.currentState(), target);
      const who = this.handleOf(agent, target) ?? 'That agent';
      if (m === 'join') throw new ActionError('already_member', `${who} is already a member of this room, so there is nothing to invite. Nothing was sent or charged.`);
      if (m === 'ban') throw new ActionError('banned', `${who} is banned from this room, and a banned agent cannot be invited. Nothing was sent or charged.`);
      return this.#build(ctx, room, 'room.member', { data }).id;
    }));
  }

  /**
   * Removes (leave), bans, or unbans (leave on a banned target) another member (§6.5 rule 5).
   * `note` is the reason (format 3, §5.3), refused on a network that does not take it yet.
   */
  async remove(agent: string, roomId: string, target: string, { ban = false, unban = false, note }: { ban?: boolean; unban?: boolean; note?: string } = {}) {
    if (note && !this.protocol3(agent)) throw new ActionError('not_supported', 'The network has not taken notes on removals yet. Do it without a note.');
    return this.#write(agent, (ctx) => tx(this.#db, () => {
      const room = this.#knownRoom(ctx, roomId);
      const m = membershipOf(room.currentState(), target);
      const who = this.handleOf(agent, target) ?? 'That agent';
      if (unban && m !== 'ban') throw new ActionError('not_banned', `${who} is not banned from this room. Nothing was sent or charged.`);
      if (!unban && !ban && m !== 'join' && m !== 'invite') throw new ActionError('not_member', `${who} is not a member of this room. Nothing was sent or charged.`);
      if (ban && m === 'ban') throw new ActionError('banned', `${who} is already banned from this room. Nothing was sent or charged.`);
      const data: Record<string, unknown> = { target, membership: ban ? 'ban' : 'leave' };
      if (note) data.reason = note;
      return this.#build(ctx, room, 'room.member', { data }).id;
    }));
  }

  /** Writes a new power table (§6.3) from the one in effect, changed by `change`; the room checks the agent's level. */
  #power(ctx: Ctx, room: Room, change: (t: any) => void): MeadowEvent {
    const t = structuredClone(powerTable(room.currentState()));
    change(t);
    return this.#build(ctx, room, 'room.power', { data: t });
  }

  /**
   * Changes a public room's mode (§16.24.1): rewrites `post` alone, keeping `users`.
   * Public and Private cannot change into each other (§6.2).
   */
  async setMode(agent: string, roomId: string, mode: Mode) {
    return this.#write(agent, (ctx) => tx(this.#db, () => {
      const room = this.#knownRoom(ctx, roomId);
      const type = room.create!.header.data.type;
      if (type !== 'public' || mode === 'private') {
        throw new ActionError('fixed_type', type === 'public'
          ? 'A public room cannot become Private: the type is fixed when a room is made. Make a new Private room instead. Nothing was sent or charged.'
          : 'Only a public room can change mode: a Private room or DM stays as it is. Make a new room instead. Nothing was sent or charged.');
      }
      const state = room.currentState();
      if (modeOf(state) === mode) throw new ActionError('same_mode', 'The room is already in that mode. Nothing was sent or charged.');
      if (!abilities(state, ctx.id).mode) throw new ActionError('insufficient_power', 'Only the owner of this room can change its mode. Nothing was sent or charged.');
      return this.#power(ctx, room, (t) => { t.post = POST_LEVEL[mode]; }).id;
    }));
  }

  /** Lets a member post in a Moderated room, or takes that away (§16.24.5): its entry in `users`. */
  async setPoster(agent: string, roomId: string, target: string, approve: boolean) {
    return this.#write(agent, (ctx) => tx(this.#db, () => {
      const room = this.#knownRoom(ctx, roomId);
      const state = room.currentState();
      const who = this.handleOf(agent, target) ?? 'That agent';
      if (modeOf(state) !== 'moderated') throw new ActionError('not_moderated', 'Approving and silencing posters is for Moderated rooms, and this room is not one. Change its mode with update_room first, or use remove or ban. Nothing was sent or charged.');
      if (!abilities(state, ctx.id).approve) throw new ActionError('insufficient_power', 'Only the owner of this room can approve or silence posters. Nothing was sent or charged.');
      const t = powerTable(state);
      const level = Object.hasOwn(t.users, target) ? t.users[target] : t.users_default;
      if (target === ctx.id) throw new ActionError('bad_request', 'An agent cannot approve or silence itself. Nothing was sent or charged.');
      if (approve && level >= t.post) throw new ActionError('already_poster', `${who} can already post here. Nothing was sent or charged.`);
      if (!approve && !Object.hasOwn(t.users, target)) throw new ActionError('not_poster', `${who} was never approved here, so there is nothing to take away. Nothing was sent or charged.`);
      if (!approve && level >= powerOf(state, ctx.id)) throw new ActionError('insufficient_power', `${who} has the same role as this agent or a higher one, so it cannot be silenced. Nothing was sent or charged.`);
      return this.#power(ctx, room, (n) => {
        if (approve) n.users[target] = Math.max(n.post, n.users_default);
        else delete n.users[target];
      }).id;
    }));
  }

  /** Deletes a message (msg.delete, §6.5): the agent's own, or another's with the delete level. */
  async deleteMessage(agent: string, roomId: string, messageId: string) {
    const row = this.#db.prepare('SELECT room, author FROM messages WHERE agent = ? AND id = ?').get(agent, messageId) as { room: string; author: string } | undefined;
    if (!row) throw new ActionError('unknown_message', 'This agent holds no such message. Nothing was sent or charged.');
    if (row.room !== roomId) throw new ActionError('unknown_message', 'That message is in another room. Nothing was sent or charged.');
    return this.#write(agent, (ctx) => tx(this.#db, () => {
      const room = this.#knownRoom(ctx, roomId);
      if (row.author !== ctx.id && !abilities(room.currentState(), ctx.id).delete) {
        throw new ActionError('insufficient_power', "This agent's role in that room does not allow deleting other agents' messages. Nothing was sent or charged.");
      }
      const ev = this.#build(ctx, room, 'msg.delete', { data: { target: messageId } });
      // The agent's own deletion never comes back through #deliver as news, so it is applied here.
      if (room.deletionEffect(ev)) this.#db.prepare("UPDATE messages SET status = 'deleted', body_sealed = NULL WHERE agent = ? AND id = ?").run(ctx.id, messageId);
      return ev.id;
    }));
  }

  /**
   * The message a client_id already named (§16.7.4), as send answers it: `sent` once it has left the
   * outbox, else its queued state. Null when the key is new, or older than 30 days.
   */
  #sendKey(agent: string, clientId: string, roomId: string): { result: string; sent: boolean; duplicate?: true; refused?: string; refusedCode?: string; offline?: string; held?: string; report?: SyncReport } | null {
    const k: any = this.#db.prepare('SELECT message, room, at FROM send_keys WHERE agent = ? AND client_id = ?').get(agent, clientId);
    if (!k || k.at < this.#now() - SEND_KEY_MS) return null;
    if (k.room !== roomId) throw new ActionError('client_id_used', 'That client_id was already used for a message in another room. Choose a new one for a new message. Nothing was sent or charged.');
    const queued: any = this.#db.prepare('SELECT reason FROM outbox WHERE agent = ? AND id = ?').get(agent, k.message);
    return queued ? { result: k.message, sent: false, duplicate: true, held: queued.reason ?? 'queued' } : { result: k.message, sent: true, duplicate: true };
  }

  /** What the room card and the tools say about a room (§16.24); null for a room this agent holds no events of. */
  roomInfo(agent: string, roomId: string): RoomInfo | null {
    const ctx = this.#load(agent);
    const room = this.#room(ctx, roomId);
    if (room.size === 0) return null;
    const state = room.currentState();
    const members = [...state].filter(([k, ev]) => k.startsWith('room.member|') && ev.header.data.membership === 'join');
    const joinedAt = new Map(members.map(([, ev]) => [ev.header.data.target as string, ev.header.ts as number]));
    const last = this.#db.prepare("SELECT MAX(json_extract(event, '$.header.ts')) AS ts FROM events WHERE agent = ? AND room = ? AND json_extract(outcome, '$.outcome') = 'accepted'").get(agent, roomId) as any;
    return {
      room: roomId,
      type: room.create!.header.data.type,
      mode: modeOf(state),
      role: roleOf(state, ctx.id),
      can: abilities(state, ctx.id),
      members: members.length,
      waiting: waiting(state).sort((a, b) => (joinedAt.get(b) ?? 0) - (joinedAt.get(a) ?? 0)),
      approved: approvedCount(state),
      listed: state.get('room.meta|')?.header.data.listed === true,
      lastEventAt: last?.ts ?? null,
      hidden: this.hiddenIn(agent, roomId),
    };
  }

  // --- Hiding (§16.24.6): on this computer only, never sent ---------------------------

  /** Hides or unhides one message from the window and the agent. */
  hideMessage(agent: string, id: string, hide: boolean): boolean {
    return Number(this.#db.prepare('UPDATE messages SET hidden = ? WHERE agent = ? AND id = ?').run(hide ? 1 : 0, agent, id).changes) > 0;
  }

  /** Hides or unhides every message of an author in one room, later ones included. */
  hideAuthor(agent: string, roomId: string, author: string, hide: boolean) {
    if (hide) this.#db.prepare('INSERT OR IGNORE INTO hidden_authors (agent, room, author, at) VALUES (?, ?, ?, ?)').run(agent, roomId, author, this.#now());
    else this.#db.prepare('DELETE FROM hidden_authors WHERE agent = ? AND room = ? AND author = ?').run(agent, roomId, author);
  }

  /** Trusts or stops trusting a sender (§16.11), by agent ID. Only the person, from the window: no tool reaches it. */
  trustSender(agent: string, author: string, trust: boolean) {
    if (author === agent) throw new ActionError('bad_request', 'An agent cannot trust itself.');
    if (trust) this.#db.prepare('INSERT OR IGNORE INTO trusted_senders (agent, author, at) VALUES (?, ?, ?)').run(agent, author, this.#now());
    else this.#db.prepare('DELETE FROM trusted_senders WHERE agent = ? AND author = ?').run(agent, author);
  }

  /** The senders an agent's person trusts, oldest first. */
  trustedSenders(agent: string): string[] {
    return (this.#db.prepare('SELECT author FROM trusted_senders WHERE agent = ? ORDER BY at').all(agent) as any[]).map((r) => r.author);
  }

  /** Unhides everything in a room. */
  unhideAll(agent: string, roomId: string) {
    tx(this.#db, () => {
      this.#db.prepare('UPDATE messages SET hidden = 0 WHERE agent = ? AND room = ?').run(agent, roomId);
      this.#db.prepare('DELETE FROM hidden_authors WHERE agent = ? AND room = ?').run(agent, roomId);
    });
  }

  /** Of these hint keys (§16.24.4), the ones not given to the agent yet. */
  newHints(agent: string, keys: string[]): string[] {
    const seen = this.#db.prepare('SELECT 1 FROM hints WHERE agent = ? AND key = ?');
    return keys.filter((k) => !seen.get(agent, k));
  }

  /** Records hints as given, so each situation is told once. */
  markHints(agent: string, keys: string[]) {
    const ins = this.#db.prepare('INSERT OR IGNORE INTO hints (agent, key, at) VALUES (?, ?, ?)');
    tx(this.#db, () => keys.forEach((k) => ins.run(agent, k, this.#now())));
  }

  hiddenIn(agent: string, roomId: string): { messages: number; authors: string[] } {
    const authors = (this.#db.prepare('SELECT author FROM hidden_authors WHERE agent = ? AND room = ? ORDER BY at').all(agent, roomId) as any[]).map((r) => r.author);
    const n = (this.#db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.agent = ? AND m.room = ? AND (m.hidden = 1 OR EXISTS
      (SELECT 1 FROM hidden_authors h WHERE h.agent = m.agent AND h.room = m.room AND h.author = m.author))`).get(agent, roomId) as any).n;
    return { messages: n, authors };
  }

  #knownRoom(ctx: Ctx, roomId: string): Room {
    const room = this.#room(ctx, roomId);
    if (room.size === 0) throw new ActionError('unknown_room', 'This agent does not know that room.');
    return room;
  }

  /** Opens or resumes a DM with `peer` (§8.8): joins its invite, or creates the room. */
  async startDm(agent: string, peer: string) {
    const ctx = this.#load(agent);
    if (peer === agent) throw new ActionError('dm_self', 'An agent cannot open a DM with itself.');
    await this.#exclusive(agent, () => this.#ensureBundles(ctx, [peer]));
    const key = dmKey(agent, peer);
    // Of every DM room with this key the agent knows, the lowest room.create ID is canonical (§4.3).
    const known = (this.#db.prepare("SELECT room, status, invite FROM rooms WHERE agent = ? AND type = 'dm'").all(agent) as any[])
      .filter((r) => {
        const create = this.#room(ctx, r.room).create ?? JSON.parse(r.invite ?? 'null')?.state?.find((e: MeadowEvent) => e.header.kind === 'room.create');
        return create?.header.data.dm_key === key;
      })
      .sort((a, b) => (a.room < b.room ? -1 : 1));
    const canonical = known[0];
    if (canonical?.status === 'joined') return { result: canonical.room as string, sent: true };
    if (canonical?.status === 'invited') return this.joinRoom(agent, canonical.room);
    return this.#write(agent, (c) => tx(this.#db, () => {
      const room = this.#create(c, { type: 'dm', dm_with: peer, dm_key: key });
      this.#build(c, room, 'room.member', { data: { target: c.id, membership: 'join' } });
      return room.id as string;
    }));
  }

  /** Posts a message (§5.3, §8.7). In a private room or DM it is encrypted, sharing a new session first when §8.4 says so. */
  async send(agent: string, roomId: string, text: string, opts: { replyTo?: string; report?: Record<string, unknown>; mentions?: string[]; clientId?: string } = {}) {
    // An idempotency key (§16.7.4): a repeat answers the first message, writing and paying nothing.
    if (opts.clientId !== undefined) {
      if (typeof opts.clientId !== 'string' || !CLIENT_ID.test(opts.clientId)) {
        throw new ActionError('bad_request', 'client_id is 1 to 128 letters, digits, or . _ : - characters. Nothing was sent or charged.');
      }
      const prior = this.#sendKey(agent, opts.clientId, roomId);
      if (prior) return prior;
    }
    // A reply names a message this agent holds in this same room (a tester replied to one from
    // another room, and to a made-up ID, 2026-10-02). Checked here, free, before anything is built.
    if (opts.replyTo !== undefined) {
      const target = this.#db.prepare('SELECT room FROM messages WHERE agent = ? AND id = ?').get(agent, opts.replyTo) as { room: string } | undefined;
      if (!target) throw new ActionError('unknown_reply', 'reply_to must be a message this agent has read in this room, and that ID is not one it holds. Nothing was sent or charged.');
      if (target.room !== roomId) throw new ActionError('unknown_reply', 'reply_to names a message in another room. A reply can only answer a message in the same room. Nothing was sent or charged.');
    }
    const keyed = (id: string) => {
      if (opts.clientId === undefined) return;
      this.#db.prepare('DELETE FROM send_keys WHERE agent = ? AND at < ?').run(agent, this.#now() - SEND_KEY_MS);
      this.#db.prepare('INSERT OR IGNORE INTO send_keys (agent, client_id, message, room, at) VALUES (?, ?, ?, ?, ?)').run(agent, opts.clientId, id, roomId, this.#now());
    };
    return this.#write(agent, async (ctx) => {
      const room = this.#knownRoom(ctx, roomId);
      const type = room.create!.header.data.type;
      const body: InnerBody = { text, ...(opts.replyTo && { reply_to: opts.replyTo }), ...(opts.report && { report: opts.report }) };
      if (type === 'public') {
        return tx(this.#db, () => {
          // Mentions ride in the header only in public rooms (§5.2, §6.5 rule 3; §16.20.1).
          const mentions = [...new Set(opts.mentions ?? [])].filter((id) => /^a_[A-Za-z0-9_-]{43}$/.test(id) && id !== ctx.id).slice(0, MAX_MENTIONS);
          const ev = this.#build(ctx, room, 'msg.post', { content: JSON.stringify(body), ...(mentions.length && { mentions }) });
          this.#storeMessage(ctx, ev, { status: 'shown', body }, true);
          keyed(ev.id);
          return ev.id;
        });
      }
      const to = recipients(room.stateAt(room.heads()), ctx.id);
      // Bundles first, so a session is never started and then left unshared.
      await this.#ensureBundles(ctx, [...to].filter((p) => !ctx.crypto.hasOlmSession(p)));
      return tx(this.#db, () => {
        const { s, fresh } = ctx.crypto.currentSession(roomId, to);
        if (fresh && s.recipients.size) {
          for (const content of ctx.crypto.shareContents(roomId, s, s.recipients, (p) => this.#bundle(ctx, p))) {
            this.#build(ctx, room, 'room.keys', { content });
          }
        }
        const enc = ctx.crypto.encryptPost(roomId, s, body);
        const ev = this.#build(ctx, room, 'msg.post', { content: enc.content, commitment: enc.commitment });
        ctx.crypto.recordOwnMessage(roomId, s, enc.index, ev.id);
        this.#storeMessage(ctx, ev, { status: 'shown', body, kf: enc.kf, session: s.gs.sessionId, index: enc.index }, true);
        keyed(ev.id);
        return ev.id;
      });
    });
  }

  /** Reads a room from the network (a paid sync naming it), without joining (§7.2). */
  /**
   * Reads a public room once without joining it (§16.7.4 preview_room): one
   * sync naming it with no heads. A room this agent did not already follow is
   * left as `previewed`, so later syncs do not read it again.
   */
  async preview(agent: string, roomId: string): Promise<{ report: SyncReport; type: string | null }> {
    const existed = !!this.#roomRow(agent, roomId);
    const report = await this.read(agent, roomId);
    const row = this.#roomRow(agent, roomId);
    // The type from the room's own create event: a row records it only once the agent's membership changes.
    const type = this.#room(this.#load(agent), roomId).create?.header.data.type ?? row?.type ?? null;
    if (!existed && row?.status === 'reading') this.#setRoom(agent, roomId, { status: 'previewed', ...(type && { type }) });
    return { report, type };
  }

  /**
   * Pending invitations as the sync delivered them (§7.2): the room's name and
   * topic (its room.meta), its member count, who sent it, and, on the
   * invitation itself, the sender's note and its claim of how it was sent
   * (format 3). All of it is the node's and the sender's word, for the agent to
   * decide with; the join is checked by the room like any event.
   */
  invites(agent: string): { room: string; type: string | null; from: string | null; members: number | null; name?: string; topic?: string; note?: string; origin?: string }[] {
    return (this.#db.prepare("SELECT room, type, invite FROM rooms WHERE agent = ? AND status = 'invited' ORDER BY updated_at DESC").all(agent) as any[]).map((r) => {
      let inv: any = {};
      try {
        inv = JSON.parse(r.invite ?? '{}');
      } catch {}
      const state: any[] = Array.isArray(inv.state) ? inv.state : [];
      const meta = state.find((e) => e?.header?.kind === 'room.meta')?.header?.data ?? {};
      const own = state.find((e) => e?.header?.kind === 'room.member' && e.header.data?.target === agent)?.header?.data ?? {};
      const str = (x: unknown) => (typeof x === 'string' && x.length ? x : undefined);
      const out: any = {
        room: r.room, type: r.type ?? inv.type ?? null,
        from: AGENT_ID.test(inv.from ?? '') ? inv.from : null,
        members: Number.isSafeInteger(inv.members) ? inv.members : null,
      };
      for (const [k, v] of [['name', str(meta.name)], ['topic', str(meta.topic)], ['note', str(own.reason)], ['origin', ['manual', 'automatic'].includes(own.origin) ? own.origin : undefined]] as const) {
        if (v !== undefined) out[k] = v;
      }
      return out;
    });
  }

  /** Whether this agent's own profile says it is discoverable (§5.4): true, false, or null before it registered. */
  discoverable(agent: string): boolean | null {
    const ctx = this.#load(agent);
    const head = ctx.log.head(agent);
    return head ? head.state.discoverable === true : null;
  }

  async read(agent: string, roomId: string): Promise<SyncReport> {
    return this.#exclusive(agent, async () => {
      const ctx = this.#load(agent);
      if (!this.#roomRow(agent, roomId)) this.#setRoom(agent, roomId, { status: 'reading' });
      return this.#sync(ctx);
    });
  }

  // --- Peers and bundles (§8.2) ---------------------------------------------------------

  #bundle(ctx: Ctx, peer: string): Bundle | undefined {
    const r: any = this.#db.prepare('SELECT curve25519, fallback FROM peers WHERE agent = ? AND peer = ?').get(ctx.id, peer);
    return r ? { curve25519: vodozemacKey(r.curve25519), fallback: vodozemacKey(r.fallback) } : undefined;
  }

  /** Fetches and verifies the chains of peers with no known bundle: a paid lookup each (§7.3). */
  async #ensureBundles(ctx: Ctx, peers: string[]) {
    for (const peer of peers) {
      if (this.#bundle(ctx, peer)) continue;
      const res = await this.#transport.call('/v2/lookup', { agent_id: peer, chain: true }, ctx.id);
      const profile = res.data?.agents?.[0];
      if (res.status !== 200 || !profile) throw new ActionError('unknown_agent', `No agent ${peer} was found on the network.`);
      this.#acceptChain(ctx, peer, profile);
    }
  }

  /**
   * Verifies a looked-up chain (§7.3): every event checks out from
   * agent.register to the head, and the head's state gives the keys. The
   * served keys are not trusted on their own.
   */
  #acceptChain(ctx: Ctx, peer: string, profile: any) {
    const log = new AgentLog();
    for (const ev of profile.chain ?? []) {
      if (ev?.header?.author !== peer || log.add(ev).outcome !== 'accepted') throw new ActionError('bad_chain', `The network served an invalid key history for ${peer}.`);
    }
    const head = log.head(peer);
    if (!head) throw new ActionError('bad_chain', `The network served no key history for ${peer}.`);
    const keys = head.state.keys;
    tx(this.#db, () => {
      this.#db.prepare(`INSERT OR REPLACE INTO peers (agent, peer, name, curve25519, fallback, head, chain, verified_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ctx.id, peer, head.state.name, keys.curve25519, keys.fallback, head.id, JSON.stringify(profile.chain), this.#now());
    });
    for (const ev of profile.chain) ctx.log.add(ev);
    // Interacting with an agent pins its handle to its ID (§3.2).
    this.#pin(ctx.id, handleOf(peer, head.state.name), peer);
  }

  // --- Sync (§7.2, §16.8) -------------------------------------------------------------------

  async sync(agent: string): Promise<SyncReport> {
    return this.#exclusive(agent, () => this.#sync(this.#load(agent)));
  }

  /** The heads to send: every room being read or joined, as the agent's graph has it minus unsent events. */
  #heads(ctx: Ctx): Record<string, string[]> {
    const unsent = new Set((this.#db.prepare('SELECT id FROM outbox WHERE agent = ?').all(ctx.id) as any[]).map((r) => r.id));
    const out: Record<string, string[]> = {};
    for (const r of this.#db.prepare("SELECT room FROM rooms WHERE agent = ? AND status IN ('joined', 'reading')").all(ctx.id) as any[]) {
      const room = this.#room(ctx, r.room);
      const heads = new Set<string>();
      const stack = [...room.heads()];
      while (stack.length) {
        const id = stack.pop()!;
        if (!unsent.has(id)) heads.add(id);
        else stack.push(...room.event(id).header.parents);
      }
      out[r.room] = [...heads].sort().slice(-20);
    }
    return out;
  }

  /** The queued events the agent's setting lets go, in order (§16.7.5). */
  #sendable(agent: string): { id: string; event: string }[] {
    const may = this.may(agent);
    const rows = this.#db.prepare('SELECT id, event FROM outbox WHERE agent = ? ORDER BY seq').all(agent) as any[];
    return may === 'all' ? rows : rows.filter((r) => outboxAllowed(may, agent, JSON.parse(r.event)));
  }

  /** How many queued events the agent's setting is holding back (§16.10.3). */
  heldBySetting(agent: string): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE agent = ?').get(agent) as any).n - this.#sendable(agent).length;
  }

  /** What the agent may do (§16.7.5). */
  may(agent: string): May {
    const m = (this.#db.prepare('SELECT may FROM agents WHERE id = ?').get(agent) as any)?.may;
    return MAY.includes(m) ? m : 'all';
  }

  /** Sets what the agent may do; only the window calls this (§16.7.5). */
  setMay(agent: string, may: May) {
    if (!MAY.includes(may)) throw new ActionError('bad_request', 'Unknown setting.');
    this.#db.prepare('UPDATE agents SET may = ? WHERE id = ?').run(may, agent);
  }

  /** A room's local settings (§16.10.2); they never touch updated_at, which the backup nudge reads. */
  setRoomSettings(agent: string, room: string, s: { guard?: RoomGuard; notify?: RoomNotify }) {
    if (s.guard !== undefined && !['default', 'always', 'never'].includes(s.guard)) throw new ActionError('bad_request', 'Unknown MessageGuard setting.');
    if (s.notify !== undefined && !['normal', 'priority', 'muted'].includes(s.notify)) throw new ActionError('bad_request', 'Unknown notification setting.');
    if (!this.#roomRow(agent, room)) throw new ActionError('unknown_room', 'This agent does not know that room.');
    if (s.guard !== undefined) this.#db.prepare('UPDATE rooms SET guard_mode = ? WHERE agent = ? AND room = ?').run(s.guard, agent, room);
    if (s.notify !== undefined) this.#db.prepare('UPDATE rooms SET notify = ? WHERE agent = ? AND room = ?').run(s.notify, agent, room);
  }

  /** An agent ID, from an ID or a handle this computer already knows; null otherwise. Never a paid lookup. */
  knownAgent(agent: string, who: string): string | null {
    if (/^a_[A-Za-z0-9_-]{43}$/.test(who)) return who;
    const pinned = this.#pinned(agent, who);
    if (pinned) return pinned;
    return (this.#db.prepare('SELECT peer FROM peers WHERE agent = ? UNION SELECT peer FROM author_names WHERE agent = ?').all(agent, agent) as any[])
      .map((r) => r.peer as string).find((p) => this.handleOf(agent, p) === who) ?? null;
  }

  /**
   * The DM this agent has already joined with `who` (an agent ID or a handle), found
   * on this computer only, with no paid lookup; null if there is none (§16.7.5).
   */
  joinedDmWith(agent: string, who: string): string | null {
    const peer = this.knownAgent(agent, who);
    if (!peer) return null;
    return this.rooms(agent).find((r) => r.type === 'dm' && r.status === 'joined' && r.dmWith === peer)?.room ?? null;
  }

  async #sync(ctx: Ctx): Promise<SyncReport> {
    try {
      return await this.#syncPages(ctx);
    } catch (err) {
      this.#onSyncError?.(ctx.id, err);
      throw err;
    }
  }

  /** One page's request for an agent (§7.2): its heads, the queued events its setting lets go, and the chains to ask for. */
  #page(ctx: Ctx): { fields: any; rows: number; total: number; ask: string[]; before: string } {
    // Events the agent's setting holds back stay queued, unsent (§16.7.5).
    const sendable = this.#sendable(ctx.id);
    const rows = sendable.slice(0, SYNC.outbox);
    const heads = this.#heads(ctx);
    const fields: any = { heads };
    if (rows.length) fields.outbox = rows.map((r) => JSON.parse(r.event));
    // Chains to verify the names nodes gave (§16.8), only where the network takes `agents` (§7.2).
    const ask = this.protocol3(ctx.id) ? this.#chainsToAsk(ctx) : [];
    if (ask.length) fields.agents = ask;
    return { fields, rows: rows.length, total: sendable.length, ask, before: JSON.stringify(heads) };
  }

  /** Marks the chains a sync asked for as asked (§16.8), once the network answered. */
  #asked(ctx: Ctx, ask: string[]) {
    if (!ask.length) return;
    const mark = this.#db.prepare('UPDATE author_names SET asked_at = ? WHERE agent = ? AND peer = ?');
    const backfilled = this.#db.prepare(`INSERT INTO name_backfill (agent, peer, asked_at) SELECT ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM author_names WHERE agent = ? AND peer = ?)
      ON CONFLICT (agent, peer) DO UPDATE SET asked_at = excluded.asked_at`);
    tx(this.#db, () => {
      for (const peer of ask) {
        mark.run(this.#now(), ctx.id, peer);
        backfilled.run(ctx.id, peer, this.#now(), ctx.id, peer);
      }
    });
  }

  /**
   * Takes one sync answer for an agent, single or an entry of a batch, and says whether the agent
   * needs another page: the node said more, events wait for the next call, or events stayed queued.
   */
  async #takePage(ctx: Ctx, data: any, page: { rows: number; total: number; before: string }, report: SyncReport): Promise<boolean> {
    await this.#ingestSync(ctx, data, report);
    const waiting = (data.pending ?? []).some((p: any) => p.reason === 'create_limit' || p.reason === 'batch_limit');
    if (!data.more && !waiting && page.total <= page.rows) return false;
    // Every page is paid: a page that sent nothing and brought nothing new ends the sync (a node saying "more" forever would drain the budget).
    if (!page.rows && JSON.stringify(this.#heads(ctx)) === page.before && !(data.invites ?? []).length) {
      this.#problem(ctx.id, 'sync', 'A node said more was waiting but sent nothing new; the sync stopped to save money.');
      return false;
    }
    return true;
  }

  async #syncPages(ctx: Ctx): Promise<SyncReport> {
    const report: SyncReport = { calls: 0, accepted: [], rejected: [], pending: [], invites: 0, messages: 0 };
    for (let page = 0; page < SYNC.maxPages; page++) {
      const p = this.#page(ctx);
      const { fields, ask } = p;
      fields.limit_bytes = SYNC.limitBytes;
      let res;
      try {
        res = await this.#transport.call('/v2/sync', signRequest(this.#signer(ctx.id), fields), ctx.id);
        // A node before 0.3.0 refuses `agents` as unknown: send again without it, and leave it out for an hour.
        const e = res.data?.error;
        if (ask.length && res.status === 400 && e?.code === 'bad_request' && /\bagents\b/.test(e?.message ?? '')) {
          this.#setMeta('agents_off_until', String(this.#now() + AUTHORS.agentsOffMs));
          report.calls++;
          delete fields.agents;
          ask.length = 0;
          res = await this.#transport.call('/v2/sync', signRequest(this.#signer(ctx.id), fields), ctx.id);
        }
      } catch (err) {
        if (report.calls === 0) throw err;
        report.stopped = err instanceof Error ? err.message : String(err);
        break;
      }
      report.calls++;
      if (res.status === 200) this.#asked(ctx, ask);
      if (res.status !== 200) {
        const e = res.data?.error;
        throw new ActionError(e?.code ?? 'sync_failed', `The network refused the sync: ${e?.message ?? res.status}.`);
      }
      if (!(await this.#takePage(ctx, res.data, p, report))) break;
    }
    tx(this.#db, () => this.#housekeeping(ctx));
    if (this.#afterSync) await this.#afterSync(ctx.id, report);
    return report;
  }

  // --- Combined syncs (§7.9, §16.8) ---------------------------------------------------------

  /** Whether combined syncs are off for now: a node or the portal did not know the route. */
  batchOff(): boolean {
    return Number(this.#meta('batch_off_until') ?? 0) > this.#now();
  }

  /**
   * Syncs up to 8 agents with one paid call per page (§7.9), paid as the first agent: the caller
   * groups agents that one payer pays for. Each agent's answer is taken exactly as its own sync's
   * would be, and each fails or succeeds on its own. Runs inside every agent's lock, taken in a
   * fixed order so two combined syncs never wait on each other. With one agent, or while combined
   * syncs are off, each agent syncs on its own.
   */
  async syncMany(agents: string[]): Promise<Map<string, SyncReport | Error>> {
    const ids = [...new Set(agents)];
    if (ids.length > SYNC.batch) throw new ActionError('bad_request', `At most ${SYNC.batch} agents sync in one call.`);
    const out = new Map<string, SyncReport | Error>();
    if (ids.length <= 1 || this.batchOff()) {
      for (const id of ids) out.set(id, await this.sync(id).catch((err) => (err instanceof Error ? err : new Error(String(err)))));
      return out;
    }
    const payer = ids[0];
    const ordered = [...ids].sort();
    const locked = ordered.reduceRight<() => Promise<void>>((inner, id) => () => this.#exclusive(id, inner), () => this.#syncBatch(ids.map((id) => this.#load(id)), payer, out));
    await locked();
    return out;
  }

  async #syncBatch(ctxs: Ctx[], payer: string, out: Map<string, SyncReport | Error>): Promise<void> {
    const reports = new Map(ctxs.map((c) => [c.id, { calls: 0, accepted: [], rejected: [], pending: [], invites: 0, messages: 0 } as SyncReport]));
    const fail = (ctx: Ctx, err: Error) => {
      out.set(ctx.id, err);
      this.#onSyncError?.(ctx.id, err);
    };
    let active = ctxs;
    const served = new Set<string>();
    for (let page = 0; page < SYNC.maxPages && active.length; page++) {
      const pages = new Map(active.map((c) => [c.id, this.#page(c)]));
      const body = { syncs: active.map((c) => signRequest(this.#signer(c.id), pages.get(c.id)!.fields)), limit_bytes: SYNC.limitBytes };
      let res;
      try {
        res = await this.#transport.call('/v2/sync-batch', body, payer);
      } catch (err) {
        // Nothing was answered: an agent that had no page yet fails; one that had stops where it got to.
        for (const c of active) {
          const r = reports.get(c.id)!;
          if (r.calls === 0) fail(c, err instanceof Error ? err : new Error(String(err)));
          else r.stopped = err instanceof Error ? err.message : String(err);
        }
        active = [];
        break;
      }
      for (const c of active) reports.get(c.id)!.calls++;
      const e = res.data?.error;
      // A node before 0.4.0, or a portal that does not offer the route: single syncs for an hour (§7.9).
      if (res.status === 404 || res.status === 405 || (res.status === 400 && e?.code === 'bad_request' && /sync-batch|\bsyncs\b/.test(e?.message ?? ''))) {
        this.#setMeta('batch_off_until', String(this.#now() + SYNC.batchOffMs));
        this.#problem(null, 'sync', 'The network does not take combined syncs yet, so each agent syncs on its own for the next hour.');
        for (const c of active) {
          const r = await this.#sync(c).catch((err) => (err instanceof Error ? err : new Error(String(err))));
          out.set(c.id, r);
          if (!(r instanceof Error)) reports.delete(c.id);
        }
        // Those syncs ran their own housekeeping and afterSync.
        for (const c of active) if (out.get(c.id) instanceof Error) reports.delete(c.id);
        active = [];
        break;
      }
      const entries = res.status === 200 && Array.isArray(res.data?.syncs) ? res.data.syncs : null;
      if (!entries) {
        for (const c of active) fail(c, new ActionError(e?.code ?? 'sync_failed', `The network refused the sync: ${e?.message ?? res.status}.`));
        active = [];
        break;
      }
      const byAgent = new Map<string, any>();
      for (const x of entries) if (x && typeof x === 'object' && typeof x.agent === 'string' && !byAgent.has(x.agent)) byAgent.set(x.agent, x);
      const next: Ctx[] = [];
      // The node serves the first entry of every call (§7.9): a call that served none is a node
      // that will never answer, and every page is paid (security review A2, as F6 for one agent).
      if (![...byAgent.values()].some((x) => active.some((c) => c.id === x.agent) && x.deferred !== true)) {
        this.#problem(null, 'sync', 'A node put off every agent in a combined sync; the sync stopped to save money.');
        for (const c of active) {
          const r = reports.get(c.id)!;
          if (served.has(c.id)) r.stopped = 'The node put off the rest of this sync.';
          else fail(c, new ActionError('sync_failed', 'The network put off this agent\'s sync and sent nothing.'));
        }
        active = [];
        break;
      }
      for (const c of active) {
        const x = byAgent.get(c.id);
        if (!x) {
          fail(c, new ActionError('sync_failed', 'The network answered the combined sync without this agent.'));
          continue;
        }
        // Not reached in this call (the answer's size): nothing of it was processed; it goes again.
        if (x.deferred === true) {
          next.push(c);
          continue;
        }
        if (x.failed) {
          fail(c, new ActionError(typeof x.failed.code === 'string' ? x.failed.code : 'sync_failed', `The network refused the sync: ${String(x.failed.message ?? x.failed.code)}.`));
          continue;
        }
        const p = pages.get(c.id)!;
        served.add(c.id);
        this.#asked(c, p.ask);
        const { agent: _agent, ...data } = x;
        try {
          if (await this.#takePage(c, { ...data, node: res.data.node }, p, reports.get(c.id)!)) next.push(c);
        } catch (err) {
          fail(c, err instanceof Error ? err : new Error(String(err)));
        }
      }
      active = next;
    }
    const done = new Map<string, SyncReport>();
    for (const c of ctxs) {
      const r = reports.get(c.id);
      if (!r || out.get(c.id) instanceof Error) continue;
      tx(this.#db, () => this.#housekeeping(c));
      out.set(c.id, r);
      done.set(c.id, r);
    }
    if (!done.size) return;
    if (this.#afterSyncMany) await this.#afterSyncMany(done);
    else for (const [id, r] of done) if (this.#afterSync) await this.#afterSync(id, r);
  }

  /** Authors whose chain to ask for (§16.8): no verified chain, or the head moved; each at most once a day. */
  #chainsToAsk(ctx: Ctx): string[] {
    const since = this.#now() - AUTHORS.askEveryMs;
    const named = (this.#db.prepare(`SELECT a.peer FROM author_names a LEFT JOIN peers p ON p.agent = a.agent AND p.peer = a.peer
      WHERE a.agent = ? AND a.too_large = 0 AND (p.peer IS NULL OR p.head IS NULL OR p.head != a.head)
        AND (a.asked_at IS NULL OR a.asked_at < ?)
      ORDER BY a.seen_at DESC LIMIT ?`).all(ctx.id, since, AUTHORS.chainsPerSync) as any[]).map((r) => r.peer as string);
    const room = AUTHORS.chainsPerSync - named.length;
    if (room <= 0) return named;
    // Backfill (§16.8): authors of stored messages no node ever named, newest first. Their
    // messages never come back in a sync, so they would otherwise stay unnamed for good.
    const nameless = (this.#db.prepare(`SELECT m.author AS peer, MAX(m.ts) AS last FROM messages m
      LEFT JOIN peers p ON p.agent = m.agent AND p.peer = m.author
      LEFT JOIN author_names a ON a.agent = m.agent AND a.peer = m.author
      LEFT JOIN name_backfill b ON b.agent = m.agent AND b.peer = m.author
      WHERE m.agent = ? AND m.author != ? AND p.peer IS NULL AND a.peer IS NULL
        AND NOT EXISTS (SELECT 1 FROM pins x WHERE x.agent = m.agent AND x.peer = m.author)
        AND (b.peer IS NULL OR (b.too_large = 0 AND b.asked_at < ?))
      GROUP BY m.author ORDER BY last DESC LIMIT ?`).all(ctx.id, ctx.id, since, room) as any[]).map((r) => r.peer as string);
    return [...named, ...nameless.filter((p) => AGENT_ID.test(p))];
  }

  /**
   * A sync answer's names and chains (§7.2, §16.8). Names are kept as the
   * node's word; chains are verified like a lookup's and, when they verify,
   * replace the word, pin the handle, and give the agent's keys.
   */
  #ingestNames(ctx: Ctx, data: any) {
    if (data.authors && typeof data.authors === 'object' && !Array.isArray(data.authors)) {
      this.#setMeta('authors_seen', String(this.#now()));
      const up = this.#db.prepare(`INSERT INTO author_names (agent, peer, name, head, node, seen_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (agent, peer) DO UPDATE SET name = excluded.name, head = excluded.head, node = excluded.node, seen_at = excluded.seen_at,
          too_large = CASE WHEN author_names.head = excluded.head THEN author_names.too_large ELSE 0 END`);
      for (const [peer, a] of Object.entries<any>(data.authors)) {
        if (peer === ctx.id || !AGENT_ID.test(peer) || typeof a?.name !== 'string' || !NAME.test(a.name) || typeof a.head !== 'string') continue;
        up.run(ctx.id, peer, a.name, a.head, typeof data.node === 'string' ? data.node : null, this.#now());
      }
    }
    const chains = data.chains;
    if (!chains || typeof chains !== 'object' || Array.isArray(chains)) return;
    for (const [peer, v] of Object.entries<any>(chains)) {
      if (peer === ctx.id || !AGENT_ID.test(peer)) continue;
      if (v && !Array.isArray(v) && v.chain_too_large === true) {
        this.#db.prepare('UPDATE author_names SET too_large = 1 WHERE agent = ? AND peer = ?').run(ctx.id, peer);
        this.#db.prepare('UPDATE name_backfill SET too_large = 1 WHERE agent = ? AND peer = ?').run(ctx.id, peer);
        continue;
      }
      if (!Array.isArray(v)) continue;
      try {
        this.#acceptChain(ctx, peer, { chain: v });
      } catch {
        this.#problem(ctx.id, 'names', `A node sent a key history for ${peer} that does not verify. The name it gave stays unverified.`);
        continue;
      }
      const verified: any = this.#db.prepare('SELECT name, head FROM peers WHERE agent = ? AND peer = ?').get(ctx.id, peer);
      const claimed: any = this.#db.prepare('SELECT name, node FROM author_names WHERE agent = ? AND peer = ?').get(ctx.id, peer);
      if (claimed && verified?.name && claimed.name !== verified.name) {
        this.#problem(ctx.id, 'names', `A node${claimed.node ? ` (${claimed.node})` : ''} named ${peer} "${claimed.name}", but its signed history says "${verified.name}". The signed name is shown.`);
      }
    }
  }

  async #ingestSync(ctx: Ctx, data: any, report: SyncReport) {
    const received: Received[] = [];
    try {
      await this.#ingestSyncInner(ctx, data, report, received);
    } finally {
      // Told after the database holds them, so the log can name the room.
      for (const r of received) this.#onReceived?.(ctx.id, r);
    }
  }

  async #ingestSyncInner(ctx: Ctx, data: any, report: SyncReport, received: Received[]) {
    const node = typeof data.node === 'string' ? data.node : null;
    this.watch.heard(node);
    tx(this.#db, () => this.#ingestNames(ctx, data));
    tx(this.#db, () => {
      const delivered: { id: string; room: string }[] = [];
      for (const id of data.accepted ?? []) {
        const row: any = this.#db.prepare('SELECT kind, room FROM outbox WHERE agent = ? AND id = ?').get(ctx.id, id);
        if (row?.room && !String(row.kind).startsWith('agent.')) delivered.push({ id, room: row.room });
        if (row?.kind === 'agent.register') this.#db.prepare('UPDATE agents SET registered_at = COALESCE(registered_at, ?) WHERE id = ?').run(this.#now(), ctx.id);
        this.#db.prepare('DELETE FROM outbox WHERE agent = ? AND id = ?').run(ctx.id, id);
        report.accepted.push(id);
      }
      if (node && delivered.length) this.watch.accepted(ctx.id, node, delivered);
      for (const r of data.rejected ?? []) {
        const row: any = this.#db.prepare('SELECT kind FROM outbox WHERE agent = ? AND id = ?').get(ctx.id, r.id);
        this.#db.prepare('DELETE FROM outbox WHERE agent = ? AND id = ?').run(ctx.id, r.id);
        const own = String(row?.kind ?? '').startsWith('agent.') && this.#rollbackOwn(ctx.id, r.id);
        this.#problem(ctx.id, 'rejected', refusalWords(row?.kind, r.reason, own));
        report.rejected.push({ id: r.id, reason: r.reason });
      }
      for (const p of data.pending ?? []) {
        this.#db.prepare('UPDATE outbox SET reason = ? WHERE agent = ? AND id = ?').run(p.reason ?? 'missing', ctx.id, p.id);
        report.pending.push({ id: p.id, reason: p.reason });
      }
      for (const inv of data.invites ?? []) {
        const row = this.#roomRow(ctx.id, inv.room);
        if (row && ['joined', 'banned'].includes(row.status)) continue;
        this.#setRoom(ctx.id, inv.room, { status: 'invited', type: inv.type, invite: inv });
        report.invites++;
        if (row?.status !== 'invited') received.push({ type: 'invite', room: inv.room });
      }
    });
    for (const [roomId, entry] of Object.entries<any>(data.rooms ?? {})) {
      if (entry.expired) {
        if (this.#roomRow(ctx.id, roomId)?.status !== 'expired') received.push({ type: 'expired', room: roomId });
        tx(this.#db, () => this.#setRoom(ctx.id, roomId, { status: 'expired' }));
      } else if (entry.readable === false) {
        // How a removed member learns of its removal (§7.2). A node's word is not
        // enough: the room is marked removed only when a signed membership event,
        // validated in the agent's own room, says so.
        const room = this.#room(ctx, roomId);
        if (entry.membership && room.size > 0) countNew(report, roomId, await this.ingestRoomEvents(ctx.id, roomId, [entry.membership]));
        const proved = room.size > 0 && ['leave', 'ban'].includes(membershipOf(room.currentState(), ctx.id));
        const row = this.#roomRow(ctx.id, roomId);
        if (proved && (row?.status === 'joined' || row?.status === 'reading')) {
          tx(this.#db, () => this.#setRoom(ctx.id, roomId, { status: 'removed' }));
          const m = room.currentState().get(`room.member|${ctx.id}`)?.header;
          // Its own leave, from another copy, is not something the network did to it.
          if (m && m.author !== ctx.id) received.push({ type: 'removed', room: roomId, by: m.author, ban: m.data.membership === 'ban', ...(typeof m.data.reason === 'string' && { reason: m.data.reason }) });
        }
        else if (!proved) this.#problem(ctx.id, 'sync', `A node said this agent can no longer read room ${roomId}, without a signed removal; the room is kept.`);
      } else if (entry.events?.length) {
        countNew(report, roomId, await this.ingestRoomEvents(ctx.id, roomId, entry.events));
      }
    }
    // Watching the nodes (§16.23): what this node served, and what it attests holding.
    if (node) {
      const served = new Map<string, Set<string>>();
      for (const [roomId, entry] of Object.entries<any>(data.rooms ?? {})) {
        if (Array.isArray(entry?.events)) served.set(roomId, new Set(entry.events.map((e: any) => e?.id).filter((x: unknown) => typeof x === 'string')));
      }
      const ok = this.watch.observe(ctx.id, node, served, data.attestation, (roomId) => {
        const room = this.#room(ctx, roomId);
        return room.size > 0 ? room : null;
      });
      if (!ok) this.#problem(ctx.id, 'nodes', ATTESTATION_BROKEN);
      this.watch.notices(ctx.id);
    }
  }

  /**
   * Applies events served for one room (§7.2): each is validated by the
   * agent's own room, stored, and, if accepted and not soft-failed, delivered
   * as state, keys, or a message. Returns how many new messages from others
   * it produced. Used by sync, and by the conformance tests.
   */
  async ingestRoomEvents(agent: string, roomId: string, served: any[]): Promise<number> {
    const ctx = this.#load(agent);
    const room = this.#room(ctx, roomId);
    const fresh: { ev: MeadowEvent; outcome: any; repaired: boolean }[] = [];
    let queue = served.filter((e) => e && typeof e === 'object');
    for (let pass = 0; pass < 3 && queue.length; pass++) {
      const next = [];
      for (const raw of queue) {
        const ev = clean(raw);
        if (room.has(ev.id)) {
          // Content that arrives after the header (§11.3 repair) is stored and delivered now.
          const stored: any = this.#db.prepare('SELECT content, withheld FROM events WHERE agent = ? AND id = ?').get(ctx.id, ev.id);
          if (ev.content !== undefined && stored && stored.content === null && ev.header.content_hash) {
            const r = room.outcome(ev.id);
            this.#db.prepare('UPDATE events SET content = ?, withheld = NULL WHERE agent = ? AND id = ?').run(ev.content, ctx.id, ev.id);
            fresh.push({ ev, outcome: r, repaired: true });
          }
          continue;
        }
        const r = room.add(ev);
        if (r.outcome === 'pending') {
          next.push(raw);
          continue;
        }
        if (r.outcome === 'discarded') {
          this.#problem(ctx.id, 'discarded', `A node served an invalid event in ${roomId} (${r.reason}); it was ignored.`);
          continue;
        }
        this.#storeEvent(ctx, roomId, ev, r, ev.content === undefined ? raw.withheld : undefined);
        fresh.push({ ev, outcome: r, repaired: false });
      }
      queue = next;
    }
    if (queue.length) this.#problem(ctx.id, 'pending', `${queue.length} event(s) in ${roomId} are waiting for events the node did not send.`);

    let messages = 0;
    const slots = new Set<string>();
    for (const { ev, outcome, repaired } of fresh) {
      if (outcome.outcome !== 'accepted') continue;
      messages += await this.#deliver(ctx, room, ev, outcome, repaired, slots);
    }
    if (slots.size) tx(this.#db, () => this.#settleSlots(ctx, slots));
    return messages;
  }

  async #deliver(ctx: Ctx, room: Room, ev: MeadowEvent, outcome: any, repaired: boolean, slots: Set<string>): Promise<number> {
    const h = ev.header;
    const type = room.create?.header.data.type;
    if (!repaired && h.kind === 'room.member' && h.data.target === ctx.id) {
      const m = h.data.membership;
      const status = m === 'join' ? 'joined' : m === 'invite' ? null : m === 'ban' ? 'banned' : h.author === ctx.id ? 'left' : 'removed';
      const was = this.#roomRow(ctx.id, room.id)?.status;
      tx(this.#db, () => this.#setRoom(ctx.id, room.id, { type, ...(status && { status }), ...(status === 'joined' && { invite: null }) }));
      // Removed or banned by another member: something the network did to the agent (§16.18.1).
      if ((status === 'removed' || status === 'banned') && h.author !== ctx.id && was !== status) {
        this.#onReceived?.(ctx.id, { type: 'removed', room: room.id, by: h.author, ban: m === 'ban', ...(typeof h.data.reason === 'string' && { reason: h.data.reason }) });
      }
    }
    if (h.author === ctx.id) {
      this.#ownFromElsewhere(ctx, type, ev, outcome, slots);
      return 0;
    }
    // Keys go to §8's own checks even when soft-failed: a conforming node serves those without
    // content, but if one arrives with it, entitlement (§8.6) is what refuses it, not arrival order.
    if (h.kind === 'room.keys' && type !== 'public') {
      await this.#receiveKeys(ctx, room, ev, slots);
      return 0;
    }
    // Soft-failed events are valid but never delivered (§6.6).
    if (outcome.soft_failed) return 0;
    if (h.kind === 'room.power' && !repaired) {
      this.#powerChanged(ctx, room, ev);
      return 0;
    }
    if (h.kind === 'msg.delete' && !repaired) {
      if (room.deletionEffect(ev)) {
        tx(this.#db, () => this.#db.prepare("UPDATE messages SET status = 'deleted', body_sealed = NULL WHERE agent = ? AND id = ?").run(ctx.id, h.data.target));
      }
      return 0;
    }
    if (h.kind !== 'msg.post') return 0;
    const existing: any = this.#db.prepare('SELECT status FROM messages WHERE agent = ? AND id = ?').get(ctx.id, ev.id);
    if (existing && !(repaired && existing.status === 'withheld')) return 0;
    const withheld = ev.content === undefined;
    tx(this.#db, () => {
      if (withheld) this.#storeMessage(ctx, ev, { status: 'withheld' });
      else if (type === 'public') {
        const body = parsePublic(ev.content!);
        this.#storeMessage(ctx, ev, body ? { status: 'shown', body } : { status: 'unsupported' });
      } else this.#decryptInto(ctx, ev, slots);
    });
    if (existing) return 0;
    // Written before this agent was a recipient: it can never be read (§8.6), so it is not news.
    const stored: any = this.#db.prepare('SELECT status FROM messages WHERE agent = ? AND id = ?').get(ctx.id, ev.id);
    return stored?.status === 'missing_key' && this.#preJoin(ctx, room.id, ev.id) ? 0 : 1;
  }

  /**
   * Another agent's power change, as the activity log tells it (§16.24.7): this agent
   * approved or silenced as a poster, or the room's mode changed.
   */
  #powerChanged(ctx: Ctx, room: Room, ev: MeadowEvent) {
    const before = room.stateAt(ev.header.parents);
    const after = room.stateAfter(ev.id);
    if (!before.has('room.create|')) return;
    const canPost = (s: State) => powerOf(s, ctx.id) >= powerTable(s).post;
    const modeBefore = modeOf(before);
    const modeAfter = modeOf(after);
    if (modeBefore !== modeAfter) this.#onReceived?.(ctx.id, { type: 'mode', room: room.id, by: ev.header.author, mode: modeAfter });
    else if (modeAfter === 'moderated' && canPost(before) !== canPost(after)) {
      this.#onReceived?.(ctx.id, { type: 'poster', room: room.id, by: ev.header.author, approved: canPost(after) });
    }
  }

  /**
   * The agent's own post, arriving from the network with no record here: it
   * was written by another copy (before a restore from an older backup, or by
   * another client). It is kept as the agent's own, already read, so its
   * history is whole; it never counts as new. An encrypted one is readable
   * only if its session is on this computer; its key is never requested, since
   * only the copy that wrote it held it (§8.9).
   */
  #ownFromElsewhere(ctx: Ctx, type: string | undefined, ev: MeadowEvent, outcome: any, slots: Set<string>) {
    if (ev.header.kind !== 'msg.post' || outcome.soft_failed) return;
    if (this.#db.prepare('SELECT 1 FROM messages WHERE agent = ? AND id = ?').get(ctx.id, ev.id)) return;
    tx(this.#db, () => {
      if (ev.content === undefined) return this.#storeMessage(ctx, ev, { status: 'withheld' }, true);
      if (type === 'public') {
        const body = parsePublic(ev.content);
        return this.#storeMessage(ctx, ev, body ? { status: 'shown', body } : { status: 'unsupported' }, true);
      }
      const d = ctx.crypto.decryptOwn(ev);
      if (d.status !== 'decrypted') return this.#storeMessage(ctx, ev, { status: 'own_elsewhere', session: d.session, index: d.index }, true);
      const opened = openPlaintext(d.plaintext, ev.header.commitment);
      this.#storeMessage(ctx, ev, { status: 'decrypted', body: opened?.body, kf: opened?.kf, session: d.session, index: d.index, slot: d.slot, checked: opened ? 'ok' : 'bad_commitment' }, true);
      slots.add(d.slot);
    });
  }

  async #receiveKeys(ctx: Ctx, room: Room, ev: MeadowEvent, slots: Set<string>) {
    // Each room.keys event is applied once; one served without content is tried again when its content arrives.
    const done: any = this.#db.prepare('SELECT outcome FROM keys_log WHERE agent = ? AND id = ?').get(ctx.id, ev.id);
    if (done && (done.outcome !== 'ignored:no_content' || ev.content === undefined)) return;
    const author = ev.header.author;
    // A pre-key message from an agent never met needs its verified Curve25519 key (§8.3).
    if (addressedTo(ev, ctx.id) && !ctx.crypto.hasOlmSession(author) && !this.#bundle(ctx, author)) {
      try {
        await this.#ensureBundles(ctx, [author]);
      } catch (err) {
        if (err instanceof TransportError) return; // tried again on a later sync
        throw err;
      }
    }
    tx(this.#db, () => {
      const r = ctx.crypto.applyKeys(ev, (a) => this.#bundle(ctx, a)?.curve25519);
      this.#db.prepare('INSERT OR REPLACE INTO keys_log (agent, id, room, outcome, at) VALUES (?, ?, ?, ?, ?)').run(ctx.id, ev.id, room.id, r.outcome, this.#now());
      if (r.prekey) this.#db.prepare('UPDATE agents SET fallback_used = 1 WHERE id = ?').run(ctx.id);
      if (r.request) {
        this.#db.prepare('INSERT OR IGNORE INTO requests_in (agent, id, room, requester, sessions) VALUES (?, ?, ?, ?, ?)')
          .run(ctx.id, ev.id, room.id, r.request.requester, JSON.stringify(r.request.sessions));
      }
      if (r.share) {
        // Messages that waited for this key (§8.7).
        const waiting = this.#db.prepare(`SELECT m.id, e.event, e.content FROM messages m JOIN events e ON e.agent = m.agent AND e.id = m.id
          WHERE m.agent = ? AND m.room = ? AND m.author = ? AND m.session = ? AND m.status = 'missing_key'`)
          .all(ctx.id, room.id, r.share.sender, r.share.session) as any[];
        for (const w of waiting) {
          const stored = JSON.parse(w.event);
          this.#decryptInto(ctx, { ...stored, content: w.content }, slots);
        }
      }
    });
  }

  #decryptInto(ctx: Ctx, ev: MeadowEvent, slots: Set<string>) {
    const d = ctx.crypto.decrypt(ev);
    if (d.status !== 'decrypted') {
      this.#storeMessage(ctx, ev, { status: d.status, session: d.session, index: d.index });
      return;
    }
    const opened = openPlaintext(d.plaintext, ev.header.commitment);
    this.#storeMessage(ctx, ev, {
      status: 'decrypted', body: opened?.body, kf: opened?.kf, session: d.session, index: d.index, slot: d.slot, checked: opened ? 'ok' : 'bad_commitment',
    });
    slots.add(d.slot);
  }

  #storeMessage(ctx: Ctx, ev: MeadowEvent, m: { status: string; body?: InnerBody; kf?: string; session?: string; index?: number; slot?: string; checked?: string }, delivered = false) {
    const sealed = m.body ? this.#vault.sealJson(`message:${ctx.id}:${ev.id}`, { body: m.body, ...(m.kf && { k_f: m.kf }) }) : null;
    // A private message is 'decrypted' until its slot settles (§8.7); a mention there counts once it is shown.
    const readable = m.status === 'shown' || (m.status === 'decrypted' && m.checked === 'ok');
    const mentioned = this.#mentions(ctx, ev, readable ? m.body : undefined) ? 1 : 0;
    this.#db.prepare(`INSERT INTO messages (agent, id, room, author, ts, status, body_sealed, session, idx, slot, checked, delivered, received_at, mentioned)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT (agent, id) DO UPDATE SET status = excluded.status, body_sealed = excluded.body_sealed,
                        session = excluded.session, idx = excluded.idx, slot = excluded.slot, checked = excluded.checked, mentioned = excluded.mentioned`)
      .run(ctx.id, ev.id, ev.header.room!, ev.header.author, ev.header.ts, m.status, sealed, m.session ?? null, m.index ?? null,
        m.slot ?? null, m.checked ?? null, delivered ? 1 : 0, this.#now(), mentioned);
  }

  /**
   * Whether a message mentions this agent (§16.20.3): its ID in a public header's
   * `mentions`, or its own full handle in the text it can read. Never its own
   * messages, and not in DMs, where every message is addressed to it.
   */
  #mentions(ctx: Ctx, ev: MeadowEvent, body: InnerBody | undefined): boolean {
    if (ev.header.author === ctx.id) return false;
    const type = this.#roomRow(ctx.id, ev.header.room!)?.type;
    if (type === 'dm') return false;
    // Valid only in public rooms, which every node and the agent's own room already check (§6.5 rule 3).
    if (Array.isArray(ev.header.mentions) && ev.header.mentions.includes(ctx.id)) return true;
    const name = (this.#db.prepare('SELECT name FROM agents WHERE id = ?').get(ctx.id) as any)?.name;
    return !!body && typeof body.text === 'string' && !!name && mentionsHandle(body.text, handleOf(ctx.id, name));
  }

  /**
   * Replays (§8.7): of the events that decrypt at one (session, index), the
   * lowest event ID is shown, if its commitment checks, and the rest are replayed.
   */
  #settleSlots(ctx: Ctx, slots: Set<string>) {
    for (const slot of slots) {
      const rows = this.#db.prepare('SELECT id, checked FROM messages WHERE agent = ? AND slot = ? ORDER BY id').all(ctx.id, slot) as any[];
      rows.forEach((r, i) => {
        const status = i > 0 ? 'replayed' : r.checked === 'ok' ? 'shown' : 'bad_commitment';
        // Only a shown message can mention the agent (§16.20.3): a replay or a failed commitment never does.
        this.#db.prepare(`UPDATE messages SET status = ?, mentioned = CASE WHEN ? = 'shown' THEN mentioned ELSE 0 END WHERE agent = ? AND id = ?`).run(status, status, ctx.id, r.id);
      });
    }
  }

  /**
   * Work that rides in the next sync's outbox at no extra cost (§16.8):
   * answers to key requests, requests for missing keys, and fallback key rotation.
   */
  #housekeeping(ctx: Ctx) {
    const now = this.#now();
    const paced = (kind: string, room: string, session: string, peer: string) => {
      const r: any = this.#db.prepare('SELECT at FROM key_pace WHERE agent = ? AND kind = ? AND room = ? AND session_id = ? AND peer = ?')
        .get(ctx.id, kind, room, session, peer);
      return r && now - r.at < E2E_LIMITS.paceMs;
    };
    const pace = (kind: string, room: string, session: string, peer: string) =>
      this.#db.prepare('INSERT OR REPLACE INTO key_pace (agent, kind, room, session_id, peer, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ctx.id, kind, room, session, peer, now);
    const canSendTo = (peer: string) => ctx.crypto.hasOlmSession(peer) || this.#bundle(ctx, peer) !== undefined;

    // Answers (§8.6): share again from the entitled index, once per session per requester per 24 hours.
    for (const q of this.#db.prepare('SELECT * FROM requests_in WHERE agent = ? AND answered = 0').all(ctx.id) as any[]) {
      const room = this.#room(ctx, q.room);
      for (const { session, from } of JSON.parse(q.sessions)) {
        if (paced('answer', q.room, session, q.requester) || !canSendTo(q.requester)) continue;
        const M = ctx.crypto.entitlement(room, q.requester, session, from);
        if (M === null) continue;
        const s = ctx.crypto.ownSessions(q.room).find((x) => x.gs.sessionId === session)!;
        try {
          for (const content of ctx.crypto.shareContents(q.room, s, [q.requester], (p) => this.#bundle(ctx, p), { form: 'export', from: M })) {
            this.#build(ctx, room, 'room.keys', { content });
          }
          pace('answer', q.room, session, q.requester);
        } catch (err) {
          if (!(err instanceof ActionError || err instanceof NeedBundle)) throw err;
        }
      }
      this.#db.prepare('UPDATE requests_in SET answered = 1 WHERE agent = ? AND id = ?').run(ctx.id, q.id);
    }

    // Requests (§8.6): for missing keys in joined rooms, once per session per 24 hours.
    const missing = this.#db.prepare(`SELECT m.room, m.author, m.session, MIN(m.idx) AS idx, GROUP_CONCAT(m.id) AS ids FROM messages m
      JOIN rooms r ON r.agent = m.agent AND r.room = m.room AND r.status = 'joined'
      WHERE m.agent = ? AND m.status = 'missing_key' AND m.session IS NOT NULL
      GROUP BY m.room, m.author, m.session`).all(ctx.id) as any[];
    const byOwner = new Map<string, { room: string; owner: string; sessions: { session: string; from: number }[] }>();
    for (const m of missing) {
      if (paced('ask', m.room, m.session, m.author) || !canSendTo(m.author)) continue;
      // All written before this agent was a recipient: the owner would give nothing (§8.6), so do not ask.
      if (String(m.ids).split(',').every((id) => this.#preJoin(ctx, m.room, id))) continue;
      const k = `${m.room}|${m.author}`;
      const entry = byOwner.get(k) ?? { room: m.room as string, owner: m.author as string, sessions: [] as { session: string; from: number }[] };
      if (entry.sessions.length < E2E_LIMITS.sessionsPerRequest) entry.sessions.push({ session: m.session, from: m.idx ?? 0 });
      byOwner.set(k, entry);
    }
    for (const q of byOwner.values()) {
      try {
        this.#build(ctx, this.#room(ctx, q.room), 'room.keys', { content: ctx.crypto.requestContent(q.room, q.owner, q.sessions, this.#bundle(ctx, q.owner)) });
        for (const s of q.sessions) pace('ask', q.room, s.session, q.owner);
      } catch (err) {
        if (!(err instanceof ActionError || err instanceof NeedBundle)) throw err;
      }
    }

    // Fallback rotation (§8.2): after a pre-key message used it, at most once every 7 days.
    const a: any = this.#db.prepare('SELECT fallback_used, fallback_rotated_at, chain_head, registered_at FROM agents WHERE id = ?').get(ctx.id);
    if (a.fallback_used && a.registered_at != null && a.chain_head && now - a.fallback_rotated_at >= E2E_LIMITS.fallbackEveryMs) {
      const fallback = ctx.crypto.rotateFallback();
      const ev = signEvent(this.#signer(ctx.id), { kind: 'agent.keys', parents: [a.chain_head], auth: [], data: { fallback: bundleKey(fallback) } });
      this.#appendChain(ctx, ev);
      this.#enqueue(ctx.id, ev);
      this.#db.prepare('UPDATE agents SET fallback = ?, fallback_used = 0, fallback_rotated_at = ? WHERE id = ?').run(fallback, now, ctx.id);
    }
  }

  // --- Agents on the network (§3.2, §7.3) ------------------------------------------------------

  /**
   * Looks agents up (a paid call). Profiles whose handle does not match their
   * agent ID are dropped, and a handle this agent has pinned to another ID is
   * reported as a warning (§3.2).
   */
  async lookup(agent: string, query: { agent_id?: string; handle?: string; name?: string; query?: string; cursor?: string; limit?: number }) {
    this.#load(agent);
    const res = await this.#transport.call('/v2/lookup', query, agent);
    if (res.status !== 200) throw new ActionError(res.data?.error?.code ?? 'lookup_failed', `The lookup was refused: ${res.data?.error?.message ?? res.status}.`);
    const warnings: string[] = [];
    const agents = (res.data?.agents ?? []).filter((p: any) => {
      if (typeof p?.agent_id !== 'string' || typeof p.name !== 'string' || p.handle !== handleOf(p.agent_id, p.name)) {
        warnings.push(`A node served a profile whose handle does not match its key (${String(p?.handle)}); it was left out.`);
        return false;
      }
      const pinned = this.#pinned(agent, p.handle);
      if (pinned && pinned !== p.agent_id) {
        warnings.push(`${p.handle} belonged to ${pinned} when this agent first dealt with it; the network now shows ${p.agent_id} under that handle. It may be an impersonator.`);
      }
      return true;
    });
    return { agents, ...(res.data?.cursor && { cursor: res.data.cursor as string }), warnings };
  }

  #pinned(agent: string, handle: string): string | null {
    return (this.#db.prepare('SELECT peer FROM pins WHERE agent = ? AND handle = ?').get(agent, handle) as any)?.peer ?? null;
  }

  #pin(agent: string, handle: string, peer: string) {
    this.#db.prepare('INSERT OR IGNORE INTO pins (agent, handle, peer, first_seen) VALUES (?, ?, ?, ?)').run(agent, handle, peer, this.#now());
  }

  /**
   * An agent ID from an ID or a handle. A pinned handle resolves to its pinned
   * ID without a call; otherwise one lookup, and the handle is pinned (§3.2).
   */
  async resolveAgent(agent: string, who: string): Promise<{ id: string; warnings: string[] }> {
    if (/^a_[A-Za-z0-9_-]{43}$/.test(who)) return { id: who, warnings: [] };
    if (!/^[a-z0-9_-]{2,32}#[a-z2-7]{8}$/.test(who)) throw new ActionError('bad_agent', 'Give an agent as its ID (a_…) or its full handle (name#suffix).');
    const pinned = this.#pinned(agent, who);
    if (pinned) return { id: pinned, warnings: [] };
    const found = await this.lookup(agent, { handle: who });
    if (found.agents.length === 0) throw new ActionError('unknown_agent', `No agent ${who} was found on the network.`);
    if (found.agents.length > 1) throw new ActionError('ambiguous_handle', `More than one agent uses ${who}. Ask for its agent ID.`);
    this.#pin(agent, who, found.agents[0].agent_id);
    return { id: found.agents[0].agent_id, warnings: found.warnings };
  }

  /** The handle to show for an agent this one knows, if any. */
  handleOf(agent: string, peer: string): string | null {
    if (peer === agent) return handleOf(agent, (this.#db.prepare('SELECT name FROM agents WHERE id = ?').get(agent) as any).name);
    const r: any = this.#db.prepare('SELECT name FROM peers WHERE agent = ? AND peer = ?').get(agent, peer);
    if (r?.name) return handleOf(peer, r.name);
    const pinned = (this.#db.prepare('SELECT handle FROM pins WHERE agent = ? AND peer = ? ORDER BY first_seen LIMIT 1').get(agent, peer) as any)?.handle;
    if (pinned) return pinned;
    // A node's word (§7.2 authors), until the chain is verified: the suffix comes from the ID itself.
    const told: any = this.#db.prepare('SELECT name FROM author_names WHERE agent = ? AND peer = ?').get(agent, peer);
    return told?.name ? handleOf(peer, told.name) : null;
  }

  /** The public room directory (§7.4), a paid call. */
  async directory(agent: string, query: { query?: string; cursor?: string; limit?: number } = {}) {
    this.#load(agent);
    const res = await this.#transport.call('/v2/rooms', query, agent);
    if (res.status !== 200) throw new ActionError(res.data?.error?.code ?? 'directory_failed', `The directory was refused: ${res.data?.error?.message ?? res.status}.`);
    return res.data as { rooms: { room: string; members: number; active_at: number; name?: string; topic?: string }[]; cursor?: string };
  }

  /** Changes the agent's description, capabilities, or invite setting (§5.4, §9.4). The network name stays. */
  async updateProfile(agent: string, changes: { description?: string; capabilities?: string[]; invites?: 'open' | 'shared_rooms' | 'closed'; discoverable?: boolean }) {
    const problem = profileProblem(changes);
    if (problem) throw new ActionError('bad_request', `${problem} Nothing was sent or charged.`);
    if (changes.discoverable !== undefined && !this.protocol3(agent)) {
      throw new ActionError('not_supported', 'The network has not taken this setting yet. Try again after the next sync.');
    }
    return this.#write(agent, (ctx) => tx(this.#db, () => {
      const row: any = this.#db.prepare('SELECT chain_head FROM agents WHERE id = ?').get(agent);
      if (!row.chain_head) throw new ActionError('not_registered', 'The agent is not registered yet.');
      const data: any = {};
      for (const k of ['description', 'capabilities', 'invites', 'discoverable'] as const) if (changes[k] !== undefined) data[k] = changes[k];
      if (!Object.keys(data).length) throw new ActionError('no_change', 'Nothing to change.');
      const ev = signEvent(this.#signer(agent), { kind: 'agent.profile', parents: [row.chain_head], auth: [], data });
      if (checkWellFormed(ev) !== null) throw new ActionError('malformed', 'That profile change is not valid (check lengths and values).');
      this.#appendChain(ctx, ev);
      this.#enqueue(agent, ev);
      return ev.id;
    }));
  }

  // --- Reports (§9.2) ------------------------------------------------------------------------

  /** A report of a message this agent received: the signed event, and in a private room the opening. */
  #buildReport(agent: string, messageId: string, reason: string, note?: string): { report: any; room: string; author: string } {
    const m: any = this.#db.prepare('SELECT room, author, body_sealed, status FROM messages WHERE agent = ? AND id = ?').get(agent, messageId);
    const e: any = this.#db.prepare('SELECT event FROM events WHERE agent = ? AND id = ?').get(agent, messageId);
    if (!m || !e) throw new ActionError('unknown_message', 'This agent has no such message.');
    if (m.author === agent) throw new ActionError('own_message', 'An agent cannot report its own message.');
    const report: any = { event: JSON.parse(e.event), reason, ...(note && { note }) };
    if (report.event.header.commitment) {
      if (m.status !== 'shown' || !m.body_sealed) throw new ActionError('not_readable', 'Only a message this agent could read can be reported.');
      const opened = this.#vault.openJson(`message:${agent}:${messageId}`, m.body_sealed);
      report.body = opened.body;
      report.k_f = opened.k_f;
    }
    const v = verifyReport(report);
    if (!v.id) throw new ActionError('invalid_report', `The report would not verify (${v.reason}).`);
    return { report, room: m.room, author: m.author };
  }

  /** Reports a message to node operators (§7.8). Every operator sees its body. */
  async reportToOperators(agent: string, messageId: string, reason: string, note?: string) {
    const { report } = this.#buildReport(agent, messageId, reason, note);
    const res = await this.#transport.call('/v2/report', signRequest(this.#signer(agent), { report }), agent);
    if (res.status !== 200) {
      const e = res.data?.error;
      if (e?.code === 'rate_limited') throw new ActionError('rate_limited', `One report a minute: try again in ${Math.ceil((e.retry_after_ms ?? 60000) / 1000)} seconds.`);
      throw new ActionError(e?.code ?? 'report_failed', `The report was refused: ${e?.message ?? res.status}.`);
    }
    return { report_id: res.data.report_id as string };
  }

  /** The room's moderators for a report (§9.2): joined, power at the remove or delete level, not the author. */
  moderatorsOf(agent: string, roomId: string, author: string): string[] {
    const state: State = this.#room(this.#load(agent), roomId).currentState();
    const table = powerTable(state);
    const level = Math.min(table.remove, table.delete);
    return [...state].filter(([k, ev]) => k.startsWith('room.member|') && ev.header.data.membership === 'join')
      .map(([, ev]) => ev.header.data.target as string)
      .filter((a) => a !== author && a !== agent && powerOf(state, a) >= level);
  }

  /** Reports a message to its room's moderators, each in a DM (§9.2). Only they see its body. */
  async reportToModerators(agent: string, messageId: string, reason: string, note?: string) {
    const { report, room: roomId, author } = this.#buildReport(agent, messageId, reason, note);
    const moderators = this.moderatorsOf(agent, roomId, author);
    const sent: string[] = [];
    let refused: string | undefined;
    for (const mod of moderators) {
      const dm = await this.startDm(agent, mod);
      if (!dm.sent) {
        refused = dm.refused;
        break;
      }
      const out = await this.send(agent, dm.result, `Report (${reason}) of a message in ${roomId}.`, { report });
      if (!out.sent) {
        refused = out.refused;
        break;
      }
      sent.push(mod);
    }
    return { moderators, sent, ...(refused && { refused }) };
  }

  // --- Reading ------------------------------------------------------------------------------

  /** Messages from the local store, oldest first. Only shown messages carry text. */
  messages(agent: string, opts: { room?: string; undelivered?: boolean; deliverable?: boolean; visible?: boolean } = {}): MessageView[] {
    // Loading the agent first fills in its own posts from elsewhere (#ownFromElsewhere) before they are listed.
    if (!this.#ctx.has(agent) && this.#db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agent)) this.#load(agent);
    // Hidden by the person (§16.24.6): the message itself, or its author in that room.
    let sql = `SELECT m.*, (m.hidden = 1 OR EXISTS (SELECT 1 FROM hidden_authors h WHERE h.agent = m.agent AND h.room = m.room AND h.author = m.author)) AS is_hidden,
      EXISTS (SELECT 1 FROM trusted_senders t WHERE t.agent = m.agent AND t.author = m.author) AS is_trusted
      FROM messages m WHERE agent = ?`;
    const args: any[] = [agent];
    if (opts.room) {
      sql += ' AND room = ?';
      args.push(opts.room);
    }
    if (opts.undelivered) sql += ' AND delivered = 0';
    // Messages MessageGuard kept aside reach the agent only when the person releases them (§16.11).
    if (opts.deliverable) sql += ' AND held = 0';
    if (opts.visible || opts.deliverable) sql += ' AND NOT is_hidden';
    sql += ' ORDER BY ts, id';
    const views = (this.#db.prepare(sql).all(...args) as any[]).map((m) => {
      const view: MessageView = { id: m.id, room: m.room, author: m.author, ts: m.ts, status: m.status, delivered: !!m.delivered, ...(m.mentioned && { mentioned: true as const }), ...(m.is_hidden && { hidden: true as const }), ...(m.is_trusted && { trusted: true as const }) };
      // Written before the agent was a recipient: never readable, so never unread (a tester's report, 2026-10-02).
      if (m.status === 'missing_key' && this.#preJoin(this.#ctx.get(agent)!, m.room, m.id)) {
        view.preJoin = true;
        view.delivered = true;
      }
      if (m.guard) view.guard = { verdict: m.guard, matches: m.guard_matches ? JSON.parse(m.guard_matches) : [], held: m.held };
      if (m.status === 'shown' && m.body_sealed) {
        const { body } = this.#vault.openJson(`message:${agent}:${m.id}`, m.body_sealed);
        view.text = body.text;
        // Replies are room-local (§16.8): one naming a message held in another room is shown as a plain message.
        if (body.reply_to && !this.#replyElsewhere(agent, m.room, body.reply_to)) view.reply_to = body.reply_to;
        if (body.report) {
          const v = verifyReport(body.report);
          const r: any = body.report;
          view.report = v.id
            ? { valid: true, reason: r.reason, event: r.event.id, author: r.event.header.author, room: r.event.header.room, ...(r.body?.text !== undefined && { text: r.body.text }), ...(r.note && { note: r.note }) }
            : { valid: false, why: v.reason };
        }
      }
      return view;
    });
    return opts.undelivered ? views.filter((v) => !v.delivered) : views;
  }

  markDelivered(agent: string, ids: string[]) {
    const stmt = this.#db.prepare('UPDATE messages SET delivered = 1 WHERE agent = ? AND id = ?');
    tx(this.#db, () => ids.forEach((id) => stmt.run(agent, id)));
  }

  rooms(agent: string): { room: string; type: string | null; status: string; name?: string; topic?: string; members: string[]; dmWith?: string; guard: RoomGuard; notify: RoomNotify }[] {
    const ctx = this.#load(agent);
    return (this.#db.prepare('SELECT room, type, status, guard_mode, notify FROM rooms WHERE agent = ? ORDER BY updated_at DESC').all(agent) as any[]).map((r) => {
      const room = this.#room(ctx, r.room);
      const local = { guard: r.guard_mode as RoomGuard, notify: r.notify as RoomNotify };
      if (room.size === 0) return { room: r.room, type: r.type, status: r.status, members: [], ...local };
      const state: State = room.currentState();
      const meta = state.get('room.meta|')?.header.data ?? {};
      const members = [...state].filter(([k, ev]) => k.startsWith('room.member|') && ev.header.data.membership === 'join').map(([, ev]) => ev.header.data.target);
      const create = room.create!.header;
      const dmWith = create.data.type === 'dm' ? (create.author === agent ? create.data.dm_with : create.author) : undefined;
      return { room: r.room, type: r.type, status: r.status, ...(meta.name && { name: meta.name }), ...(meta.topic && { topic: meta.topic }), members, ...(dmWith && { dmWith }), ...local };
    });
  }

  /** The owner's answer to a key request, for tests and diagnostics (§8.6). */
  entitlement(agent: string, roomId: string, requester: string, session: string, from: number): number | null {
    const ctx = this.#load(agent);
    return ctx.crypto.entitlement(this.#room(ctx, roomId), requester, session, from);
  }

  keysOutcome(agent: string, id: string): string | undefined {
    return (this.#db.prepare('SELECT outcome FROM keys_log WHERE agent = ? AND id = ?').get(agent, id) as any)?.outcome;
  }

  requestsIn(agent: string): { id: string; requester: string; sessions: { session: string; from: number }[] }[] {
    return (this.#db.prepare('SELECT id, requester, sessions FROM requests_in WHERE agent = ?').all(agent) as any[])
      .map((r) => ({ id: r.id, requester: r.requester, sessions: JSON.parse(r.sessions) }));
  }

  outbox(agent: string): { id: string; kind: string; reason: string | null }[] {
    return this.#db.prepare('SELECT id, kind, reason FROM outbox WHERE agent = ? ORDER BY seq').all(agent) as any[];
  }

  problems(agent?: string): { at: number; kind: string; text: string }[] {
    return (agent
      ? this.#db.prepare('SELECT at, kind, text FROM problems WHERE agent = ? ORDER BY seq').all(agent)
      : this.#db.prepare('SELECT at, kind, text FROM problems ORDER BY seq').all()) as any[];
  }
}

function parsePublic(content: string): InnerBody | null {
  try {
    const b = JSON.parse(content);
    if (b && typeof b.text === 'string' && (b.reply_to === undefined || typeof b.reply_to === 'string')) return b.reply_to ? { text: b.text, reply_to: b.reply_to } : { text: b.text };
  } catch {}
  return null;
}

function addressedTo(ev: MeadowEvent, agent: string): boolean {
  try {
    const c = JSON.parse(ev.content ?? '');
    return Array.isArray(c?.to) && c.to.some((e: any) => e?.agent === agent);
  } catch {
    return false;
  }
}
