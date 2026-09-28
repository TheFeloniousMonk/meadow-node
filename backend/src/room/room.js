// One room's event graph: event processing (SPEC §6.6), state before and
// after events, heads, and current state (§6.7). Holds headers only; content
// lives in the store. Agent chain events (§5.4) come from the resolver given to
// the constructor: keyAt(id), descends(id, ancestorId), and currentKey(agent).

import { checkWellFormed, roomIdOf, signingKeyB64, stateKey } from '../proto/event.js';
import { authKeys, authorize, powerOf, powerTable } from './auth.js';
import { resolve } from './resolve.js';

export class Room {
  #events = new Map();
  #outcomes = new Map();
  #depth = new Map();
  #after = new Map();
  #chains = new Map();
  #heads = new Set(); // accepted events no accepted event descends from
  #tips = new Set(); // stored events with no stored children
  #createId = null;
  #agents;
  #ctx;

  constructor(agents = null) {
    this.#agents = agents;
    this.#ctx = { event: (id) => this.#events.get(id), authChain: (id) => this.authChain(id), agents };
  }

  get id() {
    return this.#createId && roomIdOf(this.#createId);
  }

  get create() {
    return this.#createId && this.#events.get(this.#createId);
  }

  get size() {
    return this.#events.size;
  }

  has(id) {
    return this.#events.has(id);
  }

  event(id) {
    return this.#events.get(id);
  }

  outcome(id) {
    return this.#outcomes.get(id);
  }

