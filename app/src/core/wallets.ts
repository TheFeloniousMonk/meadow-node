// Wallets and the spend guard (SPEC §16.9). A wallet is a recovery phrase,
// sealed at rest, holding USDC on Base. The core signs payments without asking,
// but only through authorize(), which refuses unless the terms match the
// portal's catalog, the amount is within the listed price and the per-call
// maximum, and the wallet's last 24 hours stay within its daily budget. The
// check and the record of the payment happen in one synchronous step, so two
// calls at once cannot both pass on the same budget.

import { randomBytes, randomUUID } from 'node:crypto';
import { tx, type Db } from './db.ts';
import { BASE, USDC, formatUsd, toAtomic, type Catalog } from './catalog.ts';
import { addressOf, isMnemonic, newMnemonic, normalizeMnemonic, privateKeyFromMnemonic, sameAddress, signTransfer, type Authorization, type Hex } from './evm.ts';
import { TransportError } from './transport.ts';
import type { Vault } from './vault.ts';

export const DAY_MS = 24 * 3600 * 1000;
/** The longest a signed authorization stays valid, whatever the 402 asks (§16.9). */
const MAX_VALID_S = 300;
/** The per-call maximum until the person sets one (§16.14): a limit, not a price. */
export const DEFAULT_PER_CALL_MAX_USD = '0.01';

