// At 1,000 nodes (SPEC §17 q13 s, t, u, v): stable anti-entropy partners, discovery from the
// indexer with only what changed, gossip to healthy peers, and gossiping what completes a push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Builder } from '../../conformance/tools/builder.js';
import { createPeerServer } from '../src/server.js';
import { Store } from '../src/store/store.js';
import { BAN_THRESHOLD, Peers, signPeer } from '../src/peer/peers.js';
import { Replicator } from '../src/peer/replicator.js';
import { Discovery } from '../src/peer/discovery.js';
import { listSuppliers } from '../src/peer/chain.js';

const quiet = { log() {}, warn() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(r));
const fakeId = (i) => 'n_' + String(i).padStart(43, 'A');
const PUSHED = { accepted: 1, rejected: 0, discarded: 0, pending: [], create_limit: [], reports: 0 };

function room(name = 'alice', posts = 1) {
  const b = new Builder();
  const a = b.agent(name);
  b.create('create', a, { type: 'public' });
  b.join('join', a);
  for (let i = 0; i < posts; i++) b.post(`p${i}`, a, `hello ${i}`);
  return b;
}

// ---- (t) Discovery from the indexer ----

test('indexer listing: complete, then only changes since a height; unbonding comes back removed; a lagging indexer falls back to the chain API', async () => {
  const asked = [];
  let lag = 0;
  const fetch = async (url, init) => {
    if (url.startsWith('https://idx')) {
      asked.push(JSON.parse(init.body));
      return json({ data: {
        _metadata: { lastProcessedHeight: 1000, targetHeight: 1000 + lag },
        supplierServiceConfigs: { nodes: [
          { supplierId: 'pokt1a', endpoints: [{ url: 'https://a.example', rpcType: 4 }], supplier: { stakeStatus: 'Staked' } },
          { supplierId: 'pokt1b', endpoints: [{ url: 'https://b.example' }], supplier: { stakeStatus: 'Unstaking' } },
        ], pageInfo: { hasNextPage: false, endCursor: null } },
      } });
    }
    return json({ supplier: [{ operator_address: 'pokt1lcd', services: [{ service_id: 'meadow', endpoints: [{ url: 'https://lcd.example' }] }] }], pagination: {} });
  };
  const opts = { indexer: 'https://idx/graphql', base: 'https://lcd', fetch };

  const full = await listSuppliers('main', opts);
  assert.deepEqual({ full: full.full, height: full.height, source: full.source }, { full: true, height: 1000, source: 'indexer' });
  assert.equal(asked[0].variables.since, undefined);
  assert.match(asked[0].query, /stakeStatus: \{ equalTo: Staked \}/);

  const changes = await listSuppliers('main', { ...opts, since: 900 });
  assert.equal(asked[1].variables.since, '900');
  assert.match(asked[1].query, /unstakingBeginBlockId/);
  assert.equal(changes.full, false);
  assert.deepEqual(changes.suppliers, [{ operator: 'pokt1a', urls: ['https://a.example'] }]);
  assert.deepEqual(changes.removed, ['pokt1b']);

  lag = 500;
  const fallback = await listSuppliers('main', opts);
  assert.equal(fallback.source, 'chain API');
  assert.match(fallback.fallback, /500 blocks behind/);
  assert.deepEqual({ full: fallback.full, height: fallback.height }, { full: true, height: null });
  assert.deepEqual(fallback.suppliers, [{ operator: 'pokt1lcd', urls: ['https://lcd.example'] }]);
});

