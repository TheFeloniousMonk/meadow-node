// The person's tunnel (SPEC §16.7.2): how ChatGPT, which reaches only remote
// MCP servers over HTTPS, gets to the tunneled interface on this computer. The
// project hosts nothing in between.
//
// - ngrok (the default): the app opens the tunnel itself with ngrok's official
//   SDK and the person's own token. A free ngrok account has one permanent
//   address ngrok assigns (for example something.ngrok-free.app), no time
//   limit, and 20,000 requests a month (ngrok's free plan limits, 2026-09-29).
// - custom (advanced): the person runs their own tunnel, such as a Cloudflare
//   named tunnel to their own domain, pointed at the tunneled interface's
//   port, and tells the app its public address.
//
// The tunnel is watched, not assumed (§16.17.8). Its state says what the app
// last confirmed: that a request through the public address reached this app.
// - The reachability check: one GET of the app's own sign-in metadata through
//   the address (one request against ngrok's monthly limit). It runs after a
//   start, a wake, heartbeats returning, and a passing Test connection; never
//   on a timer.
// - The local watch, free: ngrok's heartbeats and disconnection signal, and a
//   loopback request to the door every minute.
// - When a check fails, an ngrok tunnel is restarted (same token, same
//   permanent address) and checked again: at most 4 restarts per wake or
//   disconnect, retried at 10 s, 30 s, 2 min and 5 min after a wake. One chain
//   serializes every check and restart, the button's too.

export type TunnelProvider = 'none' | 'ngrok' | 'custom';
export type TunnelState = 'off' | 'starting' | 'on' | 'reconnecting' | 'unreachable' | 'error';

export interface TunnelStatus {
  provider: TunnelProvider;
  state: TunnelState;
  /** The public address, kept from ngrok's first answer until the tunnel is off or fails with `error`. */
  url: string | null;
  error: string | null;
  /** When a check through the address last passed. */
  reachedAt: number | null;
  /** What came back from the last failed check. */
  why: string | null;
  /** Restarts in the current episode. */
  restarts: number;
  /** True while the app is still restarting and checking. */
  trying: boolean;
  /** The wake that began the current episode, if one did. */
  wokeAt: number | null;
  /** ngrok kept refusing the address as already open, past 2 minutes (ERR_NGROK_334). */
  heldElsewhere: boolean;
  /** The loopback check of the door; null before the first. */
  door: { ok: boolean; why: string | null; at: number } | null;
}

/** An open ngrok session with its one HTTP endpoint. */
export interface NgrokSession {
  url: string;
  close(): Promise<void>;
}

/** Opens an ngrok session forwarding to the door; the callbacks are the local watch. */
export type NgrokOpener = (o: { token: string; port: number; onHeartbeat(ms: number): void; onDisconnect(error: string): void }) => Promise<NgrokSession>;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  every(fn: () => void, ms: number): unknown;
  stop(handle: unknown): void;
}

export const WATCH = {
  /** Heartbeat interval and tolerance, in seconds, set by the app; also ngrok's documented defaults (2026-10-01). */
  beatInterval: 10,
  beatTolerance: 15,
  /** No heartbeat answer for this long: the session is dead. */
  beatsLostMs: 30_000,
  /** Reconnecting for longer than this: the app restarts it. */
  reconnectingMs: 60_000,
  watchdogMs: 5_000,
  doorEveryMs: 60_000,
  /** When each attempt runs, from the start of an episode: after a wake, and after anything else. */
  wakeDelays: [10_000, 30_000, 120_000, 300_000],
  otherDelays: [0, 30_000, 120_000, 300_000],
  heldRetryMs: 20_000,
  heldGiveUpMs: 120_000,
  timeoutMs: 10_000,
};

// Unref'd: the watch never keeps a process alive by itself (the app's own life is the tray's).
const realTimers: Timers = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clear: (h) => clearTimeout(h as any),
  every: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  },
  stop: (h) => clearInterval(h as any),
};

