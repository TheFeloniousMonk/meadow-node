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
import type { Vault } from './vault.ts';

export const SYNC = {
  outbox: 100, // events per call (§7.2)
  maxPages: 20, // calls one sync may make before it stops
  limitBytes: 1024 * 1024,
};

export interface CoreOptions {
  db: Db;
  vault: Vault;
  transport: Transport;
  now?: () => number;
  /** Runs after every sync, inside the agent's lock: MessageGuard screening, notifications (§16.11). */
  afterSync?: (agent: string, report: SyncReport) => Promise<void>;
}

export interface SyncReport {
  calls: number;
  accepted: string[];
  rejected: { id: string; reason: string }[];
  pending: { id: string; reason?: string }[];
  invites: number;
  messages: number; // new messages from others
  stopped?: string; // why the sync stopped early, in plain words
}

/** An action the protocol does not allow in the agent's own view of the room. */
export class ActionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface MessageView {
  id: string;
  room: string;
  author: string;
  ts: number;
  status: string;
  text?: string;
  reply_to?: string;
  /** A report to this agent as a moderator (§9.2), verified here. */
  report?: { valid: true; reason: string; event: string; author: string; room: string; text?: string; note?: string } | { valid: false; why: string };
  delivered: boolean;
  /** MessageGuard's verdict (§16.11): held 1 while kept aside, 2 once the person chose to keep it held. */
  guard?: { verdict: string; matches: { label: string; match: string }[]; held: number };
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

export class Core {
  #db: Db;
  #vault: Vault;
  #transport: Transport;
  #afterSync?: (agent: string, report: SyncReport) => Promise<void>;
  #now: () => number;
  #ctx = new Map<string, Ctx>();
  #locks = new Map<string, Promise<unknown>>();

  constructor({ db, vault, transport, now = Date.now, afterSync }: CoreOptions) {
    this.#afterSync = afterSync;
    this.#db = db;
    this.#vault = vault;
    this.#transport = transport;
    this.#now = now;
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
    if (ctx) return ctx;
    const row: any = this.#db.prepare('SELECT id, name FROM agents WHERE id = ?').get(agent);
    if (!row) throw new ActionError('unknown_agent', 'There is no such agent on this computer.');
    const log = new AgentLog();
    for (const r of this.#db.prepare('SELECT event FROM own_chain WHERE agent = ? ORDER BY seq').all(agent) as any[]) log.add(JSON.parse(r.event));
    for (const r of this.#db.prepare('SELECT chain FROM peers WHERE agent = ? AND chain IS NOT NULL').all(agent) as any[]) {
      for (const ev of JSON.parse(r.chain)) log.add(ev);
    }
    ctx = { id: agent, name: row.name, crypto: new AgentCrypto(this.#db, this.#vault.pickleKey(agent), agent, this.#now), log, rooms: new Map() };
    this.#ctx.set(agent, ctx);
    return ctx;
  }

  /** Runs one agent's network work one call at a time, so two syncs never interleave. */
  async #exclusive<T>(agent: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(agent) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.#locks.set(agent, run.catch(() => {}));
    return run;
  }

  /**
   * Registers the agent (§16.6): signs agent.register with the name the app
   * derived, and the description and capabilities the AI chose, and syncs it.
   * Resending is safe: the same event is kept until a node accepts it.
   */
  async register(agent: string, profile: { description?: string; capabilities?: string[] } = {}) {
    return this.#exclusive(agent, async () => {
      const ctx = this.#load(agent);
      const row: any = this.#db.prepare('SELECT * FROM agents WHERE id = ?').get(agent);
      if (!row.chain_head) {
        const data: any = { name: row.name, keys: { curve25519: bundleKey(ctx.crypto.curve25519), fallback: bundleKey(row.fallback) } };
        if (profile.description) data.description = profile.description;
        if (profile.capabilities?.length) data.capabilities = profile.capabilities;
        const ev = signEvent(this.#signer(agent), { kind: 'agent.register', parents: [], auth: [], data });
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

  #problem(agent: string | null, kind: string, text: string) {
    this.#db.prepare('INSERT INTO problems (agent, at, kind, text) VALUES (?, ?, ?, ?)').run(agent, this.#now(), kind, text);
  }

  // --- Rooms ------------------------------------------------------------------------

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
    this.#db.prepare(`INSERT OR IGNORE INTO events (agent, room, id, seq, event, outcome, content, withheld)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ctx.id, roomId, ev.id, seq, JSON.stringify({ header: ev.header, id: ev.id, sig: ev.sig }), JSON.stringify(outcome), ev.content ?? null, withheld ?? null);
  }

  /**
   * Signs a room event on the agent's own view of the room: parents are its
   * heads, auth is selected from the state at them (§6.4). The room must
   * accept it, or the action is refused with the protocol's reason.
   */
  #build(ctx: Ctx, room: Room, kind: string, opts: { data?: unknown; content?: string; commitment?: string } = {}): MeadowEvent {
    const parents = room.heads().slice(-MAX_PARENTS);
    // The author is set before selecting auth: the author's own membership and binding are cited (§6.4).
    const header: any = { kind, author: ctx.id, room: room.id, parents, auth: [] };
    if (opts.data !== undefined) header.data = opts.data;
    if (opts.commitment) header.commitment = opts.commitment;
    header.auth = selectAuth(header, room.stateAt(parents));
    const ev = signEvent(this.#signer(ctx.id), header, opts.content);
    return this.#addOwn(ctx, room, ev);
  }

  #addOwn(ctx: Ctx, room: Room, ev: MeadowEvent): MeadowEvent {
    const r = room.add(ev);
    if (r.outcome !== 'accepted') throw new ActionError(r.reason ?? r.outcome, `The network would refuse this (${r.reason ?? r.outcome}).`);
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

  /** Writes events and syncs them at once (§16.8). A refused payment leaves them queued. */
  async #write<T>(agent: string, build: (ctx: Ctx) => T | Promise<T>): Promise<{ result: T; sent: boolean; refused?: string; report?: SyncReport }> {
    return this.#exclusive(agent, async () => {
      const ctx = this.#load(agent);
      const result = await build(ctx);
      try {
        const report = await this.#sync(ctx);
        return { result, sent: true, report };
      } catch (err) {
        if (err instanceof TransportError && err.kind === 'refused') return { result, sent: false, refused: err.message };
        throw err;
      }
    });
  }

