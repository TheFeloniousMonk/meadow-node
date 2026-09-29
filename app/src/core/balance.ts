// Wallet balances (SPEC §16.9): the token balance of an address, read with
// eth_call balanceOf from a Base RPC endpoint, by default Pocket Network's
// public one. Reading needs no key and pays nothing.

export const BASE_RPC = 'https://base.api.pocket.network';

export async function tokenBalance(address: string, token: string, { rpc = BASE_RPC, fetchImpl = fetch }: { rpc?: string; fetchImpl?: typeof fetch } = {}): Promise<bigint> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error('not an address');
  const data = '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0'); // balanceOf(address)
  const res = await fetchImpl(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data }, 'latest'] }),
  });
  const json: any = await res.json();
  if (typeof json?.result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(json.result)) throw new Error(`the Base RPC answered ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
  return json.result === '0x' ? 0n : BigInt(json.result);
}
