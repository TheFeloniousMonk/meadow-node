// MessageGuard (SPEC §16.11): screens new messages for prompt injection
// before the AI sees them, with the portal's prompt-injection detection
// service. Off by default; the person turns it on for public rooms, and
// separately for private rooms and DMs, whose decrypted text it then sends to
// the service.
//
// Batched per sync: all new messages go in one call, clearly delimited. If
// that says safe, all are delivered. Otherwise each is checked in its own call,
// up to a per-sync limit: safe is delivered, suspicious is delivered with the
// verdict, malicious is kept aside for the person. A message not checked (the
// budget ran out, the limit was reached, or the answer could not be read) is
// delivered, marked unchecked: never marked safe.

import type { Db } from './db.ts';
import type { Vault } from './vault.ts';
import { TransportError } from './transport.ts';

export const GUARD_SERVICE = 'prompt-injection-detect';
export const GUARD_PATH = '/v1/prompt';
/** The most text sent in one call; a larger batch is split. */
export const GUARD_BATCH_CHARS = 30_000;

export type Verdict = 'safe' | 'suspicious' | 'malicious';
export interface Screen {
  verdict: Verdict;
  matches: { label: string; match: string }[];
  ruleset?: string;
}

/** Sends text to the screening service as `agent`, paid from its wallet; null if the answer cannot be read. */
export type Screener = (text: string, agent: string) => Promise<Screen | null>;

export interface GuardSettings {
  public: boolean;
  private: boolean;
  perSyncLimit: number;
}

/**
 * The service's answer, read defensively: its shape is its own (the catalog
 * does not pin it). The live service (ruleset inj-rules-v2.0, 2026-09-29) says
 * no_known_pattern when no rule matched, which it notes is not a promise of
 * safety; the app shows that as "no known tricks found" (§16.11).
 */
export function readScreen(data: any): Screen | null {
  if (data?.verdict === 'no_known_pattern') data = { ...data, verdict: 'safe' };
  if (!data || !['safe', 'suspicious', 'malicious'].includes(data.verdict)) return null;
  const matches = Array.isArray(data.matches)
    ? data.matches.filter((m: any) => m && typeof m.label === 'string').map((m: any) => ({ label: m.label, match: typeof m.match === 'string' ? m.match.slice(0, 200) : '' }))
    : [];
  return { verdict: data.verdict, matches, ...(typeof data.ruleset === 'string' && { ruleset: data.ruleset }) };
}

export interface GuardReport {
  calls: number;
  safe: number;
  suspicious: number;
  held: number;
  unchecked: number;
  stopped?: string;
}

export class MessageGuard {
  #db: Db;
  #vault: Vault;
  #screen: Screener;
  #settings: () => GuardSettings;

  constructor({ db, vault, screener, settings }: { db: Db; vault: Vault; screener: Screener; settings: () => GuardSettings }) {
    this.#db = db;
    this.#vault = vault;
    this.#screen = screener;
    this.#settings = settings;
  }

