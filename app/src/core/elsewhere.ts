// USDC on the wrong network (SPEC §16.9.2). A wallet's address is the same on
// every network that shares Base's address format, and the same recovery phrase
// controls it there, so USDC sent on Ethereum, Arbitrum, Optimism, Polygon, or
// BNB Smart Chain by mistake still belongs to the person; only the app cannot
// use it. This finds it, so the app can say so instead of "lost". Reading is
// free: one balanceOf per contract through Pocket Network's public RPCs. Each
// contract and its decimals are pinned here, never read from the chain (BNB
// Smart Chain's USDC has 18 decimals, not 6); checked on 2026-10-01 by reading
// each contract's name and symbol, and each RPC's chain ID.

import { callUint, rpcCall } from './balance.ts';
import { formatUsd } from './catalog.ts';

export interface ElsewhereToken {
  /** The network's name, as the person would see it at an exchange. */
  network: string;
  rpc: string;
  chainId: number;
  token: string;
  decimals: number;
  /** usdc: native USDC; bridged: the older bridged copy on that network; usdbc: USDbC on Base. */
  kind: 'usdc' | 'bridged' | 'usdbc';
}

export const ELSEWHERE: ElsewhereToken[] = [
  { network: 'Ethereum', rpc: 'https://eth.api.pocket.network', chainId: 1, token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, kind: 'usdc' },
  { network: 'Arbitrum', rpc: 'https://arb-one.api.pocket.network', chainId: 42161, token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, kind: 'usdc' },
  { network: 'Arbitrum', rpc: 'https://arb-one.api.pocket.network', chainId: 42161, token: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', decimals: 6, kind: 'bridged' },
  { network: 'Optimism', rpc: 'https://op.api.pocket.network', chainId: 10, token: '0x0b2C639c533813f4Aa9D7837cAf62653d097Ff85', decimals: 6, kind: 'usdc' },
  { network: 'Optimism', rpc: 'https://op.api.pocket.network', chainId: 10, token: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', decimals: 6, kind: 'bridged' },
  { network: 'Polygon', rpc: 'https://poly.api.pocket.network', chainId: 137, token: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, kind: 'usdc' },
  { network: 'Polygon', rpc: 'https://poly.api.pocket.network', chainId: 137, token: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6, kind: 'bridged' },
  { network: 'BNB Smart Chain', rpc: 'https://bsc.api.pocket.network', chainId: 56, token: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, kind: 'usdc' },
  { network: 'Base', rpc: 'https://base.api.pocket.network', chainId: 8453, token: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', decimals: 6, kind: 'usdbc' },
];

export interface ElsewhereFind {
  network: string;
  kind: ElsewhereToken['kind'];
  amount: bigint;
  decimals: number;
  /** In dollars, at the token's own decimals ("$5.00"). */
  usd: string;
}

export interface ElsewhereResult {
  at: number;
  found: ElsewhereFind[];
  /** Networks that could not be read this time (their RPC failed, or answered as another chain). */
  unreadable: string[];
}

/** The plain sentence for one find (§16.9.2). */
export function elsewhereSentence(f: ElsewhereFind): string {
  if (f.kind === 'usdbc') return `${f.usd} arrived as USDbC, an older copy of USDC on Base that the app does not use. It is safe in this wallet.`;
  return `${f.usd} of ${f.kind === 'bridged' ? 'an older, bridged USDC' : 'USDC'} arrived on ${f.network}, not Base. It is safe: it belongs to this wallet, and only your recovery phrase can move it. But the app can only use USDC on Base. For your next deposit, choose Base as the network.`;
}

/**
 * Looks for the address's USDC on each network in the table. An RPC whose chain ID is not the
 * one pinned is skipped. Amounts under a cent (dust anyone can send) are not reported.
 */
export async function findElsewhere(address: string, { fetchImpl = fetch as typeof fetch, tokens = ELSEWHERE, now = Date.now } = {}): Promise<ElsewhereResult> {
  const found: ElsewhereFind[] = [];
  const unreadable = new Set<string>();
  const byRpc = new Map<string, ElsewhereToken[]>();
  for (const t of tokens) byRpc.set(t.rpc, [...(byRpc.get(t.rpc) ?? []), t]);
  await Promise.all([...byRpc].map(async ([rpc, list]) => {
    const opts = { rpc, fetchImpl };
    try {
      const id = await rpcCall('eth_chainId', [], opts);
      if (typeof id !== 'string' || Number(BigInt(id)) !== list[0].chainId) throw new Error('another chain');
    } catch {
      unreadable.add(list[0].network);
      return;
    }
    for (const t of list) {
      try {
        const amount = await callUint(t.token, '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0'), opts);
        if (centsOf(amount, t.decimals) > 0n) found.push({ network: t.network, kind: t.kind, amount, decimals: t.decimals, usd: formatUsd(centsOf(amount, t.decimals), 2) });
      } catch {
        unreadable.add(t.network);
      }
    }
  }));
  // The table's order: Ethereum first, USDbC on Base last.
  found.sort((a, b) => tokens.findIndex((t) => t.network === a.network && t.kind === a.kind) - tokens.findIndex((t) => t.network === b.network && t.kind === b.kind));
  return { at: now(), found, unreadable: [...unreadable] };
}

/** Whole cents, whatever the token's decimals (18-decimal USDC would otherwise show 18 places). */
function centsOf(amount: bigint, decimals: number): bigint {
  return decimals > 2 ? amount / 10n ** BigInt(decimals - 2) : amount * 10n ** BigInt(2 - decimals);
}
