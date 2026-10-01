// Move to Base (SPEC §16.9.3): the ReceiveWithAuthorization and approval
// encodings against viem; the guard on a Relay quote, which refuses every
// mutation of a good one; a whole move through a stand-in Relay (success,
// refund, refusal before anything is signed); and USDbC through a stand-in CoW
// on a stand-in Base (approval for exactly the amount, gas bought with Base USDC).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decodeFunctionData, hashTypedData, parseAbi, recoverTypedDataAddress, type Hex as VHex } from 'viem';
import { addressOf, erc20ApproveData, receiveDigest, signDigest, type Hex } from '../src/core/evm.ts';
import { openDb } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { Catalog, USDC } from '../src/core/catalog.ts';
import { Wallets } from '../src/core/wallets.ts';
import { COW, Mover } from '../src/core/move.ts';
import { ELSEWHERE } from '../src/core/elsewhere.ts';
import { Bridger, RELAY_PROXY, checkRelayQuote, movable, type BridgeState } from '../src/core/bridge.ts';
import { MOCK_COW, MOCK_RPC, USDBC, mockBase } from './mock-base.ts';

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}` as VHex;
const ARB = ELSEWHERE.find((t) => t.network === 'Arbitrum' && t.kind === 'usdc')!;
const RECEIVE = { ReceiveWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] } as const;

test('the ReceiveWithAuthorization digest matches viem, and the signature recovers to the wallet', async () => {
  const key = randomBytes(32);
  const from = addressOf(key);
  const domain = { name: 'USD Coin', version: '2', chainId: 42161, verifyingContract: ARB.token as Hex };
  const a = { from, to: RELAY_PROXY, value: '5000000', validAfter: '0', validBefore: '1790883723', nonce: `0x${'d9'.repeat(32)}` as Hex };
  const message = { ...a, value: 5000000n, validAfter: 0n, validBefore: 1790883723n };
  assert.equal(hex(receiveDigest(domain, a)), hashTypedData({ domain, types: RECEIVE, primaryType: 'ReceiveWithAuthorization', message }));
  const sig = signDigest(key, receiveDigest(domain, a));
  assert.equal(await recoverTypedDataAddress({ domain, types: RECEIVE, primaryType: 'ReceiveWithAuthorization', message, signature: sig }), from);
});

test('the approval call data is ERC-20 approve(spender, amount), as viem decodes it', () => {
  const call = decodeFunctionData({ abi: parseAbi(['function approve(address spender, uint256 amount)']), data: erc20ApproveData(COW.vaultRelayer, 4_200_000n) });
  assert.equal(call.functionName, 'approve');
  assert.deepEqual(call.args, [COW.vaultRelayer, 4_200_000n]);
});

test('what can be moved: native USDC on four networks and USDbC; not bridged USDC or BNB Smart Chain', () => {
  for (const n of ['Ethereum', 'Arbitrum', 'Optimism', 'Polygon']) assert.ok(movable(n, 'usdc'), n);
  assert.ok(movable('Base', 'usdbc'));
  assert.equal(movable('BNB Smart Chain', 'usdc'), null);
  for (const n of ['Arbitrum', 'Optimism', 'Polygon']) assert.equal(movable(n, 'bridged'), null);
});

const NOW_S = 1_790_880_000;
const RELAY_ID = `0x${'17'.repeat(32)}`;

/** A good Relay quote, shaped as the live one of 2026-10-01: one signature, Base USDC to the same wallet. */
function goodQuote(wallet: string, amount = 5_000_000n, out = 4_963_363n) {
  return {
    requestId: RELAY_ID,
    steps: [{
      id: 'authorize1', kind: 'signature', requestId: RELAY_ID,
      items: [{
        status: 'incomplete',
        data: {
          sign: {
            signatureKind: 'eip712', primaryType: 'ReceiveWithAuthorization',
            domain: { name: 'USD Coin', version: '2', chainId: ARB.chainId, verifyingContract: ARB.token },
            types: RECEIVE,
            value: { from: wallet, to: RELAY_PROXY, value: amount.toString(), validAfter: 0, validBefore: NOW_S + 600, nonce: `0x${'4f'.repeat(32)}` },
          },
          post: { endpoint: '/execute/permits', method: 'POST', body: { kind: 'eip3009', requestId: RELAY_ID, api: 'swap' } },
        },
        check: { endpoint: `/intents/status/v3?requestId=${RELAY_ID}`, method: 'GET' },
      }],
    }],
    details: {
      recipient: wallet, sender: wallet,
      currencyIn: { currency: { chainId: ARB.chainId, address: ARB.token.toLowerCase(), decimals: 6 }, amount: amount.toString(), minimumAmount: amount.toString() },
      currencyOut: { currency: { chainId: 8453, address: USDC.address.toLowerCase(), decimals: 6 }, amount: out.toString(), minimumAmount: ((out * 98n) / 100n).toString() },
    },
    protocol: { v2: { orderData: {
      inputs: [{ refunds: [{ chainId: 'arbitrum', recipient: wallet }, { chainId: 'base', recipient: wallet }] }],
      output: { chainId: 'base', payments: [{ recipient: wallet, currency: USDC.address.toLowerCase() }], calls: [] },
    } } },
  };
}

test('the guard passes a good quote and refuses every mutation of it, before anything is signed', () => {
  const wallet = addressOf(randomBytes(32));
  const ctx = { wallet, src: ARB, amount: 5_000_000n, nowS: NOW_S };
  const ok = checkRelayQuote(goodQuote(wallet), ctx);
  assert.equal(ok.message.to, RELAY_PROXY);
  assert.equal(ok.requestId, RELAY_ID);
  assert.equal(ok.postBody.requestId, RELAY_ID);

  const other = addressOf(randomBytes(32));
  const mutations: [string, (q: any) => void][] = [
    ['two steps', (q) => q.steps.push(q.steps[0])],
    ['a transaction step', (q) => { q.steps[0].kind = 'transaction'; }],
    ['another primary type', (q) => { q.steps[0].items[0].data.sign.primaryType = 'TransferWithAuthorization'; }],
    ['another domain name', (q) => { q.steps[0].items[0].data.sign.domain.name = 'USDC'; }],
    ['another chain in the domain', (q) => { q.steps[0].items[0].data.sign.domain.chainId = 8453; }],
    ['another token contract', (q) => { q.steps[0].items[0].data.sign.domain.verifyingContract = USDC.address; }],
    ['another from', (q) => { q.steps[0].items[0].data.sign.value.from = other; }],
    ['another to', (q) => { q.steps[0].items[0].data.sign.value.to = other; }],
    ['another value', (q) => { q.steps[0].items[0].data.sign.value.value = '5000001'; }],
    ['valid for too long', (q) => { q.steps[0].items[0].data.sign.value.validBefore = NOW_S + 31 * 60; }],
    ['already expired', (q) => { q.steps[0].items[0].data.sign.value.validBefore = NOW_S; }],
    ['not valid yet', (q) => { q.steps[0].items[0].data.sign.value.validAfter = NOW_S + 60; }],
    ['a malformed nonce', (q) => { q.steps[0].items[0].data.sign.value.nonce = '0x1234'; }],
    ['another submission', (q) => { q.steps[0].items[0].data.post.endpoint = '/execute/call'; }],
    ['a malformed request ID', (q) => { q.steps[0].items[0].data.post.body.requestId = 'abc'; }],
    ['another recipient', (q) => { q.details.recipient = other; }],
    ['another source chain', (q) => { q.details.currencyIn.currency.chainId = 1; }],
    ['another source amount', (q) => { q.details.currencyIn.amount = '1'; }],
    ['another destination chain', (q) => { q.details.currencyOut.currency.chainId = 10; }],
    ['another destination token', (q) => { q.details.currencyOut.currency.address = USDBC; }],
    ['a refund to someone else', (q) => { q.protocol.v2.orderData.inputs[0].refunds[1].recipient = other; }],
    ['a payment to someone else', (q) => { q.protocol.v2.orderData.output.payments[0].recipient = other; }],
    ['a call at the destination', (q) => { q.protocol.v2.orderData.output.calls.push({ to: other }); }],
  ];
  for (const [name, mutate] of mutations) {
    const q = goodQuote(wallet);
    mutate(q);
    assert.throws(() => checkRelayQuote(q, ctx), /nothing was signed/, name);
  }
  // More than half in fees: refused with its own words.
  assert.throws(() => checkRelayQuote(goodQuote(wallet, 5_000_000n, 2_400_000n), ctx), /more than half of it in fees/);
});

const ARB_RPC = 'https://arb.test';
const RELAY = 'https://relay.test';

/** A stand-in Relay and Arbitrum, in front of the stand-in Base: statuses play out in order. */
function world({ statuses = ['pending', 'success'], arbUsdc = 5_000_000n, mutate }: { statuses?: string[]; arbUsdc?: bigint; mutate?: (q: any) => void } = {}) {
  const base = mockBase({ usdc: new Map(), eth: new Map() });
  const posted: { signature: string; body: any }[] = [];
  const statusLeft = [...statuses];
  let wallet = '';
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.startsWith(RELAY)) {
      const path = url.slice(RELAY.length);
      if (path === '/quote/v2') {
        wallet = body.user;
        assert.equal(body.recipient, body.user);
        assert.equal(body.refundTo, body.user);
        assert.equal(body.usePermit, true);
        const q = goodQuote(body.user, BigInt(body.amount));
        q.steps[0].items[0].data.sign.value.validBefore = Math.floor(Date.now() / 1000) + 600;
        mutate?.(q);
        return Response.json(q);
      }
      if (path.startsWith('/execute/permits?signature=')) {
        posted.push({ signature: path.split('=')[1], body });
        return Response.json({ message: 'ok', steps: [] });
      }
      if (path.startsWith('/intents/status/v3?requestId=')) {
        const s = statusLeft.shift() ?? 'pending';
        if (s === 'success') base.chain.usdc.set(wallet.toLowerCase(), (base.chain.usdc.get(wallet.toLowerCase()) ?? 0n) + 4_963_363n);
        return Response.json({ status: s });
      }
      return Response.json({ message: 'no' }, { status: 404 });
    }
    if (url === ARB_RPC) {
      const { method, params } = body;
      if (method === 'eth_call') return Response.json({ jsonrpc: '2.0', id: 1, result: `0x${arbUsdc.toString(16).padStart(64, '0')}` });
      return Response.json({ jsonrpc: '2.0', id: 1, error: { message: `no ${method} ${params}` } });
    }
    return base.fetchImpl(url, init);
  }) as typeof fetch;
  const db = openDb();
  const wallets = new Wallets({ db, vault: new Vault(randomBytes(32)), catalog: new Catalog({ url: 'https://unused.test' }) });
  const w = wallets.create('Everyday', '1.00');
  const mover = new Mover({ wallets, db, rpc: { rpc: MOCK_RPC }, cowApi: MOCK_COW, fetchImpl: base.fetchImpl, sleep: async () => {} });
  const bridger = new Bridger({
    wallets, db, mover, fetchImpl, relayApi: RELAY, baseRpc: { rpc: MOCK_RPC, fetchImpl: base.fetchImpl },
    rpcFor: (t) => (t.network === 'Base' ? { rpc: MOCK_RPC, fetchImpl: base.fetchImpl } : { rpc: ARB_RPC, fetchImpl }), sleep: async () => {},
  });
  return { base, posted, db, w, bridger };
}

test('a move from Arbitrum: one signature by the wallet, posted to Relay, followed to success; nothing counted as a payment', async () => {
  const { base, posted, db, w, bridger } = world();
  const plan = await bridger.plan(w.id, 'Arbitrum', 'usdc');
  assert.equal(plan.route, 'relay');
  assert.equal(plan.amountUsd, '$5.00');
  assert.equal(plan.high, false);
  const states: BridgeState[] = [];
  const end = await bridger.run(w.id, 'Arbitrum', 'usdc', (s) => states.push(s));
  assert.equal(end.step, 'done', JSON.stringify(end));
  assert.equal(end.arrived, '$4.963363');
  assert.deepEqual(states.map((s) => s.step), ['checking', 'signing', 'moving', 'done']);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body, { kind: 'eip3009', requestId: RELAY_ID, api: 'swap' });
  // The signature is the wallet's, over exactly what the guard checked.
  const v = goodQuote(w.address).steps[0].items[0].data.sign;
  const signer = await recoverTypedDataAddress({
    domain: { ...v.domain, verifyingContract: v.domain.verifyingContract as VHex }, types: RECEIVE, primaryType: 'ReceiveWithAuthorization',
    message: { from: w.address as VHex, to: RELAY_PROXY as VHex, value: 5_000_000n, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 600), nonce: v.value.nonce as VHex },
    signature: posted[0].signature as VHex,
  });
  assert.equal(signer.toLowerCase(), w.address.toLowerCase());
  assert.equal(base.chain.sent.length, 0, 'no transaction from the wallet');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM payments').get() as any).n, 0, 'not a payment');
  assert.deepEqual(db.prepare('SELECT status, request_id FROM bridges').all().map((r: any) => [r.status, r.request_id]), [['done', RELAY_ID]]);
});

test('a refund is said as such; a quote the guard refuses fails before anything is signed or posted', async () => {
  const r = world({ statuses: ['pending', 'refund'] });
  const end = await r.bridger.run(r.w.id, 'Arbitrum', 'usdc', () => {});
  assert.equal(end.step, 'refunded');
  assert.match(end.error!, /refunded it to this wallet on Arbitrum/);

  const bad = world({ mutate: (q) => { q.steps[0].items[0].data.sign.value.to = '0x000000000000000000000000000000000000dEaD'; } });
  const refused = await bad.bridger.run(bad.w.id, 'Arbitrum', 'usdc', () => {});
  assert.equal(refused.step, 'failed');
  assert.match(refused.error!, /nothing was signed/);
  assert.equal(bad.posted.length, 0);
});

test('USDbC: gas bought with Base USDC, an approval for exactly the amount to CoW, then an order to this wallet with a checked minimum', async () => {
  const base = mockBase({ usdc: new Map(), eth: new Map() });
  const db = openDb();
  const wallets = new Wallets({ db, vault: new Vault(randomBytes(32)), catalog: new Catalog({ url: 'https://unused.test' }) });
  const w = wallets.create('Everyday', '1.00');
  base.chain.usdbc.set(w.address.toLowerCase(), 3_000_000n);
  base.chain.usdc.set(w.address.toLowerCase(), 500_000n);
  const mover = new Mover({ wallets, db, rpc: { rpc: MOCK_RPC }, cowApi: MOCK_COW, fetchImpl: base.fetchImpl, sleep: async () => {} });
  const bridger = new Bridger({ wallets, db, mover, fetchImpl: base.fetchImpl, baseRpc: { rpc: MOCK_RPC, fetchImpl: base.fetchImpl }, rpcFor: () => ({ rpc: MOCK_RPC, fetchImpl: base.fetchImpl }), sleep: async () => {} });

  const plan = await bridger.plan(w.id, 'Base', 'usdbc');
  assert.equal(plan.route, 'cow');
  assert.equal(plan.gasFromUsdc, true);
  const states: string[] = [];
  const end = await bridger.run(w.id, 'Base', 'usdbc', (s) => states.push(s.step));
  assert.equal(end.step, 'done', JSON.stringify(end));
  assert.deepEqual(states, ['checking', 'buying_gas', 'approving', 'signing', 'moving', 'done']);
  assert.deepEqual(base.chain.approvals, [{ token: USDBC, spender: COW.vaultRelayer.toLowerCase(), amount: 3_000_000n }]);
  const order = base.chain.orders.at(-1);
  assert.equal(order.sellToken.toLowerCase(), USDBC);
  assert.equal(order.buyToken, USDC.address);
  assert.equal(order.receiver, w.address);
  assert.equal(BigInt(order.sellAmount), 3_000_000n);
  assert.ok(BigInt(order.buyAmount) >= 2_850_000n, 'at least 95%');
  assert.equal(base.usdbcOf(w.address), 0n);
});

test('USDbC with no ETH and too little Base USDC for the fee is refused, plainly, before anything is signed', async () => {
  const base = mockBase({ usdc: new Map(), eth: new Map() });
  const db = openDb();
  const wallets = new Wallets({ db, vault: new Vault(randomBytes(32)), catalog: new Catalog({ url: 'https://unused.test' }) });
  const w = wallets.create('Everyday', '1.00');
  base.chain.usdbc.set(w.address.toLowerCase(), 3_000_000n);
  const mover = new Mover({ wallets, db, rpc: { rpc: MOCK_RPC }, cowApi: MOCK_COW, fetchImpl: base.fetchImpl, sleep: async () => {} });
  const bridger = new Bridger({ wallets, db, mover, fetchImpl: base.fetchImpl, baseRpc: { rpc: MOCK_RPC, fetchImpl: base.fetchImpl }, rpcFor: () => ({ rpc: MOCK_RPC, fetchImpl: base.fetchImpl }), sleep: async () => {} });
  await assert.rejects(bridger.plan(w.id, 'Base', 'usdbc'), /at least \$0\.11 of USDC on Base/);
  assert.equal(base.chain.sent.length, 0);
});
