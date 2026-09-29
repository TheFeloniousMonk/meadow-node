// Runs the conformance vectors (state/, agent/, report/) against the reference node.
//
//   node conformance/run.js
//
// Another implementation passes by feeding each vector's steps, in order, to a
// fresh room and matching every step's outcome, the final heads, and the final
// current state (SPEC §6.9).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room } from '../backend/src/room/room.js';
import { verifyReport } from '../backend/src/proto/report.js';
import { AgentLog } from '../backend/src/agent/agent.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'vectors', 'state');
let failed = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const v = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const agents = new AgentLog();
  const room = new Room(agents);
  const idOf = new Map();
  const errors = [];

  for (const step of v.steps) {
    idOf.set(step.label, step.event.id);
    const isAgent = step.event.header?.kind?.startsWith('agent.');
    const got = isAgent ? agents.add(step.event) : room.add(step.event);
    const want = step.expect;
    const same = got.outcome === want.outcome &&
      (want.outcome === 'accepted' ? (isAgent || got.soft_failed === want.soft_failed) : got.reason === want.reason);
    if (!same) errors.push(`${step.label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }

  const heads = room.heads();
  const wantHeads = v.final.heads.map((l) => idOf.get(l)).sort();
  if (JSON.stringify(heads) !== JSON.stringify(wantHeads)) errors.push(`heads: expected ${wantHeads}, got ${heads}`);

  const state = room.currentState();
  const keys = new Set([...state.keys(), ...Object.keys(v.final.state)]);
  for (const k of keys) {
    const want = v.final.state[k] && idOf.get(v.final.state[k]);
    if (state.get(k)?.id !== want) errors.push(`state ${k}: expected ${want}, got ${state.get(k)?.id}`);
  }

  if (errors.length) {
    failed++;
    console.log(`FAIL ${file}\n  ${errors.join('\n  ')}`);
  } else {
    console.log(`ok   ${file}`);
  }
}

const agentDir = join(dirname(fileURLToPath(import.meta.url)), 'vectors', 'agent');
for (const file of readdirSync(agentDir).filter((f) => f.endsWith('.json')).sort()) {
  const v = JSON.parse(readFileSync(join(agentDir, file), 'utf8'));
  const log = new AgentLog();
  const idOf = new Map();
  const errors = [];
  for (const step of v.steps) {
    idOf.set(step.label, step.event.id);
    const got = log.add(step.event);
    const want = step.expect;
    const same = got.outcome === want.outcome && (want.outcome === 'accepted' || got.reason === want.reason);
    if (!same) errors.push(`${step.label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  for (const [agent, want] of Object.entries(v.final.heads)) {
    const got = log.head(agent);
    if (got?.id !== idOf.get(want.head)) errors.push(`head of ${agent}: expected ${want.head}, got ${got?.id}`);
    if (JSON.stringify(got?.state) !== JSON.stringify(want.state)) errors.push(`state of ${agent} differs`);
  }
  if (errors.length) {
    failed++;
    console.log(`FAIL agent/${file}\n  ${errors.join('\n  ')}`);
  } else {
    console.log(`ok   agent/${file}`);
  }
}

const reportDir = join(dirname(fileURLToPath(import.meta.url)), 'vectors', 'report');
for (const file of readdirSync(reportDir).filter((f) => f.endsWith('.json')).sort()) {
  const v = JSON.parse(readFileSync(join(reportDir, file), 'utf8'));
  const got = verifyReport(v.report);
  const ok = v.expect.valid ? got.id === v.expect.id : got.reason === v.expect.reason;
  if (ok) {
    console.log(`ok   report/${file}`);
  } else {
    failed++;
    console.log(`FAIL report/${file}\n  expected ${JSON.stringify(v.expect)}, got ${JSON.stringify(got)}`);
  }
}

// End-to-end encryption (SPEC §8.11): each vector is checked from its own
// contents only (pickled state, key bundles, and events), through the
// reference receiver in tools/e2e.js and vodozemac via crypto/pkg.
const { E2EClient, PICKLE_KEY, wasm } = await import('./tools/e2e.js');
const e2eDir = join(dirname(fileURLToPath(import.meta.url)), 'vectors', 'e2e');
for (const file of readdirSync(e2eDir).filter((f) => f.endsWith('.json')).sort()) {
  const v = JSON.parse(readFileSync(join(e2eDir, file), 'utf8'));
  const errors = [];
  try {
    if (v.type === 'olm') {
      const acct = wasm.Account.fromPickle(v.receiver_account, PICKLE_KEY);
      if (acct.curve25519Key !== v.receiver_bundle.curve25519) errors.push('receiver key differs from its bundle');
      const [first, ...rest] = v.messages;
      const r = acct.createInboundSession(v.sender_curve25519, first.body);
      const s = r.takeSession();
      const got = [r.plaintext, ...rest.map((m) => s.decrypt(m.type, m.body))];
      v.messages.forEach((m, i) => { if (got[i] !== m.plaintext) errors.push(`message ${i}: got ${got[i]}`); });
    } else if (v.type === 'megolm') {
      const all = wasm.InboundGroupSession.import(v.exported_0);
      const from1 = wasm.InboundGroupSession.import(v.exported_1);
      for (const m of v.messages) {
        const d = all.decrypt(m.body);
        if (d.plaintext !== m.plaintext || d.messageIndex !== m.index) errors.push(`index ${m.index}: got ${d.plaintext}@${d.messageIndex}`);
        let late = null;
        try { late = from1.decrypt(m.body).plaintext; } catch {}
        if ((m.index >= 1) !== (late === m.plaintext)) errors.push(`import at 1, index ${m.index}: got ${late}`);
      }
      const signed = new wasm.InboundGroupSession(v.session_key);
      if (signed.sessionId !== v.session_id || signed.firstKnownIndex !== v.messages.length) errors.push('session_key does not parse as the signed key at the current index');
      let exportParsed = true;
      try { new wasm.InboundGroupSession(v.exported_0); } catch { exportParsed = false; }
      if (exportParsed) errors.push('an exported key parsed as a signed key');
    } else {
      const room = new Room(new AgentLog());
      for (const s of v.steps) room.add(s.event);
      const client = E2EClient.fromSnapshot({ id: v.receiver.agent, name: v.receiver.name }, v.state);
      const { statuses, requests } = client.receive(v.steps.map((s) => s.event), v.room_type, v.bundles);
      const idOf = new Map(v.steps.map((s) => [s.label, s.event.id]));
      for (const [label, want] of Object.entries(v.expect.statuses)) {
        const got = statuses.get(idOf.get(label));
        if (got !== want) errors.push(`${label}: expected ${want}, got ${got}`);
      }
      for (const [label, want] of Object.entries(v.expect.answers)) {
        const req = requests.get(idOf.get(label));
        const got = req ? req.sessions.map((q) => client.entitlement(room, req.requester, q.session, q.from)) : null;
        if (JSON.stringify(got) !== JSON.stringify(want)) errors.push(`answer to ${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
      }
      if (requests.size !== Object.keys(v.expect.answers).length) errors.push(`${requests.size} requests, ${Object.keys(v.expect.answers).length} expected`);
    }
  } catch (err) {
    errors.push(`threw: ${err.message}`);
  }
  if (errors.length) {
    failed++;
    console.log(`FAIL e2e/${file}\n  ${errors.join('\n  ')}`);
  } else {
    console.log(`ok   e2e/${file}`);
  }
}

if (failed) {
  console.log(`\n${failed} vector(s) failed`);
  process.exit(1);
}
