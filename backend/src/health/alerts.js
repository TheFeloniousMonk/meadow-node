// Operator alerts (SPEC §9.6): a health report posted to a Discord webhook the
// operator names, every interval, or only on trouble. Off unless configured.
// The webhook URL is a secret: it is never logged and never in an error.

import { buildPayload } from './report.js';
import { networkTotals } from './container.js';

export const WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
export const MIN_INTERVAL_MIN = 15;
export const FIRST_CHECK_MS = 60_000;
const POST_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 60_000;

export class AlertConfigError extends Error {
  name = 'AlertConfigError';
}

/** The alert settings from the environment, or null when no webhook is set. Throws AlertConfigError with plain words. */
export function parseAlertConfig(env) {
  const webhook = env.MEADOW_ALERT_WEBHOOK?.trim();
  if (!webhook) return null;
  let url;
  try {
    url = new URL(webhook);
  } catch {
    throw new AlertConfigError('MEADOW_ALERT_WEBHOOK is not a URL; give the Discord webhook URL from the channel\'s Integrations settings');
  }
  if (url.protocol !== 'https:' || !WEBHOOK_HOSTS.has(url.hostname) || !url.pathname.startsWith('/api/webhooks/')) {
    throw new AlertConfigError('MEADOW_ALERT_WEBHOOK must be a Discord webhook URL (https://discord.com/api/webhooks/…)');
  }
  const interval = env.MEADOW_ALERT_INTERVAL_MIN?.trim() ? Number(env.MEADOW_ALERT_INTERVAL_MIN) : 60;
  if (!Number.isSafeInteger(interval) || interval < MIN_INTERVAL_MIN) {
    throw new AlertConfigError(`MEADOW_ALERT_INTERVAL_MIN is a whole number of minutes, at least ${MIN_INTERVAL_MIN}`);
  }
  const mode = env.MEADOW_ALERT_MODE?.trim() || 'report';
  if (mode !== 'report' && mode !== 'problems') throw new AlertConfigError('MEADOW_ALERT_MODE is report or problems');
  const mention = env.MEADOW_ALERT_MENTION?.trim() || null;
  return { webhook: url.href, intervalMs: interval * 60_000, mode, mention };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Posts a payload to the webhook: a 10-second timeout and one retry; a 429 waits for
 * Discord's retry_after (at most 60 s), then one retry. Never throws; the result says what happened,
 * in words that never include the URL.
 */
export async function postWebhook(webhook, payload, { fetch = globalThis.fetch, wait = sleep } = {}) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (res.ok) {
        await res.body?.cancel?.().catch(() => {});
        return { ok: true, status: res.status };
      }
      const text = await res.text().catch(() => '');
      if (res.status === 429 && attempt === 0) {
        let after = Number(res.headers.get('retry-after'));
        try {
          after = Number(JSON.parse(text).retry_after);
        } catch { /* use the header */ }
        const ms = Number.isFinite(after) ? Math.ceil(after * 1000) : MAX_RETRY_AFTER_MS + 1;
        if (ms > MAX_RETRY_AFTER_MS) return { ok: false, status: 429, error: 'Discord asked to wait longer than a minute; this report is skipped' };
        await wait(ms);
        continue;
      }
      last = { ok: false, status: res.status, error: `Discord answered ${res.status}` };
      if (res.status < 500) return last; // a 4xx won't change on retry (for example a deleted webhook)
    } catch (err) {
      last = { ok: false, status: null, error: err.name === 'TimeoutError' ? 'no answer within 10 seconds' : (err.cause?.code ?? err.name) };
    }
  }
  return last;
}

/**
 * The schedule: one check a minute after start, then every interval. In `report` mode every check
 * posts; in `problems` mode a check posts when something is wrong, when it clears, and once a day
 * (the first check after 00:00 UTC).
 */
export class Alerts {
  #o;
  #timers = [];
  #lastLevel = 'ok';
  #lastDay = null;
  #netStart;
  #netPrev = null;
  #prevAt;

  // o: { config, healths: [Health], container: () => containerStats, post, log, now, fetch }
  constructor(o) {
    this.#o = { log: console, now: Date.now, readNet: networkTotals, ...o };
    this.#o.post ??= (payload) => postWebhook(this.#o.config.webhook, payload, { fetch: this.#o.fetch });
    this.#netStart = this.#o.readNet();
    this.#prevAt = this.#o.now();
  }

  start() {
    const tick = () => this.check().catch((err) => this.#o.log.warn?.(`alert check: ${err.message}`));
    this.#timers.push(setTimeout(() => {
      tick();
      this.#timers.push(setInterval(tick, this.#o.config.intervalMs));
    }, FIRST_CHECK_MS));
    return this;
  }

  stop() {
    for (const t of this.#timers) {
      clearTimeout(t);
      clearInterval(t);
    }
  }

  #container(now) {
    const c = this.#o.container();
    const net = c.network ?? this.#o.readNet();
    const base = this.#netPrev ?? this.#netStart;
    return {
      ...c,
      network: net,
      networkTotal: net && this.#netStart ? { in: net.in - this.#netStart.in, out: net.out - this.#netStart.out } : null,
      networkInterval: net && base ? { in: net.in - base.in, out: net.out - base.out } : null,
      interval_ms: now - this.#prevAt,
    };
  }

  /** One check: snapshots, then a post if the mode says so. Returns what was decided. */
  async check() {
    const now = this.#o.now();
    const snapshots = [];
    for (const h of this.#o.healths) snapshots.push(await h.snapshot({ advance: true }));
    const container = this.#container(now);
    this.#netPrev = container.network;
    this.#prevAt = now;
    const { level, payload } = buildPayload(snapshots, container, { mention: this.#o.config.mention, cleared: this.#lastLevel !== 'ok' });
    const day = new Date(now).toISOString().slice(0, 10);
    const daily = this.#lastDay !== null && day !== this.#lastDay;
    const post = this.#o.config.mode === 'report' || level !== 'ok' || this.#lastLevel !== 'ok' || daily || this.#lastDay === null;
    this.#lastLevel = level;
    this.#lastDay = day;
    if (!post) return { level, posted: false };
    const res = await this.#o.post(payload);
    if (!res.ok) this.#o.log.warn?.(`alert webhook: could not post: ${res.error}`);
    return { level, posted: res.ok, result: res };
  }
}
