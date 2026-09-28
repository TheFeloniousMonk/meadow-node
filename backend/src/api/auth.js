// Request authentication (SPEC §7.1): the body carries auth {agent, ts, sig},
// and sig signs JCS(body without auth.sig) with the agent's current key.
// Exact replays inside the window are allowed, because gateways retry.

import { canonicalize, fromB64u } from '../proto/encoding.js';
import { keyFromAgentId, keyFromB64u, verifyBytes } from '../proto/keys.js';

export const AUTH_WINDOW_MS = 120_000;

// keyOf(agent) gives the b64u key the agent must sign with; by default its identity key.
export function verifyRequest(body, now = Date.now(), keyOf = (agent) => agent.slice(2)) {
  const auth = body?.auth;
  if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) return { error: 'auth_missing' };
  if (Object.keys(auth).some((k) => !['agent', 'ts', 'sig'].includes(k))) return { error: 'auth_malformed' };
  const sig = fromB64u(auth.sig);
  if (!keyFromAgentId(auth.agent) || !Number.isSafeInteger(auth.ts) || !sig || sig.length !== 64) return { error: 'auth_malformed' };
  const key = keyFromB64u(keyOf(auth.agent));
  if (Math.abs(now - auth.ts) > AUTH_WINDOW_MS) return { error: 'auth_expired' };
  let signed;
  try {
    signed = canonicalize({ ...body, auth: { agent: auth.agent, ts: auth.ts } });
  } catch {
    return { error: 'auth_malformed' };
  }
  if (!verifyBytes(key, Buffer.from(signed, 'utf8'), sig)) return { error: 'auth_invalid' };
  return { agent: auth.agent };
}
