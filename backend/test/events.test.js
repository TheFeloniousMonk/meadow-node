import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Builder } from '../../conformance/tools/builder.js';
import { fetchEvents } from '../src/api/events.js';
import { RequestError, SYNC_LIMITS } from '../src/api/sync.js';
import { Store } from '../src/store/store.js';

const feed = (store, b) => {
  for (const s of b.steps) assert.equal(store.ingest(s.event).outcome, 'accepted', s.label);
};

// A public room (alice) and a private room (carol, with dave invited and joined,
// then erin joined and removed).
function world() {
  const pub = new Builder();
  const alice = pub.agent('alice');
  pub.create('create', alice, { type: 'public' });
  pub.join('join', alice);
  pub.post('hello', alice, 'hello');
  pub.post('bye', alice, 'bye');
  pub.add('delete', alice, 'msg.delete', { data: { target: pub.id('bye') } });

  const priv = new Builder();
  const carol = priv.agent('carol');
  const dave = priv.agent('dave');
  const erin = priv.agent('erin');
  priv.create('create', carol, { type: 'private' });
  priv.join('join', carol);
  priv.member('invite-dave', carol, dave, 'invite');
  priv.join('dave-join', dave);
  priv.member('invite-erin', carol, erin, 'invite');
  priv.join('erin-join', erin);
  priv.sealed('secret', carol, 'secret');
  priv.member('remove-erin', carol, erin, 'leave');

  const store = new Store();
  feed(store, pub);
  feed(store, priv);
  return { store, pub, priv, alice, carol, dave, erin };
}

test('anonymous callers get public-room events in request order, served as in sync', () => {
  const { store, pub } = world();
  const ids = [pub.id('hello'), pub.id('create'), pub.id('bye')];
  const res = fetchEvents(store, { ids }, null);
  assert.equal(res.node, store.node.id);
  assert.deepEqual(res.events.map((e) => e.id), ids);
  assert.deepEqual(res.unknown, []);
  assert.deepEqual(res.more, []);
  assert.equal(res.events[0].content, pub.steps.find((s) => s.label === 'hello').event.content);
  assert.equal(res.events[2].withheld, 'author');
  assert.equal(res.events[2].content, undefined);
  // Metadata first, events last (§7.6).
  assert.deepEqual(Object.keys(res), ['node', 'unknown', 'more', 'events']);
});

test('private-room events only for agents joined now; one answer for every refusal', () => {
  const { store, pub, priv, alice, carol, dave, erin } = world();
  const secret = priv.id('secret');
  const never = 'e_' + 'A'.repeat(43);

  assert.equal(store.membership(priv.room.id, erin.id).membership, 'leave');
  assert.deepEqual(fetchEvents(store, { ids: [secret] }, carol.id).events.map((e) => e.id), [secret]);
  assert.deepEqual(fetchEvents(store, { ids: [secret] }, dave.id).events.map((e) => e.id), [secret]);
  for (const who of [null, alice.id, erin.id]) {
    const res = fetchEvents(store, { ids: [secret, never, pub.id('hello')] }, who);
    assert.deepEqual(res.unknown, [secret, never], `caller ${who}`);
    assert.deepEqual(res.events.map((e) => e.id), [pub.id('hello')]);
  }
});

test('expired rooms are unknown', () => {
  const { store, pub } = world();
  store.sweep(Date.now() + store.retention.roomMs + 1);
  const res = fetchEvents(store, { ids: [pub.id('hello')] }, null);
  assert.deepEqual(res.unknown, [pub.id('hello')]);
  assert.deepEqual(res.events, []);
});

test('events that do not fit are returned in more, in order', () => {
  const b = new Builder();
  const alice = b.agent('alice');
  b.create('create', alice, { type: 'public' });
  b.join('join', alice);
  const big = 'x'.repeat(60 * 1024);
  const ids = [];
  for (let i = 0; i < 80; i++) ids.push(b.post(`p${i}`, alice, `${i} ${big}`));
  const store = new Store();
  feed(store, b);

  const first = fetchEvents(store, { ids }, null);
  assert.ok(first.more.length > 0);
  assert.ok(JSON.stringify(first.events).length <= SYNC_LIMITS.maxBytes);
  assert.deepEqual([...first.events.map((e) => e.id), ...first.more], ids);
  const rest = fetchEvents(store, { ids: first.more }, null);
  assert.deepEqual(rest.more, []);
  assert.deepEqual(rest.events.map((e) => e.id), first.more);
});

test('bad requests are refused', () => {
  const { store, pub } = world();
  const id = pub.id('hello');
  for (const body of [
    {},
    { ids: [] },
    { ids: 'e_x' },
    { ids: ['nope'] },
    { ids: [id, id] },
    { ids: Array.from({ length: 101 }, (_, i) => 'e_' + String(i).padStart(43, 'A')) },
    { ids: [id], heads: {} },
  ]) {
    assert.throws(() => fetchEvents(store, body, null), RequestError, JSON.stringify(body).slice(0, 80));
  }
});
