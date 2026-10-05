// Peer visibility and bans (SPEC §17 q13 m) and operator alerts (§9.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Builder } from '../../conformance/tools/builder.js';
import { createPeerServer, createServer } from '../src/server.js';
import { Store } from '../src/store/store.js';
import { BAN_MS, BAN_THRESHOLD, Peers, signPeer, verifyPeer } from '../src/peer/peers.js';
import { Replicator } from '../src/peer/replicator.js';
import { Traffic, countServer, countingFetch } from '../src/health/traffic.js';
import { Health, QUIET_MS } from '../src/health/health.js';
import { networkTotals } from '../src/health/container.js';
import { buildPayload, containerIssues } from '../src/health/report.js';
import { Alerts, AlertConfigError, parseAlertConfig, postWebhook } from '../src/health/alerts.js';
import { alertTest, openDatabase, operate } from '../src/operator.js';
import { events } from './helpers.js';

const HOOK = 'https://discord.com/api/webhooks/123/secret-token';
const quiet = { log() {}, warn() {} };
const lines = () => {
  const out = [];
  return { out, log: (t) => out.push(t), warn: (t) => out.push(t) };
};
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(r));

function room() {
  const b = new Builder();
  const alice = b.agent('alice');
  b.create('create', alice, { type: 'public' });
  b.join('join', alice);
  b.post('hello', alice, 'hello');
  return b;
}

// ---- Peers: reasons, logging, bans that expire (q13 m) ----

test('a penalty is logged with its reason; at the threshold the peer is banned for an hour, then accepted again', () => {
  let now = 1_000_000;
  const log = lines();
  const store = new Store();
  const peers = new Peers([], { log, now: () => now });
  const other = new Store();
  peers.add({ id: other.node.id, url: 'http://x' });
  peers.penalize(other.node.id, 1, 'bad_signature');
  assert.match(log.out[0], /penalty \+1 \(bad_signature\), 1\/50/);
  peers.penalize(other.node.id, BAN_THRESHOLD - 1, 'bad_report');
  assert.equal(peers.get(other.node.id).banned, true);
  assert.match(log.out.at(-1), /banned for 60 min after 50 penalty points \(last: bad_report\)/);
  assert.equal(verifyPeer(signPeer(other.node, {}, now), peers, now).error, 'unknown_peer');
  assert.equal(peers.active().length, 0);

  now += BAN_MS;
  assert.equal(peers.get(other.node.id).banned, false, 'the ban has expired');
  assert.equal(peers.get(other.node.id).penalty, 0, 'with its penalty cleared');
  assert.match(log.out.at(-1), /ban expired/);
  assert.deepEqual(verifyPeer(signPeer(other.node, {}, now), peers, now), { node: other.node.id });

  peers.penalize(other.node.id, BAN_THRESHOLD, 'content_mismatch');
  assert.match(log.out.at(-1), /banned for 120 min/, 'a second ban lasts twice as long');
  store.close();
  other.close();
});

test('discovery logs a peer added and dropped, and keeps its status', async () => {
  const { Discovery } = await import('../src/peer/discovery.js');
  const store = new Store();
  const other = new Store();
  const log = lines();
  const peers = new Peers([], { log: quiet });
  let answering = true;
  const fetch = async (url) => (url.startsWith('https://them') && answering
    ? new Response(JSON.stringify({ node: other.node.id }), { status: 200 })
    : new Response(JSON.stringify({ node: store.node.id }), { status: 200 }));
  const d = new Discovery(store, peers, {
    networks: ['main'], log, fetch, recheckMs: 0, // every run asks every hostname again
    listSuppliers: async () => [{ operator: 'a', urls: ['https://us'] }, { operator: 'b', urls: ['https://them'] }],
  });
  await d.run();
  assert.match(log.out.join('\n'), /peer n_\S+ added at https:\/\/them\/meadow-peer/);
  assert.deepEqual({ suppliers: d.status.suppliers, others: d.status.others, found: d.status.found }, { suppliers: 2, others: 1, found: 1 });
  answering = false;
  await d.run();
  assert.match(log.out.join('\n'), /dropped/);
  store.close();
  other.close();
});

// ---- Event origin (q13 m) ----

