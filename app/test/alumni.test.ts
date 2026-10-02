// The alumni club from the app's side (SPEC §18.8): validating a key, paying
// through the club while active (recorded under "Alumni club", accepted by the
// portal), the fallback to the agent's own wallet at the cap or with the club
// unreachable, an answer that does not match the terms, a membership that
// ends, the browser link with PKCE, and what the tools report. A stand-in club
// signs with a test key; nothing reaches the real one.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { addressOf, signTransfer, type Hex } from '../src/core/evm.ts';
import { TransportError } from '../src/core/transport.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

const MEMBER_KEY = randomBytes(32);
const MEMBER = addressOf(MEMBER_KEY);
const KEY = 'mclub1.eyJtIjoibV90ZXN0In0.c2lnbmF0dXJl';

/** A stand-in club: answers status, pay, redeem, cancel as the real one does (§18.14). */
async function startClub() {
  const club = {
    url: '', active: true, refuse: null as null | { code: string; refused: string }, down: false, tamper: false,
    pays: 0, redeemed: [] as string[], codes: new Map<string, string>(), cancelled: false,
    server: null as unknown as http.Server,
  };
  club.server = http.createServer(async (req, res) => {
    if (club.down) return req.socket.destroy();
    const body = await new Promise<any>((r) => { let s = ''; req.on('data', (c) => (s += c)).on('end', () => r(s ? JSON.parse(s) : {})); });
    const send = (v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    const path = req.url!.replace(/^\/alumni\/api\//, '');
    if (path !== 'redeem' && body.key !== KEY) return send({ refused: 'This alumni membership key is not valid any more.', code: 'key' });
    if (path === 'status') {
      return send(club.active
        ? { active: true, member: 'Jinx', tier: 'premium', tier_name: 'Premium', paid_through: '2099-01-01', cancelled: club.cancelled,
          settings: { daily_cap_usd: '1.50', receive_interval_min: 15, messageguard: true, combine_syncs: true }, spent_24h_usd: '$0.00', allowance_left_usd: '$1.50',
          payer_address: MEMBER, history: [{ date: '2026-10-02', amount: '50.00', currency: 'USD', tier: 'Premium', status: 'completed' }] }
        : { active: false, member: 'Jinx', ended: 'expired', history: [] });
    }
    if (path === 'pay') {
      if (club.refuse) return send(club.refuse);
      club.pays++;
      const t = body.term;
      const nowS = Math.floor(Date.now() / 1000);
      const authorization = { from: MEMBER, to: club.tamper ? '0x000000000000000000000000000000000000dEaD' : t.payTo, value: t.amount, validAfter: String(nowS - 60), validBefore: String(nowS + 60), nonce: `0x${randomBytes(32).toString('hex')}` as Hex };
      const signature = signTransfer(MEMBER_KEY, { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, authorization as any);
      return send({ from: MEMBER, authorization, signature, allowance_left_usd: '$1.495' });
    }
    if (path === 'redeem') {
      const challenge = club.codes.get(body.code);
      if (!challenge || createHash('sha256').update(body.verifier).digest('base64url') !== challenge) return send({ refused: 'That code has expired or was already used.', code: 'code' });
      club.redeemed.push(body.code);
      return send({ key: KEY });
    }
    if (path === 'cancel') {
      club.cancelled = true;
      return send({ cancelled: true, runs_until: '2099-01-01' });
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => club.server.listen(0, '127.0.0.1', r));
  club.url = `http://127.0.0.1:${(club.server.address() as AddressInfo).port}/alumni`;
  return club;
}

let portal: MockPortal;
let club: Awaited<ReturnType<typeof startClub>>;
before(async () => {
  portal = await startMockPortal();
  club = await startClub();
});
after(async () => {
  await portal.close();
  club.server.close();
});

async function computer(opts: { withWallet?: boolean } = {}) {
  club.active = true;
  club.refuse = null;
  club.down = false;
  club.tamper = false;
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog, alumniUrl: club.url });
  const { id } = s.core.createAgent('lolly');
  s.connections.set(id, 'claude', 'lolly');
  let wallet: string | null = null;
  if (opts.withWallet !== false) {
    wallet = s.wallets.create('Everyday', '5.00').id;
    s.wallets.assign(id, wallet);
  }
  return { s, agent: id, wallet };
}

const payments = (s: Services) => s.db.prepare('SELECT wallet, service, status FROM payments ORDER BY seq').all() as any[];

test('a key that is not one is refused before asking the club; a refused key is refused; a good one makes the membership active', async () => {
  const { s } = await computer();
  await assert.rejects(s.alumni.validate('hello'), /not an alumni membership key/);
  await assert.rejects(s.alumni.validate('mclub1.abc.def'), /not valid any more/);
  assert.equal(s.alumni.active(), false);
  const st = await s.alumni.validate(` ${KEY} `);
  assert.equal(st.tier_name, 'Premium');
  assert.equal(s.alumni.active(), true);
  assert.deepEqual(s.alumni.settings(), { daily_cap_usd: '1.50', receive_interval_min: 15, messageguard: true, combine_syncs: true });
  assert.equal(s.alumni.key(), KEY, 'stored sealed, opened for use');
  assert.ok(!JSON.stringify(s.db.prepare("SELECT value FROM meta WHERE key = 'alumni_key'").get()).includes('mclub1'), 'the key is not stored in the clear');
});

test('while active, the club pays: recorded under the Alumni club, accepted by the portal, and an agent with no wallet can register and sync', async () => {
  const { s, agent } = await computer({ withWallet: false });
  await s.alumni.validate(KEY);
  const paidBefore = portal.paid.length;
  await s.core.register(agent);
  await s.core.sync(agent);
  assert.ok(club.pays >= 2);
  assert.ok(portal.paid.slice(paidBefore).every((p) => p.from === MEMBER), 'every payment came from the member\'s club address');
  assert.ok(payments(s).every((p) => p.wallet === 'alumni' && p.status === 'settled'));
  // The tools report the club as what pays, with its cap as the budget.
  const st: any = (await s.tools.call(agent, 'status', {}, { via: 'claude' })).data;
  assert.equal(st.wallet.balance, 'paid by the alumni club, up to its daily allowance');
  const r: any = (await s.tools.call(agent, 'sync', {}, { via: 'claude' })).data;
  assert.equal(r.cost, '$0.005');
  assert.match(r.budget_left_today, /^\$1\.4/);
  assert.equal(s.tools.spendingSummary(agent, 0, 'person')?.wallet, 'Alumni club');
});

test('at the cap: refused with the way to allow the fallback; with the fallback on, the agent\'s own wallet pays', async () => {
  const { s, agent } = await computer();
  await s.alumni.validate(KEY);
  await s.core.register(agent);
  club.refuse = { code: 'cap', refused: 'The alumni club\'s allowance for today is used up; it frees up at 14:05 UTC.' };
  await assert.rejects(s.transport.call('/v2/rooms', {}, agent), (e: any) => e instanceof TransportError && e.kind === 'refused' && /used up/.test(e.message) && /Settings under Meadow v1 alumni/.test(e.message));
  s.alumni.setFallback(true);
  const before = payments(s).length;
  await s.transport.call('/v2/rooms', {}, agent);
  assert.equal(payments(s).at(-1)!.wallet, s.wallets.walletOf(agent), 'the agent\'s own wallet paid');
  assert.equal(payments(s).length, before + 1);
});

test('the club unreachable counts like the cap; a refusal that is not about the allowance never falls back', async () => {
  const { s, agent } = await computer();
  await s.alumni.validate(KEY);
  await s.core.register(agent);
  club.down = true;
  await assert.rejects(s.transport.call('/v2/rooms', {}, agent), /could not be reached/);
  s.alumni.setFallback(true);
  await s.transport.call('/v2/rooms', {}, agent);
  assert.equal(payments(s).at(-1)!.wallet, s.wallets.walletOf(agent));
  club.down = false;
  club.refuse = { code: 'service', refused: 'MessageGuard is included with Premium and Charter memberships, not Basic.' };
  const before = payments(s).length;
  await assert.rejects(s.transport.call('/v2/rooms', {}, agent), /not Basic/);
  assert.equal(payments(s).length, before, 'nothing signed, not even by the wallet');
});

test('an answer that does not match the portal\'s terms is not used, and nothing is recorded', async () => {
  const { s, agent } = await computer();
  await s.alumni.validate(KEY);
  await s.core.register(agent);
  club.tamper = true;
  const before = payments(s).length;
  await assert.rejects(s.transport.call('/v2/rooms', {}, agent), /does not match the portal's terms/);
  assert.equal(payments(s).length, before);
});

test('when the membership ends, the agent\'s own wallet pays again, with nothing to restore', async () => {
  const { s, agent, wallet } = await computer();
  await s.alumni.validate(KEY);
  await s.core.register(agent);
  club.active = false;
  await s.refreshAlumni();
  assert.equal(s.alumni.active(), false);
  assert.equal(s.wallets.walletOf(agent), wallet, 'the agent kept its wallet throughout');
  await s.transport.call('/v2/rooms', {}, agent);
  assert.equal(payments(s).at(-1)!.wallet, wallet);
});

test('Join alumni club: the browser hands a one-time code to the app\'s loopback listener, redeemed with the PKCE verifier', async () => {
  const { s } = await computer();
  const { url, done } = await s.alumni.startLink(false);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, `${club.url}/link`);
  const port = Number(u.searchParams.get('port'));
  const state = u.searchParams.get('state')!;
  const challenge = u.searchParams.get('challenge')!;
  // A page from elsewhere with the wrong state is refused, and the listener keeps waiting.
  assert.equal((await fetch(`http://127.0.0.1:${port}/alumni/callback?code=x&state=wrong`)).status, 400);
  // The club's site, after sign-in, sends the browser back with a code bound to the challenge.
  club.codes.set('code-1', challenge);
  const page = await fetch(`http://127.0.0.1:${port}/alumni/callback?code=code-1&state=${state}`);
  assert.match(await page.text(), /connected to the Meadow app/);
  assert.equal((await done).tier_name, 'Premium');
  assert.equal(s.alumni.key(), KEY);
  assert.deepEqual(club.redeemed, ['code-1']);
  // Listening once: the port is closed now.
  await assert.rejects(fetch(`http://127.0.0.1:${port}/alumni/callback?code=code-1&state=${state}`));
});

test('cancel asks the club and refreshes; the membership stays active to the end of the paid period', async () => {
  const { s } = await computer();
  await s.alumni.validate(KEY);
  const r = await s.alumni.cancel();
  assert.equal(r.runs_until, '2099-01-01');
  assert.equal(s.alumni.cached()?.status.cancelled, true);
  assert.equal(s.alumni.active(), true);
});
