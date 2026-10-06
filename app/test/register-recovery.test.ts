// Registering after a refusal (SPEC §16.6, a tester's report, 2026-10-06): an agent's register call
// answered registered: false for days with nothing queued. A node had refused the registration
// event; the app dropped it from the outbox but kept it as the head of the agent's own chain, so no
// later call built a new one. Now values every node refuses are caught before signing, a refused own
// event is rolled back, and an agent left stuck by an earlier version registers again.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../backend/src/server.js';
import { Store } from '../../backend/src/store/store.js';
import { openDb } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { Core } from '../src/core/core.ts';
import type { Transport } from '../src/core/transport.ts';

const servers: any[] = [];
after(() => { for (const s of servers) s.close(); });

async function node() {
  const store = new Store();
  const server = createServer(store, { network: 'main', version: 'test', sourceUrl: '', supportUrl: '', operator: null });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { store, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Every event in a request body with this kind. */
function eventsOfKind(body: unknown, kind: string): any[] {
  const out: any[] = [];
  const walk = (x: any) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      if (x.header?.kind === kind && typeof x.id === 'string') out.push(x);
      else Object.values(x).forEach(walk);
    }
  };
  walk(body);
  return out;
}

/** Calls the node; with `refuse` set, a sync carrying an event of that kind is answered as a refusal. */
function transport(n: { url: string }) {
  const t: Transport & { refuse: string | null; down: boolean } = {
    refuse: null,
    down: false,
    async call(path, body) {
      if (t.down) throw new Error('offline');
      const refused = t.refuse ? eventsOfKind(body, t.refuse) : [];
      if (path === '/v2/sync' && refused.length) {
        return { status: 200, data: { node: 'n_' + 'N'.repeat(43), accepted: [], rejected: refused.map((e) => ({ id: e.id, reason: 'malformed' })), pending: [], rooms: {}, invites: [], more: false } };
      }
      const res = await fetch(n.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    },
  };
  return t;
}

function setup(t: Transport) {
  const db = openDb();
  const core = new Core({ db, vault: new Vault(randomBytes(32)), transport: t });
  const { id, name } = core.createAgent('Neo');
  return { db, core, id, name };
}

const lookup = async (n: { url: string }, agentId: string) => {
  const res = await fetch(n.url + '/v2/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: agentId }) });
  return ((await res.json()) as any).agents as any[];
};

test('a description or capability every node would refuse is caught before signing, for free', async () => {
  const n = await node();
  const a = setup(transport(n));
  await assert.rejects(a.core.register(a.id, { capabilities: ['x'.repeat(65)] }), /too long: each can be at most 64 bytes.*Nothing was sent/);
  await assert.rejects(a.core.register(a.id, { capabilities: ['a', 'a'] }), /listed twice/);
  await assert.rejects(a.core.register(a.id, { description: 'é'.repeat(513) }), /at most 1024 bytes/);
  assert.equal((a.db.prepare('SELECT chain_head FROM agents WHERE id = ?').get(a.id) as any).chain_head, null);
  assert.equal((a.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as any).n, 0);
  const r = await a.core.register(a.id, { capabilities: ['x'.repeat(64)] });
  assert.equal(r.registered, true);
});

test('a refused registration is rolled back, says so, and the next register call registers', async () => {
  const n = await node();
  const t = transport(n);
  const a = setup(t);
  t.refuse = 'agent.register';
  const first = await a.core.register(a.id);
  assert.equal(first.registered, false);
  assert.deepEqual(first.report.rejected.map((x: any) => x.reason), ['malformed']);
  assert.match(a.core.problems(a.id).map((p) => p.text).join('\n'), /refused this agent's registration \(malformed\)\. Nothing of it was kept; it can be tried again/);
  assert.equal((a.db.prepare('SELECT chain_head FROM agents WHERE id = ?').get(a.id) as any).chain_head, null, 'not left as the head');

  t.refuse = null;
  const again = await a.core.register(a.id);
  assert.equal(again.registered, true);
  assert.equal((await lookup(n, a.id)).length, 1, 'the node serves it');
});

test('an agent stuck by an earlier version (head kept, nothing queued, never registered) registers again', async () => {
  const n = await node();
  const t = transport(n);
  const a = setup(t);
  // What an earlier version left: the registration signed and queued, then dropped from the outbox on
  // a refusal, with the head kept.
  t.down = true;
  await assert.rejects(a.core.register(a.id));
  a.db.prepare('DELETE FROM outbox WHERE agent = ?').run(a.id);
  assert.notEqual((a.db.prepare('SELECT chain_head FROM agents WHERE id = ?').get(a.id) as any).chain_head, null);

  t.down = false;
  const r = await a.core.register(a.id);
  assert.equal(r.registered, true);
  assert.equal((await lookup(n, a.id)).length, 1);
  assert.equal(a.core.agents()[0].handle, r.handle, 'the same handle: the key did not change');
});

test('a refused profile change is rolled back, so the next change builds on what nodes hold', async () => {
  const n = await node();
  const t = transport(n);
  const a = setup(t);
  assert.equal((await a.core.register(a.id)).registered, true);
  const head = (a.db.prepare('SELECT chain_head FROM agents WHERE id = ?').get(a.id) as any).chain_head;
  t.refuse = 'agent.profile';
  await a.core.updateProfile(a.id, { description: 'first try' });
  await a.core.sync(a.id);
  assert.equal((a.db.prepare('SELECT chain_head FROM agents WHERE id = ?').get(a.id) as any).chain_head, head, 'back to the registration');
  t.refuse = null;
  await a.core.updateProfile(a.id, { description: 'second try' });
  const s = await a.core.sync(a.id);
  assert.equal(s.rejected.length, 0);
  assert.equal((await lookup(n, a.id))[0].description, 'second try');
});
