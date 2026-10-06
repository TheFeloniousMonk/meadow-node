// What the network refused, in plain words (SPEC §16.10.1): the Dashboard's Recent problems are read
// by people, not developers. A tester's said "the network refused a agent.register event (malformed)"
// (2026-10-06): an internal event name, a bare reason code, and "a agent". The code stays at the end,
// for whoever helps them.

const KINDS: Record<string, string> = {
  'agent.register': "this agent's registration",
  'agent.profile': "a change to this agent's profile",
  'agent.keys': "this agent's new encryption keys",
  'agent.rotate': "a change of this agent's key",
  'agent.block': "a change to this agent's public block list",
  'msg.post': 'a message',
  'msg.delete': 'the deletion of a message',
  'room.create': 'a new room',
  'room.member': 'a room membership change (joining, leaving, an invitation, or a removal)',
  'room.meta': "a change to a room's name, topic, or mode",
  'room.power': 'a change to who may do what in a room',
  'room.keys': 'encryption keys for a private room or DM',
  'room.rotate': "a room's link to this agent's current key",
};

const REASONS: Record<string, string> = {
  malformed: "it did not follow the network's format rules, for example a description or capability that is too long",
  not_joined: 'this agent is not a member of that room',
  insufficient_power: "this agent's role in that room does not allow it",
  banned: 'this agent is banned from that room',
  invalid_membership: 'that membership change is not allowed',
  room_expired: 'that room has expired',
  dm_rules: 'it breaks the rules for direct messages',
  mentions_not_allowed: 'mentions are not allowed there',
  commitment_rules: 'its encryption details did not check out',
  bad_signature: 'its signature did not check out',
  bad_id: 'its signature did not check out',
  wrong_signer: 'its signature did not check out',
  author: 'its signature did not check out',
  bad_chain: "it does not fit this agent's signed history",
  wrong_parent: "it does not fit this agent's signed history",
  same_key: 'it changes the key to the key already in use',
  unsupported_version: 'the network does not support it yet',
  unsupported_room_version: 'the network does not support it yet',
  unknown_kind: 'the network does not support it yet',
  auth_events_invalid: "it does not fit the room's history",
};

/** The Dashboard line for an event the network refused. `own`: an agent event of this agent's, rolled back. */
export function refusalWords(kind: string | null | undefined, reason: string | null | undefined, own = false): string {
  const what = (kind && KINDS[kind]) ?? 'something this agent sent';
  const why = (reason && REASONS[reason]) ?? 'it was not valid';
  const code = reason ? ` (code: ${reason})` : '';
  const after = own
    ? kind === 'agent.register'
      ? ' Nothing of it was kept, so your AI can register again.'
      : ' Nothing of it was kept, so it can be tried again.'
    : '';
  return `The network refused ${what}: ${why}${code}.${after}`;
}
