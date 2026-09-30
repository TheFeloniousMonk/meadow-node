// Wallet balances (SPEC §16.9): the token balance of an address, read with
// eth_call balanceOf from a Base RPC endpoint, by default Pocket Network's
// public one. Reading needs no key and pays nothing.

export const BASE_RPC = 'https://base.api.pocket.network';

export interface RpcOptions {
  rpc?: string;
  fetchImpl?: typeof fetch;
}

/** One JSON-RPC call to Base. An error answer throws with the node's message. */
export async function rpcCall(method: string, params: unknown[], { rpc = BASE_RPC, fetchImpl = fetch }: RpcOptions = {}): Promise<any> {
  const res = await fetchImpl(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json: any = await res.json();
  if (json?.error || !('result' in (json ?? {}))) throw new Error(`the Base RPC answered ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
  return json.result;
}

const quantity = (r: unknown): bigint => {
  if (typeof r !== 'string' || !/^0x[0-9a-fA-F]*$/.test(r)) throw new Error(`the Base RPC answered ${JSON.stringify(r).slice(0, 200)}`);
  return r === '0x' ? 0n : BigInt(r);
};

/** eth_call to `to` with `data`, read as one uint256. */
export async function callUint(to: string, data: string, opts: RpcOptions = {}): Promise<bigint> {
  return quantity(await rpcCall('eth_call', [{ to, data }, 'latest'], opts));
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
