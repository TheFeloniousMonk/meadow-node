#!/usr/bin/env node
// Replication simulation (SPEC §17 q13, the 1,000-node review). Runs N nodes in one process: the
// real Store, Peers, Replicator, and Discovery, on a simulated network (calls go straight to the
// target node's peer API, with the same authentication) and a simulated clock. A seeded workload
// writes rooms and posts at random nodes, as clients would. Some nodes can be down. It counts every
// peer request and byte by path, full and incremental anti-entropy listings, pushes aimed at nodes
// that are down, what discovery would read from the chain API, and how each event reached each node
// (push or anti-entropy) and how long that took.
//
//   node backend/sim/simulate.js [--nodes 200] [--minutes 30] [--rooms 50] [--posts-per-min 20]
//                                [--down 0] [--fail 0.05] [--settle 5] [--flush-ms 1000] [--seed 1]
//                                [--record-bytes 35000] [--json]
//
// Not a test: it measures. Validation costs about half a millisecond per event per node, so
// 1,000 nodes with a few hundred events takes minutes.

import { parseArgs } from 'node:util';
import { Store } from '../src/store/store.js';
import { Peers, verifyPeer } from '../src/peer/peers.js';
import { Replicator } from '../src/peer/replicator.js';
import { Discovery } from '../src/peer/discovery.js';
import { peerRoutes } from '../src/peer/api.js';
import { RequestError } from '../src/api/sync.js';
import { toWire } from '../src/api/wire.js';
import { Builder } from '../../conformance/tools/builder.js';