test('discovery reads changes between complete listings and asks a hostname only when new, failing, or due again', async () => {
  const store = new Store();
  const others = [new Store(), new Store(), new Store()];
  const nodeAt = { 'https://a.x': others[0].node.id, 'https://b.x': others[1].node.id, 'https://c.x': others[2].node.id, 'https://us.x': store.node.id };
  const down = new Set(['https://b.x']);
  let hellos = [];
  const fetch = async (url) => {
    const origin = new URL(url).origin;
    hellos.push(origin);
    if (down.has(origin)) throw new Error('refused');
    return json({ node: nodeAt[origin] });
  };
  const sinces = [];
  let answer;
  const peers = new Peers([], { log: quiet });
  const d = new Discovery(store, peers, {
    networks: ['main'], peerPath: '', fetch, log: quiet, fullEveryMs: 300, recheckMs: 300,
    listSuppliers: async (network, { since }) => {
      sinces.push(since);
      return answer;
    },
  });
  const s = (op, url) => ({ operator: op, urls: [url] });
  const ids = () => peers.all().map((p) => p.id).sort();

  answer = { suppliers: [s('us', 'https://us.x'), s('a', 'https://a.x'), s('b', 'https://b.x')], removed: [], height: 100, full: true };
  await d.run();
  assert.deepEqual(sinces, [null], 'first run: complete');
  assert.deepEqual(hellos.sort(), ['https://a.x', 'https://b.x', 'https://us.x']);
  assert.deepEqual(ids(), [others[0].node.id]);
  assert.deepEqual({ suppliers: d.status.suppliers, others: d.status.others, found: d.status.found }, { suppliers: 3, others: 2, found: 1 });

  hellos = [];
  answer = { suppliers: [s('c', 'https://c.x')], removed: [], height: 110, full: false };
  await d.run();
  assert.equal(sinces[1], 100, 'then only what changed since the last height');
  assert.deepEqual(hellos.sort(), ['https://b.x', 'https://c.x'], 'the new hostname, and the one that failed; not the ones that answered');
  assert.deepEqual(ids(), [others[0].node.id, others[2].node.id].sort());

  hellos = [];
  answer = { suppliers: [], removed: ['a'], height: 120, full: false };
  await d.run();
  assert.equal(sinces[2], 110);
  assert.deepEqual(ids(), [others[2].node.id], 'a supplier no longer staked is dropped');
  assert.deepEqual(hellos, ['https://b.x']);

  await wait(320);
  hellos = [];
  answer = { suppliers: [s('us', 'https://us.x'), s('c', 'https://c.x')], removed: [], height: 130, full: true };
  await d.run();
  assert.equal(sinces[3], null, 'complete again once the listing is old');
  assert.deepEqual(hellos.sort(), ['https://c.x', 'https://us.x'], 'answering hostnames asked again once due; b is no longer listed');
  assert.deepEqual(ids(), [others[2].node.id]);
  store.close();
  for (const o of others) o.close();
});

test('discovery asks at most a few hostnames at once, and falls back to a complete run after a listing without a height', async () => {
  const store = new Store();
  let inflight = 0;
  let max = 0;
  let asked = 0;
  const fetch = async () => {
    inflight++;
    asked++;
    max = Math.max(max, inflight);
    await wait(5);
    inflight--;
    throw new Error('refused');
  };
  const sinces = [];
  const d = new Discovery(store, new Peers([], { log: quiet }), {
    networks: ['main'], peerPath: '', fetch, log: quiet, hellos: 3,
    listSuppliers: async (network, { since }) => {
      sinces.push(since);
      return { suppliers: Array.from({ length: 20 }, (_, i) => ({ operator: `s${i}`, urls: [`https://h${i}.x`] })), removed: [], height: null, full: true, source: 'chain API' };
    },
  });
  await d.run();
  assert.equal(asked, 20);
  assert.equal(max, 3);
  await d.run();
  assert.deepEqual(sinces, [null, null], 'no height to start from: complete again');
  store.close();
});

// ---- (u) Gossip to healthy peers ----

