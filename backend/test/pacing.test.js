// Replication review (SPEC §17 q13 n, o, p, q, r): early discovery, push pacing,
// incremental anti-entropy, chain tails, and content repair backoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Builder } from '../../conformance/tools/builder.js';
import { createPeerServer } from '../src/server.js';
import { Store } from '../src/store/store.js';
import { Peers, signPeer, verifyPeer } from '../src/peer/peers.js';
import { FULL_ROUND_MS, Replicator } from '../src/peer/replicator.js';
import { Discovery, EARLY_MIN_MS } from '../src/peer/discovery.js';

const quiet = { log() {}, warn() {} };
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Two nodes on localhost, peered; B's calls to A are recorded (path and request body).
async function pair(opts = {}) {
  const calls = [];
  const nodes = [];
  for (let i = 0; i < 2; i++) {
    const store = new Store();
    const peers = new Peers([], { log: quiet });
    const fetch = i === 1
      ? async (url, init) => {
        calls.push({ path: new URL(url).pathname.replace(/^.*\/v2/, '/v2'), body: JSON.parse(init.body) });
        const res = await globalThis.fetch(url, init);
        return opts.rewrite ? opts.rewrite(url, res) : res;
      }
      : globalThis.fetch;
    const replicator = new Replicator(store, peers, { flushMs: 0, antiEntropyMs: 0, log: quiet, fetch, ...opts.replicator });
    const server = createPeerServer(store, peers, replicator);
    const port = await listen(server);
    nodes.push({ store, peers, replicator, server, id: store.node.id, url: `http://127.0.0.1:${port}` });
  }
  const [A, B] = nodes;
  A.peers.add({ id: B.id, url: B.url });
  B.peers.add({ id: A.id, url: A.url });
  return { A, B, calls, done: () => Promise.all(nodes.map((n) => close(n.server))) };
}

function rooms(n, prefix = 'r') {
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = new Builder();
    const a = b.agent(`${prefix}${i}`);
    b.create('create', a, { type: 'public' });
    b.join('join', a);
    b.post('hello', a, `hello ${i}`);
    out.push(b);
  }
  return out;
}

// ---- (o) Push pacing ----

test('pushes to a peer that refuses at once back off: 1 s, then 2 s, and recover with one log line', async () => {
  const store = new Store();
  const other = new Store();
  const peers = new Peers([], { log: quiet });
  peers.add({ id: other.node.id, url: 'http://peer/meadow-peer' });
  const log = [];
  let calls = 0;
  let fail = true;
  const fetch = async () => {
    calls++;
    if (fail) throw new Error('ECONNREFUSED');
    return new Response('{"accepted":1,"rejected":0,"discarded":0,"pending":[],"create_limit":[],"reports":0}', { status: 200 });
  };
  const rep = new Replicator(store, peers, { fetch, flushMs: 50, antiEntropyMs: 0, log: { log: (t) => log.push(t), warn: (t) => log.push(t) } }).start();
  for (const s of rooms(1)[0].steps) store.ingest(s.event);
  await wait(2600);
  assert.ok(calls >= 2 && calls <= 3, `${calls} pushes in 2.6 s (was about 10 a second at this flush rate)`);
  assert.equal(log.filter((l) => /failing/.test(l)).length, 1, 'logged once when it starts failing');
  fail = false;
  await wait(4200);
  assert.ok(log.some((l) => /recovered after \d+ failed attempts/.test(l)), log.join('\n'));
  rep.stop();
  store.close();
  other.close();
});

test('one push in flight per peer: a backlog of new rooms arrives in order', async () => {
  const store = new Store();
  const other = new Store();
  const peers = new Peers([], { log: quiet });
  peers.add({ id: other.node.id, url: 'http://peer/meadow-peer' });
  let inflight = 0;
  let max = 0;
  const kinds = [];
  const fetch = async (url, init) => {
    inflight++;
    max = Math.max(max, inflight);
    for (const ev of JSON.parse(init.body).events) kinds.push(ev.header.kind);
    await wait(150);
    inflight--;
    return new Response('{"accepted":0,"rejected":0,"discarded":0,"pending":[],"create_limit":[],"reports":0}', { status: 200 });
  };
  const rep = new Replicator(store, peers, { fetch, flushMs: 20, antiEntropyMs: 0, log: quiet }).start();
  for (const b of rooms(6)) for (const s of b.steps) store.ingest(s.event);
  await wait(2000);
  assert.equal(max, 1, 'never two pushes to one peer at once');
  assert.equal(kinds.filter((k) => k === 'room.create').length, 6);
  assert.equal(kinds[0], 'room.create', 'each room starts with its create');
  rep.stop();
  store.close();
  other.close();
});

