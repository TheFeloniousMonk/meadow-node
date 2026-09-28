import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Builder } from '../../conformance/tools/builder.js';
import { verifyRequest } from '../src/api/auth.js';
import { sync } from '../src/api/sync.js';
import { Store } from '../src/store/store.js';
import { events, signed } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

const call = (store, agent, fields) => {
  const body = signed(agent, fields);
  return sync(store, body, verifyRequest(body).agent);
};

function room(type = 'public') {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  b.create('create', alice, { type });
  b.join('alice-join', alice);
  b.post('first', alice, 'first');
  return { b, alice, bob };
}

test('a room expires after 90 days without an accepted event, and any event resets the clock', () => {
  const { b, alice, bob } = room();
  const store = new Store();
  for (const ev of events(b, 'create', 'alice-join', 'first')) store.ingest(ev, T0);

  assert.equal(store.sweep(T0 + 90 * DAY - 1).rooms, 0);
  b.join('bob-join', bob);
  store.ingest(events(b, 'bob-join')[0], T0 + 60 * DAY);
  assert.equal(store.sweep(T0 + 149 * DAY).rooms, 0, 'the join kept it alive');

  // A rejected event is not activity.
  b.post('not-joined', b.agent('carol'), 'x');
  assert.equal(store.ingest(events(b, 'not-joined')[0], T0 + 140 * DAY).outcome, 'rejected');

  assert.deepEqual(store.sweep(T0 + 151 * DAY), { content: 0, rooms: 1, forgotten: 0, reports: 0 });
  assert.equal(store.room(b.room.id), undefined);
  assert.deepEqual(store.roomsOf(alice.id), []);
  assert.ok(store.expired(b.room.id));

  // Late events are refused clearly while the tombstone lasts.
  b.post('late', alice, 'anyone here?');
  assert.deepEqual(store.ingest(events(b, 'late')[0], T0 + 152 * DAY), { outcome: 'discarded', reason: 'room_expired' });
  assert.deepEqual(store.ingest(events(b, 'create')[0], T0 + 152 * DAY), { outcome: 'discarded', reason: 'room_expired' });
  assert.deepEqual(call(store, alice, { heads: { [b.room.id]: [b.id('first')] } }).rooms, { [b.room.id]: { expired: true } });

  // After 30 days the tombstone goes, and the room is simply unknown.
  assert.equal(store.sweep(T0 + 182 * DAY).forgotten, 1);
  assert.equal(store.expired(b.room.id), false);
  assert.equal(store.ingest(events(b, 'late')[0], T0 + 183 * DAY).reason, 'unknown_room');
});

test('content expires after 90 days while the room lives on', () => {
  const { b, alice } = room();
  const store = new Store();
  for (const ev of events(b, 'create', 'alice-join', 'first')) store.ingest(ev, T0);
  b.post('recent', alice, 'recent');
  store.ingest(events(b, 'recent')[0], T0 + 80 * DAY);

  const done = store.sweep(T0 + 91 * DAY);
  assert.equal(done.rooms, 0);
  assert.equal(done.content, 1);
  const r = store.room(b.room.id);
  assert.equal(store.serve(r, b.id('first')).withheld, 'expired');
  assert.equal(store.serve(r, b.id('first')).content, undefined);
  assert.ok(store.serve(r, b.id('recent')).content);
});

test('one new room per sync call', () => {
  const a = new Builder();
  const alice = a.agent('alice');
  a.create('create', alice, { type: 'public' });
  a.join('join', alice);
  const c = new Builder();
  c.create('create', c.agent('alice'), { type: 'private' });
  c.join('join', c.agent('alice'));
  const store = new Store();

  const outbox = [...events(a, 'create', 'join'), ...events(c, 'create', 'join')];
  const first = call(store, alice, { outbox });
  assert.deepEqual(first.accepted, [a.id('create'), a.id('join')]);
  assert.deepEqual(first.pending, [
    { id: c.id('create'), missing: [], reason: 'create_limit' },
    { id: c.id('join'), missing: [], reason: 'unknown_room' },
  ]);

  // Resending the first room is a retry and does not count; the second room now fits.
  const second = call(store, alice, { outbox });
  assert.deepEqual(second.accepted, outbox.map((e) => e.id));
  assert.deepEqual(second.pending, []);
});
