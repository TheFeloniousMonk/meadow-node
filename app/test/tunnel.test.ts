// The tunnel watch (SPEC §16.17.8): the state says what the app last confirmed,
// a dead tunnel is found by the local watch or a wake, an ngrok tunnel is
// restarted (at most 4 times, on the wake schedule), ERR_NGROK_334 is waited out,
// a refused token is never retried, the button never overlaps an automatic
// restart, and a custom tunnel is checked but never restarted. A fake clock, fake
// ngrok sessions, and a fake network: nothing here reaches the internet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tunnel, WATCH, isLocalFailure, type NgrokOpener, type Timers } from '../src/app/tunnel.ts';
import { tunnelStep } from '../src/app/check.ts';

const URL_ = 'https://abc.ngrok-free.app';

class FakeClock implements Timers {
  t = 1_000_000_000_000;
  #q: { at: number; fn: () => void; id: number; every?: number }[] = [];
  #id = 0;
  now = () => this.t;
  set = (fn: () => void, ms: number) => {
    const id = ++this.#id;
    this.#q.push({ at: this.t + ms, fn, id });
    return id;
  };
  every = (fn: () => void, ms: number) => {
    const id = ++this.#id;
    this.#q.push({ at: this.t + ms, fn, id, every: ms });
    return id;
  };
  clear = (h: unknown) => {
    this.#q = this.#q.filter((x) => x.id !== h);
  };
  stop = this.clear;
  /** Moves time forward, running whatever falls due, and letting each run's promises finish. */
  async advance(ms: number, tunnel: Tunnel) {
    const end = this.t + ms;
    for (;;) {
      await flush(tunnel);
      const due = this.#q.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = due.at;
      if (due.every) due.at += due.every;
      else this.#q = this.#q.filter((x) => x !== due);
      due.fn();
    }
    this.t = end;
    await flush(tunnel);
  }
}

/** Lets every promise that can finish without the clock finish (never waits on the tunnel, which may be waiting on the clock). */
async function flush(_t: Tunnel) {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
}

/** ngrok: each open takes the next scripted error (or opens), and hands back the watch's callbacks. */
function fakeNgrok() {
  const o = {
    opens: 0, closes: 0, inFlight: 0, maxInFlight: 0,
    /** An open session answers heartbeats; a test sets this false to play a dead one. */
    alive: false,
    script: [] as (string | null)[],
    gate: null as Promise<void> | null,
    beat: (_ms: number) => {},
    drop: (_e: string) => {},
  };
  const open: NgrokOpener = async ({ onHeartbeat, onDisconnect }) => {
    o.inFlight++;
    o.maxInFlight = Math.max(o.maxInFlight, o.inFlight);
    try {
      if (o.gate) await o.gate;
      o.opens++;
      const err = o.script.shift();
      if (err) throw new Error(err);
      o.beat = onHeartbeat;
      o.drop = onDisconnect;
      o.alive = true;
      return { url: URL_, close: async () => { o.closes++; o.alive = false; } };
    } finally {
      o.inFlight--;
    }
  };
  return { o, open };
}

/** The network: the address reaches the app while `up` says so; otherwise ngrok's offline page. */
function fakeNet() {
  const net = { up: (() => true) as () => boolean, impostor: false, doorUp: true, local: null as string | null };
  const fetchImpl = (async (input: any) => {
    // Something on this computer answers for the address (a VPN, antivirus, a filter): the request never reaches ngrok.
    if (net.local) throw Object.assign(new TypeError('fetch failed'), { cause: { code: net.local } });
    if (net.impostor) return Response.json({ issuer: 'https://elsewhere.example' });
    if (!net.up()) return new Response('<html>ERR_NGROK_3200 The endpoint is offline</html>', { status: 404 });
    assert.match(String(input), /\/\.well-known\/oauth-authorization-server$/);
    return Response.json({ issuer: URL_ });
  }) as typeof fetch;
  const doorFetch = (async () => {
    if (!net.doorUp) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return Response.json({ issuer: URL_ });
  }) as typeof fetch;
  return { net, fetchImpl, doorFetch };
}