const { values: o } = parseArgs({
  options: {
    nodes: { type: 'string', default: '200' },
    minutes: { type: 'string', default: '30' },
    rooms: { type: 'string', default: '50' },
    'posts-per-min': { type: 'string', default: '20' },
    down: { type: 'string', default: '0' },
    fail: { type: 'string', default: '0.05' },
    settle: { type: 'string', default: '5' },
    'flush-ms': { type: 'string', default: '1000' },
    fanout: { type: 'string', default: '3' },
    'ae-seconds': { type: 'string', default: '60' },
    seed: { type: 'string', default: '1' },
    'record-bytes': { type: 'string', default: '35000' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (o.help) {
  console.log(`Usage: node backend/sim/simulate.js [options]
  --nodes N           nodes in the network (default 200)
  --minutes M         simulated minutes (default 30)
  --rooms R           rooms written during the run (default 50)
  --posts-per-min P   posts per simulated minute, across the network (default 20)
  --down F            fraction of nodes down from the start, so never anyone's peer (default 0)
  --fail F            fraction of nodes that go down after discovery, at the first minute (default 0.05)
  --settle M          minutes with no new writes at the end, for anti-entropy to finish (default 5)
  --flush-ms T        push interval in simulated ms (default 1000; the node's is 250)
  --fanout K          push targets per new event (default 3, the node's)
  --ae-seconds A      anti-entropy interval in simulated seconds (default 60, the node's)
  --seed S            random seed (default 1)
  --record-bytes B    size of one supplier record from the chain API (default 35000, measured 23-47 KB)
  --json              print the result as JSON`);
  process.exit(0);
}
const N = Number(o.nodes);
const MINUTES = Number(o.minutes);
const ROOMS = Number(o.rooms);
const PPM = Number(o['posts-per-min']);
const DOWN = Number(o.down);
const FAIL = Number(o.fail);
const SETTLE = Number(o.settle);
const FLUSH_MS = Number(o['flush-ms']);
const FANOUT = Number(o.fanout);
const AE_MS = Number(o['ae-seconds']) * 1000;
const RECORD_BYTES = Number(o['record-bytes']);

// ---- Seeded randomness and a simulated clock, for the node code too ----
let seed = Number(o.seed) >>> 0 || 1;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const START = Date.now();
let clock = START;
Date.now = () => clock;
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const quiet = { log() {}, warn() {} };

// ---- Counters ----
const paths = new Map(); // path -> { calls, failed, reqBytes, resBytes }
const tally = (path, req, res, failed = false) => {
  const p = paths.get(path) ?? { calls: 0, failed: 0, reqBytes: 0, resBytes: 0 };
  p.calls++;
  if (failed) p.failed++;
  p.reqBytes += req;
  p.resBytes += res;
  paths.set(path, p);
};
const listings = { full: 0, incremental: 0 };
let pushesToDown = 0;
let lcdBytes = 0;
let discoveryRuns = 0;

// ---- Nodes ----
const host = (i) => `n${i}.sim`;
const nodes = [];
const byHost = new Map();

// What a node's peer port does with a request (createPeerServer, without HTTP).
function serve(node, path, text) {
  const route = node.routes[path];
  if (!route) return { status: 404, body: { error: { code: 'not_found' } } };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: 400, body: { error: { code: 'bad_json' } } };
  }
  let who = null;
  if (route.auth) {
    const auth = verifyPeer(body, node.peers);
    if (auth.error) return { status: auth.error === 'unknown_peer' ? 403 : 401, body: { error: { code: auth.error } } };
    node.peers.noteOk(auth.node);
    who = auth.node;
  }
  try {
    return { status: 200, body: route.handle(body, who) };
  } catch (err) {
    if (err instanceof RequestError) return { status: 400, body: { error: { code: err.code, message: err.message } } };
    throw err;
  }
}

// The simulated network, as seen from one node.
const fetchFrom = () => async (url, init = {}) => {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/meadow-peer/, '');
  const target = byHost.get(u.host);
  const req = Buffer.byteLength(init.body ?? '', 'utf8');
  if (path === '/v2/rooms' || path === '/v2/agents' || path === '/v2/reports') {
    const b = JSON.parse(init.body ?? '{}');
    if (!b.cursor && path === '/v2/rooms') listings[b.since ? 'incremental' : 'full']++;
  }
  if (!target || target.down) {
    tally(path, req, 0, true);
    if (path === '/v2/push') pushesToDown++;
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  }
  const { status, body } = serve(target, path, init.body ?? '{}');
  const text = toWire(body);
  tally(path, req, Buffer.byteLength(text, 'utf8'), status !== 200);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
};

// How each event reached each node.
const events = new Map(); // id -> { room, at, last, push, pull }
const failingSet = new Set(); // nodes that will fail: their arrivals don't count
for (let i = 0; i < N; i++) {
  const store = new Store();
  const peers = new Peers([], { log: quiet });
  // Started without timers: the loop below drives pushes and anti-entropy on the simulated clock.
  const replicator = new Replicator(store, peers, { fetch: fetchFrom(), flushMs: 0, antiEntropyMs: 0, fanout: FANOUT, log: quiet }).start();
  const node = { i, store, peers, replicator, routes: peerRoutes(store, peers, replicator), down: false };
  store.onStored((info) => {
    const e = events.get(info.id);
    if (!e || node.down || failingSet.has(node)) return;
    e.last = Math.max(e.last, clock);
    if (info.origin === 'pull') e.pull++;
    else if (info.origin) e.push++;
  });
  nodes.push(node);
  byHost.set(host(i), node);
}
const downCount = Math.round(N * DOWN);
for (const n of [...nodes].sort(() => Math.random() - 0.5).slice(0, downCount)) n.down = true;
// Nodes that fail after discovery stay in their peers' lists, as a node that went down would.
let live = nodes.filter((n) => !n.down);
const failCount = Math.round(N * FAIL);
const failing = [...live].sort(() => Math.random() - 0.5).slice(0, failCount);
for (const n of failing) failingSet.add(n);

// Discovery: every node reads the supplier list and says hello to every supplier, as at start.
const suppliers = nodes.map((n) => ({ operator: `pokt1sim${n.i}`, urls: [`http://${host(n.i)}`] }));
async function discoverAll() {
  for (const n of live) {
    const d = new Discovery(n.store, n.peers, {
      networks: ['main'], peerPath: '/meadow-peer', fetch: fetchFrom(), intervalMs: 0, log: quiet,
      listSuppliers: async () => {
        lcdBytes += suppliers.length * RECORD_BYTES;
        return suppliers;
      },
    });
    await d.run();
    discoveryRuns++;
  }
}

// ---- Workload ----
const rooms = []; // { b, home, posts }
function clientWrite(node, ev, room) {
  events.set(ev.id, { room, at: clock, last: clock, push: 0, pull: 0 });
  const r = node.store.ingest(ev);
  if (process.env.SIM_DEBUG && r.outcome !== 'accepted') console.log('write', ev.header.kind, r.outcome, r.reason ?? '', JSON.stringify(r.missing ?? []).slice(0, 80));
}
function newRoom(k) {
  const b = new Builder();
  const a = b.agent(`sim-${k}`);
  b.create('create', a, { type: 'public' });
  b.join('join', a);
  const home = pick(live);
  const r = { b, a, home, posts: 0 };
  for (const s of b.steps) clientWrite(home, s.event, b.room.id);
  rooms.push(r);
}
function post() {
  // A client writes through a live node it has synced with, so the node holds the room's latest
  // event (the new post's parent): mostly the room's usual node.
  const latest = (r) => r.b.steps.at(-1).event.id;
  const holders = (r) => live.filter((n) => n.store.room(r.b.room.id)?.has(latest(r)));
  const r = pick(rooms.filter((x) => holders(x).length));
  if (!r) return;
  const h = holders(r);
  const node = !r.home.down && Math.random() < 0.7 && h.includes(r.home) ? r.home : pick(h);
  r.b.post(`p${r.posts++}`, r.a, `hello ${r.posts}`);
  clientWrite(node, r.b.steps.at(-1).event, r.b.room.id);
}

// ---- Run ----
const t0 = performance.now();
await discoverAll();
const discoveryStart = { lcd: lcdBytes, hellos: paths.get('/v2/hello')?.calls ?? 0, nodes: live.length };
const total = MINUTES * 60_000;
const roomsEvery = Math.max(1, Math.floor((total / 2) / Math.max(ROOMS, 1))); // rooms in the first half
let postDebt = 0;
let roomsMade = 0;
for (let t = 0; t < total; t += FLUSH_MS) {
  clock = START + t;
  if (t === 60_000) {
    for (const n of failing) n.down = true;
    live = nodes.filter((n) => !n.down);
  }
  while (roomsMade < ROOMS && roomsMade * roomsEvery <= t) newRoom(roomsMade++);
  postDebt += (PPM * FLUSH_MS) / 60_000;
  while (postDebt >= 1) {
    post();
    postDebt--;
  }
  for (const n of live) await n.replicator.flushAll(clock);
  if (t % AE_MS === 0 && t > 0) for (const n of live) await n.replicator.antiEntropyAll();
}
// Minutes with no new writes, so anti-entropy can finish what push missed.
for (let t = FLUSH_MS; t <= SETTLE * 60_000; t += FLUSH_MS) {
  clock = START + total + t;
  for (const n of live) await n.replicator.flushAll(clock);
  if (t % AE_MS === 0) for (const n of live) await n.replicator.antiEntropyAll();
}
const wall = (performance.now() - t0) / 1000;

// ---- Results ----
const L = live.length;
const ev = [...events.values()];
// Complete: every live node holds it now (checked in each store).
const ids = [...events.keys()];
const complete = ids.filter((id) => live.every((n) => n.store.room(events.get(id).room)?.has(id))).map((id) => events.get(id));
const times = complete.map((e) => e.last - e.at).sort((a, b) => a - b);
const q = (p) => (times.length ? times[Math.min(times.length - 1, Math.floor(p * times.length))] / 1000 : null);
const via = ev.reduce((s, e) => ({ push: s.push + e.push, pull: s.pull + e.pull }), { push: 0, pull: 0 });
const perNodeMin = (x) => x / L / (MINUTES + SETTLE);
const byPath = Object.fromEntries([...paths].sort().map(([p, v]) => [p, {
  calls: v.calls, failed: v.failed, calls_per_node_per_min: +perNodeMin(v.calls).toFixed(2),
  kb_per_node_per_min: +(perNodeMin(v.reqBytes + v.resBytes) / 1024).toFixed(1),
}]));
const result = {
  config: { nodes: N, down: downCount, failed: failCount, fanout: FANOUT, ae_seconds: AE_MS / 1000, minutes: MINUTES, settle: SETTLE, rooms: ROOMS, posts_per_min: PPM, flush_ms: FLUSH_MS, seed: Number(o.seed) },
  events: { written: ev.length, reached_every_live_node: complete.length, missing_somewhere: ev.length - complete.length },
  delivery_seconds: { p50: q(0.5), p95: q(0.95), max: q(1) },
  arrivals: { by_push: via.push, by_pull: via.pull, pull_share: +(via.pull / Math.max(1, via.push + via.pull)).toFixed(3) },
  anti_entropy_listings: { ...listings, full_share: +(listings.full / Math.max(1, listings.full + listings.incremental)).toFixed(3) },
  pushes_aimed_at_down_nodes: pushesToDown,
  discovery: {
    hellos_per_run_per_node: +(discoveryStart.hellos / discoveryStart.nodes).toFixed(0),
    chain_api_mb_per_run_per_node: +(discoveryStart.lcd / discoveryStart.nodes / 1e6).toFixed(1),
    chain_api_gb_per_day_network: +(discoveryStart.lcd * 48 / 1e9).toFixed(1),
  },
  peer_api: byPath,
  wall_seconds: +wall.toFixed(1),
};
if (process.env.SIM_DEBUG) {
  for (const id of ids) {
    const e = events.get(id);
    const holders = live.filter((n) => n.store.room(e.room)?.has(id)).length;
    if (holders === live.length) continue;
    const outcome = live.map((n) => n.store.room(e.room)?.outcome?.(id)?.outcome ?? '-');
    console.log('missing', id.slice(0, 10), 'room', e.room.slice(0, 10), 'holders', holders, '/', live.length, 'written at', (e.at - START) / 1000, 's', [...new Set(outcome)].join(','));
  }
}
if (o.json) console.log(JSON.stringify(result, null, 2));
else {
  const r = result;
  console.log(`${N} nodes (${downCount} down, ${failCount} failing at minute 1), ${MINUTES} min + ${SETTLE} min settling, ${ROOMS} rooms, ${PPM} posts/min, push every ${FLUSH_MS} ms, fanout ${FANOUT}, anti-entropy every ${AE_MS / 1000} s, seed ${o.seed}; ${r.wall_seconds} s`);
  console.log(`events: ${r.events.written} written, ${r.events.reached_every_live_node} reached every live node, ${r.events.missing_somewhere} missing somewhere`);
  console.log(`delivery to every live node: p50 ${r.delivery_seconds.p50} s, p95 ${r.delivery_seconds.p95} s, max ${r.delivery_seconds.max} s`);
  console.log(`arrivals at other nodes: ${r.arrivals.by_push} by push, ${r.arrivals.by_pull} by pull (missing history or anti-entropy; ${(r.arrivals.pull_share * 100).toFixed(1)}%)`);
  console.log(`anti-entropy room listings: ${r.anti_entropy_listings.full} full, ${r.anti_entropy_listings.incremental} incremental (${(r.anti_entropy_listings.full_share * 100).toFixed(1)}% full)`);
  console.log(`pushes aimed at down nodes: ${r.pushes_aimed_at_down_nodes}`);
  console.log(`discovery per run: ${r.discovery.hellos_per_run_per_node} hellos and ${r.discovery.chain_api_mb_per_run_per_node} MB from the chain API per node; ${r.discovery.chain_api_gb_per_day_network} GB/day across the network at one run per 30 min`);
  console.log('peer API, per node per minute:');
  for (const [p, v] of Object.entries(r.peer_api)) console.log(`  ${p.padEnd(13)} ${String(v.calls_per_node_per_min).padStart(7)} calls  ${String(v.kb_per_node_per_min).padStart(8)} KB  (${v.failed} failed of ${v.calls})`);
}
process.exit(0);
