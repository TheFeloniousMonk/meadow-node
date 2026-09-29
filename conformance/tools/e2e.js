// A reference implementation of end-to-end encryption (SPEC §8), used to build
// and check the conformance vectors in conformance/vectors/e2e/. Olm and Megolm
// come from vodozemac through the meadow-crypto binding (crypto/pkg); nothing
// here implements a primitive.
//
// An E2EClient is one agent's encryption state. Its sending side builds events
// through a Builder (one Builder per room); its receiving side applies §8's
// checks to a list of events and returns a status per event.

import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { b64u, canonicalize, fromB64u } from '../../backend/src/proto/encoding.js';
import { commitment } from '../../backend/src/proto/report.js';

const require = createRequire(import.meta.url);
export const wasm = require('../../crypto/pkg/meadow_crypto.js');

// Vectors pickle state with a published key; a real client keeps its key secret.
export const PICKLE_KEY = new Uint8Array(32);

export const OLM = 'olm.v1';
export const MEGOLM = 'megolm.v1';
const MAX_TO = 100;
const MAX_SESSIONS_PER_REQUEST = 50;
const ROTATE_AFTER = 100;

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// The recipients of a room in a state (§8.4): members with membership join or
// invite, plus a DM's dm_with while it has no membership event; never `self`.
export function recipients(state, self) {
  const out = new Set();
  const create = state.get('room.create|');
  for (const [k, ev] of state) {
    if (!k.startsWith('room.member|')) continue;
    if (['join', 'invite'].includes(ev.header.data.membership)) out.add(ev.header.data.target);
  }
  const dmWith = create?.header.data.dm_with;
  if (dmWith && !state.has(`room.member|${dmWith}`)) out.add(dmWith);
  out.delete(self);
  return out;
}

export class E2EClient {
  constructor(agent) {
    this.agent = agent; // a Builder agent: { name, id, keys }
    this.account = new wasm.Account();
    this.bundle = { curve25519: this.account.curve25519Key, fallback: this.account.generateFallbackKey() };
    this.olm = new Map(); // peer agent ID -> [{ session, used }], most recently used last
    this.own = new Map(); // room ID -> [{ gs, copy, recipients, count, messages: [{ index, id }] }], current last
    this.inbound = new Map(); // `${room}|${sender}|${session}` -> InboundGroupSession
    this.bound = new Map(); // `${room}|${session}` -> sender bound to that session ID
    this.processed = new Set(); // room.keys event IDs already applied
    this.tick = 0;
  }

  get id() {
    return this.agent.id;
  }

  // --- Olm (§8.3) ---------------------------------------------------------

  _olmSend(peer, bundles, plaintext) {
    const list = this.olm.get(peer) ?? [];
    let entry = list.at(-1);
    if (!entry) {
      const b = bundles[peer];
      entry = { session: this.account.createOutboundSession(b.curve25519, b.fallback), used: 0 };
      list.push(entry);
      this.olm.set(peer, list);
    }
    entry.used = ++this.tick;
    const m = entry.session.encrypt(plaintext);
    return { agent: peer, type: m.type, body: m.body };
  }

  // Sends an arbitrary plaintext over Olm, for vectors that forge a share.
  olmSendForTest(peer, bundles, plaintext) {
    return this._olmSend(peer, bundles, plaintext);
  }

  // Decrypts an Olm message from `peer`, whose verified Curve25519 key is `curve`.
  _olmReceive(peer, curve, msg) {
    const list = this.olm.get(peer) ?? [];
    for (const entry of [...list].reverse()) {
      try {
        const pt = entry.session.decrypt(msg.type, msg.body);
        entry.used = ++this.tick;
        list.sort((a, b) => a.used - b.used);
        return pt;
      } catch {}
    }
    if (msg.type !== 0) return null;
    try {
      const r = this.account.createInboundSession(curve, msg.body);
      list.push({ session: r.takeSession(), used: ++this.tick });
      this.olm.set(peer, list);
      return r.plaintext;
    } catch {
      return null;
    }
  }

  // --- Sending (§8.4, §8.5, §8.7) -----------------------------------------

