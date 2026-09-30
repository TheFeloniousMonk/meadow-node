// Notes and anchors (SPEC §16.19): local, private context an agent carries.
// Anchors are the person's alone (written only from the window); notes about
// other agents and rooms can be written by the person or by the AI through
// the `note` tool, and always say who wrote them. Sealed at rest; carried in
// the backup; never sent anywhere.

import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import type { Vault } from './vault.ts';
import type { Who } from './activity.ts';

export type NoteKind = 'anchor' | 'agent' | 'room';

export const NOTE_LIMITS = { chars: 500, anchors: 10, agentNotes: 500 };

export interface Note {
  id: string;
  kind: NoteKind;
  /** The agent ID or room ID it is about; '' for an anchor. */
  about: string;
  text: string;
  who: Who;
  at: number;
  /** Written by the AI and not yet seen by the person (§16.19.2). */
  unseen: boolean;
}

export class NoteError extends Error {}

export class Notes {
  #db: Db;
  #vault: Vault;
  #now: () => number;

  constructor({ db, vault, now = Date.now }: { db: Db; vault: Vault; now?: () => number }) {
    this.#db = db;
    this.#vault = vault;
    this.#now = now;
  }

  #row(agent: string, r: any): Note {
    return {
      id: r.id, kind: r.kind, about: r.about, who: r.who, at: r.at, unseen: r.acked === 0,
      text: this.#vault.openJson(`note:${agent}:${r.id}`, r.text_sealed).text,
    };
  }

  #check(text: string) {
    if (typeof text !== 'string') throw new NoteError('A note is text.');
    if ([...text].length > NOTE_LIMITS.chars) throw new NoteError(`A note is at most ${NOTE_LIMITS.chars} characters.`);
  }

  /** Every note and anchor, newest first. */
  list(agent: string, { kind, about }: { kind?: NoteKind; about?: string } = {}): Note[] {
    const where = ['agent = ?'];
    const args: any[] = [agent];
    if (kind) {
      where.push('kind = ?');
      args.push(kind);
    }
    if (about !== undefined) {
      where.push('about = ?');
      args.push(about);
    }
    return (this.#db.prepare(`SELECT * FROM notes WHERE ${where.join(' AND ')} ORDER BY at DESC, id`).all(...args) as any[]).map((r) => this.#row(agent, r));
  }

  anchors(agent: string): Note[] {
    return this.list(agent, { kind: 'anchor' }).reverse();
  }

  /** The one note about an agent or a room, or null. */
  get(agent: string, kind: 'agent' | 'room', about: string): Note | null {
    return this.list(agent, { kind, about })[0] ?? null;
  }

  /**
   * Sets or clears the note about an agent or a room (an empty text clears it). `who` is
   * the person or the AI's connection; a note the AI writes waits to be seen (§16.19.2).
   * Returns what happened, for the activity log.
   */
  set(agent: string, kind: 'agent' | 'room', about: string, text: string, who: Who): 'added' | 'changed' | 'removed' | 'unchanged' {
    this.#check(text);
    if (who === 'runner') throw new NoteError('The built-in runner can read notes but not write them.');
    const was = this.get(agent, kind, about);
    const trimmed = text.trim();
    if (!trimmed) {
      if (!was) return 'unchanged';
      this.#db.prepare('DELETE FROM notes WHERE agent = ? AND id = ?').run(agent, was.id);
      return 'removed';
    }
    if (was?.text === trimmed && was.who === who) return 'unchanged';
    if (!was && kind === 'agent' && (this.#db.prepare("SELECT COUNT(*) AS n FROM notes WHERE agent = ? AND kind = 'agent'").get(agent) as any).n >= NOTE_LIMITS.agentNotes) {
      throw new NoteError(`There can be at most ${NOTE_LIMITS.agentNotes} notes about other agents. Remove one first.`);
    }
    const id = was?.id ?? `n_${randomBytes(9).toString('base64url')}`;
    this.#db.prepare(`INSERT OR REPLACE INTO notes (agent, id, kind, about, text_sealed, who, at, acked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(agent, id, kind, about, this.#vault.sealJson(`note:${agent}:${id}`, { text: trimmed }), who, this.#now(), who === 'you' ? 1 : 0);
    return was ? 'changed' : 'added';
  }

  /** Adds or changes an anchor: the window's call only; no tool reaches it (§16.19.2). */
  setAnchor(agent: string, id: string | null, text: string): string {
    this.#check(text);
    const trimmed = text.trim();
    if (!trimmed) throw new NoteError('An anchor needs some text. To take it away, remove it.');
    if (id && !this.#db.prepare("SELECT 1 FROM notes WHERE agent = ? AND id = ? AND kind = 'anchor'").get(agent, id)) throw new NoteError('There is no such anchor.');
    if (!id && (this.#db.prepare("SELECT COUNT(*) AS n FROM notes WHERE agent = ? AND kind = 'anchor'").get(agent) as any).n >= NOTE_LIMITS.anchors) {
      throw new NoteError(`An agent has at most ${NOTE_LIMITS.anchors} anchors. Change or remove one first.`);
    }
    const key = id ?? `n_${randomBytes(9).toString('base64url')}`;
    // An anchor keeps its first time, so the list keeps its order when one is changed.
    // A new one always sorts after the others, even within the same millisecond.
    const last = (this.#db.prepare("SELECT MAX(at) AS at FROM notes WHERE agent = ? AND kind = 'anchor'").get(agent) as any).at ?? 0;
    const at = id ? (this.#db.prepare('SELECT at FROM notes WHERE agent = ? AND id = ?').get(agent, id) as any).at : Math.max(this.#now(), last + 1);
    this.#db.prepare(`INSERT OR REPLACE INTO notes (agent, id, kind, about, text_sealed, who, at, acked) VALUES (?, ?, 'anchor', '', ?, 'you', ?, 1)`)
      .run(agent, key, this.#vault.sealJson(`note:${agent}:${key}`, { text: trimmed }), at);
    return key;
  }

  /** Removes a note or an anchor (the window). */
  remove(agent: string, id: string): Note | null {
    const n = this.list(agent).find((x) => x.id === id) ?? null;
    if (n) this.#db.prepare('DELETE FROM notes WHERE agent = ? AND id = ?').run(agent, id);
    return n;
  }

  /** The person keeps a note the AI wrote: it becomes theirs (§16.19.4). */
  keep(agent: string, id: string) {
    this.#db.prepare("UPDATE notes SET who = 'you', acked = 1 WHERE agent = ? AND id = ? AND kind != 'anchor'").run(agent, id);
  }

  /** The person has seen the AI's notes (the card's notice). */
  seen(agent: string) {
    this.#db.prepare('UPDATE notes SET acked = 1 WHERE agent = ?').run(agent);
  }

  unseen(agent: string): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM notes WHERE agent = ? AND acked = 0').get(agent) as any).n;
  }
}
