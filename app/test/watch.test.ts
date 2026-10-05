// Watching the nodes (SPEC §16.23): delivery confirmation and attestation
// comparison across two in-process nodes, and held-back writes in plain words.
// A test transport sends each call to node A, node B, or both; a write sent to
// A only is an event B never received, as from a node that withholds it.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../backend/src/server.js';
import { Store } from '../../backend/src/store/store.js';
import { checkAttestation } from '../../backend/src/proto/attest.js';
import { openDb } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { Core } from '../src/core/core.ts';
import type { Transport } from '../src/core/transport.ts';
import { ATTESTATION_BROKEN, WATCH, heldWords } from '../src/core/watch.ts';
import { ToolHost } from '../src/core/tools.ts';

const servers: any[] = [];
after(() => { for (const s of servers) s.close(); });

async function node(config: Record<string, unknown> = {}) {
  const store = new Store();
  const server = createServer(store, { network: 'main', version: 'test', sourceUrl: '', supportUrl: '', operator: null, ...config });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { store, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

type Mode = 'A' | 'B' | 'both';
/** Calls node A, node B, or both (answering with A's). `edit` may change an answer. */
function twoNodes(a: { url: string }, b: { url: string }) {
  const t: Transport & { mode: Mode; edit?: (data: any) => any } = {
    mode: 'both',
    async call(path, body) {
      const post = async (url: string) => {
        const res = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, data: await res.json() };
      };
      let out;
      if (t.mode === 'both') {
        out = await post(a.url);
        await post(b.url);
      } else out = await post(t.mode === 'A' ? a.url : b.url);
      return t.edit ? { ...out, data: t.edit(out.data) } : out;
    },
  };
  return t;
}

/** An agent with its own clock, so its events can be "held" well before a node's attestation. */
function agent(name: string, transport: Transport) {
  const clock = { t: Date.now() };
  const db = openDb();
  const core = new Core({ db, vault: new Vault(randomBytes(32)), transport, now: () => clock.t });
  const { id } = core.createAgent(name);
  return { core, id, clock, transport };
}

const nodeProblems = (a: { core: Core; id: string }) => a.core.problems(a.id).filter((p) => p.kind === 'nodes').map((p) => p.text);
const tick = () => new Promise((r) => setTimeout(r, 5));

async function room(alice: ReturnType<typeof agent>, bob: ReturnType<typeof agent>) {
  await alice.core.register(alice.id);
  await bob.core.register(bob.id);
  const { result: roomId } = await alice.core.createRoom(alice.id, { type: 'public', name: 'Watch' });
  await bob.core.joinRoom(bob.id, roomId);
  await alice.core.sync(alice.id);
  return roomId;
}

test('a node that keeps leaving out events another node served is noted once, with signed evidence', async () => {
  const A = await node(), B = await node();
  const ta = twoNodes(A, B), tb = twoNodes(A, B);
  const alice = agent('Alice', ta), bob = agent('Bob', tb);
  const roomId = await room(alice, bob);

  // Three posts reach node A only. Bob reads them from A, on a clock 20 minutes behind the nodes'.
  ta.mode = 'A';
  for (const text of ['one', 'two', 'three']) await alice.core.send(alice.id, roomId, text);
  tb.mode = 'A';
  bob.clock.t = Date.now() - 20 * 60_000;
  await bob.core.sync(bob.id);
  assert.deepEqual(bob.core.messages(bob.id, { room: roomId }).filter((m) => m.author === alice.id).map((m) => m.text), ['one', 'two', 'three']);
  assert.deepEqual(nodeProblems(bob), [], 'node A serves them: nothing to note');

  // Node B never had them. Its signed heads leave them out, twice.
  bob.clock.t = Date.now();
  tb.mode = 'B';
  await bob.core.sync(bob.id);
  await tick();
  await bob.core.sync(bob.id);
  await tick();
  await bob.core.sync(bob.id); // the pattern again, the same day
  const notes = nodeProblems(bob);
  assert.equal(notes.length, 1, 'once a day, not once per sync');
  assert.match(notes[0], /keeps leaving out messages that other nodes showed more than 10 minutes earlier \(3 messages/);
  assert.match(notes[0], new RegExp(B.store.node.id.slice(0, 10)));
  const evidence = bob.core.watch.evidence(bob.id);
  assert.equal(evidence.length, 3);
  assert.ok(evidence.every((e) => e.node === B.store.node.id && checkAttestation(e.attestation) === null));
  // Node A is never blamed.
  assert.equal(bob.core.watch.evidence(bob.id, A.store.node.id).length, 0);
});

test('one miss is lag, not a pattern; an event held less than 10 minutes is not judged', async () => {
  const A = await node(), B = await node();
  const ta = twoNodes(A, B), tb = twoNodes(A, B);
  const alice = agent('Alice', ta), bob = agent('Bob', tb);
  const roomId = await room(alice, bob);
  ta.mode = 'A';
  await alice.core.send(alice.id, roomId, 'only on A');
  tb.mode = 'A';
  await bob.core.sync(bob.id); // held now: too recent to judge
  tb.mode = 'B';
  await bob.core.sync(bob.id);
  assert.equal(bob.core.watch.evidence(bob.id).length, 0, 'held less than 10 minutes before the attestation');
  // Another event, held long before node B's next answer, misses once: evidence, but no notice.
  bob.clock.t = Date.now() - 20 * 60_000;
  ta.mode = 'A';
  await alice.core.send(alice.id, roomId, 'also only on A');
  tb.mode = 'A';
  await bob.core.sync(bob.id);
  bob.clock.t = Date.now();
  tb.mode = 'B';
  await bob.core.sync(bob.id);
  assert.equal(bob.core.watch.evidence(bob.id).length, 1);
  assert.deepEqual(nodeProblems(bob), []);
});

test('delivery: confirmed when another node shows it; never noted on time alone, however long one node answers', async () => {
  const A = await node(), B = await node();
  const ta = twoNodes(A, B), tb = twoNodes(A, B);
  const alice = agent('Alice', ta), bob = agent('Bob', tb);
  const roomId = await room(alice, bob);

  // Sent to both; node A accepts it, and node B's next answer covers it.
  await alice.core.send(alice.id, roomId, 'everywhere');
  ta.mode = 'B';
  alice.clock.t = Date.now() + 60 * 60_000;
  await alice.core.sync(alice.id);
  assert.deepEqual(nodeProblems(alice), []);

  // Accepted by node A, and then the gateway sends every call to A for hours (a session): nothing to
  // judge, so nothing is noted (a tester's Dashboard filled with these, 2026-10-05).
  alice.clock.t = Date.now();
  ta.mode = 'A';
  await alice.core.send(alice.id, roomId, 'A answers everything for a while');
  for (const h of [1, 2, 3]) {
    alice.clock.t = Date.now() + h * 3600_000;
    await alice.core.sync(alice.id);
  }
  assert.ok(alice.core.watch.several(), 'two nodes have answered today');
  assert.deepEqual(nodeProblems(alice), []);
  assert.equal(alice.core.watch.evidence(alice.id).length, 0);
});

test('own messages another node keeps leaving out are noted as a pattern, with signed evidence', async () => {
  const A = await node(), B = await node();
  const ta = twoNodes(A, B), tb = twoNodes(A, B);
  const alice = agent('Alice', ta), bob = agent('Bob', tb);
  const roomId = await room(alice, bob);

  // Three posts accepted by node A only, 20 minutes before node B's answers.
  ta.mode = 'A';
  alice.clock.t = Date.now() - 20 * 60_000;
  for (const text of ['one', 'two', 'three']) await alice.core.send(alice.id, roomId, text);
  alice.clock.t = Date.now();
  ta.mode = 'B';
  await alice.core.sync(alice.id);
  await tick();
  await alice.core.sync(alice.id);
  const notes = nodeProblems(alice);
  assert.equal(notes.length, 1);
  assert.match(notes[0], new RegExp(`Node ${B.store.node.id.slice(0, 10)}.*keeps leaving out messages`));
  const evidence = alice.core.watch.evidence(alice.id);
  assert.equal(evidence.length, 3);
  assert.ok(evidence.every((e) => e.node === B.store.node.id && checkAttestation(e.attestation) === null));
  assert.equal(alice.core.watch.evidence(alice.id, A.store.node.id).length, 0, 'the node that accepted them is not blamed');
});

test('delivery: a different node serving the event confirms it too', () => {
  const core = new Core({ db: openDb(), vault: new Vault(randomBytes(32)), transport: { call: async () => ({ status: 500, data: {} }) }, now: () => clock });
  let clock = Date.now();
  const a = 'a_' + 'A'.repeat(43), r = 'r_' + 'R'.repeat(43), e = 'e_' + 'E'.repeat(43);
  const [n1, n2] = ['n_' + '1'.repeat(43), 'n_' + '2'.repeat(43)];
  core.watch.heard(n1);
  core.watch.heard(n2);
  core.watch.accepted(a, n1, [{ id: e, room: r }]);
  // The accepting node serving it again proves nothing; another node serving it does.
  core.watch.observe(a, n1, new Map([[r, new Set([e])]]), undefined, () => null);
  core.watch.observe(a, n2, new Map([[r, new Set([e])]]), undefined, () => null);
  clock += 3600_000;
  core.watch.notices(a);
  assert.deepEqual(core.problems(a), []);
});

test('with one node, nothing is ever noted', async () => {
  const A = await node();
  const t = twoNodes(A, A);
  t.mode = 'A';
  const alice = agent('Alice', t), bob = agent('Bob', t);
  const roomId = await room(alice, bob);
  await alice.core.send(alice.id, roomId, 'hello');
  alice.clock.t = bob.clock.t = Date.now() + 2 * 3600_000;
  await alice.core.sync(alice.id);
  await bob.core.sync(bob.id);
  assert.deepEqual([...nodeProblems(alice), ...nodeProblems(bob)], []);
  assert.equal(bob.core.watch.several(), false);
});

test('an attestation that does not check is ignored and noted', async () => {
  const A = await node();
  const t = twoNodes(A, A);
  t.mode = 'A';
  const alice = agent('Alice', t);
  await alice.core.register(alice.id);
  t.edit = (data) => (data?.attestation ? { ...data, attestation: { ...data.attestation, ts: data.attestation.ts + 1 } } : data);
  await alice.core.sync(alice.id);
  assert.deepEqual(nodeProblems(alice), [ATTESTATION_BROKEN]);
});

test('a write a node held back says so in plain words, never sent: true', async () => {
  const A = await node({ writeLimits: { roomPerMin: 4 } });
  const t = twoNodes(A, A);
  t.mode = 'A';
  const alice = agent('Alice', t);
  await alice.core.register(alice.id);
  // A named room: its join and its name are two writes of the four a minute.
  const { result: roomId } = await alice.core.createRoom(alice.id, { type: 'public', name: 'Fast' });
  const first = await alice.core.send(alice.id, roomId, 'one');
  const second = await alice.core.send(alice.id, roomId, 'two');
  const third = await alice.core.send(alice.id, roomId, 'three');
  assert.equal(first.sent, true);
  assert.equal(second.sent, true);
  assert.equal(third.sent, false);
  assert.equal(third.held, 'rate_limit');
  assert.match(heldWords(third.held), /about 20 messages a minute in a room.*do not send it again/);
  assert.equal(alice.core.outbox(alice.id).length, 1, 'kept to send again');
  // What the AI is told (§16.23).
  const told: any = ToolHost.prototype.written.call(null, third, 'message');
  assert.equal(told.sent, false);
  assert.equal(told.why, 'rate_limit');
  assert.match(told.queued, /^The message is saved here: Meadow limits how fast one agent writes/);
});
