// Getting USDC on Base (SPEC §16.9.2): the wrong-network finder over its pinned
// table (BNB Smart Chain's USDC has 18 decimals), an RPC answering as another
// chain skipped, dust ignored, the plain sentences (never "lost"), the deposit
// notification and what does not raise it, the once-a-minute limit, and the
// Troubleshoot line. A fake RPC: nothing here reaches the networks.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ELSEWHERE, elsewhereSentence, findElsewhere } from '../src/core/elsewhere.ts';
import { Catalog, toAtomic } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { troubleshoot } from '../src/app/troubleshoot.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

let portal: MockPortal;
before(async () => {
  portal = await startMockPortal();
});
after(() => portal.close());

const ADDRESS = '0x5d3f000000000000000000000000000000002445';
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

/** RPCs by URL: their chain ID and each token's balance for ADDRESS. Counts the calls. */
function fakeRpc(chains: Record<string, number>, balances: Record<string, bigint>) {
  const calls = { n: 0 };
  const fetchImpl = (async (url: any, init: any) => {
    calls.n++;
    const { method, params } = JSON.parse(init.body);
    if (method === 'eth_chainId') return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' + (chains[String(url)] ?? 0).toString(16) });
    const to = params[0].to.toLowerCase();
    assert.match(params[0].data, /^0x70a08231[0-9a-f]{64}$/, 'balanceOf an address');
    return Response.json({ jsonrpc: '2.0', id: 1, result: word(balances[to] ?? 0n) });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const CHAINS = Object.fromEntries(ELSEWHERE.map((t) => [t.rpc, t.chainId]));
const tok = (network: string, kind = 'usdc') => ELSEWHERE.find((t) => t.network === network && t.kind === kind)!.token.toLowerCase();

test('the pinned table: five other networks and USDbC, 6 decimals except BNB Smart Chain\'s 18, one chain ID per endpoint', () => {
  assert.equal(ELSEWHERE.length, 9);
  assert.deepEqual([...new Set(ELSEWHERE.map((t) => t.network))], ['Ethereum', 'Arbitrum', 'Optimism', 'Polygon', 'BNB Smart Chain', 'Base']);
  for (const t of ELSEWHERE) assert.equal(t.decimals, t.network === 'BNB Smart Chain' ? 18 : 6, t.network);
  for (const t of ELSEWHERE) assert.equal(CHAINS[t.rpc], t.chainId);
  assert.ok(ELSEWHERE.every((t) => t.token !== '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), 'the wallet\'s own USDC on Base is not "elsewhere"');
  assert.ok(ELSEWHERE.every((t) => t.rpc.endsWith('.api.pocket.network')));
});

test('amounts across decimals come out in dollars, in the table\'s order; dust under a cent is not reported', async () => {
  const { fetchImpl } = fakeRpc(CHAINS, {
    [tok('BNB Smart Chain')]: 5n * 10n ** 18n,
    [tok('Ethereum')]: 12_340_000n,
    [tok('Polygon', 'bridged')]: 9_999n, // under a cent
    [tok('Base', 'usdbc')]: 1_000_000n,
  });
  const r = await findElsewhere(ADDRESS, { fetchImpl });
  assert.deepEqual(r.found.map((f) => `${f.network} ${f.kind} ${f.usd}`), ['Ethereum usdc $12.34', 'BNB Smart Chain usdc $5.00', 'Base usdbc $1.00']);
  assert.deepEqual(r.unreadable, []);
});

test('an endpoint that answers as another chain is skipped and named unreadable', async () => {
  const { fetchImpl } = fakeRpc({ ...CHAINS, 'https://poly.api.pocket.network': 1 }, { [tok('Polygon')]: 5_000_000n, [tok('Ethereum')]: 5_000_000n });
  const r = await findElsewhere(ADDRESS, { fetchImpl });
  assert.deepEqual(r.found.map((f) => f.network), ['Ethereum']);
  assert.deepEqual(r.unreadable, ['Polygon']);
});

test('the sentences say it is safe and the person\'s, never lost, and what to choose next time', () => {
  const s = elsewhereSentence({ network: 'Arbitrum', kind: 'usdc', amount: 5_000_000n, decimals: 6, usd: '$5.00' });
  assert.match(s, /^\$5\.00 of USDC arrived on Arbitrum, not Base\. It is safe: it belongs to this wallet/);
  assert.match(s, /choose Base as the network\.$/);
  assert.doesNotMatch(s, /lost/i);
  assert.match(elsewhereSentence({ network: 'Base', kind: 'usdbc', amount: 1n, decimals: 6, usd: '$1.00' }), /arrived as USDbC, an older copy of USDC on Base/);
  // Top off no longer says other networks lose the money (§16.9.2).
  const topOff = readFileSync(new URL('../src/renderer/src/screens/Wallets.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(topOff, /would be lost/);
  assert.match(topOff, /the money is not lost, but the app cannot use it there/);
});

async function computer() {
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const notes: string[] = [];
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog, notifyText: (t, b) => notes.push(`${t} | ${b}`) });
  s.server = { listening: true } as any;
  const wallet = s.wallets.create('Everyday', '5.00');
  return { s, wallet, notes };
}

test('a deposit raises a notification; the first read, a drop, a move between this app\'s wallets, or notifications off do not', async () => {
  const { s, wallet, notes } = await computer();
  s.noteBalance(wallet.id, 0n);
  assert.deepEqual(notes, [], 'the first read only remembers');
  s.noteBalance(wallet.id, toAtomic('1', 6));
  assert.deepEqual(notes, ['$1.00 of USDC arrived in Everyday | It is ready to pay for your agents\' calls.']);
  s.noteBalance(wallet.id, toAtomic('0.995', 6));
  assert.equal(notes.length, 1, 'a payment is a drop');
  s.db.prepare("INSERT INTO moves (wallet, address, to_address, status, at) VALUES ('w_other', '0x1', ?, 'done', ?)").run(wallet.address.toUpperCase().replace('0X', '0x'), Date.now());
  s.noteBalance(wallet.id, toAtomic('3', 6));
  assert.equal(notes.length, 1, 'money moved in from another wallet here is not a deposit');
  s.db.prepare('DELETE FROM moves').run();
  s.setSettings({ notifications: false });
  s.noteBalance(wallet.id, toAtomic('4', 6));
  assert.equal(notes.length, 1);
});

test('looking elsewhere runs at most once a minute per wallet unless forced, and Troubleshoot shows a find as amber with Top off', async () => {
  const { s, wallet } = await computer();
  const { id } = s.core.createAgent('Chappy');
  s.wallets.assign(id, wallet.id);
  const { fetchImpl, calls } = fakeRpc(CHAINS, { [tok('Arbitrum')]: 2_500_000n });
  await s.checkElsewhere({ fetchImpl });
  const first = calls.n;
  assert.ok(first > 0);
  await s.checkElsewhere({ fetchImpl });
  assert.equal(calls.n, first, 'within a minute: no new reads');
  await s.checkElsewhere({ fetchImpl, force: true });
  assert.equal(calls.n, first * 2);
  s.outside.balances.set(wallet.id, toAtomic('10', 6));
  const line = troubleshoot(s, () => null).groups.find((g) => g.title === 'Money')!.items.find((i) => i.key === `elsewhere:${wallet.id}`)!;
  assert.equal(line.state, 'warn');
  assert.equal(line.text, 'Everyday holds $2.50 on Arbitrum. It is safe and yours, but the app can only use USDC on Base.');
  assert.deepEqual(line.action, { label: 'Top off', go: 'wallets', open: 'topOff', wallet: wallet.id });
});
