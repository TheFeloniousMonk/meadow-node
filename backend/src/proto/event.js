// Event format and the well-formedness check for room events (SPEC §5.1,
// §6.6 step 1) and agent events (§5.4).

import { b64u, canonicalize, fromB64u, sha256 } from './encoding.js';
import { keyFromAgentId, keyFromB64u, verifyBytes } from './keys.js';

export const EVENT_VERSION = 2;
export const ROOM_VERSION = 1;
export const MAX_PARENTS = 20;
export const MAX_CONTENT = 64 * 1024;
export const MAX_HEADER = 64 * 1024;

export const STATE_KINDS = new Set(['room.create', 'room.meta', 'room.power', 'room.member', 'room.rotate']);
export const ROOM_KINDS = new Set([...STATE_KINDS, 'room.keys', 'msg.post', 'msg.delete']);
export const AGENT_KINDS = new Set(['agent.register', 'agent.profile', 'agent.keys', 'agent.rotate', 'agent.block']);
export const INVITE_SETTINGS = new Set(['open', 'shared_rooms', 'closed']);
export const MAX_BLOCKED = 1024;
export const MEMBERSHIPS = new Set(['invite', 'join', 'leave', 'ban']);
export const ROOM_TYPES = new Set(['public', 'private', 'dm']);
export const LEVEL_KEYS = ['users_default', 'post', 'invite', 'remove', 'ban', 'delete', 'meta', 'power'];

const HEADER_FIELDS = new Set([
  'v', 'kind', 'author', 'room', 'parents', 'auth', 'ts', 'data',
  'content_hash', 'content_len', 'commitment', 'mentions', 'signer',
]);
const EVENT_FIELDS = new Set(['header', 'id', 'sig', 'content']);

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isEventId = (x) => typeof x === 'string' && /^e_[A-Za-z0-9_-]{43}$/.test(x) && fromB64u(x.slice(2)) !== null;
const isRoomId = (x) => typeof x === 'string' && /^r_[A-Za-z0-9_-]{43}$/.test(x) && fromB64u(x.slice(2)) !== null;
const isAgentId = (x) => keyFromAgentId(x) !== null;
const isLevel = (x) => Number.isSafeInteger(x) && x >= 0 && x <= 100;
const onlyKeys = (obj, allowed) => Object.keys(obj).every((k) => allowed.includes(k));
const utf8Len = (s) => Buffer.byteLength(s, 'utf8');
const isKey = (x) => keyFromB64u(x) !== null;
const isName = (x) => typeof x === 'string' && /^[a-z0-9_-]{2,32}$/.test(x);
const isDescription = (x) => typeof x === 'string' && utf8Len(x) <= 1024;
const isCapabilities = (x) => Array.isArray(x) && x.length <= 32 && new Set(x).size === x.length &&
  x.every((c) => typeof c === 'string' && c.length > 0 && utf8Len(c) <= 64);

function checkProfileFields(d) {
  if (d.name !== undefined && !isName(d.name)) return 'malformed';
  if (d.description !== undefined && !isDescription(d.description)) return 'malformed';
  if (d.capabilities !== undefined && !isCapabilities(d.capabilities)) return 'malformed';
  if (d.invites !== undefined && !INVITE_SETTINGS.has(d.invites)) return 'malformed';
  return null;
}

function isIdList(list, min, max) {
  return Array.isArray(list) && list.length >= min && list.length <= max &&
    list.every(isEventId) && new Set(list).size === list.length;
}

export const eventId = (header) => 'e_' + b64u(sha256(canonicalize(header)));
export const idBytes = (id) => fromB64u(id.slice(2));
export const roomIdOf = (createId) => 'r_' + createId.slice(2);

export function dmKey(a, b) {
  return b64u(sha256(canonicalize([a, b].sort())));
}

export function stateKey(header) {
  switch (header.kind) {
    case 'room.create':
    case 'room.meta':
    case 'room.power':
      return header.kind + '|';
    case 'room.member':
      return 'room.member|' + header.data.target;
    case 'room.rotate':
      return 'room.rotate|' + header.author;
    default:
      return null;
  }
}

