// Room modes and moderation (SPEC §4.4, §16.24): the four modes over the power
// table, the AI asked at creation, results that explain the room, the moderate
// tool, hints at the moment they matter, and hiding on this computer only.
// Calls are paid through the mock portal, in front of a node in this process.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { Catalog } from '../src/core/catalog.ts';
import { Wallets } from '../src/core/wallets.ts';
import { PortalTransport } from '../src/core/portal.ts';
import { Core, type Received } from '../src/core/core.ts';
import { ToolHost, HINTS } from '../src/core/tools.ts';
import { Activity } from '../src/core/activity.ts';
import { modeOf } from '../src/core/modes.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

let portal: MockPortal;
const db = openDb();
const vault = new Vault(randomBytes(32));
let core: Core;
let host: ToolHost;
let wallets: Wallets;
let walletId = '';
const received: { agent: string; what: Received }[] = [];

before(async () => {
  portal = await startMockPortal();
  const catalog = new Catalog({ url: portal.catalogUrl });
  wallets = new Wallets({ db, vault, catalog });
  core = new Core({ db, vault, transport: new PortalTransport({ catalog, wallets }), onReceived: (agent, what) => received.push({ agent, what }) });
  host = new ToolHost({ core, wallets, catalog, balance: async () => 1_000_000n, activity: new Activity({ db }) });
  walletId = wallets.create('Everyday', '5.00').id;
});
after(async () => {
  await portal.close();
});

async function agent(name: string) {
  const { id } = core.createAgent(name);
  wallets.assign(id, walletId);
  await host.call(id, 'register', {});
  return { id, handle: core.agents().find((a) => a.id === id)!.handle };
}
const call = async (who: string, name: string, args: Record<string, unknown> = {}) => (await host.call(who, name, args, { via: 'claude' })) as { data: any; isError?: boolean };

test('create_room needs a mode, says what the room is, and builds each mode from the power table', async () => {
  const owner = await agent('maker');
  const missing = await call(owner.id, 'create_room', { name: 'No mode' });
  assert.equal(missing.isError, true);
  assert.match(missing.data.error, /mode is required/);
  assert.equal((await call(owner.id, 'create_room', { type: 'public' })).isError, true); // the old argument is gone

  const made: Record<string, string> = {};
  for (const mode of ['open', 'moderated', 'announcements', 'private']) {
    const r = await call(owner.id, 'create_room', { mode, name: mode });
    assert.equal(r.data.sent, true, mode);
    made[mode] = r.data.room;
    assert.equal(core.roomInfo(owner.id, r.data.room)!.mode, mode);
    assert.match(r.data.room_mode, new RegExp(`^${mode[0].toUpperCase()}${mode.slice(1)}: .*Your role: owner\\.`));
  }
  assert.match((await call(owner.id, 'create_room', { mode: 'moderated' })).data.room_mode, /approve a poster with moderate/);
  assert.equal((await call(owner.id, 'create_room', { mode: 'private', listed: true })).isError, true);

  // status names every room's mode and the agent's role.
  const st = (await call(owner.id, 'status')).data;
  assert.equal(st.rooms.find((r: any) => r.room === made.announcements).mode, 'announcements');
  assert.equal(st.rooms.find((r: any) => r.room === made.private).your_role, 'owner');

  // The tool list states the four modes and asks the AI to ask its person.
  const def = host.list().find((t) => t.name === 'create_room')!;
  assert.match(def.description, /moderated: anyone can read it, and only agents the owner approves can post/);
  assert.match(def.description, /ask them/);
  assert.equal(host.list().find((t) => t.name === 'moderate')!.annotations.destructiveHint, true);
});

test('Moderated: members wait, the owner is told once, approves and silences; the member is told', async () => {
  const owner = await agent('host');
  const guest = await agent('guest');
  const room = (await call(owner.id, 'create_room', { mode: 'moderated', name: 'Garden' })).data.room;
  assert.equal((await call(guest.id, 'join_room', { room })).data.sent, true);
  const silent = await call(guest.id, 'send', { room, text: 'hello?' });
  assert.equal(silent.isError, true);
  assert.equal(silent.data.code, 'insufficient_power');
  assert.equal(silent.data.paid_calls, 0);

  await call(owner.id, 'sync');
  const first = (await call(owner.id, 'read', { room })).data;
  assert.equal(first.mode, 'moderated');
  assert.match(first.you_can.join(' '), new RegExp(`1 member has joined and can't post yet \\(newest: ${guest.handle.replace('#', '#')}\\)`));
  assert.equal((await call(owner.id, 'read', { room })).data.you_can, undefined); // once per waiting agent

  // A member cannot approve; the owner can, and then the guest posts.
  assert.match((await call(guest.id, 'moderate', { room, action: 'approve', agent: owner.handle })).data.refused, /Only the owner/);
  const ok = await call(owner.id, 'moderate', { room, action: 'approve', agent: guest.handle });
  assert.equal(ok.data.sent, true);
  assert.equal((await call(owner.id, 'moderate', { room, action: 'approve', agent: guest.handle })).data.code, 'already_poster');
  await call(guest.id, 'sync');
  assert.ok(received.some((r) => r.agent === guest.id && r.what.type === 'poster' && r.what.approved));
  assert.equal((await call(guest.id, 'send', { room, text: 'thanks' })).data.sent, true);

  // Silenced again, the guest cannot post.
  assert.equal((await call(owner.id, 'moderate', { room, action: 'silence', agent: guest.id })).data.sent, true);
  await call(guest.id, 'sync');
  assert.ok(received.some((r) => r.agent === guest.id && r.what.type === 'poster' && !r.what.approved));
  assert.equal((await call(guest.id, 'send', { room, text: 'still here' })).data.code, 'insufficient_power');

  // The log names what each did.
  const ownerLog = new Activity({ db }).list(owner.id).map((e) => e.text);
  assert.ok(ownerLog.includes(`Approved ${guest.handle} to post in “Garden”.`));
  assert.ok(ownerLog.includes(`Silenced ${guest.handle} in “Garden”.`));
  assert.ok(ownerLog.includes('Created a Moderated room “Garden”.'));

  // Approving is for Moderated rooms only.
  const open = (await call(owner.id, 'create_room', { mode: 'open' })).data.room;
  assert.equal((await call(owner.id, 'moderate', { room: open, action: 'approve', agent: guest.id })).data.code, 'not_moderated');
});

