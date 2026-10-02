// The alumni club, from the app's side (SPEC §18.8). The club's server is the
// gate: it signs a payment only for an active member, within the tier's cap.
// The app keeps the membership key sealed, caches the club's status, links a
// key through the browser (a loopback listener and PKCE, RFC 8252), and, while
// the membership is active, asks the club to sign each payment instead of the
// agent's wallet. Club payments are recorded like any other, under the wallet
// "Alumni club", so cost reporting and spending summaries work unchanged.

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Db } from './db.ts';
import type { Vault } from './vault.ts';
import { BASE, USDC, toAtomic, type Catalog } from './catalog.ts';
import { sameAddress, type Hex } from './evm.ts';
import { parseTerms, type Authorized } from './wallets.ts';
import { TransportError } from './transport.ts';
import { currentCause, notePayment } from './cause.ts';
import { REPLY_LIMITS, readJson } from './deps.ts';

export const ALUMNI_WALLET = 'alumni';
export const ALUMNI_WALLET_NAME = 'Alumni club';
export const CLUB_URL = 'https://meadowprotocol.com/alumni';
const DAY_MS = 24 * 3600_000;
const CLUB_TIMEOUT_MS = 10_000;
const LINK_MS = 15 * 60_000;
/** The receive intervals the app accepts from anyone, in minutes (as Settings offers them). */
export const MIN_INTERVAL = 5;
export const MAX_INTERVAL = 1440;
const USD = /^\d+(\.\d{1,6})?$/;
/** A cap's free-up time further off than this is not believed (§18.8: the allowance is per 24 hours). */
const MAX_HOLD_MS = 25 * 3600_000;

export interface ClubSettings {
  daily_cap_usd: string;
  receive_interval_min: number;
  messageguard: boolean;
  combine_syncs: boolean;
}

/** What the club's status endpoint answers (§18.14). */
export interface ClubStatus {
  active: boolean;
  member?: string;
  tier?: string;
  tier_name?: string;
  paid_through?: string;
  cancelled?: boolean;
  changes_to?: string;
  changes_on?: string;
  settings?: ClubSettings;
  spent_24h_usd?: string;
  allowance_left_usd?: string;
  payer_address?: string | null;
  ended?: string;
  history?: { date: string; amount: string; currency: string; tier: string | null; status: string }[];
}

/** A refusal the club gave that the fallback setting may answer with the agent's own wallet (§18.8). */
export class ClubFallback extends Error {
  readonly code: 'cap' | 'unavailable' | 'rate' | 'nokey';
  constructor(message: string, code: 'cap' | 'unavailable' | 'rate' | 'nokey' = 'unavailable') {
    super(message);
    this.code = code;
  }
}

/** Why the club is not paying just now (§18.8): its allowance used up until `until`, or the club unreachable. */
export interface ClubHeld {
  code: 'cap' | 'unavailable';
  text: string;
  /** When the allowance frees up (the cap); null when unknown. */
  until: number | null;
  at: number;
}

/** An unreachable club is reported for this long after the last failed attempt. */
const UNAVAILABLE_MS = 3600_000;

/** When the allowance frees up: the club's `frees_at`, else the "HH:MM UTC" in its refusal, next after `now`. */
export function freesAt(j: { frees_at?: unknown; refused?: unknown }, now: number): number | null {
  const given = typeof j.frees_at === 'number' ? j.frees_at : typeof j.frees_at === 'string' ? Date.parse(j.frees_at) : NaN;
  if (Number.isFinite(given)) return given;
  const m = /\b(\d{2}):(\d{2}) UTC\b/.exec(String(j.refused ?? ''));
  if (!m) return null;
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(m[1]), Number(m[2]));
  if (t <= now) t += DAY_MS;
  return t;
}

export class Alumni {
  #db: Db;
  #vault: Vault;
  #catalog: Catalog;
  #fetch: typeof fetch;
  #now: () => number;
  #base: string;
  #changed: () => void;
  /** Closes the browser link waiting now, if any. */
  #link: (() => void) | null = null;

  constructor({ db, vault, catalog, fetchImpl = fetch, now = Date.now, base = CLUB_URL, changed = () => {} }: {
    db: Db; vault: Vault; catalog: Catalog; fetchImpl?: typeof fetch; now?: () => number; base?: string; changed?: () => void;
  }) {
    this.#db = db;
    this.#vault = vault;
    this.#catalog = catalog;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#base = base.replace(/\/$/, '');
    this.#changed = changed;
  }

