// inbox with a room (SPEC §16.7.4, user 2026-10-25): one busy room's unread, without the rest of
// the agent's rooms; the rest stays unread and is counted. Through the app's real services,
// paying the mock portal in front of a node.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

let portal: MockPortal;
before(async () => {
  portal = await startMockPortal();
});
after(() => portal.close());

async function computer() {
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog, notify: () => {} });
  const wallet = s.wallets.create('Test', '5.00').id;
  const agent = async (name: string) => {
    const { id } = s.core.createAgent(name);
    s.wallets.assign(id, wallet);
    s.connections.set(id, 'claude', name);
    await s.core.register(id);
    return id;
  };
  return { s, agent };
}

/** Bob is in two public rooms with Alice: two new messages in the busy one, one in the quiet one. */
async function setup() {
  const A = await computer();
  const B = await computer();
  const alice = await A.agent('alice');
  const bob = await B.agent('bob');
  const { result: busy } = await A.s.core.createRoom(alice, { type: 'public', name: 'Busy' });
  const { result: quiet } = await A.s.core.createRoom(alice, { type: 'public', name: 'Quiet' });
  await B.s.core.joinRoom(bob, busy);
  await B.s.core.joinRoom(bob, quiet);
  await A.s.core.sync(alice);
  await A.s.core.send(alice, busy, 'one');
  await A.s.core.send(alice, busy, 'two');
  await A.s.core.send(alice, quiet, 'elsewhere');
  await B.s.core.sync(bob);
  return { B, bob, busy, quiet };
}

const texts = (answer: any) => answer.rooms.flatMap((r: any) => r.messages.map((m: any) => m.text));

test('inbox with a room gives only that room, and counts the rest without marking it read', async () => {
  const { B, bob, busy, quiet } = await setup();
  const one: any = (await B.s.tools.call(bob, 'inbox', { room: busy })).data;
  assert.deepEqual(one.rooms.map((r: any) => r.room), [busy]);
  assert.deepEqual(texts(one), ['one', 'two']);
  assert.equal(one.unread_elsewhere, 1);
  assert.equal(one.more_unread, undefined);

  // The busy room is read now; asking again says so, and the quiet room is still waiting.
  const again: any = (await B.s.tools.call(bob, 'inbox', { room: busy })).data;
  assert.equal(again.rooms.length, 0);
  assert.match(again.note, /Nothing new in this room/);
  assert.equal(again.unread_elsewhere, 1);
  const rest: any = (await B.s.tools.call(bob, 'inbox', {})).data;
  assert.deepEqual(rest.rooms.map((r: any) => r.room), [quiet]);
  assert.deepEqual(texts(rest), ['elsewhere']);
});

test('inbox with a room and a limit counts what is left in that room', async () => {
  const { B, bob, busy } = await setup();
  const first: any = (await B.s.tools.call(bob, 'inbox', { room: busy, limit: 1 })).data;
  assert.deepEqual(texts(first), ['one']);
  assert.equal(first.more_unread, 1);
  assert.equal(first.unread_elsewhere, 1);
});

test('inbox with a room the agent is not in says so; the runner is refused outside its rooms', async () => {
  const { B, bob, busy, quiet } = await setup();
  const none: any = (await B.s.tools.call(bob, 'inbox', { room: 'r_notOneOfMine' })).data;
  assert.equal(none.rooms.length, 0);
  assert.match(none.note, /not one of its rooms/);
  assert.equal(none.unread_elsewhere, 3);

  const refused: any = (await B.s.tools.call(bob, 'inbox', { room: busy }, { rooms: new Set([quiet]) })).data;
  assert.equal(refused.refused_code, 'not_enabled_here');
  assert.equal(B.s.core.messages(bob, { undelivered: true }).filter((m) => m.room === busy).length, 2, 'nothing marked read');
});
