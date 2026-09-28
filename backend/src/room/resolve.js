// State resolution (SPEC §6.8), after Matrix state resolution v2.1.
//
// `ctx` supplies event(id), authChain(id) (all events reachable through
// auth links, excluding the event itself), and agents (the chain resolver
// authorize needs). Every event reached is accepted.

import { stateKey } from '../proto/event.js';
import { authKeys, authorize, powerOf } from './auth.js';

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function authMap(ev, ctx) {
  const map = new Map();
  for (const id of ev.header.auth) {
    const a = ctx.event(id);
    map.set(stateKey(a.header), a);
  }
  return map;
}

function isPowerEvent(h) {
  if (h.kind === 'room.power') return true;
  return h.kind === 'room.member' && h.data.target !== h.author &&
    (h.data.membership === 'leave' || h.data.membership === 'ban');
}

function powerAuthOf(ev, ctx) {
  for (const id of ev.header.auth) {
    const a = ctx.event(id);
    if (a.header.kind === 'room.power') return a;
  }
  return null;
}

function senderPower(ev, ctx) {
  const map = authMap(ev, ctx);
  return map.has('room.create|') ? powerOf(map, ev.header.author) : 0;
}

export function iterativeAuth(ids, initial, ctx) {
  const S = new Map(initial);
  for (const id of ids) {
    const ev = ctx.event(id);
    const A = authMap(ev, ctx);
    for (const k of authKeys(ev.header)) if (S.has(k)) A.set(k, S.get(k));
    if (authorize(ev, A, ctx.agents) === null) S.set(stateKey(ev.header), ev);
  }
  return S;
}

function reverseTopologicalPowerSort(ids, ctx) {
  const set = new Set(ids);
  const pending = new Map();
  const children = new Map();
  const key = new Map();
  for (const id of set) {
    const ev = ctx.event(id);
    const inSet = ev.header.auth.filter((a) => set.has(a));
    pending.set(id, inSet.length);
    for (const a of inSet) children.set(a, [...(children.get(a) ?? []), id]);
    key.set(id, { power: senderPower(ev, ctx), ts: ev.header.ts });
  }
  const cmp = (a, b) => key.get(b).power - key.get(a).power || key.get(a).ts - key.get(b).ts || byId(a, b);
  const ready = [...set].filter((id) => pending.get(id) === 0);
  const out = [];
  while (ready.length) {
    ready.sort(cmp);
    const id = ready.shift();
    out.push(id);
    for (const c of children.get(id) ?? []) {
      pending.set(c, pending.get(c) - 1);
      if (pending.get(c) === 0) ready.push(c);
    }
  }
  return out;
}

function mainlineSort(ids, root, ctx) {
  const mainline = [];
  for (let p = root; p; p = powerAuthOf(p, ctx)) mainline.push(p.id);
  const position = new Map(mainline.reverse().map((id, i) => [id, i + 1]));
  const depth = (ev) => {
    for (let x = ev; x; x = powerAuthOf(x, ctx)) if (position.has(x.id)) return position.get(x.id);
    return 0;
  };
  const key = new Map(ids.map((id) => {
    const ev = ctx.event(id);
    return [id, { depth: depth(ev), ts: ev.header.ts }];
  }));
  return [...ids].sort((a, b) => key.get(a).depth - key.get(b).depth || key.get(a).ts - key.get(b).ts || byId(a, b));
}

function conflictedSubgraph(conflicted, ctx) {
  const candidates = new Set();
  for (const c of conflicted) {
    candidates.add(c);
    for (const a of ctx.authChain(c)) candidates.add(a);
  }
  const out = new Set();
  for (const x of candidates) {
    if (conflicted.has(x) || [...ctx.authChain(x)].some((a) => conflicted.has(a))) out.add(x);
  }
  return out;
}

export function resolve(states, ctx) {
  if (states.length === 0) return new Map();
  if (states.length === 1) return new Map(states[0]);

  const unconflicted = new Map();
  const conflicted = new Set();
  const keys = new Set(states.flatMap((s) => [...s.keys()]));
  for (const k of keys) {
    const ids = states.map((s) => s.get(k)?.id);
    if (ids.every((id) => id !== undefined && id === ids[0])) unconflicted.set(k, states[0].get(k));
    else for (const id of ids) if (id !== undefined) conflicted.add(id);
  }
  if (conflicted.size === 0) return unconflicted;

  // Auth difference: in some states' auth chains but not all (a state's chain includes its own events).
  const counts = new Map();
  for (const s of states) {
    const chain = new Set();
    for (const ev of s.values()) {
      chain.add(ev.id);
      for (const a of ctx.authChain(ev.id)) chain.add(a);
    }
    for (const id of chain) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const full = new Set([...conflicted, ...conflictedSubgraph(conflicted, ctx)]);
  for (const [id, n] of counts) if (n < states.length) full.add(id);

  const powerIds = new Set();
  for (const id of full) {
    if (!isPowerEvent(ctx.event(id).header)) continue;
    powerIds.add(id);
    for (const a of ctx.authChain(id)) if (full.has(a)) powerIds.add(a);
  }
  let partial = iterativeAuth(reverseTopologicalPowerSort(powerIds, ctx), new Map(), ctx);

  const rest = [...full].filter((id) => !powerIds.has(id));
  const root = partial.get('room.power|') ?? unconflicted.get('room.power|') ?? null;
  partial = iterativeAuth(mainlineSort(rest, root, ctx), partial, ctx);

  for (const [k, ev] of unconflicted) partial.set(k, ev);
  return partial;
}