  // --- State -----------------------------------------------------------------------

  #meta(key: string): string | undefined {
    return (this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as any)?.value;
  }

  #setMeta(key: string, value: string | null) {
    if (value === null) this.#db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else this.#db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  /** The membership key, opened; null when none is linked. Never shown to a tool or the diagnostics. */
  key(): string | null {
    const sealed = this.#meta('alumni_key');
    return sealed ? this.#vault.open('alumni:key', Buffer.from(sealed, 'base64')).toString('utf8') : null;
  }

  #setKey(key: string | null) {
    this.#setMeta('alumni_key', key === null ? null : Buffer.from(this.#vault.seal('alumni:key', key)).toString('base64'));
  }

  /** The club's last answer, and when it came. */
  cached(): { status: ClubStatus; at: number } | null {
    const raw = this.#meta('alumni_status');
    return raw ? JSON.parse(raw) : null;
  }

  /** Whether the membership is active, from the last answer: the payer is the real gate, so a stale answer can never spend more. */
  active(): boolean {
    const c = this.cached();
    if (!c?.status.active || !this.key()) return false;
    // The paid period ends at the date the club gave, plus the club's own billing grace (3 days).
    return !c.status.paid_through || this.#now() < Date.parse(`${c.status.paid_through}T00:00:00Z`) + 4 * DAY_MS;
  }

  /**
   * The tier's settings while active (§18.8 overrides); null otherwise. Checked here, once, for
   * every use: the club's word drives timers and money, so a value out of range or unreadable is
   * replaced by a safe one, never passed on (security review A1, A4, 2026-10-02).
   */
  settings(): ClubSettings | null {
    const st = this.active() ? this.cached()?.status.settings : null;
    if (!st || typeof st !== 'object') return null;
    const minutes = Number.isSafeInteger(st.receive_interval_min) ? Math.min(Math.max(st.receive_interval_min, MIN_INTERVAL), MAX_INTERVAL) : 15;
    return {
      daily_cap_usd: typeof st.daily_cap_usd === 'string' && USD.test(st.daily_cap_usd) ? st.daily_cap_usd : '0.00',
      receive_interval_min: minutes,
      messageguard: st.messageguard === true,
      combine_syncs: st.combine_syncs === true,
    };
  }

  /** The allowance left today, as the club last said it ("$1.23"), or null when it said nothing readable. */
  allowanceLeft(): string | null {
    const v = this.active() ? this.cached()?.status.allowance_left_usd : null;
    return typeof v === 'string' && /^\$\d+(\.\d{1,6})?$/.test(v) ? v : null;
  }

  /** Use my own wallet when the club allowance is used up (§18.8): off by default, since the app never turns a cost on by itself. */
  fallback(): boolean {
    return this.#meta('alumni_fallback') === '1';
  }

  setFallback(on: boolean) {
    this.#setMeta('alumni_fallback', on ? '1' : null);
    this.#changed();
  }

  /** Why the club is not paying just now, while that holds: the cap until it frees up, or the club unreachable for the last hour. */
  held(): ClubHeld | null {
    if (!this.active()) return null;
    const raw = this.#meta('alumni_held');
    if (!raw) return null;
    const h: ClubHeld = JSON.parse(raw);
    const now = this.#now();
    // A cap with no known end is tried again after an hour, like an unreachable club.
    if (h.code === 'cap' && h.until !== null ? now >= h.until : now - h.at > UNAVAILABLE_MS) return null;
    return h;
  }

  #setHeld(h: ClubHeld | null) {
    const was = this.#meta('alumni_held') ?? null;
    const now = h ? JSON.stringify(h) : null;
    if (was === now) return;
    this.#setMeta('alumni_held', now);
    this.#changed();
  }

  // --- The club's API --------------------------------------------------------------------

  async #post(path: string, body: unknown): Promise<any> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/api/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(CLUB_TIMEOUT_MS),
      });
    } catch {
      throw new ClubFallback('The alumni club could not be reached just now.');
    }
    const j: any = await readJson(res, REPLY_LIMITS.rpc).catch(() => null);
    if (!j || typeof j !== 'object') throw new ClubFallback(`The alumni club answered ${res.status} with something unreadable.`);
    if (j.error) throw new Error(`The alumni club refused the request: ${String(j.error.message ?? j.error.code)}`);
    return j;
  }

  /** Asks the club for the membership's status and keeps the answer. On failure, keeps the last one. */
  async refresh(): Promise<ClubStatus | null> {
    const key = this.key();
    if (!key) return null;
    const j = await this.#post('status', { key }).catch(() => null);
    if (!j) return this.cached()?.status ?? null;
    if (j.refused) {
      // A key the club no longer accepts (a new key made elsewhere): the membership is not active here.
      const status: ClubStatus = { active: false, ended: j.refused };
      this.#setMeta('alumni_status', JSON.stringify({ status, at: this.#now() }));
      this.#changed();
      return status;
    }
    this.#setMeta('alumni_status', JSON.stringify({ status: j, at: this.#now() }));
    this.#changed();
    return j as ClubStatus;
  }

  /** Whether the daily check is due (§18.8: on start, once a day, after validating or cancelling). */
  due(): boolean {
    const c = this.cached();
    return !!this.key() && (!c || this.#now() - c.at > DAY_MS);
  }

  /** Validate alumni membership: a key pasted from the club's site. */
  async validate(key: string): Promise<ClubStatus> {
    const k = key.trim();
    if (!/^mclub1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(k)) throw new Error('That is not an alumni membership key. Copy the whole key from the club\'s site; it starts with mclub1.');
    const j = await this.#post('status', { key: k });
    if (j.refused) throw new Error(j.refused);
    this.#setKey(k);
    this.#setMeta('alumni_status', JSON.stringify({ status: j, at: this.#now() }));
    this.#changed();
    return j as ClubStatus;
  }

  async cancel(): Promise<{ runs_until: string | null }> {
    const key = this.key();
    if (!key) throw new Error('There is no alumni membership on this computer.');
    const j = await this.#post('cancel', { key });
    if (j.refused) throw new Error(j.refused);
    await this.refresh();
    return { runs_until: j.runs_until ?? null };
  }

  /** Removes the membership from this computer (the membership itself continues). */
  forget() {
    this.#setKey(null);
    this.#setMeta('alumni_status', null);
    this.#changed();
  }

  // --- Join and Get a new key: the browser hands the key back (§18.6) ----------------------

  /**
   * Starts the link: listens once on a loopback port, and returns the club's address to open
   * in the browser. `done` settles with the status once the key arrives, or fails after 15 minutes.
   */
  async startLink(rotate: boolean): Promise<{ url: string; done: Promise<ClubStatus> }> {
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let settle!: { ok: (s: ClubStatus) => void; fail: (e: Error) => void };
    const done = new Promise<ClubStatus>((ok, fail) => (settle = { ok, fail }));
    // One link at a time: a new one closes the last one's listener (security review A3).
    this.#link?.();
    // The club's words are text here, never markup (security review A3).
    const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const page = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1>${esc(title)}</h1><p>${esc(text)}</p></body>`;
    const server = http.createServer(async (req, res) => {
      // Only this computer's own address, as the browser sends it (no DNS rebinding), like the app's other loopback servers.
      if (req.headers.host !== `127.0.0.1:${(server.address() as AddressInfo).port}`) return res.writeHead(421).end();
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/alumni/callback') return res.writeHead(404).end();
      const code = u.searchParams.get('code');
      if (u.searchParams.get('state') !== state || !code) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page('Not this link', 'This page did not come from the link the Meadow app started. Start again from the app.'));
        return;
      }
      server.close();
      try {
        const j = await this.#post('redeem', { code, verifier });
        if (j.refused || typeof j.key !== 'string') throw new Error(j.refused ?? 'The club did not give a key.');
        const status = await this.validate(j.key);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Connected', 'Your alumni membership is connected to the Meadow app. You can close this tab.'));
        settle.ok(status);
      } catch (err) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Not connected', `${(err as Error).message} Start again from the app.`));
        settle.fail(err as Error);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const timer = setTimeout(() => {
      server.close();
      settle.fail(new Error('The link was not finished within 15 minutes. Start again from the app.'));
    }, LINK_MS);
    timer.unref?.();
    const close = () => {
      server.close();
      settle.fail(new Error('A newer link was started.'));
    };
    this.#link = close;
    done.finally(() => {
      clearTimeout(timer);
      if (this.#link === close) this.#link = null;
    }).catch(() => {});
    const q = new URLSearchParams({ state, challenge, port: String(port), ...(rotate && { rotate: '1' }) });
    return { url: `${this.#base}/link?${q}`, done };
  }

  // --- Paying through the club (§18.7, §18.8) --------------------------------------------

  /**
   * Asks the club to sign a 402's payment. The app checks the terms against the price list
   * first, as for its own wallet (§16.9 checks 1 to 3), and the answer against the terms after.
   * Throws ClubFallback for the refusals the fallback setting may answer (the cap, the club
   * unreachable), and a refusal TransportError otherwise.
   */
  async authorize(req: { agent: string | null; serviceId: string; path: string; offer: any }): Promise<Authorized> {
    const key = this.key();
    if (!key) throw new ClubFallback('No alumni membership key on this computer.', 'nokey');
    const rail = this.#catalog.baseRail(req.serviceId);
    const service = this.#catalog.service(req.serviceId);
    if (!rail || !service) throw new TransportError('refused', `${req.serviceId} is not in the portal's price list with a USDC on Base price, so nothing was paid.`, { catalogMismatch: true });
    const terms = parseTerms(req.offer).find((t) => t.scheme === 'exact' && t.network === BASE.network && sameAddress(t.asset, USDC.address));
    if (!terms || !sameAddress(terms.payTo, rail.payToAddress) || BigInt(terms.amount) > toAtomic(service.priceUsd, USDC.decimals) ||
        terms.extra.name !== USDC.name || terms.extra.version !== USDC.version) {
      throw new TransportError('refused', 'The portal asked for a payment its price list does not show, so nothing was paid.', { catalogMismatch: true });
    }
    let j: any;
    try {
      j = await this.#post('pay', { key, service: req.serviceId, term: terms });
    } catch (err) {
      if (err instanceof ClubFallback) this.#setHeld({ code: 'unavailable', text: err.message, until: null, at: this.#now() });
      throw err;
    }
    if (j.refused) {
      if (j.code === 'cap') {
        this.#noteAllowance('$0.00');
        // Never believed further off than a day and an hour: the allowance is per 24 hours (security review A6).
        const until = freesAt(j, this.#now());
        this.#setHeld({ code: 'cap', text: String(j.refused), until: until === null ? null : Math.min(until, this.#now() + MAX_HOLD_MS), at: this.#now() });
      }
      if (j.code === 'unavailable') this.#setHeld({ code: 'unavailable', text: String(j.refused), until: null, at: this.#now() });
      if (j.code === 'cap' || j.code === 'unavailable' || j.code === 'rate') throw new ClubFallback(j.refused, j.code);
      if (j.code === 'membership_ended' || j.code === 'key') void this.refresh();
      throw new TransportError('refused', j.refused);
    }
    const a = j.authorization;
    // What the club signed must be exactly what the portal asked for.
    if (!a || !sameAddress(a.to, terms.payTo) || a.value !== terms.amount || typeof j.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(j.signature)) {
      throw new TransportError('refused', 'The alumni club answered with a payment that does not match the portal\'s terms, so it was not used.');
    }
    const echo: any = {};
    if (req.offer?.resource && typeof req.offer.resource === 'object') echo.resource = req.offer.resource;
    if (req.offer?.extensions && typeof req.offer.extensions === 'object') echo.extensions = req.offer.extensions;
    const payload = { x402Version: 2, ...echo, accepted: terms, payload: { signature: j.signature, authorization: a } };
    const r = this.#db.prepare(`INSERT INTO payments (wallet, agent, service, path, amount, asset, network, pay_to, nonce, valid_before, signed_at, status, cause)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'signed', ?)`)
      .run(ALUMNI_WALLET, req.agent, req.serviceId, req.path, terms.amount, terms.asset, terms.network, terms.payTo, a.nonce, Number(a.validBefore) * 1000, this.#now(), currentCause());
    notePayment(Number(r.lastInsertRowid));
    if (typeof j.allowance_left_usd === 'string') this.#noteAllowance(j.allowance_left_usd);
    this.#setHeld(null);
    return { seq: Number(r.lastInsertRowid), header: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'), amount: BigInt(terms.amount), decimals: USDC.decimals, wallet: ALUMNI_WALLET };
  }

  #noteAllowance(left: string) {
    const c = this.cached();
    if (!c) return;
    c.status.allowance_left_usd = left;
    this.#setMeta('alumni_status', JSON.stringify(c));
  }

  /** The club's payer address, for the record (never used to sign here). */
  payerAddress(): Hex | null {
    const a = this.cached()?.status.payer_address;
    return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as Hex) : null;
  }
}