  async createRoom(agent: string, opts: { type: 'public' | 'private'; name?: string; topic?: string; listed?: boolean }) {
    return this.#write(agent, (ctx) => tx(this.#db, () => {
      const room = this.#create(ctx, { type: opts.type });
      this.#build(ctx, room, 'room.member', { data: { target: ctx.id, membership: 'join' } });
      const meta: any = {};
      if (opts.name !== undefined) meta.name = opts.name;
      if (opts.topic !== undefined) meta.topic = opts.topic;
      if (opts.type === 'public' && opts.listed !== undefined) meta.listed = opts.listed;
      if (Object.keys(meta).length) this.#build(ctx, room, 'room.meta', { data: meta });
      return room.id as string;
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

  async invite(agent: string, roomId: string, target: string) {
    return this.#write(agent, (ctx) => tx(this.#db, () =>
      this.#build(ctx, this.#knownRoom(ctx, roomId), 'room.member', { data: { target, membership: 'invite' } }).id));
  }

  /** Removes (leave) or bans another member (§6.5 rule 5). */
  async remove(agent: string, roomId: string, target: string, { ban = false } = {}) {
    return this.#write(agent, (ctx) => tx(this.#db, () =>
      this.#build(ctx, this.#knownRoom(ctx, roomId), 'room.member', { data: { target, membership: ban ? 'ban' : 'leave' } }).id));
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
  async send(agent: string, roomId: string, text: string, opts: { replyTo?: string; report?: Record<string, unknown> } = {}) {
    return this.#write(agent, async (ctx) => {
      const room = this.#knownRoom(ctx, roomId);
      const type = room.create!.header.data.type;
      const body: InnerBody = { text, ...(opts.replyTo && { reply_to: opts.replyTo }), ...(opts.report && { report: opts.report }) };
      if (type === 'public') {
        return tx(this.#db, () => {
          const ev = this.#build(ctx, room, 'msg.post', { content: JSON.stringify(body) });
          this.#storeMessage(ctx, ev, { status: 'shown', body }, true);
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
        return ev.id;
      });
    });
  }

  /** Reads a room from the network (a paid sync naming it), without joining (§7.2). */
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

