// End-to-end encryption for one agent (SPEC §8): its Olm account and pairwise
// sessions, the group sessions it created, and the ones it received. Every
// change is written through to the database at once, pickled with the agent's
// pickle key (§8.9). Olm and Megolm come from vodozemac; this file applies
// §8's rules and nothing else.

import { randomBytes } from 'node:crypto';
import { b64u, canonicalize, commitment, fromB64u, wasm } from './deps.ts';
import type { MeadowEvent, State } from './deps.ts';
import type { Db } from './db.ts';

export const OLM = 'olm.v1';
export const MEGOLM = 'megolm.v1';
export const E2E_LIMITS = {
  to: 100, // recipients per room.keys event (§8.5)
  sessionsPerRequest: 50, // §8.6
  rotateAfterMessages: 100, // §8.4
  rotateAfterMs: 7 * 24 * 3600 * 1000,
  paceMs: 24 * 3600 * 1000, // one request, and one answer, per session per 24 hours (§8.6)
  fallbackEveryMs: 7 * 24 * 3600 * 1000, // §8.2
};

export interface Bundle {
  curve25519: string;
  fallback: string;
}

/**
 * Keys in the key bundle are b64u, like every key in agent events (§2, §3.3);
 * vodozemac reads and writes unpadded standard base64 (§8.1). The same 32
 * bytes, converted at the boundary.
 */
export const bundleKey = (vodozemacKey: string): string => Buffer.from(vodozemacKey, 'base64').toString('base64url');
export const vodozemacKey = (bundleKeyB64u: string): string => Buffer.from(bundleKeyB64u, 'base64url').toString('base64').replace(/=+$/, '');

/** A message body (§5.3); `report` carries a report to a room's moderators, in their DM (§9.2). */
export type InnerBody = { text: string; reply_to?: string; report?: Record<string, unknown> };

interface OlmEntry {
  sessionId: string;
  session: import('../../../crypto/pkg/meadow_crypto.js').Session;
  created: number;
  lastDecrypt: number;
}

export interface OwnSession {
  gs: import('../../../crypto/pkg/meadow_crypto.js').GroupSession;
  copy: import('../../../crypto/pkg/meadow_crypto.js').InboundGroupSession;
  recipients: Set<string>;
  count: number;
  messages: { index: number; id: string }[];
  createdAt: number;
  seq: number;
}

export type Decryption =
  | { status: 'unsupported' | 'undecryptable'; session?: string; index?: number }
  | { status: 'missing_key'; session: string; index?: number }
  | { status: 'decrypted'; session: string; index: number; slot: string; plaintext: string };

export type KeysOutcome = {
  outcome: string; // accepted, request, ignored:*, discarded:*
  prekey?: boolean; // an inbound Olm session was created: the fallback key was used (§8.2)
  share?: { sender: string; session: string };
  request?: { requester: string; sessions: { session: string; from: number }[] };
};

export class NeedBundle extends Error {
  peer: string;
  constructor(peer: string) {
    super(`no verified key bundle for ${peer}`);
    this.peer = peer;
  }
}

const parse = (s: string | undefined): any => {
  try {
    return JSON.parse(s ?? '');
  } catch {
    return null;
  }
};
const isObject = (x: unknown): x is Record<string, any> => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * The recipients of a room in a state (§8.4): members whose membership is join
 * or invite, plus a DM's dm_with while it has no membership event; never `self`.
 */
export function recipients(state: State, self: string): Set<string> {
  const out = new Set<string>();
  for (const [k, ev] of state) {
    if (k.startsWith('room.member|') && ['join', 'invite'].includes(ev.header.data.membership)) out.add(ev.header.data.target);
  }
  const dmWith = state.get('room.create|')?.header.data.dm_with;
  if (dmWith && !state.has(`room.member|${dmWith}`)) out.add(dmWith);
  out.delete(self);
  return out;
}

/**
 * Checks a decrypted Megolm plaintext against the event's franking commitment
 * (§8.7, §9.1). The plaintext must be exactly {body, k_f}, body a valid message
 * body, and HMAC-SHA256(k_f, JCS(body)) the header's commitment.
 */
