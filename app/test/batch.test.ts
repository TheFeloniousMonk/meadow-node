// Combining agents' syncs (SPEC §7.9, §16.8, §18.8): with the setting on,
// background receiving and Sync Now sync up to 8 agents that one payer pays
// for in one /v2/sync-batch call; each agent's answer is taken as its own
// sync's would be. MessageGuard then screens every agent's new messages in
// one check. A network without the route means single syncs for an hour; one
// agent's refused entry fails that agent alone; an answer too large for the
// call pages through the agents. Against the node in this process, behind the
// mock portal.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { SYNC } from '../src/core/core.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

let portal: MockPortal;
before(async () => {
  portal = await startMockPortal();
});
after(() => portal.close());

async function computer() {
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog });
  const wallets = new Map<string, string>();
  const agent = async (name: string, wallet = 'Everyday') => {
    if (!wallets.has(wallet)) wallets.set(wallet, s.wallets.create(wallet, '5.00').id);
    const { id } = s.core.createAgent(name);
    s.wallets.assign(id, wallets.get(wallet)!);
    s.connections.set(id, 'chatgpt', name);
    await s.core.register(id);
    return id;
  };
  return { s, agent, wallets };
}

/** Dave writes in his public room; the agents on the other computer join it. */
async function world(names: { name: string; wallet?: string }[]) {
  const W = await computer();
  const dave = await W.agent('dave');
  const { result: room } = await W.s.core.createRoom(dave, { type: 'public', name: 'Porch' });
  const A = await computer();
  const ids: string[] = [];
  for (const n of names) {
    const id = await A.agent(n.name, n.wallet);
    await A.s.core.joinRoom(id, room);
    ids.push(id);
  }
  // Sending is one paid call; settings never change it.
  A.s.setSettings({ combineSyncs: true });
  return { W, A, dave, room, ids };
}