test('Announcements: followers read, only the owner and moderators post; the owner changes the mode', async () => {
  const owner = await agent('herald');
  const reader = await agent('reader');
  const room = (await call(owner.id, 'create_room', { mode: 'announcements', name: 'News' })).data.room;
  await call(reader.id, 'join_room', { room });
  assert.equal((await call(reader.id, 'send', { room, text: 'me too' })).data.code, 'insufficient_power');
  assert.equal((await call(owner.id, 'send', { room, text: 'Release 1' })).data.sent, true);
  await call(reader.id, 'sync');
  assert.equal((await call(reader.id, 'read', { room })).data.messages.at(-1).text, 'Release 1');

  // Only the owner changes the mode, and it is told back what the room now is.
  assert.equal((await call(reader.id, 'update_room', { room, mode: 'open' })).data.code, 'insufficient_power');
  const changed = await call(owner.id, 'update_room', { room, mode: 'open' });
  assert.equal(changed.data.sent, true);
  assert.match(changed.data.room_mode, /^Open: /);
  assert.equal((await call(owner.id, 'update_room', { room, mode: 'open' })).data.code, 'same_mode');
  await call(reader.id, 'sync');
  assert.ok(received.some((r) => r.agent === reader.id && r.what.type === 'mode' && r.what.mode === 'open'));
  assert.equal((await call(reader.id, 'send', { room, text: 'now I can' })).data.sent, true);
  assert.ok(new Activity({ db }).list(owner.id).some((e) => e.text === 'Made “News” Open.'));

  // Public and Private never change into each other.
  const secret = (await call(owner.id, 'create_room', { mode: 'private' })).data.room;
  assert.equal((await call(owner.id, 'update_room', { room: secret, mode: 'open' })).data.code, 'fixed_type');
  assert.equal((await call(owner.id, 'update_room', { room, mode: 'private' })).isError, true); // not offered
});

test('moderate: delete, remove (said to be reversible in public), ban and unban; Porch refuses it', async () => {
  const owner = await agent('warden');
  const pest = await agent('pest');
  const room = (await call(owner.id, 'create_room', { mode: 'open', name: 'Commons' })).data.room;
  await call(pest.id, 'join_room', { room });
  const msg = (await call(pest.id, 'send', { room, text: 'spam spam' })).data.message;
  await call(owner.id, 'sync');

  // A member cannot delete another's message; the owner can, and both copies drop it.
  const other = (await call(owner.id, 'send', { room, text: 'mine' })).data.message;
  await call(pest.id, 'sync');
  assert.equal((await call(pest.id, 'moderate', { room, action: 'delete', message: other })).data.code, 'insufficient_power');
  assert.equal((await call(owner.id, 'moderate', { room, action: 'delete', message: msg })).data.sent, true);
  assert.equal(core.messages(owner.id, { room }).find((m) => m.id === msg)!.status, 'deleted');
  await call(pest.id, 'sync');
  assert.equal(core.messages(pest.id, { room }).find((m) => m.id === msg)!.status, 'deleted');

  const removed = await call(owner.id, 'moderate', { room, action: 'remove', agent: pest.handle });
  assert.equal(removed.data.sent, true);
  assert.match(removed.data.notice, /can come back at once/);
  await call(pest.id, 'sync');
  assert.equal((await call(pest.id, 'join_room', { room })).data.sent, true); // back again

  assert.equal((await call(owner.id, 'moderate', { room, action: 'ban', agent: pest.id })).data.sent, true);
  await call(pest.id, 'sync');
  assert.equal((await call(pest.id, 'join_room', { room })).data.code, 'banned');
  assert.equal((await call(owner.id, 'moderate', { room, action: 'unban', agent: pest.id })).data.sent, true);
  assert.equal((await call(owner.id, 'moderate', { room, action: 'unban', agent: pest.id })).data.code, 'not_banned');
  assert.ok(new Activity({ db }).list(owner.id).some((e) => e.kind === 'moderation' && e.text === `Banned ${pest.handle} from “Commons”.`));

  // Wrong shapes are refused before anything is paid.
  assert.equal((await call(owner.id, 'moderate', { room, action: 'delete' })).isError, true);
  assert.equal((await call(owner.id, 'moderate', { room, action: 'ban' })).isError, true);
  assert.equal((await call(owner.id, 'moderate', { room, action: 'approve', agent: pest.id, note: 'x' })).isError, true);

  core.setMay(owner.id, 'porch');
  assert.match((await call(owner.id, 'moderate', { room, action: 'ban', agent: pest.id })).data.refused, /Porch/);
  core.setMay(owner.id, 'all');
});

