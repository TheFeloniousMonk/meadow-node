import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Builder } from '../../conformance/tools/builder.js';
import { createPeerServer } from '../src/server.js';
import { Store } from '../src/store/store.js';
import { Peers, signPeer } from '../src/peer/peers.js';
import { Replicator } from '../src/peer/replicator.js';
import { Discovery } from '../src/peer/discovery.js';
import { keypairFromSeed } from '../src/proto/keys.js';
import { b64u, sha256 } from '../src/proto/encoding.js';
import { verifyReport } from '../src/proto/report.js';
import { events } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const quiet = { warn() {} };

// n nodes, each with a peer server on localhost, all peered with each other.
// Timers are off, so tests drive flushes and anti-entropy. `setup(stores)` runs
// before replication starts.
async function cluster(n, setup = () => {}, opts = {}) {
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const store = new Store();
    const peers = new Peers();
    const replicator = new Replicator(store, peers, { flushMs: 0, antiEntropyMs: 0, log: quiet, ...opts });
    const server = createPeerServer(store, peers, replicator);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    nodes.push({ store, peers, replicator, server, id: store.node.id, url: `http://127.0.0.1:${server.address().port}` });
  }
  for (const a of nodes) for (const b of nodes) if (a !== b) a.peers.add({ id: b.id, url: b.url });
  setup(nodes.map((x) => x.store));
  for (const x of nodes) x.replicator.start();
  const close = () => Promise.all(nodes.map((x) => {
    x.replicator.stop();
    return new Promise((resolve) => x.server.close(resolve));
  }));
  return { nodes, close };
}

async function settle(nodes) {
  for (let round = 0; round < 5; round++) {
    await Promise.all(nodes.map((x) => x.replicator.flushAll()));
    await Promise.all(nodes.map((x) => x.replicator.idle()));
  }
}

function room() {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  b.create('create', alice, { type: 'public' });
  b.join('alice-join', alice);
  b.post('hello', alice, 'hello');
  b.join('bob-join', bob);
  b.post('reply', bob, 'hi');
  return { b, alice, bob };
}

