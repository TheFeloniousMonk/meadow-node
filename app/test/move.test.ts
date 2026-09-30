// Moving money out (SPEC §16.9.1): every encoding the move signs, against viem,
// and the whole move against a mock Base node and a mock CoW Protocol API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import {
  decodeFunctionData, encodeFunctionData, hashTypedData, keccak256, parseAbi, parseTransaction, recoverTypedDataAddress, serializeTransaction,
  recoverTransactionAddress, type Hex as VHex,
} from 'viem';
import {
  addressOf, cowOrderDigest, erc20TransferData, permitCallData, permitDigest, signDigest, signTx1559, validAddress, type CowOrder, type Hex, type Permit,
} from '../src/core/evm.ts';
import { openDb } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { Catalog, USDC } from '../src/core/catalog.ts';
import { Wallets } from '../src/core/wallets.ts';
import { COW, Mover, type MoveState } from '../src/core/move.ts';
import { MOCK_COW, MOCK_RPC, mockBase } from './mock-base.ts';

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}` as VHex;
const usdcDomain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC.address as Hex };
const cowDomain = { name: 'Gnosis Protocol', version: 'v2', chainId: 8453, verifyingContract: COW.settlement };
const ERC20 = parseAbi(['function transfer(address to, uint256 amount)', 'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)']);

test('the permit digest and its call data match viem', async () => {
  const key = randomBytes(32);
  const owner = addressOf(key);
  const p: Permit = { owner, spender: COW.vaultRelayer, value: '123456', nonce: '7', deadline: '1790000000' };
  const types = { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] } as const;
  const message = { owner, spender: p.spender, value: 123456n, nonce: 7n, deadline: 1790000000n };
  assert.equal(hex(permitDigest(usdcDomain, p)), hashTypedData({ domain: usdcDomain, types, primaryType: 'Permit', message }));
  const sig = signDigest(key, permitDigest(usdcDomain, p));
  assert.equal(await recoverTypedDataAddress({ domain: usdcDomain, types, primaryType: 'Permit', message, signature: sig }), owner);
  const call = decodeFunctionData({ abi: ERC20, data: permitCallData(p, sig) });
  assert.equal(call.functionName, 'permit');
  assert.deepEqual(call.args.slice(0, 5), [owner, COW.vaultRelayer, 123456n, 1790000000n, Number(BigInt('0x' + sig.slice(130)))]);
  assert.equal(call.args[5], `0x${sig.slice(2, 66)}`);
  assert.equal(call.args[6], `0x${sig.slice(66, 130)}`);
});

test('the CoW order digest matches viem', () => {
  const o: CowOrder = {
    sellToken: USDC.address, buyToken: COW.eth, receiver: '0x9204A37abeca67A1b0B614F2badc0EC6C8ed55f3', sellAmount: '100000', buyAmount: '37000000000000',
    validTo: 1790729390, appData: keccak256(new TextEncoder().encode('{}')) as Hex, feeAmount: '0', kind: 'sell', partiallyFillable: false,
    sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
  };
  const types = { Order: [
    { name: 'sellToken', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'receiver', type: 'address' }, { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' }, { name: 'validTo', type: 'uint32' }, { name: 'appData', type: 'bytes32' }, { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' }, { name: 'partiallyFillable', type: 'bool' }, { name: 'sellTokenBalance', type: 'string' }, { name: 'buyTokenBalance', type: 'string' }] } as const;
  const message = { ...o, sellAmount: 100000n, buyAmount: 37000000000000n, feeAmount: 0n };
  assert.equal(hex(cowOrderDigest(cowDomain, o)), hashTypedData({ domain: cowDomain, types, primaryType: 'Order', message }));
  // And the empty app data hash is the one CoW's API documents for "{}".
  assert.equal(o.appData, '0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d');
});

test('the EIP-1559 transaction is byte-identical to viem, and signed by the wallet', async () => {
  const key = randomBytes(32);
  const account = privateKeyToAccount(hex(key));
  const to = '0x1111111111111111111111111111111111111111';
  for (const [nonce, value, amount] of [[0n, 0n, 1n], [5n, 0n, 1234567n], [300n, 1n, 10n ** 30n]] as const) {
    const t = { chainId: 8453, nonce, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 11_000_000n, gas: 84_500n, to: USDC.address as Hex, value, data: erc20TransferData(to, amount) };
    const mine = signTx1559(key, t);
    const theirs = await account.signTransaction({ type: 'eip1559', chainId: 8453, nonce: Number(nonce), maxPriorityFeePerGas: t.maxPriorityFeePerGas, maxFeePerGas: t.maxFeePerGas, gas: t.gas, to: t.to, value, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, amount] }) });
    assert.equal(mine.raw, theirs);
    assert.equal(mine.hash, keccak256(theirs));
    assert.equal(await recoverTransactionAddress({ serializedTransaction: mine.raw as any }), account.address);
  }
  assert.equal(serializeTransaction(parseTransaction(signTx1559(key, { chainId: 8453, nonce: 0n, maxPriorityFeePerGas: 0n, maxFeePerGas: 0n, gas: 0n, to, value: 0n, data: '0x' }).raw as any) as any).length > 0, true);
});

test('addresses: lower, upper, and valid checksums pass; a bad checksum does not', () => {
  assert.ok(validAddress('0x9204A37abeca67A1b0B614F2badc0EC6C8ed55f3'));
  assert.ok(validAddress('0x9204a37abeca67a1b0b614f2badc0ec6c8ed55f3'));
  assert.ok(validAddress('0x9204A37ABECA67A1B0B614F2BADC0EC6C8ED55F3'));
  assert.ok(!validAddress('0x9204A37abeca67A1b0B614F2badc0EC6C8ed55F3'));
  assert.ok(!validAddress('0x9204a37abeca67a1b0b614f2badc0ec6c8ed55f'));
  assert.ok(!validAddress('9204a37abeca67a1b0b614f2badc0ec6c8ed55f3'));
});

// --- The whole move, against mocks ---------------------------------------------------

const DEST = '0x2222222222222222222222222222222222222222';

function world({ usdc = 5_000_000n, eth = 0n, fill = 'fulfilled' as 'fulfilled' | 'expired', code = '0x' } = {}) {
  const db = openDb();
  const wallets = new Wallets({ db, vault: new Vault(randomBytes(32)), catalog: new Catalog({ url: 'https://unused.test' }) });
  const w = wallets.create('Everyday', '1.00');
  const base = mockBase({ usdc: new Map([[w.address.toLowerCase(), usdc]]), eth: new Map([[w.address.toLowerCase(), eth]]), fill, code });
  const mover = new Mover({ wallets, db, rpc: { rpc: MOCK_RPC }, cowApi: MOCK_COW, fetchImpl: base.fetchImpl, sleep: async () => {} });
  return { chain: base.chain, base, db, wallets, w, mover };
}

test('a wallet with no ETH swaps a little USDC for the fee through CoW, then sends everything else', async () => {
  const { chain, base, db, w, mover } = world();
  const plan = await mover.plan(w.id, DEST);
  assert.equal(plan.swap, 100_000n);
  assert.equal(plan.arrives, 4_900_000n);
  const states: MoveState[] = [];
  const end = await mover.run(w.id, DEST, (s) => states.push(s));
  assert.equal(end.step, 'done', end.error);
  assert.deepEqual(states.map((s) => s.step), ['checking', 'swapping', 'sending', 'done']);
  assert.equal(end.amount, '$4.90');
  assert.equal(base.usdcOf(w.address), 0n);
  assert.equal(base.usdcOf(DEST), 4_900_000n);

  // The order: USDC for native ETH, to the wallet itself, signed by the wallet, with a permit hook for exactly its sell amount.
  const o = chain.orders[0];
  assert.equal(o.buyToken, COW.eth);
  assert.equal(o.receiver, w.address);
  assert.equal(o.from, w.address);
  assert.equal(o.feeAmount, '0');
  assert.equal(keccak256(new TextEncoder().encode(o.appData)), o.appDataHash);
  const hook = JSON.parse(o.appData).metadata.hooks.pre[0];
  assert.equal(hook.target, USDC.address);
  const permit = decodeFunctionData({ abi: ERC20, data: hook.callData });
  assert.deepEqual(permit.args.slice(0, 3), [w.address, COW.vaultRelayer, BigInt(o.sellAmount)]);
  assert.equal(BigInt(o.buyAmount), (BigInt(o.sellAmount) * 370_000_000n * 95n) / 100n);
  // The quote priced the same app data, so the hook's gas is in the fee.
  assert.equal(chain.quotes[0].appData, o.appData);

  // The transfer: USDC.transfer(DEST, everything left), from the wallet, on Base.
  const t = parseTransaction(chain.sent[0]);
  assert.equal(t.chainId, 8453);
  assert.equal(t.to?.toLowerCase(), USDC.address.toLowerCase());
  assert.deepEqual(decodeFunctionData({ abi: ERC20, data: t.data! }).args, [DEST, 4_900_000n]);
  assert.equal((await recoverTransactionAddress({ serializedTransaction: chain.sent[0] as any })).toLowerCase(), w.address.toLowerCase());
  assert.deepEqual({ ...db.prepare('SELECT status, amount, to_address FROM moves').get() }, { status: 'done', amount: '$4.90', to_address: DEST });
});

test('a wallet that already has enough ETH sends at once, with no swap', async () => {
  const { chain, w, mover } = world({ eth: 10n ** 15n });
  assert.equal((await mover.plan(w.id, DEST)).swap, null);
  const end = await mover.run(w.id, DEST, () => {});
  assert.equal(end.step, 'done');
  assert.equal(chain.orders.length, 0);
  assert.equal(end.amount, '$5.00');
});

test('a swap no one takes moves nothing and says so', async () => {
  const { chain, w, mover } = world({ fill: 'expired' });
  const end = await mover.run(w.id, DEST, () => {});
  assert.equal(end.step, 'failed');
  assert.match(end.error!, /No one took the swap/);
  assert.equal(chain.sent.length, 0);
});

test('bad destinations and wallets too small to move are refused before anything is signed', async () => {
  const { w, mover, chain } = world({ usdc: 50_000n });
  await assert.rejects(mover.plan(w.id, 'not an address'), /not a valid address/);
  await assert.rejects(mover.plan(w.id, w.address), /this wallet's own address/);
  await assert.rejects(mover.plan(w.id, USDC.address), /contract, not a wallet/);
  await assert.rejects(mover.plan(w.id, '0x2222222222222222222222222222222222222222'.replace('0x22', '0x2A')), (e: Error) => /valid|holds/.test(e.message));
  await assert.rejects(mover.plan(w.id, DEST), /too little to move/);
  assert.equal(chain.orders.length + chain.sent.length, 0);
});

test('a contract destination is flagged in the plan', async () => {
  const { w, mover } = world({ code: '0x6080' });
  assert.equal((await mover.plan(w.id, DEST)).contract, true);
});

test('the window cannot move money past the typed check or the system dialog', async () => {
  const { Services } = await import('../src/app/services.ts');
  const { createHandlers } = await import('../src/app/handlers.ts');
  const catalog = new Catalog({ fetchImpl: (async () => ({ ok: true, json: async () => ({ services: [] }) })) as unknown as typeof fetch });
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog });
  const w = s.wallets.create('Everyday', '1.00');
  const other = s.wallets.create('Fresh', '1.00');
  const base = mockBase({ usdc: new Map([[w.address.toLowerCase(), 3_000_000n]]) });
  (s as any).mover = new Mover({ wallets: s.wallets, db: s.db, rpc: { rpc: MOCK_RPC }, cowApi: MOCK_COW, fetchImpl: base.fetchImpl, sleep: async () => {} });
  const asked: string[] = [];
  let answer = false;
  const handle = createHandlers(s, {
    execPath: 'x', bridgeScript: 'x', copy: () => {}, openExternal: () => {}, saveFile: async () => null, openFile: async () => null,
    confirmMove: async ({ message }) => (asked.push(message), answer),
  });

  const plan: any = await handle('movePlan', { walletId: w.id, to: other.id });
  assert.equal(plan.toWallet, 'Fresh');
  assert.equal(plan.to, other.address);
  assert.equal(plan.swapUsd, '$0.10');

  // An outside address needs its last 4 characters typed back, before the system dialog is even shown.
  assert.deepEqual(await handle('moveStart', { walletId: w.id, to: DEST, confirm: 'nope' }), { ok: false, error: 'Type the last 4 characters of the address to confirm it.' });
  assert.equal(asked.length, 0);
  // The system dialog says no: nothing moves.
  assert.deepEqual(await handle('moveStart', { walletId: w.id, to: DEST, confirm: '2222' }), { ok: false, error: 'Nothing moved.' });
  assert.equal(asked.length, 1);
  assert.equal(base.chain.orders.length + base.chain.sent.length, 0);

  // To one of this app's wallets, no typing; the system dialog still asks.
  answer = true;
  assert.deepEqual(await handle('moveStart', { walletId: w.id, to: other.id, confirm: '' }), { ok: true });
  assert.match(asked[1], /Move about \$2\.90 out of Everyday/);
  for (let i = 0; i < 50 && (await handle('moveStatus', { walletId: w.id }) as any)?.step !== 'done'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await handle('moveStatus', { walletId: w.id }) as any).step, 'done');
  assert.equal(base.usdcOf(other.address), 2_900_000n);
});