async function setup(provider: 'ngrok' | 'custom' = 'ngrok') {
  const clock = new FakeClock();
  const { o, open } = fakeNgrok();
  const { net, fetchImpl, doorFetch } = fakeNet();
  const events: string[] = [];
  const t = new Tunnel({ changed: () => {}, event: (w, d) => events.push(d ? `${w}: ${d}` : w), open, fetch: fetchImpl, doorFetch, now: clock.now, timers: clock });
  // ngrok's heartbeats, every 10 seconds while the session lives.
  clock.every(() => o.alive && o.beat(25), WATCH.beatInterval * 1000);
  await t.start({ provider, port: 47734, ngrokToken: 'tok', customUrl: URL_ });
  await flush(t);
  const step = () => tunnelStep({ tunnel: t } as any);
  return { clock, o, net, events, t, step };
}

test('a started tunnel is on only once a check through its address passes, and says when', async () => {
  const { t, o, events, step } = await setup();
  assert.equal(o.opens, 1);
  assert.equal(t.status.state, 'on');
  assert.ok(t.status.reachedAt);
  assert.deepEqual(events, ['check pass']);
  assert.equal(step().state, 'ok');
  assert.match(step().text, /reached this app/);
});

test('a wake whose check passes restarts nothing', async () => {
  const { t, o, clock, events } = await setup();
  t.wake();
  await clock.advance(WATCH.wakeDelays[0], t);
  assert.equal(o.opens, 1);
  assert.equal(t.status.state, 'on');
  assert.deepEqual(events.slice(1), ['wake', 'check pass']);
});

test('a wake whose check fails restarts the tunnel once, and the check after it passes', async () => {
  const { t, o, net, clock, events } = await setup();
  net.up = () => o.opens >= 2; // only a new session reaches the app
  t.wake();
  await clock.advance(9_000, t);
  assert.equal(o.opens, 1, 'nothing before 10 seconds');
  await clock.advance(1_000, t);
  assert.equal(o.opens, 2);
  assert.equal(o.closes, 1, 'the old session closed first');
  assert.equal(t.status.state, 'on');
  assert.equal(t.status.restarts, 0);
  assert.deepEqual(events.slice(1), ['wake', 'check fail: the tunnel\'s own error page (ERR_NGROK_3200): the tunnel is not reaching this app', 'restart: after a wake', 'check pass']);
  await clock.advance(10 * 60_000, t);
  assert.equal(o.opens, 2, 'no later retries once it passed');
});

