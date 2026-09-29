// The conformance vectors, run against the app (SPEC §16.15).
//
// State, agent, and report vectors: the app validates rooms, chains, and
// reports with the node's own code (src/core/deps.ts), so they run through
// exactly the functions the app calls.
//
// End-to-end vectors (§8.11): each room vector's receiver is loaded into an
// app database, from the vector's pickles alone, and its events go through
// Core.ingestRoomEvents, the path every sync takes. The statuses the app
// stores, and its answers to key requests, must match the vector.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentLog, Room, roomIdOf, verifyReport, wasm } from '../src/core/deps.ts';
import { openDb } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { Core } from '../src/core/core.ts';
import { bundleKey } from '../src/core/e2e.ts';
import type { Transport } from '../src/core/transport.ts';

const VECTORS = join(import.meta.dirname, '..', '..', 'conformance', 'vectors');
const load = (dir: string) => readdirSync(join(VECTORS, dir)).filter((f) => f.endsWith('.json')).sort()
  .map((f) => ({ file: f, v: JSON.parse(readFileSync(join(VECTORS, dir, f), 'utf8')) }));

const noNetwork: Transport = { call: async () => { throw new Error('no network in vector tests'); } };

for (const { file, v } of load('state')) {
  test(`state/${file}`, () => {
    const agents = new AgentLog();
    const room = new Room(agents);
    const idOf = new Map<string, string>();
    for (const step of v.steps) {
      idOf.set(step.label, step.event.id);
      const isAgent = step.event.header?.kind?.startsWith('agent.');
      const got: any = isAgent ? agents.add(step.event) : room.add(step.event);
      const want = step.expect;
      assert.equal(got.outcome, want.outcome, step.label);
      if (want.outcome === 'accepted' && !isAgent) assert.equal(got.soft_failed, want.soft_failed, step.label);
      if (want.outcome !== 'accepted') assert.equal(got.reason, want.reason, step.label);
    }
    assert.deepEqual(room.heads(), v.final.heads.map((l: string) => idOf.get(l)).sort());
    const state = room.currentState();
    for (const k of new Set([...state.keys(), ...Object.keys(v.final.state)])) {
      assert.equal(state.get(k)?.id, v.final.state[k] && idOf.get(v.final.state[k]), k);
    }
  });
}

for (const { file, v } of load('agent')) {
  test(`agent/${file}`, () => {
    const log = new AgentLog();
    const idOf = new Map<string, string>();
    for (const step of v.steps) {
      idOf.set(step.label, step.event.id);
      const got: any = log.add(step.event);
      assert.equal(got.outcome, step.expect.outcome, step.label);
      if (step.expect.outcome !== 'accepted') assert.equal(got.reason, step.expect.reason, step.label);
    }
    for (const [agent, want] of Object.entries<any>(v.final.heads)) {
      assert.equal(log.head(agent)?.id, idOf.get(want.head));
      assert.deepEqual(log.head(agent)?.state, want.state);
    }
  });
}

for (const { file, v } of load('report')) {
  test(`report/${file}`, () => {
    const got = verifyReport(v.report);
    if (v.expect.valid) assert.equal(got.id, v.expect.id);
    else assert.equal(got.reason, v.expect.reason);
  });
}

