// Sending to the right place (SPEC §16.7.4, a tester's report, 2026-10-05): an AI without its
// usual context sent a message meant for one agent to another agent's DM. DMs now say who they
// are with, send takes `to` and says where each message went, and delete_message withdraws the
// agent's own message. Through the app's real services, paying the mock portal in front of a node.

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
    return { id, handle: s.core.agents().find((a) => a.id === id)!.handle };
  };
  return { s, wallet, agent };
}

/** Bob has a DM with Alice and one with Carol, and both handles are known on his computer. */
async function three() {
  const A = await computer();
  const B = await computer();
  const C = await computer();
  const alice = await A.agent('alice');
  const bob = await B.agent('bob');
  const carol = await C.agent('carol');
  for (const p of [alice, carol]) {
    await B.s.core.resolveAgent(bob.id, p.handle);
    await B.s.core.startDm(bob.id, p.id);
  }
  return { A, B, C, alice, bob, carol };
}

test('status and inbox say who each DM is with', async () => {
  const { A, B, alice, bob, carol } = await three();
  const st = (await B.s.tools.call(bob.id, 'status', {})).data as any;
  const dms = st.rooms.filter((r: any) => r.type === 'dm');
  assert.deepEqual(dms.map((r: any) => r.with).sort(), [alice.handle, carol.handle].sort());

  await A.s.core.sync(alice.id);
  const invite = A.s.core.rooms(alice.id).find((r) => r.type === 'dm')!;
  await A.s.core.joinRoom(alice.id, invite.room);
  await A.s.core.send(alice.id, invite.room, 'hello bob');
  await B.s.core.sync(bob.id);
  const inbox = (await B.s.tools.call(bob.id, 'inbox', {})).data as any;
  assert.equal(inbox.rooms.find((r: any) => r.room === invite.room).with, alice.handle);
  const read = (await B.s.tools.call(bob.id, 'read', { room: invite.room })).data as any;
  assert.equal(read.with, alice.handle);
});

test('send with to goes to that agent’s DM, and sent_to says so', async () => {
  const { B, alice, bob, carol } = await three();
  const r = (await B.s.tools.call(bob.id, 'send', { to: carol.handle, text: 'for carol' })).data as any;
  assert.equal(r.sent, true);
  assert.equal(r.sent_to, `your DM with ${carol.handle}`);
  const carolDm = B.s.core.joinedDmWith(bob.id, carol.id);
  assert.equal(B.s.core.messages(bob.id, { room: carolDm! }).at(-1)?.id, r.message);
  assert.equal(B.s.core.messages(bob.id, { room: B.s.core.joinedDmWith(bob.id, alice.id)! }).length, 0, 'nothing in the DM with alice');

  // By room, too, the answer names the DM.
  const byRoom = (await B.s.tools.call(bob.id, 'send', { room: carolDm!, text: 'again' })).data as any;
  assert.equal(byRoom.sent_to, `your DM with ${carol.handle}`);
});

test('send to an agent with no DM, or with both room and to, costs nothing and says what to do', async () => {
  const { B, bob, carol } = await three();
  const paid = B.s.wallets.paymentCount(B.wallet);
  const none = await B.s.tools.call(bob.id, 'send', { to: 'dave#abcdefgh', text: 'hi' });
  assert.match(String((none.data as any).refused), /no DM with dave#abcdefgh.*start_dm/);
  assert.equal(none.isError, undefined, 'a refusal is an answer');
  const both = await B.s.tools.call(bob.id, 'send', { to: carol.handle, room: 'r_x', text: 'hi' });
  assert.equal(both.isError, true);
  assert.match(String((both.data as any).error), /either room, or to/);
  assert.equal(B.s.wallets.paymentCount(B.wallet), paid, 'nothing was paid for');
});

test('in a named room, sent_to gives the room and its name, fenced', async () => {
  const { B, bob } = await three();
  const { result: room } = await B.s.core.createRoom(bob.id, { type: 'public', name: 'Garden' });
  const r = (await B.s.tools.call(bob.id, 'send', { room, text: 'hi' })).data as any;
  assert.equal(r.sent_to.room, room);
  assert.match(r.sent_to.name, /^<<agent-text [0-9a-f]{6}>>Garden<<\/agent-text [0-9a-f]{6}>>$/);
  assert.ok(r.agent_text, 'the fence is explained');
});

test('delete_message withdraws the agent’s own message; another agent’s is refused for free; Porch refuses it', async () => {
  const { A, B, alice, bob } = await three();
  const sent = (await B.s.tools.call(bob.id, 'send', { to: alice.handle, text: 'oops, wrong DM' })).data as any;
  const dm = B.s.core.joinedDmWith(bob.id, alice.id)!;
  const del = (await B.s.tools.call(bob.id, 'delete_message', { room: dm, message: sent.message })).data as any;
  assert.equal(del.sent, true);
  assert.match(del.note, /already received it may have read it/);
  assert.equal(B.s.core.messages(bob.id, { room: dm }).find((m) => m.id === sent.message)?.status, 'deleted');

  await A.s.core.sync(alice.id);
  await A.s.core.joinRoom(alice.id, dm);
  const { result: theirs } = await A.s.core.send(alice.id, dm, 'mine');
  await B.s.core.sync(bob.id);
  const paid = B.s.wallets.paymentCount(B.wallet);
  const other = (await B.s.tools.call(bob.id, 'delete_message', { room: dm, message: theirs })).data as any;
  assert.match(String(other.refused), /another agent's/);
  assert.equal(B.s.wallets.paymentCount(B.wallet), paid);

  B.s.core.setMay(bob.id, 'porch');
  assert.match(String(((await B.s.tools.call(bob.id, 'delete_message', { room: dm, message: sent.message })).data as any).refused), /Porch/);
});
