// The payment rail is pinned in code (SPEC §16.9): a price list or a 402 that
// changes the token, its decimals, or its signing domain is refused, and no
// authorization outlives five minutes. Found by the app's security review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { Catalog, USDC } from '../src/core/catalog.ts';
import { Wallets } from '../src/core/wallets.ts';
import { Core } from '../src/core/core.ts';

const PAY_TO = '0xF732ea490c5766071785a2310523f7fA2CEbB829';

async function setup(rail: Record<string, unknown> = {}) {
  const list = { services: [{ serviceId: 'meadow', displayName: 'Meadow', resourceUrl: 'https://portal.test/v1/meadow', priceUsd: '0.005000',
    rails: [{ id: 'base', network: 'eip155:8453', chainId: 8453, tokenAddress: USDC.address, tokenDecimals: 6, payToAddress: PAY_TO, ...rail }] }] };
  const catalog = new Catalog({ fetchImpl: (async () => new Response(JSON.stringify(list))) as unknown as typeof fetch });
  await catalog.refresh();
  const db = openDb();
  const vault = new Vault(randomBytes(32));
  const wallets = new Wallets({ db, vault, catalog });
  const w = wallets.create('Test', '0.02');
  const { id } = new Core({ db, vault, transport: { call: async () => ({ status: 500, data: {} }) } }).createAgent('tester');
  wallets.assign(id, w.id);
  return { wallets, id };
}

const offer = (amount: string, terms: Record<string, unknown> = {}) => ({
  x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount, asset: USDC.address, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' }, ...terms }],
});

test('a price list that changes the decimals or the token is refused', async () => {
  // With 18 decimals, $1.00 of real USDC (1,000,000 units) would count as a millionth of a millionth of a cent.
  const { wallets: w18, id } = await setup({ tokenDecimals: 18 });
  assert.throws(() => w18.check({ agent: id, serviceId: 'meadow', offer: offer('1000000') }), /describes meadow's payment differently/);
  const { wallets: other, id: id2 } = await setup({ tokenAddress: '0x0000000000000000000000000000000000000001' });
  assert.throws(() => other.check({ agent: id2, serviceId: 'meadow', offer: offer('5000', { asset: '0x0000000000000000000000000000000000000001' }) }), /differently from USDC on Base/);
});

test('a 402 that names another signing domain is refused', async () => {
  const { wallets: w, id } = await setup();
  assert.throws(() => w.check({ agent: id, serviceId: 'meadow', offer: offer('5000', { extra: { name: 'Fake', version: '2' } }) }), /not USDC/);
  assert.equal(w.check({ agent: id, serviceId: 'meadow', offer: offer('5000') }).usd, '$0.005');
});

test('an authorization is valid for five minutes at most, whatever the 402 asks', async () => {
  const { wallets: w, id } = await setup();
  const a = w.authorize({ agent: id, serviceId: 'meadow', path: '/v2/sync', offer: offer('5000', { maxTimeoutSeconds: 1_000_000_000 }) });
  const auth = JSON.parse(Buffer.from(a.header, 'base64').toString()).payload.authorization;
  assert.ok(Number(auth.validBefore) - Math.floor(Date.now() / 1000) <= 300);
});
