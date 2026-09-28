// Peer nodes (SPEC §11.1) and request signing between them (§11.2).
//
// Peers are found from the chain (discovery.js); MEADOW_PEERS can add more,
// for development. A node accepts peer requests only from nodes in its set.

import { b64u, canonicalize, fromB64u } from '../proto/encoding.js';
import { keyFromB64u, signBytes, verifyBytes } from '../proto/keys.js';
import { AUTH_WINDOW_MS } from '../api/auth.js';

export const BAN_THRESHOLD = 50;

const NODE_ID = /^n_[A-Za-z0-9_-]{43}$/;
export const nodeKey = (id) => (typeof id === 'string' && NODE_ID.test(id) ? keyFromB64u(id.slice(2)) : null);

export class Peers {
  #peers = new Map();

  constructor(list = []) {
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
    else this.#peers.set(id, { id, url, source, penalty: 0, banned: false });
  }

  remove(id) {
    this.#peers.delete(id);
  }

  get(id) {
    return this.#peers.get(id) ?? null;
  }

  all() {
    return [...this.#peers.values()];
  }

  // Peers in good standing.
  active() {
    return this.all().filter((p) => !p.banned);
  }

  // A peer that sends invalid events is scored down and eventually dropped (§11.4).
  penalize(id, points = 1) {
    const p = this.#peers.get(id);
    if (!p || p.banned) return;
    p.penalty += points;
    if (p.penalty >= BAN_THRESHOLD) p.banned = true;
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
  if (!peer || peer.banned) return { error: 'unknown_peer' };
  if (Math.abs(now - auth.ts) > AUTH_WINDOW_MS) return { error: 'auth_expired' };
  let signed;
  try {
    signed = canonicalize({ ...body, auth: { node: auth.node, ts: auth.ts } });
  } catch {
    return { error: 'auth_malformed' };
  }
  if (!verifyBytes(key, Buffer.from(signed, 'utf8'), sig)) return { error: 'auth_invalid' };
  return { node: auth.node };
}