test('each stored event records its origin: a client, or the peer it came from; counts by origin', async () => {
  const a = new Store();
  const b = new Store();
  const peersA = new Peers([], { log: quiet });
  const peersB = new Peers([], { log: quiet });
  const repA = new Replicator(a, peersA, { flushMs: 0, antiEntropyMs: 0, log: quiet });
  const repB = new Replicator(b, peersB, { flushMs: 0, antiEntropyMs: 0, log: quiet });
  const sa = createPeerServer(a, peersA, repA);
  const sb = createPeerServer(b, peersB, repB);
  const pa = await listen(sa);
  const pb = await listen(sb);
  peersA.add({ id: b.node.id, url: `http://127.0.0.1:${pb}` });
  peersB.add({ id: a.node.id, url: `http://127.0.0.1:${pa}` });
  repA.start();
  repB.start();
  const bld = room();
  for (const ev of events(bld, 'create', 'join', 'hello')) a.ingest(ev);
  await repA.flushAll();
  await repB.idle();

  assert.deepEqual(a.ingestCounts.get('client'), { received: 3, accepted: 3 });
  assert.equal(b.ingestCounts.get(a.node.id).accepted, 3, 'B counts them as from A');
  assert.equal(peersA.get(b.node.id).lastOk !== null, true, 'A noted the successful push');
  assert.equal(peersB.get(a.node.id).lastOk !== null, true, 'B noted the signed request it accepted');
  repA.stop();
  repB.stop();
  await close(sa);
  await close(sb);
});

test('origin is stored in the database, and an older database gains the column', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meadow-origin-'));
  const path = join(dir, 'meadow-main.db');
  // A database from before 0.6: events and agent_events without origin.
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, room TEXT NOT NULL,
    event TEXT NOT NULL, content TEXT, withheld TEXT, outcome TEXT NOT NULL, reason TEXT, target TEXT,
    soft_failed INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY, agent TEXT NOT NULL, event TEXT NOT NULL, depth INTEGER NOT NULL,
    rotations INTEGER NOT NULL, state TEXT NOT NULL, received_at INTEGER NOT NULL);`);
  old.close();
  const store = new Store(path);
  const other = new Store();
  const bld = room();
  const [create, join2] = events(bld, 'create', 'join');
  store.ingest(create);
  store.ingest(join2, Date.now(), other.node.id);
  store.close();
  const db = new DatabaseSync(path);
  const rows = db.prepare('SELECT id, origin FROM events ORDER BY seq').all();
  assert.deepEqual(rows.map((r) => r.origin), ['client', other.node.id]);
  db.close();
  other.close();
});

// ---- Traffic ----

test('traffic: a server counts its sockets, and a counting fetch counts bodies', async () => {
  const t = new Traffic();
  const server = countServer(http.createServer((req, res) => res.end('x'.repeat(1000))), t);
  const port = await listen(server);
  const own = new Traffic();
  const f = countingFetch(fetch, own);
  const res = await f(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'y'.repeat(200) });
  assert.equal((await res.text()).length, 1000);
  assert.deepEqual(own.totals(), { in: 1000, out: 200 });
  const totals = t.totals();
  assert.ok(totals.in > 200 && totals.out > 1000, 'headers and bodies, both ways');
  await close(server);
});

test('/proc/net/dev totals leave out loopback', () => {
  const text = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  5000      10    0    0    0     0          0         0     5000      10    0    0    0     0       0          0
  eth0: 123456     100    0    0    0     0          0         0   654321     90    0    0    0     0       0          0`;
  assert.deepEqual(networkTotals(text), { in: 123456, out: 654321 });
  assert.equal(networkTotals(null), null);
});

// ---- Health ----

async function node({ startedAt = Date.now(), now = Date.now } = {}) {
  const store = new Store();
  const peers = new Peers([], { log: quiet, now });
  const relay = createServer(store, { network: 'main', version: 'test' });
  const peer = createPeerServer(store, peers);
  const ports = { relay: await listen(relay), peer: await listen(peer) };
  const discovery = { status: { lastRun: Date.now(), suppliers: 2, others: 1, found: 1, lastError: null, failuresInARow: 0 } };
  const traffic = { relay: new Traffic(), peer: new Traffic(), own: new Traffic() };
  const health = new Health({ network: 'main', store, peers, discovery, traffic, ports, version: '0.6.0', startedAt, now });
  return { store, peers, relay, peer, health, discovery, done: async () => { await close(relay); await close(peer); store.close(); } };
}

test('a healthy node with a syncing peer is OK, and the snapshot is kept for the operator command', async () => {
  const n = await node();
  const other = new Store();
  n.peers.add({ id: other.node.id, url: 'https://them.example/meadow-peer', source: 'chain' });
  n.peers.noteOk(other.node.id);
  const s = await n.health.snapshot({ advance: true });
  assert.equal(s.level, 'ok', JSON.stringify(s.issues));
  assert.equal(s.self.relay.ok && s.self.peer.ok, true);
  assert.equal(s.peers[0].host, 'them.example');
  assert.equal(JSON.parse(n.store.getMeta('health')).node, n.store.node.id);
  await n.done();
  other.close();
});