const paidPaths = (s: Services, since: number) => (s.db.prepare('SELECT wallet, path FROM payments WHERE seq > ? ORDER BY seq').all(since) as any[]);
const lastSeq = (s: Services) => (s.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM payments').get() as any).n as number;
const texts = (s: Services, agent: string) => s.core.messages(agent).map((m) => m.text);

test('combined: one paid call brings every agent its new messages, and MessageGuard checks them all in one call', async () => {
  const { W, A, dave, room, ids } = await world([{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }]);
  A.s.setSettings({ guardPublic: true });
  await W.s.core.send(dave, room, 'Morning, everyone.');
  const since = lastSeq(A.s);
  const screened = portal.screened.length;
  const results = await A.s.syncAll('background');
  assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
  const paid = paidPaths(A.s, since);
  assert.deepEqual(paid.map((p) => p.path), ['/v2/sync-batch', '/v1/prompt'], 'one sync call for three agents, one screening call for all');
  for (const id of ids) {
    assert.ok(texts(A.s, id).includes('Morning, everyone.'));
    assert.ok(A.s.lastSyncOk(id), 'each agent counts as synced');
  }
  assert.equal(portal.screened.length, screened + 1);
  assert.match(portal.screened.at(-1)!, /Message 3 of 3/);
  const row: any = A.s.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE guard = 'safe'").get();
  assert.equal(row.n, 3, 'each agent\'s copy is marked from the one check');
});

test('combined: queued events from several agents go out in the one call', async () => {
  const { W, A, room, ids } = await world([{ name: 'alice' }, { name: 'bob' }]);
  portal.always402 = true;
  try {
    for (const [i, id] of ids.entries()) await A.s.core.send(id, room, `queued ${i}`).catch(() => {});
  } finally {
    portal.always402 = false;
  }
  assert.ok(ids.every((id) => A.s.core.outbox(id).some((e) => e.kind === 'msg.post')), 'both posts are queued');
  const since = lastSeq(A.s);
  await A.s.syncAll('person');
  assert.deepEqual(paidPaths(A.s, since).map((p) => p.path), ['/v2/sync-batch']);
  assert.ok(ids.every((id) => !A.s.core.outbox(id).some((e) => e.kind === 'msg.post')), 'both were accepted');
  const dave = W.s.core.agents()[0].id;
  await W.s.core.sync(dave);
  assert.ok(texts(W.s, dave).includes('queued 0') && texts(W.s, dave).includes('queued 1'));
});

test('combined: each wallet pays only for its own agents', async () => {
  const { A, ids } = await world([{ name: 'alice', wallet: 'One' }, { name: 'bob', wallet: 'Two' }, { name: 'carol', wallet: 'Two' }]);
  const since = lastSeq(A.s);
  await A.s.syncAll('background');
  const paid = paidPaths(A.s, since);
  const one = A.s.wallets.walletOf(ids[0]);
  const two = A.s.wallets.walletOf(ids[1]);
  assert.deepEqual(paid.filter((p) => p.wallet === one).map((p) => p.path), ['/v2/sync'], 'alone on its wallet: a single sync');
  assert.deepEqual(paid.filter((p) => p.wallet === two).map((p) => p.path), ['/v2/sync-batch']);
});

test('off by default: one call per agent', async () => {
  const { A } = await world([{ name: 'alice' }, { name: 'bob' }]);
  A.s.setSettings({ combineSyncs: false });
  const since = lastSeq(A.s);
  await A.s.syncAll('background');
  assert.deepEqual(paidPaths(A.s, since).map((p) => p.path), ['/v2/sync', '/v2/sync']);
});

test('a network without the route: single syncs now, and for the next hour', async () => {
  const { A, ids } = await world([{ name: 'alice' }, { name: 'bob' }]);
  const call = A.s.transport.call.bind(A.s.transport);
  let asked = 0;
  A.s.transport.call = async (path, body, agent) => {
    if (path !== '/v2/sync-batch') return call(path, body, agent);
    asked++;
    return { status: 404, data: { error: { code: 'not_found', message: 'no such route' } } };
  };
  const results = await A.s.syncAll('background');
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  assert.equal(asked, 1);
  assert.equal(A.s.core.batchOff(), true);
  for (const id of ids) assert.ok(A.s.lastSyncOk(id));
  await A.s.syncAll('background');
  assert.equal(asked, 1, 'not asked again within the hour');
});

test('one agent refused by the network fails alone; the others are synced', async () => {
  const { W, A, dave, room, ids } = await world([{ name: 'alice' }, { name: 'bob' }]);
  await W.s.core.send(dave, room, 'Still here?');
  const call = A.s.transport.call.bind(A.s.transport);
  A.s.transport.call = async (path, body: any, agent) => {
    if (path === '/v2/sync-batch') body.syncs[1].auth.sig = body.syncs[0].auth.sig; // the second entry's signature is wrong
    return call(path, body, agent);
  };
  const results = await A.s.syncAll('person');
  const failed = results.filter((r) => !r.ok);
  assert.equal(failed.length, 1);
  assert.ok(texts(A.s, results.find((r) => r.ok)!.agent).includes('Still here?'));
  assert.ok(!texts(A.s, failed[0].agent).includes('Still here?'));
  assert.ok((A.s.db.prepare("SELECT 1 FROM problems WHERE agent = ? AND kind = 'sync'").get(failed[0].agent)), 'the failure is kept for the Dashboard');
  assert.ok(ids.includes(failed[0].agent));
});

test('an answer too large for one call pages through the agents, each in turn', async () => {
  const { W, A, dave, room, ids } = await world([{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }]);
  await W.s.core.send(dave, room, 'Paged.');
  const limit = SYNC.limitBytes;
  SYNC.limitBytes = 100_000; // under the node's room for a second entry, so each call serves one agent
  try {
    const since = lastSeq(A.s);
    const results = await A.s.syncAll('background');
    assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
    assert.deepEqual(paidPaths(A.s, since).map((p) => p.path), ['/v2/sync-batch', '/v2/sync-batch', '/v2/sync-batch']);
    for (const id of ids) assert.ok(texts(A.s, id).includes('Paged.'));
  } finally {
    SYNC.limitBytes = limit;
  }
});

test('a node that puts off every agent: one paid call, and the agents are not counted as synced (security review A2)', async () => {
  const { A } = await world([{ name: 'alice' }, { name: 'bob' }]);
  A.s.transport.call = (async (path: string, body: any, agent: string | null) => {
    if (path !== '/v2/sync-batch') throw new Error('unexpected');
    return { status: 200, data: { node: 'n_x', more: true, syncs: body.syncs.map((e: any) => ({ agent: e.auth.agent, deferred: true })) } };
  }) as any;
  const results = await A.s.syncAll('background');
  assert.deepEqual(results.map((r) => r.ok), [false, false]);
});

test('with the club paying and the fallback on, agents are combined only with others on the same wallet (security review A5)', async () => {
  const { A, ids } = await world([{ name: 'alice', wallet: 'One' }, { name: 'bob', wallet: 'Two' }, { name: 'carol', wallet: 'Two' }]);
  // As if a membership were active with the fallback on: the grouping must follow the agents' own wallets.
  (A.s.alumni as any).active = () => true;
  (A.s.alumni as any).fallback = () => true;
  (A.s.alumni as any).settings = () => ({ daily_cap_usd: '1.50', receive_interval_min: 15, messageguard: false, combine_syncs: true });
  const seen: string[][] = [];
  const many = A.s.core.syncMany.bind(A.s.core);
  A.s.core.syncMany = async (agents: string[]) => {
    seen.push([...agents].sort());
    return many(agents);
  };
  await A.s.syncAll('background').catch(() => {});
  const two = [ids[1], ids[2]].sort();
  assert.ok(seen.some((g) => JSON.stringify(g) === JSON.stringify(two)), 'bob and carol together');
  assert.ok(seen.every((g) => !(g.includes(ids[0]) && g.length > 1)), 'alice never with the others');
});

test('combined: each agent takes its own entry\'s attestation, and the node is heard (§16.23)', async () => {
  const { A, ids } = await world([{ name: 'erin' }, { name: 'fay' }]);
  await A.s.syncAll('person');
  for (const id of ids) {
    assert.deepEqual(A.s.core.problems(id).filter((p) => p.kind === 'nodes'), [], 'every entry\'s attestation checks for its own agent');
    const views = A.s.db.prepare('SELECT DISTINCT node FROM node_views WHERE agent = ?').all(id) as any[];
    assert.equal(views.length, 1, 'kept under the agent it names');
  }
  assert.equal((A.s.db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as any).n, 1);
  assert.equal(A.s.core.watch.several(), false, 'one node: quiet');
});
