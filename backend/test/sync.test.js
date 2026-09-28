import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Builder } from '../../conformance/tools/builder.js';
import { dmKey } from '../src/proto/event.js';
import { verifyRequest } from '../src/api/auth.js';
import { sync } from '../src/api/sync.js';
import { Store } from '../src/store/store.js';
import { events, signed } from './helpers.js';

// A public room with alice joined and one post.
function publicRoom() {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  const carol = b.agent('carol');
  b.create('create', alice, { type: 'public' });
  b.join('alice-join', alice);
  b.post('hello', alice, 'hello');
  return { b, alice, bob, carol };
}

const call = (store, agent, fields) => {
  const body = signed(agent, fields);
  const auth = verifyRequest(body);
  assert.equal(auth.error, undefined);
  return sync(store, body, auth.agent);
};

test('outbox is published in one call and read back', () => {
  const { b, alice } = publicRoom();
  const store = new Store();
  const res = call(store, alice, { outbox: events(b, 'create', 'alice-join', 'hello') });
  assert.deepEqual(res.accepted, events(b, 'create', 'alice-join', 'hello').map((e) => e.id));
  assert.deepEqual(res.rejected, []);
  const room = res.rooms[b.room.id];
  assert.deepEqual(room.events.map((e) => e.id), res.accepted);
  assert.deepEqual(room.heads, [b.id('hello')]);
  assert.equal(room.events[2].content, events(b, 'hello')[0].content);

  // Nothing new since the client's heads: the room is left out.
  const again = call(store, alice, { heads: { [b.room.id]: [b.id('hello')] } });
  assert.deepEqual(again.rooms, {});
});

test('exact retries are harmless', () => {
  const { b, alice } = publicRoom();
  const store = new Store();
  const body = signed(alice, { outbox: events(b, 'create', 'alice-join', 'hello') });
  const first = sync(store, body, verifyRequest(body).agent);
  const retry = sync(store, body, verifyRequest(body).agent);
  assert.deepEqual(retry.accepted, first.accepted);
  assert.deepEqual(retry.rejected, []);
});

test('outbox rejections, discards, and pending events', () => {
  const { b, alice, bob } = publicRoom();
  const store = new Store();
  const [create, join, hello] = events(b, 'create', 'alice-join', 'hello');
  const res = call(store, alice, {
    outbox: [create, hello, join, { ...join, sig: create.sig }, 42],
  });
  assert.deepEqual(res.accepted, [create.id, join.id]);
  assert.deepEqual(res.pending, [{ id: hello.id, missing: [join.id] }]);
  assert.deepEqual(res.rejected, [{ id: join.id, reason: 'bad_signature' }, { id: null, reason: 'malformed' }]);

  b.join('bob-join', bob);
  const other = call(store, alice, { outbox: events(b, 'bob-join') });
  assert.deepEqual(other.rejected, [{ id: b.id('bob-join'), reason: 'not_author' }]);

  const unknown = new Builder();
  unknown.create('c2', unknown.agent('alice'), { type: 'private' });
  unknown.join('j2', unknown.agent('alice'));
  const res2 = call(store, alice, { outbox: events(unknown, 'j2') });
  assert.deepEqual(res2.pending, [{ id: unknown.id('j2'), missing: [], reason: 'unknown_room' }]);
});

test('invites carry what the invitee needs to join', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  b.create('create', alice, { type: 'private' });
  b.join('alice-join', alice);
  b.member('invite', alice, bob, 'invite');
  const store = new Store();
  call(store, alice, { outbox: events(b, 'create', 'alice-join', 'invite') });

  const res = call(store, bob, {});
  assert.equal(res.invites.length, 1);
  const inv = res.invites[0];
  assert.equal(inv.room, b.room.id);
  assert.equal(inv.from, alice.id);
  assert.deepEqual(inv.heads, [b.id('invite')]);
  assert.deepEqual(inv.state.map((e) => e.id).sort(), [b.id('create'), b.id('invite')].sort());
  assert.deepEqual(res.rooms, {}, 'invitees cannot read a private room');

  b.join('bob-join', bob);
  const joined = call(store, bob, { outbox: events(b, 'bob-join') });
  assert.deepEqual(joined.accepted, [b.id('bob-join')]);
  assert.deepEqual(joined.invites, []);
  assert.equal(joined.rooms[b.room.id].events.length, 4);

  const seen = call(store, alice, { heads: { [b.room.id]: [b.id('invite')] } });
  assert.deepEqual(seen.rooms[b.room.id].events.map((e) => e.id), [b.id('bob-join')]);
});

