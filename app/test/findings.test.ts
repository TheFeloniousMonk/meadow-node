// Aevum's findings (a tester's report, 2026-10-02, SPEC §16.8, §16.9.4, §16.7.4):
// a write that cannot start in time is refused and never goes out late; a write
// the network did not take stays queued and says so; reply_to must name a message
// in the same room; every payment records its cause, and results explain the
// wallet's other spending; a known private room is refused free; private rooms'
// plaintext is named; the last member leaving is told what happens.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../backend/src/server.js';
import { Store } from '../../backend/src/store/store.js';
import { openDb } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { Core } from '../src/core/core.ts';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { TransportError, type Transport } from '../src/core/transport.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

let server: any;
let url = '';
let portal: MockPortal;
before(async () => {
  server = createServer(new Store(), { network: 'main', version: 'test', sourceUrl: '', supportUrl: '', operator: null });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  portal = await startMockPortal();
});
after(async () => {
  server.close();
  await portal.close();
});

/** The node, called directly; `gate` holds every call until opened, `down` fails them as the network would. */
function transport() {
  const t = {
    gate: null as Promise<void> | null,
    down: false,
    async call(path: string, body: unknown) {
      if (t.gate) await t.gate;
      if (t.down) throw new TransportError('network', 'The app could not reach the portal. Check the internet connection.');
      const res = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    },
  };
  return t as Transport & typeof t;
}

async function agent(name: string, writeWaitMs = 200) {
  const t = transport();
  const core = new Core({ db: openDb(), vault: new Vault(randomBytes(32)), transport: t, writeWaitMs });
  const { id } = core.createAgent(name);
  await core.register(id);
  return { core, id, t };
}

const own = (core: Core, id: string, room: string) => core.messages(id, { room }).filter((m) => m.author === id).map((m) => (m.status === 'shown' ? m.text : m.status));

test('a write that cannot start in time is refused at once, and never goes out later', async () => {
  const a = await agent('aevum');
  const { result: room } = await a.core.createRoom(a.id, { type: 'public', name: 'Bench' });
  let open!: () => void;
  a.t.gate = new Promise<void>((r) => (open = r));
  const stalled = a.core.sync(a.id); // a background sync on a dead connection, holding the agent's lock
  const t0 = Date.now();
  await assert.rejects(a.core.send(a.id, room, 'would be late'), (e: any) => e.code === 'busy' && /nothing was sent/i.test(e.message) && /nothing goes out late/.test(e.message));
  assert.ok(Date.now() - t0 < 2000, 'refused at once, not after the stalled call');
  a.t.gate = null;
  open();
  await stalled;
  await a.core.sync(a.id);
  assert.deepEqual(own(a.core, a.id, room), [], 'the refused message was never written');
  assert.equal(a.core.outbox(a.id).filter((e) => e.kind === 'msg.post').length, 0);
  // Once the earlier call is done, writing works again.
  const ok = await a.core.send(a.id, room, 'on time');
  assert.equal(ok.sent, true);
  assert.deepEqual(own(a.core, a.id, room), ['on time']);
});

test('a write the network did not take stays queued, says so, and goes with the next sync', async () => {
  const a = await agent('aevum');
  const { result: room } = await a.core.createRoom(a.id, { type: 'public', name: 'Bench' });
  a.t.down = true;
  const out = await a.core.send(a.id, room, 'queued');
  assert.equal(out.sent, false);
  assert.match(out.offline!, /could not reach the portal/);
  assert.equal(a.core.outbox(a.id).filter((e) => e.kind === 'msg.post').length, 1);
  a.t.down = false;
  await a.core.sync(a.id);
  assert.equal(a.core.outbox(a.id).filter((e) => e.kind === 'msg.post').length, 0, 'sent with the next sync');
});

test('reply_to must name a message this agent holds in the same room; refused free otherwise', async () => {
  const a = await agent('aevum');
  const { result: one } = await a.core.createRoom(a.id, { type: 'public', name: 'One' });
  const { result: two } = await a.core.createRoom(a.id, { type: 'public', name: 'Two' });
  const first = await a.core.send(a.id, one, 'first');
  await assert.rejects(a.core.send(a.id, two, 'reply across rooms', { replyTo: first.result }), (e: any) => e.code === 'unknown_reply' && /another room/.test(e.message));
  await assert.rejects(a.core.send(a.id, one, 'reply to nothing', { replyTo: `e_${'A'.repeat(43)}` }), (e: any) => e.code === 'unknown_reply' && /not one it holds/.test(e.message));
  const ok = await a.core.send(a.id, one, 'a real reply', { replyTo: first.result });
  assert.equal(ok.sent, true);
  assert.deepEqual(own(a.core, a.id, two), []);
});

