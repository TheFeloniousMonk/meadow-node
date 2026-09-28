// Replication between nodes (SPEC §11.3), directly over each supplier's
// public hostname: gossip push to a few peers, pulls of history a push
// depended on, and periodic anti-entropy. Every event received is validated
// like a client's (§11.4). Peer calls are free, so pacing can be quick.

import { signPeer } from './peers.js';
import { ingestFromPeer, isAgentEvent, PEER_LIMITS } from './api.js';
import { verifyReport } from '../proto/report.js';

const QUEUE_CAP = 10_000;
const HOLD_CAP = 5_000;
const HOLD_MS = 60 * 60 * 1000;
const MAX_PULL_PAGES = 50;

export class Replicator {
  #store;
  #peers;
  #opts;
  #queues = new Map(); // peer ID -> [{ room, id } | { agent, id } | { report }]
  #held = new Map(); // event ID -> { ev, at }: waiting on history no peer has supplied yet
  #inflight = new Set();
  #busy = new Set();
  #timers = [];
  #unsubscribe = null;

  constructor(store, peers, opts = {}) {
    this.#store = store;
    this.#peers = peers;
    this.#opts = {
      fanout: 3, flushMs: 250, antiEntropyMs: 60_000, antiEntropyPeers: 2, timeoutMs: 10_000,
      newRoomsPerRound: 20, newAgentsPerRound: 50, fetch: globalThis.fetch, log: console, ...opts,
    };
  }

  start() {
    this.#unsubscribe = this.#store.onStored((info) => this.#enqueue(info));
    const { flushMs, antiEntropyMs } = this.#opts;
    if (flushMs > 0) this.#timers.push(setInterval(() => this.#track(this.flushAll()), flushMs));
    if (antiEntropyMs > 0) {
      this.#track(this.antiEntropyAll());
      this.#timers.push(setInterval(() => this.#track(this.antiEntropyAll()), antiEntropyMs));
    }
    return this;
  }

  stop() {
    this.#unsubscribe?.();
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
  }

  async idle() {
    while (this.#inflight.size) await Promise.allSettled([...this.#inflight]);
  }

  get heldCount() {
    return this.#held.size;
  }

  #track(promise) {
    const p = promise.catch((err) => this.#opts.log.warn?.(`replication: ${err.message}`)).finally(() => this.#inflight.delete(p));
    this.#inflight.add(p);
    return p;
  }

  #shuffled(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Gossip: each newly stored item goes to `fanout` random peers other than
  // the one it came from; they do the same, and dedup ends the spread.
  // Anti-entropy pulls are not passed on: every node runs its own.
  #enqueue(info) {
    if (info.origin === 'pull') return;
    const targets = this.#shuffled(this.#peers.active().filter((p) => p.id !== info.origin)).slice(0, this.#opts.fanout);
    for (const peer of targets) {
      const q = this.#queues.get(peer.id) ?? [];
      if (q.length >= QUEUE_CAP) q.shift(); // anti-entropy catches up with what we drop
      q.push(info);
      this.#queues.set(peer.id, q);
    }
  }

  async #call(peer, path, fields) {
    const res = await this.#opts.fetch(peer.url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signPeer(this.#store.node, fields)),
      signal: AbortSignal.timeout(this.#opts.timeoutMs),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${peer.id} ${path}: ${res.status} ${body?.error?.code ?? ''}`);
    return body;
  }

  // One peer failing (down, or not yet aware of us) doesn't hold up the
  // others; its queue is kept for the next flush.
  async flushAll() {
    await Promise.all(this.#peers.active().map((p) => this.flush(p).catch((err) => this.#opts.log.warn?.(`push to ${p.id}: ${err.message}`))));
  }

  // Push one peer's queue in order. A batch ends before a second new room or
  // agent, which the receiver would refuse (§11.2), so nothing travels ahead
  // of the room or chain it belongs to.
  async flush(peer) {
    const q = this.#queues.get(peer.id);
    while (q?.length) {
      const batch = [];
      const roots = { room: 0, agent: 0 };
      for (const item of q) {
        if (batch.length >= PEER_LIMITS.push) break;
        const payload = item.report ? { report: this.#store.report(item.report) }
          : { event: item.agent ? this.#store.agentEvent(item.id) : this.#store.forPeer(item.room, item.id) };
        const kind = payload.event?.header.kind;
        const root = kind === 'room.create' ? 'room' : kind === 'agent.register' ? 'agent' : null;
        if (root && roots[root] >= 1) break;
        if (root) roots[root]++;
        batch.push(payload);
      }
      const taken = q.splice(0, batch.length);
      const events = batch.filter((b) => b.event).map((b) => b.event);
      const reports = batch.filter((b) => b.report).map((b) => b.report);
      if (!events.length && !reports.length) continue;
      try {
        await this.#call(peer, '/v2/push', { events, reports });
      } catch (err) {
        q.unshift(...taken);
        throw err;
      }
    }
  }

  // A push left events waiting on history: pull it from the peer that sent
  // them (it has it), and hold whatever still cannot be placed.
  resolvePending(peerId, pending) {
    const peer = this.#peers.get(peerId);
    this.hold(pending);
    if (peer) this.#track(this.#resolveFrom(peer, pending));
  }

  async #resolveFrom(peer, pending) {
    const agents = new Set(pending.filter(isAgentEvent).map((ev) => ev.header.author));
    const rooms = new Set(pending.filter((ev) => !isAgentEvent(ev)).map((ev) => ev.header.room));
    for (const agent of agents) await this.pullChain(peer, agent);
    for (const room of rooms) await this.pullRoom(peer, room);
    this.#retryHeldNow();
  }

  hold(events) {
    const now = Date.now();
    for (const ev of events) {
      if (this.#held.size >= HOLD_CAP) this.#held.delete(this.#held.keys().next().value);
      this.#held.set(ev.id, { ev, at: now });
    }
  }

  #retryHeldNow(now = Date.now()) {
    for (const [id, h] of this.#held) if (now - h.at > HOLD_MS) this.#held.delete(id);
    if (!this.#held.size) return;
    const held = [...this.#held.values()].map((h) => h.ev);
    const res = ingestFromPeer(this.#store, held);
    const still = new Set(res.pending.map((ev) => ev.id));
    for (const ev of held) if (!still.has(ev.id)) this.#held.delete(ev.id);
  }

  async pullChain(peer, agent) {
    const res = await this.#call(peer, '/v2/chain', { agent });
    ingestFromPeer(this.#store, res.events, { onInvalid: () => this.#peers.penalize(peer.id) });
  }

  // Pull a room's events we lack, page by page, from our heads forward.
  async pullRoom(peer, roomId) {
    const key = `${peer.id}|${roomId}`;
    if (this.#busy.has(key)) return;
    this.#busy.add(key);
    try {
      for (let pageNo = 0; pageNo < MAX_PULL_PAGES; pageNo++) {
        const heads = this.#store.room(roomId)?.heads() ?? [];
        const res = await this.#call(peer, '/v2/since', { room: roomId, heads });
        const got = ingestFromPeer(this.#store, res.events, { onInvalid: () => this.#peers.penalize(peer.id) });
        // Bindings wait on agent chains (§6.6 step 3): fetch those, then retry.
        if (got.pending.length) {
          for (const agent of new Set(got.pending.map((ev) => ev.header.author))) await this.pullChain(peer, agent);
          ingestFromPeer(this.#store, got.pending);
        }
        if (!res.more || got.accepted + got.rejected === 0) break;
      }
    } finally {
      this.#busy.delete(key);
    }
  }

  // Each round compares with a few random peers.
  async antiEntropyAll() {
    const peers = this.#shuffled(this.#peers.active()).slice(0, this.#opts.antiEntropyPeers);
    for (const p of peers) {
      await this.antiEntropy(p).catch((err) => this.#opts.log.warn?.(`anti-entropy with ${p.id}: ${err.message}`));
    }
    this.#retryHeldNow();
  }

  // Compare rooms, agents, and reports with one peer and pull what differs.
  // Rooms quiet past our expiry window are skipped so expired rooms stay
  // expired (§10.2); new rooms and agents are adopted a limited number per
  // round, so a peer listing junk cannot flood this node.
  async antiEntropy(peer, now = Date.now()) {
    const quietLimit = now - this.#store.retention.roomMs;
    let newRooms = 0;
    for (let cursor = ''; ;) {
      const res = await this.#call(peer, '/v2/rooms', { cursor });
      for (const r of res.rooms) {
        if (this.#store.expired(r.room) || r.active_at < quietLimit) continue;
        const local = this.#store.room(r.room);
        if (!local) {
          if (newRooms >= this.#opts.newRoomsPerRound) continue;
          newRooms++;
        } else if (!r.heads.some((h) => !local.has(h))) continue;
        await this.pullRoom(peer, r.room);
      }
      if (!res.cursor) break;
      cursor = res.cursor;
    }
    let newAgents = 0;
    for (let cursor = ''; ;) {
      const res = await this.#call(peer, '/v2/agents', { cursor });
      for (const a of res.agents) {
        if (this.#store.agentEvent(a.head)) continue;
        if (!this.#store.agent(a.agent)) {
          if (newAgents >= this.#opts.newAgentsPerRound) continue;
          newAgents++;
        }
        await this.pullChain(peer, a.agent);
      }
      if (!res.cursor) break;
      cursor = res.cursor;
    }
    for (let cursor = ''; ;) {
      const res = await this.#call(peer, '/v2/reports', { cursor });
      for (const r of res.reports) {
        if (this.#store.report(r.id)) continue;
        const v = verifyReport(r.report);
        if (v.id) this.#store.addReport(v.id, r.report, null, now, 'pull');
        else this.#peers.penalize(peer.id);
      }
      if (!res.cursor) break;
      cursor = res.cursor;
    }
  }
}
