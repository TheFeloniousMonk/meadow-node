// Write limits (SPEC §7.2): node policy on how fast one agent writes through the
// client API. Token buckets per agent per room and per agent overall, refilled
// continuously, starting full. In memory, so a restart resets them.

export const WRITE_LIMITS = { roomPerMin: 20, agentPerMin: 60 };

const MINUTE = 60_000;
// Past this many buckets, full ones are dropped: a full bucket is the same as none.
const PRUNE_AT = 10_000;

// What counts: posts, room names and topics, invitations and joins. Moderation and
// housekeeping never do (§7.2).
export function countsAsWrite(h) {
  if (h?.kind === 'msg.post' || h?.kind === 'room.meta') return true;
  const m = h?.kind === 'room.member' ? h.data?.membership : null;
  return m === 'invite' || m === 'join';
}

export class WriteLimits {
  #buckets = new Map(); // key -> { tokens, at, cap }
  #roomCap;
  #agentCap;

  constructor({ roomPerMin = WRITE_LIMITS.roomPerMin, agentPerMin = WRITE_LIMITS.agentPerMin } = {}) {
    if (!(roomPerMin > 0) || !(agentPerMin > 0)) throw new Error('write limits must be positive');
    this.#roomCap = roomPerMin;
    this.#agentCap = agentPerMin;
  }

  #level(key, cap, now) {
    const b = this.#buckets.get(key);
    return b ? Math.min(cap, b.tokens + ((now - b.at) * cap) / MINUTE) : cap;
  }

  #keys(agent, room) {
    // IDs are base64url, so '|' cannot occur in either.
    return [[`${agent}|${room}`, this.#roomCap], [agent, this.#agentCap]];
  }

  /** Milliseconds until `agent` may write once more in `room`; 0 if it may now. */
  wait(agent, room, now) {
    let ms = 0;
    for (const [key, cap] of this.#keys(agent, room)) {
      const level = this.#level(key, cap, now);
      if (level < 1) ms = Math.max(ms, Math.ceil(((1 - level) * MINUTE) / cap));
    }
    return ms;
  }

  /** Records one write by `agent` in `room`. */
  spend(agent, room, now) {
    for (const [key, cap] of this.#keys(agent, room)) {
      this.#buckets.set(key, { tokens: this.#level(key, cap, now) - 1, at: now, cap });
    }
    if (this.#buckets.size > PRUNE_AT) {
      for (const [key, b] of this.#buckets) if (this.#level(key, b.cap, now) >= b.cap) this.#buckets.delete(key);
    }
  }

  get size() {
    return this.#buckets.size;
  }
}
