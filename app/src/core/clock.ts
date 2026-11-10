// The network's time (SPEC §16.28). A node refuses a request whose time is more
// than 2 minutes from its own (§7.1), and a payment's window is checked against
// the chain's time, so both are signed with this computer's clock corrected by
// the offset every portal answer shows in its Date header. Local records
// (budgets, activity, schedules) keep the computer's own time.

/** Offsets smaller than this are noise: the Date header has one-second resolution, and nothing checks time this finely. */
export const CLOCK_NOISE_MS = 10_000;

export class NetworkClock {
  #local: () => number;
  #offset = 0;
  #seenAt: number | null = null;

  constructor(local: () => number = Date.now) {
    this.#local = local;
  }

  /** This computer's own time. */
  local(): number {
    return this.#local();
  }

  /** The network's time now, as well as the app knows it. */
  now(): number {
    return this.#local() + this.#offset;
  }

  /** The network's time minus this computer's, in ms; 0 when within the noise. */
  offset(): number {
    return this.#offset;
  }

  /** When an answer last told the time (this computer's clock), or null. */
  seenAt(): number | null {
    return this.#seenAt;
  }

  /**
   * Takes the time from an answer's Date header. `sentAt` and `receivedAt` are this computer's
   * clock around the request: the header describes about the midpoint. Returns whether the
   * offset moved by the noise or more, so a request signed before should be signed again.
   */
  observe(date: string | null | undefined, sentAt: number, receivedAt: number): boolean {
    if (!date) return false;
    const server = Date.parse(date);
    if (!Number.isFinite(server) || receivedAt < sentAt) return false;
    // The header is truncated to the second: its true time is half a second later on average.
    const raw = server + 500 - (sentAt + receivedAt) / 2;
    const next = Math.abs(raw) < CLOCK_NOISE_MS ? 0 : Math.round(raw);
    const moved = Math.abs(next - this.#offset) >= CLOCK_NOISE_MS;
    if (moved || next === 0) this.#offset = next;
    this.#seenAt = receivedAt;
    return moved;
  }

  /** For tests: forget what answers said, and optionally stand in for this computer's clock. */
  reset(local: () => number = Date.now) {
    this.#local = local;
    this.#offset = 0;
    this.#seenAt = null;
  }
}

/** The app's one network clock: the portal transport sets it, and signing reads it. */
export const networkClock = new NetworkClock();

/** How far off this computer's clock is, in plain words, or null when it is right (§16.28). */
export function clockWords(offsetMs: number): string | null {
  if (Math.abs(offsetMs) < 60_000) return null;
  const minutes = Math.round(Math.abs(offsetMs) / 60_000);
  const amount = minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  // The offset is the network minus this computer: positive means this computer is behind.
  return `This computer's clock is ${amount} ${offsetMs > 0 ? 'slow' : 'fast'}.`;
}