test('levels: self-checks failing, no peer syncing for 2 hours, a banned peer, discovery failing', async () => {
  const now = Date.now();
  const n = await node({ startedAt: now - QUIET_MS - 1000 });
  const other = new Store();
  n.peers.add({ id: other.node.id, url: 'https://them.example/meadow-peer', source: 'chain' });
  let s = await n.health.snapshot();
  assert.equal(s.level, 'problem');
  assert.match(s.issues.map((i) => i.text).join('\n'), /no peer has had a successful exchange for 2 hours/);

  n.peers.penalize(other.node.id, BAN_THRESHOLD, 'bad_signature');
  n.discovery.status.failuresInARow = 3;
  n.discovery.status.lastError = { text: 'chain API main: 503' };
  s = await n.health.snapshot();
  const text = s.issues.map((i) => `${i.level}: ${i.text}`).join('\n');
  assert.match(text, /warning: Peer n_\S+ \(them.example\) is banned/);
  assert.match(text, /problem: Discovery could not read the chain in its last 3 runs \(chain API main: 503\)/);

  await close(n.relay);
  s = await n.health.snapshot();
  assert.match(s.issues[0].text, /relay port does not answer/);
  await close(n.peer);
  n.store.close();
  other.close();
});

// ---- The report ----

const container = (over = {}) => ({
  network: { in: 0, out: 0 }, networkInterval: { in: 5_000_000, out: 7_000_000 }, networkTotal: { in: 9e7, out: 1e8 },
  interval_ms: 3_600_000,
  disk: { databases: [{ network: 'main', bytes: 40e6, wal: 4e6 }], volume: { total: 100e9, used: 50e9, free: 50e9, percent: 50 } },
  memory: { rss: 200e6, limit: 512 * 2 ** 20, percent: 37 },
  ...over,
});

test('the report stays within Discord\'s limits, and mentions only on a problem', async () => {
  const n = await node();
  for (let i = 0; i < 25; i++) {
    const s = new Store();
    n.peers.add({ id: s.node.id, url: `https://peer${i}.example/meadow-peer`, source: 'chain' });
    n.peers.noteFail(s.node.id, 'x'.repeat(300));
    s.close();
  }
  const snap = await n.health.snapshot();
  const { payload } = buildPayload([snap, { ...snap, network: 'beta' }], container(), { mention: '<@&42>' });
  const size = payload.embeds.reduce((t, e) => t + e.title.length + e.description.length, 0);
  assert.ok(size <= 6000, `${size} characters`);
  assert.ok(payload.embeds.every((e) => e.description.length <= 4096));
  assert.match(payload.embeds[0].description, /and 15 more/);
  assert.equal(payload.content, undefined, 'all OK: no mention');

  const full = buildPayload([snap], container({ disk: { databases: [], volume: { total: 100, used: 95, free: 5, percent: 95 } } }), { mention: '<@&42>' });
  assert.equal(full.level, 'problem');
  assert.equal(full.payload.content, '<@&42>');
  assert.match(full.payload.embeds.at(-1).description, /95% full/);
  assert.deepEqual(containerIssues(container({ memory: { rss: 450, limit: 500, percent: 90 } })).map((i) => i.level), ['warning']);
  await n.done();
});

// ---- Configuration and posting ----

test('configuration: only a Discord webhook; interval and mode checked; never echoes the URL', () => {
  assert.equal(parseAlertConfig({}), null);
  assert.deepEqual(parseAlertConfig({ MEADOW_ALERT_WEBHOOK: HOOK }), { webhook: HOOK, intervalMs: 3_600_000, mode: 'report', mention: null });
  assert.equal(parseAlertConfig({ MEADOW_ALERT_WEBHOOK: HOOK.replace('discord.com', 'canary.discord.com'), MEADOW_ALERT_INTERVAL_MIN: '15', MEADOW_ALERT_MODE: 'problems' }).mode, 'problems');
  for (const env of [
    { MEADOW_ALERT_WEBHOOK: 'https://example.com/api/webhooks/1/x' },
    { MEADOW_ALERT_WEBHOOK: 'http://discord.com/api/webhooks/1/x' },
    { MEADOW_ALERT_WEBHOOK: 'https://discord.com/channels/1' },
    { MEADOW_ALERT_WEBHOOK: HOOK, MEADOW_ALERT_INTERVAL_MIN: '5' },
    { MEADOW_ALERT_WEBHOOK: HOOK, MEADOW_ALERT_MODE: 'loud' },
  ]) {
    assert.throws(() => parseAlertConfig(env), (err) => err instanceof AlertConfigError && !err.message.includes('secret-token'));
  }
});

