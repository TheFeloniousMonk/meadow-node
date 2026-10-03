// Write limits (SPEC §7.2): token buckets per agent per room and per agent
// overall. Over a limit an event comes back pending with rate_limit and
// retry_after_ms, unprocessed; moderation, housekeeping, and resends never count.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Builder } from '../../conformance/tools/builder.js';
import { WriteLimits, WRITE_LIMITS, countsAsWrite } from '../src/api/limits.js';
import { sync } from '../src/api/sync.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store/store.js';
import { events, signed } from './helpers.js';

const T0 = 1_800_000_000_000;

test('buckets: 20 per room and 60 overall per minute, refilling continuously', () => {
  const l = new WriteLimits();
  assert.deepEqual(WRITE_LIMITS, { roomPerMin: 20, agentPerMin: 60 });
  for (let i = 0; i < 20; i++) {
    assert.equal(l.wait('a_x', 'r_1', T0), 0);
    l.spend('a_x', 'r_1', T0);
  }
  assert.equal(l.wait('a_x', 'r_1', T0), 3000, 'one token refills every 3 s at 20 per minute');
  assert.equal(l.wait('a_x', 'r_1', T0 + 3000), 0);
  assert.equal(l.wait('a_y', 'r_1', T0), 0, 'another agent has its own buckets');
  for (const r of ['r_2', 'r_3']) for (let i = 0; i < 20; i++) l.spend('a_x', r, T0);
  assert.equal(l.wait('a_x', 'r_4', T0), 1000, 'the overall bucket (60) is empty: one token per second');
});

test('what counts: posts, names and topics, invitations and joins; never moderation or housekeeping', () => {
  const m = (membership) => ({ kind: 'room.member', data: { membership } });
  for (const h of [{ kind: 'msg.post' }, { kind: 'room.meta' }, m('invite'), m('join')]) assert.equal(countsAsWrite(h), true, JSON.stringify(h));
  for (const h of [m('leave'), m('ban'), { kind: 'msg.delete' }, { kind: 'room.power' }, { kind: 'room.rotate' }, { kind: 'room.keys' }, { kind: 'room.create' }, { kind: 'agent.profile' }]) {
    assert.equal(countsAsWrite(h), false, JSON.stringify(h));
  }
});

// A public room owned by alice, with bob joined; `n` posts by bob after that.
function room(n) {
  const b = new Builder();
  const alice = b.agent('alice'), bob = b.agent('bob');
  b.create('create', alice, { type: 'public' });
  b.join('alice-join', alice);
  b.join('bob-join', bob);
  for (let i = 0; i < n; i++) b.post(`p${i}`, bob, `post ${i}`);
  return { b, alice, bob };
}

test('over the room limit: pending with rate_limit and retry_after_ms, unprocessed; sent again later', () => {
  const { b, alice, bob } = room(25);
  const store = new Store();
  const limits = new WriteLimits();
  sync(store, signed(alice, { outbox: events(b, 'create', 'alice-join') }), alice.id, null, { limits, now: T0 });
  sync(store, signed(bob, { outbox: events(b, 'bob-join') }), bob.id, null, { limits, now: T0 });
  const posts = Array.from({ length: 25 }, (_, i) => `p${i}`);
  // bob's join used one token, so 19 posts go now.
  const res = sync(store, signed(bob, { outbox: events(b, ...posts) }), bob.id, null, { limits, now: T0 });
  assert.equal(res.accepted.length, 19);
  assert.equal(res.pending.length, 6);
  for (const p of res.pending) {
    assert.equal(p.reason, 'rate_limit');
    assert.ok(p.retry_after_ms > 0 && p.retry_after_ms <= 3000);
    assert.equal(store.room(b.room.id).has(p.id), false, 'not processed');
  }
  // Resending what the node already holds never counts; the rest goes once tokens refill.
  const later = sync(store, signed(bob, { outbox: events(b, ...posts) }), bob.id, null, { limits, now: T0 + 6 * 3000 });
  assert.equal(later.accepted.length, 25);
  assert.equal(later.pending.length, 0);
});

test('moderation is never limited: an owner who used up her posts can still remove and ban', () => {
  const b = new Builder();
  const alice = b.agent('alice'), bob = b.agent('bob'), carol = b.agent('carol');
  b.create('create', alice, { type: 'public' });
  b.join('alice-join', alice);
  b.join('bob-join', bob);
  b.join('carol-join', carol);
  for (let i = 0; i < 20; i++) b.post(`a${i}`, alice, `alice ${i}`);
  // Concurrent with the posts, so they do not wait on a post that is held back.
  b.member('remove-bob', alice, bob, 'leave', { parents: ['carol-join'] });
  b.member('ban-carol', alice, carol, 'ban', { parents: ['remove-bob'] });
  b.post('one-more', alice, 'over the limit', { parents: ['ban-carol'] });
  const store = new Store();
  const limits = new WriteLimits();
  sync(store, signed(alice, { outbox: events(b, 'create', 'alice-join') }), alice.id, null, { limits, now: T0 });
  sync(store, signed(bob, { outbox: events(b, 'bob-join') }), bob.id, null, { limits, now: T0 });
  sync(store, signed(carol, { outbox: events(b, 'carol-join') }), carol.id, null, { limits, now: T0 });
  const labels = [...Array.from({ length: 20 }, (_, i) => `a${i}`), 'remove-bob', 'ban-carol', 'one-more'];
  const res = sync(store, signed(alice, { outbox: events(b, ...labels) }), alice.id, null, { limits, now: T0 });
  // alice's join took one token: 19 posts go, the 20th and the last post wait; the removal and the ban go.
  assert.equal(res.accepted.length, 21);
  assert.ok(res.accepted.includes(b.id('remove-bob')) && res.accepted.includes(b.id('ban-carol')));
  assert.deepEqual(res.pending.map((p) => p.reason), ['rate_limit', 'rate_limit']);
});

test('without limits (null), nothing is held back: peers and tests use sync unlimited', () => {
  const { b, alice, bob } = room(30);
  const store = new Store();
  sync(store, signed(alice, { outbox: events(b, 'create', 'alice-join') }), alice.id);
  const res = sync(store, signed(bob, { outbox: events(b, 'bob-join', ...Array.from({ length: 30 }, (_, i) => `p${i}`)) }), bob.id);
  assert.equal(res.accepted.length, 31);
});

test('over HTTP: the server limits writes, and config.writeLimits sets the rates', async () => {
  const { b, alice, bob } = room(5);
  const store = new Store();
  const server = createServer(store, { version: '0.0.0-test', sourceUrl: 'https://example.invalid/src', writeLimits: { roomPerMin: 3 } });
  await new Promise((r) => server.listen(0, r));
  const post = (body) => new Promise((resolve, reject) => {
    const req = request({ port: server.address().port, method: 'POST', path: '/v2/sync' }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  try {
    await post(signed(alice, { outbox: events(b, 'create', 'alice-join') }));
    const res = await post(signed(bob, { outbox: events(b, 'bob-join', 'p0', 'p1', 'p2', 'p3', 'p4') }));
    assert.equal(res.accepted.length, 3, 'the join and two posts');
    assert.deepEqual(res.pending.map((p) => p.reason), ['rate_limit', 'rate_limit', 'rate_limit']);
    assert.ok(res.pending.every((p) => p.retry_after_ms > 0));
  } finally {
    server.close();
  }
});