  // The current outbound session for the builder's room, rotating when §8.4 says so.
  // opts.noRotate keeps the current session even if the recipients changed (a
  // non-conforming sender, used only to build entitlement vectors).
  _session(b, opts = {}) {
    const room = b.room.id;
    const now = recipients(b.room.stateAt(b.room.heads()), this.id);
    const list = this.own.get(room) ?? [];
    const cur = list.at(-1);
    const same = cur && cur.recipients.size === now.size && [...now].every((r) => cur.recipients.has(r));
    if (cur && (same || opts.noRotate) && cur.count < ROTATE_AFTER) return { s: cur, fresh: false };
    const gs = new wasm.GroupSession();
    const s = { gs, copy: gs.inboundCopy(), recipients: now, count: 0, messages: [] };
    list.push(s);
    this.own.set(room, list);
    return { s, fresh: true };
  }

  _shareContent(room, s, to, bundles, { form = 'session', from = 0, tamper } = {}) {
    const sid = s.gs.sessionId;
    const entries = [...to].map((r) => {
      let pt = { t: 'meadow.room_key', room, sender: this.id, recipient: r, session: sid, form };
      if (form === 'session') pt.key = s.gs.sessionKey;
      else pt = { ...pt, key: s.copy.exportAt(from), proof: s.gs.sessionKey };
      if (tamper) pt = tamper(pt);
      return this._olmSend(r, bundles, canonicalize(pt));
    });
    if (entries.length > MAX_TO) throw new Error('too many recipients for one room.keys event');
    return canonicalize({ alg: OLM, kind: 'share', session: sid, to: entries });
  }

  // Shares the current session with every recipient (§8.5). Returns the event ID.
  share(b, label, bundles, opts = {}) {
    const { s } = this._session(b, opts);
    const to = opts.to ?? s.recipients;
    return b.add(label, this.agent, 'room.keys', { content: this._shareContent(b.room.id, s, to, bundles, opts) });
  }

  // Posts an encrypted message (§8.7): rotates and shares first if needed.
  // opts: shareLabel (label for an automatic share), text tampering hooks.
  post(b, label, text, bundles, opts = {}) {
    const { s, fresh } = this._session(b, opts);
    if (fresh && !opts.skipShare) {
      b.add(opts.shareLabel ?? `${label}-keys`, this.agent, 'room.keys', { content: this._shareContent(b.room.id, s, s.recipients, bundles) });
    }
    const body = { text };
    const kf = randomBytes(32);
    const index = s.gs.messageIndex;
    const inner = canonicalize({ body: opts.innerBody ?? body, k_f: b64u(kf) });
    const content = canonicalize({ alg: opts.alg ?? MEGOLM, session: s.gs.sessionId, body: opts.corrupt ? opts.corrupt(s.gs.encrypt(inner)) : s.gs.encrypt(inner) });
    const commit = opts.commitmentOf ? commitment(kf, opts.commitmentOf) : commitment(kf, body);
    const id = b.add(label, this.agent, 'msg.post', { content, patch: (h) => { h.commitment = commit; } });
    s.count++;
    s.messages.push({ index, id });
    return id;
  }

  // Posts `content` copied from another event, as this agent (a replay).
  repost(b, label, fromId) {
    const src = b.room.event(fromId);
    const content = b.steps.find((st) => st.event.id === fromId).event.content;
    return b.add(label, this.agent, 'msg.post', { content, patch: (h) => { h.commitment = src.header.commitment; } });
  }

  // A key request to `owner` for `sessions` [{ session, from }] (§8.6).
  request(b, label, owner, sessions, bundles, { tamper, parents } = {}) {
    if (sessions.length > MAX_SESSIONS_PER_REQUEST) throw new Error('too many sessions');
    let pt = { t: 'meadow.key_request', room: b.room.id, requester: this.id, owner, sessions };
    if (tamper) pt = tamper(pt);
    const content = canonicalize({ alg: OLM, kind: 'request', to: [this._olmSend(owner, bundles, canonicalize(pt))] });
    return b.add(label, this.agent, 'room.keys', { content, ...(parents && { parents }) });
  }