/** One entry of a 402's `accepts` (x402 version 2). */
export interface Terms {
  scheme: string;
  network: string;
  amount: string;
  asset: Hex;
  payTo: Hex;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export interface WalletView {
  id: string;
  name: string;
  address: Hex;
  dailyBudgetUsd: string;
  spent24h: bigint;
  agents: string[];
}

export interface Authorized {
  seq: number;
  header: string;
  amount: bigint;
  decimals: number;
  wallet: string;
}

const refuse = (message: string, catalogMismatch = false): never => {
  throw new TransportError('refused', message, { catalogMismatch });
};

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The offer's terms, narrowed and checked. Anything else in `accepts` is ignored. */
export function parseTerms(offer: any): Terms[] {
  if (offer?.x402Version !== 2 || !Array.isArray(offer.accepts)) return [];
  return offer.accepts.filter((e: any) =>
    typeof e?.scheme === 'string' && typeof e.network === 'string' && typeof e.amount === 'string' && /^\d+$/.test(e.amount) &&
    HEX_ADDRESS.test(e.asset) && HEX_ADDRESS.test(e.payTo) && Number.isSafeInteger(e.maxTimeoutSeconds) && e.maxTimeoutSeconds > 0 &&
    typeof e.extra?.name === 'string' && typeof e.extra?.version === 'string',
  ).map((e: any) => ({
    scheme: e.scheme, network: e.network, amount: e.amount, asset: e.asset, payTo: e.payTo,
    maxTimeoutSeconds: e.maxTimeoutSeconds, extra: { name: e.extra.name, version: e.extra.version },
  }));
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export class Wallets {
  #db: Db;
  #vault: Vault;
  #catalog: Catalog;
  #now: () => number;

  constructor({ db, vault, catalog, now = Date.now }: { db: Db; vault: Vault; catalog: Catalog; now?: () => number }) {
    this.#db = db;
    this.#vault = vault;
    this.#catalog = catalog;
    this.#now = now;
  }

  // --- Managing wallets -----------------------------------------------------------

  /** A new wallet. The phrase is returned once, to show the person; it is kept only sealed. */
  create(name: string, dailyBudgetUsd: string): { id: string; address: Hex; mnemonic: string } {
    const mnemonic = newMnemonic();
    return { ...this.#insert(name, mnemonic, dailyBudgetUsd), mnemonic };
  }

  import(name: string, phrase: string, dailyBudgetUsd: string): { id: string; address: Hex } {
    if (!isMnemonic(phrase)) throw new Error('That is not a valid recovery phrase. Check each word and their order.');
    return this.#insert(name, normalizeMnemonic(phrase), dailyBudgetUsd);
  }

  #insert(name: string, mnemonic: string, dailyBudgetUsd: string) {
    toAtomic(dailyBudgetUsd, 6);
    const address = addressOf(privateKeyFromMnemonic(mnemonic));
    if (this.#db.prepare('SELECT 1 FROM wallets WHERE address = ?').get(address)) throw new Error('That wallet is already on this computer.');
    const id = `w_${randomUUID()}`;
    this.#db.prepare('INSERT INTO wallets (id, name, address, secret_sealed, daily_budget, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, address, this.#vault.sealJson(`wallet:${id}:secret`, { mnemonic }), dailyBudgetUsd, this.#now());
    return { id, address };
  }

  list(): WalletView[] {
    return (this.#db.prepare('SELECT id, name, address, daily_budget FROM wallets ORDER BY created_at').all() as any[]).map((w) => ({
      id: w.id, name: w.name, address: w.address, dailyBudgetUsd: w.daily_budget, spent24h: this.spent(w.id),
      agents: (this.#db.prepare('SELECT id FROM agents WHERE wallet = ?').all(w.id) as any[]).map((a) => a.id),
    }));
  }

  /**
   * Takes a wallet off this computer (§16.9): its sealed phrase is erased and
   * the agents it paid for are left with no wallet. Nothing changes on Base;
   * the phrase still reaches the money. `confirm` must be the wallet's name,
   * exactly as the person typed it. Its payments stay in the history.
   */
  remove(wallet: string, confirm: string) {
    const row = this.#db.prepare('SELECT name FROM wallets WHERE id = ?').get(wallet) as any;
    if (!row) throw new Error('There is no such wallet.');
    if (confirm.trim() !== row.name.trim()) throw new Error(`Type the wallet's name, ${row.name}, to remove it.`);
    tx(this.#db, () => {
      this.#db.prepare('UPDATE agents SET wallet = NULL WHERE wallet = ?').run(wallet);
      this.#db.prepare('DELETE FROM wallets WHERE id = ?').run(wallet);
    });
  }

  address(wallet: string): Hex {
    const row = this.#db.prepare('SELECT address FROM wallets WHERE id = ?').get(wallet) as any;
    if (!row) throw new Error('There is no such wallet.');
    return row.address;
  }

  /**
   * Signs with the wallet's key, for moving its money out (§16.9.1) and for
   * nothing else. `sign` runs synchronously and must not keep the key, which is
   * wiped when it returns. Only the core's Mover calls this; no tool can.
   */
  signWith<T>(wallet: string, sign: (key: Uint8Array, address: Hex) => T): T {
    const w = this.#db.prepare('SELECT address, secret_sealed FROM wallets WHERE id = ?').get(wallet) as any;
    if (!w) throw new Error('There is no such wallet.');
    const key = privateKeyFromMnemonic(this.#vault.openJson(`wallet:${wallet}:secret`, w.secret_sealed).mnemonic);
    try {
      return sign(key, w.address);
    } finally {
      key.fill(0);
    }
  }

  setBudget(wallet: string, dailyBudgetUsd: string) {
    toAtomic(dailyBudgetUsd, 6);
    this.#db.prepare('UPDATE wallets SET daily_budget = ? WHERE id = ?').run(dailyBudgetUsd, wallet);
  }

  assign(agent: string, wallet: string) {
    if (!this.#db.prepare('SELECT 1 FROM wallets WHERE id = ?').get(wallet)) throw new Error('There is no such wallet.');
    this.#db.prepare('UPDATE agents SET wallet = ? WHERE id = ?').run(wallet, agent);
  }

  walletOf(agent: string | null): string | null {
    if (!agent) return null;
    return (this.#db.prepare('SELECT wallet FROM agents WHERE id = ?').get(agent) as any)?.wallet ?? null;
  }

  perCallMaxUsd(): string {
    return (this.#db.prepare("SELECT value FROM meta WHERE key = 'per_call_max_usd'").get() as any)?.value ?? DEFAULT_PER_CALL_MAX_USD;
  }

  setPerCallMax(usd: string) {
    toAtomic(usd, 6);
    this.#db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('per_call_max_usd', ?)").run(usd);
  }

  /** What the wallet signed in the last 24 hours, in token base units. Failed payments count too: they were signed. */
  spent(wallet: string): bigint {
    return (this.#db.prepare('SELECT amount FROM payments WHERE wallet = ? AND signed_at > ?').all(wallet, this.#now() - DAY_MS) as any[])
      .reduce((sum, p) => sum + BigInt(p.amount), 0n);
  }

  /** How many payments the wallet has signed, ever. */
  paymentCount(wallet: string): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM payments WHERE wallet = ?').get(wallet) as any).n;
  }

  payments(limit = 50): any[] {
    return this.#db.prepare('SELECT * FROM payments ORDER BY seq DESC LIMIT ?').all(limit) as any[];
  }

  // --- The spend guard (§16.9) ----------------------------------------------------

  /**
   * Runs every check on a 402's terms (§16.9, checks 2 to 4) without signing:
   * what the call would cost, or a refusal in plain words. For the app to show
   * a cost before a call, and for the live dry run.
   */
  check(req: { agent: string | null; serviceId: string; offer: any }): { amount: bigint; decimals: number; usd: string } {
    const e = this.#evaluate(req);
    return { amount: e.amount, decimals: e.decimals, usd: formatUsd(e.amount, e.decimals) };
  }

  #evaluate(req: { agent: string | null; serviceId: string; offer: any }) {
    const walletId = this.walletOf(req.agent);
    if (!walletId) refuse('No wallet pays for this agent yet. Assign one on the Agents screen.');
    const service = this.#catalog.service(req.serviceId);
    const rail = this.#catalog.baseRail(req.serviceId);
    if (!service || !rail) refuse(`${req.serviceId} is not in the portal's price list with a USDC on Base price, so the app will not pay for it.`, true);
    // The price list may not change the token, the chain, or the unit limits are counted in.
    if (!sameAddress(rail!.tokenAddress, USDC.address) || rail!.tokenDecimals !== USDC.decimals || rail!.chainId !== BASE.chainId) {
      refuse(`The portal's price list describes ${req.serviceId}'s payment differently from USDC on Base, so the app will not pay for it.`, true);
    }

    // Terms on the app's rail, in the exact scheme, to the catalog's asset and payee (checks 2).
    const all = parseTerms(req.offer);
    const terms = all.find((t) => t.scheme === 'exact' && t.network === BASE.network && sameAddress(t.asset, USDC.address));
    if (!terms) return refuse('The portal did not offer a way to pay in USDC on Base, so nothing was paid.', true);
    if (!sameAddress(terms.payTo, rail!.payToAddress)) refuse('The portal asked to pay an address its price list does not show, so nothing was paid.', true);

    if (terms.extra?.name !== USDC.name || terms.extra?.version !== USDC.version) refuse('The portal asked to sign for a token that is not USDC, so nothing was paid.', true);

    // The amount (check 3).
    const decimals = USDC.decimals;
    const amount = BigInt(terms.amount);
    const price = toAtomic(service!.priceUsd, decimals);
    if (amount > price) refuse(`The portal asked for ${formatUsd(amount, decimals)}, more than its listed price of ${formatUsd(price, decimals)}, so nothing was paid.`, true);
    const perCall = toAtomic(this.perCallMaxUsd(), decimals);
    if (amount > perCall) refuse(`This call costs ${formatUsd(amount, decimals)}, more than the most you allow per call (${formatUsd(perCall, decimals)}). You can change that in Settings.`);

    // The budget (check 4). Payments count from signing; authorize() runs this and records the payment in one step.
    {
      const w: any = this.#db.prepare('SELECT name, address, secret_sealed, daily_budget FROM wallets WHERE id = ?').get(walletId);
      const budget = toAtomic(w.daily_budget, decimals);
      const since = this.#now() - DAY_MS;
      const recent = this.#db.prepare('SELECT amount, signed_at FROM payments WHERE wallet = ? AND signed_at > ? ORDER BY signed_at').all(walletId, since) as any[];
      const spent = recent.reduce((s, p) => s + BigInt(p.amount), 0n);
      if (spent + amount > budget) {
        let left = spent;
        let frees: number | null = null;
        for (const p of recent) {
          left -= BigInt(p.amount);
          if (left + amount <= budget) {
            frees = p.signed_at + DAY_MS;
            break;
          }
        }
        refuse(amount > budget
          ? `The daily budget of the wallet "${w.name}" (${formatUsd(budget, decimals)}) is less than one call (${formatUsd(amount, decimals)}). You can raise it on the Wallets screen.`
          : `The daily budget of the wallet "${w.name}" is spent: ${formatUsd(spent, decimals)} of ${formatUsd(budget, decimals)} in the last 24 hours. Enough frees up at ${time(frees!)}.`);
      }
      return { walletId: walletId!, w, terms: terms!, rail: rail!, amount, decimals };
    }
  }

  /**
   * Checks a 402's terms for a call the core is making to `serviceId`, and
   * signs if every check passes; otherwise throws a refusal in plain words.
   * Returns the PAYMENT-SIGNATURE header and the payment's record.
   */
  authorize(req: { agent: string | null; serviceId: string; path: string; offer: any }): Authorized {
    return tx(this.#db, () => {
      const { walletId, w, terms, rail, amount, decimals } = this.#evaluate(req);
      const { mnemonic } = this.#vault.openJson(`wallet:${walletId}:secret`, w.secret_sealed);
      const key = privateKeyFromMnemonic(mnemonic);
      const from = addressOf(key);
      const nowS = Math.floor(this.#now() / 1000);
      // As the portal's own payer does: a minute of clock skew before, the seller's timeout after, capped at five minutes.
      const authorization: Authorization = {
        from, to: terms.payTo, value: terms.amount,
        validAfter: String(nowS - 60), validBefore: String(nowS + Math.min(MAX_VALID_S, Math.max(60, terms.maxTimeoutSeconds))),
        nonce: `0x${randomBytes(32).toString('hex')}`,
      };
      const signature = signTransfer(key, { name: USDC.name, version: USDC.version, chainId: BASE.chainId, verifyingContract: USDC.address }, authorization);
      key.fill(0);
      const r = this.#db.prepare(`INSERT INTO payments (wallet, agent, service, path, amount, asset, network, pay_to, nonce, valid_before, signed_at, status)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'signed')`)
        .run(walletId, req.agent, req.serviceId, req.path, terms.amount, terms.asset, terms.network, terms.payTo, authorization.nonce, Number(authorization.validBefore) * 1000, this.#now());
      const echo: any = {};
      if (req.offer?.resource && typeof req.offer.resource === 'object') echo.resource = req.offer.resource;
      if (req.offer?.extensions && typeof req.offer.extensions === 'object') echo.extensions = req.offer.extensions;
      const payload = { x402Version: 2, ...echo, accepted: terms, payload: { signature, authorization } };
      return { seq: Number(r.lastInsertRowid), header: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'), amount, decimals, wallet: walletId };
    });
  }

  settled(seq: number, txHash: string | undefined) {
    this.#db.prepare("UPDATE payments SET status = 'settled', tx = ? WHERE seq = ?").run(txHash ?? null, seq);
  }

  failed(seq: number, error: string) {
    this.#db.prepare("UPDATE payments SET status = 'failed', error = ? WHERE seq = ?").run(error, seq);
  }
}