// ---- (p) Incremental anti-entropy ----

test('anti-entropy: a full first round, then only what changed; hourly full again', async () => {
  const { A, B, calls, done } = await pair();
  try {
    for (const b of rooms(3)) for (const s of b.steps) A.store.ingest(s.event);
    const now = Date.now();
    await B.replicator.antiEntropy(B.peers.get(A.id), now);
    assert.equal(calls.find((c) => c.path === '/v2/rooms').body.since, undefined, 'first round: full');
    assert.equal(B.store.counts().rooms, 3);

    calls.length = 0;
    await B.replicator.antiEntropy(B.peers.get(A.id), now + 60_000);
    const roomsCall = calls.find((c) => c.path === '/v2/rooms');
    assert.equal(typeof roomsCall.body.since, 'string', 'second round: from the mark');
    assert.deepEqual(calls.map((c) => c.path), ['/v2/rooms', '/v2/agents', '/v2/reports'], 'nothing changed: three small listings, no pulls');

    // A new post in one room: only that room is listed, and pulled.
    const extra = rooms(1, 'late')[0];
    for (const s of extra.steps) A.store.ingest(s.event);
    calls.length = 0;
    await B.replicator.antiEntropy(B.peers.get(A.id), now + 120_000);
    assert.equal(B.store.counts().rooms, 4);
    assert.ok(calls.some((c) => c.path === '/v2/since'), 'the changed room was pulled');

    calls.length = 0;
    await B.replicator.antiEntropy(B.peers.get(A.id), now + 60_000 + FULL_ROUND_MS);
    assert.equal(calls.find((c) => c.path === '/v2/rooms').body.since, undefined, 'hourly: full again');
  } finally {
    await done();
  }
});

test('a since listing returns only changed rooms; a mark from another node is ignored', async () => {
  const { A, B, done } = await pair();
  try {
    for (const b of rooms(3)) for (const s of b.steps) A.store.ingest(s.event);
    const post = (body) => fetch(`${A.url}/v2/rooms`, { method: 'POST', body: JSON.stringify(signPeer(B.store.node, body)) }).then((r) => r.json());
    const first = await post({});
    assert.equal(first.rooms.length, 3);
    assert.equal(typeof first.mark, 'string');
    assert.deepEqual((await post({ since: first.mark })).rooms, [], 'nothing changed');
    const late = rooms(1, 'late')[0];
    for (const s of late.steps) A.store.ingest(s.event);
    assert.deepEqual((await post({ since: first.mark })).rooms.map((r) => r.room), [late.room.id]);
    assert.equal((await post({ since: B.store.mark() })).rooms.length, 4, "another node's mark: a full listing");
    assert.equal((await post({ since: 'junk' })).rooms.length, 4);
  } finally {
    await done();
  }
});

test('a node before 0.6.0 (no mark) gets a full comparison every round', async () => {
  const strip = async (url, res) => {
    if (!/\/v2\/(rooms|agents|reports)$/.test(new URL(url).pathname)) return res;
    const body = await res.json();
    delete body.mark;
    return new Response(JSON.stringify(body), { status: res.status });
  };
  const { A, B, calls, done } = await pair({ rewrite: strip });
  try {
    for (const b of rooms(1)) for (const s of b.steps) A.store.ingest(s.event);
    await B.replicator.antiEntropy(B.peers.get(A.id));
    calls.length = 0;
    await B.replicator.antiEntropy(B.peers.get(A.id));
    assert.equal(calls.find((c) => c.path === '/v2/rooms').body.since, undefined);
  } finally {
    await done();
  }
});

test('the adoption limit holds a mark back until every new room is adopted', async () => {
  const { A, B, calls, done } = await pair({ replicator: { newRoomsPerRound: 1 } });
  try {
    for (const b of rooms(3)) for (const s of b.steps) A.store.ingest(s.event);
    const now = Date.now();
    for (let i = 0; i < 3; i++) await B.replicator.antiEntropy(B.peers.get(A.id), now + i * 60_000);
    assert.equal(B.store.counts().rooms, 3, 'one new room a round, none lost to the mark');
    calls.length = 0;
    await B.replicator.antiEntropy(B.peers.get(A.id), now + 3 * 60_000);
    assert.equal(typeof calls.find((c) => c.path === '/v2/rooms').body.since, 'string', 'then incremental');
  } finally {
    await done();
  }
});

// ---- (q) Chain tails ----

function chain(n) {
  const b = new Builder();
  const alice = b.agent('alice');
  b.register('reg', alice);
  let parent = 'reg';
  for (let i = 0; i < n; i++) {
    b.agentEvent(`p${i}`, alice, 'agent.profile', { parent, data: { description: `v${i}` } });
    parent = `p${i}`;
  }
  return { b, alice };
}