export function signingKey(header) {
  return header.signer !== undefined ? keyFromB64u(header.signer) : keyFromAgentId(header.author);
}

// The signing key as b64u, the form agent state and room bindings use.
export const signingKeyB64 = (header) => header.signer ?? header.author.slice(2);

function checkData(h) {
  const d = h.data;
  switch (h.kind) {
    case 'room.create': {
      if (!isObject(d) || !onlyKeys(d, ['type', 'room_version', 'levels', 'dm_with', 'dm_key', 'chain'])) return 'malformed';
      if (d.chain !== undefined && !isEventId(d.chain)) return 'malformed';
      if (!Number.isSafeInteger(d.room_version)) return 'malformed';
      if (d.room_version !== ROOM_VERSION) return 'unsupported_room_version';
      if (!ROOM_TYPES.has(d.type)) return 'malformed';
      if (d.levels !== undefined &&
          (!isObject(d.levels) || !onlyKeys(d.levels, LEVEL_KEYS) || !Object.values(d.levels).every(isLevel))) {
        return 'malformed';
      }
      if (d.type === 'dm') {
        if (!isAgentId(d.dm_with) || d.dm_with === h.author || d.dm_key !== dmKey(h.author, d.dm_with)) return 'malformed';
      } else if (d.dm_with !== undefined || d.dm_key !== undefined) {
        return 'malformed';
      }
      return null;
    }
    case 'room.meta':
      if (!isObject(d) || Object.keys(d).length === 0 || !onlyKeys(d, ['name', 'topic', 'listed'])) return 'malformed';
      if (d.name !== undefined && (typeof d.name !== 'string' || utf8Len(d.name) > 256)) return 'malformed';
      if (d.topic !== undefined && (typeof d.topic !== 'string' || utf8Len(d.topic) > 1024)) return 'malformed';
      if (d.listed !== undefined && typeof d.listed !== 'boolean') return 'malformed';
      return null;
    case 'room.power':
      if (!isObject(d) || Object.keys(d).length !== LEVEL_KEYS.length + 1 || !onlyKeys(d, ['users', ...LEVEL_KEYS])) return 'malformed';
      if (!LEVEL_KEYS.every((k) => isLevel(d[k]))) return 'malformed';
      if (!isObject(d.users) || !Object.entries(d.users).every(([a, l]) => isAgentId(a) && isLevel(l))) return 'malformed';
      return null;
    case 'room.member':
      if (!isObject(d) || Object.keys(d).length !== 2 || !isAgentId(d.target) || !MEMBERSHIPS.has(d.membership)) return 'malformed';
      return null;
    case 'room.rotate':
      if (!isObject(d) || Object.keys(d).length !== 1 || !isEventId(d.chain)) return 'malformed';
      return null;
    case 'msg.delete':
      if (!isObject(d) || Object.keys(d).length !== 1 || !isEventId(d.target)) return 'malformed';
      return null;
    case 'agent.register':
      if (!isObject(d) || !onlyKeys(d, ['name', 'description', 'capabilities', 'invites', 'keys']) || !isName(d.name)) return 'malformed';
      if (!isObject(d.keys) || Object.keys(d.keys).length !== 2 || !isKey(d.keys.curve25519) || !isKey(d.keys.fallback)) return 'malformed';
      return checkProfileFields(d);
    case 'agent.profile':
      if (!isObject(d) || Object.keys(d).length === 0 || !onlyKeys(d, ['name', 'description', 'capabilities', 'invites'])) return 'malformed';
      return checkProfileFields(d);
    case 'agent.keys':
      if (!isObject(d) || Object.keys(d).length === 0 || !onlyKeys(d, ['curve25519', 'fallback'])) return 'malformed';
      return Object.values(d).every(isKey) ? null : 'malformed';
    case 'agent.rotate':
      if (!isObject(d) || Object.keys(d).length !== 1 || !isKey(d.key)) return 'malformed';
      return null;
    case 'agent.block':
      if (!isObject(d) || Object.keys(d).length !== 1 || !Array.isArray(d.blocked) || d.blocked.length > MAX_BLOCKED ||
          !d.blocked.every(isAgentId) || new Set(d.blocked).size !== d.blocked.length || d.blocked.includes(h.author)) {
        return 'malformed';
      }
      return null;
    default:
      return d === undefined ? null : 'malformed';
  }
}

