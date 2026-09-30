// Agent chains (SPEC §5.4): validity of agent events, agent state, head
// selection, and handles (§3.2).

import { sha256 } from '../proto/encoding.js';
import { keyFromAgentId } from '../proto/keys.js';
import { AGENT_KINDS, checkWellFormed } from '../proto/event.js';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export const handleSuffix = (agentId) => base32(sha256(keyFromAgentId(agentId))).slice(0, 8);
export const handleOf = (agentId, name) => `${name}#${handleSuffix(agentId)}`;

// Applies an agent event to its parent's record ({agent, state, depth, rotations},
// or null for agent.register). Returns the new record, or { reason }.
export function applyAgentEvent(parent, ev) {
  const h = ev.header;
  const d = h.data;
  const signing = h.signer ?? h.author.slice(2);
  if (h.kind === 'agent.register') {
    return {
      agent: h.author,
      depth: 1,
      rotations: 0,
      state: {
        key: signing,
        name: d.name,
        description: d.description ?? '',
        capabilities: d.capabilities ?? [],
        invites: d.invites ?? 'open',
        keys: d.keys,
        blocked: [],
        // Format 3 (SPEC §5.4). Absent means not discoverable, so state from format 2 is unchanged.
        ...(d.discoverable !== undefined && { discoverable: d.discoverable }),
      },
    };
  }
  if (parent.agent !== h.author) return { reason: 'wrong_parent' };
  const s = parent.state;
  if (signing !== s.key) return { reason: 'wrong_signer' };
  let state;
  let rotations = parent.rotations;
  switch (h.kind) {
    case 'agent.profile':
      state = { ...s, ...d };
      break;
    case 'agent.keys':
      state = { ...s, keys: { ...s.keys, ...d } };
      break;
    case 'agent.rotate':
      if (d.key === s.key) return { reason: 'same_key' };
      state = { ...s, key: d.key };
      rotations++;
      break;
    case 'agent.block':
      state = { ...s, blocked: d.blocked };
      break;
  }
  return { agent: h.author, depth: parent.depth + 1, rotations, state };
}

// Head order: more rotations, then a longer chain, then the lower ID.
export function betterHead(a, b) {
  if (!b) return true;
  if (a.rotations !== b.rotations) return a.rotations > b.rotations;
  if (a.depth !== b.depth) return a.depth > b.depth;
  return a.id < b.id;
}

// In-memory agent chains, for conformance and tests. The store implements the
// same rules on SQLite. Also the chain resolver a Room needs.
export class AgentLog {
  #records = new Map();
  #heads = new Map();

  add(ev) {
    const malformed = checkWellFormed(ev);
    if (malformed) return { outcome: 'discarded', reason: malformed };
    if (!AGENT_KINDS.has(ev.header.kind)) return { outcome: 'discarded', reason: 'unknown_kind' };
    if (this.#records.has(ev.id)) return { outcome: 'accepted' };
    const parentId = ev.header.parents[0];
    const parent = parentId === undefined ? null : this.#records.get(parentId);
    if (parent === undefined) return { outcome: 'pending', missing: [parentId] };
    const rec = applyAgentEvent(parent, ev);
    if (rec.reason) return { outcome: 'discarded', reason: rec.reason };
    const record = { ...rec, id: ev.id, parent: parentId ?? null };
    this.#records.set(ev.id, record);
    if (betterHead(record, this.#heads.get(record.agent))) this.#heads.set(record.agent, record);
    return { outcome: 'accepted' };
  }

  head(agent) {
    return this.#heads.get(agent) ?? null;
  }

  keyAt(id) {
    const r = this.#records.get(id);
    return r ? { agent: r.agent, key: r.state.key } : null;
  }

  descends(id, ancestor) {
    for (let r = this.#records.get(id); r; r = this.#records.get(r.parent)) if (r.id === ancestor) return true;
    return false;
  }

  currentKey(agent) {
    return this.#heads.get(agent)?.state.key ?? null;
  }
}
