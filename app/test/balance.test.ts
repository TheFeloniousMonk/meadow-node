// The Base RPC fallback (SPEC §16.9): Pocket's public endpoint first, for at most
// PRIMARY_TIMEOUT_MS, then Base's own. A slow, failing, or "0x" answer goes to the
// fallback; a send never does; another RPC has no fallback unless given one. A fake
// RPC: nothing here reaches the networks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_RPC, BASE_RPC_FALLBACK, PRIMARY_TIMEOUT_MS, ethBalance, rpcCall, tokenBalance } from '../src/core/balance.ts';

const ADDRESS = '0x5d3f000000000000000000000000000000002445';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

type Answer = 'hang' | 'down' | 'error' | 'empty' | bigint;

/** Each URL's behaviour, and the URLs asked in order. */
function fakeRpc(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    asked.push(String(url));
    const a = answers[String(url)];
    if (a === 'hang') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    }
    if (a === 'down') throw new TypeError('fetch failed');
    if (a === 'error') return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'relay failed' } });
    const { method } = JSON.parse(init.body);
    if (a === 'empty') return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' });
    return Response.json({ jsonrpc: '2.0', id: 1, result: method === 'eth_call' ? word(a) : '0x' + a.toString(16) });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

test('Pocket answering: Base is never asked', async () => {
  const { fetchImpl, asked } = fakeRpc({ [BASE_RPC]: 7n });
  assert.equal(await tokenBalance(ADDRESS, USDC, { fetchImpl }), 7n);
  assert.deepEqual(asked, [BASE_RPC]);
});

test('the fallback is 5 seconds behind Pocket', () => {
  assert.equal(PRIMARY_TIMEOUT_MS, 5_000);
  assert.equal(BASE_RPC_FALLBACK, 'https://mainnet.base.org');
});

for (const fault of ['hang', 'down', 'error', 'empty'] as const) {
  test(`Pocket ${fault}: the read goes to Base's own endpoint`, async () => {
    const { fetchImpl, asked } = fakeRpc({ [BASE_RPC]: fault, [BASE_RPC_FALLBACK]: 9n });
    const started = Date.now();
    assert.equal(await tokenBalance(ADDRESS, USDC, { fetchImpl, primaryTimeoutMs: 50 }), 9n);
    assert.deepEqual(asked, [BASE_RPC, BASE_RPC_FALLBACK]);
    assert.ok(Date.now() - started < 2_000);
  });
}

test('both failing: the read fails, within the overall limit', async () => {
  const { fetchImpl, asked } = fakeRpc({ [BASE_RPC]: 'hang', [BASE_RPC_FALLBACK]: 'hang' });
  const started = Date.now();
  await assert.rejects(ethBalance(ADDRESS, { fetchImpl, primaryTimeoutMs: 50, timeoutMs: 200 }));
  assert.deepEqual(asked, [BASE_RPC, BASE_RPC_FALLBACK]);
  assert.ok(Date.now() - started < 1_000);
});

test('an empty answer from both is never shown as $0.00', async () => {
  const { fetchImpl } = fakeRpc({ [BASE_RPC]: 'empty', [BASE_RPC_FALLBACK]: 'empty' });
  await assert.rejects(tokenBalance(ADDRESS, USDC, { fetchImpl }), /no usable answer/);
});

test('a send never falls back, and keeps the whole limit', async () => {
  const { fetchImpl, asked } = fakeRpc({ [BASE_RPC]: 'down', [BASE_RPC_FALLBACK]: 1n });
  await assert.rejects(rpcCall('eth_sendRawTransaction', ['0x02'], { fetchImpl, primaryTimeoutMs: 50 }));
  assert.deepEqual(asked, [BASE_RPC]);
});

test('another network has no fallback unless given one; null turns it off', async () => {
  const other = 'https://arb-one.api.pocket.network';
  const a = fakeRpc({ [other]: 'down', [BASE_RPC_FALLBACK]: 1n });
  await assert.rejects(ethBalance(ADDRESS, { rpc: other, fetchImpl: a.fetchImpl }));
  assert.deepEqual(a.asked, [other]);
  const b = fakeRpc({ [BASE_RPC]: 'down', [BASE_RPC_FALLBACK]: 1n });
  await assert.rejects(ethBalance(ADDRESS, { fetchImpl: b.fetchImpl, fallback: null }));
  assert.deepEqual(b.asked, [BASE_RPC]);
});