async function computer() {
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog });
  const wallet = s.wallets.create('Everyday', '5.00').id;
  const agent = async (name: string) => {
    const { id } = s.core.createAgent(name);
    s.wallets.assign(id, wallet);
    s.connections.set(id, 'claude', name);
    await s.core.register(id);
    return id;
  };
  return { s, agent, wallet };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('every payment records its cause, and results explain the rest of the wallet\'s spending', async () => {
  const { s, agent, wallet } = await computer();
  const aevum = await agent('aevum');
  const lucero = await agent('lucero');
  const first: any = await s.tools.call(aevum, 'sync', {}, { via: 'claude' });
  assert.equal(first.data.paid_calls, 1);
  assert.equal(first.data.other_spending_since_your_last_call, undefined);
  await tick();
  await s.syncAll(); // background receiving: one sync per agent on the wallet
  await tick();
  await s.tools.call(lucero, 'sync', {}, { via: 'claude' });
  await tick();
  const next: any = await s.tools.call(aevum, 'sync', {}, { via: 'claude' });
  assert.equal(next.data.cost, '$0.005', 'its own call only');
  assert.equal(next.data.paid_calls, 1);
  const other = next.data.other_spending_since_your_last_call;
  assert.equal(other.total, '$0.015');
  assert.deepEqual(other.by.sort(), [
    '$0.005 for another agent on this computer, ' + s.core.agents().find((a) => a.id === lucero)!.handle + ', 1 call',
    '$0.01 for background receiving (the app checks for new messages on a timer), 2 calls',
  ].sort());
  const causes = (s.db.prepare('SELECT agent, cause FROM payments ORDER BY seq').all() as any[]).filter((p) => p.cause !== 'app').map((p) => `${p.agent === aevum ? 'aevum' : 'lucero'} ${p.cause}`);
  assert.deepEqual(causes, ['aevum claude:sync', 'aevum background', 'lucero background', 'lucero claude:sync', 'aevum claude:sync']);
  const st: any = await s.tools.call(aevum, 'status', {}, { via: 'claude' });
  assert.ok(st.data.wallet.spent_last_24h.by.some((x: string) => /background receiving/.test(x)));
  assert.equal(s.wallets.paymentsBetween(wallet, 0, Date.now()).length >= 5, true);
});

test('a room the app knows to be private, or already joined, is refused free by preview_room', async () => {
  const { s, agent } = await computer();
  const aevum = await agent('aevum');
  const lucero = await agent('lucero');
  const { result: priv } = await s.core.createRoom(lucero, { type: 'private', name: 'Household' });
  await s.core.invite(lucero, priv, aevum);
  await s.core.sync(aevum);
  const r: any = await s.tools.call(aevum, 'preview_room', { room: priv }, { via: 'claude' });
  assert.match(r.data.refused, /Only a public room can be read before joining, and this one is not\. .*Nothing was charged/);
  assert.equal(r.data.paid_calls, 0);
  const { result: pub } = await s.core.createRoom(aevum, { type: 'public', name: 'Mine' });
  const j: any = await s.tools.call(aevum, 'preview_room', { room: pub }, { via: 'claude' });
  assert.match(j.data.refused, /already in this room/);
  assert.equal(j.data.paid_calls, 0);
});

test('a private room\'s plaintext is named when set; the last member leaving is told what happens', async () => {
  const { s, agent } = await computer();
  const aevum = await agent('aevum');
  const made: any = await s.tools.call(aevum, 'create_room', { type: 'private', name: 'aevum-testbench', topic: 'the household' }, { via: 'claude' });
  assert.match(made.data.notice, /name, its topic, and invitation notes are not encrypted/);
  const pub: any = await s.tools.call(aevum, 'create_room', { type: 'public', name: 'Open' }, { via: 'claude' });
  assert.equal(pub.data.notice, undefined);
  const topic: any = await s.tools.call(aevum, 'update_room', { room: made.data.room, topic: 'still private?' }, { via: 'claude' });
  assert.match(topic.data.notice, /not encrypted/);
  const left: any = await s.tools.call(aevum, 'leave_room', { room: made.data.room }, { via: 'claude' });
  assert.match(left.data.notice, /last member.*90 days after its last event/);
});