  // Returns { outcome: 'accepted', soft_failed } | { outcome: 'rejected' | 'discarded', reason }
  //       | { outcome: 'pending', missing }.
  // Pass wellFormed: true only when the caller already ran checkWellFormed.
  add(ev, { wellFormed = false } = {}) {
    const malformed = wellFormed ? null : checkWellFormed(ev);
    if (malformed) return { outcome: 'discarded', reason: malformed };
    const known = this.#outcomes.get(ev.id);
    if (known) return known;

    const h = ev.header;
    if (h.kind === 'room.create' ? this.#createId !== null : h.room !== this.id) {
      return { outcome: 'discarded', reason: 'wrong_room' };
    }
    const missing = [...new Set([...h.parents, ...h.auth])].filter((id) => !this.#events.has(id));
    const chain = (h.kind === 'room.rotate' || h.kind === 'room.create') ? h.data.chain : undefined;
    if (chain !== undefined && !this.#agents?.keyAt(chain)) missing.push(chain);
    if (missing.length) return { outcome: 'pending', missing };

    const reason = this.#checkAuthEvents(ev) ?? authorize(ev, this.stateAt(h.parents), this.#agents);
    // A room.create that fails never becomes a room.
    if (reason && h.kind === 'room.create') return { outcome: 'discarded', reason };
    const result = reason
      ? { outcome: 'rejected', reason }
      : { outcome: 'accepted', soft_failed: this.#softFails(ev) };
    this.#store({ header: h, id: ev.id, sig: ev.sig }, result);
    return result;
  }

  // Reload an event already processed and persisted, in the order it was stored.
  restore(ev, result) {
    this.#store({ header: ev.header, id: ev.id, sig: ev.sig }, result);
  }

  #store(ev, result) {
    const h = ev.header;
    this.#events.set(ev.id, ev);
    this.#outcomes.set(ev.id, result);
    this.#depth.set(ev.id, 1 + Math.max(0, ...h.parents.map((p) => this.#depth.get(p))));
    if (h.kind === 'room.create') this.#createId = ev.id;
    for (const p of h.parents) this.#tips.delete(p);
    this.#tips.add(ev.id);
    if (result.outcome !== 'accepted') return;
    // Everything below an accepted event is covered, except what only rejected events covered.
    const stack = [...h.parents];
    while (stack.length) {
      const id = stack.pop();
      if (this.#heads.delete(id) || this.#outcomes.get(id).outcome === 'accepted') continue;
      stack.push(...this.#events.get(id).header.parents);
    }
    this.#heads.add(ev.id);
  }

  // §6.6 step 6: not allowed by the current state, or signed with a key the
  // author's chain has retired, as far as this node knows.
  #softFails(ev) {
    if (authorize(ev, this.currentState(), this.#agents) !== null) return true;
    const current = this.#agents?.currentKey(ev.header.author);
    return current != null && current !== signingKeyB64(ev.header);
  }

  #checkAuthEvents(ev) {
    const h = ev.header;
    const allowed = new Set(authKeys(h));
    const map = new Map();
    for (const id of h.auth) {
      const a = this.#events.get(id);
      const k = stateKey(a.header);
      if (this.#outcomes.get(id).outcome !== 'accepted' || !k || !allowed.has(k) || map.has(k)) {
        return 'auth_events_invalid';
      }
      map.set(k, a);
    }
    if (h.kind !== 'room.create' && !map.has('room.create|')) return 'auth_events_invalid';
    return authorize(ev, map, this.#agents);
  }

  authChain(id) {
    let chain = this.#chains.get(id);
    if (chain) return chain;
    chain = new Set();
    for (const a of this.#events.get(id).header.auth) {
      chain.add(a);
      for (const x of this.authChain(a)) chain.add(x);
    }
    this.#chains.set(id, chain);
    return chain;
  }

  // State before an event with these parents.
  stateAt(parents) {
    return resolve(parents.map((p) => this.stateAfter(p)), this.#ctx);
  }

  stateAfter(id) {
    let state = this.#after.get(id);
    if (state) return state;
    const ev = this.#events.get(id);
    state = this.stateAt(ev.header.parents);
    const k = stateKey(ev.header);
    if (k && this.#outcomes.get(id).outcome === 'accepted') state.set(k, ev);
    this.#after.set(id, state);
    return state;
  }

  heads() {
    return [...this.#heads].sort();
  }

  currentState() {
    return this.stateAt(this.heads());
  }

  // Stored events that are not ancestors-or-self of `since`, oldest first
  // (depth, then ID). Walks back from the tips and from `since` together in
  // depth order, so the cost follows the size of the difference, not the room.
  eventsSince(since) {
    const known = since.filter((id) => this.#events.has(id));
    const theirs = new Map();
    const heap = new MaxHeap((id) => this.#depth.get(id));
    let mine = 0;
    const push = (id, isTheirs) => {
      if (theirs.has(id)) {
        if (isTheirs && !theirs.get(id)) {
          theirs.set(id, true);
          mine--;
        }
        return;
      }
      theirs.set(id, isTheirs);
      if (!isTheirs) mine++;
      heap.push(id);
    };
    for (const id of known) push(id, true);
    for (const id of this.#tips) push(id, false);

    const out = [];
    while (mine > 0) {
      const id = heap.pop();
      const isTheirs = theirs.get(id);
      if (!isTheirs) {
        mine--;
        out.push(id);
      }
      for (const p of this.#events.get(id).header.parents) push(p, isTheirs);
    }
    out.sort((a, b) => this.#depth.get(a) - this.#depth.get(b) || (a < b ? -1 : a > b ? 1 : 0));
    return { ids: out, missing: known.length !== since.length };
  }

  // What an accepted msg.delete does to its target (SPEC §6.5): 'author',
  // 'moderator', or null for no effect (or target not stored yet).
  deletionEffect(del) {
    const target = this.#events.get(del.header.data.target);
    if (!target || !(target.header.kind === 'msg.post' || target.header.kind === 'room.keys')) return null;
    if (target.header.author === del.header.author) return 'author';
    const state = this.stateAt(del.header.parents);
    return powerOf(state, del.header.author) >= powerTable(state).delete ? 'moderator' : null;
  }
}

class MaxHeap {
  #items = [];
  #key;
  constructor(key) {
    this.#key = key;
  }
  push(item) {
    const a = this.#items;
    a.push(item);
    for (let i = a.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (this.#key(a[parent]) >= this.#key(a[i])) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop() {
    const a = this.#items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.#key(a[l]) > this.#key(a[m])) m = l;
        if (r < a.length && this.#key(a[r]) > this.#key(a[m])) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
