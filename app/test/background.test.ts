// Client sync review (SPEC §16.8, app 0.1.10): background receiving never repeats a sync just
// made, pages are as large as the node allows, and the AI's sync tool says how fresh its view is.
// Against the node in this process, behind the mock portal.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { SYNC } from '../src/core/core.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

let portal: MockPortal;
before(async () => {
  portal = await startMockPortal();
});
after(() => portal.close());

const MIN = 60_000;

async function computer() {
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog });
  const wallets = new Map<string, string>();
  const agent = async (name: string, wallet = 'Everyday') => {
    if (!wallets.has(wallet)) wallets.set(wallet, s.wallets.create(wallet, '5.00').id);
    const { id } = s.core.createAgent(name);
    s.wallets.assign(id, wallets.get(wallet)!);
    s.connections.set(id, 'claude', name);
    await s.core.register(id);
    return id;
  };
  return { s, agent, wallets };
}

const lastSeq = (s: Services) => (s.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM payments').get() as any).n as number;
const paid = (s: Services, since: number) => (s.db.prepare('SELECT agent, path, cause FROM payments WHERE seq > ? ORDER BY seq').all(since) as any[]);

test('a background check skips a group synced within the interval, by any path, and syncs it once the interval has passed', async () => {
  const { s, agent } = await computer();
  const alice = await agent('alice');
  const bob = await agent('bob');
  const now = Date.now();
  const interval = s.settings().syncMinutes * MIN;

  // Registering synced both: nothing is due yet.
  let since = lastSeq(s);
  assert.deepEqual(await s.syncAll('background', { due: true, now }), []);
  assert.equal(paid(s, since).length, 0, 'no paid call');

  // The AI syncs alice; bob's last sync is still the oldest, so the group is due an interval after it.
  await s.tools.call(alice, 'sync', {}, { via: 'claude' });
  assert.deepEqual(await s.syncAll('background', { due: true, now: now + interval - MIN }), []);
  since = lastSeq(s);
  const r = await s.syncAll('background', { due: true, now: now + interval + 1000 });
  assert.deepEqual(r.map((x) => x.agent).sort(), [alice, bob].sort());
  assert.deepEqual(paid(s, since).map((p) => p.path), ['/v2/sync-batch'], 'one combined call for the group');

  // Sync Now is never held back.
  since = lastSeq(s);
  await s.syncAll('person');
  assert.equal(paid(s, since).length, 1);
  s.stop();
});

test('a group whose background sync fails is tried again an interval later, not every minute', async () => {
  const { s, agent } = await computer();
  const alice = await agent('alice');
  const now = Date.now() + 60 * MIN; // long after registering: due
  const interval = s.settings().syncMinutes * MIN;
  const wallet = s.wallets.walletOf(alice)!;
  s.wallets.setBudget(wallet, '0.00'); // every paid call is refused
  const first = await s.syncAll('background', { due: true, now });
  assert.equal(first.length, 1);
  assert.equal(first[0].ok, false);
  assert.deepEqual(await s.syncAll('background', { due: true, now: now + MIN }), [], 'not again a minute later');
  assert.equal((await s.syncAll('background', { due: true, now: now + interval })).length, 1, 'again an interval later');
  s.stop();
});

test('agents on different wallets are due on their own', async () => {
  const { s, agent } = await computer();
  const alice = await agent('alice', 'One');
  const bob = await agent('bob', 'Two');
  const now = Date.now();
  const interval = s.settings().syncMinutes * MIN;
  await s.tools.call(alice, 'sync', {}, { via: 'claude' });
  // Shift bob's last sync back, as if it had been an interval ago.
  s.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`sync_ok:${bob}`, String(now - interval - 1000));
  const r = await s.syncAll('background', { due: true, now });
  assert.deepEqual(r.map((x) => x.agent), [bob], 'only bob is due');
  s.stop();
});

test('every sync asks for the node\'s largest page', async () => {
  const { s, agent } = await computer();
  const alice = await agent('alice');
  await agent('bob');
  assert.equal(SYNC.limitBytes, 4 * 1024 * 1024 - 64 * 1024);
  const seen: number[] = [];
  const call = s.transport.call.bind(s.transport);
  s.transport.call = async (path, body, who) => {
    if (path === '/v2/sync' || path === '/v2/sync-batch') seen.push(body.limit_bytes);
    return call(path, body, who);
  };
  await s.core.sync(alice);
  await s.syncAll('person');
  assert.deepEqual([...new Set(seen)], [SYNC.limitBytes]);
  s.stop();
});

test('the sync tool says how fresh the view is, and when background receiving looks next', async () => {
  const { s, agent } = await computer();
  const alice = await agent('alice');
  const r: any = await s.tools.call(alice, 'sync', {}, { via: 'claude' });
  assert.equal(typeof r.data.last_checked_seconds_ago, 'number', 'registering synced it a moment ago');
  assert.ok(r.data.last_checked_seconds_ago < 60);
  const interval = s.settings().syncMinutes * 60;
  assert.ok(r.data.next_background_check_in_seconds > interval - 5 && r.data.next_background_check_in_seconds <= interval + 60, String(r.data.next_background_check_in_seconds));
  s.setSettings({ syncEnabled: false });
  const off: any = await s.tools.call(alice, 'sync', {}, { via: 'claude' });
  assert.equal(off.data.background_receiving, 'off');
  assert.equal(off.data.next_background_check_in_seconds, undefined);
  s.stop();
});
