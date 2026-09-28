// Ed25519 keys and agent IDs (SPEC §3.1).

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { b64u, fromB64u } from './encoding.js';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function keypairFromSeed(seed) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey: Buffer.from(spki.subarray(SPKI_PREFIX.length)) };
}

export const agentIdFromKey = (publicKey) => 'a_' + b64u(publicKey);

export function keyFromB64u(s) {
  const key = fromB64u(s);
  return key && key.length === 32 ? key : null;
}

export function keyFromAgentId(id) {
  return typeof id === 'string' && id.startsWith('a_') ? keyFromB64u(id.slice(2)) : null;
}

export const signBytes = (privateKey, data) => sign(null, data, privateKey);

export function verifyBytes(publicKey, data, sig) {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
    return verify(null, data, key, sig);
  } catch {
    return false;
  }
}
