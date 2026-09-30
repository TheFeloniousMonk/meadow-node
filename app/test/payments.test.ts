// Payments (SPEC §16.9): wallet keys and signatures against viem, the spend
// guard's refusals, and the whole x402 exchange against a mock portal that
// checks every payment as a facilitator would.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mnemonicToAccount } from 'viem/accounts';
import { hashTypedData } from 'viem';
import { addressOf, newMnemonic, privateKeyFromMnemonic, signTransfer, transferDigest, type Hex } from '../src/core/evm.ts';
import { Catalog, formatUsd, toAtomic } from '../src/core/catalog.ts';
import { openDb } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { Wallets } from '../src/core/wallets.ts';
import { PortalTransport } from '../src/core/portal.ts';
import { Core } from '../src/core/core.ts';
import { TransportError } from '../src/core/transport.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

const TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] } as const;

test('wallet addresses and payment signatures match viem exactly', async () => {
  for (let i = 0; i < 5; i++) {
    const phrase = newMnemonic();
    assert.equal(phrase.split(' ').length, 12);
    const acct = mnemonicToAccount(phrase);
    const key = privateKeyFromMnemonic(phrase);
    assert.equal(addressOf(key), acct.address);
    const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Hex };
    const a = {
      from: acct.address, to: '0xF732ea490c5766071785a2310523f7fA2CEbB829' as Hex, value: String(1 + i * 4999),
      validAfter: '1790000000', validBefore: String(1790000060 + i), nonce: `0x${randomBytes(32).toString('hex')}` as Hex,
    };
    const message = { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) };
    assert.equal(`0x${Buffer.from(transferDigest(domain, a)).toString('hex')}`, hashTypedData({ domain, types: TYPES, primaryType: 'TransferWithAuthorization', message }));
    assert.equal(signTransfer(key, domain, a), await acct.signTypedData({ domain, types: TYPES, primaryType: 'TransferWithAuthorization', message }));
  }
});

test('dollar amounts convert to token units exactly', () => {
  assert.equal(toAtomic('0.005000', 6), 5000n);
  assert.equal(toAtomic('1', 6), 1_000_000n);
  assert.equal(toAtomic('0.5', 6), 500_000n);
  assert.throws(() => toAtomic('0.0000001', 6));
  assert.throws(() => toAtomic('-1', 6));
  assert.equal(formatUsd(5000n), '$0.005');
  assert.equal(formatUsd(1_000_000n), '$1.00');
  assert.equal(formatUsd(1_250_000n), '$1.25');
});

let portal: MockPortal;
before(async () => {
  portal = await startMockPortal();
});
after(() => portal.close());

function setup({ budget = '1.00' } = {}) {
  const db = openDb();
  const vault = new Vault(randomBytes(32));
  const catalog = new Catalog({ url: portal.catalogUrl });
  const wallets = new Wallets({ db, vault, catalog });
  const transport = new PortalTransport({ catalog, wallets });
  const core = new Core({ db, vault, transport });
  const w = wallets.create('Everyday', budget);
  const agent = (name: string) => {
    const { id } = core.createAgent(name);
    wallets.assign(id, w.id);
    return id;
  };
  return { db, core, wallets, catalog, transport, wallet: w, agent };
}

test('agents register, talk, and pay through the portal; every call is paid and recorded', async () => {
  portal.quote = {};
  const { core, wallets, wallet, agent } = setup();
  const alice = agent('alice');
  const bob = agent('bob');
  const before = portal.paid.length;
  await core.register(alice);
  await core.register(bob);
  const { result: dm } = await core.startDm(alice, bob); // a lookup, then the create and join
  await core.send(alice, dm, 'paid for');
  await core.sync(bob);
  await core.startDm(bob, alice);
  assert.deepEqual(core.messages(bob, { room: dm }).map((m) => m.text), ['paid for']);
  const calls = portal.paid.length - before;
  assert.ok(calls >= 6);
  assert.ok(portal.paid.slice(before).every((p) => p.from === wallet.address && p.value === '5000'));
  assert.equal(wallets.spent(wallet.id), BigInt(calls) * 5000n);
  assert.ok(wallets.payments().every((p) => p.status === 'settled' && p.tx));
});