export function openPlaintext(plaintext: string, headerCommitment: string | undefined): { body: InnerBody; kf: string } | null {
  const inner = parse(plaintext);
  if (!isObject(inner) || Object.keys(inner).length !== 2) return null;
  const { body, k_f: kfB64 } = inner;
  const kf = typeof kfB64 === 'string' ? fromB64u(kfB64) : null;
  if (!isObject(body) || typeof body.text !== 'string' || kf?.length !== 32) return null;
  if (!Object.keys(body).every((k) => k === 'text' || k === 'reply_to' || k === 'report')) return null;
  if (body.reply_to !== undefined && typeof body.reply_to !== 'string') return null;
  if (body.report !== undefined && !isObject(body.report)) return null;
  if (commitment(kf, body) !== headerCommitment) return null;
  return { body: body as InnerBody, kf: kfB64 };
}

/** A fresh Olm account and its first bundle, for a new agent (§8.2). */
export function newAccount(pickleKey: Uint8Array): { account: string; bundle: Bundle } {
  const account = new wasm.Account();
  const fallback = account.generateFallbackKey();
  return { account: account.pickle(pickleKey), bundle: { curve25519: account.curve25519Key, fallback } };
}

export class AgentCrypto {
  readonly agent: string;
  readonly account: import('../../../crypto/pkg/meadow_crypto.js').Account;
  #db: Db;
  #key: Uint8Array;
  #olm = new Map<string, OlmEntry[]>();
  #own = new Map<string, OwnSession[]>();
  #inbound = new Map<string, import('../../../crypto/pkg/meadow_crypto.js').InboundGroupSession>();
  #bound = new Map<string, string>();
  #now: () => number;

  constructor(db: Db, pickleKey: Uint8Array, agent: string, now: () => number = Date.now) {
    this.#db = db;
    this.#key = pickleKey;
    this.agent = agent;
    this.#now = now;
    const row: any = db.prepare('SELECT account FROM agents WHERE id = ?').get(agent);
    if (!row) throw new Error(`unknown agent ${agent}`);
    this.account = wasm.Account.fromPickle(row.account, pickleKey);
    for (const r of db.prepare('SELECT * FROM olm_sessions WHERE agent = ? ORDER BY created').all(agent) as any[]) {
      const list = this.#olm.get(r.peer) ?? [];
      list.push({ sessionId: r.session_id, session: wasm.Session.fromPickle(r.pickle, pickleKey), created: r.created, lastDecrypt: r.last_decrypt });
      this.#olm.set(r.peer, list);
    }
    for (const r of db.prepare('SELECT * FROM group_out WHERE agent = ? ORDER BY seq').all(agent) as any[]) {
      const list = this.#own.get(r.room) ?? [];
      list.push({
        gs: wasm.GroupSession.fromPickle(r.pickle, pickleKey),
        copy: wasm.InboundGroupSession.fromPickle(r.copy, pickleKey),
        recipients: new Set(JSON.parse(r.recipients)),
        count: r.count,
        messages: JSON.parse(r.messages),
        createdAt: r.created_at,
        seq: r.seq,
      });
      this.#own.set(r.room, list);
    }
    for (const r of db.prepare('SELECT * FROM group_in WHERE agent = ?').all(agent) as any[]) {
      this.#inbound.set(`${r.room}|${r.sender}|${r.session_id}`, wasm.InboundGroupSession.fromPickle(r.pickle, pickleKey));
    }
    for (const r of db.prepare('SELECT * FROM group_bind WHERE agent = ?').all(agent) as any[]) {
      this.#bound.set(`${r.room}|${r.session_id}`, r.sender);
    }
  }

  get curve25519(): string {
    return this.account.curve25519Key;
  }

  // --- Persistence ---------------------------------------------------------

