// POST /v2/sync-batch (SPEC §7.9): several agents' syncs in one call. Each
// entry is answered as its own /v2/sync; the call's limits (one new room, 100
// outbox events, limit_bytes) are shared in entry order; a failed signature
// fails one entry, a malformed entry the whole call; entries see only their own
// agent's rooms.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Builder } from '../../conformance/tools/builder.js';
import { verifyRequest } from '../src/api/auth.js';
import { RequestError, SYNC_LIMITS, sync, syncBatch } from '../src/api/sync.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store/store.js';
import { events, signed } from './helpers.js';

// Two rooms: alice's public room with a post, and bob's private room with a post.
function world() {
  const pub = new Builder();
  const alice = pub.agent('alice');
  pub.create('create', alice, { type: 'public' });
  pub.join('join', alice);
  pub.post('hello', alice, 'hello from alice');
  const priv = new Builder();
  const bob = priv.agent('bob');
  priv.create('create', bob, { type: 'private' });
  priv.join('join', bob);
  priv.post('secret', bob, 'only for bob');
  return { pub, priv, alice, bob, carol: pub.agent('carol') };
}

const batch = (store, body) => syncBatch(store, body, Date.now(), (a) => store.requestKey(a));
const single = (store, body) => sync(store, body, verifyRequest(body, Date.now(), (a) => store.requestKey(a)).agent);

test('two agents in one call, each answered exactly as its own sync', () => {
  const { pub, priv, alice, bob } = world();
  const one = new Store();
  const two = new Store();
  const a = signed(alice, { outbox: events(pub, 'create', 'join', 'hello') });
  const b = signed(bob, { outbox: events(priv, 'create', 'join', 'secret') });
  // Separately: two calls, so two new rooms are allowed.
  const expected = [single(one, a), single(one, b)];
  // Together, the second room waits for the next call (one new room per call).
  const res = batch(two, { syncs: [a, b] });
  assert.equal(res.node, two.node.id);
  assert.equal(res.more, false);
  assert.deepEqual(res.syncs.map((s) => s.agent), [alice.id, bob.id]);
  const { node: _n, ...first } = expected[0];
  assert.deepEqual(res.syncs[0], { agent: alice.id, ...first });
  assert.deepEqual(res.syncs[1].pending.map((p) => p.reason), ['create_limit', 'unknown_room', 'unknown_room']);
  // The next call carries it, and bob's answer matches his own sync.
  const again = batch(two, { syncs: [signed(bob, { outbox: events(priv, 'create', 'join', 'secret') })] });
  assert.deepEqual(again.syncs[0].accepted, expected[1].accepted);
  assert.deepEqual(Object.keys(again.syncs[0].rooms), Object.keys(expected[1].rooms));
});

test('entries see only their own agent: a private room never reaches another entry', () => {
  const { pub, priv, alice, bob } = world();
  const store = new Store();
  single(store, signed(alice, { outbox: events(pub, 'create', 'join', 'hello') }));
  single(store, signed(bob, { outbox: events(priv, 'create', 'join', 'secret') }));
  const res = batch(store, { syncs: [signed(alice, {}), signed(bob, {})] });
  assert.deepEqual(Object.keys(res.syncs[0].rooms), [pub.room.id]);
  assert.deepEqual(Object.keys(res.syncs[1].rooms), [priv.room.id]);
  assert.ok(!JSON.stringify(res.syncs[0]).includes(priv.room.id));
});

test('a failed signature fails its entry only; the call answers 200 with `failed`, never `error`', () => {
  const { pub, alice, bob } = world();
  const store = new Store();
  const good = signed(alice, { outbox: events(pub, 'create', 'join', 'hello') });
  const forged = { ...signed(bob, {}), heads: {} }; // changed after signing
  const res = batch(store, { syncs: [forged, good] });
  assert.deepEqual(res.syncs[0], { agent: bob.id, failed: { code: 'auth_invalid', message: 'request authentication failed (SPEC 7.1)' } });
  assert.equal(res.syncs[1].accepted.length, 3);
  assert.ok(!('error' in res));
  const old = signed(alice, {}, Date.now() - 10 * 60_000);
  assert.equal(batch(store, { syncs: [old] }).syncs[0].failed.code, 'auth_expired');
});

test('a malformed call or entry is a bad_request for the whole call, with nothing processed', () => {
  const { pub, alice, bob } = world();
  const store = new Store();
  const ok = signed(alice, { outbox: events(pub, 'create', 'join', 'hello') });
  const cases = [
    { syncs: [] },
    { syncs: Array.from({ length: SYNC_LIMITS.batch + 1 }, (_, i) => signed(pub.agent(`a${i}`), {})) },
    { syncs: [ok, ok] }, // two entries for one agent
    { syncs: [ok, signed(bob, { limit_bytes: 1000 })] }, // limit_bytes belongs to the call
    { syncs: [ok, signed(bob, { extra: 1 })] },
    { syncs: [ok, signed(bob, { heads: 'nope' })] },
    { syncs: [ok, 42] },
    { syncs: [ok], other: true },
    { syncs: [ok], limit_bytes: 0 },
  ];
  for (const body of cases) {
    assert.throws(() => batch(store, body), (e) => e instanceof RequestError && e.code === 'bad_request', JSON.stringify(body).slice(0, 80));
  }
  assert.equal(store.room(pub.room.id), undefined, 'nothing was ingested');
});

