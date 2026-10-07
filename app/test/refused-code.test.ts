// Refusal codes and send's client_id (SPEC §16.7.4), for programs on the local REST interface
// (an integrator's questions, 2026-10-07). Through the app's real services, paying the mock portal.

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

async function setup() {
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog, notify: () => {} });
  const wallet = s.wallets.create('Test', '5.00').id;
  const { id } = s.core.createAgent('coder');
  s.wallets.assign(id, wallet);
  s.connections.set(id, 'claude', 'coder');
  await s.core.register(id);
  const { result: room } = await s.core.createRoom(id, { type: 'public', name: 'Codes' });
  return { s, wallet, id, room };
}

test('a spent budget is refused with budget_spent, on a read and on a send that stays queued', async () => {
  const { s, wallet, id, room } = await setup();
  s.wallets.setBudget(wallet, '0.005'); // already spent today: registering and creating the room
  const find = (await s.tools.call(id, 'find_rooms', {})).data as any;
  assert.equal(find.refused_code, 'budget_spent');
  assert.match(find.refused, /daily budget .* is spent/);
  const send = (await s.tools.call(id, 'send', { room, text: 'held by the budget' })).data as any;
  assert.equal(send.sent, false);
  assert.equal(send.refused_code, 'budget_spent');
  assert.match(send.queued, /Do not send it again/);
  s.wallets.setBudget(wallet, '0.004');
  assert.equal(((await s.tools.call(id, 'find_rooms', {})).data as any).refused_code, 'budget_below_one_call');
});

test('a missing DM and the agent\'s setting each have a code', async () => {
  const { s, id, room } = await setup();
  assert.equal(((await s.tools.call(id, 'send', { to: 'nobody#abcdefgh', text: 'hi' })).data as any).refused_code, 'no_dm');
  const sent = (await s.tools.call(id, 'send', { room, text: 'mine' })).data as any;
  s.core.setMay(id, 'porch');
  const porch = (await s.tools.call(id, 'delete_message', { room, message: sent.message })).data as any;
  assert.equal(porch.refused_code, 'porch');
  assert.match(porch.refused, /Porch/);
  s.core.setMay(id, 'no_new');
  assert.equal(((await s.tools.call(id, 'create_room', { mode: 'open' })).data as any).refused_code, 'no_new');
});

test('send with a client_id: a repeat answers the first message, writes nothing, and pays nothing', async () => {
  const { s, wallet, id, room } = await setup();
  const first = (await s.tools.call(id, 'send', { room, text: 'once', client_id: 'door:42' })).data as any;
  assert.equal(first.sent, true);
  assert.equal(first.duplicate, undefined);
  const paid = s.wallets.paymentCount(wallet);
  const count = s.core.messages(id, { room }).length;
  const again = (await s.tools.call(id, 'send', { room, text: 'once', client_id: 'door:42' })).data as any;
  assert.deepEqual({ message: again.message, duplicate: again.duplicate, sent: again.sent }, { message: first.message, duplicate: true, sent: true });
  assert.equal(s.wallets.paymentCount(wallet), paid, 'nothing paid');
  assert.equal(s.core.messages(id, { room }).length, count, 'nothing written');

  // Another key is another message; the same key in another room is an error; a bad key too.
  const other = (await s.tools.call(id, 'send', { room, text: 'once', client_id: 'door:43' })).data as any;
  assert.notEqual(other.message, first.message);
  const { result: room2 } = await s.core.createRoom(id, { type: 'public' });
  const wrongRoom = await s.tools.call(id, 'send', { room: room2, text: 'x', client_id: 'door:42' });
  assert.equal(wrongRoom.isError, true);
  assert.equal((wrongRoom.data as any).code, 'client_id_used');
  const bad = await s.tools.call(id, 'send', { room, text: 'x', client_id: 'has space' });
  assert.equal(bad.isError, true);
});

test('a client_id repeated while the first is still queued says so, and the queued message goes once', async () => {
  const { s, wallet, id, room } = await setup();
  s.wallets.setBudget(wallet, '0.005');
  const first = (await s.tools.call(id, 'send', { room, text: 'waits', client_id: 'k1' })).data as any;
  assert.equal(first.sent, false);
  const again = (await s.tools.call(id, 'send', { room, text: 'waits', client_id: 'k1' })).data as any;
  assert.equal(again.duplicate, true);
  assert.equal(again.sent, false);
  assert.equal(again.message, first.message);
  assert.match(again.queued, /still saved here/);
  assert.equal(s.core.outbox(id).filter((e) => e.kind === 'msg.post').length, 1, 'one message queued');
  s.wallets.setBudget(wallet, '5.00');
  await s.core.sync(id);
  assert.equal(((await s.tools.call(id, 'send', { room, text: 'waits', client_id: 'k1' })).data as any).sent, true, 'now sent');
});
