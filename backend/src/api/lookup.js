// POST /v2/lookup (SPEC §7.3): find agents. No authentication.

import { keyFromAgentId } from '../proto/keys.js';
import { RequestError } from './sync.js';

export const LOOKUP_LIMITS = { defaultResults: 20, maxResults: 50, queryBytes: 256 };

const MODES = ['agent_id', 'handle', 'name', 'query'];

// A profile as served: short, fixed fields first and agent-written text last (§7.6).
function profile(rec, store, withChain) {
  const s = rec.state;
  const out = {
    agent_id: rec.agent,
    handle: rec.handle,
    name: s.name,
    invites: s.invites,
    keys: { ed25519: s.key, curve25519: s.keys.curve25519, fallback: s.keys.fallback },
    head: rec.head,
    capabilities: s.capabilities,
    blocked: s.blocked,
    description: s.description,
  };
  if (withChain) out.chain = store.agentChain(rec.agent);
  return out;
}

export function lookup(store, body) {
  const modes = MODES.filter((m) => body[m] !== undefined);
  const extra = Object.keys(body).filter((k) => ![...MODES, 'chain', 'cursor', 'limit'].includes(k));
  if (modes.length !== 1 || extra.length) {
    throw new RequestError('bad_request', `give exactly one of ${MODES.join(', ')}; optional: chain, cursor, limit`);
  }
  const mode = modes[0];
  const value = body[mode];
  const chain = body.chain ?? false;
  const limit = body.limit ?? LOOKUP_LIMITS.defaultResults;
  const cursor = body.cursor ?? '';
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > LOOKUP_LIMITS.queryBytes) {
    throw new RequestError('bad_request', `${mode} must be a non-empty string of at most ${LOOKUP_LIMITS.queryBytes} bytes`);
  }
  if (typeof chain !== 'boolean' || typeof cursor !== 'string' ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > LOOKUP_LIMITS.maxResults) {
    throw new RequestError('bad_request', `chain is a boolean, cursor a string, limit 1..${LOOKUP_LIMITS.maxResults}`);
  }

  switch (mode) {
    case 'agent_id': {
      if (!keyFromAgentId(value)) throw new RequestError('bad_request', 'agent_id is not a valid agent ID');
      const rec = store.agent(value);
      return { agents: rec ? [profile(rec, store, chain)] : [] };
    }
    case 'handle': {
      const m = /^([a-z0-9_-]{2,32})#([a-z2-7]{8})$/.exec(value);
      if (!m) throw new RequestError('bad_request', 'handle must look like name#suffix');
      return { agents: store.agentsByHandle(m[1], m[2]).map((r) => profile(r, store, chain)) };
    }
    case 'name':
    case 'query': {
      const found = mode === 'name'
        ? store.agentsByName(value, cursor, limit + 1)
        : store.searchAgents(value, cursor, limit + 1);
      const page = found.slice(0, limit);
      const out = { agents: page.map((r) => profile(r, store, false)) };
      if (found.length > limit) out.cursor = page.at(-1).agent;
      return out;
    }
  }
}
