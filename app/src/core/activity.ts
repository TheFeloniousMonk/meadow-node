// The activity log (SPEC §16.18): a local record of what changed for an agent
// and who caused it, in plain sentences for the person. Not a message archive
// (the Inbox has messages) and not the connection diagnostics (§16.17). Who is
// always what the app itself knows: the window, a connection, the runner, the
// network, or the app; never what a model or a message says.

import type { Db } from './db.ts';
import type { Via } from './diagnostics.ts';

export type Who = 'you' | 'claude' | 'chatgpt' | 'local' | 'runner' | 'network' | 'app';
export type ActivityKind = 'rooms' | 'received' | 'profile' | 'reports' | 'settings' | 'backups' | 'problems';

export const WHO_WORDS: Record<Who, string> = {
  you: 'You',
  claude: 'Your AI, in Claude',
  chatgpt: 'Your AI, in ChatGPT',
  local: 'Your AI, through the local interface',
  runner: 'The built-in runner',
  network: 'The network',
  app: 'The app',
};

/** Who a tool call's connection makes the actor (§16.18.2). */
export const whoOf = (via: Via): Who => (via === 'rest' ? 'local' : via);

const KINDS: ActivityKind[] = ['rooms', 'received', 'profile', 'reports', 'settings', 'backups', 'problems'];

export const KEEP_DAYS = 90;
export const KEEP_ENTRIES = 5_000;
const DAY = 24 * 3600 * 1000;

export interface ActivityEntry {
  at: number;
  who: Who;
  kind: ActivityKind;
  text: string;
  room: string | null;
  /** The sentence holds text other agents wrote (a room name, a note): fenced when the AI reads it. */
  ext: boolean;
}

export class Activity {
  #db: Db;
  #now: () => number;

  constructor({ db, now = Date.now }: { db: Db; now?: () => number }) {
    this.#db = db;
    this.#now = now;
  }

  /** Adds an entry, and keeps the log to 90 days or the newest 5,000 entries (§16.18.4). */
  add(agent: string, who: Who, kind: ActivityKind, text: string, { room, ext = false }: { room?: string | null; ext?: boolean } = {}) {
    const now = this.#now();
    // A quoted note that ends its own sentence needs no second full stop: “…here.” not “…here.”.
    text = text.replace(/([.!?…])”\.(\s|$)/g, '$1”$2');
    this.#db.prepare('INSERT OR IGNORE INTO activity (agent, at, who, kind, text, room, ext) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(agent, now, who, kind, text.slice(0, 600), room ?? null, ext ? 1 : 0);
    this.#db.prepare(`DELETE FROM activity WHERE agent = ? AND (at < ? OR seq NOT IN (SELECT seq FROM activity WHERE agent = ? ORDER BY at DESC, seq DESC LIMIT ?))`)
      .run(agent, now - KEEP_DAYS * DAY, agent, KEEP_ENTRIES);
  }

  /** Whether an entry of this kind and text was added for the agent within `ms` (for "at most one per hour" entries). */
  recent(agent: string, kind: ActivityKind, text: string, ms: number): boolean {
    return !!this.#db.prepare('SELECT 1 FROM activity WHERE agent = ? AND kind = ? AND text = ? AND at > ?').get(agent, kind, text, this.#now() - ms);
  }

  /** The agent's log, newest first. */
  list(agent: string, { kinds, who, since, rooms, limit = 500 }: { kinds?: ActivityKind[]; who?: Who[]; since?: number; rooms?: Set<string>; limit?: number } = {}): ActivityEntry[] {
    const where = ['agent = ?'];
    const args: any[] = [agent];
    if (kinds?.length) {
      where.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
      args.push(...kinds);
    }
    if (who?.length) {
      where.push(`who IN (${who.map(() => '?').join(', ')})`);
      args.push(...who);
    }
    if (since !== undefined) {
      where.push('at >= ?');
      args.push(since);
    }
    const rows = this.#db.prepare(`SELECT at, who, kind, text, room, ext FROM activity WHERE ${where.join(' AND ')} ORDER BY at DESC, seq DESC`).all(...args) as any[];
    // The runner sees only entries about the rooms it may act in (§16.18.3).
    const scoped = rooms ? rows.filter((r) => r.room && rooms.has(r.room)) : rows;
    return scoped.slice(0, limit).map((r) => ({ at: r.at, who: r.who, kind: r.kind, text: r.text, room: r.room, ext: !!r.ext }));
  }

  /** Every entry, oldest first, for the backup (§16.12). */
  all(agent: string): ActivityEntry[] {
    return this.list(agent, { limit: KEEP_ENTRIES }).reverse();
  }

  /**
   * A restore merges (§16.18.4, user 2026-09-30): the backup's entries are added to the
   * ones here, an entry in both is kept once, and nothing here is lost.
   */
  merge(agent: string, entries: unknown): number {
    if (!Array.isArray(entries)) return 0;
    const ins = this.#db.prepare('INSERT OR IGNORE INTO activity (agent, at, who, kind, text, room, ext) VALUES (?, ?, ?, ?, ?, ?, ?)');
    let n = 0;
    for (const e of entries as any[]) {
      if (!e || typeof e.at !== 'number' || !Object.hasOwn(WHO_WORDS, e.who) || !KINDS.includes(e.kind) || typeof e.text !== 'string') continue;
      n += Number(ins.run(agent, e.at, e.who, e.kind, e.text.slice(0, 600), typeof e.room === 'string' ? e.room : null, e.ext ? 1 : 0).changes);
    }
    return n;
  }
}
