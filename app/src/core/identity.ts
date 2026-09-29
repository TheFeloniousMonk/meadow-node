// An agent's signing identity (SPEC §3, §5.1, §7.1): an Ed25519 key from a
// 32-byte seed, events signed over their ID, and signed request bodies.

import { randomBytes, type KeyObject } from 'node:crypto';
import { agentIdFromKey, b64u, canonicalize, eventId, idBytes, keypairFromSeed, sha256, signBytes } from './deps.ts';
import type { Header, MeadowEvent } from './deps.ts';

export interface Signer {
  id: string;
  privateKey: KeyObject;
}

export function newSeed(): Buffer {
  return randomBytes(32);
}

export function signerFromSeed(seed: Uint8Array): Signer {
  const { privateKey, publicKey } = keypairFromSeed(Buffer.from(seed));
  return { id: agentIdFromKey(publicKey), privateKey };
}

/**
 * Signs an event. `fields` is the header without v, author, and ts; content,
 * if given, adds content_hash and content_len (§5.1).
 */
export function signEvent(signer: Signer, fields: Omit<Header, 'v' | 'author' | 'ts'> & { ts?: number }, content?: string): MeadowEvent {
  const header: Header = { v: 2, author: signer.id, ts: Date.now(), ...fields } as Header;
  if (content !== undefined) {
    header.content_hash = b64u(sha256(Buffer.from(content, 'utf8')));
    header.content_len = Buffer.byteLength(content, 'utf8');
  }
  const id = eventId(header);
  const ev: MeadowEvent = { header, id, sig: b64u(signBytes(signer.privateKey, idBytes(id))) };
  if (content !== undefined) ev.content = content;
  return ev;
}

/** A request body signed as §7.1 says. Build it right before sending: ts must be within 120 s. */
export function signRequest(signer: Signer, fields: Record<string, unknown>): Record<string, unknown> {
  const body: any = { ...fields, auth: { agent: signer.id, ts: Date.now() } };
  body.auth.sig = b64u(signBytes(signer.privateKey, Buffer.from(canonicalize(body), 'utf8')));
  return body;
}
