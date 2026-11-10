// The computer's clock (SPEC §16.28): a tester's clock was off, so a node
// refused every request as expired while the alumni club paid for each one.
// The app takes the network's time from the portal's Date header, signs again
// before paying when the free 402 shows the clock is off, and background
// receiving stops paying for a refusal that would only repeat.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { CLOCK_NOISE_MS, NetworkClock, clockWords, networkClock } from '../src/core/clock.ts';
import { Catalog } from '../src/core/catalog.ts';
import { openDb } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { Wallets } from '../src/core/wallets.ts';
import { PortalTransport } from '../src/core/portal.ts';
import { ActionError, Core } from '../src/core/core.ts';
import { newSeed, signRequest, signerFromSeed } from '../src/core/identity.ts';
import { Services } from '../src/app/services.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

const MIN = 60_000;

test('the offset comes from the Date header, at the midpoint of the request; small ones are noise', () => {
  const c = new NetworkClock(() => 1_000_000);
  const server = Date.UTC(2026, 10, 10, 12, 0, 0);
  // This computer is 3 minutes slow: it sent at server - 3 min - 200 ms and heard back 400 ms later.
  const sent = server - 3 * MIN - 200;
  assert.equal(c.observe(new Date(server).toUTCString(), sent, sent + 400), true);
  assert.ok(Math.abs(c.offset() - 3 * MIN) < 1_000, `offset ${c.offset()}`);
  assert.equal(c.now(), 1_000_000 + c.offset());
  // The same again moves nothing.
  assert.equal(c.observe(new Date(server + 1_000).toUTCString(), sent + 1_000, sent + 1_400), false);
  // Within the noise: the computer is right.
  assert.equal(c.observe(new Date(server).toUTCString(), server - 3_000, server - 2_000), true);
  assert.equal(c.offset(), 0);
  assert.equal(c.observe(new Date(server).toUTCString(), server - CLOCK_NOISE_MS + 2_000, server - CLOCK_NOISE_MS + 2_100), false);
  assert.equal(c.offset(), 0);
  // No header, or a bad one: nothing changes.
  assert.equal(c.observe(null, 0, 1), false);
  assert.equal(c.observe('not a date', 0, 1), false);
  assert.equal(c.offset(), 0);
});

test('the clock in plain words', () => {
  assert.equal(clockWords(30_000), null);
  assert.equal(clockWords(3 * MIN), "This computer's clock is 3 minutes slow.");
  assert.equal(clockWords(-1 * MIN), "This computer's clock is 1 minute fast.");
  assert.equal(clockWords(-5 * 60 * MIN), "This computer's clock is 5 hours fast.");
});

let portal: MockPortal;
before(async () => { portal = await startMockPortal(); });
after(() => portal.close());
afterEach(() => networkClock.reset());

function setup() {
  const db = openDb();
  const vault = new Vault(randomBytes(32));
  const catalog = new Catalog({ url: portal.catalogUrl });
  const wallets = new Wallets({ db, vault, catalog });
  const transport = new PortalTransport({ catalog, wallets });
  const core = new Core({ db, vault, transport });
  const w = wallets.create('Everyday', '1.00');
  const { id } = core.createAgent('Chappy');
  wallets.assign(id, w.id);
  return { core, transport, catalog, agent: id };
}

for (const [label, skew] of [['slow', -5 * MIN], ['fast', 5 * MIN]] as const) {
  test(`a clock 5 minutes ${label}: the free 402 corrects it, so the one paid call is accepted`, async () => {
    const { core, agent } = setup();
    networkClock.reset(() => Date.now() + skew);
    const paidBefore = portal.paid.length;
    await core.register(agent);
    assert.equal(portal.paid.length - paidBefore, 1, 'one payment, for a call the node accepted');
    assert.ok(Math.abs(networkClock.offset() + skew) < 2_000, `offset ${networkClock.offset()}`);
    assert.ok(core.agents()[0].registered, 'the node took the registration');
    // Later calls are signed right the first time.
    await core.sync(agent);
    assert.equal(portal.paid.length - paidBefore, 2);
  });
}

test('without signing again, the same call is refused as expired: what the tester saw', async () => {
  const { transport, agent } = setup();
  networkClock.reset(() => Date.now() - 5 * MIN);
  const signer = signerFromSeed(newSeed());
  // A request signed with the wrong clock, sent with no way to sign it again.
  const res = await transport.call('/v2/sync', signRequest(signer, { since: {}, outbox: [] }), agent);
  assert.equal(res.status, 401);
  assert.equal(res.data?.error?.code, 'auth_expired');
});

test('background receiving leaves out an agent whose requests were refused, until something changes', async () => {
  const catalog = new Catalog({ url: portal.catalogUrl });
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog });
  const w = s.wallets.create('Everyday', '1.00');
  const a = s.core.createAgent('Chappy').id;
  s.wallets.assign(a, w.id);
  s.db.prepare('UPDATE agents SET registered_at = ? WHERE id = ?').run(Date.now(), a);
  const asked: string[][] = [];
  let refuse = true;
  const answer = (ids: string[]) => new Map(ids.map((id) => [id, refuse ? new ActionError('auth_expired', 'The network refused the sync: request authentication failed (SPEC 7.1).') : { calls: 1, accepted: [], rejected: [], pending: [], invites: 0, messages: 0 } as any]));
  (s.core as any).syncMany = async (ids: string[]) => { asked.push(ids); return answer(ids); };
  (s.core as any).sync = async (id: string) => { asked.push([id]); const r = answer([id]).get(id); if (r instanceof Error) throw r; return r; };

  await s.syncAll('background');
  assert.deepEqual(asked, [[a]], 'the first background sync tries');
  assert.ok(s.authRefusal(a));
  await s.syncAll('background');
  await s.syncAll('event');
  assert.equal(asked.length, 1, 'background receiving and Event Mode do not pay for it again');
  await s.syncAll('person');
  assert.equal(asked.length, 2, 'Sync Now always tries');
  assert.equal(s.authRefusal(a, Date.now() + 6 * 60 * MIN + 1), null, 'after 6 hours it is tried again');
  // A changed clock offset is a reason to try again.
  networkClock.observe(new Date(Date.now() + 4 * MIN).toUTCString(), Date.now(), Date.now());
  assert.equal(s.authRefusal(a), null);
  networkClock.reset();
  refuse = false;
  await s.syncAll('person');
  assert.equal(s.authRefusal(a), null, 'a sync that works clears it');
  s.stop();
});
