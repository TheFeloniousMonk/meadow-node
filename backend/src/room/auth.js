// Power table, auth event selection, and authorization rules (SPEC §6.3-§6.5).
//
// A room state S is a Map from state key ("kind|state_key") to event.

import { signingKeyB64 } from '../proto/event.js';

export const DEFAULT_LEVELS = {
  users_default: 0, post: 0, invite: 0, remove: 50, ban: 50, delete: 50, meta: 50, power: 100,
};

export function defaultPowerTable(create) {
  const { author, data } = create.header;
  const users = { [author]: 100 };
  if (data.type === 'dm') users[data.dm_with] = 100;
  return { users, ...DEFAULT_LEVELS, ...data.levels };
}

export function powerTable(S) {
  const power = S.get('room.power|');
  return power ? power.header.data : defaultPowerTable(S.get('room.create|'));
}

export function powerOf(S, agent) {
  const table = powerTable(S);
  return Object.hasOwn(table.users, agent) ? table.users[agent] : table.users_default;
}

export function membershipOf(S, agent) {
  return S.get('room.member|' + agent)?.header.data.membership ?? 'leave';
}

// The state keys an event's auth list may reference (§6.4).
export function authKeys(header) {
  if (header.kind === 'room.create') return [];
  const keys = ['room.create|', 'room.power|', 'room.member|' + header.author, 'room.rotate|' + header.author];
  if (header.kind === 'room.member' && header.data.target !== header.author) keys.push('room.member|' + header.data.target);
  return keys;
}

// The auth list a client puts in a new event, given the state at its parents.
export function selectAuth(header, S) {
  return authKeys(header).filter((k) => S.has(k)).map((k) => S.get(k).id);
}

// `agents` resolves agent chain events (§5.4): keyAt(id) -> {agent, key} | null,
// and descends(id, ancestorId) -> boolean. Chain events are immutable, so
// answers never change once known.

// The key a room accepts for `author` in state S: the key at the chain event
// its room.rotate binds, or for a creator the chain event its room.create
// cites, else its identity key.
export function expectedKey(S, author, agents) {
  const binding = S.get('room.rotate|' + author);
  if (binding) return agents?.keyAt(binding.header.data.chain)?.key ?? null;
  const create = S.get('room.create|');
  if (create.header.author === author && create.header.data.chain) return agents?.keyAt(create.header.data.chain)?.key ?? null;
  return author.slice(2);
}

// A chain event cited by `h` must be its author's, and `h` signed with the key there.
function checkChainKey(h, chainId, agents) {
  const at = agents?.keyAt(chainId);
  if (!at || at.agent !== h.author) return 'bad_chain';
  return at.key === signingKeyB64(h) ? null : 'wrong_signer';
}

// Returns null if `ev` is allowed in state S, else a reason code (§6.5).
export function authorize(ev, S, agents) {
  const h = ev.header;
  if (h.kind === 'room.create') return h.data.chain ? checkChainKey(h, h.data.chain, agents) : null;
  const create = S.get('room.create|');
  if (!create) return 'auth_events_invalid';

  const author = h.author;
  // A binding proves its own key through the chain event it cites.
  const keyError = h.kind === 'room.rotate'
    ? checkChainKey(h, h.data.chain, agents)
    : expectedKey(S, author, agents) === signingKeyB64(h) ? null : 'wrong_signer';
  if (keyError) return keyError;

  const type = create.header.data.type;
  if (h.mentions !== undefined && type !== 'public') return 'mentions_not_allowed';
  // Encrypted posts must be reportable (§9.1); plaintext posts need no franking.
  if (h.kind === 'msg.post' && (h.commitment !== undefined) !== (type !== 'public')) return 'commitment_rules';

  const table = powerTable(S);
  const level = powerOf(S, author);
  const joined = membershipOf(S, author) === 'join';

  switch (h.kind) {
    case 'room.member':
      return authorizeMember(h, S, create, table, level);
    case 'room.power':
      if (!joined) return 'not_joined';
      if (level < table.power) return 'insufficient_power';
      return checkPowerChange(table, h.data, author, level);
    case 'room.meta':
      if (!joined) return 'not_joined';
      return level >= table.meta ? null : 'insufficient_power';
    case 'msg.post':
    case 'room.keys':
      if (!joined) return 'not_joined';
      return level >= table.post ? null : 'insufficient_power';
    case 'room.rotate': {
      // Allowed wherever the author is, or could be, a member, so a rotated
      // agent can bind its key before joining.
      const membership = membershipOf(S, author);
      if (membership === 'ban') return 'banned';
      const dm = create.header.data;
      const eligible = membership === 'join' || membership === 'invite' || type === 'public' ||
        (type === 'dm' && (author === create.header.author || author === dm.dm_with));
      if (!eligible) return 'not_joined';
      // Bindings only move forward along the chain.
      const previous = S.get('room.rotate|' + author);
      if (previous && (previous.header.data.chain === h.data.chain ||
          !agents.descends(h.data.chain, previous.header.data.chain))) return 'bad_chain';
      return null;
    }
    case 'msg.delete':
      return joined ? null : 'not_joined';
    default:
      return 'unknown_kind';
  }
}

function authorizeMember(h, S, create, table, level) {
  const author = h.author;
  const { target, membership } = h.data;
  const { type, dm_with: dmWith } = create.header.data;
  const creator = create.header.author;
  const authorMembership = membershipOf(S, author);
  const targetMembership = membershipOf(S, target);

  if (membership === 'join') {
    if (target !== author) return 'invalid_membership';
    if (targetMembership === 'ban') return 'banned';
    if (type === 'dm') return author === creator || author === dmWith ? null : 'dm_rules';
    if (author === creator && !S.has('room.member|' + author)) return null;
    if (type === 'public') return null;
    return targetMembership === 'invite' || targetMembership === 'join' ? null : 'not_invited';
  }

  // In a DM the only other transition is leaving yourself.
  if (type === 'dm' && !(membership === 'leave' && target === author)) return 'dm_rules';

  if (membership === 'invite') {
    if (authorMembership !== 'join') return 'not_joined';
    if (targetMembership === 'join' || targetMembership === 'ban') return 'invalid_membership';
    return level >= table.invite ? null : 'insufficient_power';
  }
  if (membership === 'leave') {
    if (target === author) return authorMembership === 'invite' || authorMembership === 'join' ? null : 'invalid_membership';
    if (authorMembership !== 'join') return 'not_joined';
    if (targetMembership === 'ban' && level < table.ban) return 'insufficient_power';
    return level >= table.remove && powerOf(S, target) < level ? null : 'insufficient_power';
  }
  // ban
  if (authorMembership !== 'join') return 'not_joined';
  return level >= table.ban && powerOf(S, target) < level ? null : 'insufficient_power';
}

function checkPowerChange(old, next, author, level) {
  for (const k of ['users_default', 'post', 'invite', 'remove', 'ban', 'delete', 'meta', 'power']) {
    if (old[k] !== next[k] && (old[k] > level || next[k] > level)) return 'insufficient_power';
  }
  for (const agent of new Set([...Object.keys(old.users), ...Object.keys(next.users)])) {
    const before = Object.hasOwn(old.users, agent) ? old.users[agent] : undefined;
    const after = Object.hasOwn(next.users, agent) ? next.users[agent] : undefined;
    if (before === after) continue;
    if ((before !== undefined && before > level) || (after !== undefined && after > level)) return 'insufficient_power';
    if (agent !== author && before === level) return 'insufficient_power';
  }
  return null;
}
