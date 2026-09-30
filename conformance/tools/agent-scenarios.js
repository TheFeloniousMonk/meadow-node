// Agent chain scenarios (SPEC §5.4). Expectations are hand-derived from the
// spec; generate.js refuses to write vectors if the implementation disagrees.
//
// Outcomes: 'accepted', 'discarded:<reason>'. `heads` maps agent name to the
// label of its head and its full expected state.

import { b64u, sha256 } from '../../backend/src/proto/encoding.js';

const curve = (name) => b64u(sha256(`${name}/curve25519`));
const fallback = (name, n = 0) => b64u(sha256(`${name}/fallback/${n}`));
const key = (agent, keyName = 'primary') => b64u(agent.keys[keyName].publicKey);

// The state right after a plain agent.register (§5.4).
const registered = (agent) => ({
  key: key(agent), name: agent.name, description: '', capabilities: [], invites: 'open',
  keys: { curve25519: curve(agent.name), fallback: fallback(agent.name) }, blocked: [],
});

export const agentScenarios = [
  {
    name: 'register-and-update',
    description: 'Profile, key bundle, and block list updates each change only their own fields.',
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.register('register', alice);
      s.agentEvent('profile', alice, 'agent.profile', { parent: 'register', data: { description: 'charts', capabilities: ['render.chart'] } });
      s.agentEvent('invites', alice, 'agent.profile', { parent: 'profile', data: { invites: 'shared_rooms' } });
      s.agentEvent('keys', alice, 'agent.keys', { parent: 'invites', data: { fallback: fallback('alice', 1) } });
      s.agentEvent('block', alice, 'agent.block', { parent: 'keys', data: { blocked: [bob.id] } });
    },
    expect: (s) => {
      const alice = s.agents.get('alice'), bob = s.agents.get('bob');
      return {
        outcomes: { register: 'accepted', profile: 'accepted', invites: 'accepted', keys: 'accepted', block: 'accepted' },
        heads: {
          alice: {
            head: 'block',
            state: {
              ...registered(alice), description: 'charts', capabilities: ['render.chart'], invites: 'shared_rooms',
              keys: { curve25519: curve('alice'), fallback: fallback('alice', 1) }, blocked: [bob.id],
            },
          },
        },
      };
    },
  },
  {
    name: 'rotation',
    description: 'After agent.rotate, only the new key signs; rotating to the current key is refused.',
    build(s) {
      const alice = s.agent('alice');
      s.register('register', alice);
      s.agentEvent('rotate', alice, 'agent.rotate', { parent: 'register', data: { key: s.newKey(alice, 'second') } });
      s.agentEvent('old-key', alice, 'agent.profile', { parent: 'rotate', data: { description: 'old key' } });
      s.agentEvent('new-key', alice, 'agent.profile', { parent: 'rotate', data: { description: 'new key' }, key: 'second' });
      s.agentEvent('same-key', alice, 'agent.rotate', { parent: 'new-key', data: { key: s.newKey(alice, 'second') }, key: 'second' });
    },
    expect: (s) => {
      const alice = s.agents.get('alice');
      return {
        outcomes: {
          register: 'accepted', rotate: 'accepted', 'old-key': 'discarded:wrong_signer', 'new-key': 'accepted',
          'same-key': 'discarded:same_key',
        },
        heads: { alice: { head: 'new-key', state: { ...registered(alice), key: key(alice, 'second'), description: 'new key' } } },
      };
    },
  },
  {
    name: 'wrong-parent',
    description: "An agent event must extend its own author's chain.",
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.register('alice-register', alice);
      s.register('bob-register', bob);
      s.agentEvent('bob-on-alice', bob, 'agent.profile', { parent: 'alice-register', data: { description: 'x' } });
    },
    expect: (s) => ({
      outcomes: { 'alice-register': 'accepted', 'bob-register': 'accepted', 'bob-on-alice': 'discarded:wrong_parent' },
      heads: {
        alice: { head: 'alice-register', state: registered(s.agents.get('alice')) },
        bob: { head: 'bob-register', state: registered(s.agents.get('bob')) },
      },
    }),
  },
  {
    name: 'fork-longest-chain',
    description: 'Of two branches without rotations, the longer one is the head.',
    build(s) {
      const alice = s.agent('alice');
      s.register('register', alice);
      s.agentEvent('a1', alice, 'agent.profile', { parent: 'register', data: { description: 'a1' } });
      s.agentEvent('a2', alice, 'agent.profile', { parent: 'a1', data: { description: 'a2' } });
      s.agentEvent('b1', alice, 'agent.profile', { parent: 'register', data: { description: 'b1' } });
    },
    expect: (s) => ({
      outcomes: { register: 'accepted', a1: 'accepted', a2: 'accepted', b1: 'accepted' },
      heads: { alice: { head: 'a2', state: { ...registered(s.agents.get('alice')), description: 'a2' } } },
    }),
  },
  {
    name: 'rotation-beats-length',
    description: 'A branch with more rotations is the head even when shorter, so a retired key cannot win by writing more.',
    build(s) {
      const alice = s.agent('alice');
      s.register('register', alice);
      s.agentEvent('a1', alice, 'agent.profile', { parent: 'register', data: { description: 'a1' } });
      s.agentEvent('a2', alice, 'agent.profile', { parent: 'a1', data: { description: 'a2' } });
      s.agentEvent('a3', alice, 'agent.profile', { parent: 'a2', data: { description: 'a3' } });
      s.agentEvent('rotate', alice, 'agent.rotate', { parent: 'register', data: { key: s.newKey(alice, 'second') } });
    },
    expect: (s) => {
      const alice = s.agents.get('alice');
      return {
        outcomes: { register: 'accepted', a1: 'accepted', a2: 'accepted', a3: 'accepted', rotate: 'accepted' },
        heads: { alice: { head: 'rotate', state: { ...registered(alice), key: key(alice, 'second') } } },
      };
    },
  },
  {
    name: 'fork-tie-lower-id',
    description: 'Branches with equal rotations and length: the lower event ID is the head.',
    build(s) {
      const alice = s.agent('alice');
      s.register('register', alice);
      s.agentEvent('x', alice, 'agent.profile', { parent: 'register', data: { description: 'x' } });
      s.agentEvent('y', alice, 'agent.profile', { parent: 'register', data: { description: 'y' } });
    },
    expect: (s) => {
      const head = s.id('x') < s.id('y') ? 'x' : 'y';
      return {
        outcomes: { register: 'accepted', x: 'accepted', y: 'accepted' },
        heads: { alice: { head, state: { ...registered(s.agents.get('alice')), description: head } } },
      };
    },
  },
  {
    name: 'second-register',
    description: 'A second agent.register starts a competing root; head selection decides between them.',
    build(s) {
      const alice = s.agent('alice');
      s.register('register-1', alice);
      s.register('register-2', alice, { description: 'again' });
      s.agentEvent('on-2', alice, 'agent.profile', { parent: 'register-2', data: { capabilities: ['x'] } });
    },
    expect: (s) => ({
      outcomes: { 'register-1': 'accepted', 'register-2': 'accepted', 'on-2': 'accepted' },
      heads: { alice: { head: 'on-2', state: { ...registered(s.agents.get('alice')), description: 'again', capabilities: ['x'] } } },
    }),
  },
  {
    name: 'agent-malformed',
    description: 'Names are 2-32 of [a-z0-9_-]; register carries no signer; a block list cannot hold its author; updates are not empty.',
    build(s) {
      const alice = s.agent('alice');
      s.agentEvent('bad-name', alice, 'agent.register', {
        data: { name: 'Alice', keys: { curve25519: curve('alice'), fallback: fallback('alice') } },
      });
      s.newKey(alice, 'second');
      s.agentEvent('register-with-signer', alice, 'agent.register', {
        key: 'second', data: { name: 'alice', keys: { curve25519: curve('alice'), fallback: fallback('alice') } },
      });
      s.register('register', alice);
      s.agentEvent('block-self', alice, 'agent.block', { parent: 'register', data: { blocked: [alice.id] } });
      s.agentEvent('empty-profile', alice, 'agent.profile', { parent: 'register', data: {} });
      s.agentEvent('with-room', alice, 'agent.profile', { parent: 'register', data: { description: 'x' }, patch: (h) => { h.room = 'r_' + 'A'.repeat(43); } });
    },
    expect: (s) => ({
      outcomes: {
        'bad-name': 'discarded:malformed', 'register-with-signer': 'discarded:malformed', register: 'accepted',
        'block-self': 'discarded:malformed', 'empty-profile': 'discarded:malformed', 'with-room': 'discarded:malformed',
      },
      heads: { alice: { head: 'register', state: registered(s.agents.get('alice')) } },
    }),
  },
  {
    name: 'format-3-discoverable',
    description: 'Format 3 (§15) adds discoverable, a boolean, to register and profile; format 2 may not carry it, and a non-boolean is malformed. Turning it off is a change like any other.',
    build(s) {
      const alice = s.agent('alice'), bob = s.agent('bob');
      s.register('register', alice, { discoverable: true }, { v: 3 });
      s.agentEvent('f2-toggle', alice, 'agent.profile', { parent: 'register', data: { discoverable: false } });
      s.agentEvent('not-boolean', alice, 'agent.profile', { v: 3, parent: 'register', data: { discoverable: 1 } });
      s.agentEvent('off', alice, 'agent.profile', { v: 3, parent: 'register', data: { discoverable: false } });
      s.agentEvent('v4', alice, 'agent.profile', { v: 4, parent: 'off', data: { description: 'x' } });
      s.register('bob-f2', bob, { discoverable: false });
      s.register('bob-register', bob);
    },
    expect: (s) => {
      const alice = s.agents.get('alice'), bob = s.agents.get('bob');
      return {
        outcomes: {
          register: 'accepted', 'f2-toggle': 'discarded:malformed', 'not-boolean': 'discarded:malformed', off: 'accepted',
          v4: 'discarded:unsupported_version', 'bob-f2': 'discarded:malformed', 'bob-register': 'accepted',
        },
        heads: {
          alice: { head: 'off', state: { ...registered(alice), discoverable: false } },
          // A format-2 agent's state has no discoverable field: absent means not discoverable (§5.4).
          bob: { head: 'bob-register', state: registered(bob) },
        },
      };
    },
  },
];
