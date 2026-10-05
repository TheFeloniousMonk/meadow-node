// Replication between nodes (SPEC §11.3), directly over each supplier's
// public hostname: gossip push to a few peers, pulls of history a push
// depended on, and periodic anti-entropy. Every event received is validated
// like a client's (§11.4). Peer calls are free, so pacing can be quick.

import { REPLY_LIMITS, ReplyTooLarge, readJson } from './read.js';
import { signPeer } from './peers.js';
import { ingestFromPeer, isAgentEvent, PEER_LIMITS } from './api.js';
import { verifyReport } from '../proto/report.js';

const QUEUE_CAP = 10_000;
const HOLD_CAP = 5_000;
const HOLD_MS = 60 * 60 * 1000;
const MAX_PULL_PAGES = 50;
// Push pacing (§11.3): after a failed push, wait 1 s, doubling per failure, at most 5 minutes.
export const PUSH_BACKOFF_MS = 1000;
export const PUSH_BACKOFF_MAX_MS = 5 * 60 * 1000;
// Incremental anti-entropy (§11.3): a full comparison with each peer at least this often.
export const FULL_ROUND_MS = 60 * 60 * 1000;

export class Replicator {
  #store;
  #peers;
  #opts;
  #queues = new Map(); // peer ID -> [{ room, id } | { agent, id } | { report }]
  #held = new Map(); // event ID -> { ev, at, from }: waiting on history no peer has supplied yet
  #inflight = new Set();
  #busy = new Set();
  #pushing = new Set(); // peers with a push in flight: one at a time, in order
  #backoff = new Map(); // peer ID -> { failures, until } after failed pushes
  #rounds = new Map(); // peer ID -> { marks: { rooms, agents, reports }, fullAt } (incremental anti-entropy)
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

