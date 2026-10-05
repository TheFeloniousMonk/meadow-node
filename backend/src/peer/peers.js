// Peer nodes (SPEC §11.1) and request signing between them (§11.2).
//
// Peers are found from the chain (discovery.js); MEADOW_PEERS can add more,
// for development. A node accepts peer requests only from nodes in its set.

import { b64u, canonicalize, fromB64u } from '../proto/encoding.js';
import { keyFromB64u, signBytes, verifyBytes } from '../proto/keys.js';
import { AUTH_WINDOW_MS } from '../api/auth.js';

export const BAN_THRESHOLD = 50;
// A ban lasts an hour, doubling with each further ban of the same peer, at most a day
// (§17 q13 m): one bug or one bad hour must not cut two honest nodes apart until a restart.
export const BAN_MS = 60 * 60 * 1000;
export const BAN_MAX_MS = 24 * 60 * 60 * 1000;

const NODE_ID = /^n_[A-Za-z0-9_-]{43}$/;
export const nodeKey = (id) => (typeof id === 'string' && NODE_ID.test(id) ? keyFromB64u(id.slice(2)) : null);
export const shortId = (id) => (typeof id === 'string' ? id.slice(0, 10) + '…' : String(id));

export class Peers {
  #peers = new Map();
  #log;
  #now;

  // opts.log: where penalties and bans are logged (console); opts.now: the clock (tests).
  constructor(list = [], opts = {}) {
    this.#log = opts.log ?? console;
    this.#now = opts.now ?? Date.now;
    for (const p of list) this.add(p);
  }

  // "n_…@https://host/meadow-peer, n_…@https://…"
  static parse(spec = '') {
    return spec.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
      const at = entry.indexOf('@');
      const id = entry.slice(0, at);
      const url = entry.slice(at + 1).replace(/\/+$/, '');
      if (at < 0 || !nodeKey(id) || !/^https?:\/\//.test(url)) throw new Error(`bad peer "${entry}": expected n_<node key>@<url>`);
      return { id, url };
    });
  }

  // Adding a known peer updates its URL and keeps its score.
  add({ id, url, source = 'config' }) {
    const known = this.#peers.get(id);
    if (known) Object.assign(known, { url, source });
    else {
      this.#peers.set(id, {
        id, url, source, penalty: 0, banned: false, bannedUntil: null, bans: 0, lastPenalty: null,
        lastOk: null, lastError: null, failures: 0, addedAt: this.#now(),
      });
    }
  }

  remove(id) {
    this.#peers.delete(id);
  }

  // An expired ban is lifted when the peer is next looked at, with its penalty cleared.
  #refresh(p) {
    if (p?.banned && p.bannedUntil !== null && this.#now() >= p.bannedUntil) {
      Object.assign(p, { banned: false, bannedUntil: null, penalty: 0 });
      this.#log.log?.(`peer ${shortId(p.id)}: ban expired, accepted again`);
    }
    return p;
  }

  get(id) {
    return this.#refresh(this.#peers.get(id)) ?? null;
  }

  all() {
    return [...this.#peers.values()].map((p) => this.#refresh(p));
  }

  // Peers in good standing.
  active() {
    return this.all().filter((p) => !p.banned);
  }

  // A peer that sends invalid events is scored down and banned for a while (§11.4).
  // `reason` says what it sent: an invalid event's reason, bad_report, reply_too_large, content_mismatch.
  penalize(id, points = 1, reason = 'unspecified') {
    const p = this.get(id);
    if (!p || p.banned) return;
    p.penalty += points;
    p.lastPenalty = { reason, at: this.#now() };
    this.#log.warn?.(`peer ${shortId(id)}: penalty +${points} (${reason}), ${p.penalty}/${BAN_THRESHOLD}`);
    if (p.penalty >= BAN_THRESHOLD) {
      p.bans++;
      const ms = Math.min(BAN_MS * 2 ** (p.bans - 1), BAN_MAX_MS);
      Object.assign(p, { banned: true, bannedUntil: this.#now() + ms });
      this.#log.warn?.(`peer ${shortId(id)}: banned for ${Math.round(ms / 60_000)} min after ${p.penalty} penalty points (last: ${reason})`);
    }
  }

  // A successful exchange with a peer, in either direction.
  noteOk(id) {
    const p = this.#peers.get(id);
    if (p) Object.assign(p, { lastOk: this.#now(), failures: 0 });
  }

  // A failed call to a peer: kept, in a few words, for the health report (§9.6).
  noteFail(id, err) {
    const p = this.#peers.get(id);
    if (!p) return;
    p.failures++;
    p.lastError = { text: String(err?.message ?? err).slice(0, 200), at: this.#now() };
  }
}

// Body with auth {node, ts, sig}; sig signs JCS(body without auth.sig) with the node key.
export function signPeer(node, fields, now = Date.now()) {
  const body = { ...fields, auth: { node: node.id, ts: now } };
  body.auth.sig = b64u(signBytes(node.privateKey, Buffer.from(canonicalize(body), 'utf8')));
  return body;
}

export function verifyPeer(body, peers, now = Date.now()) {
  const auth = body?.auth;
  if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) return { error: 'auth_missing' };
  const key = nodeKey(auth.node);
  const sig = fromB64u(auth.sig);
  if (Object.keys(auth).some((k) => !['node', 'ts', 'sig'].includes(k)) || !key ||
      !Number.isSafeInteger(auth.ts) || !sig || sig.length !== 64) return { error: 'auth_malformed' };
  const peer = peers.get(auth.node);
  if (peer?.banned) return { error: 'unknown_peer' };
  if (Math.abs(now - auth.ts) > AUTH_WINDOW_MS) return { error: peer ? 'auth_expired' : 'unknown_peer' };
  let signed;
  try {
    signed = canonicalize({ ...body, auth: { node: auth.node, ts: auth.ts } });
  } catch {
    return { error: peer ? 'auth_malformed' : 'unknown_peer' };
  }
  const valid = verifyBytes(key, Buffer.from(signed, 'utf8'), sig);
  // A node this one does not know yet: refused, but a valid signature says so (`signed`),
  // which lets discovery run early (§11.1). The answer is the same either way.
  if (!peer) return { error: 'unknown_peer', ...(valid && { signed: auth.node }) };
  if (!valid) return { error: 'auth_invalid' };
  return { node: auth.node };
}
