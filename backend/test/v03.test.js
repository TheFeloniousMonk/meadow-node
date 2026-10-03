// Node v0.3.0: event format 3 (SPEC §15), author names and chains in sync
// (§7.2), what an invitation shows before joining (§7.2), discoverability and
// oversized chains in lookup (§7.3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Builder } from '../../conformance/tools/builder.js';
import { AgentLog } from '../src/agent/agent.js';
import { verifyRequest } from '../src/api/auth.js';
import { CHAIN_LIMITS, lookup } from '../src/api/lookup.js';
import { sync } from '../src/api/sync.js';
import { checkWellFormed, MAX_REASON } from '../src/proto/event.js';
import { Store } from '../src/store/store.js';
import { events, signed } from './helpers.js';

const call = (store, agent, fields) => {
  const body = signed(agent, fields);
  const auth = verifyRequest(body);
  assert.equal(auth.error, undefined);
  return sync(store, body, auth.agent);
};

/** The reason code a builder step's event gets from the well-formedness check. */
const wf = (b, label) => checkWellFormed(events(b, label)[0]);

test('format 3: reason and origin on room.member, discoverable on profiles; format 2 refuses them', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  b.create('create', alice, { type: 'private' });
  b.join('alice-join', alice);
  const invite = (label, data, v) => b.add(label, alice, 'room.member', { v, data: { target: bob.id, membership: 'invite', ...data } });

  invite('f3-note', { reason: 'For the Tuesday reading group.', origin: 'manual' }, 3);
  invite('f3-auto', { origin: 'automatic' }, 3);
  invite('f3-plain', {}, 3);
  invite('f3-max', { reason: 'é'.repeat(MAX_REASON / 2) }, 3);
  for (const l of ['f3-note', 'f3-auto', 'f3-plain', 'f3-max']) assert.equal(wf(b, l), null, l);

  invite('f2-note', { reason: 'hello' }, 2);
  invite('f2-origin', { origin: 'manual' }, 2);
  invite('f3-long', { reason: 'x'.repeat(MAX_REASON + 1) }, 3);
  invite('f3-empty', { reason: '' }, 3);
  invite('f3-bad-origin', { origin: 'bot' }, 3);
  invite('f3-extra', { reason: 'hi', other: 1 }, 3);
  b.add('f3-origin-on-ban', alice, 'room.member', { v: 3, data: { target: bob.id, membership: 'ban', origin: 'manual' } });
  for (const l of ['f2-note', 'f2-origin', 'f3-long', 'f3-empty', 'f3-bad-origin', 'f3-extra', 'f3-origin-on-ban']) assert.equal(wf(b, l), 'malformed', l);
  b.add('ban-reason', alice, 'room.member', { v: 3, data: { target: bob.id, membership: 'ban', reason: 'spam' } });
  assert.equal(wf(b, 'ban-reason'), null, 'a reason may go with any membership');
  b.add('v4', alice, 'room.member', { v: 4, data: { target: bob.id, membership: 'invite' } });
  assert.equal(wf(b, 'v4'), 'unsupported_version');

  const carol = b.agent('carol');
  b.register('c3', carol, { discoverable: true }, { v: 3 });
  b.agentEvent('c3-off', carol, 'agent.profile', { v: 3, parent: 'c3', data: { discoverable: false } });
  assert.equal(wf(b, 'c3'), null);
  assert.equal(wf(b, 'c3-off'), null);
  const dave = b.agent('dave');
  b.register('d2', dave, { discoverable: true });
  assert.equal(wf(b, 'd2'), 'malformed', 'discoverable needs format 3');
  b.agentEvent('d-bad', dave, 'agent.profile', { v: 3, parent: 'd2', data: { discoverable: 'yes' } });
  assert.equal(wf(b, 'd-bad'), 'malformed');
});

test('a reason changes nothing about authorization or state', () => {
  const run = (data, v) => {
    const b = new Builder();
    const alice = b.agent('alice');
    const bob = b.agent('bob');
    b.create('create', alice, { type: 'private' });
    b.join('alice-join', alice);
    b.add('invite', alice, 'room.member', { v, data: { target: bob.id, membership: 'invite', ...data } });
    b.join('bob-join', bob);
    return b.steps.map((s) => s.result.outcome);
  };
  assert.deepEqual(run({ reason: 'welcome', origin: 'automatic' }, 3), run({}, 2));
});

