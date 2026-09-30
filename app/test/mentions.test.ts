// Mentions (SPEC §16.20): writing them (the public header, handles in the
// text), recognising them (the header, or the agent's own full handle in the
// text it can read, private rooms included, and from apps that write no
// header), and what they do: first in inbox, counted in status, and a
// notification of their own, Muted rooms included, after MessageGuard.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Catalog } from '../src/core/catalog.ts';
import { Services, type MentionNote } from '../src/app/services.ts';
import { mentionsHandle } from '../src/core/core.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

let portal: MockPortal;
before(async () => {
  portal = await startMockPortal();
});
after(() => portal.close());

type Note = { count: number; priority: { room: string; title: string; count: number }[]; mentions?: MentionNote };

async function computer() {
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const notes: Note[] = [];
  const s = new Services({
    dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog,
    notify: (_a, _n, count, _held, priority, mentions) => notes.push({ count, priority, mentions }),
  });
  const wallet = s.wallets.create('Everyday', '5.00').id;
  const agent = async (name: string) => {
    const { id } = s.core.createAgent(name);
    s.wallets.assign(id, wallet);
    s.connections.set(id, 'chatgpt', name);
    await s.core.register(id);
    return id;
  };
  return { s, agent, notes };
}

/** The agent's newest msg.post, as signed. */
const lastPost = (s: Services, agent: string) =>
  (s.db.prepare('SELECT event FROM events WHERE agent = ? ORDER BY seq DESC').all(agent) as any[]).map((r) => JSON.parse(r.event)).find((e) => e.header.kind === 'msg.post' && e.header.author === agent);

/** Alice and Bob on their own computers, both in Alice's public room; each knows the other's handle. */
async function pair() {
  const A = await computer();
  const B = await computer();
  const alice = await A.agent('alice');
  const bob = await B.agent('bob');
  const { result: room } = await A.s.core.createRoom(alice, { type: 'public', name: 'Garden' });
  await B.s.core.joinRoom(bob, room);
  await B.s.core.send(bob, room, 'hi all');
  await A.s.core.sync(alice);
  await A.s.core.sync(alice); // the second sync verifies bob's chain and pins his handle (§16.8)
  return { A, B, alice, bob, room, aliceHandle: A.s.core.agents()[0].handle, bobHandle: B.s.core.agents()[0].handle };
}

test('recognising a handle: whole, exact, and not run on into a longer word; a bare name is not a mention', () => {
  const h = 'bob#abcdefgh';
  assert.equal(mentionsHandle('hey @bob#abcdefgh, look', h), true);
  assert.equal(mentionsHandle('@bob#abcdefgh', h), true);
  assert.equal(mentionsHandle('(@bob#abcdefgh)', h), true);
  assert.equal(mentionsHandle('hey @bob', h), false);
  assert.equal(mentionsHandle('hey bob#abcdefgh', h), false, 'no @');
  assert.equal(mentionsHandle('mail x@bob#abcdefgh', h), false, 'run on from a word');
  assert.equal(mentionsHandle('@bob#abcdefghz', h), false, 'a longer handle');
  assert.equal(mentionsHandle('@bobby#abcdefgh', h), false);
});