test('a tunnel that keeps failing is restarted 4 times on the wake schedule, then is red with what the app tried', async () => {
  const { t, o, net, clock, step } = await setup();
  net.up = () => false;
  t.wake();
  const opensAt: number[] = [];
  for (const at of [10_000, 30_000, 120_000, 300_000]) {
    await clock.advance(at - (opensAt.at(-1) ?? 0), t);
    opensAt.push(at);
    assert.equal(o.opens, opensAt.length + 1, `a restart at ${at / 1000} s`);
    if (opensAt.length < 4) assert.equal(t.status.state, 'reconnecting', 'amber while the app is still trying');
  }
  assert.equal(t.status.state, 'unreachable');
  assert.equal(t.status.restarts, 4);
  assert.equal(t.status.trying, false);
  const s = step();
  assert.equal(s.state, 'bad');
  assert.match(s.text, /^After this computer woke at .+, the tunnel stopped reaching this app: the tunnel's own error page \(ERR_NGROK_3200\).+ The app restarted it 4 times\.$/);
  assert.match(s.fix!, /^Press Restart tunnel/);
  assert.equal(t.url, URL_, 'the address outlives the bad state, so the door keeps answering');
  // A check that passes later (Test connection) turns it green again.
  t.confirm();
  assert.equal(t.status.state, 'on');
});

test('heartbeats stopping turn the tunnel amber; their return runs a check that turns it green', async () => {
  const { t, o, clock, events, step } = await setup();
  o.alive = false; // ngrok's servers stop answering
  await clock.advance(WATCH.beatsLostMs + WATCH.watchdogMs, t);
  assert.equal(t.status.state, 'reconnecting');
  assert.ok(events.includes('lost: heartbeats stopped'));
  assert.match(step().text, /ngrok lost its connection and is reconnecting/);
  o.beat(42);
  await flush(t);
  assert.equal(t.status.state, 'on');
  assert.deepEqual(events.slice(-2), ['reconnected', 'check pass']);
  assert.equal(o.opens, 1, 'no restart was needed');
});

test('a disconnection, then ngrok reconnecting by itself, ends green with no restart', async () => {
  const { t, o, events } = await setup();
  o.alive = false;
  o.drop('connection reset');
  assert.equal(t.status.state, 'reconnecting');
  assert.ok(events.includes('lost: ngrok lost its connection'));
  o.beat(30);
  await flush(t);
  assert.equal(t.status.state, 'on');
  assert.equal(o.opens, 1);
});

test('reconnecting for more than 60 seconds is restarted', async () => {
  const { t, o, clock, events } = await setup();
  o.alive = false;
  o.drop('gone');
  await clock.advance(WATCH.reconnectingMs - 5_000, t);
  assert.equal(o.opens, 1, 'still waiting for ngrok');
  await clock.advance(15_000, t);
  assert.equal(o.opens, 2);
  assert.ok(events.includes('restart: reconnecting too long'));
  assert.equal(t.status.state, 'on');
});

test('a refused token is never retried', async () => {
  const { t, o, net, clock } = await setup();
  net.up = () => false;
  o.script.push('failed to authenticate: ERR_NGROK_105');
  t.wake();
  await clock.advance(10 * 60_000, t);
  assert.equal(o.opens, 2, 'one try, no retries');
  assert.equal(t.status.state, 'error');
  assert.match(t.status.error!, /did not accept the token/);
  assert.equal(t.url, null);
});

test('ERR_NGROK_334 after a wake is waited out without counting a restart', async () => {
  const { t, o, net, clock, events } = await setup();
  net.up = () => o.opens >= 4;
  o.script.push('the endpoint is already online. ERR_NGROK_334', 'the endpoint is already online. ERR_NGROK_334');
  t.wake();
  await clock.advance(10_000, t);
  assert.equal(o.opens, 2);
  await clock.advance(WATCH.heldRetryMs * 2, t);
  assert.equal(o.opens, 4);
  assert.equal(t.status.state, 'on');
  assert.equal(events.filter((e) => e.startsWith('restart')).length, 1, 'one restart, two waits');
  assert.equal(events.filter((e) => e.startsWith('address held')).length, 2);
});

test('an address still held after 2 minutes is named as open somewhere else', async () => {
  const { t, o, net, clock, step } = await setup();
  net.up = () => false;
  for (let i = 0; i < 20; i++) o.script.push('ERR_NGROK_334');
  t.wake();
  await clock.advance(10_000 + WATCH.heldGiveUpMs + WATCH.heldRetryMs, t);
  assert.equal(t.status.state, 'unreachable');
  assert.equal(t.status.heldElsewhere, true);
  assert.match(step().text, /open somewhere else/);
  const opens = o.opens;
  await clock.advance(10 * 60_000, t);
  assert.equal(o.opens, opens, 'it stops trying');
});

test('Restart tunnel during an automatic restart waits its turn and replaces the rest of the schedule', async () => {
  const { t, o, net, clock } = await setup();
  net.up = () => o.opens >= 3;
  let release!: () => void;
  t.wake();
  o.gate = new Promise<void>((r) => (release = r));
  await clock.advance(10_000, t); // the automatic restart is now waiting inside ngrok's open
  const pressed = t.restart();
  release();
  o.gate = null;
  const r = await pressed;
  await flush(t);
  assert.equal(o.maxInFlight, 1, 'never two opens at once');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'The tunnel is back and reaches this app.');
  assert.equal(t.status.state, 'on');
  const opens = o.opens;
  await clock.advance(10 * 60_000, t);
  assert.equal(o.opens, opens, 'no automatic retry left over');
});