  async #sync(ctx: Ctx): Promise<SyncReport> {
    const report: SyncReport = { calls: 0, accepted: [], rejected: [], pending: [], invites: 0, messages: 0 };
    for (let page = 0; page < SYNC.maxPages; page++) {
      const rows = this.#db.prepare('SELECT id, event FROM outbox WHERE agent = ? ORDER BY seq LIMIT ?').all(ctx.id, SYNC.outbox) as any[];
      const total = (this.#db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE agent = ?').get(ctx.id) as any).n;
      const fields: any = { heads: this.#heads(ctx), limit_bytes: SYNC.limitBytes };
      if (rows.length) fields.outbox = rows.map((r) => JSON.parse(r.event));
      let res;
      try {
        res = await this.#transport.call('/v2/sync', signRequest(this.#signer(ctx.id), fields), ctx.id);
      } catch (err) {
        if (report.calls === 0) throw err;
        report.stopped = err instanceof Error ? err.message : String(err);
        break;
      }
      report.calls++;
      if (res.status !== 200) {
        const e = res.data?.error;
        throw new ActionError(e?.code ?? 'sync_failed', `The network refused the sync: ${e?.message ?? res.status}.`);
      }
      const data = res.data;
      const before = JSON.stringify(this.#heads(ctx));
      await this.#ingestSync(ctx, data, report);
      const createLimited = (data.pending ?? []).some((p: any) => p.reason === 'create_limit');
      if (!data.more && !createLimited && total <= rows.length) break;
      // Every page is paid: a page that sent nothing and brought nothing new ends the sync (a node saying "more" forever would drain the budget).
      if (!rows.length && JSON.stringify(this.#heads(ctx)) === before && !(data.invites ?? []).length) {
        this.#problem(ctx.id, 'sync', 'A node said more was waiting but sent nothing new; the sync stopped to save money.');
        break;
      }
    }
    tx(this.#db, () => this.#housekeeping(ctx));
    if (this.#afterSync) await this.#afterSync(ctx.id, report);
    return report;
  }

  async #ingestSync(ctx: Ctx, data: any, report: SyncReport) {
    tx(this.#db, () => {
      for (const id of data.accepted ?? []) {
        const row: any = this.#db.prepare('SELECT kind FROM outbox WHERE agent = ? AND id = ?').get(ctx.id, id);
        if (row?.kind === 'agent.register') this.#db.prepare('UPDATE agents SET registered_at = COALESCE(registered_at, ?) WHERE id = ?').run(this.#now(), ctx.id);
        this.#db.prepare('DELETE FROM outbox WHERE agent = ? AND id = ?').run(ctx.id, id);
        report.accepted.push(id);
      }
      for (const r of data.rejected ?? []) {
        const row: any = this.#db.prepare('SELECT kind FROM outbox WHERE agent = ? AND id = ?').get(ctx.id, r.id);
        this.#db.prepare('DELETE FROM outbox WHERE agent = ? AND id = ?').run(ctx.id, r.id);
        this.#problem(ctx.id, 'rejected', `The network refused a ${row?.kind ?? 'queued'} event (${r.reason}).`);
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
      }
    });
    for (const [roomId, entry] of Object.entries<any>(data.rooms ?? {})) {
      if (entry.expired) {
        tx(this.#db, () => this.#setRoom(ctx.id, roomId, { status: 'expired' }));
      } else if (entry.readable === false) {
        // How a removed member learns of its removal (§7.2). A node's word is not
        // enough: the room is marked removed only when a signed membership event,
        // validated in the agent's own room, says so.
        const room = this.#room(ctx, roomId);
        if (entry.membership && room.size > 0) report.messages += await this.ingestRoomEvents(ctx.id, roomId, [entry.membership]);
        const proved = room.size > 0 && ['leave', 'ban'].includes(membershipOf(room.currentState(), ctx.id));
        const row = this.#roomRow(ctx.id, roomId);
        if (proved && (row?.status === 'joined' || row?.status === 'reading')) tx(this.#db, () => this.#setRoom(ctx.id, roomId, { status: 'removed' }));
        else if (!proved) this.#problem(ctx.id, 'sync', `A node said this agent can no longer read room ${roomId}, without a signed removal; the room is kept.`);
      } else if (entry.events?.length) {
        report.messages += await this.ingestRoomEvents(ctx.id, roomId, entry.events);
      }
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
      tx(this.#db, () => this.#setRoom(ctx.id, room.id, { type, ...(status && { status }), ...(status === 'joined' && { invite: null }) }));
    }
    if (h.author === ctx.id) return 0;
    // Keys go to §8's own checks even when soft-failed: a conforming node serves those without
    // content, but if one arrives with it, entitlement (§8.6) is what refuses it, not arrival order.
    if (h.kind === 'room.keys' && type !== 'public') {
      await this.#receiveKeys(ctx, room, ev, slots);
      return 0;
    }
    // Soft-failed events are valid but never delivered (§6.6).
    if (outcome.soft_failed) return 0;
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
    return existing ? 0 : 1;
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
    this.#db.prepare(`INSERT INTO messages (agent, id, room, author, ts, status, body_sealed, session, idx, slot, checked, delivered, received_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT (agent, id) DO UPDATE SET status = excluded.status, body_sealed = excluded.body_sealed,
                        session = excluded.session, idx = excluded.idx, slot = excluded.slot, checked = excluded.checked`)
      .run(ctx.id, ev.id, ev.header.room!, ev.header.author, ev.header.ts, m.status, sealed, m.session ?? null, m.index ?? null,
        m.slot ?? null, m.checked ?? null, delivered ? 1 : 0, this.#now());
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
        this.#db.prepare('UPDATE messages SET status = ? WHERE agent = ? AND id = ?').run(status, ctx.id, r.id);
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
    const missing = this.#db.prepare(`SELECT m.room, m.author, m.session, MIN(m.idx) AS idx FROM messages m
      JOIN rooms r ON r.agent = m.agent AND r.room = m.room AND r.status = 'joined'
      WHERE m.agent = ? AND m.status = 'missing_key' AND m.session IS NOT NULL
      GROUP BY m.room, m.author, m.session`).all(ctx.id) as any[];
    const byOwner = new Map<string, { room: string; owner: string; sessions: { session: string; from: number }[] }>();
    for (const m of missing) {
      if (paced('ask', m.room, m.session, m.author) || !canSendTo(m.author)) continue;
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
    return (this.#db.prepare('SELECT handle FROM pins WHERE agent = ? AND peer = ? ORDER BY first_seen LIMIT 1').get(agent, peer) as any)?.handle ?? null;
  }

  /** The public room directory (§7.4), a paid call. */
  async directory(agent: string, query: { query?: string; cursor?: string; limit?: number } = {}) {
    this.#load(agent);
    const res = await this.#transport.call('/v2/rooms', query, agent);
    if (res.status !== 200) throw new ActionError(res.data?.error?.code ?? 'directory_failed', `The directory was refused: ${res.data?.error?.message ?? res.status}.`);
    return res.data as { rooms: { room: string; members: number; active_at: number; name?: string; topic?: string }[]; cursor?: string };
  }

  /** Changes the agent's description, capabilities, or invite setting (§5.4, §9.4). The network name stays. */
  async updateProfile(agent: string, changes: { description?: string; capabilities?: string[]; invites?: 'open' | 'shared_rooms' | 'closed' }) {
    return this.#write(agent, (ctx) => tx(this.#db, () => {
      const row: any = this.#db.prepare('SELECT chain_head FROM agents WHERE id = ?').get(agent);
      if (!row.chain_head) throw new ActionError('not_registered', 'The agent is not registered yet.');
      const data: any = {};
      for (const k of ['description', 'capabilities', 'invites'] as const) if (changes[k] !== undefined) data[k] = changes[k];
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
  messages(agent: string, opts: { room?: string; undelivered?: boolean; deliverable?: boolean } = {}): MessageView[] {
    let sql = 'SELECT * FROM messages WHERE agent = ?';
    const args: any[] = [agent];
    if (opts.room) {
      sql += ' AND room = ?';
      args.push(opts.room);
    }
    if (opts.undelivered) sql += ' AND delivered = 0';
    // Messages MessageGuard kept aside reach the agent only when the person releases them (§16.11).
    if (opts.deliverable) sql += ' AND held = 0';
    sql += ' ORDER BY ts, id';
    return (this.#db.prepare(sql).all(...args) as any[]).map((m) => {
      const view: MessageView = { id: m.id, room: m.room, author: m.author, ts: m.ts, status: m.status, delivered: !!m.delivered };
      if (m.guard) view.guard = { verdict: m.guard, matches: m.guard_matches ? JSON.parse(m.guard_matches) : [], held: m.held };
      if (m.status === 'shown' && m.body_sealed) {
        const { body } = this.#vault.openJson(`message:${agent}:${m.id}`, m.body_sealed);
        view.text = body.text;
        if (body.reply_to) view.reply_to = body.reply_to;
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
  }

  markDelivered(agent: string, ids: string[]) {
    const stmt = this.#db.prepare('UPDATE messages SET delivered = 1 WHERE agent = ? AND id = ?');
    tx(this.#db, () => ids.forEach((id) => stmt.run(agent, id)));
  }

  rooms(agent: string): { room: string; type: string | null; status: string; name?: string; topic?: string; members: string[]; dmWith?: string }[] {
    const ctx = this.#load(agent);
    return (this.#db.prepare('SELECT room, type, status FROM rooms WHERE agent = ? ORDER BY updated_at DESC').all(agent) as any[]).map((r) => {
      const room = this.#room(ctx, r.room);
      if (room.size === 0) return { room: r.room, type: r.type, status: r.status, members: [] };
      const state: State = room.currentState();
      const meta = state.get('room.meta|')?.header.data ?? {};
      const members = [...state].filter(([k, ev]) => k.startsWith('room.member|') && ev.header.data.membership === 'join').map(([, ev]) => ev.header.data.target);
      const create = room.create!.header;
      const dmWith = create.data.type === 'dm' ? (create.author === agent ? create.data.dm_with : create.author) : undefined;
      return { room: r.room, type: r.type, status: r.status, ...(meta.name && { name: meta.name }), ...(meta.topic && { topic: meta.topic }), members, ...(dmWith && { dmWith }) };
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
