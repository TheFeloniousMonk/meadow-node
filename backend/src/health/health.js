// One network's health (SPEC §9.6): self-checks of its own ports, what it
// holds and accepted, its peers, and its traffic. A snapshot is plain JSON:
// the alerts post it, and it is kept in the database (meta `health`) so the
// operator command can show peers and send a test report.

import { PROTOCOL } from '../proto/event.js';

export const QUIET_MS = 2 * 60 * 60 * 1000; // no successful exchange for this long is reported
export const DISCOVERY_FAILURES = 3; // failed discovery runs in a row before it is a problem

const minus = (a, b) => ({ in: a.in - (b?.in ?? 0), out: a.out - (b?.out ?? 0) });

export class Health {
  #o;
  #prev = null; // counters at the last advancing snapshot

  // o: { network, store, peers, discovery, traffic: { relay, peer, own }, ports: { relay, peer },
  //      version, startedAt, fetch, now }
  constructor(o) {
    this.#o = { fetch: globalThis.fetch, now: Date.now, startedAt: Date.now(), ...o };
  }

  get network() {
    return this.#o.network;
  }

  async #selfCheck(url, init, check) {
    const t = this.#o.now();
    try {
      const res = await this.#o.fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
      const body = await res.json().catch(() => null);
      const ok = res.ok && check(body);
      return { ok, ms: this.#o.now() - t, ...(!ok && { error: `answered ${res.status}` }) };
    } catch (err) {
      return { ok: false, ms: this.#o.now() - t, error: err.cause?.code ?? err.message };
    }
  }

  // `advance`: start a new interval (the alert checks); otherwise the deltas
  // stay against the last one (the snapshot kept for the operator command).
  async snapshot({ advance = false } = {}) {
    const o = this.#o;
    const now = o.now();
    const [relay, peer] = await Promise.all([
      this.#selfCheck(`http://127.0.0.1:${o.ports.relay}/healthz`, {}, (b) => b?.status === 'ok'),
      this.#selfCheck(`http://127.0.0.1:${o.ports.peer}/v2/hello`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }, (b) => b?.node === o.store.node.id),
    ]);

    const ingest = Object.fromEntries([...o.store.ingestCounts].map(([k, v]) => [k, { ...v }]));
    const traffic = { relay: o.traffic.relay.totals(), peer: o.traffic.peer.totals(), own: o.traffic.own.totals() };
    const prev = this.#prev;
    const lastInterval = (key) => {
      const cur = ingest[key] ?? { received: 0, accepted: 0 };
      const was = prev?.ingest[key] ?? { received: 0, accepted: 0 };
      return { received: cur.received - was.received, accepted: cur.accepted - was.accepted };
    };
    const origins = new Set([...Object.keys(ingest), ...Object.keys(prev?.ingest ?? {})]);
    const accepted = { clients: lastInterval('client').accepted, peers: 0 };
    for (const k of origins) if (k !== 'client') accepted.peers += lastInterval(k).accepted;

    const since = (at) => (at ? now - at : null);
    const upFor = now - o.startedAt;
    const peers = o.peers.all().map((p) => ({
      id: p.id,
      host: (() => { try { return new URL(p.url).host; } catch { return p.url; } })(),
      source: p.source,
      banned: p.banned,
      banned_until: p.bannedUntil,
      penalty: p.penalty,
      last_penalty: p.lastPenalty,
      last_ok: p.lastOk,
      quiet_ms: since(p.lastOk) ?? Math.min(upFor, since(p.addedAt) ?? upFor),
      failures: p.failures,
      last_error: p.lastError,
      interval: lastInterval(p.id),
    }));

    const issues = [];
    const problem = (text) => issues.push({ level: 'problem', text });
    const warning = (text) => issues.push({ level: 'warning', text });
    if (!relay.ok) problem(`The relay port does not answer its own health check (${relay.error}). Clients can't reach this node.`);
    if (!peer.ok) problem(`The peer port does not answer its own hello (${peer.error}). Other nodes can't sync with it.`);
    const d = o.discovery?.status ?? {};
    if (d.failuresInARow >= DISCOVERY_FAILURES) problem(`Discovery could not read the chain in its last ${d.failuresInARow} runs (${d.lastError?.text ?? 'unknown error'}). New peers won't be found.`);
    const others = d.others ?? 0;
    const active = peers.filter((p) => !p.banned);
    // Syncing: a successful exchange within the quiet window. A peer never heard from is not.
    const syncing = active.filter((p) => p.last_ok !== null && now - p.last_ok < QUIET_MS);
    if (others > 0 && upFor >= QUIET_MS && syncing.length === 0) {
      problem(`The chain lists ${others} other supplier${others === 1 ? '' : 's'}, but no peer has had a successful exchange for ${Math.round(QUIET_MS / 3_600_000)} hours. This node is not replicating.`);
    }
    for (const p of peers) {
      if (p.banned) warning(`Peer ${p.id.slice(0, 10)}… (${p.host}) is banned until ${new Date(p.banned_until).toISOString().slice(11, 16)} UTC after ${p.penalty} penalty points (last: ${p.last_penalty?.reason ?? 'unknown'}).`);
      else if (syncing.length && p.quiet_ms >= QUIET_MS) warning(`Peer ${p.id.slice(0, 10)}… (${p.host}) has had no successful exchange for ${Math.round(p.quiet_ms / 3_600_000)} hours${p.last_error ? ` (last error: ${p.last_error.text})` : ''}.`);
    }

    const snap = {
      network: o.network,
      at: now,
      node: o.store.node.id,
      version: o.version,
      protocol: PROTOCOL,
      up_ms: upFor,
      self: { relay, peer },
      holds: o.store.counts(),
      accepted,
      discovery: { last_run: d.lastRun ?? null, suppliers: d.suppliers ?? null, others: d.others ?? null, found: d.found ?? null, last_error: d.lastError ?? null, failures_in_a_row: d.failuresInARow ?? 0 },
      peers,
      traffic: {
        interval: { relay: minus(traffic.relay, prev?.traffic.relay), peer: minus(traffic.peer, prev?.traffic.peer), own: minus(traffic.own, prev?.traffic.own) },
        total: traffic,
        interval_ms: now - (prev?.at ?? o.startedAt),
      },
      issues,
      level: issues.some((i) => i.level === 'problem') ? 'problem' : issues.length ? 'warning' : 'ok',
    };
    if (advance) this.#prev = { at: now, ingest, traffic };
    try {
      o.store.putMeta('health', JSON.stringify(snap));
    } catch { /* never let the report affect serving */ }
    return snap;
  }
}