test('the call shares 100 outbox events: past that, events come back pending with batch_limit', () => {
  const { pub, alice, bob } = world();
  pub.join('bob-join', bob);
  for (let i = 0; i < 90; i++) pub.post(`a${i}`, alice, `alice ${i}`);
  for (let i = 0; i < 30; i++) pub.post(`b${i}`, bob, `bob ${i}`);
  const store = new Store();
  single(store, signed(alice, { outbox: events(pub, 'create', 'join', 'hello') }));
  single(store, signed(bob, { outbox: events(pub, 'bob-join') }));
  const a = Array.from({ length: 90 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 30 }, (_, i) => `b${i}`);
  const res = batch(store, { syncs: [signed(alice, { outbox: events(pub, ...a) }), signed(bob, { outbox: events(pub, ...b) })] });
  assert.equal(res.syncs[0].accepted.length, 90);
  assert.equal(res.syncs[1].accepted.length, 10);
  assert.equal(res.syncs[1].pending.length, 20);
  assert.deepEqual([...new Set(res.syncs[1].pending.map((p) => p.reason))], ['batch_limit']);
  // Bob sends them again in the next call.
  const next = batch(store, { syncs: [signed(bob, { outbox: events(pub, ...b.slice(10)) })] });
  assert.equal(next.syncs[0].accepted.length, 20);
});

test('limit_bytes is the whole call: later entries are deferred, and the first always makes progress', () => {
  const { pub, alice, bob } = world();
  for (let i = 0; i < 40; i++) pub.post(`big${i}`, alice, 'x'.repeat(30_000));
  const store = new Store();
  const labels = Array.from({ length: 40 }, (_, i) => `big${i}`);
  single(store, signed(alice, { outbox: events(pub, 'create', 'join', 'hello', ...labels.slice(0, 30)) }));
  single(store, signed(alice, { outbox: events(pub, ...labels.slice(30)) }));
  pub.join('bob-join', bob);
  single(store, signed(bob, { outbox: events(pub, 'bob-join') }));
  // A tiny limit: alice's entry still gets one event; bob's is deferred, untouched.
  const res = batch(store, { syncs: [signed(alice, {}), signed(bob, {})], limit_bytes: 1000 });
  assert.equal(res.more, true);
  assert.ok(res.syncs[0].rooms[pub.room.id].events.length >= 1);
  assert.ok(res.syncs[0].rooms[pub.room.id].events.length < 4, 'stops at the first large event');
  assert.equal(res.syncs[0].more, true);
  assert.deepEqual(res.syncs[1], { agent: bob.id, deferred: true });
  // The default limit: alice fills most of it; bob is deferred once less than 256 KiB is left.
  const big = batch(store, { syncs: [signed(alice, {}), signed(bob, {})] });
  assert.ok(big.syncs[0].rooms[pub.room.id].events.length > 1);
  assert.equal(big.syncs[1].deferred, true);
  // Bob alone, with his heads unknown, is served.
  assert.ok(batch(store, { syncs: [signed(bob, {})] }).syncs[0].rooms[pub.room.id].events.length > 0);
  // The whole answer stays under the 4 MiB response cap at the largest limit.
  const max = batch(store, { syncs: [signed(alice, {}), signed(bob, {})], limit_bytes: 64 * 1024 * 1024 });
  assert.ok(Buffer.byteLength(JSON.stringify(max), 'utf8') < SYNC_LIMITS.responseBytes);
});

test('agents asked for are capped across the call', () => {
  const { alice, bob, pub } = world();
  const store = new Store();
  const ids = Array.from({ length: 30 }, (_, i) => pub.agent(`x${i}`).id);
  assert.throws(() => batch(store, { syncs: [signed(alice, { agents: ids }), signed(bob, { agents: ids.slice(0, 21).map((_, i) => pub.agent(`y${i}`).id) })] }),
    (e) => e.code === 'bad_request' && /across the call/.test(e.message));
});

test('over HTTP: one paid relay, a 200 JSON object with node, more, and syncs; no route auth needed', async () => {
  const { pub, alice } = world();
  const store = new Store();
  const server = createServer(store, { version: '0.0.0-test', sourceUrl: 'https://example.invalid/src' });
  await new Promise((r) => server.listen(0, r));
  try {
    const body = JSON.stringify({ syncs: [signed(alice, { outbox: events(pub, 'create', 'join', 'hello') })] });
    const res = await new Promise((resolve, reject) => {
      const req = request({ port: server.address().port, method: 'POST', path: '/v2/sync-batch' }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      for (let i = 0; i < body.length; i += 1000) req.write(body.slice(i, i + 1000)); // chunked, no Content-Length
      req.end();
    });
    assert.equal(res.status, 200);
    assert.ok(res.raw.startsWith('{"node":'));
    const json = JSON.parse(res.raw);
    assert.deepEqual(Object.keys(json), ['node', 'more', 'syncs']);
    assert.equal(json.syncs[0].accepted.length, 3);
  } finally {
    server.close();
  }
});