test('posting: a 429 waits retry_after and tries once more; a 4xx is not retried; errors never name the URL', async () => {
  const calls = [];
  const answers = [new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 }), new Response(null, { status: 204 })];
  const waited = [];
  let res = await postWebhook(HOOK, { content: 'x' }, { fetch: async (u) => { calls.push(u); return answers.shift(); }, wait: async (ms) => waited.push(ms) });
  assert.deepEqual(res, { ok: true, status: 204 });
  assert.deepEqual(waited, [1500]);

  res = await postWebhook(HOOK, {}, { fetch: async () => new Response('{}', { status: 404 }) });
  assert.deepEqual(res, { ok: false, status: 404, error: 'Discord answered 404' });

  let n = 0;
  res = await postWebhook(HOOK, {}, { fetch: async () => { n++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  assert.equal(n, 2, 'a network error is tried once more');
  assert.equal(res.error, 'ENOTFOUND');
  assert.ok(!JSON.stringify(res).includes('secret-token'));

  res = await postWebhook(HOOK, {}, { fetch: async () => new Response(JSON.stringify({ retry_after: 600 }), { status: 429 }) });
  assert.match(res.error, /longer than a minute/);
});

test('problems mode posts the first check, trouble, its clearing, and a daily summary; report mode posts every check', async () => {
  let level = 'ok';
  let now = Date.UTC(2026, 9, 5, 10);
  const health = { snapshot: async () => ({
    network: 'main', at: now, node: 'n_' + 'a'.repeat(43), version: 't', protocol: 3, up_ms: 1, holds: { rooms: 0, agents: 0, events: 0 },
    self: { relay: { ok: true, ms: 1 }, peer: { ok: true, ms: 1 } }, accepted: { clients: 0, peers: 0 },
    discovery: { last_run: now, suppliers: 1, others: 0, found: 0, last_error: null, failures_in_a_row: 0 }, peers: [],
    traffic: { interval: { relay: { in: 0, out: 0 }, peer: { in: 0, out: 0 }, own: { in: 0, out: 0 } }, total: { relay: { in: 0, out: 0 }, peer: { in: 0, out: 0 }, own: { in: 0, out: 0 } }, interval_ms: 1 },
    issues: level === 'ok' ? [] : [{ level, text: 'something' }], level,
  }) };
  const posted = [];
  const a = new Alerts({
    config: { webhook: HOOK, intervalMs: 3_600_000, mode: 'problems', mention: null }, healths: [health], now: () => now,
    container: () => container(), readNet: () => null, log: quiet, post: async (p) => { posted.push(p); return { ok: true }; },
  });
  const step = async (l, ms = 3_600_000) => { level = l; now += ms; return (await a.check()).posted; };
  assert.equal(await step('ok', 0), true, 'the first check after start');
  assert.equal(await step('ok'), false);
  assert.equal(await step('warning'), true);
  assert.equal(await step('ok'), true, 'cleared');
  assert.match(posted.at(-1).content, /All clear again/);
  assert.equal(await step('ok'), false);
  assert.equal(await step('ok', 24 * 3_600_000), true, 'the daily summary');

  const log = lines();
  const b = new Alerts({
    config: { webhook: HOOK, intervalMs: 3_600_000, mode: 'report', mention: null }, healths: [health], now: () => now,
    container: () => container(), readNet: () => null, log, post: async () => ({ ok: false, error: 'Discord answered 500' }),
  });
  level = 'ok';
  assert.deepEqual(await b.check().then((r) => [r.level, r.posted]), ['ok', false], 'report mode tries every check');
  assert.deepEqual(log.out, ['alert webhook: could not post: Discord answered 500']);
});

// ---- Operator command ----

test('operator: peers reads the latest snapshot; alert-test posts it as a test report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meadow-alert-'));
  const path = join(dir, 'meadow-main.db');
  const store = new Store(path);
  const peers = new Peers([], { log: quiet });
  const other = new Store();
  peers.add({ id: other.node.id, url: 'https://them.example/meadow-peer', source: 'chain' });
  peers.penalize(other.node.id, 3, 'bad_report');
  const traffic = { relay: new Traffic(), peer: new Traffic(), own: new Traffic() };
  const health = new Health({ network: 'main', store, peers, discovery: null, traffic, ports: { relay: 1, peer: 1 }, version: 't' });
  await health.snapshot();

  const db = openDatabase(path);
  const out = operate(db, 'peers');
  assert.equal(out.peers[0].node, other.node.id);
  assert.deepEqual([out.peers[0].penalty, out.peers[0].last_penalty.reason], [3, 'bad_report']);

  await assert.rejects(alertTest(db, 'main', { env: {} }), /MEADOW_ALERT_WEBHOOK is not set/);
  let sent = null;
  const res = await alertTest(db, 'main', { env: { MEADOW_ALERT_WEBHOOK: HOOK }, dataDir: dir, post: async (p) => { sent = p; return { ok: true, status: 204 }; } });
  assert.deepEqual(res, { posted: true, status: 204 });
  assert.match(sent.content, /^Test report from the main node/);
  db.close();
  store.close();
  other.close();
});
