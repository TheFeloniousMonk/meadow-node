import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Builder } from '../../conformance/tools/builder.js';
import { dmKey } from '../src/proto/event.js';
import { b64u, canonicalize } from '../src/proto/encoding.js';
import { signBytes } from '../src/proto/keys.js';
import { handleOf } from '../src/agent/agent.js';
import { verifyRequest } from '../src/api/auth.js';
import { lookup } from '../src/api/lookup.js';
import { sync } from '../src/api/sync.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store/store.js';
import { events, signed } from './helpers.js';

const call = (store, agent, fields) => {
  const body = signed(agent, fields);
  const auth = verifyRequest(body, Date.now(), (a) => store.requestKey(a));
  assert.equal(auth.error, undefined);
  return sync(store, body, auth.agent);
};

test('agent events: pending on a missing parent, then the same head as the conformance log', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  b.register('register', alice, { description: 'renders charts', capabilities: ['render.chart'] });
  b.agentEvent('a1', alice, 'agent.profile', { parent: 'register', data: { description: 'a1' } });
  b.agentEvent('a2', alice, 'agent.profile', { parent: 'a1', data: { description: 'a2' } });
  b.agentEvent('rotate', alice, 'agent.rotate', { parent: 'register', data: { key: b.newKey(alice, 'second') } });

  const store = new Store();
  const [register, a1, a2, rotate] = events(b, 'register', 'a1', 'a2', 'rotate');
  assert.deepEqual(store.ingest(a1), { outcome: 'pending', missing: [register.id] });
  for (const ev of [register, a1, a2, rotate, a2]) assert.equal(store.ingest(ev).outcome, 'accepted');

  const rec = store.agent(alice.id);
  assert.equal(rec.head, b.agentLog.head(alice.id).id);
  assert.deepEqual(rec.state, b.agentLog.head(alice.id).state);
  assert.equal(rec.head, rotate.id);
  assert.deepEqual(store.agentChain(alice.id).map((e) => e.id), [register.id, rotate.id]);
  assert.equal(store.requestKey(alice.id), b64u(alice.keys.second.publicKey));
});

test('lookup by agent ID, handle, name, and query', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  // Alice chose to be found by name (format 3); Bob did not, so only exact lookups find him (§7.3).
  b.register('alice', alice, { description: 'Renders 100% of charts', capabilities: ['render.chart'], discoverable: true }, { v: 3 });
  b.register('bob', bob, { description: 'summarizes charts', capabilities: ['text.summary'] });
  const store = new Store();
  for (const s of b.steps) store.ingest(s.event);

  const byId = lookup(store, { agent_id: alice.id, chain: true }).agents;
  assert.equal(byId.length, 1);
  assert.equal(byId[0].handle, handleOf(alice.id, 'alice'));
  assert.equal(byId[0].keys.ed25519, alice.id.slice(2));
  assert.deepEqual(byId[0].chain.map((e) => e.id), [b.id('alice')]);
  assert.equal(Object.keys(byId[0]).at(-2), 'description', 'agent-written text comes last');

  assert.deepEqual(lookup(store, { handle: handleOf(bob.id, 'bob') }).agents.map((a) => a.agent_id), [bob.id]);
  assert.deepEqual(lookup(store, { handle: handleOf(alice.id, 'bob') }).agents, [], 'suffix belongs to alice, name to bob');
  assert.deepEqual(lookup(store, { name: 'alice' }).agents.map((a) => a.agent_id), [alice.id]);
  assert.equal(byId[0].discoverable, true);
  assert.deepEqual(lookup(store, { name: 'bob' }).agents, [], 'bob is not discoverable');
  assert.deepEqual(lookup(store, { agent_id: bob.id }).agents.map((a) => [a.agent_id, a.discoverable]), [[bob.id, false]]);
  assert.deepEqual(lookup(store, { query: 'CHART' }).agents.map((a) => a.agent_id), [alice.id]);
  assert.deepEqual(lookup(store, { query: '100%' }).agents.map((a) => a.agent_id), [alice.id]);
  assert.deepEqual(lookup(store, { query: '%' }).agents.map((a) => a.agent_id), [alice.id], '% is literal');
  assert.deepEqual(lookup(store, { agent_id: b.agent('carol').id }).agents, []);

  for (const bad of [{}, { name: 'a', query: 'b' }, { name: '' }, { handle: 'alice' }, { agent_id: 'a_x' }, { name: 'x', limit: 99 }, { name: 'x', other: 1 }]) {
    assert.throws(() => lookup(store, bad), { code: 'bad_request' }, JSON.stringify(bad));
  }
});

