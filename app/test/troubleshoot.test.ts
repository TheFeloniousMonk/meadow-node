// Troubleshoot (SPEC §16.21): every line in dependency order, the verdict on the
// first red one with its button, amber never in the verdict while something is
// red, grey choices never faults, the money rules (empty, low, budget spent,
// background syncing over budget, no wallet), the ChatGPT lines, and the
// outside checks: free, at most once a minute unless asked again.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Catalog, toAtomic } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { createPublicServer } from '../src/server/public.ts';
import { runOutside, troubleshoot, LOW_DAYS } from '../src/app/troubleshoot.ts';
import type { ClaudeState } from '../src/app/check.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

let portal: MockPortal;
before(async () => {
  portal = await startMockPortal();
});
after(() => portal.close());

const TUNNEL = 'https://meadow-trouble.example';
/** The other networks' RPCs, unreachable here: the wrong-network finder reads nothing (it has its own tests). */
const offline = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
const claudeOk = (): ClaudeState => ({ installed: true, upToDate: true, unreadable: false });

async function computer(budget = '5.00') {
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog });
  // The interfaces are listening, as in the running app (the tests do not open real ports for them).
  s.server = { listening: true } as any;
  const wallet = s.wallets.create('Everyday', budget).id;
  const agent = async (name: string, type: 'claude' | 'chatgpt' | 'other' = 'claude', { pay = true } = {}) => {
    const { id } = s.core.createAgent(name);
    s.connections.set(id, type, name);
    if (pay) {
      s.wallets.assign(id, wallet);
      await s.core.register(id);
      await s.syncOne(id);
    }
    return id;
  };
  const price = s.catalog.priceAtomic('meadow')!.atomic;
  const view = () => troubleshoot(s, claudeOk);
  const line = (key: string, group?: string) => view().groups.filter((g) => !group || g.title === group).flatMap((g) => g.items).find((i) => i.key === key)!;
  return { s, wallet, agent, price, view, line };
}

const usdc = (usd: string) => toAtomic(usd, 6);

test('all working but one amber line: the verdict says everything works and counts it; grey choices are not faults', async () => {
  const { s, wallet, agent, view, line } = await computer();
  await agent('Chappy');
  s.outside.balances.set(wallet, usdc('20'));
  const v = view();
  assert.deepEqual(v.groups.map((g) => g.title), ['This computer', 'Money', 'Chappy']);
  assert.deepEqual(v.groups[2].items.map((i) => i.key), ['registered', 'network', 'bridge', 'lastcall', 'backup', 'waiting']);
  assert.equal(v.verdict.state, 'ok');
  assert.equal(v.verdict.amber, 1, 'only "Claude has not called Meadow yet"');
  assert.match(v.verdict.text, /^Everything is working\. One thing could use a look below\.$/);
  assert.equal(line('guard').state, 'info');
  assert.equal(line('login').state, 'info');
  assert.deepEqual(line('login').action, { label: 'Turn on', run: 'startAtLogin' });
  assert.match(line('balance:' + wallet).text, /^Everyday: \$20\.00, about \d+ days of background syncing\.$/);
  assert.equal(line('backup').state, 'info', 'never backed up, with nothing private, is a choice');
});