test('sync names every author it serves and every invite sender, from the chain head', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  const carol = b.agent('carol');
  b.register('alice-reg', alice);
  b.register('bob-reg', bob);
  b.register('carol-reg', carol);
  b.agentEvent('alice-renamed', alice, 'agent.profile', { parent: 'alice-reg', data: { name: 'alicia' } });
  b.create('create', alice, { type: 'public' });
  b.join('alice-join', alice);
  b.add('meta', alice, 'room.meta', { data: { name: 'Garden club', topic: 'Seeds and soil' } });
  b.post('hello', alice, 'hello');
  b.join('bob-join', bob);
  b.post('reply', bob, 'hi');
  b.add('invite', alice, 'room.member', { v: 3, data: { target: carol.id, membership: 'invite', reason: 'You asked about seeds.', origin: 'manual' } });
  const store = new Store();
  for (const l of ['alice-reg', 'bob-reg', 'carol-reg', 'alice-renamed']) store.ingest(events(b, l)[0]);
  call(store, alice, { outbox: events(b, 'create', 'alice-join', 'meta', 'hello') });
  call(store, bob, { outbox: events(b, 'bob-join', 'reply') });
  call(store, alice, { outbox: events(b, 'invite') });

  const res = call(store, carol, { heads: { [b.room.id]: [] } });
  const head = store.agent(alice.id).head;
  assert.deepEqual(res.authors, { [alice.id]: { name: 'alicia', head }, [bob.id]: { name: 'bob', head: store.agent(bob.id).head } });
  assert.deepEqual(Object.keys(res), ['node', 'accepted', 'rejected', 'pending', 'more', 'authors', 'invites', 'rooms', 'chains', 'attestation'], 'names with the metadata, chains and the attestation last');
  assert.equal('agents' in res, false, 'agents is the lookup array; sync must not reuse the key');

  // The invitation shows the room's name, topic, member count, and the note and origin on the invite itself.
  const inv = res.invites[0];
  assert.equal(inv.members, 2);
  const meta = inv.state.find((e) => e.header.kind === 'room.meta');
  assert.deepEqual(meta.header.data, { name: 'Garden club', topic: 'Seeds and soil' });
  const own = inv.state.find((e) => e.header.kind === 'room.member');
  assert.deepEqual(own.header.data, { target: carol.id, membership: 'invite', reason: 'You asked about seeds.', origin: 'manual' });

  // Nothing to name: authors is still present, so a client knows this node takes `agents`.
  assert.deepEqual(call(store, bob, { heads: { [b.room.id]: [b.id('reply'), b.id('invite')] } }).authors, {});
});

test('sync returns requested chains that verify, and refuses a bad agents list', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  b.register('alice-reg', alice);
  b.agentEvent('a1', alice, 'agent.profile', { parent: 'alice-reg', data: { description: 'one' } });
  b.register('bob-reg', bob);
  const store = new Store();
  for (const s of b.steps) store.ingest(s.event);

  const stranger = b.agent('stranger').id;
  const res = call(store, bob, { agents: [alice.id, stranger] });
  assert.deepEqual(Object.keys(res.chains), [alice.id], 'unknown agents are left out');
  const log = new AgentLog();
  for (const ev of res.chains[alice.id]) assert.equal(log.add(ev).outcome, 'accepted');
  assert.equal(log.head(alice.id).id, b.id('a1'));

  for (const bad of [[], Array.from({ length: 51 }, (_, i) => b.agent(`x${i}`).id), [alice.id, alice.id], ['a_nope'], 'a']) {
    assert.throws(() => call(store, bob, { agents: bad }), { code: 'bad_request' }, JSON.stringify(bad).slice(0, 40));
  }
});

test('the first requested chain always comes; others wait for room in limit_bytes', () => {
  const b = new Builder();
  const big = (name) => {
    const a = b.agent(name);
    b.register(`${name}-reg`, a, { description: 'd'.repeat(1000), capabilities: Array.from({ length: 32 }, (_, i) => `c${i}`.padEnd(60, '.')) });
    return a;
  };
  const one = big('one');
  const two = big('two');
  const asker = b.agent('asker');
  b.register('asker-reg', asker);
  const store = new Store();
  for (const s of b.steps) store.ingest(s.event);
  const res = call(store, asker, { agents: [one.id, two.id], limit_bytes: 100 });
  assert.deepEqual(Object.keys(res.chains), [one.id], 'past limit_bytes, only the first');
  const roomy = call(store, asker, { agents: [one.id, two.id] });
  assert.deepEqual(Object.keys(roomy.chains).sort(), [one.id, two.id].sort());
});

test('discoverable agents only in name and word searches; a toggle takes effect at the head', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  b.register('reg', alice, { description: 'charts' }, { v: 3 });
  const store = new Store();
  store.ingest(events(b, 'reg')[0]);
  assert.deepEqual(lookup(store, { query: 'chart' }).agents, []);
  b.agentEvent('on', alice, 'agent.profile', { v: 3, parent: 'reg', data: { discoverable: true } });
  store.ingest(events(b, 'on')[0]);
  assert.deepEqual(lookup(store, { query: 'chart' }).agents.map((a) => a.agent_id), [alice.id]);
  b.agentEvent('off', alice, 'agent.profile', { v: 3, parent: 'on', data: { discoverable: false } });
  store.ingest(events(b, 'off')[0]);
  assert.deepEqual(lookup(store, { name: 'alice' }).agents, []);
  assert.equal(lookup(store, { agent_id: alice.id }).agents.length, 1, 'an exact lookup still finds it');
});

test('a chain too large for one answer says so instead', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  b.register('reg', alice);
  let parent = 'reg';
  for (let i = 0; i <= CHAIN_LIMITS.maxEvents; i++) {
    b.agentEvent(`p${i}`, alice, 'agent.profile', { parent, data: { description: `v${i}` } });
    parent = `p${i}`;
  }
  const store = new Store();
  for (const s of b.steps) store.ingest(s.event);
  const [p] = lookup(store, { agent_id: alice.id, chain: true }).agents;
  assert.equal(p.chain, undefined);
  assert.equal(p.chain_too_large, true);
  const asker = b.agent('asker');
  assert.deepEqual(call(store, asker, { agents: [alice.id] }).chains, { [alice.id]: { chain_too_large: true } });
});
