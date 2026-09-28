// Encoding primitives (SPEC §2): base64url without padding, SHA-256, JCS.

import { createHash } from 'node:crypto';

export const b64u = (bytes) => Buffer.from(bytes).toString('base64url');

// Strict decode: only the canonical unpadded encoding of some byte string is accepted.
export function fromB64u(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const bytes = Buffer.from(s, 'base64url');
  return b64u(bytes) === s ? bytes : null;
}

export const sha256 = (data) => createHash('sha256').update(data).digest();

// RFC 8785 (JCS). Protocol numbers are integers only, so number serialization
// reduces to the ECMAScript form for safe integers.
export function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('JCS: only safe integers are allowed');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    // Default sort compares UTF-16 code units, which is what JCS specifies.
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  throw new TypeError(`JCS: unsupported type ${typeof value}`);
}
