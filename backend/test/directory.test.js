import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Builder } from '../../conformance/tools/builder.js';
import { directory } from '../src/api/rooms.js';
import { RequestError } from '../src/api/sync.js';
import { Store } from '../src/store/store.js';

// A room created and joined by `owner` (a fresh agent per room), with optional meta.
function room(type, meta, owner = 'alice') {
  const b = new Builder();
  const a = b.agent(owner);
  b.create('create', a, { type });
  b.join('join', a);
  if (meta) b.meta('meta', a, meta);
  return { b, a };
}

const feed = (store, b) => {
  for (const s of b.steps) assert.equal(store.ingest(s.event).outcome, 'accepted', s.label);
};

test('lists public rooms whose room.meta says listed, and nothing else', () => {
  const store = new Store();
  const general = room('public', { name: 'General', topic: 'Say hello', listed: true });
  const unlisted = room('public', { name: 'Quiet' });
  const off = room('public', { name: 'Off', listed: false });
  const bare = room('public');
  const secret = room('private', { name: 'Secret', listed: true });
  for (const r of [general, unlisted, off, bare, secret]) feed(store, r.b);

  const res = directory(store, {});
  assert.equal(res.cursor, undefined);
  assert.equal(res.rooms.length, 1);
  const [e] = res.rooms;
  assert.equal(e.room, general.b.room.id);
  assert.equal(e.members, 1);
  assert.equal(e.name, 'General');
  assert.equal(e.topic, 'Say hello');
  assert.ok(Number.isSafeInteger(e.active_at));
  // Agent-written text comes last (§7.6).
  assert.deepEqual(Object.keys(e), ['room', 'members', 'active_at', 'name', 'topic']);
});

test('follows the room state: joins, relisting, and unlisting', () => {
  const store = new Store();
  const { b, a } = room('public', { name: 'General', listed: true });
  const bob = b.agent('bob');
  b.join('bob-join', bob);
  feed(store, b);
  assert.equal(directory(store, {}).rooms[0].members, 2);

  b.meta('rename', a, { name: 'Lobby', listed: true });
  feed(store, { steps: b.steps.slice(-1) });
  assert.equal(directory(store, {}).rooms[0].name, 'Lobby');

  b.meta('hide', a, { name: 'Lobby', listed: false });
  feed(store, { steps: b.steps.slice(-1) });
  assert.deepEqual(directory(store, {}).rooms, []);
});

test('query matches name or topic, case-insensitively, with LIKE wildcards taken literally', () => {
  const store = new Store();
  const rooms = [
    room('public', { name: 'General', listed: true }, 'a1'),
    room('public', { name: 'Charts', topic: 'Pretty GENERAL graphs', listed: true }, 'a2'),
    room('public', { name: '100%_real', listed: true }, 'a3'),
    room('public', { name: '100 real', listed: true }, 'a4'),
  ];
  for (const r of rooms) feed(store, r.b);
  const names = (q) => directory(store, { query: q }).rooms.map((e) => e.name).sort();
  assert.deepEqual(names('general'), ['Charts', 'General']);
  assert.deepEqual(names('%_'), ['100%_real']);
  assert.deepEqual(names('nothing'), []);
});

test('pages in room ID order with a cursor', () => {
  const store = new Store();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = room('public', { name: `room ${i}`, listed: true }, `owner${i}`);
    feed(store, r.b);
    ids.push(r.b.room.id);
  }
  ids.sort();
  const seen = [];
  let cursor;
  do {
    const res = directory(store, { limit: 2, ...(cursor && { cursor }) });
    assert.ok(res.rooms.length <= 2);
    seen.push(...res.rooms.map((e) => e.room));
    cursor = res.cursor;
  } while (cursor);
  assert.deepEqual(seen, ids);
});

test('the directory survives a restart and drops expired rooms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meadow-dir-'));
  const path = join(dir, 'node.db');
  try {
    let store = new Store(path);
    const { b } = room('public', { name: 'General', listed: true });
    feed(store, b);
    store.close();

    store = new Store(path);
    assert.equal(directory(store, {}).rooms[0].room, b.room.id);
    store.sweep(Date.now() + store.retention.roomMs + 1);
    assert.deepEqual(directory(store, {}).rooms, []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bad requests are refused', () => {
  const store = new Store();
  for (const body of [
    { query: '' },
    { query: 'x'.repeat(257) },
    { query: 5 },
    { limit: 0 },
    { limit: 51 },
    { cursor: 3 },
    { heads: {} },
  ]) {
    assert.throws(() => directory(store, body), RequestError, JSON.stringify(body));
  }
});