test('a chain pull asks from our own head and gets only the tail', async () => {
  const { b, alice } = chain(10);
  const { A, B, calls, done } = await pair();
  try {
    for (const s of b.steps) A.store.ingest(s.event);
    for (const s of b.steps.slice(0, 6)) B.store.ingest(s.event);
    await B.replicator.pullChain(B.peers.get(A.id), alice.id);
    const c = calls.filter((x) => x.path === '/v2/chain');
    assert.equal(c.length, 1);
    assert.equal(c[0].body.after, b.id('p4'), "from B's head");
    assert.equal(B.store.agent(alice.id).head, b.id('p9'));
  } finally {
    await done();
  }
});

test('a head not on the peer\'s chain (a fork) gets after_unknown, and the pull starts over', async () => {
  const { b, alice } = chain(3);
  // A branch only B holds: after p0, B's alice wrote 'alt' instead of p1.
  b.agentEvent('alt', alice, 'agent.profile', { parent: 'p0', data: { description: 'elsewhere' } });
  const step = (label) => b.steps.find((x) => x.label === label).event;
  const { A, B, calls, done } = await pair();
  try {
    for (const l of ['reg', 'p0', 'p1', 'p2']) A.store.ingest(step(l));
    for (const l of ['reg', 'p0', 'alt']) B.store.ingest(step(l));
    const res = await fetch(`${A.url}/v2/chain`, { method: 'POST', body: JSON.stringify(signPeer(B.store.node, { agent: alice.id, after: b.id('alt') })) }).then((r) => r.json());
    assert.deepEqual(res, { events: [], more: false, after_unknown: true });
    calls.length = 0;
    await B.replicator.pullChain(B.peers.get(A.id), alice.id);
    assert.deepEqual(calls.map((c) => c.body.after ?? null), [b.id('alt'), null], 'from our head first, then from the start');
    assert.ok(B.store.agentEvent(b.id('p2')), "A's branch arrived");
  } finally {
    await done();
  }
});

test('a gap is due when found, then after 1, 2, 4 minutes as it is asked again, at most 6 hours', () => {
  const store = new Store();
  const b = rooms(1)[0];
  for (const ev of b.steps.map((s) => s.event).map(({ content, ...rest }) => rest)) store.ingest(ev);
  const id = b.id('hello');
  let now = Date.now();
  assert.deepEqual(store.contentGaps(10, now), [id], 'due when found');
  for (const waitMin of [1, 2, 4, 8]) {
    store.gapsAsked([id], now);
    assert.deepEqual(store.contentGaps(10, now + waitMin * 60_000 - 1000), [], `not before ${waitMin} min`);
    now += waitMin * 60_000;
    assert.deepEqual(store.contentGaps(10, now), [id], `due after ${waitMin} min`);
  }
  for (let i = 0; i < 20; i++) store.gapsAsked([id], now);
  assert.deepEqual(store.contentGaps(10, now + 6 * 3_600_000), [id], 'never more than 6 hours');
  store.close();
});

// ---- (n) Early discovery ----

test('a correctly signed request from an unknown node runs discovery early, at most every 5 minutes', async () => {
  const store = new Store();
  const stranger = new Store();
  const peers = new Peers([], { log: quiet });
  let runs = 0;
  const d = new Discovery(store, peers, { networks: ['main'], log: quiet, intervalMs: 0, listSuppliers: async () => { runs++; return []; } });
  const seen = [];
  const server = createPeerServer(store, peers, null, { onUnknownPeer: (id) => seen.push(id) && d.nudge(id) });
  const port = await listen(server);
  try {
    const post = (body) => fetch(`http://127.0.0.1:${port}/v2/rooms`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.status);
    assert.equal(await post(signPeer(stranger.node, {})), 403, 'still refused');
    assert.deepEqual(seen, [stranger.node.id]);
    await wait(20);
    assert.equal(runs, 1, 'discovery ran at once');
    const forged = signPeer(stranger.node, {});
    forged.auth.sig = forged.auth.sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    assert.equal(await post(forged), 403);
    assert.equal(seen.length, 1, 'a bad signature does not count');
    assert.equal(await post(signPeer(stranger.node, {})), 403);
    await wait(20);
    assert.equal(runs, 1, 'not again within 5 minutes');
    assert.equal(d.nudge(stranger.node.id, Date.now() + EARLY_MIN_MS + 1), true);
    assert.equal(verifyPeer(signPeer(stranger.node, {}), peers).signed, stranger.node.id);
  } finally {
    await close(server);
    store.close();
    stranger.close();
  }
});