test('an empty wallet is the first red line, with Top off; amber lines below never take the verdict', async () => {
  const { s, wallet, agent, view } = await computer();
  await agent('Chappy');
  s.outside.balances.set(wallet, 0n);
  const v = view();
  assert.equal(v.verdict.state, 'bad');
  assert.match(v.verdict.text, /^Everything is working except wallets: Everyday is empty \(\$0\.00\), so its agents' calls cannot be paid\.$/);
  assert.deepEqual(v.verdict.action, { label: 'Top off', go: 'wallets', open: 'topOff', wallet });
  assert.ok(v.verdict.amber >= 1, 'the amber line is still counted, below');
});

test('the order decides the verdict: a dead interface comes before an empty wallet, and the rest are counted', async () => {
  const { s, wallet, agent, view } = await computer();
  await agent('Chappy');
  s.outside.balances.set(wallet, 0n);
  s.server = null;
  s.serverError = 'Port 47733 is taken by another program; choose another in Settings.';
  const v = view();
  assert.match(v.verdict.text, /^Everything is working except the app's interfaces: Open Settings, then Connections, and choose another port\.$/);
  assert.equal(v.verdict.more, 1);
});

test(`a balance under ${LOW_DAYS} days of background syncing is amber, from the live price and the sync interval`, async () => {
  const { s, wallet, agent, price, line } = await computer();
  await agent('Chappy');
  const perDay = BigInt(Math.ceil((24 * 60) / s.settings().syncMinutes)) * price;
  s.outside.balances.set(wallet, perDay * BigInt(LOW_DAYS) - 1n);
  const l = line('balance:' + wallet);
  assert.equal(l.state, 'warn');
  assert.match(l.text, /less than 3 days of background syncing/);
  s.setSettings({ syncEnabled: false });
  assert.equal(line('balance:' + wallet).state, 'ok', 'with no background syncing, nothing runs it down');
});

test('a budget smaller than one call is red; background syncing over budget is amber', async () => {
  const tiny = await computer('0.000001');
  await tiny.agent('Chappy', 'claude', { pay: false }).then((id) => tiny.s.wallets.assign(id, tiny.wallet));
  tiny.s.outside.balances.set(tiny.wallet, usdc('20'));
  const red = tiny.line('budget:' + tiny.wallet);
  assert.equal(red.state, 'bad');
  assert.match(red.text, /daily budget \(\$0\.000001\) is less than one call/);
  assert.deepEqual(red.action, { label: 'Change the budget', go: 'wallets', open: 'budget', wallet: tiny.wallet });

  const { s, wallet, agent, line } = await computer('0.30');
  await agent('Chappy');
  s.outside.balances.set(wallet, usdc('20'));
  const amber = line('budget:' + wallet);
  assert.equal(amber.state, 'warn');
  assert.match(amber.text, /^Background syncing alone needs about \$0\.48 a day for Everyday's 1 agent, more than its daily budget of \$0\.30\.$/);
});

test('an agent with no wallet is red, with a button that points at its wallet choice', async () => {
  const { agent, view } = await computer();
  const id = await agent('Orphan', 'claude', { pay: false });
  const v = view();
  assert.match(v.verdict.text, /^Everything is working except wallets: Orphan has no wallet to pay for its calls\.$/);
  assert.deepEqual(v.verdict.action, { label: 'Choose a wallet', go: 'agents', open: 'chooseWallet', agent: id });
});

test('a ChatGPT agent: tunnel off is red with Turn the tunnel on; with the tunnel up, the outside checks prove the sign-in protection, for free', async () => {
  const { s, wallet, agent, view, line } = await computer();
  const id = await agent('Chappy GPT', 'chatgpt');
  s.outside.balances.set(wallet, usdc('20'));
  let v = view();
  const tunnel = v.groups[2].items.find((i) => i.key === 'tunnel')!;
  assert.equal(tunnel.state, 'bad');
  assert.deepEqual(tunnel.action, { label: 'Turn the tunnel on', go: 'settings' });

  // The door on a random port, reached as the tunnel would reach it.
  const server = createPublicServer({ host: s.tools, oauth: s.oauth, version: 'test', diagnostics: s.diagnostics, base: () => s.tunnel.url, agents: () => s.chatgptAgents(), onRequest: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  s.publicServer = server;
  const port = (server.address() as AddressInfo).port;
  const viaTunnel = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    return new Promise<Response>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: u.pathname, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}), host: u.host } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as any })));
      });
      req.on('error', reject);
      if (init.body) req.write(init.body);
      req.end();
    });
  }) as typeof fetch;
  s.tunnel.fetchImpl = viaTunnel;
  s.tunnel.doorFetch = viaTunnel;
  try {
    await s.tunnel.start({ provider: 'custom', port, customUrl: TUNNEL });
    await s.tunnel.settled();
    assert.equal(line('protection').state, 'info', 'not checked yet');
    const paid = portal.paid.length;
    let balanceReads = 0;
    const ran = await runOutside(s, { fetchImpl: viaTunnel, elsewhereFetch: offline, balanceOf: async () => (balanceReads++, usdc('20')) });
    assert.equal(ran, true);
    assert.equal(portal.paid.length, paid, 'no paid call');
    assert.equal(balanceReads, 1);
    assert.equal(line('protection').state, 'ok');
    assert.equal(line('tunnel').state, 'ok');
    v = view();
    assert.equal(v.groups[2].items.find((i) => i.key === 'signin')!.state, 'bad', 'not paired yet');
    assert.deepEqual(v.verdict.action, { label: 'Pair ChatGPT again', go: 'agents', open: 'chatgpt', agent: id });

    // At most once a minute, unless asked again.
    assert.equal(await runOutside(s, { fetchImpl: viaTunnel, elsewhereFetch: offline, balanceOf: async () => (balanceReads++, 0n) }), false);
    assert.equal(balanceReads, 1);
    assert.equal(await runOutside(s, { again: true, fetchImpl: viaTunnel, elsewhereFetch: offline, balanceOf: async () => (balanceReads++, 0n) }), true);
    assert.equal(balanceReads, 2);
    assert.equal(line('balance:' + wallet).state, 'bad');
  } finally {
    await s.tunnel.stop();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a balance Base could not give is amber with what to try, and one never read is only "checking"', async () => {
  const { s, wallet, agent, line } = await computer();
  await agent('Chappy');
  assert.equal(line('balance:' + wallet).state, 'info');
  s.outside.balances.set(wallet, null);
  assert.equal(line('balance:' + wallet).state, 'warn');
  assert.match(line('balance:' + wallet).fix!, /internet connection/);
});
