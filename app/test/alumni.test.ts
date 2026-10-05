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
import { freesAt } from '../src/core/alumni.ts';
import { troubleshoot } from '../src/app/troubleshoot.ts';

const MEMBER_KEY = randomBytes(32);
const MEMBER = addressOf(MEMBER_KEY);
const KEY = 'mclub1.eyJtIjoibV90ZXN0In0.c2lnbmF0dXJl';

/** A stand-in club: answers status, pay, redeem, cancel as the real one does (§18.14). */
async function startClub() {
  const club = {
    url: '', active: true, tier: 'premium' as 'premium' | 'basic', asked: 0, allowance: null as string | null, refuse: null as null | { code: string; refused: string }, down: false, tamper: false,
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
        ? { active: true, member: 'Jinx', tier: club.tier, tier_name: club.tier === 'basic' ? 'Basic' : 'Premium', paid_through: '2099-01-01', cancelled: club.cancelled,
          settings: club.tier === 'basic' ? { daily_cap_usd: '0.70', receive_interval_min: 15, messageguard: false, combine_syncs: true } : { daily_cap_usd: '1.50', receive_interval_min: 15, messageguard: true, combine_syncs: true },
          spent_24h_usd: '$0.00', allowance_left_usd: club.allowance ?? (club.tier === 'basic' ? '$0.70' : '$1.50'),
          payer_address: MEMBER, history: [{ date: '2026-10-02', amount: '50.00', currency: 'USD', tier: 'Premium', status: 'completed' }] }
        : { active: false, member: 'Jinx', ended: 'expired', history: [] });
    }
    if (path === 'pay') {
      club.asked++;
      if (club.refuse) return send(club.refuse);
      club.pays++;
      const t = body.term;
      const nowS = Math.floor(Date.now() / 1000);
      const authorization = { from: MEMBER, to: club.tamper ? '0x000000000000000000000000000000000000dEaD' : t.payTo, value: t.amount, validAfter: String(nowS - 60), validBefore: String(nowS + 60), nonce: `0x${randomBytes(32).toString('hex')}` as Hex };
      const signature = signTransfer(MEMBER_KEY, { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, authorization as any);
      return send({ from: MEMBER, authorization, signature, allowance_left_usd: '$1.495' });
    }
    if (path === 'redeem') {
      // A compromised club's words, to show they stay text (security review A3).
      if (body.code === 'code-html') return send({ refused: '<img src=x onerror=alert(1)><script>alert(1)</script>', code: 'code' });
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
  club.tier = 'premium';
  club.allowance = null;
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

// --- Step 2: the overrides (§18.8) ---------------------------------------------------------

test("while active the tier sets the receive interval and public-room MessageGuard; the person's own settings come back when it ends", async (t) => {
  const { s, agent } = await computer();
  s.setSettings({ syncMinutes: 60, guardPublic: false, guardPrivate: true });
  t.after(() => s.stop()); // setSettings started background receiving
  await s.alumni.validate(KEY);
  const on = s.effectiveSettings();
  assert.equal(on.syncMinutes, 15);
  assert.equal(on.guardPublic, true, 'Premium includes MessageGuard for public rooms');
  assert.equal(on.guardPrivate, true, "private rooms stay the person's choice on Premium");
  assert.equal(s.settings().syncMinutes, 60, "the person's own value is kept underneath");
  const st: any = (await s.tools.call(agent, 'status', {}, { via: 'claude' })).data;
  assert.equal(st.messageguard, 'on for all rooms', 'the tools and the screening use the settings in force');
  assert.equal(st.wallet.name, 'Alumni club');
  club.active = false;
  await s.refreshAlumni();
  assert.deepEqual([s.effectiveSettings().syncMinutes, s.effectiveSettings().guardPublic, s.effectiveSettings().guardPrivate], [60, false, true]);
});

test('on Basic, MessageGuard is off for every room while active, since the club does not pay for screening', async () => {
  const { s, agent } = await computer();
  s.setSettings({ guardPublic: true, guardPrivate: true });
  club.tier = 'basic';
  // Spent on another of the member's computers: the club's count, not this computer's.
  club.allowance = '$0.20';
  await s.alumni.validate(KEY);
  assert.equal(s.effectiveSettings().guardPublic, false);
  assert.equal(s.effectiveSettings().guardPrivate, false);
  const st: any = (await s.tools.call(agent, 'status', {}, { via: 'claude' })).data;
  assert.equal(st.messageguard, 'off');
  assert.equal(st.wallet.budget_left_today, '$0.20', "the allowance is the club's own count");
});

test("at the cap without the fallback, background receiving waits until the allowance frees up; the person's Sync Now still asks", async () => {
  const { s, agent } = await computer({ withWallet: false });
  await s.alumni.validate(KEY);
  await s.core.register(agent);
  club.refuse = { code: 'cap', refused: "The alumni club's allowance for today is used up; it frees up at 14:05 UTC." };
  await s.syncAll('background');
  const h = s.alumni.held();
  assert.equal(h?.code, 'cap');
  assert.equal(new Date(h!.until!).toISOString().slice(11, 16), '14:05');
  assert.ok(h!.until! > Date.now() && h!.until! - Date.now() <= 24 * 3600_000);
  assert.equal(s.alumni.cached()?.status.allowance_left_usd, '$0.00');
  const asked = club.asked;
  await s.syncAll('background');
  assert.equal(club.asked, asked, 'background receiving did not ask the club again');
  await s.syncAll('person');
  assert.equal(club.asked, asked + 1, 'Sync Now still tries');
  // Troubleshoot says so, with the way to the membership.
  const money = troubleshoot(s, () => null).groups.find((g) => g.title === 'Money')!;
  const item = money.items.find((i) => i.key === 'alumni')!;
  assert.equal(item.state, 'bad');
  assert.match(item.text, /used up/);
  assert.ok(!money.items.some((i) => i.key.startsWith('nowallet:')), 'an agent the club pays for is not "without a wallet"');
  // A paid call that goes through clears it.
  club.refuse = null;
  await s.syncAll('person');
  assert.equal(s.alumni.held(), null);
});

test("with the fallback on, background receiving goes on at the cap, paid by the agent's own wallet", async () => {
  const { s, agent, wallet } = await computer();
  await s.alumni.validate(KEY);
  await s.core.register(agent);
  s.alumni.setFallback(true);
  club.refuse = { code: 'cap', refused: "The alumni club's allowance for today is used up; it frees up at 14:05 UTC." };
  const before = payments(s).length;
  await s.syncAll('background');
  assert.ok(payments(s).length > before);
  assert.equal(payments(s).at(-1)!.wallet, wallet);
});

test("when the allowance frees up: the club's frees_at, else the time in its words, the next one after now", () => {
  const now = Date.parse('2026-10-02T15:00:00Z');
  assert.equal(freesAt({ frees_at: '2026-10-03T14:05:00Z' }, now), Date.parse('2026-10-03T14:05:00Z'));
  assert.equal(freesAt({ refused: 'used up; it frees up at 16:30 UTC.' }, now), Date.parse('2026-10-02T16:30:00Z'));
  assert.equal(freesAt({ refused: 'used up; it frees up at 14:05 UTC.' }, now), Date.parse('2026-10-03T14:05:00Z'));
  assert.equal(freesAt({ refused: 'used up.' }, now), null);
});

test("the club's members combine syncs: one call, paid by the club, for every agent, wallet or not", async () => {
  const { s, agent } = await computer({ withWallet: false });
  const { id: second } = s.core.createAgent('pip');
  s.connections.set(second, 'claude', 'pip');
  await s.alumni.validate(KEY);
  await s.core.register(agent);
  await s.core.register(second);
  const before = payments(s).length;
  const results = await s.syncAll('background');
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  const paid = s.db.prepare('SELECT wallet, path FROM payments ORDER BY seq').all().slice(before) as any[];
  assert.deepEqual(paid.map((p) => [p.wallet, p.path]), [['alumni', '/v2/sync-batch']]);
});

test('the club cannot set a receive interval outside 5 minutes to a day, nor unreadable amounts (security review A1, A4)', async () => {
  const { s } = await computer();
  await s.alumni.validate(KEY);
  const set = (settings: any, allowance: any) => {
    const c = s.alumni.cached()!;
    c.status.settings = settings;
    c.status.allowance_left_usd = allowance;
    s.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('alumni_status', ?)").run(JSON.stringify(c));
  };
  for (const [given, want] of [[0, 5], [-5, 5], [undefined, 15], [40000, 1440], [2.5, 15], [30, 30]] as const) {
    set({ daily_cap_usd: '1.50', receive_interval_min: given, messageguard: true, combine_syncs: true }, '$1.00');
    assert.equal(s.effectiveSettings().syncMinutes, want, `receive_interval_min ${given}`);
  }
  set({ daily_cap_usd: '1.50 USD', receive_interval_min: 15, messageguard: 'yes', combine_syncs: 1 }, 1.5);
  assert.deepEqual(s.alumni.settings(), { daily_cap_usd: '0.00', receive_interval_min: 15, messageguard: false, combine_syncs: false });
  assert.equal(s.alumni.allowanceLeft(), null);
});

test('the browser link page shows the club\u2019s words as text, and a new link closes the last one (security review A3)', async () => {
  const { s } = await computer();
  const first = await s.alumni.startLink(false);
  first.done.catch(() => {});
  const { url, done } = await s.alumni.startLink(false);
  done.catch(() => {});
  const u = new URL(url);
  const port = Number(u.searchParams.get('port'));
  await assert.rejects(fetch(`http://127.0.0.1:${new URL(first.url).searchParams.get('port')}/alumni/callback?code=x&state=y`), 'the first listener is closed');
  await assert.rejects(first.done, /newer link/);
  const page = await (await fetch(`http://127.0.0.1:${port}/alumni/callback?code=code-html&state=${u.searchParams.get('state')}`)).text();
  assert.ok(page.includes('&#60;script&#62;') && !page.includes('<script') && !page.includes('<img'));
  await assert.rejects(done);
});