test('a new DM shows up as an invite until joined', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  b.create('create', alice, { type: 'dm', dm_with: bob.id, dm_key: dmKey(alice.id, bob.id) });
  b.join('alice-join', alice);
  const store = new Store();
  call(store, alice, { outbox: events(b, 'create', 'alice-join') });
  const res = call(store, bob, {});
  assert.deepEqual(res.invites.map((i) => [i.room, i.type, i.from]), [[b.room.id, 'dm', alice.id]]);
  b.join('bob-join', bob);
  assert.deepEqual(call(store, bob, { outbox: events(b, 'bob-join') }).invites, []);
});

test('public rooms can be read without joining; private rooms cannot', () => {
  const { b, alice, carol } = publicRoom();
  const priv = new Builder();
  priv.create('create', priv.agent('alice'), { type: 'private' });
  priv.join('alice-join', priv.agent('alice'));
  const store = new Store();
  call(store, alice, { outbox: events(b, 'create', 'alice-join', 'hello') });
  call(store, alice, { outbox: events(priv, 'create', 'alice-join') });

  const res = call(store, carol, { heads: { [b.room.id]: [], [priv.room.id]: [] } });
  assert.equal(res.rooms[b.room.id].events.length, 3);
  assert.deepEqual(res.rooms[priv.room.id], { readable: false, membership: null });
});

test('a removed member learns of it and reads nothing more', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  b.create('create', alice, { type: 'private' });
  b.join('alice-join', alice);
  b.member('invite', alice, bob, 'invite');
  b.join('bob-join', bob);
  b.member('remove', alice, bob, 'leave');
  b.sealed('after', alice, 'bob cannot see this');
  const store = new Store();
  call(store, alice, { outbox: events(b, 'create', 'alice-join', 'invite') });
  call(store, bob, { outbox: events(b, 'bob-join') });
  call(store, alice, { outbox: events(b, 'remove', 'after') });

  const res = call(store, bob, { heads: { [b.room.id]: [b.id('bob-join')] } });
  assert.equal(res.rooms[b.room.id].readable, false);
  assert.equal(res.rooms[b.room.id].membership.id, b.id('remove'));
});

test('limit_bytes pages oldest first until more is false', () => {
  const { b, alice, bob } = publicRoom();
  for (let i = 0; i < 30; i++) b.post(`p${i}`, alice, `message ${i} `.repeat(20));
  const store = new Store();
  call(store, alice, { outbox: b.steps.map((s) => s.event) });

  const got = [];
  let heads = [];
  for (let calls = 0; ; calls++) {
    assert.ok(calls < 20, 'paging must terminate');
    const res = call(store, bob, { heads: { [b.room.id]: heads }, limit_bytes: 4000 });
    const page = res.rooms[b.room.id]?.events ?? [];
    got.push(...page.map((e) => e.id));
    if (page.length) heads = [page.at(-1).id];
    if (!res.more) break;
  }
  assert.deepEqual(got, b.steps.map((s) => s.event.id));
});

test('eventsSince returns exactly the other branch of a fork', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  b.create('create', alice, { type: 'public' });
  b.join('alice-join', alice);
  b.join('bob-join', bob);
  b.post('a1', alice, 'a1', { parents: ['bob-join'] });
  b.post('a2', alice, 'a2');
  b.post('b1', bob, 'b1', { parents: ['bob-join'] });
  b.post('b2', bob, 'b2', { parents: ['b1'] });
  const since = b.room.eventsSince([b.id('a2')]);
  assert.deepEqual(since.ids, [b.id('b1'), b.id('b2')]);
  assert.equal(since.missing, false);

  const unknown = b.room.eventsSince([b.id('a2'), 'e_' + 'A'.repeat(43)]);
  assert.deepEqual(unknown.ids, [b.id('b1'), b.id('b2')]);
  assert.equal(unknown.missing, true);
  assert.equal(b.room.eventsSince([]).ids.length, 7);
});

