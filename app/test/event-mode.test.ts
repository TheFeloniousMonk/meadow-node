// Event Mode (SPEC §16.25, user 2026-10-25): a faster receive frequency for a set time, then the
// normal schedule. The countdown with a fake clock; then through the app's real services, paying
// the mock portal in front of a node: the interval in force, the payment cause, and the end.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/core/db.ts';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { EVENT_DURATIONS, EventMode } from '../src/app/event-mode.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

const MIN = 60_000;

test('the choices: 10, 5, 2, 1 minutes; 1 to 8 hours in quarter hours; off by default', () => {
  assert.equal(EVENT_DURATIONS[0], 60);
  assert.equal(EVENT_DURATIONS.at(-1), 480);
  assert.equal(EVENT_DURATIONS.length, 29);
  const em = new EventMode({ db: openDb(':memory:') });
  assert.deepEqual(em.view(), { on: false, paused: false, frequency: 5, duration: 60, endsAt: null, remainingMs: null });
  assert.equal(em.activeFrequency(), null);
  assert.throws(() => em.choose({ frequency: 3 }), /10, 5, 2, or 1/);
  assert.throws(() => em.choose({ duration: 70 }), /quarter hours/);
});

test('the countdown: start, pause, resume, reset, a new duration, and the end', () => {
  let t = 1_000_000;
  const em = new EventMode({ db: openDb(':memory:'), now: () => t });
  em.choose({ frequency: 2, duration: 90 });
  em.start();
  assert.equal(em.view().endsAt, t + 90 * MIN);
  assert.equal(em.activeFrequency(), 2);

  t += 30 * MIN;
  em.pause();
  assert.deepEqual([em.view().paused, em.view().remainingMs, em.view().endsAt], [true, 60 * MIN, null]);
  assert.equal(em.activeFrequency(), null, 'paused: the normal schedule applies');
  t += 500 * MIN; // a paused event keeps its time, however long it waits
  assert.equal(em.due(), false);
  em.resume();
  assert.equal(em.view().endsAt, t + 60 * MIN);

  em.choose({ frequency: 1 }); // applies at once, keeps the countdown
  assert.equal(em.view().endsAt, t + 60 * MIN);
  assert.equal(em.activeFrequency(), 1);
  em.choose({ duration: 120 }); // restarts the countdown at the new length
  assert.equal(em.view().endsAt, t + 120 * MIN);

  t += 10 * MIN;
  em.pause();
  em.reset(); // back to the full duration, still paused
  assert.deepEqual([em.view().paused, em.view().remainingMs], [true, 120 * MIN]);
  em.resume();
  t += 120 * MIN;
  assert.equal(em.due(), true);
  assert.equal(em.activeFrequency(), null);
  em.stop();
  assert.equal(em.view().on, false);
  assert.throws(() => em.pause(), /not running/);
});

let portal: MockPortal;
before(async () => {
  portal = await startMockPortal();
});
after(() => portal.close());

async function computer() {
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const told: [string, string][] = [];
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog, notify: () => {}, notifyText: (title, body) => told.push([title, body]) });
  const wallet = s.wallets.create('Test', '5.00').id;
  const { id } = s.core.createAgent('alice');
  s.wallets.assign(id, wallet);
  s.connections.set(id, 'claude', 'alice');
  await s.core.register(id);
  return { s, agent: id, told };
}

test('while it runs, the event frequency is in force, even with normal auto-sync off, and its calls are paid as Event Mode', async () => {
  const { s, agent } = await computer();
  s.setSettings({ syncEnabled: false });
  assert.equal(s.freshness(agent).nextBackground, null, 'normal auto-sync off: no background check');

  s.setEventMode({ action: 'start', frequency: 2, duration: 60 });
  const next = s.freshness(agent).nextBackground!;
  assert.ok(next > Date.now() && next <= Date.now() + 2 * MIN + 15_000, 'the next check follows the event frequency');

  await s.syncAll('event');
  const paid = s.wallets.payments(5) as any[];
  assert.equal(paid[0].cause, 'event');
  const status: any = (await s.tools.call(agent, 'status', {})).data;
  assert.match(JSON.stringify(status.wallet.spent_last_24h), /Event Mode/);

  s.setEventMode({ action: 'pause' });
  assert.equal(s.freshness(agent).nextBackground, null, 'paused: back to the normal schedule, which is off');
  const log = s.activity.list(agent, {}).map((e) => e.text);
  assert.ok(log.some((t) => /Event Mode started: checking for new messages every 2 minutes for 1 hour\./.test(t)));
  assert.ok(log.some((t) => /Event Mode paused/.test(t)));
});

test('when its time is up, the next look ends it, logs it, and tells the person what schedule applies', async () => {
  const { s, agent, told } = await computer();
  s.setSettings({ syncEnabled: true, syncMinutes: 15 });
  s.setEventMode({ action: 'start', frequency: 1, duration: 60 });
  // Move the end into the past, as if the hour went by.
  const row: any = s.db.prepare("SELECT value FROM meta WHERE key = 'event_mode'").get();
  s.db.prepare("UPDATE meta SET value = ? WHERE key = 'event_mode'").run(JSON.stringify({ ...JSON.parse(row.value), endsAt: Date.now() - 1 }));
  s.backgroundTick();
  assert.equal(s.eventMode.view().on, false);
  assert.deepEqual(told, [['Event Mode ended', 'Back to checking every 15 minutes.']]);
  assert.ok(s.activity.list(agent, {}).some((e) => e.text === 'Event Mode ended: back to the normal schedule.'));
  s.schedule(); // tidy: the timer the tick may have set
});