// Returns null if the event is well-formed and correctly signed, else a reason code.
// Failing events are discarded: not stored, not relayed.
export function checkWellFormed(ev) {
  if (!isObject(ev) || !isObject(ev.header) || typeof ev.id !== 'string' || typeof ev.sig !== 'string') return 'malformed';
  if (!Object.keys(ev).every((k) => EVENT_FIELDS.has(k))) return 'malformed';
  const h = ev.header;
  if (!Number.isSafeInteger(h.v)) return 'malformed';
  if (h.v !== EVENT_VERSION) return 'unsupported_version';
  if (!Object.keys(h).every((k) => HEADER_FIELDS.has(k))) return 'malformed';
  if (!ROOM_KINDS.has(h.kind) && !AGENT_KINDS.has(h.kind)) return 'unknown_kind';
  if (!isAgentId(h.author) || !Number.isSafeInteger(h.ts) || h.ts < 0) return 'malformed';
  if (h.signer !== undefined && (keyFromB64u(h.signer) === null || h.signer === h.author.slice(2))) return 'malformed';

  if (AGENT_KINDS.has(h.kind)) {
    // An agent's events form a chain: register is the root, every other event names its predecessor.
    const register = h.kind === 'agent.register';
    if (h.room !== undefined || !isIdList(h.auth, 0, 0) || !isIdList(h.parents, register ? 0 : 1, register ? 0 : 1)) return 'malformed';
    if (register && h.signer !== undefined) return 'malformed';
  } else if (h.kind === 'room.create') {
    // A creator that has rotated signs with the key at data.chain (SPEC §6.5 rule 1).
    if (h.room !== undefined || (h.signer !== undefined && h.data?.chain === undefined) ||
        !isIdList(h.parents, 0, 0) || !isIdList(h.auth, 0, 0)) return 'malformed';
  } else if (!isRoomId(h.room) || !isIdList(h.parents, 1, MAX_PARENTS) || !isIdList(h.auth, 1, 5)) {
    return 'malformed';
  }

  const dataError = checkData(h);
  if (dataError) return dataError;

  const hasContent = h.kind === 'msg.post' || h.kind === 'room.keys';
  if (hasContent) {
    if (typeof h.content_hash !== 'string' || fromB64u(h.content_hash)?.length !== 32) return 'malformed';
    if (!Number.isSafeInteger(h.content_len) || h.content_len < 0 || h.content_len > MAX_CONTENT) return 'malformed';
  } else if (h.content_hash !== undefined || h.content_len !== undefined || ev.content !== undefined) {
    return 'malformed';
  }
  if (h.commitment !== undefined && (h.kind !== 'msg.post' || fromB64u(h.commitment)?.length !== 32)) {
    return 'malformed';
  }
  if (h.mentions !== undefined && (h.kind !== 'msg.post' || !Array.isArray(h.mentions) || h.mentions.length < 1 ||
      h.mentions.length > 64 || !h.mentions.every(isAgentId) || new Set(h.mentions).size !== h.mentions.length)) {
    return 'malformed';
  }
  if (ev.content !== undefined) {
    if (typeof ev.content !== 'string' || utf8Len(ev.content) !== h.content_len) return 'malformed';
    if (b64u(sha256(Buffer.from(ev.content, 'utf8'))) !== h.content_hash) return 'malformed';
  }

  let canonical;
  try {
    canonical = canonicalize(h);
  } catch {
    return 'malformed';
  }
  if (Buffer.byteLength(canonical, 'utf8') > MAX_HEADER) return 'malformed';
  if ('e_' + b64u(sha256(canonical)) !== ev.id) return 'bad_id';
  const sig = fromB64u(ev.sig);
  if (!sig || sig.length !== 64 || !verifyBytes(signingKey(h), idBytes(ev.id), sig)) return 'bad_signature';
  return null;
}
