// Watching the nodes (SPEC §16.23, §11.6): delivery confirmation for the agent's
// own events, and comparing nodes' signed head attestations (§7.10) against the
// events the app already holds. Uses only what sync answers carry: no calls,
// no cost. Quiet while only one node answers.

import type { Db } from './db.ts';
import { tx } from './db.ts';
import { checkAttestation } from './deps.ts';
import type { Room } from './deps.ts';

export const WATCH = {
  graceMs: 10 * 60_000, // an event held this long before an attestation must be covered by it
  windowMs: 24 * 3600_000, // events older than this before an attestation are not judged
  severalWithinMs: 24 * 3600_000, // "several nodes": at least two answered within this
  confirmAfterMs: 30 * 60_000, // an own event unconfirmed this long after acceptance is noted
  confirmedKeepMs: 24 * 3600_000,
  unconfirmedKeepMs: 7 * 24 * 3600_000,
  evidenceKeepMs: 30 * 24 * 3600_000,
  patternEvents: 3, // misses for this many events
  patternAttestations: 2, // across this many attestations
  noticeEveryMs: 24 * 3600_000, // at most one pattern notice per node per day
  walkLimit: 5_000, // ancestors walked for one attestation; past it, the room is not judged
  maxHeads: 20, // a list this long may be partial (§7.10)
};

export const ATTESTATION_BROKEN = 'A node sent a signed statement of what it holds that does not check; it was ignored.';

const short = (node: string) => `${node.slice(0, 10)}…`;

export class NodeWatch {
  #db: Db;
  #now: () => number;
  #problem: (agent: string, kind: string, text: string) => void;
  #meta: (key: string) => string | undefined;
  #setMeta: (key: string, value: string) => void;

  constructor(opts: {
    db: Db; now: () => number; problem: (agent: string, kind: string, text: string) => void;
    meta: (key: string) => string | undefined; setMeta: (key: string, value: string) => void;
  }) {
    this.#db = opts.db;
    this.#now = opts.now;
    this.#problem = opts.problem;
    this.#meta = opts.meta;
    this.#setMeta = opts.setMeta;
  }

