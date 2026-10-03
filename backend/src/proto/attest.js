// Head attestations (SPEC §7.10): a node's signed statement of the heads it
// holds for the rooms an answer covers, at a moment, for a caller. Clients
// compare them across nodes to catch withholding (§11.6). The node key is in
// the node ID, so an attestation checks with nothing else.

import { b64u, canonicalize, fromB64u } from './encoding.js';
import { keyFromB64u, signBytes, verifyBytes } from './keys.js';

export const ATTEST_PREFIX = 'meadow-attestation-v1\n';
export const ATTEST_LIMITS = { rooms: 500, heads: 20 };

const NODE_ID = /^n_[A-Za-z0-9_-]{43}$/;
const AGENT_ID = /^a_[A-Za-z0-9_-]{43}$/;
const ROOM_ID = /^r_[A-Za-z0-9_-]{43}$/;
const EVENT_ID = /^e_[A-Za-z0-9_-]{43}$/;

const signedBytes = (att) => Buffer.from(ATTEST_PREFIX + canonicalize(att), 'utf8');

/** Heads as attested: sorted, at most ATTEST_LIMITS.heads (the lowest IDs). */
export const attestedHeads = (heads) => [...heads].sort().slice(0, ATTEST_LIMITS.heads);

/** node: { id, privateKey }. rooms: room ID -> heads, already in attested form. */
export function signAttestation(node, agent, ts, rooms) {
  const att = { node: node.id, agent, ts, rooms };
  return { ...att, sig: b64u(signBytes(node.privateKey, signedBytes(att))) };
}

/** null when the attestation is well-formed and its signature verifies, else a reason. */
export function checkAttestation(att) {
  if (att === null || typeof att !== 'object' || Array.isArray(att)) return 'malformed';
  const { node, agent, ts, rooms, sig, ...extra } = att;
  if (Object.keys(extra).length || !NODE_ID.test(node ?? '') || !AGENT_ID.test(agent ?? '') || !Number.isSafeInteger(ts) ||
      rooms === null || typeof rooms !== 'object' || Array.isArray(rooms) || typeof sig !== 'string') return 'malformed';
  const entries = Object.entries(rooms);
  if (entries.length > ATTEST_LIMITS.rooms) return 'malformed';
  for (const [room, heads] of entries) {
    if (!ROOM_ID.test(room) || !Array.isArray(heads) || heads.length > ATTEST_LIMITS.heads) return 'malformed';
    for (let i = 0; i < heads.length; i++) {
      if (typeof heads[i] !== 'string' || !EVENT_ID.test(heads[i]) || (i > 0 && heads[i - 1] >= heads[i])) return 'malformed';
    }
  }
  const key = keyFromB64u(node.slice(2));
  const bytes = fromB64u(sig);
  if (!key || !bytes || bytes.length !== 64) return 'malformed';
  return verifyBytes(key, signedBytes({ node, agent, ts, rooms }), bytes) ? null : 'bad_signature';
}
