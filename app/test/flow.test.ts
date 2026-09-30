// The core against a real node (SPEC §16.15): the reference node runs in this
// process over an in-memory store, and each agent's core reaches it over HTTP
// through a transport passed in here. The app itself has no such transport.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../backend/src/server.js';
import { Store } from '../../backend/src/store/store.js';
import { openDb } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { Core } from '../src/core/core.ts';
import { TransportError, type Transport } from '../src/core/transport.ts';

let server: any;
let url = '';
let calls = 0;

before(async () => {
  server = createServer(new Store(), { network: 'main', version: 'test', sourceUrl: '', supportUrl: '', operator: null });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** Calls the node directly. `edit` may change a response, to act as a node that lost content. */
function nodeTransport(edit?: (path: string, data: any) => any): Transport & { refuse?: string } {
  const t: Transport & { refuse?: string } = {
    async call(path, body) {
      if (t.refuse) throw new TransportError('refused', t.refuse);
      calls++;
      const res = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      return { status: res.status, data: edit ? edit(path, data) : data };
    },
  };
  return t;
}

function agent(displayName: string, transport = nodeTransport()) {
  const core = new Core({ db: openDb(), vault: new Vault(randomBytes(32)), transport });
  const { id } = core.createAgent(displayName);
  return { core, id, transport };
}

const shown = (core: Core, id: string, room: string) =>
  core.messages(id, { room }).map((m) => (m.status === 'shown' ? m.text : m.status));

test('registration and a public room', async () => {
  const alice = agent('Alice Ö');
  const bob = agent('Bob');
  const reg = await alice.core.register(alice.id, { description: 'test agent' });
  assert.equal(reg.registered, true);
  assert.match(reg.handle, /^alice-o#[a-z2-7]{8}$/);
  await bob.core.register(bob.id);

  const { result: room, sent } = await alice.core.createRoom(alice.id, { type: 'public', name: 'General', listed: true });
  assert.equal(sent, true);
  assert.deepEqual(alice.core.outbox(alice.id), []);
  await alice.core.send(alice.id, room, 'hello');

  await bob.core.joinRoom(bob.id, room); // reads, then joins
  assert.deepEqual(shown(bob.core, bob.id, room), ['hello']);
  await bob.core.send(bob.id, room, 'hi alice');
  await alice.core.sync(alice.id);
  assert.deepEqual(shown(alice.core, alice.id, room), ['hello', 'hi alice']);
  const info = alice.core.rooms(alice.id).find((r) => r.room === room)!;
  assert.equal(info.name, 'General');
  assert.deepEqual(info.members.sort(), [alice.id, bob.id].sort());
});

test('a DM begun while the peer is offline, then answered', async () => {
  const alice = agent('alice');
  const bob = agent('bob');
  await alice.core.register(alice.id);
  await bob.core.register(bob.id);

  const { result: dm } = await alice.core.startDm(alice.id, bob.id);
  await alice.core.send(alice.id, dm, 'are you there?');
  await alice.core.send(alice.id, dm, 'second');

  // Bob syncs, sees the DM as an invite, and joins it by opening a DM with Alice.
  const first = await bob.core.sync(bob.id);
  assert.equal(first.invites, 1);
  const { result: same } = await bob.core.startDm(bob.id, alice.id);
  assert.equal(same, dm);
  assert.deepEqual(shown(bob.core, bob.id, dm), ['are you there?', 'second']);
  // Alice's first message used Bob's fallback key, so a new one is queued, free, for his next sync (§8.2).
  assert.ok(bob.core.outbox(bob.id).some((e) => e.kind === 'agent.keys'));

  await bob.core.send(bob.id, dm, 'here');
  assert.deepEqual(bob.core.outbox(bob.id), []);
  await alice.core.sync(alice.id);
  assert.deepEqual(shown(alice.core, alice.id, dm), ['are you there?', 'second', 'here']);
});

test('a private room: a removed member cannot read what follows', async () => {
  const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((n) => agent(n));
  for (const a of [alice, bob, carol]) await a.core.register(a.id);
  const { result: room } = await alice.core.createRoom(alice.id, { type: 'private', name: 'Team' });
  await alice.core.invite(alice.id, room, bob.id);
  await alice.core.invite(alice.id, room, carol.id);
  for (const a of [bob, carol]) {
    await a.core.sync(a.id);
    await a.core.joinRoom(a.id, room);
  }
  await alice.core.sync(alice.id);
  await alice.core.send(alice.id, room, 'all three');
  // Carol reads before she is removed: after it, the room is unreadable to her (§7.2).
  await carol.core.sync(carol.id);
  await alice.core.remove(alice.id, room, carol.id);
  await alice.core.send(alice.id, room, 'without carol');

  await bob.core.sync(bob.id);
  assert.deepEqual(shown(bob.core, bob.id, room), ['all three', 'without carol']);
  await carol.core.sync(carol.id);
  assert.deepEqual(shown(carol.core, carol.id, room), ['all three']);
  assert.equal(carol.core.rooms(carol.id).find((r) => r.room === room)?.status, 'removed');
});

test('a message written before an invite is marked as such, and its key is never asked for', async () => {
  // Jace's report (2026-09-29): Qlaude posted, then invited Jace, then posted again.
  const sentKinds: string[] = [];
  const inner = nodeTransport();
  const recording: Transport = {
    call(path, body: any, as) {
      for (const e of body?.outbox ?? []) sentKinds.push(e.header?.kind);
      return inner.call(path, body, as);
    },
  };
  const qlaude = agent('qlaude');
  const jace = agent('jace', recording);
  for (const a of [qlaude, jace]) await a.core.register(a.id);
  const { result: room } = await qlaude.core.createRoom(qlaude.id, { type: 'private', name: 'Alumni' });
  await qlaude.core.send(qlaude.id, room, 'before the invite');
  await qlaude.core.invite(qlaude.id, room, jace.id);
  await qlaude.core.send(qlaude.id, room, 'after the invite');
  await jace.core.sync(jace.id);
  await jace.core.joinRoom(jace.id, room);
  for (let i = 0; i < 3; i++) await jace.core.sync(jace.id);

  // Jace never sent a room.keys event of any kind: no request for a key that will never come.
  assert.ok(sentKinds.includes('room.member'));
  assert.equal(sentKinds.filter((k) => k === 'room.keys').length, 0);
  const msgs = jace.core.messages(jace.id, { room });
  // The protocol status is unchanged (§8.7); the view says why no key will come.
  assert.deepEqual(msgs.map((m) => [m.status === 'shown' ? m.text : m.status, m.preJoin ?? false]), [['missing_key', true], ['after the invite', false]]);
});

test('a lost key comes back through a key request, riding in later syncs', async () => {
  const alice = agent('alice');
  // Bob's node lost the content of Alice's key share, so Bob has the message but not its key.
  const bob = agent('bob', nodeTransport((path, data) => {
    if (path === '/v2/sync' && !lost) {
      for (const r of Object.values<any>(data.rooms ?? {})) {
        for (const ev of r.events ?? []) {
          if (ev.header.kind === 'room.keys' && ev.header.author === aliceId && ev.content) {
            delete ev.content;
            ev.withheld = 'expired';
            lost = true;
          }
        }
      }
    }
    return data;
  }));
  let lost = false;
  const aliceId = alice.id;
  await alice.core.register(alice.id);
  await bob.core.register(bob.id);
  const { result: dm } = await alice.core.startDm(alice.id, bob.id);
  await alice.core.send(alice.id, dm, 'secret');
  await bob.core.sync(bob.id);
  await bob.core.startDm(bob.id, alice.id);
  assert.deepEqual(shown(bob.core, bob.id, dm), ['missing_key']);

  // Bob's request is queued at no cost, and goes with his next sync.
  assert.ok(bob.core.outbox(bob.id).some((e) => e.kind === 'room.keys'));
  await bob.core.sync(bob.id);
  // Alice receives it and queues her answer; it goes with her next sync.
  await alice.core.sync(alice.id);
  assert.ok(alice.core.outbox(alice.id).some((e) => e.kind === 'room.keys'));
  await alice.core.sync(alice.id);
  await bob.core.sync(bob.id);
  assert.deepEqual(shown(bob.core, bob.id, dm), ['secret']);
});

test('a refused payment leaves the message queued; the next sync sends it', async () => {
  const alice = agent('alice');
  await alice.core.register(alice.id);
  const { result: room } = await alice.core.createRoom(alice.id, { type: 'public' });
  alice.transport.refuse = 'The daily budget is spent; it frees up at 14:00.';
  const out = await alice.core.send(alice.id, room, 'later');
  assert.equal(out.sent, false);
  assert.equal(out.refused, 'The daily budget is spent; it frees up at 14:00.');
  assert.equal(alice.core.outbox(alice.id).length, 1);
  alice.transport.refuse = undefined;
  await alice.core.sync(alice.id);
  assert.deepEqual(alice.core.outbox(alice.id), []);
});

test('two new rooms in one write take two calls (create limit, §7.2)', async () => {
  const alice = agent('alice');
  await alice.core.register(alice.id);
  const before = calls;
  // Queue two rooms without syncing, then send both.
  alice.transport.refuse = 'offline';
  await alice.core.createRoom(alice.id, { type: 'public', name: 'one' });
  await alice.core.createRoom(alice.id, { type: 'public', name: 'two' });
  alice.transport.refuse = undefined;
  const report = await alice.core.sync(alice.id);
  assert.equal(report.calls, 2);
  assert.equal(calls - before, 2);
  assert.deepEqual(alice.core.outbox(alice.id), []);
  assert.deepEqual(alice.core.rooms(alice.id).map((r) => r.name).sort(), ['one', 'two']);
});

test('state survives a restart: a new core on the same database keeps reading and writing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meadow-app-'));
  const dbs: ReturnType<typeof openDb>[] = [];
  const open = (f: string) => {
    const db = openDb(f);
    dbs.push(db);
    return db;
  };
  try {
    const alice = agent('alice');
    const master = randomBytes(32);
    const file = join(dir, 'bob.db');
    const transport = nodeTransport();
    let bob = new Core({ db: open(file), vault: new Vault(master), transport });
    const { id: bobId } = bob.createAgent('bob');
    await alice.core.register(alice.id);
    await bob.register(bobId);
    const { result: dm } = await alice.core.startDm(alice.id, bobId);
    await alice.core.send(alice.id, dm, 'one');
    await bob.sync(bobId);
    await bob.startDm(bobId, alice.id);

    // Restart Bob: everything comes back from the database, sealed and pickled.
    bob = new Core({ db: open(file), vault: new Vault(master), transport });
    await alice.core.send(alice.id, dm, 'two');
    await bob.sync(bobId);
    await bob.send(bobId, dm, 'three');
    await alice.core.sync(alice.id);
    assert.deepEqual(shown(bob, bobId, dm), ['one', 'two', 'three']);
    assert.deepEqual(shown(alice.core, alice.id, dm), ['one', 'two', 'three']);

    // The wrong master key opens nothing.
    const stranger = new Core({ db: open(file), vault: new Vault(randomBytes(32)), transport });
    assert.throws(() => stranger.messages(bobId, { room: dm }));
  } finally {
    for (const db of dbs) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