test('Restart tunnel reports a tunnel that still does not reach the app', async () => {
  const { t, net } = await setup();
  net.up = () => false;
  const r = await t.restart();
  assert.equal(r.ok, false);
  assert.match(r.text, /^The tunnel restarted but still does not reach this app: the tunnel's own error page/);
  assert.equal(t.status.state, 'unreachable');
});

test('ngrok connected but the address blocked on this computer: no restart, amber, and it says why', async () => {
  const { t, o, net, clock, events, step } = await setup();
  net.local = 'ERR_SSL_WRONG_VERSION_NUMBER';
  const r = await t.checkNow();
  assert.equal(r.ok, false);
  assert.equal(t.status.state, 'unreachable');
  assert.equal(t.status.blockedHere, true);
  assert.equal(t.status.trying, false);
  assert.ok(events.includes('blocked here: it could not be reached (ERR_SSL_WRONG_VERSION_NUMBER)'));
  const s = step();
  assert.equal(s.state, 'warn');
  assert.match(s.text, /^The tunnel is connected to ngrok, but this computer cannot reach its own address: .*ERR_SSL_WRONG_VERSION_NUMBER.*ChatGPT reaches the tunnel/);
  assert.match(s.fix!, /^If ChatGPT works, nothing needs doing/);
  // A wake while ngrok's heartbeats are current: still nothing to restart.
  t.wake();
  await clock.advance(10 * 60_000, t);
  assert.equal(o.opens, 1, 'never restarted');
  assert.equal(t.status.blockedHere, true);
  // The block lifted: the next check turns it green.
  net.local = null;
  assert.equal((await t.checkNow()).ok, true);
  assert.equal(t.status.state, 'on');
  assert.equal(t.status.blockedHere, false);
});

test('a lookup failure while ngrok is not heard from is restarted as before', async () => {
  const { t, o, net, clock } = await setup();
  o.alive = false; // ngrok's servers silent too: the computer's network, not a local block
  await clock.advance(25_000, t);
  net.local = 'ENOTFOUND';
  o.script = ['failed to dial ngrok server'];
  t.wake();
  await clock.advance(10_000, t);
  assert.equal(o.opens, 2, 'a restart was tried');
  assert.equal(t.status.state, 'reconnecting');
  assert.equal(t.status.blockedHere, false);
  net.local = null; // the network is back
  await clock.advance(20_000, t);
  assert.equal(t.status.state, 'on');
});

test('Restart tunnel that ends blocked on this computer says so', async () => {
  const { t, net } = await setup();
  net.local = 'ERR_SSL_WRONG_VERSION_NUMBER';
  const r = await t.restart();
  assert.equal(r.ok, false);
  assert.match(r.text, /^The tunnel is connected to ngrok, but this computer cannot reach its own address/);
  assert.equal(t.status.blockedHere, true);
});

test('which failures count as a block on this computer', () => {
  const failed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
  for (const code of ['ERR_SSL_WRONG_VERSION_NUMBER', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET']) {
    assert.equal(isLocalFailure(failed(code)), true, code);
  }
  assert.equal(isLocalFailure(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), false, 'ngrok can be slow');
  assert.equal(isLocalFailure(failed('UND_ERR_SOCKET')), false);
  assert.equal(isLocalFailure(new Error('no code')), false);
});

test('a custom tunnel is checked at the same moments but never restarted', async () => {
  const { t, o, net, clock, step } = await setup('custom');
  assert.equal(o.opens, 0);
  assert.equal(t.status.state, 'on');
  net.up = () => false;
  t.wake();
  await clock.advance(10_000, t);
  assert.equal(t.status.state, 'unreachable', 'red at once: only its owner can restart it');
  assert.match(step().fix!, /Restart your own tunnel program/);
  net.up = () => true;
  await clock.advance(30_000, t);
  assert.equal(t.status.state, 'on', 'a later check finds it back');
  assert.equal(o.opens, 0);
  const r = await t.restart();
  assert.equal(r.ok, false);
  assert.match(r.text, /Only an ngrok tunnel/);
});

test('another server answering at the address fails the check', async () => {
  const { t, net, clock } = await setup('custom');
  net.impostor = true;
  t.wake();
  await clock.advance(10_000, t);
  assert.equal(t.status.state, 'unreachable');
  assert.equal(t.status.why, 'an answer from something other than this app');
});

test('the door\'s loopback check is recorded down and back, and restarts nothing', async () => {
  const { t, o, net, clock, events } = await setup();
  net.doorUp = false;
  for (let i = 0; i < 3; i++) {
    o.beat(10); // keep the session alive meanwhile
    await clock.advance(WATCH.doorEveryMs, t);
  }
  assert.equal(t.status.door?.ok, false);
  assert.match(t.status.door!.why!, /ECONNREFUSED/);
  assert.equal(events.filter((e) => e.startsWith('door down')).length, 1, 'recorded once, not every minute');
  assert.equal(o.opens, 1);
  net.doorUp = true;
  o.beat(10);
  await clock.advance(WATCH.doorEveryMs, t);
  assert.equal(t.status.door?.ok, true);
  assert.ok(events.includes('door back'));
});

test('turning the tunnel off stops every timer and the session', async () => {
  const { t, o, clock } = await setup();
  await t.start({ provider: 'none', port: 47734 });
  assert.equal(t.status.state, 'off');
  assert.equal(o.closes, 1);
  await clock.advance(10 * 60_000, t);
  assert.equal(o.opens, 1);
  assert.equal(t.url, null);
});
