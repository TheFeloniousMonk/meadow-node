// Peer discovery from the chain (SPEC §11.1). The suppliers staked for the
// Meadow service publish their public endpoint URLs on-chain. Each supplier's
// node answers at <endpoint origin><peer path>, where the supplier's Caddy
// routes the peer path to the node's peer port. Asking that URL who is there
// (/v2/hello) yields the node key; TLS on the supplier's own registered
// hostname vouches for it. So only nodes behind staked suppliers become peers,
// with no signed announcements.

import { REPLY_LIMITS, readJson } from './read.js';
import { shortId } from './peers.js';

export const PEER_PATH = '/meadow-peer';
// Early discovery (§11.1): at most once in this long, on a signed request from an unknown node.
export const EARLY_MIN_MS = 5 * 60 * 1000;

export class Discovery {
  #store;
  #peers;
  #opts;
  #timer = null;
  #running = null;
  #earlyAt = 0;
  // The last runs, for the health report (§9.6): when, suppliers listed, nodes found, and failures in a row.
  status = { lastRun: null, suppliers: null, others: null, found: null, lastError: null, failuresInARow: 0 };

  // opts.listSuppliers(network) -> [{ operator, urls: [endpoint URL, …] }]
  constructor(store, peers, opts) {
    this.#store = store;
    this.#peers = peers;
    this.#opts = { networks: [], peerPath: PEER_PATH, intervalMs: 30 * 60_000, timeoutMs: 10_000, fetch: globalThis.fetch, log: console, ...opts };
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

  // One pass: returns the peers found. Chain-discovered peers that no longer
  // answer are dropped; configured ones stay.
  async run() {
    const origins = new Set();
    let suppliers = 0;
    for (const network of this.#opts.networks) {
      for (const s of await this.#opts.listSuppliers(network)) {
        suppliers++;
        for (const u of s.urls) {
          try {
            const url = new URL(u);
            if (url.protocol === 'https:' || url.protocol === 'http:') origins.add(url.origin);
          } catch { /* not a URL: skip */ }
        }
      }
    }
    const found = new Map();
    let self = false;
    await Promise.all([...origins].map(async (origin) => {
      const url = origin + this.#opts.peerPath;
      try {
        const res = await this.#opts.fetch(url + '/v2/hello', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          signal: AbortSignal.timeout(this.#opts.timeoutMs),
        });
        const hello = await readJson(res, REPLY_LIMITS.hello);
        if (res.ok && hello.node === this.#store.node.id) self = true;
        else if (res.ok && typeof hello.node === 'string') found.set(hello.node, url);
      } catch { /* no Meadow node there, or not reachable */ }
    }));
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
    this.status = { lastRun: Date.now(), suppliers, others: suppliers - (self ? 1 : 0), found: found.size, lastError: null, failuresInARow: 0 };
    return [...found].map(([id, url]) => ({ id, url }));
  }
}
