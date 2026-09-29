// State resolution scenarios. Each `expect` is derived by hand from SPEC §6,
// independently of the reference implementation; generate.js refuses to write a
// vector when the implementation disagrees.
//
// Outcomes: 'accepted', 'soft_failed' (accepted, soft-failed), 'rejected:<reason>',
// 'discarded:<reason>'. State entries: [kind, agent name or '', label].

import { dmKey } from '../../backend/src/proto/event.js';

export const scenarios = [
  {
    name: 'public-basics',
    description: 'Creator joins a public room; anyone else can join without an invite and post.',
    sections: ['6.5', '6.7'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.post('alice-post', alice, 'hello');
      s.join('bob-join', bob);
      s.post('bob-post', bob, 'hi');
    },
    expect: () => ({
      outcomes: { create: 'accepted', 'alice-join': 'accepted', 'alice-post': 'accepted', 'bob-join': 'accepted', 'bob-post': 'accepted' },
      heads: ['bob-post'],
      state: [['room.create', '', 'create'], ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'bob-join']],
    }),
  },
  {
    name: 'private-invite',
    description: 'Joining a private room needs an invite. Rejected events are not heads.',
    sections: ['6.5'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'private' });
      s.join('alice-join', alice);
      s.join('bob-join-uninvited', bob);
      s.member('alice-invites-bob', alice, bob, 'invite');
      s.join('bob-join', bob);
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-join-uninvited': 'rejected:not_invited',
        'alice-invites-bob': 'accepted', 'bob-join': 'accepted',
      },
      heads: ['bob-join'],
      state: [['room.create', '', 'create'], ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'bob-join']],
    }),
  },
  {
    name: 'rejected-parent',
    description: 'Posting requires membership. An accepted event may have a rejected parent; the rejected event adds no state, and its ancestors are no longer heads.',
    sections: ['6.5', '6.6', '6.7'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.post('bob-post', bob, 'not a member');
      s.post('alice-post', alice, 'after a rejected event', { parents: ['bob-post'] });
    },
    expect: () => ({
      outcomes: { create: 'accepted', 'alice-join': 'accepted', 'bob-post': 'rejected:not_joined', 'alice-post': 'accepted' },
      heads: ['alice-post'],
      state: [['room.create', '', 'create'], ['room.member', 'alice', 'alice-join']],
    }),
  },
  {
    name: 'ban-unban',
    description: 'A ban works on an agent who never joined, blocks joining, and is lifted by a leave from someone with ban power.',
    sections: ['6.5'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.member('alice-bans-bob', alice, bob, 'ban');
      s.join('bob-join-banned', bob);
      s.member('alice-unbans-bob', alice, bob, 'leave');
      s.join('bob-join', bob);
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'alice-bans-bob': 'accepted', 'bob-join-banned': 'rejected:banned',
        'alice-unbans-bob': 'accepted', 'bob-join': 'accepted',
      },
      heads: ['bob-join'],
      state: [['room.create', '', 'create'], ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'bob-join']],
    }),
  },
  {
    name: 'remove-needs-higher-power',
    description: 'Removing or banning needs the level for it and strictly more power than the target.',
    sections: ['6.3', '6.5'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob'), carol = s.agent('carol'), dave = s.agent('dave');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.join('bob-join', bob);
      s.join('carol-join', carol);
      s.join('dave-join', dave);
      s.power('power', alice, { alice: 100, bob: 50, carol: 50 });
      s.member('bob-removes-carol', bob, carol, 'leave');
      s.member('bob-removes-dave', bob, dave, 'leave');
      s.member('carol-bans-bob', carol, bob, 'ban');
      s.join('dave-rejoins', dave);
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-join': 'accepted', 'carol-join': 'accepted', 'dave-join': 'accepted',
        power: 'accepted', 'bob-removes-carol': 'rejected:insufficient_power', 'bob-removes-dave': 'accepted',
        'carol-bans-bob': 'rejected:insufficient_power', 'dave-rejoins': 'accepted',
      },
      heads: ['dave-rejoins'],
      state: [
        ['room.create', '', 'create'], ['room.power', '', 'power'], ['room.member', 'alice', 'alice-join'],
        ['room.member', 'bob', 'bob-join'], ['room.member', 'carol', 'carol-join'], ['room.member', 'dave', 'dave-rejoins'],
      ],
    }),
  },
  {
    name: 'power-change-rules',
    description: 'Changing the power table: no level above your own, no demoting peers at your level, no changing a level set above yours.',
    sections: ['6.3', '6.5'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob'), carol = s.agent('carol'), dave = s.agent('dave');
      s.create('create', alice, { type: 'public' });
      for (const a of [alice, bob, carol, dave]) s.join(`${a.name}-join`, a);
      s.power('p1', alice, { alice: 100, bob: 50, carol: 50 }, { power: 50 });
      s.power('bob-raises-self', bob, { alice: 100, bob: 60, carol: 50 }, { power: 50 });
      s.power('bob-demotes-carol', bob, { alice: 100, bob: 50 }, { power: 50 });
      s.power('bob-promotes-dave', bob, { alice: 100, bob: 50, carol: 50, dave: 50 }, { power: 50 });
      s.power('carol-lowers-ban', carol, { alice: 100, bob: 50, carol: 50, dave: 50 }, { power: 50, ban: 40 });
      s.power('dave-raises-power', dave, { alice: 100, bob: 50, carol: 50, dave: 50 }, { power: 100, ban: 40 });
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-join': 'accepted', 'carol-join': 'accepted', 'dave-join': 'accepted',
        p1: 'accepted', 'bob-raises-self': 'rejected:insufficient_power', 'bob-demotes-carol': 'rejected:insufficient_power',
        'bob-promotes-dave': 'accepted', 'carol-lowers-ban': 'accepted', 'dave-raises-power': 'rejected:insufficient_power',
      },
      heads: ['carol-lowers-ban'],
      state: [
        ['room.create', '', 'create'], ['room.power', '', 'carol-lowers-ban'], ['room.member', 'alice', 'alice-join'],
        ['room.member', 'bob', 'bob-join'], ['room.member', 'carol', 'carol-join'], ['room.member', 'dave', 'dave-join'],
      ],
    }),
  },
  {
    name: 'dm-rules',
    description: 'A DM admits exactly its two participants without invites; only leaving yourself is allowed otherwise.',
    sections: ['4.3', '6.5'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob'), carol = s.agent('carol');
      s.create('create', alice, { type: 'dm', dm_with: bob.id, dm_key: dmKey(alice.id, bob.id) });
      s.join('alice-join', alice);
      s.join('bob-join', bob);
      s.join('carol-join', carol);
      s.member('alice-invites-carol', alice, carol, 'invite');
      s.member('alice-removes-bob', alice, bob, 'leave');
      s.member('bob-leaves', bob, bob, 'leave');
      s.join('bob-rejoins', bob);
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-join': 'accepted', 'carol-join': 'rejected:dm_rules',
        'alice-invites-carol': 'rejected:dm_rules', 'alice-removes-bob': 'rejected:dm_rules', 'bob-leaves': 'accepted',
        'bob-rejoins': 'accepted',
      },
      heads: ['bob-rejoins'],
      state: [['room.create', '', 'create'], ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'bob-rejoins']],
    }),
  },
  {
    name: 'create-validation',
    description: 'A room.create with a wrong dm_key or an unknown room version is discarded.',
    sections: ['6.1', '6.6'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob'), carol = s.agent('carol');
      s.create('dm-wrong-key', alice, { type: 'dm', dm_with: bob.id, dm_key: dmKey(alice.id, carol.id) });
      s.add('future-version', alice, 'room.create', { data: { type: 'public', room_version: 2 } });
      s.create('create', alice, { type: 'public' });
    },
    expect: () => ({
      outcomes: { 'dm-wrong-key': 'discarded:malformed', 'future-version': 'discarded:unsupported_room_version', create: 'accepted' },
      heads: ['create'],
      state: [['room.create', '', 'create']],
    }),
  },
  {
    name: 'integrity',
    description: 'Events whose ID does not match the header, whose signature is wrong, or with unknown header fields are discarded.',
    sections: ['5.1', '6.6'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.post('tampered', alice, 'x', { tamper: (ev) => { ev.header.ts += 1; } });
      s.post('forged', alice, 'y', { signAs: bob });
      s.post('unknown-field', alice, 'z', { patch: (h) => { h.extra = {}; } });
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', tampered: 'discarded:bad_id', forged: 'discarded:bad_signature',
        'unknown-field': 'discarded:malformed',
      },
      heads: ['alice-join'],
      state: [['room.create', '', 'create'], ['room.member', 'alice', 'alice-join']],
    }),
  },
  {
    name: 'key-rotation',
    description: "A rotated agent's old key stays valid in a room until it binds the room to its chain; then only the new key signs, and bindings only move forward along the chain. Before binding, old-key events are valid but soft-failed.",
    sections: ['3.4', '5.4', '6.5', '6.6'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.register('bob-register', bob);
      s.join('bob-join', bob);
      s.agentEvent('bob-rotate', bob, 'agent.rotate', { parent: 'bob-register', data: { key: s.newKey(bob, 'second') } });
      s.post('bob-post-before-binding', bob, 'old key, not yet bound');
      s.bind('bob-bind', bob, 'bob-rotate', { key: 'second' });
      s.post('bob-post-old-key', bob, 'old key');
      s.post('bob-post-new-key', bob, 'new key', { key: 'second' });
      s.bind('bob-bind-backwards', bob, 'bob-register');
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-register': 'accepted', 'bob-join': 'accepted', 'bob-rotate': 'accepted',
        'bob-post-before-binding': 'soft_failed', 'bob-bind': 'accepted', 'bob-post-old-key': 'rejected:wrong_signer',
        'bob-post-new-key': 'accepted', 'bob-bind-backwards': 'rejected:bad_chain',
      },
      heads: ['bob-post-new-key'],
      state: [
        ['room.create', '', 'create'], ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'bob-join'],
        ['room.rotate', 'bob', 'bob-bind'],
      ],
    }),
  },
  {
    name: 'join-after-rotation',
    description: 'A rotated agent invited to a private room binds its key there, then joins with the new key. Binding needs eligibility and your own chain.',
    sections: ['3.4', '6.5'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob'), carol = s.agent('carol');
      s.create('create', alice, { type: 'private' });
      s.join('alice-join', alice);
      s.register('bob-register', bob);
      s.agentEvent('bob-rotate', bob, 'agent.rotate', { parent: 'bob-register', data: { key: s.newKey(bob, 'second') } });
      s.register('carol-register', carol);
      s.member('alice-invites-bob', alice, bob, 'invite');
      s.bind('carol-binds-uninvited', carol, 'carol-register');
      s.bind('carol-binds-bobs-chain', carol, 'bob-rotate');
      s.bind('bob-bind', bob, 'bob-rotate', { key: 'second' });
      s.join('bob-join', bob, { key: 'second' });
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-register': 'accepted', 'bob-rotate': 'accepted',
        'carol-register': 'accepted', 'alice-invites-bob': 'accepted', 'carol-binds-uninvited': 'rejected:not_joined',
        'carol-binds-bobs-chain': 'rejected:bad_chain', 'bob-bind': 'accepted', 'bob-join': 'accepted',
      },
      heads: ['bob-join'],
      state: [
        ['room.create', '', 'create'], ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'bob-join'],
        ['room.rotate', 'bob', 'bob-bind'],
      ],
    }),
  },
  {
    name: 'create-after-rotation',
    description: 'A rotated agent creates a room by citing its chain in room.create; the room then expects that key from the creator.',
    sections: ['3.4', '6.5', '6.6'],
    build(s) {
      const bob = s.agent('bob');
      s.register('bob-register', bob);
      s.agentEvent('bob-rotate', bob, 'agent.rotate', { parent: 'bob-register', data: { key: s.newKey(bob, 'second') } });
      const data = { type: 'public', room_version: 1, chain: s.id('bob-rotate') };
      s.add('create-old-key', bob, 'room.create', { data });
      s.add('create', bob, 'room.create', { data, key: 'second' });
      s.join('bob-join', bob, { key: 'second' });
      s.post('bob-post-old-key', bob, 'old key');
    },
    expect: () => ({
      outcomes: {
        'bob-register': 'accepted', 'bob-rotate': 'accepted', 'create-old-key': 'discarded:wrong_signer', create: 'accepted',
        'bob-join': 'accepted', 'bob-post-old-key': 'rejected:wrong_signer',
      },
      heads: ['bob-join'],
      state: [['room.create', '', 'create'], ['room.member', 'bob', 'bob-join']],
    }),
  },
  {
    name: 'auth-events-selection',
    description: 'The auth list must include room.create, only use allowed keys, and only cite accepted events.',
    sections: ['6.4', '6.6'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.member('bob-invites-self', bob, bob, 'invite');
      s.join('bob-join', bob);
      s.post('extra-key', bob, 'a', { auth: ['create', 'bob-join', 'alice-join'] });
      s.post('no-create', bob, 'b', { auth: ['bob-join'] });
      s.post('cites-rejected', bob, 'c', { auth: ['create', 'bob-invites-self'] });
      s.post('ok', bob, 'd');
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-invites-self': 'rejected:not_joined', 'bob-join': 'accepted',
        'extra-key': 'rejected:auth_events_invalid', 'no-create': 'rejected:auth_events_invalid',
        'cites-rejected': 'rejected:auth_events_invalid', ok: 'accepted',
      },
      heads: ['ok'],
      state: [['room.create', '', 'create'], ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'bob-join']],
    }),
  },
  {
    name: 'stale-auth-events',
    description: 'Auth events that pass on their own do not save an event that fails against the state before it.',
    sections: ['6.6'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.join('bob-join', bob);
      s.member('alice-removes-bob', alice, bob, 'leave');
      s.post('bob-post-stale', bob, 'still here?', { auth: ['create', 'bob-join'] });
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-join': 'accepted', 'alice-removes-bob': 'accepted',
        'bob-post-stale': 'rejected:not_joined',
      },
      heads: ['alice-removes-bob'],
      state: [['room.create', '', 'create'], ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'alice-removes-bob']],
    }),
  },
  {
    name: 'demotion-beats-concurrent-removal',
    description: 'A moderator removes someone while concurrently being demoted. Higher sender power sorts first, so the demotion applies and the removal fails in resolution. The removal is valid but soft-failed on arrival.',
    sections: ['6.6', '6.8'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob'), dave = s.agent('dave');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.join('bob-join', bob);
      s.join('dave-join', dave);
      s.power('p1', alice, { alice: 100, bob: 50 });
      s.power('p2-demotes-bob', alice, { alice: 100 }, {}, { parents: ['p1'] });
      s.member('bob-removes-dave', bob, dave, 'leave', { parents: ['p1'] });
      s.post('alice-merge', alice, 'merge');
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-join': 'accepted', 'dave-join': 'accepted', p1: 'accepted',
        'p2-demotes-bob': 'accepted', 'bob-removes-dave': 'soft_failed', 'alice-merge': 'accepted',
      },
      heads: ['alice-merge'],
      state: [
        ['room.create', '', 'create'], ['room.power', '', 'p2-demotes-bob'], ['room.member', 'alice', 'alice-join'],
        ['room.member', 'bob', 'bob-join'], ['room.member', 'dave', 'dave-join'],
      ],
    }),
  },
  {
    name: 'ban-beats-concurrent-join',
    description: 'An invited agent joins while concurrently being banned. The ban is a power event and resolves first; the join then fails.',
    sections: ['6.8'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'private' });
      s.join('alice-join', alice);
      s.member('alice-invites-bob', alice, bob, 'invite');
      s.join('bob-join', bob, { parents: ['alice-invites-bob'] });
      s.member('alice-bans-bob', alice, bob, 'ban', { parents: ['alice-invites-bob'] });
      s.sealed('alice-merge', alice, 'merge');
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'alice-invites-bob': 'accepted', 'bob-join': 'accepted',
        'alice-bans-bob': 'accepted', 'alice-merge': 'accepted',
      },
      heads: ['alice-merge'],
      state: [['room.create', '', 'create'], ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'alice-bans-bob']],
    }),
  },
  {
    name: 'soft-fail-after-ban',
    description: 'A banned agent posts from a fork that predates the ban. The post is valid at its parents, so it is accepted, but soft-failed.',
    sections: ['6.6'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.join('bob-join', bob);
      s.member('alice-bans-bob', alice, bob, 'ban', { parents: ['bob-join'] });
      s.post('bob-post-concurrent', bob, 'from before the ban', { parents: ['bob-join'] });
      s.post('alice-merge', alice, 'merge');
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-join': 'accepted', 'alice-bans-bob': 'accepted',
        'bob-post-concurrent': 'soft_failed', 'alice-merge': 'accepted',
      },
      heads: ['alice-merge'],
      state: [['room.create', '', 'create'], ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'alice-bans-bob']],
    }),
  },
  {
    name: 'concurrent-meta-ts',
    description: 'Two concurrent room.meta events under the same power table: the later ts is applied last and wins, whatever the arrival order.',
    sections: ['6.8'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.join('bob-join', bob);
      s.power('p1', alice, { alice: 100, bob: 50 });
      const t = s.clock;
      s.meta('alice-meta', alice, { name: 'Alice named it' }, { parents: ['p1'], ts: t + 2000 });
      s.meta('bob-meta', bob, { name: 'Bob named it' }, { parents: ['p1'], ts: t + 1000 });
      s.clock = t + 2000;
      s.post('alice-merge', alice, 'merge');
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-join': 'accepted', p1: 'accepted', 'alice-meta': 'accepted',
        'bob-meta': 'accepted', 'alice-merge': 'accepted',
      },
      heads: ['alice-merge'],
      state: [
        ['room.create', '', 'create'], ['room.power', '', 'p1'], ['room.meta', '', 'alice-meta'],
        ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'bob-join'],
      ],
    }),
  },
  {
    name: 'concurrent-meta-same-ts',
    description: 'Two concurrent room.meta events with equal mainline depth and ts: the larger event ID is applied last and wins.',
    sections: ['6.8'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.join('bob-join', bob);
      s.power('p1', alice, { alice: 100, bob: 50 });
      const t = s.clock + 1000;
      s.meta('alice-meta', alice, { topic: 'alice' }, { parents: ['p1'], ts: t });
      s.meta('bob-meta', bob, { topic: 'bob' }, { parents: ['p1'], ts: t });
      s.clock = t;
      s.post('alice-merge', alice, 'merge');
    },
    expect: (s) => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-join': 'accepted', p1: 'accepted', 'alice-meta': 'accepted',
        'bob-meta': 'accepted', 'alice-merge': 'accepted',
      },
      heads: ['alice-merge'],
      state: [
        ['room.create', '', 'create'], ['room.power', '', 'p1'],
        ['room.meta', '', s.id('alice-meta') > s.id('bob-meta') ? 'alice-meta' : 'bob-meta'],
        ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'bob-join'],
      ],
    }),
  },
  {
    name: 'mainline-depth-beats-ts',
    description: 'An event authorized under a newer power table sorts after one under an older table, even with an earlier ts.',
    sections: ['6.8'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.join('bob-join', bob);
      s.power('p1', alice, { alice: 100, bob: 50 });
      const t = s.clock;
      s.power('p2', alice, { alice: 100, bob: 50 }, { invite: 50 }, { parents: ['p1'], ts: t + 1000 });
      s.meta('alice-meta', alice, { name: 'newer table' }, { parents: ['p2'], ts: t + 2000 });
      s.meta('bob-meta', bob, { name: 'older table' }, { parents: ['p1'], ts: t + 9000 });
      s.clock = t + 9000;
      s.post('alice-merge', alice, 'merge');
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-join': 'accepted', p1: 'accepted', p2: 'accepted',
        'alice-meta': 'accepted', 'bob-meta': 'accepted', 'alice-merge': 'accepted',
      },
      heads: ['alice-merge'],
      state: [
        ['room.create', '', 'create'], ['room.power', '', 'p2'], ['room.meta', '', 'alice-meta'],
        ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'bob-join'],
      ],
    }),
  },
  {
    name: 'commitment-private',
    description: 'In a private room, msg.post must carry a franking commitment so it can always be reported.',
    sections: ['6.5', '9.1'],
    build(s) {
      const alice = s.agent('alice');
      s.create('create', alice, { type: 'private' });
      s.join('alice-join', alice);
      s.post('post-without-commitment', alice, 'unreportable');
      s.sealed('post-sealed', alice, 'reportable');
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'post-without-commitment': 'rejected:commitment_rules', 'post-sealed': 'accepted',
      },
      heads: ['post-sealed'],
      state: [['room.create', '', 'create'], ['room.member', 'alice', 'alice-join']],
    }),
  },
  {
    name: 'commitment-public',
    description: 'In a public room, msg.post must not carry a commitment: content is plaintext and reports cite the event alone.',
    sections: ['6.5', '9.1'],
    build(s) {
      const alice = s.agent('alice');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.sealed('post-with-commitment', alice, 'needless');
      s.post('post-plain', alice, 'fine');
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'post-with-commitment': 'rejected:commitment_rules', 'post-plain': 'accepted',
      },
      heads: ['post-plain'],
      state: [['room.create', '', 'create'], ['room.member', 'alice', 'alice-join']],
    }),
  },
  {
    name: 'mainline-root-from-unconflicted',
    description: 'Neither branch changes power, so the partial state has no power event and the mainline starts at the unconflicted one. An event citing the older table (valid) sorts before one under the current table, despite its later ts.',
    sections: ['6.4', '6.8'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.join('bob-join', bob);
      s.power('p1', alice, { alice: 100, bob: 50 });
      s.power('p2', alice, { alice: 100, bob: 50 }, { invite: 50 });
      const t = s.clock;
      s.meta('alice-meta', alice, { name: 'current table' }, { parents: ['p2'], ts: t + 1000 });
      s.meta('bob-meta-stale', bob, { name: 'older table' }, { parents: ['p2'], ts: t + 5000, auth: ['create', 'p1', 'bob-join'] });
      s.clock = t + 5000;
      s.post('alice-merge', alice, 'merge');
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-join': 'accepted', p1: 'accepted', p2: 'accepted',
        'alice-meta': 'accepted', 'bob-meta-stale': 'accepted', 'alice-merge': 'accepted',
      },
      heads: ['alice-merge'],
      state: [
        ['room.create', '', 'create'], ['room.power', '', 'p2'], ['room.meta', '', 'alice-meta'],
        ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'bob-join'],
      ],
    }),
  },
  {
    name: 'concurrent-power-changes',
    description: 'The owner demotes a moderator while the moderator promotes someone. The owner sorts first; the promotion fails in resolution.',
    sections: ['6.8'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob'), carol = s.agent('carol');
      s.create('create', alice, { type: 'public' });
      for (const a of [alice, bob, carol]) s.join(`${a.name}-join`, a);
      s.power('p1', alice, { alice: 100, bob: 50 }, { power: 50 });
      s.power('bob-promotes-carol', bob, { alice: 100, bob: 50, carol: 50 }, { power: 50 }, { parents: ['p1'] });
      s.power('alice-demotes-bob', alice, { alice: 100 }, { power: 50 }, { parents: ['p1'] });
      s.post('alice-merge', alice, 'merge');
    },
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-join': 'accepted', 'carol-join': 'accepted', p1: 'accepted',
        'bob-promotes-carol': 'accepted', 'alice-demotes-bob': 'accepted', 'alice-merge': 'accepted',
      },
      heads: ['alice-merge'],
      state: [
        ['room.create', '', 'create'], ['room.power', '', 'alice-demotes-bob'], ['room.member', 'alice', 'alice-join'],
        ['room.member', 'bob', 'bob-join'], ['room.member', 'carol', 'carol-join'],
      ],
    }),
  },
  {
    name: 'conflicted-subgraph',
    description: 'The v2.1 conflicted subgraph prevents a state reset. Alice sets bob to 50 (p1), then 100 (p2), and bob, at 100, changes the table (p3). '
      + 'A branch forked at p1 names the room, citing p2 as its power event, so p2 is in both branches\' auth chains: not conflicted, not in the auth '
      + 'difference. The conflicted power events are p1 and p3. Only the conflicted subgraph (p2 lies on the auth path from p3 to p1) replays p2 '
      + 'between them; without it, p3 is checked against p1, where bob has 50, and the table resets to p1.',
    sections: ['6.4', '6.6', '6.8'],
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.agent('carol'); // named in p3's table; never joins
      s.create('create', alice, { type: 'public' });
      s.join('alice-join', alice);
      s.join('bob-join', bob);
      s.power('p1', alice, { alice: 100, bob: 50 });
      s.power('p2', alice, { alice: 100, bob: 100 });
      s.power('p3', bob, { alice: 100, bob: 100, carol: 50 });
      s.meta('fork-meta', alice, { name: 'fork' }, { parents: ['p1'], auth: ['create', 'p2', 'alice-join'] });
      s.post('alice-merge', alice, 'merge');
    },
    // Hand derivation (§6.8), resolving state_after(p3) with state_after(fork-meta):
    // - unconflicted: create, both memberships. Conflicted: room.power {p3, p1}, room.meta {fork-meta} (in one state only).
    // - auth chains: p3's side {create, joins, p3, p2, p1}; the fork's {create, joins, p1, fork-meta, p2}. Auth difference: {p3, fork-meta}.
    // - conflicted subgraph: p2 (p2 in auth_chain(p3), p1 in auth_chain(p2)). Full set: {p1, p2, p3, fork-meta}.
    // - power events and order: p1, p2, p3 (each waits on the one before). p1 passes; p2 passes against p1 (alice at 100 raises bob to 100);
    //   p3 passes against p2 (bob at 100, adds carol at 50). Partial: room.power = p3.
    // - mainline: p1 (1), p2 (2), p3 (3). fork-meta's depth is p2's, 2. It passes against p3 (alice at 100 >= meta 50).
    // - Result: room.power p3, room.meta fork-meta. The merge (parents p3, fork-meta) changes no state.
    expect: () => ({
      outcomes: {
        create: 'accepted', 'alice-join': 'accepted', 'bob-join': 'accepted', p1: 'accepted', p2: 'accepted', p3: 'accepted',
        'fork-meta': 'accepted', 'alice-merge': 'accepted',
      },
      heads: ['alice-merge'],
      state: [
        ['room.create', '', 'create'], ['room.power', '', 'p3'], ['room.meta', '', 'fork-meta'],
        ['room.member', 'alice', 'alice-join'], ['room.member', 'bob', 'bob-join'],
      ],
    }),
  },
];