  #saveAccount() {
    this.#db.prepare('UPDATE agents SET account = ? WHERE id = ?').run(this.account.pickle(this.#key), this.agent);
  }

  #saveOlm(peer: string, e: OlmEntry) {
    this.#db.prepare(`INSERT OR REPLACE INTO olm_sessions (agent, peer, session_id, pickle, created, last_decrypt)
                      VALUES (?, ?, ?, ?, ?, ?)`).run(this.agent, peer, e.sessionId, e.session.pickle(this.#key), e.created, e.lastDecrypt);
  }

  #saveOwn(room: string, s: OwnSession) {
    this.#db.prepare(`INSERT OR REPLACE INTO group_out (agent, room, session_id, pickle, copy, recipients, count, messages, created_at, seq)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(this.agent, room, s.gs.sessionId, s.gs.pickle(this.#key), s.copy.pickle(this.#key),
        JSON.stringify([...s.recipients]), s.count, JSON.stringify(s.messages), s.createdAt, s.seq);
  }

  #saveInbound(room: string, sender: string, session: string, ig: import('../../../crypto/pkg/meadow_crypto.js').InboundGroupSession) {
    this.#db.prepare(`INSERT OR REPLACE INTO group_in (agent, room, sender, session_id, pickle, first_index, received_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(this.agent, room, sender, session, ig.pickle(this.#key), ig.firstKnownIndex, this.#now());
  }

  // --- Olm (§8.3) ------------------------------------------------------------

  hasOlmSession(peer: string): boolean {
    return (this.#olm.get(peer)?.length ?? 0) > 0;
  }

  /** Encrypts to `peer` on its preferred session, creating one from `bundle` if there is none. */
  olmEncrypt(peer: string, bundle: Bundle | undefined, plaintext: string): { agent: string; type: number; body: string } {
    const list = this.#olm.get(peer) ?? [];
    // The session that most recently decrypted from the peer, else the most recently created (§8.3).
    let entry = [...list].sort((a, b) => a.lastDecrypt - b.lastDecrypt || a.created - b.created).at(-1);
    if (!entry) {
      if (!bundle) throw new NeedBundle(peer);
      const session = this.account.createOutboundSession(bundle.curve25519, bundle.fallback);
      entry = { sessionId: session.sessionId, session, created: this.#now(), lastDecrypt: 0 };
      list.push(entry);
      this.#olm.set(peer, list);
    }
    const m = entry.session.encrypt(plaintext);
    this.#saveOlm(peer, entry);
    return { agent: peer, type: m.type, body: m.body };
  }

  /**
   * Decrypts an Olm message from `peer`. A pre-key message no existing session
   * opens starts an inbound session, checked against `curve`, the peer's
   * Curve25519 key from its verified chain. Returns null if nothing opens it.
   */
  olmDecrypt(peer: string, curve: string | undefined, msg: { type: number; body: string }): { plaintext: string; prekey: boolean } | null {
    const list = this.#olm.get(peer) ?? [];
    for (const entry of [...list].sort((a, b) => b.lastDecrypt - a.lastDecrypt || b.created - a.created)) {
      try {
        const plaintext = entry.session.decrypt(msg.type, msg.body);
        entry.lastDecrypt = this.#now();
        this.#saveOlm(peer, entry);
        return { plaintext, prekey: false };
      } catch {}
    }
    if (msg.type !== 0 || !curve) return null;
    try {
      const r = this.account.createInboundSession(curve, msg.body);
      const plaintext = r.plaintext;
      const session = r.takeSession();
      const entry = { sessionId: session.sessionId, session, created: this.#now(), lastDecrypt: this.#now() };
      list.push(entry);
      this.#olm.set(peer, list);
      this.#saveOlm(peer, entry);
      this.#saveAccount();
      return { plaintext, prekey: true };
    } catch {
      return null;
    }
  }

  /** Makes a new fallback key and returns its public half, for agent.keys (§8.2). */
  rotateFallback(): string {
    const key = this.account.generateFallbackKey();
    this.#saveAccount();
    return key;
  }

  // --- Sending (§8.4, §8.5, §8.7) ---------------------------------------------

  ownSessions(room: string): OwnSession[] {
    return this.#own.get(room) ?? [];
  }

  /** The outbound session to post with, starting a new one when §8.4 says so. */
  currentSession(room: string, now: Set<string>): { s: OwnSession; fresh: boolean } {
    const list = this.#own.get(room) ?? [];
    const cur = list.at(-1);
    const same = cur && cur.recipients.size === now.size && [...now].every((r) => cur.recipients.has(r));
    if (cur && same && cur.count < E2E_LIMITS.rotateAfterMessages && this.#now() - cur.createdAt < E2E_LIMITS.rotateAfterMs) {
      return { s: cur, fresh: false };
    }
    const gs = new wasm.GroupSession();
    // The inbound copy is taken now: a later copy cannot go back to earlier indexes (§8.4).
    const s: OwnSession = { gs, copy: gs.inboundCopy(), recipients: new Set(now), count: 0, messages: [], createdAt: this.#now(), seq: list.length };
    list.push(s);
    this.#own.set(room, list);
    this.#saveOwn(room, s);
    return { s, fresh: true };
  }

  /**
   * The contents of the room.keys events that share `s` with `to` (§8.5), up to
   * 100 recipients each. form 'export' shares the inbound copy from index
   * `from`, with the outbound session's current key as proof (§8.6).
   */
  shareContents(room: string, s: OwnSession, to: Iterable<string>, bundleOf: (peer: string) => Bundle | undefined,
    { form = 'session', from = 0 }: { form?: 'session' | 'export'; from?: number } = {}): string[] {
    const sid = s.gs.sessionId;
    const entries = [...to].map((r) => {
      const pt: Record<string, unknown> = { t: 'meadow.room_key', room, sender: this.agent, recipient: r, session: sid, form };
      if (form === 'session') pt.key = s.gs.sessionKey;
      else {
        const key = s.copy.exportAt(from);
        if (key === undefined) throw new Error(`cannot export session ${sid} at index ${from}`);
        pt.key = key;
        pt.proof = s.gs.sessionKey;
      }
      return this.olmEncrypt(r, bundleOf(r), canonicalize(pt));
    });
    const out: string[] = [];
    for (let i = 0; i < entries.length; i += E2E_LIMITS.to) {
      out.push(canonicalize({ alg: OLM, kind: 'share', session: sid, to: entries.slice(i, i + E2E_LIMITS.to) }));
    }
    return out;
  }

  /** Encrypts a message body (§8.7 steps 2 and 3). Record the event with recordOwnMessage once signed. */
  encryptPost(room: string, s: OwnSession, body: InnerBody): { content: string; commitment: string; index: number; kf: string } {
    const kf = randomBytes(32);
    const index = s.gs.messageIndex;
    const ct = s.gs.encrypt(canonicalize({ body, k_f: b64u(kf) }));
    s.count++;
    this.#saveOwn(room, s);
    return { content: canonicalize({ alg: MEGOLM, session: s.gs.sessionId, body: ct }), commitment: commitment(kf, body), index, kf: b64u(kf) };
  }

  recordOwnMessage(room: string, s: OwnSession, index: number, id: string) {
    s.messages.push({ index, id });
    this.#saveOwn(room, s);
  }

  /** The content of a key request to `owner` (§8.6). */
  requestContent(room: string, owner: string, sessions: { session: string; from: number }[], bundle: Bundle | undefined): string {
    const pt = { t: 'meadow.key_request', room, requester: this.agent, owner, sessions };
    return canonicalize({ alg: OLM, kind: 'request', to: [this.olmEncrypt(owner, bundle, canonicalize(pt))] });
  }

  /**
   * The owner's side of a request (§8.6): the lowest index M at or after
   * `from` such that the requester was a recipient before M and every later
   * message the owner sent on the session, and is a recipient now; else null.
   */
  entitlement(room: { id: string; currentState(): State; stateAt(parents: string[]): State; event(id: string): MeadowEvent | undefined },
    requester: string, session: string, from: number): number | null {
    if (!recipients(room.currentState(), this.agent).has(requester)) return null;
    const s = this.ownSessions(room.id).find((x) => x.gs.sessionId === session);
    if (!s) return null;
    const msgs = s.messages.filter((m) => m.index >= from).sort((a, b) => a.index - b.index);
    let M: number | null = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const ev = room.event(msgs[i].id);
      if (!ev || !recipients(room.stateAt(ev.header.parents), this.agent).has(requester)) break;
      M = msgs[i].index;
    }
    return M;
  }

  // --- Receiving (§8.5, §8.6, §8.7) -------------------------------------------

  /**
   * Applies a room.keys event from another member. `curveOf` gives an agent's
   * verified Curve25519 key, or undefined if none is known.
   */
  applyKeys(ev: MeadowEvent, curveOf: (agent: string) => string | undefined): KeysOutcome {
    // Served without content: withheld or expired (§9.3, §10), or not yet repaired (§11.3).
    if (ev.content === undefined) return { outcome: 'ignored:no_content' };
    const c = parse(ev.content);
    if (!isObject(c) || c.alg !== OLM || !Array.isArray(c.to)) return { outcome: 'discarded:unsupported' };
    const mine = c.to.find((e: any) => e?.agent === this.agent);
    if (!mine) return { outcome: 'ignored:not_for_me' };
    if (!Number.isSafeInteger(mine.type) || typeof mine.body !== 'string') return { outcome: 'discarded:olm' };
    const author = ev.header.author;
    const opened = this.olmDecrypt(author, curveOf(author), mine);
    const pt = parse(opened?.plaintext);
    if (!isObject(pt)) return { outcome: 'discarded:olm' };
    const prekey = opened!.prekey || undefined;
    const room = ev.header.room!;

    if (c.kind === 'request') {
      if (pt.t !== 'meadow.key_request') return { outcome: 'discarded:type', prekey };
      if (pt.room !== room) return { outcome: 'discarded:room', prekey };
      if (pt.requester !== author) return { outcome: 'discarded:requester', prekey };
      if (pt.owner !== this.agent) return { outcome: 'discarded:owner', prekey };
      const sessions = pt.sessions;
      if (!Array.isArray(sessions) || sessions.length < 1 || sessions.length > E2E_LIMITS.sessionsPerRequest ||
          !sessions.every((q: any) => isObject(q) && typeof q.session === 'string' && Number.isSafeInteger(q.from) && q.from >= 0)) {
        return { outcome: 'discarded:sessions', prekey };
      }
      return { outcome: 'request', prekey, request: { requester: author, sessions: sessions.map((q: any) => ({ session: q.session, from: q.from })) } };
    }
    if (c.kind !== 'share') return { outcome: 'discarded:unsupported', prekey };
    if (pt.t !== 'meadow.room_key') return { outcome: 'discarded:type', prekey };
    if (pt.room !== room) return { outcome: 'discarded:room', prekey };
    if (pt.sender !== author) return { outcome: 'discarded:sender', prekey };
    if (pt.recipient !== this.agent) return { outcome: 'discarded:recipient', prekey };

    let proof, ig;
    try {
      if (pt.form === 'session') {
        proof = new wasm.InboundGroupSession(pt.key);
        ig = new wasm.InboundGroupSession(pt.key);
      } else if (pt.form === 'export') {
        proof = new wasm.InboundGroupSession(pt.proof);
        ig = wasm.InboundGroupSession.import(pt.key);
      } else return { outcome: 'discarded:form', prekey };
    } catch {
      return { outcome: 'discarded:proof', prekey };
    }
    if (pt.session !== c.session || ig.sessionId !== pt.session || proof.sessionId !== pt.session) return { outcome: 'discarded:session', prekey };
    const bindKey = `${room}|${pt.session}`;
    const boundTo = this.#bound.get(bindKey);
    if (boundTo && boundTo !== author) return { outcome: 'discarded:bound', prekey };
    if (!boundTo) {
      this.#bound.set(bindKey, author);
      this.#db.prepare('INSERT OR REPLACE INTO group_bind (agent, room, session_id, sender) VALUES (?, ?, ?, ?)').run(this.agent, room, pt.session, author);
    }
    const k = `${room}|${author}|${pt.session}`;
    const have = this.#inbound.get(k);
    if (!have || ig.firstKnownIndex < have.firstKnownIndex) {
      this.#inbound.set(k, ig);
      this.#saveInbound(room, author, pt.session, ig);
    }
    return { outcome: 'accepted', prekey, share: { sender: author, session: pt.session } };
  }

  /** Decrypts an encrypted msg.post with the session stored under its own author (§8.7). */
  decrypt(ev: MeadowEvent): Decryption {
    const c = parse(ev.content);
    if (!isObject(c) || c.alg !== MEGOLM || typeof c.session !== 'string' || typeof c.body !== 'string') return { status: 'unsupported' };
    let index: number | undefined;
    try {
      index = wasm.megolmMessageIndex(c.body);
    } catch {}
    const k = `${ev.header.room}|${ev.header.author}|${c.session}`;
    const ig = this.#inbound.get(k);
    if (!ig) return { status: 'missing_key', session: c.session, index };
    if (index === undefined) return { status: 'undecryptable', session: c.session };
    // A session held from a later index does not cover this message: its key is still missing.
    if (index < ig.firstKnownIndex) return { status: 'missing_key', session: c.session, index };
    try {
      const d = ig.decrypt(c.body);
      return { status: 'decrypted', session: c.session, index: d.messageIndex, slot: `${k}|${d.messageIndex}`, plaintext: d.plaintext };
    } catch {
      return { status: 'undecryptable', session: c.session, index };
    }
  }
}