  #text(agent: string, id: string, sealed: Uint8Array): string {
    return this.#vault.openJson(`message:${agent}:${id}`, sealed).body.text as string;
  }

  #set(agent: string, id: string, guard: string, matches: Screen['matches'] = [], held = false) {
    this.#db.prepare('UPDATE messages SET guard = ?, guard_matches = ?, held = ? WHERE agent = ? AND id = ?')
      .run(guard, matches.length ? JSON.stringify(matches) : null, held ? 1 : 0, agent, id);
  }

  /** Screens every new message from others that MessageGuard covers, and not yet screened. */
  async screenNew(agent: string): Promise<GuardReport> {
    const s = this.#settings();
    const report: GuardReport = { calls: 0, safe: 0, suspicious: 0, held: 0, unchecked: 0 };
    const types = [...(s.public ? ['public'] : []), ...(s.private ? ['private', 'dm'] : [])];
    if (!types.length) return report;
    const rows = this.#db.prepare(`SELECT m.id, m.author, m.body_sealed FROM messages m JOIN rooms r ON r.agent = m.agent AND r.room = m.room
      WHERE m.agent = ? AND m.author != ? AND m.status = 'shown' AND m.guard IS NULL AND m.delivered = 0 AND m.body_sealed IS NOT NULL
        AND r.type IN (${types.map(() => '?').join(', ')}) ORDER BY m.ts, m.id`).all(agent, agent, ...types) as any[];
    if (!rows.length) return report;
    const texts = rows.map((r) => ({ id: r.id as string, text: this.#text(agent, r.id, r.body_sealed) }));

    const call = async (text: string): Promise<Screen | null | 'refused'> => {
      try {
        report.calls++;
        return await this.#screen(text, agent);
      } catch (err) {
        report.calls--;
        if (err instanceof TransportError) {
          report.stopped = err.message;
          return 'refused';
        }
        throw err;
      }
    };
    const unchecked = (ids: string[]) => ids.forEach((id) => {
      this.#set(agent, id, 'unchecked');
      report.unchecked++;
    });

    // One call per batch of whole messages, each clearly delimited.
    const batches: { id: string; text: string }[][] = [];
    for (const t of texts) {
      const last = batches.at(-1);
      const size = last ? last.reduce((n, x) => n + x.text.length + 60, 0) : Infinity;
      if (last && size + t.text.length + 60 <= GUARD_BATCH_CHARS) last.push(t);
      else batches.push([t]);
    }
    const needSingles: { id: string; text: string }[] = [];
    for (const batch of batches) {
      if (report.stopped) {
        unchecked(batch.map((t) => t.id));
        continue;
      }
      const joined = batch.map((t, i) => `----- Message ${i + 1} of ${batch.length} -----\n${t.text}`).join('\n\n');
      const r = await call(joined);
      if (r === 'refused' || r === null) unchecked(batch.map((t) => t.id));
      else if (r.verdict === 'safe') batch.forEach((t) => {
        this.#set(agent, t.id, 'safe');
        report.safe++;
      });
      else needSingles.push(...batch);
    }

    // A batch that was not safe: each message on its own, up to the limit.
    for (const [i, t] of needSingles.entries()) {
      if (report.stopped || i >= s.perSyncLimit) {
        unchecked([t.id]);
        continue;
      }
      const r = await call(t.text);
      if (r === 'refused' || r === null) unchecked([t.id]);
      else if (r.verdict === 'safe') {
        this.#set(agent, t.id, 'safe');
        report.safe++;
      } else if (r.verdict === 'suspicious') {
        this.#set(agent, t.id, 'suspicious', r.matches);
        report.suspicious++;
      } else {
        this.#set(agent, t.id, 'malicious', r.matches, true);
        report.held++;
      }
    }
    return report;
  }

  /**
   * The person's "Check for prompt injection" on one message (§16.10.2), on or
   * off: a paid call from the agent's wallet. A malicious verdict on a message
   * the agent has not been given yet keeps it aside.
   */
  async checkOne(agent: string, id: string): Promise<Screen | null> {
    const m: any = this.#db.prepare('SELECT body_sealed, delivered, status FROM messages WHERE agent = ? AND id = ?').get(agent, id);
    if (!m?.body_sealed || m.status !== 'shown') throw new Error('Only a message with readable text can be checked.');
    const r = await this.#screen(this.#text(agent, id, m.body_sealed), agent);
    if (r) this.#set(agent, id, r.verdict, r.matches, r.verdict === 'malicious' && !m.delivered);
    return r;
  }

  /** The person releases a held message to the agent, or keeps it held (§16.10.2). */
  decide(agent: string, id: string, release: boolean) {
    this.#db.prepare('UPDATE messages SET held = ? WHERE agent = ? AND id = ? AND held != 0').run(release ? 0 : 2, agent, id);
  }
}