  // Every call's outcome is noted on the peer, for the health report (§9.6).
  async #call(peer, path, fields) {
    try {
      const res = await this.#opts.fetch(peer.url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signPeer(this.#store.node, fields)),
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
      });
      let body;
      try {
        body = await readJson(res, REPLY_LIMITS.peer);
      } catch (err) {
        // A reply past the limit is a failed call, scored as for a malformed event (§11.2).
        if (err instanceof ReplyTooLarge) this.#peers.penalize(peer.id, 1, 'reply_too_large');
        throw err;
      }
      if (!res.ok) throw new Error(`${peer.id} ${path}: ${res.status} ${body?.error?.code ?? ''}`);
      this.#peers.noteOk(peer.id);
      this.#pushRecovered(peer.id);
      return body;
    } catch (err) {
      this.#peers.noteFail(peer.id, `${path}: ${err.message}`);
      throw err;
    }
  }

  // One peer failing (down, or not yet aware of us) doesn't hold up the
  // others; its queue is kept for the next flush. A peer with a push in
  // flight, or waiting after failures, is skipped this time (§11.3).
  async flushAll(now = Date.now()) {
    await Promise.all(this.#peers.active().map((p) => {
      if (this.#pushing.has(p.id) || (this.#backoff.get(p.id)?.until ?? 0) > now || !this.#queues.get(p.id)?.length) return null;
      return this.flush(p).catch(() => {});
    }));
  }

  #pushFailed(peerId, err, now = Date.now()) {
    const b = this.#backoff.get(peerId) ?? { failures: 0, until: 0 };
    b.failures++;
    b.until = now + Math.min(PUSH_BACKOFF_MS * 2 ** (b.failures - 1), PUSH_BACKOFF_MAX_MS);
    this.#backoff.set(peerId, b);
    if (b.failures === 1) this.#opts.log.warn?.(`push to ${peerId}: failing (${err.message}); retrying with backoff`);
  }

  // Any successful call to a peer ends its push backoff.
  #pushRecovered(peerId) {
    const b = this.#backoff.get(peerId);
    if (!b) return;
    this.#backoff.delete(peerId);
    if (b.failures > 1) this.#opts.log.log?.(`push to ${peerId}: recovered after ${b.failures} failed attempts`);
  }

  // Push one peer's queue in order, one push at a time. A batch ends before a
  // second new room or agent, which the receiver would refuse (§11.2), so
  // nothing travels ahead of the room or chain it belongs to.
  async flush(peer) {
    if (this.#pushing.has(peer.id)) return;
    this.#pushing.add(peer.id);
    try {
      await this.#flush(peer);
    } catch (err) {
      this.#pushFailed(peer.id, err);
      throw err;
    } finally {
      this.#pushing.delete(peer.id);
    }
  }

  async #flush(peer) {
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
    this.hold(pending, peerId);
    if (peer) this.#track(this.#resolveFrom(peer, pending));
  }

  async #resolveFrom(peer, pending) {
    const agents = new Set(pending.filter(isAgentEvent).map((ev) => ev.header.author));
    const rooms = new Set(pending.filter((ev) => !isAgentEvent(ev)).map((ev) => ev.header.room));
    for (const agent of agents) await this.pullChain(peer, agent);
    for (const room of rooms) await this.pullRoom(peer, room);
    this.#retryHeldNow();
  }

  hold(events, from = null) {
    const now = Date.now();
    for (const ev of events) {
      if (this.#held.size >= HOLD_CAP) this.#held.delete(this.#held.keys().next().value);
      this.#held.set(ev.id, { ev, at: now, from });
    }
  }

  #retryHeldNow(now = Date.now()) {
    for (const [id, h] of this.#held) if (now - h.at > HOLD_MS) this.#held.delete(id);
    if (!this.#held.size) return;
    // Grouped by the peer each came from, so the events are recorded as its.
    const byPeer = new Map();
    for (const h of this.#held.values()) byPeer.set(h.from, [...(byPeer.get(h.from) ?? []), h.ev]);
    for (const [from, held] of byPeer) {
      const res = ingestFromPeer(this.#store, held, { from });
      const still = new Set(res.pending.map((ev) => ev.id));
      for (const ev of held) if (!still.has(ev.id)) this.#held.delete(ev.id);
    }
  }

  // An agent's chain, page by page, oldest first (§11.2), from this node's own
  // head of it: only the tail is sent. From the start when the peer says our
  // head is not on its chain (a fork), or, a node before 0.6.0, sends nothing.
  async pullChain(peer, agent) {
    const own = this.#store.agent(agent)?.head;
    if (own && await this.#pullChainFrom(peer, agent, own)) return;
    await this.#pullChainFrom(peer, agent, undefined);
  }

  // false when the pull should start over from the beginning.
  async #pullChainFrom(peer, agent, start) {
    let after = start;
    for (let page = 0; page < 100; page++) {
      const res = await this.#call(peer, '/v2/chain', { agent, ...(after && { after }) });
      const events = Array.isArray(res.events) ? res.events : [];
      if (page === 0 && start && (res.after_unknown === true || (res.after_unknown === undefined && !events.length))) return false;
      ingestFromPeer(this.#store, events, { from: peer.id, onInvalid: (reason) => this.#peers.penalize(peer.id, 1, reason) });
      // A page that does not move past the last one ends the pull, whatever `more` says.
      if (!res.more || !events.length || events.at(-1).id === after) return true;
      after = events.at(-1).id;
    }
    return true;
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
        const got = ingestFromPeer(this.#store, res.events, { from: peer.id, onInvalid: (reason) => this.#peers.penalize(peer.id, 1, reason) });
        // Bindings wait on agent chains (§6.6 step 3): fetch those, then retry.
        if (got.pending.length) {
          for (const agent of new Set(got.pending.map((ev) => ev.header.author))) await this.pullChain(peer, agent);
          ingestFromPeer(this.#store, got.pending, { from: peer.id });
        }
        if (!res.more || got.accepted + got.rejected === 0) break;
      }
    } finally {
      this.#busy.delete(key);
    }
  }

  // Content repair (§11.3): ask a peer for content this node holds events
  // without. Content is checked against each event's signed hash; a peer that
  // sends the wrong bytes is scored down (§11.4).
  async repairContent(peer, now = Date.now()) {
    const ids = this.#store.contentGaps(PEER_LIMITS.content, now);
    if (!ids.length) return 0;
    const res = await this.#call(peer, '/v2/content', { ids });
    let filled = 0;
    const done = new Set();
    for (const [id, content] of Object.entries(res.content ?? {})) {
      if (!ids.includes(id)) continue;
      const r = this.#store.repairContent(id, content);
      if (r === 'filled') {
        filled++;
        done.add(id);
      } else if (r === 'mismatch') this.#peers.penalize(peer.id, 1, 'content_mismatch');
    }
    // The rest wait longer before they are asked for again (§11.3); `more` were not looked at.
    const more = new Set(Array.isArray(res.more) ? res.more : []);
    this.#store.gapsAsked(ids.filter((id) => !done.has(id) && !more.has(id)), now);
    return filled;
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
  // round, so a peer listing junk cannot flood this node. Listings are
  // incremental from the peer's last marks (§11.3): a listing's new mark is
  // kept only when that listing was taken in full this round, and a full
  // comparison runs first with each peer, after an answer without a mark, and
  // at least hourly.
  async antiEntropy(peer, now = Date.now()) {
    const quietLimit = now - this.#store.retention.roomMs;
    const state = this.#rounds.get(peer.id);
    const full = !state || state.full || now - state.fullAt >= FULL_ROUND_MS;
    const since = (key) => (full ? undefined : state.marks[key]);
    const marks = {};
    let fullAgain = false;
    const list = async (path, key, take) => {
      let complete = true;
      for (let cursor = ''; ;) {
        const s0 = since(key);
        const res = await this.#call(peer, path, { cursor, ...(s0 && { since: s0 }) });
        if (cursor === '') {
          if (typeof res.mark === 'string') marks[key] = res.mark;
          else fullAgain = true; // a node before 0.6.0: every round is full
        }
        if ((await take(res)) === false) complete = false;
        if (!res.cursor) break;
        cursor = res.cursor;
      }
      if (!complete) delete marks[key];
    };

    let newRooms = 0;
    await list('/v2/rooms', 'rooms', async (res) => {
      let complete = true;
      for (const r of res.rooms) {
        if (this.#store.expired(r.room) || r.active_at < quietLimit) continue;
        const local = this.#store.room(r.room);
        if (!local) {
          if (newRooms >= this.#opts.newRoomsPerRound) {
            complete = false;
            continue;
          }
          newRooms++;
        } else if (!r.heads.some((h) => !local.has(h))) continue;
        await this.pullRoom(peer, r.room);
      }
      return complete;
    });
    let newAgents = 0;
    await list('/v2/agents', 'agents', async (res) => {
      let complete = true;
      for (const a of res.agents) {
        if (this.#store.agentEvent(a.head)) continue;
        if (!this.#store.agent(a.agent)) {
          if (newAgents >= this.#opts.newAgentsPerRound) {
            complete = false;
            continue;
          }
          newAgents++;
        }
        await this.pullChain(peer, a.agent);
      }
      return complete;
    });
    await list('/v2/reports', 'reports', async (res) => {
      for (const r of res.reports) {
        if (this.#store.report(r.id)) continue;
        const v = verifyReport(r.report);
        if (v.id) this.#store.addReport(v.id, r.report, null, now, 'pull');
        else this.#peers.penalize(peer.id, 1, 'bad_report');
      }
    });
    // Reached only when every listing call succeeded. A listing left incomplete keeps its old mark.
    const kept = { ...(full ? {} : state.marks), ...marks };
    this.#rounds.set(peer.id, {
      marks: kept,
      fullAt: full ? now : state.fullAt,
      // Next round is full again if the peer gave no marks, or a full round left a listing incomplete.
      full: fullAgain || (full && Object.keys(kept).length < 3),
    });
    // Last, and never fatal: a peer running a release without /v2/content answers 404.
    await this.repairContent(peer, now).catch((err) => this.#opts.log.warn?.(`content repair with ${peer.id}: ${err.message}`));
  }
}