test('lookup pages with a cursor', () => {
  const b = new Builder();
  const agents = Array.from({ length: 5 }, (_, i) => b.agent(`twin${i}`));
  agents.forEach((a, i) => b.agentEvent(`r${i}`, a, 'agent.register', {
    v: 3, data: { name: 'twin', discoverable: true, keys: { curve25519: b64u(Buffer.alloc(32, i)), fallback: b64u(Buffer.alloc(32, i + 9)) } },
  }));
  const store = new Store();
  for (const s of b.steps) store.ingest(s.event);
  const seen = [];
  let cursor;
  do {
    const page = lookup(store, { name: 'twin', limit: 2, ...(cursor && { cursor }) });
    seen.push(...page.agents.map((a) => a.agent_id));
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(seen, agents.map((a) => a.id).sort());
});

test('invite filters: closed, shared_rooms, and the public block list', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  b.create('create', alice, { type: 'private' });
  b.join('alice-join', alice);
  b.member('invite', alice, bob, 'invite');
  b.register('bob-register', bob, { invites: 'closed' });
  const store = new Store();
  for (const s of b.steps) store.ingest(s.event);
  assert.deepEqual(call(store, bob, {}).invites, [], 'closed');

  b.agentEvent('bob-shared', bob, 'agent.profile', { parent: 'bob-register', data: { invites: 'shared_rooms' } });
  store.ingest(events(b, 'bob-shared')[0]);
  assert.deepEqual(call(store, bob, {}).invites, [], 'shared_rooms, but no shared room');

  const lobby = new Builder();
  lobby.create('create', lobby.agent('carol'), { type: 'public' });
  lobby.join('carol-join', lobby.agent('carol'));
  lobby.join('alice-join', lobby.agent('alice'));
  lobby.join('bob-join', lobby.agent('bob'));
  for (const s of lobby.steps) store.ingest(s.event);
  assert.equal(call(store, bob, {}).invites.length, 1, 'shared_rooms, with a shared room');

  b.agentEvent('bob-open', bob, 'agent.profile', { parent: 'bob-shared', data: { invites: 'open' } });
  b.agentEvent('bob-blocks', bob, 'agent.block', { parent: 'bob-open', data: { blocked: [alice.id] } });
  for (const ev of events(b, 'bob-open', 'bob-blocks')) store.ingest(ev);
  assert.deepEqual(call(store, bob, {}).invites, [], 'blocked');

  // The block list covers new DMs too.
  const dm = new Builder();
  dm.create('create', dm.agent('alice'), { type: 'dm', dm_with: bob.id, dm_key: dmKey(alice.id, bob.id) });
  dm.join('alice-join', dm.agent('alice'));
  for (const s of dm.steps) store.ingest(s.event);
  assert.deepEqual(call(store, bob, {}).invites, []);
});

test('a room binding waits for the chain event it cites', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  b.create('create', alice, { type: 'private' });
  b.join('alice-join', alice);
  b.member('invite', alice, bob, 'invite');
  b.register('bob-register', bob);
  b.agentEvent('bob-rotate', bob, 'agent.rotate', { parent: 'bob-register', data: { key: b.newKey(bob, 'second') } });
  b.bind('bind', bob, 'bob-rotate', { key: 'second' });
  b.join('join', bob, { key: 'second' });

  const store = new Store();
  for (const ev of events(b, 'create', 'alice-join', 'invite')) store.ingest(ev);
  const [bind, join] = events(b, 'bind', 'join');
  assert.deepEqual(store.ingest(bind), { outcome: 'pending', missing: [b.id('bob-rotate')] });

  // One sync call from the rotated agent: its chain, the binding, and the join.
  const res = call(store, bob, { outbox: events(b, 'bob-register', 'bob-rotate', 'bind', 'join') });
  assert.deepEqual(res.pending, []);
  assert.deepEqual(res.accepted, events(b, 'bob-register', 'bob-rotate', 'bind', 'join').map((e) => e.id));
  assert.equal(store.membership(b.room.id, bob.id).membership, 'join');
  assert.equal(store.room(b.room.id).outcome(join.id).soft_failed, false);
});

// Over HTTP: agent events in the outbox are taken before request auth.
let server;
let port;
const httpStore = new Store();
before(async () => {
  server = createServer(httpStore, { version: 'test', sourceUrl: 'https://example.invalid' });
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});
after(() => server.close());

function post(path, body) {
  return new Promise((resolve, reject) => {
    const req = request({ port, method: 'POST', path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function signedWith(agent, keyName, fields) {
  const body = { ...fields, auth: { agent: agent.id, ts: Date.now() } };
  body.auth.sig = b64u(signBytes(agent.keys[keyName].privateKey, Buffer.from(canonicalize(body), 'utf8')));
  return body;
}

test('requests are signed with the current key, which a rotation in the outbox updates', async () => {
  const b = new Builder();
  const alice = b.agent('alice');
  b.register('register', alice);
  b.agentEvent('rotate', alice, 'agent.rotate', { parent: 'register', data: { key: b.newKey(alice, 'second') } });

  assert.equal((await post('/v2/sync', signedWith(alice, 'primary', { outbox: events(b, 'register') }))).status, 200);
  const rotated = await post('/v2/sync', signedWith(alice, 'second', { outbox: events(b, 'rotate') }));
  assert.equal(rotated.status, 200);
  assert.deepEqual(rotated.body.accepted, [b.id('rotate')]);
  const retired = await post('/v2/sync', signedWith(alice, 'primary', {}));
  assert.equal(retired.status, 401);
  assert.equal(retired.body.error.code, 'auth_invalid');

  const found = await post('/v2/lookup', { agent_id: alice.id });
  assert.equal(found.status, 200);
  assert.equal(found.body.agents[0].keys.ed25519, b64u(alice.keys.second.publicKey));
  assert.equal((await post('/v2/lookup', { nope: 1 })).status, 400);
});
