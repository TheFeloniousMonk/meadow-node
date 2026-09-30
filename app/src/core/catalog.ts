// The portal's catalog (SPEC §16.1): every service's price and payment rails,
// read from services.json at start, once a day, and again when a payment's
// terms do not match what the app last read. Every price the app shows and
// every check the spend guard makes come from here; nothing hardcodes a price.

import { REPLY_LIMITS, readJson } from './deps.ts';

export const CATALOG_URL = 'https://agent.pocket.network/services.json';
export const REFRESH_MS = 24 * 3600 * 1000;

/** The one rail the app pays on (§16.16): USDC on Base. */
export const BASE = { network: 'eip155:8453', chainId: 8453 };
/**
 * The one token the app pays in, pinned in code (§16.9): the price list names
 * the rail, but never the unit the person's limits are counted in. USDC on
 * Base, 6 decimals, EIP-712 domain "USD Coin" version "2".
 */
export const USDC = { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, name: 'USD Coin', version: '2' } as const;

export interface Rail {
  id: string;
  network: string;
  chainId: number;
  tokenAddress: string;
  tokenDecimals: number;
  payToAddress: string;
}

export interface CatalogService {
  serviceId: string;
  displayName: string;
  resourceUrl: string;
  priceUsd: string;
  rails: Rail[];
}

/** A decimal string of dollars as token base units, exactly: "0.005000" at 6 decimals is 5000n. */
export function toAtomic(usd: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(usd.trim());
  if (!m) throw new Error(`not a price: ${usd}`);
  const frac = (m[2] ?? '').padEnd(decimals, '0');
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) throw new Error(`${usd} has more precision than the token`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.slice(0, decimals) || '0');
}

/** Token base units as dollars, trimmed: 5000n at 6 decimals is "$0.005". */
export function formatUsd(atomic: bigint, decimals = 6): string {
  const neg = atomic < 0n;
  const a = neg ? -atomic : atomic;
  const whole = a / 10n ** BigInt(decimals);
  let frac = (a % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}$${whole}.${frac}`;
}

export class Catalog {
  #fetch: typeof fetch;
  #url: string;
  #now: () => number;
  #services = new Map<string, CatalogService>();
  #fetchedAt = 0;
  registryVersion: string | null = null;

  constructor({ fetchImpl = fetch, url = CATALOG_URL, now = Date.now }: { fetchImpl?: typeof fetch; url?: string; now?: () => number } = {}) {
    this.#fetch = fetchImpl;
    this.#url = url;
    this.#now = now;
  }

  get fetchedAt() {
    return this.#fetchedAt;
  }

  async refresh(): Promise<void> {
    const res = await this.#fetch(this.#url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`the catalog answered ${res.status}`);
    const json: any = await readJson(res, REPLY_LIMITS.catalog);
    if (!Array.isArray(json?.services)) throw new Error('the catalog has no services list');
    const services = new Map<string, CatalogService>();
    for (const s of json.services) {
      if (typeof s?.serviceId !== 'string' || typeof s.resourceUrl !== 'string' || typeof s.priceUsd !== 'string' || !Array.isArray(s.rails)) continue;
      const rails = s.rails.filter((r: any) => typeof r?.network === 'string' && typeof r.tokenAddress === 'string' &&
        Number.isSafeInteger(r.tokenDecimals) && typeof r.payToAddress === 'string' && Number.isSafeInteger(r.chainId));
      services.set(s.serviceId, { serviceId: s.serviceId, displayName: s.displayName ?? s.serviceId, resourceUrl: s.resourceUrl.replace(/\/+$/, ''), priceUsd: s.priceUsd, rails });
    }
    this.#services = services;
    this.registryVersion = typeof json.registryVersion === 'string' ? json.registryVersion : null;
    this.#fetchedAt = this.#now();
  }

  /** Refreshes when never read or older than a day. */
  async ensureFresh(): Promise<void> {
    if (!this.#fetchedAt || this.#now() - this.#fetchedAt >= REFRESH_MS) await this.refresh();
  }

  service(serviceId: string): CatalogService | undefined {
    return this.#services.get(serviceId);
  }

  /** The Base USDC rail of a service, if it has one. */
  baseRail(serviceId: string): Rail | undefined {
    return this.service(serviceId)?.rails.find((r) => r.network === BASE.network && r.chainId === BASE.chainId);
  }

  /** A service's price on its Base rail, in token base units. */
  priceAtomic(serviceId: string): { atomic: bigint; decimals: number } | undefined {
    const s = this.service(serviceId);
    const rail = this.baseRail(serviceId);
    return s && rail ? { atomic: toAtomic(s.priceUsd, rail.tokenDecimals), decimals: rail.tokenDecimals } : undefined;
  }
}
