// The window's health, for safe mode (SPEC §16.26.7). Two kinds of trouble count: a start that never
// finished (the window began loading but never said it was ready: a freeze that ended in the app
// being closed), and a crash or freeze while running. Two unfinished starts, or two failures within
// ten minutes, mean safe mode: every plugin off until the person turns them back on. Kept in a small
// file beside the database (no message text, ever), so it survives the app being killed.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FAILURE_WINDOW_MS = 10 * 60_000;

export interface Trouble {
  at: number;
  reason: string;
  /** The plugin type involved, when the window could tell (an embed that failed). */
  type?: string;
}

interface Health {
  /** Window starts since the last one that finished. */
  pending: number;
  /** Crashes and freezes while running, recent ones only. */
  failures: number[];
  last: Trouble | null;
  /** The last embed that failed to show, for Troubleshoot. */
  lastEmbed: (Trouble & { message?: string }) | null;
}

export interface SafeModeState {
  on: boolean;
  /** Why it is on: in plain words. */
  reason: string | null;
  last: Trouble | null;
}

export class WindowHealth {
  #file: string | null;
  #now: () => number;
  #mem: Health = { pending: 0, failures: [], last: null, lastEmbed: null };
  safe: SafeModeState = { on: false, reason: null, last: null };

  constructor({ dir, now = Date.now }: { dir: string | null; now?: () => number }) {
    this.#file = dir ? join(dir, 'window-health.json') : null;
    this.#now = now;
    if (this.#file) {
      try {
        this.#mem = { ...this.#mem, ...JSON.parse(readFileSync(this.#file, 'utf8')) };
      } catch {
        // No record yet, or an unreadable one: start clean.
      }
    }
  }

  #save() {
    if (!this.#file) return;
    try {
      writeFileSync(`${this.#file}.tmp`, JSON.stringify(this.#mem));
      renameSync(`${this.#file}.tmp`, this.#file);
    } catch {
      // A health record that cannot be written must never stop the app.
    }
  }

  #recent() {
    const since = this.#now() - FAILURE_WINDOW_MS;
    return this.#mem.failures.filter((t) => t >= since);
  }

  /** At app start: safe mode when asked for (--safe-mode), or when the window kept failing. Counters then start again. */
  start({ asked }: { asked: boolean }): SafeModeState {
    const unfinished = this.#mem.pending >= 2;
    const failing = this.#recent().length >= 2;
    const reason = asked ? 'you asked Meadow to start without plugins'
      : unfinished ? 'the window did not finish starting twice in a row'
        : failing ? 'the window stopped working twice in a few minutes' : null;
    this.safe = { on: reason !== null, reason, last: reason ? this.#mem.last : null };
    if (unfinished || failing) {
      this.#mem.pending = 0;
      this.#mem.failures = [];
      this.#save();
    }
    return this.safe;
  }

  /** The window starts loading. */
  loading() {
    this.#mem.pending += 1;
    this.#save();
  }

  /** The window says it has finished starting. */
  ready() {
    if (this.#mem.pending === 0) return;
    this.#mem.pending = 0;
    this.#save();
  }

  /**
   * The window crashed or froze. Returns whether this calls for safe mode now (the second
   * within ten minutes), in which case safe mode is on from here, for this run.
   */
  failure(reason: string): boolean {
    const t: Trouble = { at: this.#now(), reason, ...(this.#mem.lastEmbed && this.#now() - this.#mem.lastEmbed.at < 60_000 && { type: this.#mem.lastEmbed.type }) };
    this.#mem.last = t;
    this.#mem.failures = [...this.#recent(), t.at];
    this.#mem.pending = 0; // the window is loaded again from scratch
    const now = this.#mem.failures.length >= 2 && !this.safe.on;
    if (now) {
      this.safe = { on: true, reason: 'the window stopped working twice in a few minutes', last: t };
      this.#mem.failures = [];
    }
    this.#save();
    return now;
  }

  /** An embed failed to show (its error boundary caught it). */
  embedFailed(type: string, message: string) {
    this.#mem.lastEmbed = { at: this.#now(), reason: 'an embed failed to show', type, message: message.slice(0, 300) };
    this.#save();
  }

  lastEmbed() {
    return this.#mem.lastEmbed;
  }

  lastTrouble() {
    return this.#mem.last;
  }
}
