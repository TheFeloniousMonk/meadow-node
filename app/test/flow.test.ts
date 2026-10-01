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
  const db = openDb();
  const core = new Core({ db, vault: new Vault(randomBytes(32)), transport });
  const { id } = core.createAgent(displayName);
  return { core, id, transport, db };
}

/** Moves a backfill request a day into the past, as if a day had gone by (§16.8). */
function backdate(a: { db: ReturnType<typeof openDb> }, peer: string) {
  a.db.prepare('UPDATE name_backfill SET asked_at = asked_at - 86400001 WHERE peer = ?').run(peer);
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
  // Inviting someone already in the room says so, before anything is sent (a tester, 2026-10-01).
  const sent = alice.core.outbox(alice.id).length;
  await assert.rejects(alice.core.invite(alice.id, room, bob.id), (e: any) => e.code === 'already_member' && /is already a member of this room/.test(e.message) && /Nothing was sent or charged/.test(e.message));
  assert.equal(alice.core.outbox(alice.id).length, sent, 'nothing queued');
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
  // Removed, she can be invited again; banned, she cannot, and the app says why.
  await alice.core.remove(alice.id, room, carol.id, { ban: true });
  await assert.rejects(alice.core.invite(alice.id, room, carol.id), (e: any) => e.code === 'banned' && /is banned from this room/.test(e.message));
  // Any other refusal by the room's rules is in plain words, with its code.
  await assert.rejects(bob.core.remove(bob.id, room, alice.id), (e: any) => e.code === 'insufficient_power' && /role in that room does not allow that.+Reason: insufficient_power/.test(e.message));
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

// --- Author names in sync (SPEC §7.2, §16.8; node 0.3.1) ------------------------------------

/** A transport that records every request, and may rewrite an answer or refuse a request. */
function watched(opts: { edit?: (path: string, data: any) => any; refuse?: (body: any) => any } = {}) {
  const calls: { path: string; body: any }[] = [];
  const inner = nodeTransport(opts.edit);
  const t: Transport = {
    async call(path, body: any, as) {
      calls.push({ path, body });
      const refusal = opts.refuse?.(body);
      if (refusal) return { status: 400, data: refusal };
      return inner.call(path, body, as);
    },
  };
  return { t, calls };
}

async function strangerPosts() {
  const lucero = agent('lucero');
  await lucero.core.register(lucero.id);
  const { result: room } = await lucero.core.createRoom(lucero.id, { type: 'public', name: 'Porch' });
  await lucero.core.send(lucero.id, room, 'evening, all');
  return { lucero, room, handle: lucero.core.agents()[0].handle };
}

test('a stranger is named from the first answer, then verified and pinned in the next sync, with no lookup', async () => {
  const { lucero, room, handle } = await strangerPosts();
  const w = watched();
  const ari = agent('ari', w.t);
  await ari.core.read(ari.id, room);
  assert.equal(ari.core.handleOf(ari.id, lucero.id), handle, 'named from the answer, before any chain');
  assert.equal(ari.core.protocol3(ari.id), true);
  const n = w.calls.length;
  await ari.core.sync(ari.id);
  const next = w.calls.slice(n);
  assert.deepEqual(next.map((c) => c.path), ['/v2/sync'], 'one call, the sync it makes anyway');
  assert.deepEqual(next[0].body.agents, [lucero.id], 'which asks for the chain');
  assert.equal(w.calls.some((c) => c.path === '/v2/lookup'), false, 'no paid lookup');
  assert.deepEqual((await ari.core.lookup(ari.id, { handle })).warnings, [], 'the handle is pinned to the verified ID');
  // Asked once, not on every sync.
  const m = w.calls.length;
  await ari.core.sync(ari.id);
  assert.equal(w.calls.slice(m).some((c) => c.body.agents), false);
});

test('a node that lies about a name is corrected by the signed chain, and the app says so', async () => {
  const { lucero, room, handle } = await strangerPosts();
  const liar = watched({
    edit: (path, data) => {
      for (const a of Object.values<any>(data?.authors ?? {})) if (a.name === 'lucero') a.name = 'official-support';
      return data;
    },
  });
  const ari = agent('ari', liar.t);
  await ari.core.read(ari.id, room);
  assert.match(ari.core.handleOf(ari.id, lucero.id)!, /^official-support#/, 'the node is believed at first');
  await ari.core.sync(ari.id);
  assert.equal(ari.core.handleOf(ari.id, lucero.id), handle, 'the verified name wins');
  assert.ok(ari.core.problems(ari.id).some((p) => /official-support.*signed history says "lucero"/.test(p.text)));
});

test('an older node without authors: no agents are asked for, and names come only from lookups', async () => {
  const { lucero, room } = await strangerPosts();
  const old = watched({ edit: (path, data) => { if (data) delete data.authors; return data; } });
  const ari = agent('ari', old.t);
  await ari.core.read(ari.id, room);
  await ari.core.sync(ari.id);
  assert.equal(ari.core.handleOf(ari.id, lucero.id), null);
  assert.equal(old.calls.some((c) => c.body.agents), false);
  assert.equal(ari.core.protocol3(ari.id), false);
});

test('backfill: an author stored before names existed is named by a later sync, with no lookup, asked once a day', async () => {
  const { lucero, room, handle } = await strangerPosts();
  // The message arrives from a node that sent no names, as before node 0.3.0.
  let old = true;
  let chains = true;
  const w = watched({ edit: (path, data) => {
    if (data && old) delete data.authors;
    if (data && !chains) delete data.chains;
    return data;
  } });
  const ari = agent('ari', w.t);
  await ari.core.read(ari.id, room);
  assert.equal(ari.core.handleOf(ari.id, lucero.id), null);

  // The node is upgraded; the message is never sent again, so its author is never in `authors`.
  old = false;
  chains = false; // this node does not answer the chain yet
  await ari.core.sync(ari.id); // the first answer with authors: agents may go from now on
  let n = w.calls.length;
  await ari.core.sync(ari.id);
  assert.deepEqual(w.calls.slice(n).map((c) => c.body.agents), [[lucero.id]], 'asked in the sync it makes anyway');
  n = w.calls.length;
  await ari.core.sync(ari.id);
  assert.equal(w.calls.slice(n).some((c) => c.body.agents), false, 'not asked again within a day');
  assert.equal(ari.core.handleOf(ari.id, lucero.id), null);

  // A day later it is asked again, and this time the chain comes and verifies.
  chains = true;
  n = w.calls.length;
  backdate(ari, lucero.id);
  await ari.core.sync(ari.id);
  assert.deepEqual(w.calls.slice(n).map((c) => c.body.agents), [[lucero.id]]);
  assert.equal(ari.core.handleOf(ari.id, lucero.id), handle, 'named from the verified chain');
  assert.equal(w.calls.some((c) => c.path === '/v2/lookup'), false, 'no paid lookup');
  n = w.calls.length;
  backdate(ari, lucero.id);
  await ari.core.sync(ari.id);
  assert.equal(w.calls.slice(n).some((c) => c.body.agents), false, 'a verified author is not asked for again');
});

test('backfill skips an author already named by a pin, and stops asking for a chain too large to send', async () => {
  const { lucero, room } = await strangerPosts();
  let old = true;
  let tooLarge = false;
  const w = watched({ edit: (path, data) => {
    if (data && old) delete data.authors;
    if (data?.chains && tooLarge) for (const k of Object.keys(data.chains)) data.chains[k] = { chain_too_large: true };
    return data;
  } });
  const ari = agent('ari', w.t);
  await ari.core.read(ari.id, room);
  old = false;
  await ari.core.sync(ari.id);

  // Pinned from an earlier conversation: it has a name, so nothing is asked.
  ari.db.prepare('INSERT INTO pins (agent, handle, peer, first_seen) VALUES (?, ?, ?, ?)').run(ari.id, 'lucero#aaaaaaaa', lucero.id, Date.now());
  let n = w.calls.length;
  await ari.core.sync(ari.id);
  assert.equal(w.calls.slice(n).some((c) => c.body.agents), false, 'a pinned author is not asked for');
  ari.db.prepare('DELETE FROM pins WHERE agent = ?').run(ari.id);

  // Too large: asked once, then never again, even after a day.
  tooLarge = true;
  n = w.calls.length;
  await ari.core.sync(ari.id);
  assert.deepEqual(w.calls.slice(n).map((c) => c.body.agents), [[lucero.id]]);
  backdate(ari, lucero.id);
  n = w.calls.length;
  await ari.core.sync(ari.id);
  assert.equal(w.calls.slice(n).some((c) => c.body.agents), false, 'a chain too large is not asked for again');
});

test('a node that refuses agents gets the same sync without it, and none for an hour', async () => {
  const { lucero, room, handle } = await strangerPosts();
  const picky = watched({ refuse: (b) => b.agents && { error: { code: 'bad_request', message: 'unknown fields: agents' } } });
  const ari = agent('ari', picky.t);
  await ari.core.read(ari.id, room);
  const n = picky.calls.length;
  const report = await ari.core.sync(ari.id);
  assert.deepEqual(picky.calls.slice(n).map((c) => !!c.body.agents), [true, false], 'refused, then sent again without it');
  assert.equal(report.calls, 2);
  assert.equal(ari.core.protocol3(ari.id), false, 'no agents, and no format 3, for an hour');
  assert.equal(ari.core.handleOf(ari.id, lucero.id), handle, 'the unverified name still shows');
});
