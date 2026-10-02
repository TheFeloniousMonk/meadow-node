// Wallet balances (SPEC §16.9): the token balance of an address, read with
// eth_call balanceOf from a Base RPC endpoint, by default Pocket Network's
// public one, with Base's own public endpoint behind it. Reading needs no key
// and pays nothing.

import { REPLY_LIMITS, readJson } from './deps.ts';

export const BASE_RPC = 'https://base.api.pocket.network';
/** Base's own public endpoint: asked when Pocket's does not answer in time, or answers badly. */
export const BASE_RPC_FALLBACK = 'https://mainnet.base.org';

export interface RpcOptions {
  rpc?: string;
  fetchImpl?: typeof fetch;
  /** How long one call may take in all, fallback included (default RPC_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Asked when `rpc` fails or is slow. Defaults to BASE_RPC_FALLBACK when `rpc` is BASE_RPC; null for none. */
  fallback?: string | null;
  /** How long the first endpoint gets before the fallback is asked (default PRIMARY_TIMEOUT_MS). */
  primaryTimeoutMs?: number;
}

/** No RPC read waits longer than this: the public endpoint once took 50 s to answer one (2026-10-02). */
export const RPC_TIMEOUT_MS = 15_000;
/** How long Pocket's Base endpoint gets before a read goes to the fallback. */
export const PRIMARY_TIMEOUT_MS = 5_000;

async function call1(rpc: string, method: string, params: unknown[], fetchImpl: typeof fetch, timeoutMs: number): Promise<any> {
  const res = await fetchImpl(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json: any = await readJson(res, REPLY_LIMITS.rpc);
  if (json?.error || !('result' in (json ?? {}))) throw new Error(`the Base RPC answered ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
  return json.result;
}

/**
 * One JSON-RPC call to Base. An error answer throws with the node's message. A read gets
 * `primaryTimeoutMs` on the first endpoint; if that fails, or `usable` rejects its answer, the
 * fallback gets what is left of `timeoutMs`. A send never falls back: one that timed out may
 * still have arrived, and sending it twice would only turn a success into an error.
 */
export async function rpcCall(method: string, params: unknown[], opts: RpcOptions = {}, usable?: (r: unknown) => boolean): Promise<any> {
  const { rpc = BASE_RPC, fetchImpl = fetch, timeoutMs = RPC_TIMEOUT_MS, primaryTimeoutMs = PRIMARY_TIMEOUT_MS } = opts;
  const fallback = opts.fallback === undefined ? (rpc === BASE_RPC ? BASE_RPC_FALLBACK : null) : opts.fallback;
  if (!fallback || method === 'eth_sendRawTransaction') return call1(rpc, method, params, fetchImpl, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let first: unknown;
  try {
    const r = await call1(rpc, method, params, fetchImpl, Math.min(primaryTimeoutMs, timeoutMs));
    if (!usable || usable(r)) return r;
    first = new Error(`the Base RPC gave no usable answer (${JSON.stringify(r).slice(0, 80)})`);
  } catch (e) {
    first = e;
  }
  const left = deadline - Date.now();
  if (left <= 0) throw first;
  return call1(fallback, method, params, fetchImpl, left);
}

const quantity = (r: unknown): bigint => {
  if (typeof r !== 'string' || !/^0x[0-9a-fA-F]*$/.test(r)) throw new Error(`the Base RPC answered ${JSON.stringify(r).slice(0, 200)}`);
  return r === '0x' ? 0n : BigInt(r);
};

/** eth_call to `to` with `data`, read as one uint256. */
export async function callUint(to: string, data: string, opts: RpcOptions = {}): Promise<bigint> {
  // A uint256 answer is one 32-byte word. An empty "0x" is a node that could not answer
  // (seen 2026-09-30 behind a load-balanced RPC), not a zero balance: showing $0.00 would alarm.
  const word = (r: unknown) => typeof r === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r);
  const r = await rpcCall('eth_call', [{ to, data }, 'latest'], opts, word);
  if (!word(r)) throw new Error(`the Base RPC gave no usable answer (${JSON.stringify(r).slice(0, 80)})`);
  return BigInt(r);
}

export async function tokenBalance(address: string, token: string, opts: RpcOptions = {}): Promise<bigint> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error('not an address');
  return callUint(token, '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0'), opts); // balanceOf(address)
}

/** The address's ETH, in wei. */
export async function ethBalance(address: string, opts: RpcOptions = {}): Promise<bigint> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('not an address');
  return quantity(await rpcCall('eth_getBalance', [address, 'latest'], opts));
}

export const rpcQuantity = quantity;