const post = (url, body) => fetch(url, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('new events reach every node by push', async () => {
  const { nodes, close } = await cluster(3);
  try {
    const { b } = room();
    const [A, B, C] = nodes;
    for (const s of b.steps) assert.equal(A.store.ingest(s.event).outcome, 'accepted');
    await settle(nodes);
    for (const x of [B, C]) {
      const r = x.store.room(b.room.id);
      assert.deepEqual(r.heads(), A.store.room(b.room.id).heads());
      assert.equal(x.store.serve(r, b.id('reply')).content, events(b, 'reply')[0].content);
    }
  } finally {
    await close();
  }
});

test('gossip forwards pushes beyond the first hop', async () => {
  // A knows only B. With fanout 1, B never sends back to its origin, so it
  // must forward to C.
  const { nodes, close } = await cluster(3, () => {}, { fanout: 1 });
  try {
    const [A, B, C] = nodes;
    A.peers.remove(C.id);
    const { b } = room();
    for (const s of b.steps) A.store.ingest(s.event);
    await settle(nodes);
    assert.equal(C.store.room(b.room.id)?.size, 5);
  } finally {
    await close();
  }
});

test('a push with missing history makes the receiver pull it from the sender', async () => {
  const { b } = room();
  const { nodes, close } = await cluster(2, ([a]) => { for (const s of b.steps) a.ingest(s.event); });
  try {
    const [A, B] = nodes;
    const res = await post(`${B.url}/v2/push`, signPeer(A.store.node, { events: events(b, 'reply') }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.pending, [b.id('reply')]);
    await B.replicator.idle();
    assert.deepEqual(B.store.room(b.room.id).heads(), [b.id('reply')]);
    assert.equal(B.replicator.heldCount, 0);
  } finally {
    await close();
  }
});

test('anti-entropy catches a node up, agent chains and bindings included', async () => {
  const b = new Builder();
  const alice = b.agent('alice');
  const bob = b.agent('bob');
  b.create('create', alice, { type: 'private' });
  b.join('alice-join', alice);
  b.member('invite', alice, bob, 'invite');
  b.register('bob-register', bob);
  b.agentEvent('bob-rotate', bob, 'agent.rotate', { parent: 'bob-register', data: { key: b.newKey(bob, 'second') } });
  b.bind('bind', bob, 'bob-rotate', { key: 'second' });
  b.join('join', bob, { key: 'second' });
  b.sealed('secret', bob, 'hello', { key: 'second' });

  const { nodes, close } = await cluster(2, ([a]) => { for (const s of b.steps) assert.equal(a.ingest(s.event).outcome, 'accepted'); });
  try {
    const [A, C] = nodes;
    await C.replicator.antiEntropy(C.peers.get(A.id));
    const r = C.store.room(b.room.id);
    assert.deepEqual(r.heads(), [b.id('secret')]);
    assert.equal(r.outcome(b.id('join')).outcome, 'accepted');
    assert.equal(C.store.agent(bob.id).head, b.id('bob-rotate'));
    assert.equal(C.store.membership(b.room.id, bob.id).membership, 'join');
  } finally {
    await close();
  }
});

test('a copy with content fills in a copy received without it', async () => {
  const { b } = room();
  const { nodes, close } = await cluster(2);
  try {
    const [A, B] = nodes;
    const bare = events(b, 'create', 'alice-join', 'hello').map(({ content, ...ev }) => ev);
    await post(`${B.url}/v2/push`, signPeer(A.store.node, { events: bare }));
    const r = B.store.room(b.room.id);
    assert.equal(B.store.serve(r, b.id('hello')).content, undefined);
    await post(`${B.url}/v2/push`, signPeer(A.store.node, { events: events(b, 'hello') }));
    assert.equal(B.store.serve(r, b.id('hello')).content, events(b, 'hello')[0].content);
  } finally {
    await close();
  }
});

test('unknown nodes are refused, and peers sending invalid events are dropped', async () => {
  const { nodes, close } = await cluster(2);
  try {
    const [A, B] = nodes;
    const stranger = keypairFromSeed(sha256('stranger'));
    const strangerNode = { id: 'n_' + b64u(stranger.publicKey), privateKey: stranger.privateKey };
    const refused = await post(`${B.url}/v2/rooms`, signPeer(strangerNode, {}));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'unknown_peer');
    assert.equal((await post(`${B.url}/v2/hello`, {})).body.node, B.id, 'hello needs no auth');

    const { b } = room();
    const forged = { ...events(b, 'hello')[0], sig: events(b, 'create')[0].sig };
    for (let i = 0; i < 5; i++) await post(`${B.url}/v2/push`, signPeer(A.store.node, { events: Array(10).fill(forged) }));
    assert.equal(B.peers.get(A.id).banned, true);
    assert.equal((await post(`${B.url}/v2/rooms`, signPeer(A.store.node, {}))).status, 403);
  } finally {
    await close();
  }
});

test('a push starts at most one new room and one new agent; backlogs are split to fit', async () => {
  const builders = [0, 1, 2].map((i) => {
    const b = new Builder();
    b.create('create', b.agent('alice'), { type: 'public', levels: { post: i } });
    b.join('join', b.agent('alice'));
    return b;
  });
  const agents = new Builder();
  for (const name of ['pat', 'quinn', 'rae']) agents.register(name, agents.agent(name));
  const { nodes, close } = await cluster(3, () => {}, { fanout: 1 });
  try {
    const [A, B, C] = nodes;
    const res = await post(`${B.url}/v2/push`, signPeer(A.store.node, {
      events: [...builders.map((b) => events(b, 'create')[0]), ...agents.steps.map((s) => s.event)],
    }));
    assert.equal(res.body.accepted, 2);
    assert.equal(res.body.create_limit.length, 4);

    A.peers.remove(B.id);
    for (const b of builders) for (const s of b.steps) A.store.ingest(s.event);
    await A.replicator.flushAll();
    for (const b of builders) assert.equal(C.store.room(b.room.id)?.size, 2);
  } finally {
    await close();
  }
});

test('anti-entropy skips rooms quiet past the expiry window, and caps new rooms per round', async () => {
  const old = room();
  const fresh = [0, 1, 2, 3].map((i) => {
    const b = new Builder();
    b.create('create', b.agent('alice'), { type: 'public', levels: { invite: i } });
    return b;
  });
  const { nodes, close } = await cluster(2, ([a]) => {
    for (const s of old.b.steps) a.ingest(s.event, Date.now() - 100 * DAY);
    for (const b of fresh) a.ingest(events(b, 'create')[0]);
  }, { newRoomsPerRound: 3 });
  try {
    const [A, C] = nodes;
    await C.replicator.antiEntropy(C.peers.get(A.id));
    assert.equal(C.store.room(old.b.room.id), undefined);
    assert.equal(fresh.filter((b) => C.store.room(b.room.id)).length, 3);
    await C.replicator.antiEntropy(C.peers.get(A.id));
    assert.equal(fresh.filter((b) => C.store.room(b.room.id)).length, 4);
  } finally {
    await close();
  }
});

test('reports spread by push, and anti-entropy covers what push missed', async () => {
  const b = new Builder();
  const alice = b.agent('alice');
  b.create('create', alice, { type: 'public' });
  b.join('alice-join', alice);
  b.post('spam', alice, 'buy now');
  b.post('scam', alice, 'send keys');
  const strip = (ev) => ({ header: ev.header, id: ev.id, sig: ev.sig });
  const early = { event: strip(events(b, 'spam')[0]), reason: 'spam' };
  const late = { event: strip(events(b, 'scam')[0]), reason: 'abuse' };
  const earlyId = verifyReport(early).id;
  const lateId = verifyReport(late).id;
  // `early` is stored before replication starts, so only anti-entropy can spread it.
  const { nodes, close } = await cluster(3, ([a]) => a.addReport(earlyId, early, b.agent('carol').id));
  try {
    const [A, B, C] = nodes;
    A.store.addReport(lateId, late, b.agent('carol').id);
    await settle(nodes);
    for (const x of [B, C]) assert.deepEqual(x.store.report(lateId), late);
    assert.equal(B.store.report(earlyId), null);
    await Promise.all([B, C].map((x) => x.replicator.antiEntropy(x.peers.get(A.id))));
    for (const x of [B, C]) assert.deepEqual(x.store.report(earlyId), early);
  } finally {
    await close();
  }
});

test('discovery finds nodes at staked suppliers’ hostnames and drops ones that stop answering', async () => {
  const { nodes, close } = await cluster(3);
  try {
    const [A, B, C] = nodes;
    const peers = new Peers();
    let listed = [B.url, C.url, 'http://127.0.0.1:9', 'not a url'];
    const d = new Discovery(A.store, peers, {
      networks: ['beta'], peerPath: '', timeoutMs: 2000,
      listSuppliers: async () => [{ operator: 'pokt1x', urls: [...listed, A.url] }],
    });
    const found = await d.run();
    assert.deepEqual(found.map((p) => p.id).sort(), [B.id, C.id].sort(), 'itself and dead hosts are skipped');
    assert.equal(peers.get(B.id).url, B.url);

    const configured = 'n_' + 'A'.repeat(43);
    peers.add({ id: configured, url: 'http://127.0.0.1:9' });
    listed = [B.url];
    await d.run();
    assert.deepEqual(peers.all().map((p) => p.id).sort(), [B.id, configured].sort());
  } finally {
    await close();
  }
});

test('content repair: anti-entropy fetches content a node holds events without', async () => {
  const { b } = room();
  const { nodes, close } = await cluster(2);
  try {
    const [A, B] = nodes;
    for (const s of b.steps) assert.equal(A.store.ingest(s.event).outcome, 'accepted');
    // B gets the room's events without content, so no later push would resend them.
    const bare = b.steps.map((s) => s.event).map(({ content, ...ev }) => ev);
    for (const ev of bare) assert.equal(B.store.ingest(ev).outcome, 'accepted');
    assert.deepEqual(B.store.contentGaps(10).sort(), [b.id('hello'), b.id('reply')].sort());

    await B.replicator.antiEntropy(B.peers.get(A.id));
    const r = B.store.room(b.room.id);
    assert.equal(B.store.serve(r, b.id('hello')).content, events(b, 'hello')[0].content);
    assert.equal(B.store.serve(r, b.id('reply')).content, events(b, 'reply')[0].content);
    assert.deepEqual(B.store.contentGaps(10), []);
  } finally {
    await close();
  }
});

test('content repair checks bytes against the signed hash and scores down a peer that lies', async () => {
  const { b } = room();
  const { nodes, close } = await cluster(2);
  try {
    const [A, B] = nodes;
    for (const s of b.steps) A.store.ingest(s.event);
    for (const ev of b.steps.map((s) => s.event).map(({ content, ...rest }) => rest)) B.store.ingest(ev);
    A.store.peerContent = () => JSON.stringify({ text: 'words never written' });

    assert.equal(await B.replicator.repairContent(B.peers.get(A.id)), 0);
    assert.equal(B.store.serve(B.store.room(b.room.id), b.id('hello')).content, undefined);
    assert.ok(B.peers.get(A.id).penalty >= 2, 'each wrong content scores the peer down');
    assert.equal(B.store.contentGaps(10).length, 2, 'the gaps stay open for an honest peer');
  } finally {
    await close();
  }
});

test('content repair never refills deleted or expired content', async () => {
  const { b, alice } = room();
  b.add('delete', alice, 'msg.delete', { data: { target: b.id('hello') } });
  const { nodes, close } = await cluster(2);
  try {
    const [A, B] = nodes;
    // A holds everything with content, as if it had not seen the deletion yet.
    for (const s of b.steps.slice(0, -1)) A.store.ingest(s.event);
    for (const s of b.steps) B.store.ingest(s.event);
    const r = B.store.room(b.room.id);
    assert.equal(B.store.serve(r, b.id('hello')).withheld, 'author');
    assert.deepEqual(B.store.contentGaps(10), [], 'a deletion is not a gap');
    assert.equal(B.store.repairContent(b.id('hello'), events(b, 'hello')[0].content), 'skipped');
    assert.equal(B.store.serve(r, b.id('hello')).withheld, 'author');

    // Content older than the retention window is not asked for: it would have expired.
    const c = new Builder();
    const carol = c.agent('carol');
    c.create('create', carol, { type: 'public' });
    c.join('join', carol);
    c.post('old', carol, 'old');
    for (const ev of c.steps.map((s) => s.event).map(({ content, ...rest }) => rest)) B.store.ingest(ev);
    assert.deepEqual(B.store.contentGaps(10), [c.id('old')]);
    assert.deepEqual(B.store.contentGaps(10, Date.now() + B.store.retention.contentMs + 1), []);
  } finally {
    await close();
  }
});

test('a peer without /v2/content (an older release) does not stop the rest of anti-entropy', async () => {
  const { b } = room();
  const { nodes, close } = await cluster(2);
  try {
    const [A, B] = nodes;
    for (const s of b.steps) A.store.ingest(s.event);
    for (const ev of b.steps.map((s) => s.event).map(({ content, ...rest }) => rest)) B.store.ingest(ev);
    const late = { event: { header: events(b, 'reply')[0].header, id: b.id('reply'), sig: events(b, 'reply')[0].sig }, reason: 'spam' };
    const lateId = verifyReport(late).id;
    A.store.addReport(lateId, late, null);
    const realFetch = globalThis.fetch;
    const oldPeer = (url, init) => (url.endsWith('/v2/content')
      ? Promise.resolve(new Response(JSON.stringify({ error: { code: 'not_found', message: 'no such endpoint' } }), { status: 404 }))
      : realFetch(url, init));
    const replicator = new Replicator(B.store, B.peers, { flushMs: 0, antiEntropyMs: 0, log: quiet, fetch: oldPeer });
    await replicator.antiEntropy(B.peers.get(A.id));
    assert.deepEqual(B.store.report(lateId), late, 'reports still sync');
    assert.equal(B.store.contentGaps(10).length, 2, 'gaps stay open for a newer peer');
  } finally {
    await close();
  }
});