test('deletions withhold content, whichever arrives first', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  const carol = b.agent('carol');
  b.create('create', alice, { type: 'public' });
  b.join('alice-join', alice);
  b.join('bob-join', bob);
  b.join('carol-join', carol);
  b.post('by-alice', alice, 'mine');
  b.post('by-bob', bob, 'his');
  b.post('by-carol', carol, 'hers');
  b.add('alice-deletes-own', alice, 'msg.delete', { data: { target: b.id('by-alice') } });
  b.add('alice-moderates', alice, 'msg.delete', { data: { target: b.id('by-bob') } });
  b.add('bob-tries', bob, 'msg.delete', { data: { target: b.id('by-carol') } });
  // A deletion that reaches the node before its target.
  b.post('late', carol, 'late', { parents: ['bob-tries'] });
  b.add('carol-deletes-late', carol, 'msg.delete', { data: { target: b.id('late') }, parents: ['bob-tries'] });

  const store = new Store();
  for (const ev of b.steps.map((s) => s.event).filter((e) => e.id !== b.id('late'))) store.ingest(ev);
  store.ingest(events(b, 'late')[0]);

  const room = store.room(b.room.id);
  const served = (l) => store.serve(room, b.id(l));
  assert.equal(served('by-alice').withheld, 'author');
  assert.equal(served('by-alice').content, undefined);
  assert.equal(served('by-bob').withheld, 'moderator');
  assert.equal(served('by-carol').withheld, undefined);
  assert.ok(served('by-carol').content);
  assert.equal(served('late').withheld, 'author');
});

test('rejected and soft-failed events are served as marked headers', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  b.create('create', alice, { type: 'public' });
  b.join('alice-join', alice);
  b.post('bob-not-joined', bob, 'x');
  b.join('bob-join', bob);
  b.member('ban', alice, bob, 'ban', { parents: ['bob-join'] });
  b.post('bob-concurrent', bob, 'y', { parents: ['bob-join'] });
  const store = new Store();
  for (const s of b.steps) store.ingest(s.event);
  const room = store.room(b.room.id);
  assert.deepEqual(store.serve(room, b.id('bob-not-joined')).status, 'rejected');
  assert.equal(store.serve(room, b.id('bob-not-joined')).content, undefined);
  assert.equal(store.serve(room, b.id('bob-concurrent')).status, 'soft_failed');
});

test('state survives a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meadow-'));
  try {
    const path = join(dir, 'node.db');
    const b = new Builder();
    const alice = b.agent('alice');
    const bob = b.agent('bob');
    b.create('create', alice, { type: 'private' });
    b.join('alice-join', alice);
    b.member('invite', alice, bob, 'invite');
    b.post('hello', alice, 'x', { patch: () => {} });

    let store = new Store(path);
    const nodeId = store.node.id;
    for (const s of b.steps) store.ingest(s.event);
    const heads = store.room(b.room.id).heads();
    store.close();

    store = new Store(path);
    assert.equal(store.node.id, nodeId);
    assert.deepEqual(store.room(b.room.id).heads(), heads);
    assert.equal(store.room(b.room.id).outcome(b.id('hello')).reason, 'commitment_rules');
    assert.deepEqual(store.membership(b.room.id, bob.id).membership, 'invite');
    b.join('bob-join', bob);
    assert.equal(store.ingest(events(b, 'bob-join')[0]).outcome, 'accepted');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('request auth: window, signature, and replays', () => {
  const { alice } = publicRoom();
  const now = Date.now();
  const body = signed(alice, { heads: {} }, now);
  assert.equal(verifyRequest(body, now).agent, alice.id);
  assert.equal(verifyRequest(body, now).agent, alice.id, 'replay inside the window');
  assert.equal(verifyRequest(body, now + 121_000).error, 'auth_expired');
  assert.equal(verifyRequest({ ...body, heads: { x: [] } }, now).error, 'auth_invalid');
  assert.equal(verifyRequest({}, now).error, 'auth_missing');
});