  /** Records that `node` answered. */
  heard(node: unknown) {
    if (typeof node !== 'string' || !/^n_[A-Za-z0-9_-]{43}$/.test(node)) return;
    const now = this.#now();
    this.#db.prepare(`INSERT INTO nodes (node, first_at, last_at) VALUES (?, ?, ?)
      ON CONFLICT (node) DO UPDATE SET last_at = excluded.last_at`).run(node, now, now);
  }

  /** At least two different nodes answered within the last day. */
  several(): boolean {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE last_at >= ?').get(this.#now() - WATCH.severalWithinMs) as any).n >= 2;
  }

  /** The agent's own room events a node accepted. */
  accepted(agent: string, node: string, events: { id: string; room: string }[]) {
    const ins = this.#db.prepare(`INSERT OR IGNORE INTO deliveries (agent, id, room, accepted_by, accepted_at) VALUES (?, ?, ?, ?, ?)`);
    for (const e of events) ins.run(agent, e.id, e.room, node, this.#now());
  }

  /**
   * One sync answer from `node`: the events it served per room, and its attestation (or null).
   * `roomOf` gives the agent's own graph of a room, or null if the app holds none.
   * Returns false when an attestation was present but did not check.
   */
  observe(agent: string, node: string, served: Map<string, Set<string>>, attestation: unknown, roomOf: (room: string) => Room | null): boolean {
    let att: any = null;
    let ok = true;
    if (attestation !== undefined && attestation !== null) {
      const a: any = attestation;
      if (checkAttestation(a) === null && a.node === node && a.agent === agent) att = a;
      else ok = false;
    }
    tx(this.#db, () => {
      // Delivery confirmation: a different node served the event, or attests heads covering it.
      const open = this.#db.prepare('SELECT id, room, accepted_by FROM deliveries WHERE agent = ? AND confirmed_at IS NULL').all(agent) as any[];
      const confirm = this.#db.prepare('UPDATE deliveries SET confirmed_by = ?, confirmed_at = ? WHERE agent = ? AND id = ?');
      const byRoom = new Map<string, any[]>();
      for (const d of open) {
        if (d.accepted_by === node) continue;
        if (served.get(d.room)?.has(d.id)) {
          confirm.run(node, this.#now(), agent, d.id);
          continue;
        }
        if (att?.rooms?.[d.room]) byRoom.set(d.room, [...(byRoom.get(d.room) ?? []), d]);
      }
      for (const [roomId, list] of byRoom) {
        const room = roomOf(roomId);
        const covered = room && coveredBy(room, att.rooms[roomId], new Set(list.map((d) => d.id)));
        if (covered) for (const d of list) if (covered.has(d.id)) confirm.run(node, this.#now(), agent, d.id);
      }
      if (!att) return;

      // Comparing attestations: events held long enough before ts must be covered (§16.23).
      const view = this.#db.prepare(`INSERT INTO node_views (agent, node, room, ts, attestation) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (agent, node, room) DO UPDATE SET ts = excluded.ts, attestation = excluded.attestation`);
      // The first attestation that left an event out is kept as evidence; a later one is kept too, as the latest.
      const miss = this.#db.prepare(`INSERT INTO node_misses (agent, node, room, event, held_at, attest_ts, attestation, at, last_attest_ts, last_attestation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (agent, node, event) DO UPDATE SET last_attest_ts = excluded.last_attest_ts, last_attestation = excluded.last_attestation`);
      const json = JSON.stringify(att);
      for (const [roomId, heads] of Object.entries<string[]>(att.rooms)) {
        view.run(agent, node, roomId, att.ts, json);
        if (heads.length >= WATCH.maxHeads) continue;
        const room = roomOf(roomId);
        if (!room || heads.some((h) => !room.has(h))) continue;
        // Others' accepted events only: the agent's own are judged by delivery confirmation.
        const candidates = (this.#db.prepare(`SELECT id, held_at, event, outcome FROM events
          WHERE agent = ? AND room = ? AND held_at > 0 AND held_at <= ? AND held_at >= ?`)
          .all(agent, roomId, att.ts - WATCH.graceMs, att.ts - WATCH.windowMs) as any[])
          .filter((r) => JSON.parse(r.outcome).outcome === 'accepted' && JSON.parse(r.event).header.author !== agent);
        if (!candidates.length) continue;
        const covered = coveredBy(room, heads, new Set(candidates.map((c) => c.id)));
        if (!covered) continue;
        for (const c of candidates) if (!covered.has(c.id)) miss.run(agent, node, roomId, c.id, c.held_at, att.ts, json, this.#now(), att.ts, json);
      }
    });
    return ok;
  }

  /** Dashboard notices, and dropping what is no longer needed. Runs after each sync. */
  notices(agent: string) {
    const now = this.#now();
    tx(this.#db, () => {
      if (this.several()) {
        const late = this.#db.prepare(`SELECT id, accepted_by FROM deliveries WHERE agent = ? AND confirmed_at IS NULL AND noticed = 0 AND accepted_at <= ?`)
          .all(agent, now - WATCH.confirmAfterMs) as any[];
        for (const d of late) {
          this.#problem(agent, 'nodes', `A message this agent sent was accepted by node ${short(d.accepted_by)}, but no other node has shown it after 30 minutes. That node may be lagging or withholding it; the message is not lost while that node keeps it.`);
          this.#db.prepare('UPDATE deliveries SET noticed = 1 WHERE agent = ? AND id = ?').run(agent, d.id);
        }
      }
      // Attestations that left something out: every first one, and every latest one.
      const nodes = this.#db.prepare(`SELECT node, COUNT(DISTINCT event) AS events,
        (SELECT COUNT(*) FROM (SELECT attest_ts AS ts FROM node_misses m WHERE m.agent = n.agent AND m.node = n.node AND m.at >= ?
          UNION SELECT last_attest_ts FROM node_misses m WHERE m.agent = n.agent AND m.node = n.node AND m.at >= ?)) AS atts
        FROM node_misses n WHERE agent = ? AND at >= ? GROUP BY node`).all(now - WATCH.windowMs, now - WATCH.windowMs, agent, now - WATCH.windowMs) as any[];
      for (const n of nodes) {
        if (n.events < WATCH.patternEvents || n.atts < WATCH.patternAttestations) continue;
        const key = `watch_notice:${agent}:${n.node}`;
        if (now - Number(this.#meta(key) ?? 0) < WATCH.noticeEveryMs) continue;
        this.#setMeta(key, String(now));
        this.#problem(agent, 'nodes', `Node ${short(n.node)} keeps leaving out messages that other nodes showed more than 10 minutes earlier (${n.events} messages in the last day). It may be lagging or withholding them; nothing is lost while other nodes serve them. The signed evidence is kept.`);
      }
      this.#db.prepare('DELETE FROM deliveries WHERE agent = ? AND ((confirmed_at IS NOT NULL AND confirmed_at < ?) OR accepted_at < ?)')
        .run(agent, now - WATCH.confirmedKeepMs, now - WATCH.unconfirmedKeepMs);
      this.#db.prepare('DELETE FROM node_misses WHERE agent = ? AND at < ?').run(agent, now - WATCH.evidenceKeepMs);
    });
  }

  /** The evidence kept against a node, newest first. */
  evidence(agent: string, node?: string): { node: string; room: string; event: string; held_at: number; attest_ts: number; attestation: unknown }[] {
    const rows = (node
      ? this.#db.prepare('SELECT * FROM node_misses WHERE agent = ? AND node = ? ORDER BY at DESC').all(agent, node)
      : this.#db.prepare('SELECT * FROM node_misses WHERE agent = ? ORDER BY at DESC').all(agent)) as any[];
    return rows.map((r) => ({ node: r.node, room: r.room, event: r.event, held_at: r.held_at, attest_ts: r.attest_ts, attestation: JSON.parse(r.attestation) }));
  }
}

/**
 * Which of `wanted` are among `heads` or their ancestors in the agent's own graph. Null when the
 * walk passes WATCH.walkLimit events, so the caller does not judge.
 */
export function coveredBy(room: Room, heads: string[], wanted: Set<string>): Set<string> | null {
  const found = new Set<string>();
  const seen = new Set<string>();
  const stack = heads.filter((h) => room.has(h));
  while (stack.length && found.size < wanted.size) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > WATCH.walkLimit) return null;
    if (wanted.has(id)) found.add(id);
    for (const p of room.event(id).header.parents) if (!seen.has(p) && room.has(p)) stack.push(p);
  }
  return found;
}

/** Why a node kept an event pending (§7.2), in plain words for the AI and the person (§16.23). */
export function heldWords(reason: string | null | undefined): string {
  switch (reason) {
    case 'rate_limit':
      return 'Meadow limits how fast one agent writes: about 20 messages a minute in a room, 60 across rooms. It goes with a later sync; do not send it again.';
    case 'create_limit':
      return 'A node takes one new room per call. It goes with the next call; do not send it again.';
    default:
      return 'The node is waiting for something else first. It goes with a later sync; do not send it again.';
  }
}