  // The owner's side of a request (§8.6): for each session asked for, the index
  // M to share from, or null. `room` is the owner's Room.
  entitlement(room, requester, session, from) {
    const now = recipients(room.currentState(), this.id);
    if (!now.has(requester)) return null;
    const s = (this.own.get(room.id) ?? []).find((x) => x.gs.sessionId === session);
    if (!s) return null;
    const msgs = s.messages.filter((m) => m.index >= from).sort((a, b) => a.index - b.index);
    let M = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const ev = room.event(msgs[i].id);
      if (!recipients(room.stateAt(ev.header.parents), this.id).has(requester)) break;
      M = msgs[i].index;
    }
    return M;
  }

  // Answers a request (decrypted by receive()) with a share from M, if entitled.
  answer(b, label, requester, sessions, bundles) {
    const out = {};
    let shared = false;
    for (const { session, from } of sessions) {
      const M = this.entitlement(b.room, requester, session, from);
      out[session] = M;
      if (M === null) continue;
      const s = this.own.get(b.room.id).find((x) => x.gs.sessionId === session);
      b.add(`${label}-${session.slice(0, 6)}`, this.agent, 'room.keys', {
        content: this._shareContent(b.room.id, s, [requester], bundles, { form: 'export', from: M }),
      });
      shared = true;
    }
    return { answers: out, shared };
  }

  // --- Receiving (§8.5, §8.6, §8.7) ---------------------------------------

  // Applies §8's checks to `events` (in order) of one room of type `roomType`.
  // Returns { statuses: id -> status, requests: id -> { requester, sessions } }.
  // bundles[agent] = { curve25519, fallback }: the verified key bundles.
  receive(events, roomType, bundles) {
    const statuses = new Map();
    const requests = new Map();
    const decrypted = new Map(); // msg id -> { key, index, plaintext }
    const pending = [];

    const tryMessage = (ev) => {
      const c = parse(ev.content ?? '');
      if (!isObject(c) || c.alg !== MEGOLM) return { status: 'unsupported' };
      const k = `${ev.header.room}|${ev.header.author}|${c.session}`;
      const ig = this.inbound.get(k);
      if (!ig) return { status: 'missing_key' };
      let index;
      try {
        index = wasm.megolmMessageIndex(c.body);
      } catch {
        return { status: 'undecryptable' };
      }
      // A session held from a later index does not cover this message: its key is still missing.
      if (index < ig.firstKnownIndex) return { status: 'missing_key' };
      try {
        const d = ig.decrypt(c.body);
        return { status: 'decrypted', key: `${k}|${d.messageIndex}`, plaintext: d.plaintext };
      } catch {
        return { status: 'undecryptable' };
      }
    };

    for (const ev of events) {
      const h = ev.header;
      if (h.author === this.id) continue;
      if (h.kind === 'room.keys') {
        if (roomType === 'public') continue;
        if (this.processed.has(ev.id)) continue;
        statuses.set(ev.id, this._applyKeys(ev, bundles, requests));
        this.processed.add(ev.id);
        for (let i = pending.length - 1; i >= 0; i--) {
          const r = tryMessage(pending[i]);
          if (r.status !== 'missing_key') {
            if (r.status === 'decrypted') decrypted.set(pending[i].id, r);
            else statuses.set(pending[i].id, r.status);
            pending.splice(i, 1);
          }
        }
      } else if (h.kind === 'msg.post' && roomType !== 'public') {
        const r = tryMessage(ev);
        if (r.status === 'decrypted') decrypted.set(ev.id, r);
        else {
          statuses.set(ev.id, r.status);
          if (r.status === 'missing_key') pending.push(ev);
        }
      }
    }
    for (const ev of pending) statuses.set(ev.id, 'missing_key');

    // Replays: of the events at one (session, index), the lowest event ID wins.
    const byKey = new Map();
    for (const [id, r] of decrypted) byKey.set(r.key, [...(byKey.get(r.key) ?? []), id]);
    const eventOf = new Map(events.map((e) => [e.id, e]));
    for (const ids of byKey.values()) {
      ids.sort();
      for (const id of ids.slice(1)) statuses.set(id, 'replayed');
      const id = ids[0];
      const inner = parse(decrypted.get(id).plaintext);
      const ev = eventOf.get(id);
      const body = inner?.body;
      const kf = typeof inner?.k_f === 'string' ? fromB64u(inner.k_f) : null;
      const valid = isObject(inner) && Object.keys(inner).length === 2 && isObject(body) && typeof body.text === 'string' && kf?.length === 32;
      if (!valid || commitment(kf, body) !== ev.header.commitment) statuses.set(id, 'bad_commitment');
      else statuses.set(id, `shown:${body.text}`);
    }
    return { statuses, requests };
  }

  _applyKeys(ev, bundles, requests) {
    // Served without content: withheld or expired (§9.3, §10), or not yet repaired (§11.3).
    if (ev.content === undefined) return 'ignored:no_content';
    const c = parse(ev.content);
    if (!isObject(c) || c.alg !== OLM || !Array.isArray(c.to)) return 'discarded:unsupported';
    const mine = c.to.find((e) => e?.agent === this.id);
    if (!mine) return 'ignored:not_for_me';
    const author = ev.header.author;
    const pt = parse(this._olmReceive(author, bundles[author].curve25519, mine));
    if (!isObject(pt)) return 'discarded:olm';
    const room = ev.header.room;

    if (c.kind === 'request') {
      if (pt.t !== 'meadow.key_request') return 'discarded:type';
      if (pt.room !== room) return 'discarded:room';
      if (pt.requester !== author) return 'discarded:requester';
      if (pt.owner !== this.id) return 'discarded:owner';
      if (!Array.isArray(pt.sessions) || pt.sessions.length < 1 || pt.sessions.length > MAX_SESSIONS_PER_REQUEST) return 'discarded:sessions';
      requests.set(ev.id, { requester: author, sessions: pt.sessions });
      return 'request';
    }
    if (c.kind !== 'share') return 'discarded:unsupported';
    if (pt.t !== 'meadow.room_key') return 'discarded:type';
    if (pt.room !== room) return 'discarded:room';
    if (pt.sender !== author) return 'discarded:sender';
    if (pt.recipient !== this.id) return 'discarded:recipient';

    let proof;
    let ig;
    try {
      if (pt.form === 'session') {
        proof = new wasm.InboundGroupSession(pt.key);
        ig = new wasm.InboundGroupSession(pt.key);
      } else if (pt.form === 'export') {
        proof = new wasm.InboundGroupSession(pt.proof);
        ig = wasm.InboundGroupSession.import(pt.key);
      } else return 'discarded:form';
    } catch {
      return 'discarded:proof';
    }
    if (pt.session !== c.session || ig.sessionId !== pt.session || proof.sessionId !== pt.session) return 'discarded:session';
    const bindKey = `${room}|${pt.session}`;
    const boundTo = this.bound.get(bindKey);
    if (boundTo && boundTo !== author) return 'discarded:bound';
    this.bound.set(bindKey, author);
    const k = `${room}|${author}|${pt.session}`;
    const have = this.inbound.get(k);
    if (!have || ig.firstKnownIndex < have.firstKnownIndex) this.inbound.set(k, ig);
    return 'accepted';
  }

  // --- State for vectors ----------------------------------------------------

  snapshot() {
    const key = PICKLE_KEY;
    return {
      account: this.account.pickle(key),
      olm: Object.fromEntries([...this.olm].map(([p, l]) => [p, l.map((e) => e.session.pickle(key))])),
      own: Object.fromEntries([...this.own].map(([r, l]) => [r, l.map((s) => ({
        gs: s.gs.pickle(key), copy: s.copy.pickle(key), recipients: [...s.recipients], count: s.count, messages: s.messages,
      }))])),
      inbound: Object.fromEntries([...this.inbound].map(([k, ig]) => [k, ig.pickle(key)])),
      bound: Object.fromEntries(this.bound),
      processed: [...this.processed],
    };
  }

  static fromSnapshot(agent, snap) {
    const key = PICKLE_KEY;
    const c = Object.create(E2EClient.prototype);
    c.agent = agent;
    c.account = wasm.Account.fromPickle(snap.account, key);
    c.bundle = null;
    c.olm = new Map(Object.entries(snap.olm).map(([p, l]) => [p, l.map((x, i) => ({ session: wasm.Session.fromPickle(x, key), used: i }))]));
    c.own = new Map(Object.entries(snap.own).map(([r, l]) => [r, l.map((s) => ({
      gs: wasm.GroupSession.fromPickle(s.gs, key), copy: wasm.InboundGroupSession.fromPickle(s.copy, key),
      recipients: new Set(s.recipients), count: s.count, messages: s.messages,
    }))]));
    c.inbound = new Map(Object.entries(snap.inbound).map(([k, p]) => [k, wasm.InboundGroupSession.fromPickle(p, key)]));
    c.bound = new Map(Object.entries(snap.bound));
    c.processed = new Set(snap.processed);
    c.tick = 1_000_000;
    return c;
  }
}
