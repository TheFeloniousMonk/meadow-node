// Peer discovery from the chain (SPEC §11.1). The suppliers staked for the
// Meadow service publish their public endpoint URLs on-chain. Each supplier's
// node answers at <endpoint origin><peer path>, where the supplier's Caddy
// routes the peer path to the node's peer port. Asking that URL who is there
// (/v2/hello) yields the node key; TLS on the supplier's own registered
// hostname vouches for it. So only nodes behind staked suppliers become peers,
// with no signed announcements.
//
// Runs read only what changed on the chain since the last run, with a complete
// listing every few hours (§17 q13 t). A hostname is asked /v2/hello when it is
// new, when it did not answer last time, and otherwise once a day, a few at a time.

import { REPLY_LIMITS, readJson } from './read.js';
import { shortId } from './peers.js';

export const PEER_PATH = '/meadow-peer';
// Early discovery (§11.1): at most once in this long, on a signed request from an unknown node.
export const EARLY_MIN_MS = 5 * 60 * 1000;
// A complete supplier listing at least this often; changes only in between.
export const FULL_LISTING_MS = 6 * 60 * 60 * 1000;
// A hostname that answered is asked again after this long.
export const HELLO_RECHECK_MS = 24 * 60 * 60 * 1000;
// Hellos in flight at once.
export const HELLO_CONCURRENCY = 8;

export class Discovery {
  #store;
  #peers;
  #opts;
  #timer = null;
  #running = null;
  #earlyAt = 0;
  #suppliers = new Map(); // "<network> <operator>" -> [origin]
  #listed = new Map(); // network -> { height, fullAt } after an incremental-capable listing
  #hellos = new Map(); // origin -> { node, ok, at }
  // The last runs, for the health report (§9.6): when, suppliers listed, nodes found, and failures in a row.
  status = { lastRun: null, suppliers: null, others: null, found: null, lastError: null, failuresInARow: 0 };

  // opts.listSuppliers(network, { since }) -> { suppliers: [{ operator, urls }], removed, height, full, source, fallback? },
  // or a plain array of suppliers, taken as a complete listing.
  constructor(store, peers, opts) {
    this.#store = store;
    this.#peers = peers;
    this.#opts = {
      networks: [], peerPath: PEER_PATH, intervalMs: 30 * 60_000, timeoutMs: 10_000, fetch: globalThis.fetch, log: console,
      fullEveryMs: FULL_LISTING_MS, recheckMs: HELLO_RECHECK_MS, hellos: HELLO_CONCURRENCY, ...opts,
    };
  }

  start() {
    if (!this.#opts.networks.length) return this;
    const tick = () => this.#runOnce();
    tick();
    if (this.#opts.intervalMs > 0) this.#timer = setInterval(tick, this.#opts.intervalMs);
    return this;
  }

  // One run at a time; a failure is kept in the status and logged.
  #runOnce() {
    if (this.#running) return this.#running;
    this.#running = this.run().catch((err) => {
      this.status.lastError = { text: err.message, at: Date.now() };
      this.status.failuresInARow++;
      this.#opts.log.warn?.(`discovery: ${err.message}`);
    }).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  // A correctly signed request came from a node this one doesn't know (§11.1): look at the chain
  // again now rather than at the next interval, at most once every 5 minutes. A signature alone never
  // makes a peer: the run checks the chain and asks /v2/hello as usual. Returns whether it ran.
  nudge(nodeId, now = Date.now()) {
    if (!this.#opts.networks.length || this.#running || now - this.#earlyAt < EARLY_MIN_MS) return false;
    this.#earlyAt = now;
    this.#opts.log.log?.(`discovery: running early: a signed request from unknown node ${shortId(nodeId)}`);
    this.#runOnce();
    return true;
  }

  stop() {
    clearInterval(this.#timer);
  }

  async #list(network, now) {
    const prev = this.#listed.get(network);
    const since = prev && now - prev.fullAt < this.#opts.fullEveryMs ? prev.height : null;
    let r = await this.#opts.listSuppliers(network, { since });
    if (Array.isArray(r)) r = { suppliers: r, removed: [], height: null, full: true };
    if (r.fallback) this.#opts.log.warn?.(`discovery: indexer unavailable (${r.fallback}); read the chain API instead`);
    const key = (op) => `${network} ${op}`;
    if (r.full) for (const k of this.#suppliers.keys()) if (k.startsWith(`${network} `)) this.#suppliers.delete(k);
    for (const op of r.removed ?? []) this.#suppliers.delete(key(op));
    for (const s of r.suppliers) {
      const origins = new Set();
      for (const u of s.urls) {
        try {
          const url = new URL(u);
          if (url.protocol === 'https:' || url.protocol === 'http:') origins.add(url.origin);
        } catch { /* not a URL: skip */ }
      }
      this.#suppliers.set(key(s.operator), [...origins]);
    }
    // A listing without a height (the chain API) leaves the next run complete again.
    if (Number.isSafeInteger(r.height)) this.#listed.set(network, { height: r.height, fullAt: r.full ? now : prev?.fullAt ?? 0 });
    else this.#listed.delete(network);
  }

  async #hello(origin, now) {
    let entry = { node: null, ok: false, at: now };
    try {
      const res = await this.#opts.fetch(origin + this.#opts.peerPath + '/v2/hello', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
      });
      const hello = await readJson(res, REPLY_LIMITS.hello);
      if (res.ok && typeof hello?.node === 'string') entry = { node: hello.node, ok: true, at: now };
    } catch { /* no Meadow node there, or not reachable */ }
    this.#hellos.set(origin, entry);
  }

  // One pass: returns the peers found. Chain-discovered peers whose supplier is
  // no longer listed, or whose hostname stopped answering, are dropped;
  // configured ones stay.
  async run() {
    const now = Date.now();
    for (const network of this.#opts.networks) await this.#list(network, now);
    const origins = new Set([...this.#suppliers.values()].flat());
    for (const o of this.#hellos.keys()) if (!origins.has(o)) this.#hellos.delete(o);
    const due = [...origins].filter((o) => {
      const h = this.#hellos.get(o);
      return !h || !h.ok || now - h.at >= this.#opts.recheckMs;
    });
    for (let i = 0; i < due.length;) {
      await Promise.all(due.slice(i, i += this.#opts.hellos).map((o) => this.#hello(o, now)));
    }

    const found = new Map();
    let self = false;
    for (const o of origins) {
      const h = this.#hellos.get(o);
      if (!h?.ok) continue;
      if (h.node === this.#store.node.id) self = true;
      else found.set(h.node, o + this.#opts.peerPath);
    }
    const log = (text) => this.#opts.log.log?.(`discovery: ${text}`);
    for (const [id, url] of found) {
      const known = this.#peers.get(id);
      if (!known) log(`peer ${shortId(id)} added at ${url}`);
      else if (known.url !== url) log(`peer ${shortId(id)} moved from ${known.url} to ${url}`);
      this.#peers.add({ id, url, source: 'chain' });
    }
    for (const p of this.#peers.all()) {
      if (p.source === 'chain' && !found.has(p.id)) {
        log(`peer ${shortId(p.id)} dropped: ${p.url} no longer answers or is no longer staked`);
        this.#peers.remove(p.id);
      }
    }
    // Our own supplier is listed too; it answers with this node's ID and is not a peer.
    const suppliers = this.#suppliers.size;
    this.status = { lastRun: now, suppliers, others: suppliers - (self ? 1 : 0), found: found.size, hellos: due.length, lastError: null, failuresInARow: 0 };
    return [...found].map(([id, url]) => ({ id, url }));
  }
}