test('push targets leave out a peer waiting after failed pushes', async () => {
  const store = new Store();
  const peers = new Peers([], { log: quiet });
  const pushed = { p1: [], p2: [] };
  const fetch = async (url, init) => {
    const host = new URL(url).host;
    const ids = JSON.parse(init.body).events.map((e) => e.id);
    pushed[host].push(ids);
    if (host === 'p1') throw new Error('ECONNREFUSED');
    return json(PUSHED);
  };
  const rep = new Replicator(store, peers, { fetch, fanout: 1, flushMs: 0, antiEntropyMs: 0, log: quiet }).start();
  peers.add({ id: fakeId(1), url: 'http://p1' });
  const first = room('first', 0);
  for (const s of first.steps) store.ingest(s.event);
  await rep.flushAll();
  assert.equal(pushed.p1.length, 1, 'the only peer, and its push fails');

  peers.add({ id: fakeId(2), url: 'http://p2' });
  const later = room('later', 5);
  for (const s of later.steps) store.ingest(s.event);
  await rep.flushAll();
  assert.equal(pushed.p1.length, 1, 'no push to p1 while it waits');
  assert.deepEqual(pushed.p2.flat().sort(), later.steps.map((s) => s.event.id).sort(), 'every new event went to the healthy peer');

  await wait(1100);
  await rep.flushAll();
  assert.deepEqual(pushed.p1.at(-1).sort(), first.steps.map((s) => s.event.id).sort(), 'p1 is retried with only what was queued before');
  rep.stop();
  store.close();
});

// ---- (s) Stable anti-entropy partners ----

function partnerRig(opts = {}) {
  const store = new Store();
  const peers = new Peers([], { log: quiet });
  for (let i = 0; i < 10; i++) peers.add({ id: fakeId(i), url: `http://p${i}` });
  const contacted = [];
  const failing = new Set();
  const fetch = async (url) => {
    const u = new URL(url);
    const i = Number(u.host.slice(1));
    if (u.pathname === '/v2/rooms') contacted.push(fakeId(i));
    if (failing.has(fakeId(i))) throw new Error('timeout');
    if (u.pathname === '/v2/rooms') return json({ rooms: [], mark: 'm' });
    if (u.pathname === '/v2/agents') return json({ agents: [], mark: 'm' });
    if (u.pathname === '/v2/reports') return json({ reports: [], mark: 'm' });
    return json({ content: {} });
  };
  const rep = new Replicator(store, peers, { fetch, flushMs: 0, antiEntropyMs: 0, log: quiet, ...opts });
  return { store, peers, rep, contacted, failing };
}

test('anti-entropy rounds go to four stable partners in turn, and their marks stay in use', async () => {
  const { store, rep, contacted } = partnerRig({ randomPeerShare: 0 });
  const now = Date.now();
  for (let r = 0; r < 20; r++) await rep.antiEntropyAll(now + r * 60_000);
  assert.equal(rep.partners.length, 4);
  assert.deepEqual([...new Set(contacted)].sort(), [...rep.partners].sort(), 'only partners were asked');
  for (const id of rep.partners) assert.equal(contacted.filter((c) => c === id).length, 10, 'each in turn');
  store.close();
});

test('partners change one at a time when their terms end, and at once when dropped, banned, or failing', async () => {
  const { store, peers, rep } = partnerRig({ randomPeerShare: 0 });
  const now = Date.now();
  await rep.antiEntropyAll(now);
  const before = rep.partners;
  await rep.antiEntropyAll(now + 60_000);
  assert.deepEqual(rep.partners, before, 'kept within their terms');

  const later = now + 10 * 60 * 60 * 1000; // past every term
  await rep.antiEntropyAll(later);
  assert.equal(rep.partners.filter((id) => !before.includes(id)).length, 1, 'one replaced per round');
  assert.equal(rep.partners.length, 4);

  const banned = rep.partners[0];
  peers.penalize(banned, BAN_THRESHOLD, 'test');
  const dropped = rep.partners[1];
  peers.remove(dropped);
  await rep.antiEntropyAll(later + 60_000);
  assert.ok(!rep.partners.includes(banned) && !rep.partners.includes(dropped));
  assert.equal(rep.partners.length, 4);

  store.close();

  // Within their terms, a partner that fails a round leaves at once.
  const f = partnerRig({ randomPeerShare: 0 });
  await f.rep.antiEntropyAll(now);
  const failed = f.rep.partners;
  for (const id of failed) f.failing.add(id);
  await f.rep.antiEntropyAll(now + 60_000);
  assert.equal(f.rep.partners.length, 2, 'the two asked this round failed and left');
  f.failing.clear();
  await f.rep.antiEntropyAll(now + 120_000);
  assert.equal(f.rep.partners.length, 4, 'refilled at the next round');
  assert.equal(f.rep.partners.filter((id) => failed.includes(id)).length, 2);
  f.store.close();
});

