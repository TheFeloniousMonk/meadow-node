// A mock Base node and CoW Protocol API for moving money out (SPEC §16.9.1):
// balances per address, swaps that settle (or expire) when polled, and
// transfers decoded and applied. For the tests and the UI harness.

import { decodeFunctionData, keccak256, parseAbi, parseTransaction, type Hex } from 'viem';

export const MOCK_RPC = 'https://base.test';
export const MOCK_COW = 'https://cow.test';

const ERC20 = parseAbi(['function transfer(address to, uint256 amount)', 'function approve(address spender, uint256 amount)']);
/** USDbC on Base (§16.9.3), kept apart from USDC. */
export const USDBC = '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

export function mockBase({ usdc = new Map<string, bigint>(), eth = new Map<string, bigint>(), usdbc = new Map<string, bigint>(), fill = 'fulfilled' as 'fulfilled' | 'expired', code = '0x' } = {}) {
  const chain = { usdc, eth, usdbc, fill, code, sent: [] as Hex[], orders: [] as any[], quotes: [] as any[], approvals: [] as { token: string; spender: string; amount: bigint }[] };
  const key = (a: string) => a.toLowerCase();
  const get = (m: Map<string, bigint>, a: string) => m.get(key(a)) ?? 0n;
  const add = (m: Map<string, bigint>, a: string, v: bigint) => m.set(key(a), get(m, a) + v);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.startsWith(MOCK_COW)) {
      const path = url.slice(MOCK_COW.length);
      if (path === '/api/v1/quote') {
        chain.quotes.push(body);
        // USDbC sells for USDC at 99.9%.
        if (key(body.buyToken) === BASE_USDC) return json({ id: 43, quote: { sellAmount: body.sellAmountBeforeFee, feeAmount: '0', buyAmount: String((BigInt(body.sellAmountBeforeFee) * 999n) / 1000n) } });
        // Ten cents buys 3.7e13 wei, less a fee in the sell token.
        return json({ id: 42, quote: { sellAmount: String(BigInt(body.sellAmountBeforeFee) - 2321n), feeAmount: '2321', buyAmount: String(BigInt(body.sellAmountBeforeFee) * 370_000_000n) } });
      }
      if (path === '/api/v1/orders') {
        chain.orders.push({ ...body, status: 'open' });
        return json(`0x${'ab'.repeat(56)}`, 201);
      }
      if (path.startsWith('/api/v1/orders/')) {
        const o = chain.orders.at(-1);
        if (o.status === 'open') {
          o.status = chain.fill;
          if (chain.fill === 'fulfilled' && key(o.sellToken) === USDBC) {
            add(chain.usdbc, o.from, -BigInt(o.sellAmount));
            add(chain.usdc, o.receiver, BigInt(o.buyAmount));
          } else if (chain.fill === 'fulfilled') {
            add(chain.usdc, o.from, -BigInt(o.sellAmount));
            add(chain.eth, o.from, BigInt(o.buyAmount));
          }
        }
        return json({ status: o.status });
      }
      if (path.startsWith('/api/v1/account/')) return json([]);
      return json({ errorType: 'NotFound' }, 404);
    }
    const { method, params } = body;
    const r = (result: unknown) => json({ jsonrpc: '2.0', id: 1, result });
    const q = (n: bigint) => `0x${n.toString(16)}`;
    // eth_call answers one 32-byte word, as a real node does.
    const w = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
    switch (method) {
      case 'eth_call': {
        const data: string = params[0].data;
        if (data.startsWith('0x70a08231')) return r(w(get(key(params[0].to) === USDBC ? chain.usdbc : chain.usdc, `0x${data.slice(-40)}`)));
        if (data.startsWith('0x7ecebe00')) return r(w(0n));
        if (data.startsWith('0x49948e0e')) return r(w(50_000_000_000n)); // L1 fee
        return r('0x');
      }
      case 'eth_getBalance': return r(q(get(chain.eth, params[0])));
      case 'eth_getCode': return r(chain.code);
      case 'eth_getBlockByNumber': return r({ baseFeePerGas: q(5_000_000n) });
      case 'eth_maxPriorityFeePerGas': return r(q(1_000_000n));
      case 'eth_getTransactionCount': return r(q(3n));
      case 'eth_estimateGas': return r(q(65_000n));
      case 'eth_sendRawTransaction': {
        chain.sent.push(params[0]);
        const t = parseTransaction(params[0]);
        const call = decodeFunctionData({ abi: ERC20, data: t.data! });
        const [to, amount] = call.args as [string, bigint];
        if (call.functionName === 'approve') {
          chain.approvals.push({ token: key(t.to!), spender: key(to), amount });
          return r(keccak256(params[0]));
        }
        const { recoverTransactionAddress } = await import('viem');
        const from = await recoverTransactionAddress({ serializedTransaction: params[0] });
        add(chain.usdc, from, -amount);
        add(chain.usdc, to, amount);
        return r(keccak256(params[0]));
      }
      case 'eth_getTransactionReceipt': return r({ status: '0x1' });
    }
    return json({ jsonrpc: '2.0', id: 1, error: { message: `no ${method}` } });
  }) as typeof fetch;
  return { chain, fetchImpl, usdcOf: (a: string) => get(chain.usdc, a), ethOf: (a: string) => get(chain.eth, a), usdbcOf: (a: string) => get(chain.usdbc, a) };
}
