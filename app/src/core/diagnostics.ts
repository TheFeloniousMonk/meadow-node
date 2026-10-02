// Connection diagnostics (SPEC §16.17): what the app records about the paths
// between the person's AI and the network, so a failure can be placed on one
// step. Times and outcomes only: never a token, key, code, password, request
// body, tool argument, or message text.
//
// - Each call from a connection: when, which way it came, the tool or MCP
//   method, how it ended, and how long it took. The last 200 per agent, and
//   the last of each outcome kept whatever their age.
// - Events (the tunneled interface's refusals and failures, sign-ins, the
//   tunnel's states, sync failures): one row per distinct event, counted, so
//   a stranger probing the tunnel cannot grow the table; at most 500 rows.

import type { Db } from './db.ts';
import { ActionError } from './core.ts';
import { TransportError } from './transport.ts';

/** Which way a call came: the Claude bridge (or Claude Code), another local MCP host, REST, ChatGPT through the tunnel, or the runner. */
export type Via = 'claude' | 'local' | 'rest' | 'chatgpt' | 'runner';
export type Outcome = 'ok' | 'refused' | 'failed';
export type EventKind = 'http' | 'oauth' | 'tunnel' | 'sync' | 'test';

/** Past this, a host has likely stopped waiting: ChatGPT and other hosts give up on a tool at about 20 s (§16.17.1). */
export const SLOW_MS = 20_000;
export const KEEP_CALLS = 200;
export const KEEP_EVENTS = 500;
/** Error sentences are cut to this length; they are the app's own words. */
const MAX_ERROR = 300;

export interface CallRow {
  at: number;
  via: Via;
  name: string;
  outcome: Outcome;
  ms: number;
  error: string | null;
}

export interface EventRow {
  agent: string;
  kind: EventKind;
  what: string;
  detail: string;
  firstAt: number;
  lastAt: number;
  count: number;
}

export class Diagnostics {
  #db: Db;
  #now: () => number;

  constructor({ db, now = Date.now }: { db: Db; now?: () => number }) {
    this.#db = db;
    this.#now = now;
  }

  /** Records one call from a connection. */
  call(agent: string, via: Via, name: string, outcome: Outcome, ms: number, error?: string) {
    this.#db.prepare('INSERT INTO conn_calls (agent, at, via, name, outcome, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(agent, this.#now(), via, name.slice(0, 64), outcome, Math.max(0, Math.round(ms)), error ? error.slice(0, MAX_ERROR) : null);
    // Keep the last 200, and the newest of each outcome, so an old failure is not pushed out by a run of successes.
    this.#db.prepare(`DELETE FROM conn_calls WHERE agent = ? AND seq NOT IN (SELECT seq FROM conn_calls WHERE agent = ? ORDER BY seq DESC LIMIT ?)
      AND seq NOT IN (SELECT MAX(seq) FROM conn_calls WHERE agent = ? GROUP BY outcome)`).run(agent, agent, KEEP_CALLS, agent);
  }

  /** Records an event, counting a repeat of the same one instead of storing it again. */
  event(kind: EventKind, what: string, detail = '', agent = '') {
    const now = this.#now();
    this.#db.prepare(`INSERT INTO conn_events (agent, kind, what, detail, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (agent, kind, what, detail) DO UPDATE SET last_at = excluded.last_at, count = count + 1`)
      .run(agent, kind, what.slice(0, 64), detail.slice(0, MAX_ERROR), now, now);
    this.#db.prepare('DELETE FROM conn_events WHERE seq NOT IN (SELECT seq FROM conn_events ORDER BY last_at DESC, seq DESC LIMIT ?)').run(KEEP_EVENTS);
  }

  /** The newest calls for an agent, newest first; `via` narrows them to one way in. */
  calls(agent: string, { via, limit = 50 }: { via?: Via[]; limit?: number } = {}): CallRow[] {
    const rows = this.#db.prepare(`SELECT at, via, name, outcome, ms, error FROM conn_calls WHERE agent = ?
      ${via ? `AND via IN (${via.map(() => '?').join(', ')})` : ''} ORDER BY seq DESC LIMIT ?`).all(agent, ...(via ?? []), limit) as any[];
    return rows as CallRow[];
  }

  /** Events, newest first, for an agent (with those that name no agent) or all. */
  events({ agent, kinds, limit = 50 }: { agent?: string; kinds?: EventKind[]; limit?: number } = {}): EventRow[] {
    const where: string[] = [];
    const args: any[] = [];
    if (agent !== undefined) {
      where.push("(agent = ? OR agent = '')");
      args.push(agent);
    }
    if (kinds) {
      where.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
      args.push(...kinds);
    }
    return (this.#db.prepare(`SELECT agent, kind, what, detail, first_at, last_at, count FROM conn_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY last_at DESC, seq DESC LIMIT ?`).all(...args, limit) as any[])
      .map((r) => ({ agent: r.agent, kind: r.kind, what: r.what, detail: r.detail, firstAt: r.first_at, lastAt: r.last_at, count: r.count }));
  }

  /** The newest event of these kinds and names, or null. */
  last(kind: EventKind, what: string[], agent?: string): EventRow | null {
    return this.events({ agent, kinds: [kind], limit: KEEP_EVENTS }).find((e) => what.includes(e.what)) ?? null;
  }
}

/**
 * Text for the diagnostics export (§16.17.4), with every identifier taken out:
 * agent, room, event, and node IDs, handles, tokens, wallet addresses, and
 * hosts other than the public services the app calls.
 */
export function scrub(text: string): string {
  return text
    .replace(/\b(mat|mrt|mdw)_[A-Za-z0-9_-]+/g, '<token>')
    .replace(/\ba_[A-Za-z0-9_-]{43}\b/g, '<agent>')
    .replace(/\br_[A-Za-z0-9_-]{20,}/g, '<room>')
    .replace(/\be_[A-Za-z0-9_-]{20,}/g, '<event>')
    .replace(/\bn_[A-Za-z0-9_-]{20,}/g, '<node>')
    .replace(/\b[a-z0-9_-]{2,32}#[a-z2-7]{8}\b/g, '<handle>')
    .replace(/\b0x[0-9a-fA-F]{40,}\b/g, '<address>')
    // An agent's MCP address on the tunnel carries its network name, half its handle.
    .replace(/\/[a-z0-9_-]{2,32}\/mcp\b/g, '/<name>/mcp')
    .replace(/\bhttps?:\/\/([^\s/'")]+)/gi, (m, host: string) => (host.startsWith('<') || PUBLIC_HOSTS.includes(host.toLowerCase()) ? m : m.replace(host, '<host>')));
}

/** Hosts the app calls that name no one: kept in the export. */
const PUBLIC_HOSTS = ['agent.pocket.network', 'base.api.pocket.network', 'mainnet.base.org', 'api.cow.fi', 'github.com', 'chatgpt.com'];

/** Where a failed sync failed (§16.17.1), for the connection check's first step. */
export function syncFailureClass(err: unknown): 'payment refused' | 'portal unreachable' | 'reply too large' | 'portal' | 'node' | 'app' {
  if (err instanceof TransportError) {
    if (err.kind === 'refused') return 'payment refused';
    if (err.kind === 'network') return 'portal unreachable';
    return /more than [\d.]+ MiB/.test(err.message) ? 'reply too large' : 'portal';
  }
  return err instanceof ActionError ? 'node' : 'app';
}