test('a tick that comes while an anti-entropy round is still running is skipped', async () => {
  const store = new Store();
  const peers = new Peers([], { log: quiet });
  peers.add({ id: fakeId(1), url: 'http://p1' });
  let inRound = 0;
  let max = 0;
  let rounds = 0;
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/v2/rooms') {
      rounds++;
      inRound++;
      max = Math.max(max, inRound);
      await wait(200); // a slow peer: longer than the 30 ms interval below
      inRound--;
      return json({ rooms: [], mark: 'm' });
    }
    if (path === '/v2/agents') return json({ agents: [], mark: 'm' });
    if (path === '/v2/reports') return json({ reports: [], mark: 'm' });
    return json({ content: {} });
  };
  const rep = new Replicator(store, peers, { fetch, flushMs: 0, antiEntropyMs: 30, log: quiet }).start();
  await wait(700);
  rep.stop();
  await rep.idle();
  assert.equal(max, 1, 'never two rounds at once');
  assert.ok(rounds >= 2 && rounds <= 4, `${rounds} rounds in 700 ms at 200 ms each`);
  store.close();
});

test('now and then a round asks a random peer that is not a partner', async () => {
  const { store, rep, contacted } = partnerRig({ randomPeerShare: 1 });
  await rep.antiEntropyAll();
  assert.equal(contacted.length, 2);
  for (const id of contacted) assert.ok(!rep.partners.includes(id));
  store.close();
});

// ---- (v) Gossip what completes a push ----

test('history pulled to complete a push is recorded as the sender’s and gossiped on; anti-entropy pulls are not', async () => {
  const nodes = [];
  for (let i = 0; i < 2; i++) {
    const store = new Store();
    const peers = new Peers([], { log: quiet });
    const replicator = new Replicator(store, peers, { flushMs: 0, antiEntropyMs: 0, log: quiet });
    const server = createPeerServer(store, peers, replicator);
    const port = await listen(server);
    nodes.push({ store, peers, replicator, server, id: store.node.id, url: `http://127.0.0.1:${port}` });
  }
  const [A, B] = nodes;
  A.peers.add({ id: B.id, url: B.url });
  B.peers.add({ id: A.id, url: A.url });
  try {
    const b = room('alice', 3);
    for (const s of b.steps) A.store.ingest(s.event);
    const origins = new Map();
    B.store.onStored((info) => origins.set(info.id, info.origin));
    const last = b.steps.at(-1).event;
    const res = await fetch(`${B.url}/v2/push`, { method: 'POST', body: JSON.stringify(signPeer(A.store.node, { events: [last], reports: [] })) });
    assert.equal(res.status, 200);
    await B.replicator.idle();
    assert.equal(origins.size, b.steps.length, 'the whole room arrived');
    for (const s of b.steps) assert.equal(origins.get(s.event.id), A.id, `${s.label} is A's, to be gossiped on`);

    const other = room('bob', 1);
    for (const s of other.steps) A.store.ingest(s.event);
    await B.replicator.antiEntropy(B.peers.get(A.id));
    for (const s of other.steps) assert.equal(origins.get(s.event.id), 'pull', `${s.label} came by anti-entropy`);
  } finally {
    await Promise.all(nodes.map((n) => close(n.server)));
  }
});