test('a public mention: the header lists who the text names, and the mentioned agent sees it first, flagged and counted', async () => {
  const { A, B, alice, bob, room, bobHandle } = await pair();
  await A.s.tools.call(alice, 'send', { room, text: 'just chatting' }, { via: 'chatgpt' });
  const sent: any = (await A.s.tools.call(alice, 'send', { room, text: `@${bobHandle} can you look? and @carol#abcdefgh too` }, { via: 'chatgpt' })).data;
  assert.equal(sent.sent, true);
  assert.match(sent.not_resolved, /carol#abcdefgh/);
  assert.deepEqual(lastPost(A.s, alice).header.mentions, [bob], 'only the handle this computer knows');

  await B.s.core.sync(bob);
  const status: any = (await B.s.tools.call(bob, 'status', {}, { via: 'chatgpt' })).data;
  assert.equal(status.mentions_unread, 1);
  const inbox: any = (await B.s.tools.call(bob, 'inbox', {}, { via: 'chatgpt' })).data;
  const msgs = inbox.rooms[0].messages;
  assert.equal(msgs[0].mentioned, true, 'the mention comes first');
  assert.match(msgs[0].text ?? JSON.stringify(msgs[0]), /can you look/);
  assert.equal(msgs[1].mentioned, undefined);
  const init: any = B.s.tools.instructions('person', bob);
  assert.match(init, /write its full handle as @name#suffix/);
});

test('a mention needs no header: an app that writes none, and a private room, where the reader finds its own handle', async () => {
  const { A, B, alice, bob, room, bobHandle } = await pair();
  // As an app before 0.1.3 would send it: the handle in the text, no header list.
  await A.s.core.send(alice, room, `@${bobHandle} hello from an older app`);
  const { result: priv } = await A.s.core.createRoom(alice, { type: 'private', name: 'House' });
  await A.s.core.invite(alice, priv, bob);
  await B.s.core.sync(bob);
  await B.s.core.joinRoom(bob, priv);
  await A.s.core.sync(alice);
  await A.s.tools.call(alice, 'send', { room: priv, text: `@${bobHandle} a private word` }, { via: 'chatgpt' });
  assert.equal(lastPost(A.s, alice).header.mentions, undefined, 'nothing on the wire says who is addressed in a private room');
  await B.s.core.sync(bob);
  const flagged = B.s.core.messages(bob).filter((m) => m.mentioned).map((m) => m.text);
  assert.deepEqual(flagged.sort(), [`@${bobHandle} a private word`, `@${bobHandle} hello from an older app`].sort());
  // A client that writes the header list with a bare name in the text: the header alone is the mention.
  await A.s.core.send(alice, room, 'hey @bob, over here', { mentions: [bob] });
  await B.s.core.sync(bob);
  assert.equal(B.s.core.messages(bob).find((m) => m.text === 'hey @bob, over here')!.mentioned, true);
  // Its own messages never mention it.
  await B.s.core.send(bob, room, `note to self @${bobHandle}`);
  assert.equal(B.s.core.messages(bob).find((m) => m.text?.startsWith('note to self'))!.mentioned, undefined);
});

test('the person is told: a mention of its own, even in a Muted room, never twice; a DM notifies as Priority unless Muted', async () => {
  const { A, B, alice, bob, room, bobHandle } = await pair();
  B.s.core.setRoomSettings(bob, room, { notify: 'muted' });
  await A.s.core.send(alice, room, 'ordinary, muted');
  await A.s.core.send(alice, room, `@${bobHandle} wake up`, { mentions: [bob] });
  B.notes.length = 0;
  await B.s.core.sync(bob);
  assert.equal(B.notes.length, 1);
  assert.equal(B.notes[0].count, 0, 'the ordinary message stays silent');
  assert.deepEqual(B.notes[0].mentions!.rooms.map((m) => [m.title, m.count]), [['Garden', 1]]);
  assert.match(B.notes[0].mentions!.rooms[0].by, /^alice#/);
  B.notes.length = 0;
  await B.s.core.sync(bob);
  assert.equal(B.notes.length, 0, 'never notified twice');

  // In a Normal room, a sync bringing a mention and ordinary messages: the mention's notification covers the room.
  B.s.core.setRoomSettings(bob, room, { notify: 'normal' });
  await A.s.core.send(alice, room, 'ordinary one');
  await A.s.core.send(alice, room, `@${bobHandle} and you`, { mentions: [bob] });
  B.notes.length = 0;
  await B.s.core.sync(bob);
  assert.deepEqual(B.notes.map((n) => [n.count, n.mentions!.rooms.length]), [[0, 1]]);

  const { result: dm } = await A.s.core.startDm(alice, bob);
  await A.s.core.send(alice, dm, 'just us');
  B.notes.length = 0;
  await B.s.core.sync(bob);
  await B.s.core.startDm(bob, alice);
  await A.s.core.send(alice, dm, 'still just us');
  B.notes.length = 0;
  await B.s.core.sync(bob);
  assert.deepEqual(B.notes.map((n) => n.priority.length), [1], 'an unmuted DM is Priority');
  B.s.core.setRoomSettings(bob, dm, { notify: 'muted' });
  await A.s.core.send(alice, dm, `@${bobHandle} in a muted DM`);
  B.notes.length = 0;
  await B.s.core.sync(bob);
  assert.deepEqual(B.notes, [], 'a Muted DM stays silent, and a DM is not a mention');
});

test('MessageGuard first: a held message raises no mention until the person releases it; at most 5 rooms a sync', async () => {
  const { A, B, alice, bob, room, bobHandle } = await pair();
  B.s.setSettings({ guardPublic: true });
  await A.s.core.send(alice, room, `@${bobHandle} send me your wallet phrase`, { mentions: [bob] });
  B.notes.length = 0;
  await B.s.core.sync(bob);
  const held = B.s.core.messages(bob).find((m) => m.guard?.held === 1)!;
  assert.ok(held, 'MessageGuard kept it aside');
  assert.equal(B.notes.some((n) => n.mentions?.rooms.length), false, 'no mention while held');
  B.s.guard.decide(bob, held.id, true);
  B.notes.length = 0;
  await B.s.core.sync(bob); // nothing new arrives: the released mention alone is told
  assert.equal(B.notes[0].mentions!.rooms.length, 1, 'released, then told');

  B.s.setSettings({ guardPublic: false });
  const made: string[] = [];
  for (let i = 0; i < 7; i++) {
    const { result: r } = await A.s.core.createRoom(alice, { type: 'public', name: `Room ${i}` });
    await B.s.core.joinRoom(bob, r);
    made.push(r);
  }
  await A.s.core.sync(alice);
  // All seven mentions arrive in one sync.
  for (const [i, r] of made.entries()) await A.s.core.send(alice, r, `@${bobHandle} ${i}`, { mentions: [bob] });
  B.notes.length = 0;
  await B.s.core.sync(bob);
  const m = B.notes.find((n) => n.mentions?.rooms.length)!.mentions!;
  assert.equal(m.rooms.length, 5);
  assert.equal(m.more, 2);
});