/** An app database holding the vector's receiver, converted from its published pickles. */
function receiverCore(v: any): { core: Core; agent: string } {
  const db = openDb();
  const vault = new Vault(randomBytes(32));
  const agent = v.receiver.agent;
  const zero = new Uint8Array(32);
  const key = vault.pickleKey(agent);
  const snap = v.state;
  const repickle = (cls: any, p: string) => cls.fromPickle(p, zero).pickle(key);
  db.prepare(`INSERT INTO agents (id, display_name, name, secret_sealed, account, fallback, created_at) VALUES (?, ?, ?, ?, ?, '', 0)`)
    .run(agent, v.receiver.name, v.receiver.name, vault.sealJson(`agent:${agent}:secret`, { seed: randomBytes(32).toString('base64') }), repickle(wasm.Account, snap.account));
  for (const [peer, list] of Object.entries<string[]>(snap.olm)) {
    list.forEach((p, i) => {
      const s = wasm.Session.fromPickle(p, zero);
      db.prepare('INSERT INTO olm_sessions (agent, peer, session_id, pickle, created, last_decrypt) VALUES (?, ?, ?, ?, ?, 0)').run(agent, peer, s.sessionId, s.pickle(key), i + 1);
    });
  }
  for (const [room, list] of Object.entries<any[]>(snap.own)) {
    list.forEach((s, i) => {
      const gs = wasm.GroupSession.fromPickle(s.gs, zero);
      db.prepare(`INSERT INTO group_out (agent, room, session_id, pickle, copy, recipients, count, messages, created_at, seq)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(agent, room, gs.sessionId, gs.pickle(key), repickle(wasm.InboundGroupSession, s.copy), JSON.stringify(s.recipients), s.count, JSON.stringify(s.messages), Date.now(), i);
    });
  }
  for (const [k, p] of Object.entries<string>(snap.inbound)) {
    const [room, sender, session] = k.split('|');
    const ig = wasm.InboundGroupSession.fromPickle(p, zero);
    db.prepare('INSERT INTO group_in (agent, room, sender, session_id, pickle, first_index) VALUES (?, ?, ?, ?, ?, ?)').run(agent, room, sender, session, ig.pickle(key), ig.firstKnownIndex);
  }
  for (const [k, sender] of Object.entries<string>(snap.bound)) {
    const [room, session] = k.split('|');
    db.prepare('INSERT INTO group_bind (agent, room, session_id, sender) VALUES (?, ?, ?, ?)').run(agent, room, session, sender);
  }
  for (const id of snap.processed) db.prepare("INSERT INTO keys_log (agent, id, room, outcome, at) VALUES (?, ?, '', 'processed', 0)").run(agent, id);
  for (const [peer, b] of Object.entries<any>(v.bundles)) {
    // Stored as a verified chain carries them: b64u (§3.3).
    db.prepare('INSERT INTO peers (agent, peer, curve25519, fallback, verified_at) VALUES (?, ?, ?, ?, 0)').run(agent, peer, bundleKey(b.curve25519), bundleKey(b.fallback));
  }
  return { core: new Core({ db, vault, transport: noNetwork }), agent };
}

for (const { file, v } of load('e2e')) {
  test(`e2e/${file}`, async () => {
    if (v.type === 'olm') {
      const zero = new Uint8Array(32);
      const acct = wasm.Account.fromPickle(v.receiver_account, zero);
      assert.equal(acct.curve25519Key, v.receiver_bundle.curve25519);
      const [first, ...rest] = v.messages;
      const r = acct.createInboundSession(v.sender_curve25519, first.body);
      const s = r.takeSession();
      assert.deepEqual([r.plaintext, ...rest.map((m: any) => s.decrypt(m.type, m.body))], v.messages.map((m: any) => m.plaintext));
      return;
    }
    if (v.type === 'megolm') {
      const all = wasm.InboundGroupSession.import(v.exported_0);
      for (const m of v.messages) {
        const d = all.decrypt(m.body);
        assert.equal(d.plaintext, m.plaintext);
        assert.equal(d.messageIndex, m.index);
      }
      assert.throws(() => new wasm.InboundGroupSession(v.exported_0), 'an exported key must not parse as a signed key');
      return;
    }
    const { core, agent } = receiverCore(v);
    const events = v.steps.map((s: any) => s.event);
    const roomId = roomIdOf(events[0].id);
    await core.ingestRoomEvents(agent, roomId, events);
    const idOf = new Map<string, string>(v.steps.map((s: any) => [s.label, s.event.id]));
    const messages = new Map(core.messages(agent, { room: roomId }).map((m) => [m.id, m]));
    for (const [label, want] of Object.entries<string>(v.expect.statuses)) {
      const id = idOf.get(label)!;
      const m = messages.get(id);
      const got = m ? (m.status === 'shown' ? `shown:${m.text}` : m.status) : core.keysOutcome(agent, id);
      assert.equal(got, want, label);
    }
    const requests = core.requestsIn(agent);
    assert.equal(requests.length, Object.keys(v.expect.answers).length, 'number of key requests');
    for (const [label, want] of Object.entries<any>(v.expect.answers)) {
      const req = requests.find((r) => r.id === idOf.get(label));
      assert.ok(req, `request ${label}`);
      assert.deepEqual(req.sessions.map((q) => core.entitlement(agent, roomId, req.requester, q.session, q.from)), want, `answer to ${label}`);
    }
  });
}