/** ngrok's official SDK: a session with the app's heartbeat settings and handlers, then one HTTP endpoint. */
export const openNgrok: NgrokOpener = async ({ token, port, onHeartbeat, onDisconnect }) => {
  const ngrok = await import('@ngrok/ngrok');
  const session = await new ngrok.SessionBuilder()
    .authtoken(token)
    .heartbeatInterval(WATCH.beatInterval)
    .heartbeatTolerance(WATCH.beatTolerance)
    // The latency comes in milliseconds; take the last number given, whatever the binding passes first.
    .handleHeartbeat((...a: unknown[]) => onHeartbeat(Number([...a].reverse().find((x) => typeof x === 'number') ?? 0)))
    .handleDisconnection((_addr: string, error: string) => {
      onDisconnect(String(error ?? ''));
      return true; // keep reconnecting by itself
    })
    .connect();
  try {
    const listener = await session.httpEndpoint().listenAndForward(`http://127.0.0.1:${port}`);
    const url = listener.url();
    if (!url) throw new Error('ngrok gave no address');
    return {
      url: url.replace(/\/+$/, ''),
      close: async () => {
        await listener.close().catch(() => {});
        await session.close().catch(() => {});
      },
    };
  } catch (err) {
    await session.close().catch(() => {});
    throw err;
  }
};

/** In the app's words: what answered at the address instead of this app. */
export async function describeAnswer(res: Response): Promise<string> {
  const text = (await res.text().catch(() => '')).slice(0, 4000);
  const ngrok = /ERR_NGROK_\d+/.exec(text)?.[0];
  if (ngrok) return `the tunnel's own error page (${ngrok}): the tunnel is not reaching this app`;
  return `an answer that is not this app's (HTTP ${res.status})`;
}

/** In the app's words: why a request got no answer. */
export function describeFailure(err: unknown): string {
  const e = err as any;
  return e?.name === 'TimeoutError' ? 'no answer within 10 seconds' : `it could not be reached (${e?.cause?.code ?? e?.message ?? 'unknown error'})`;
}

class Stale extends Error {}
class TokenRefused extends Error {}
class HeldElsewhere extends Error {}

const TOKEN_REFUSED = 'ngrok did not accept the token. Copy it again from your ngrok dashboard.';
const isTokenError = (m: string) => /authtoken|authentication|ERR_NGROK_10[57]\b/i.test(m);

type Reason = 'wake' | 'start' | 'reconnected' | 'reconnecting';

export class Tunnel {
  #status: TunnelStatus = Tunnel.#initial('none', 'off');
  #config: { provider: TunnelProvider; port: number; ngrokToken?: string | null; customUrl?: string | null } | null = null;
  #session: NgrokSession | null = null;
  #changed: () => void;
  #event: (what: string, detail?: string) => void;
  #open: NgrokOpener;
  #now: () => number;
  #timers: Timers;
  /** The fetch for checks through the public address; tests reach the door with their own. */
  fetchImpl: typeof fetch;
  /** The fetch for the loopback door check. */
  doorFetch: typeof fetch;
  #epoch = 0;
  #chain: Promise<unknown> = Promise.resolve();
  #watchers: unknown[] = [];
  #lastBeat = 0;
  #reconnectingSince = 0;
  #episode: { reason: Reason; timer: unknown } | null = null;

  constructor(opts: { changed(): void; event?(what: string, detail?: string): void; open?: NgrokOpener; fetch?: typeof fetch; doorFetch?: typeof fetch; now?(): number; timers?: Timers }) {
    this.#changed = opts.changed;
    this.#event = opts.event ?? (() => {});
    this.#open = opts.open ?? openNgrok;
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
    this.doorFetch = opts.doorFetch ?? ((...a) => fetch(...a));
    this.#now = opts.now ?? Date.now;
    this.#timers = opts.timers ?? realTimers;
  }

