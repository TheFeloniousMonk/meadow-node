// Event Mode (SPEC §16.25): for a set time, background receiving runs at a faster frequency, then
// the normal schedule resumes on its own. Off by default and after every event: it raises cost.
// The countdown ends at a clock time, so a closed app, sleep, or a restart does not stop it; a
// paused event keeps its remaining time instead. Kept in one meta row.

import type { Db } from '../core/db.ts';

export const EVENT_FREQUENCIES = [10, 5, 2, 1] as const;
/** Durations in minutes: 1 hour to 8 hours in quarter hours. */
export const EVENT_DURATIONS = Array.from({ length: 29 }, (_, i) => 60 + i * 15);
export const EVENT_DEFAULTS = { frequency: 5, duration: 60 };

export interface EventModeView {
  on: boolean;
  paused: boolean;
  /** Minutes between checks, and the event's length in minutes, as chosen. */
  frequency: number;
  duration: number;
  /** While running: when it ends (ms). While paused: the time left (ms). */
  endsAt: number | null;
  remainingMs: number | null;
}

interface Stored {
  frequency: number;
  duration: number;
  on: boolean;
  paused: boolean;
  endsAt: number | null;
  remainingMs: number | null;
}

const KEY = 'event_mode';

export class EventMode {
  #db: Db;
  #now: () => number;

  constructor({ db, now = Date.now }: { db: Db; now?: () => number }) {
    this.#db = db;
    this.#now = now;
  }

  #read(): Stored {
    const r = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY) as { value: string } | undefined;
    const off: Stored = { ...EVENT_DEFAULTS, on: false, paused: false, endsAt: null, remainingMs: null };
    if (!r) return off;
    try {
      return { ...off, ...JSON.parse(r.value) };
    } catch {
      return off;
    }
  }

  #write(s: Stored) {
    this.#db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(s));
  }

  view(): EventModeView {
    const s = this.#read();
    return { on: s.on, paused: s.paused, frequency: s.frequency, duration: s.duration, endsAt: s.on && !s.paused ? s.endsAt : null, remainingMs: s.on && s.paused ? s.remainingMs : null };
  }

  /** The frequency in force now, or null when Event Mode is not speeding receiving up (off, paused, or past its end). */
  activeFrequency(): number | null {
    const s = this.#read();
    return s.on && !s.paused && s.endsAt !== null && this.#now() < s.endsAt ? s.frequency : null;
  }

  /** Whether a running event has reached its end and should be ended (with its notification). */
  due(): boolean {
    const s = this.#read();
    return s.on && !s.paused && s.endsAt !== null && this.#now() >= s.endsAt;
  }

  /**
   * Chooses the frequency and the duration. A new frequency applies at once; a new duration while
   * it is on restarts the countdown at the new length (running or paused as it was).
   */
  choose({ frequency, duration }: { frequency?: number; duration?: number }) {
    const s = this.#read();
    if (frequency !== undefined) {
      if (!(EVENT_FREQUENCIES as readonly number[]).includes(frequency)) throw new Error('Choose 10, 5, 2, or 1 minutes.');
      s.frequency = frequency;
    }
    if (duration !== undefined && duration !== s.duration) {
      if (!EVENT_DURATIONS.includes(duration)) throw new Error('Choose a duration from 1 hour to 8 hours, in quarter hours.');
      s.duration = duration;
      if (s.on) this.#restart(s);
    }
    this.#write(s);
  }

  start() {
    const s = this.#read();
    s.on = true;
    s.paused = false;
    this.#restart(s);
    this.#write(s);
  }

  stop() {
    const s = this.#read();
    Object.assign(s, { on: false, paused: false, endsAt: null, remainingMs: null });
    this.#write(s);
  }

  pause() {
    const s = this.#read();
    if (!s.on || s.paused || s.endsAt === null) throw new Error('Event Mode is not running.');
    Object.assign(s, { paused: true, remainingMs: Math.max(0, s.endsAt - this.#now()), endsAt: null });
    this.#write(s);
  }

  resume() {
    const s = this.#read();
    if (!s.on || !s.paused) throw new Error('Event Mode is not paused.');
    Object.assign(s, { paused: false, endsAt: this.#now() + (s.remainingMs ?? s.duration * 60_000), remainingMs: null });
    this.#write(s);
  }

  /** Back to the full duration, running or paused as it was. */
  reset() {
    const s = this.#read();
    if (!s.on) throw new Error('Event Mode is off.');
    this.#restart(s);
    this.#write(s);
  }

  #restart(s: Stored) {
    const full = s.duration * 60_000;
    if (s.paused) Object.assign(s, { remainingMs: full, endsAt: null });
    else Object.assign(s, { endsAt: this.#now() + full, remainingMs: null });
  }
}
