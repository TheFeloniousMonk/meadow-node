// Head attestations (SPEC §7.10): every sync answer and batch entry carries the
// node's signed heads for the rooms it covers that the caller may read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Builder } from '../../conformance/tools/builder.js';
import { ATTEST_PREFIX, checkAttestation, signAttestation } from '../src/proto/attest.js';
import { canonicalize } from '../src/proto/encoding.js';
import { verifyBytes, keyFromB64u } from '../src/proto/keys.js';
import { fromB64u } from '../src/proto/encoding.js';
import { sync, syncBatch } from '../src/api/sync.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store/store.js';
import { events, register, signed } from './helpers.js';

// alice's public room, bob's private room (alice not invited), and a room nobody holds.
function world() {
  const pub = new Builder();
  const alice = pub.agent('alice');
  pub.create('create', alice, { type: 'public' });
  pub.join('join', alice);
  pub.post('hello', alice, 'hello');
  const priv = new Builder();
  const bob = priv.agent('bob');
  priv.create('create', bob, { type: 'private' });
  priv.join('join', bob);
  const elsewhere = new Builder();
  elsewhere.create('create', elsewhere.agent('carol'), { type: 'public' });
  const store = new Store();
  sync(store, signed(alice, { outbox: events(pub, 'create', 'join', 'hello') }), alice.id);
  sync(store, signed(bob, { outbox: events(priv, 'create', 'join') }), bob.id);
  return { store, pub, priv, elsewhere, alice, bob };
}

test('a sync answer attests the heads of every readable room it covers, signed by the node key', () => {
  const { store, pub, priv, elsewhere, alice } = world();
  const now = 1_800_000_000_000;
  // Named: bob's private room (unreadable for alice), a room this node does not hold. Joined: alice's.
  const res = sync(store, signed(alice, { heads: { [priv.room.id]: [], [elsewhere.room.id]: [] } }), alice.id, null, { now });
  const att = res.attestation;
  assert.equal(Object.keys(res).at(-1), 'attestation', 'the last key (§7.6)');
  assert.deepEqual(Object.keys(att), ['node', 'agent', 'ts', 'rooms', 'sig']);
  assert.equal(att.node, store.node.id);
  assert.equal(att.agent, alice.id);
  assert.equal(att.ts, now);
  assert.deepEqual(att.rooms, { [elsewhere.room.id]: [], [pub.room.id]: store.room(pub.room.id).heads() });
  assert.ok(!(priv.room.id in att.rooms), 'a room the caller cannot read is left out');
  assert.equal(checkAttestation(att), null);
  // The signature is over the prefix and JCS of the rest, with the key in the node ID.
  const { sig, ...rest } = att;
  assert.ok(verifyBytes(keyFromB64u(att.node.slice(2)), Buffer.from(ATTEST_PREFIX + canonicalize(rest), 'utf8'), fromB64u(sig)));
});

test('tampering, extra fields, unsorted or too many heads, and a wrong key all fail the check', () => {
  const { store, alice } = world();
  const att = sync(store, signed(alice, {}), alice.id).attestation;
  const room = Object.keys(att.rooms)[0];
  const other = new Builder().agent('mallory');
  assert.equal(checkAttestation({ ...att, ts: att.ts + 1 }), 'bad_signature');
  assert.equal(checkAttestation({ ...att, rooms: { ...att.rooms, [room]: [] } }), 'bad_signature');
  assert.equal(checkAttestation({ ...att, agent: other.id }), 'bad_signature');
  assert.equal(checkAttestation({ ...att, extra: 1 }), 'malformed');
  assert.equal(checkAttestation({ ...att, sig: 'nope' }), 'malformed');
  const e = (c) => 'e_' + c.repeat(43);
  const forged = signAttestation(store.node, alice.id, 1, { [room]: [e('B'), e('A')] });
  assert.equal(checkAttestation(forged), 'malformed', 'heads must be sorted');
  const many = signAttestation(store.node, alice.id, 1, { [room]: Array.from({ length: 21 }, (_, i) => e(String.fromCharCode(65 + i))) });
  assert.equal(checkAttestation(many), 'malformed', 'at most 20 heads');
  const otherNode = new Store().node;
  assert.equal(checkAttestation({ ...att, node: otherNode.id }), 'bad_signature');
});

test('each batch entry carries its own attestation, for its own agent', () => {
  const { store, pub, priv, alice, bob } = world();
  register(store, alice, bob);
  const res = syncBatch(store, { syncs: [signed(alice, {}), signed(bob, {})] }, Date.now(), (a) => store.requestKey(a));
  const [a, b] = res.syncs.map((s) => s.attestation);
  assert.equal(a.agent, alice.id);
  assert.equal(b.agent, bob.id);
  assert.deepEqual(Object.keys(a.rooms), [pub.room.id]);
  assert.deepEqual(Object.keys(b.rooms), [priv.room.id]);
  assert.equal(checkAttestation(a), null);
  assert.equal(checkAttestation(b), null);
});

test('over HTTP: the attestation still verifies after the wire escaping (§7.6)', async () => {
  const { store, alice } = world();
  const server = createServer(store, { version: '0.0.0-test', sourceUrl: 'https://example.invalid/src' });
  await new Promise((r) => server.listen(0, r));
  try {
    const raw = await new Promise((resolve, reject) => {
      const req = request({ port: server.address().port, method: 'POST', path: '/v2/sync' }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.end(JSON.stringify(signed(alice, {})));
    });
    const att = JSON.parse(raw).attestation;
    assert.equal(checkAttestation(att), null);
    assert.equal(att.node, store.node.id);
  } finally {
    server.close();
  }
});

test('the attestation counts toward limit_bytes: a tight limit pages the events instead', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  b.create('create', alice, { type: 'public' });
  b.join('join', alice);
  for (let i = 0; i < 6; i++) b.post(`p${i}`, alice, 'x'.repeat(200));
  const store = new Store();
  sync(store, signed(alice, { outbox: events(b, 'create', 'join', ...Array.from({ length: 6 }, (_, i) => `p${i}`)) }), alice.id);
  const all = sync(store, signed(alice, { heads: { [b.room.id]: [] } }), alice.id);
  const eventsSize = Buffer.byteLength(JSON.stringify(all.rooms[b.room.id].events), 'utf8');
  // Enough for every event, but not for every event plus the attestation.
  const tight = sync(store, signed(alice, { heads: { [b.room.id]: [] }, limit_bytes: eventsSize + 50 }), alice.id);
  assert.equal(all.more, false);
  assert.equal(tight.more, true);
  assert.ok(tight.rooms[b.room.id].events.length < all.rooms[b.room.id].events.length);
});

test('a room with more than 20 heads is attested with its 20 lowest head IDs', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  b.create('create', alice, { type: 'public' });
  b.join('join', alice);
  const forks = Array.from({ length: 21 }, (_, i) => `fork${i}`);
  for (const l of forks) b.post(l, alice, l, { parents: ['join'] });
  const store = new Store();
  sync(store, signed(alice, { outbox: events(b, 'create', 'join', ...forks) }), alice.id);
  const heads = store.room(b.room.id).heads();
  assert.equal(heads.length, 21);
  const att = sync(store, signed(alice, {}), alice.id).attestation;
  assert.deepEqual(att.rooms[b.room.id], [...heads].sort().slice(0, 20));
  assert.equal(checkAttestation(att), null);
});