  static #initial(provider: TunnelProvider, state: TunnelState): TunnelStatus {
    return { provider, state, url: null, error: null, reachedAt: null, why: null, restarts: 0, trying: false, wokeAt: null, heldElsewhere: false, door: null };
  }

  get status(): TunnelStatus {
    return { ...this.#status, door: this.#status.door && { ...this.#status.door } };
  }

  /** The public address, in every state from the first address until off or `error`, so the door keeps answering and checks can pass. */
  get url(): string | null {
    return this.#status.state === 'off' || this.#status.state === 'error' ? null : this.#status.url;
  }

  #set(s: Partial<TunnelStatus>) {
    this.#status = { ...this.#status, ...s };
    this.#changed();
  }

  /** Runs `fn` after every check or restart already queued, so no two overlap. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  /** Resolves once every queued check and restart has finished (tests). */
  async settled(): Promise<void> {
    let seen: Promise<unknown>;
    do {
      seen = this.#chain;
      await seen;
    } while (seen !== this.#chain);
  }

  #sleep(ms: number, epoch: number): Promise<void> {
    return new Promise((resolve, reject) => this.#timers.set(() => (epoch === this.#epoch ? resolve() : reject(new Stale())), ms));
  }

  async start(cfg: { provider: TunnelProvider; port: number; ngrokToken?: string | null; customUrl?: string | null }) {
    await this.stop();
    const epoch = this.#epoch;
    this.#config = cfg;
    const { provider } = cfg;
    if (provider === 'none') return this.#set(Tunnel.#initial(provider, 'off'));
    if (provider === 'custom') {
      let url: string;
      try {
        const u = new URL(cfg.customUrl ?? '');
        if (u.protocol !== 'https:') throw new Error();
        url = u.origin;
      } catch {
        return this.#set({ ...Tunnel.#initial(provider, 'error'), error: 'Enter your tunnel\'s public address, starting with https://.' });
      }
      this.#set({ ...Tunnel.#initial(provider, 'starting'), url });
      this.#watch(epoch);
      return void this.#single('start', epoch);
    }
    if (!cfg.ngrokToken) return this.#set({ ...Tunnel.#initial(provider, 'error'), error: 'Paste your ngrok authtoken first.' });
    this.#set(Tunnel.#initial(provider, 'starting'));
    try {
      await this.#serial(() => this.#openSession(epoch));
    } catch (err) {
      if (err instanceof Stale) return;
      if (err instanceof HeldElsewhere) {
        this.#set({ state: 'unreachable', heldElsewhere: true, why: 'ngrok says the address is already open' });
        return this.#watch(epoch);
      }
      const message = err instanceof Error ? err.message : String(err);
      return this.#set({ state: 'error', url: null, error: err instanceof TokenRefused ? TOKEN_REFUSED : `ngrok could not start: ${message}` });
    }
    this.#watch(epoch);
    void this.#single('start', epoch);
  }

  async stop() {
    this.#epoch++;
    for (const w of this.#watchers) this.#timers.stop(w);
    this.#watchers = [];
    this.#endEpisode();
    const s = this.#session;
    this.#session = null;
    if (s) await s.close().catch(() => {});
  }

  /** The computer woke or the screen was unlocked: check again, 10 seconds later, and restart if needed. */
  wake() {
    const p = this.#status.provider;
    if (p === 'none' || this.#status.state === 'off' || this.#status.state === 'error') return;
    this.#event('wake');
    const epoch = this.#epoch;
    // The heartbeat clock stood still while asleep; the wake's own checks decide now.
    this.#lastBeat = this.#now();
    this.#endEpisode();
    this.#set({ wokeAt: this.#now(), restarts: 0 });
    this.#begin('wake', epoch, false);
  }

  /**
   * A check now, for Troubleshoot (§16.21.4): one request through the address. A failure
   * starts the same restarts as any failed check. Resolves with what came back.
   */
  async checkNow(): Promise<{ ok: boolean; why: string | null }> {
    if (!this.url) return { ok: false, why: this.#status.error ?? 'the tunnel is not on' };
    const epoch = this.#epoch;
    try {
      return await this.#serial(async () => {
        if (this.#episode) return { ok: false, why: this.#status.why }; // already being fixed
        const r = await this.#check(epoch);
        if (r.ok) {
          this.#reached();
          return { ok: true, why: null };
        }
        this.#set({ why: r.why });
        this.#begin('reconnected', epoch, true);
        return { ok: false, why: r.why };
      });
    } catch {
      return { ok: false, why: 'the tunnel was changed while it was checked' };
    }
  }

  /** Test connection passed through the address (§16.17.3): it counts as a check. */
  confirm() {
    if (this.url) this.#reached();
  }

  /** Restart tunnel (§16.17.8): one restart and check, now, after anything already running. */
  async restart(): Promise<{ ok: boolean; text: string }> {
    if (this.#status.provider !== 'ngrok' || !this.#config) return { ok: false, text: 'Only an ngrok tunnel can be restarted from here. Restart your own tunnel program instead.' };
    const epoch = this.#epoch;
    this.#endEpisode();
    this.#set({ restarts: 0, wokeAt: null, heldElsewhere: false, trying: true });
    try {
      return await this.#serial(async () => {
        const opened = await this.#restartOnce('pressed', epoch);
        const r = opened ? await this.#check(epoch) : { ok: false, why: this.#status.why ?? 'ngrok could not start' };
        if (r.ok) {
          this.#reached();
          return { ok: true, text: 'The tunnel is back and reaches this app.' };
        }
        this.#set({ state: 'unreachable', why: r.why, trying: false });
        return { ok: false, text: `The tunnel restarted but still does not reach this app: ${r.why}.` };
      });
    } catch (err) {
      if (err instanceof TokenRefused) return { ok: false, text: TOKEN_REFUSED };
      if (err instanceof HeldElsewhere) return { ok: false, text: 'Your ngrok address is open somewhere else, perhaps on another computer. Close it there, then press Restart tunnel.' };
      return { ok: false, text: 'The tunnel was changed while it restarted.' };
    }
  }

  // ---- The local watch ----

  #watch(epoch: number) {
    if (this.#status.provider === 'ngrok') {
      this.#lastBeat = this.#now();
      this.#watchers.push(this.#timers.every(() => this.#watchdog(epoch), WATCH.watchdogMs));
    }
    this.#watchers.push(this.#timers.every(() => void this.#checkDoor(epoch), WATCH.doorEveryMs));
    void this.#checkDoor(epoch);
  }

  #beat(epoch: number) {
    if (epoch !== this.#epoch) return;
    this.#lastBeat = this.#now();
    if (this.#status.state === 'reconnecting' && !this.#episode) {
      this.#event('reconnected');
      void this.#single('reconnected', epoch);
    }
  }

  #lost(epoch: number, what: string) {
    if (epoch !== this.#epoch || this.#status.state === 'reconnecting' || this.#status.state === 'off' || this.#status.state === 'error') return;
    if (this.#episode) return; // a restart in progress closes sessions on purpose
    this.#reconnectingSince = this.#now();
    this.#event('lost', what);
    this.#set({ state: 'reconnecting' });
  }

  #watchdog(epoch: number) {
    // With no session (the address held elsewhere, or restarts spent without one opening) there are no
    // heartbeats to miss: only a wake or Restart tunnel tries again, as §16.17.8 limits the restarts.
    if (epoch !== this.#epoch || this.#episode || !this.#session) return;
    const now = this.#now();
    if (this.#status.state === 'reconnecting') {
      if (now - this.#reconnectingSince > WATCH.reconnectingMs) this.#begin('reconnecting', epoch, true);
    } else if (now - this.#lastBeat > WATCH.beatsLostMs) {
      this.#lost(epoch, 'heartbeats stopped');
    }
  }

  /** The door, on loopback: it must answer the app's own metadata (or, before any address, its own not-ready answer). */
  async #checkDoor(epoch: number) {
    const port = this.#config?.port;
    if (!port) return;
    let why: string | null = null;
    try {
      const res = await this.doorFetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(WATCH.timeoutMs) });
      const j: any = await res.json().catch(() => null);
      const ours = this.url ? res.status === 200 && j?.issuer === this.url : res.status === 503 && j?.error === 'not_ready';
      if (!ours) why = `an answer that is not this app's (HTTP ${res.status})`;
    } catch (err) {
      why = describeFailure(err);
    }
    if (epoch !== this.#epoch) return;
    const was = this.#status.door;
    if (why && was?.ok !== false) this.#event('door down', why);
    if (!why && was?.ok === false) this.#event('door back');
    this.#set({ door: { ok: !why, why, at: this.#now() } });
  }

  // ---- Checks and restarts ----

  /** The reachability check through the public address. */
  async #check(epoch: number): Promise<{ ok: true } | { ok: false; why: string }> {
    const url = this.url;
    if (!url) return { ok: false, why: 'the tunnel has no address' };
    let r: { ok: true } | { ok: false; why: string };
    try {
      const res = await this.fetchImpl(`${url}/.well-known/oauth-authorization-server`, {
        headers: { 'ngrok-skip-browser-warning': '1', 'user-agent': 'Meadow tunnel check' },
        signal: AbortSignal.timeout(WATCH.timeoutMs),
      });
      if (res.status !== 200) r = { ok: false, why: await describeAnswer(res) };
      else {
        const j: any = await res.json().catch(() => null);
        r = j?.issuer === url ? { ok: true } : { ok: false, why: 'an answer from something other than this app' };
      }
    } catch (err) {
      r = { ok: false, why: describeFailure(err) };
    }
    if (epoch !== this.#epoch) throw new Stale();
    this.#event(r.ok ? 'check pass' : 'check fail', r.ok ? '' : r.why);
    return r;
  }

  #reached() {
    this.#endEpisode();
    this.#set({ state: 'on', reachedAt: this.#now(), why: null, restarts: 0, trying: false, wokeAt: null, heldElsewhere: false });
  }

  /** One check; on failure, an episode of restarts begins at once. */
  #single(reason: Reason, epoch: number): Promise<void> {
    return this.#serial(async () => {
      const r = await this.#check(epoch);
      if (r.ok) return this.#reached();
      this.#set({ why: r.why });
      this.#begin(reason, epoch, true);
    }).catch((err) => {
      if (!(err instanceof Stale)) throw err;
    });
  }

  #endEpisode() {
    if (this.#episode) this.#timers.clear(this.#episode.timer);
    this.#episode = null;
  }

  /**
   * An episode: attempts at the episode's times until a check passes. Each attempt of an
   * ngrok tunnel restarts it and checks; only a wake's first attempt looks before restarting.
   * A custom tunnel cannot be restarted, so its attempts are checks. `failed` when a check
   * has just failed (or ngrok is reconnecting), so there is nothing to look at first.
   */
  #begin(reason: Reason, epoch: number, failed: boolean) {
    const delays = reason === 'wake' ? WATCH.wakeDelays : WATCH.otherDelays;
    const started = this.#now();
    const canRestart = this.#status.provider === 'ngrok';
    const schedule = (i: number) => {
      this.#episode = { reason, timer: this.#timers.set(() => void attempt(i), Math.max(0, started + delays[i] - this.#now())) };
    };
    const attempt = (i: number) => this.#serial(async () => {
      let r: { ok: true } | { ok: false; why: string } | null = null;
      if (!canRestart || (i === 0 && !failed)) r = await this.#check(epoch);
      if (canRestart && !r?.ok) r = (await this.#restartOnce(reason, epoch)) ? await this.#check(epoch) : { ok: false, why: this.#status.why ?? 'ngrok could not start' };
      if (r!.ok) return this.#reached();
      const why = (r as { why: string }).why;
      if (i + 1 < delays.length) {
        // Still trying: amber for ngrok (the app is fixing it), red for a tunnel only its owner can restart.
        this.#set({ state: canRestart ? 'reconnecting' : 'unreachable', why, trying: true });
        this.#reconnectingSince = this.#now();
        schedule(i + 1);
      } else {
        this.#episode = null;
        this.#set({ state: 'unreachable', why, trying: false });
      }
    }).catch((err) => {
      if (err instanceof Stale) return;
      this.#episode = null;
      if (err instanceof TokenRefused) return this.#set({ state: 'error', url: null, error: TOKEN_REFUSED, trying: false });
      if (err instanceof HeldElsewhere) return this.#set({ state: 'unreachable', heldElsewhere: true, why: 'ngrok says the address is already open', trying: false });
      throw err;
    });
    // A custom tunnel whose check just failed is red at once (only its owner can fix it), and retried later.
    if (!canRestart && failed) {
      this.#set({ state: 'unreachable', trying: true });
      return schedule(1);
    }
    this.#set({ trying: true });
    schedule(0);
  }

  /** Closes the session and opens a new one. False when it could not open (the reason in `why`); throws for a refused token or a held address. */
  async #restartOnce(why: Reason | 'pressed', epoch: number): Promise<boolean> {
    this.#set({ restarts: this.#status.restarts + 1 });
    this.#event('restart', why === 'pressed' ? 'pressed' : why === 'wake' ? 'after a wake' : why === 'reconnecting' ? 'reconnecting too long' : 'check failed');
    const old = this.#session;
    this.#session = null;
    if (old) await old.close().catch(() => {});
    try {
      await this.#openSession(epoch);
      return true;
    } catch (err) {
      if (err instanceof Stale || err instanceof TokenRefused || err instanceof HeldElsewhere) throw err;
      this.#set({ why: `ngrok could not start: ${err instanceof Error ? err.message : String(err)}` });
      return false;
    }
  }

  /** Opens the ngrok session; waits out ERR_NGROK_334 (the old session still held) for up to 2 minutes. */
  async #openSession(epoch: number) {
    const cfg = this.#config!;
    let heldSince: number | null = null;
    for (;;) {
      try {
        const session = await this.#open({
          token: cfg.ngrokToken!, port: cfg.port,
          onHeartbeat: () => this.#beat(epoch),
          onDisconnect: () => this.#lost(epoch, 'ngrok lost its connection'),
        });
        if (epoch !== this.#epoch) {
          await session.close().catch(() => {});
          throw new Stale();
        }
        this.#session = session;
        this.#lastBeat = this.#now();
        if (this.#status.url && this.#status.url !== session.url) this.#event('new address', session.url);
        this.#set({ url: session.url, heldElsewhere: false, error: null });
        return;
      } catch (err) {
        if (err instanceof Stale) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (isTokenError(message)) throw new TokenRefused(message);
        if (!/ERR_NGROK_334\b/.test(message)) throw err;
        heldSince ??= this.#now();
        if (this.#now() - heldSince >= WATCH.heldGiveUpMs) throw new HeldElsewhere(message);
        this.#event('address held', 'waiting for ngrok to let go of the old session');
        await this.#sleep(WATCH.heldRetryMs, epoch);
      }
    }
  }
}