test('the guard refuses terms the catalog does not show, and signs nothing', async () => {
  const { transport, wallets, agent } = setup();
  const alice = agent('alice');
  const cases: [MockPortal['quote'], RegExp][] = [
    [{ payTo: '0x000000000000000000000000000000000000dEaD' }, /pay an address its price list does not show/],
    [{ amount: '6000' }, /more than its listed price of \$0\.005/],
    [{ asset: '0x0000000000000000000000000000000000000001' }, /did not offer a way to pay in USDC on Base/],
    [{ network: 'eip155:1' }, /did not offer a way to pay in USDC on Base/],
    [{ scheme: 'upto' }, /did not offer a way to pay in USDC on Base/],
  ];
  for (const [quote, message] of cases) {
    portal.quote = quote;
    await assert.rejects(transport.call('/v2/rooms', {}, alice), (e: any) => e instanceof TransportError && e.kind === 'refused' && message.test(e.message));
  }
  portal.quote = {};
  assert.equal(wallets.payments().length, 0);
});

test('the per-call maximum and the daily budget refuse in plain words', async () => {
  portal.quote = {};
  const { transport, wallets, agent, wallet } = setup({ budget: '0.012' });
  const alice = agent('alice');
  wallets.setPerCallMax('0.004');
  await assert.rejects(transport.call('/v2/rooms', {}, alice), /costs \$0\.005, more than the most you allow per call \(\$0\.004\)/);
  wallets.setPerCallMax('0.01');
  await transport.call('/v2/rooms', {}, alice);
  await transport.call('/v2/rooms', {}, alice);
  await assert.rejects(transport.call('/v2/rooms', {}, alice), /daily budget of the wallet "Everyday" is spent: \$0\.01 of \$0\.012 in the last 24 hours\. Enough frees up at/);
  assert.equal(wallets.spent(wallet.id), 10000n);
  wallets.setBudget(wallet.id, '0.001');
  await assert.rejects(transport.call('/v2/rooms', {}, alice), /\(\$0\.001\) is less than one call/);
});

test('an agent with no wallet cannot pay', async () => {
  const { core, transport } = setup();
  const { id } = core.createAgent('nowallet');
  await assert.rejects(transport.call('/v2/rooms', {}, id), /No wallet pays for this agent/);
});

test('removing a wallet needs its exact name, forgets its phrase, and leaves its agents unable to pay', async () => {
  const { db, core, wallets, transport, wallet, agent } = setup();
  const id = agent('removed');
  assert.throws(() => wallets.remove(wallet.id, 'everyday'), /Type the wallet's name, Everyday/);
  assert.throws(() => wallets.remove(wallet.id, ''), /Type the wallet's name/);
  assert.throws(() => wallets.remove('w_nope', 'Everyday'), /no such wallet/);
  assert.equal(wallets.list().length, 1);
  wallets.remove(wallet.id, ' Everyday ');
  assert.equal(wallets.list().length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wallets').get()!.n, 0);
  assert.equal(wallets.walletOf(id), null);
  await assert.rejects(transport.call('/v2/rooms', {}, id), /No wallet pays for this agent/);
  // The agent itself stays; only its wallet is gone.
  assert.equal(core.agents().length, 1);
});

test('a second 402 after paying is a failure, never a second signature', async () => {
  portal.quote = {};
  portal.always402 = true;
  const { transport, wallets, agent } = setup();
  const alice = agent('alice');
  try {
    await assert.rejects(transport.call('/v2/rooms', {}, alice), (e: any) => e.kind === 'http' && /did not accept the payment \(payment_rejected\)/.test(e.message));
  } finally {
    portal.always402 = false;
  }
  const payments = wallets.payments();
  assert.equal(payments.length, 1);
  assert.equal(payments[0].status, 'failed');
});

test('a price change is picked up by reading the catalog again, once', async () => {
  portal.quote = {};
  portal.catalogPriceUsd = '0.004000';
  const { transport, catalog, agent } = setup();
  const alice = agent('alice');
  await catalog.refresh(); // the app read the old price
  portal.catalogPriceUsd = '0.005000'; // the price went up; the portal quotes it
  const res = await transport.call('/v2/rooms', {}, alice);
  assert.equal(res.status, 200);
  assert.equal(res.cost?.usd, '$0.005');
  assert.equal(catalog.priceAtomic('meadow')?.atomic, 5000n);
});

test('a refused payment queues the write; it goes once the budget allows', async () => {
  portal.quote = {};
  const { core, wallets, wallet, agent } = setup();
  const alice = agent('alice');
  await core.register(alice);
  const { result: room } = await core.createRoom(alice, { type: 'public' });
  wallets.setBudget(wallet.id, formatUsd(wallets.spent(wallet.id)).slice(1));
  const out = await core.send(alice, room, 'queued');
  assert.equal(out.sent, false);
  assert.match(out.refused!, /daily budget/);
  assert.equal(core.outbox(alice).length, 1);
  wallets.setBudget(wallet.id, '1.00');
  await core.sync(alice);
  assert.deepEqual(core.outbox(alice), []);
});