test('hints: a flood in an Open room the agent owns, and a flagged message, each told once', async () => {
  const owner = await agent('keeper');
  const loud = await agent('loud');
  const room = (await call(owner.id, 'create_room', { mode: 'open', name: 'Square' })).data.room;
  await call(loud.id, 'join_room', { room });
  for (let i = 0; i <= HINTS.fastPosts; i++) await call(loud.id, 'send', { room, text: `post ${i}` });
  await call(owner.id, 'sync');
  const inbox = (await call(owner.id, 'inbox')).data;
  const entry = inbox.rooms.find((r: any) => r.room === room);
  assert.match(entry.you_can.join(' '), new RegExp(`${loud.handle} posted ${HINTS.fastPosts + 1} messages here in 10 minutes`));
  assert.equal((await call(owner.id, 'read', { room })).data.you_can, undefined);

  // The member, with no power, is never told.
  assert.equal((await call(loud.id, 'read', { room })).data.you_can, undefined);

  // A message MessageGuard flagged: the owner can delete it or act on its author.
  const flagged = core.messages(owner.id, { room }).at(-1)!;
  db.prepare("UPDATE messages SET guard = 'suspicious', delivered = 0 WHERE agent = ? AND id = ?").run(owner.id, flagged.id);
  const again = (await call(owner.id, 'inbox')).data.rooms.find((r: any) => r.room === room);
  assert.match(again.you_can.join(' '), new RegExp(`MessageGuard flagged ${flagged.id}`));
});

test('hiding: kept on this computer, out of the window and the agent, and the AI is told how many', async () => {
  const owner = await agent('quiet');
  const noisy = await agent('noisy');
  const room = (await call(owner.id, 'create_room', { mode: 'open' })).data.room;
  await call(noisy.id, 'join_room', { room });
  const one = (await call(noisy.id, 'send', { room, text: 'one' })).data.message;
  await call(owner.id, 'sync');
  const paid = () => wallets.paymentsBetween(walletId, 0, Date.now() + 1).length;
  const calls = paid();

  assert.equal(core.hideMessage(owner.id, one, true), true);
  assert.equal(paid(), calls); // nothing sent or paid
  assert.equal((await call(owner.id, 'inbox')).data.rooms.length, 0);
  const read = (await call(owner.id, 'read', { room })).data;
  assert.equal(read.messages.some((m: any) => m.id === one), false);
  assert.match(read.hidden_by_your_person, /^1 message here is hidden/);
  assert.equal(core.messages(owner.id, { room, visible: true }).some((m) => m.id === one), false);

  // Hiding an author hides their later messages too, until unhidden.
  core.hideAuthor(owner.id, room, noisy.id, true);
  await call(noisy.id, 'send', { room, text: 'two' });
  await call(owner.id, 'sync');
  assert.equal((await call(owner.id, 'inbox')).data.rooms.length, 0);
  assert.deepEqual(core.hiddenIn(owner.id, room), { messages: 2, authors: [noisy.id] });
  core.unhideAll(owner.id, room);
  assert.equal(core.messages(owner.id, { room, visible: true }).length, 2);
});

test('modeOf reads the table in effect: a table no preset matches is Custom', () => {
  const create = (data: any) => ({ header: { kind: 'room.create', author: 'a_x', data } }) as any;
  const state = (c: any, power?: any) => new Map<string, any>([['room.create|', c], ...(power ? [['room.power|', { header: { data: power } }]] as any : [])]);
  assert.equal(modeOf(state(create({ type: 'public' }))), 'open');
  assert.equal(modeOf(state(create({ type: 'public', levels: { post: 10 } }))), 'moderated');
  assert.equal(modeOf(state(create({ type: 'public', levels: { post: 50 } }))), 'announcements');
  assert.equal(modeOf(state(create({ type: 'public', levels: { post: 5 } }))), 'custom');
  assert.equal(modeOf(state(create({ type: 'public', levels: { invite: 50 } }))), 'custom');
  assert.equal(modeOf(state(create({ type: 'private' }))), 'private');
  assert.equal(modeOf(state(create({ type: 'dm' }))), 'dm');
});
