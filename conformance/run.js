// Runs the conformance vectors (state/, agent/, report/) against the reference node.
//
//   node conformance/run.js
//
// Another implementation passes by feeding each vector's steps, in order, to a
// fresh room and matching every step's outcome, the final heads, and the final
// current state (SPEC §6.9). It also replays every state vector in many other
// orders that deliver each event after what it cites, and checks that the
// outcomes (soft-failing aside), heads, and state stay the same.

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

// Convergence (SPEC §6.9): every node must end with the same room whatever order
// the events reach it in. Each state vector is replayed in ORDERS seeded random
// orders, each delivering an event only after the events it cites (parents, auth
// events, the room.create, and a cited agent chain event). Every replay must give
// the same outcomes as the vector's own order (soft-failing aside: it depends on
// arrival order by design, §6.6), the same heads, and the same current state.
const ORDERS = 50;
const mulberry32 = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function replay(steps) {
  const agents = new AgentLog();
  const room = new Room(agents);
  const outcomes = new Map();
  for (const st of steps) {
    const got = st.event.header?.kind?.startsWith('agent.') ? agents.add(st.event) : room.add(st.event);
    outcomes.set(st.label, got.outcome === 'rejected' ? `rejected:${got.reason}` : got.outcome);
  }
  const state = [...room.currentState()].map(([k, ev]) => `${k}=${ev.id}`).sort();
  return { outcomes, heads: room.heads().join(','), state: state.join('\n') };
}

function randomOrder(steps, random) {
  const stored = new Map(); // event ID -> label of the step that stores it
  for (const st of steps) if (st.expect.outcome !== 'discarded') stored.set(st.event.id, st.label);
  const create = steps.find((st) => st.event.header?.kind === 'room.create' && st.expect.outcome === 'accepted');
  const deps = new Map(steps.map((st) => {
    const h = st.event.header ?? {};
    const refs = [...(h.parents ?? []), ...(h.auth ?? []), ...(h.data?.chain ? [h.data.chain] : [])];
    const d = new Set(refs.map((id) => stored.get(id)).filter((l) => l && l !== st.label));
    if (create && h.kind && !h.kind.startsWith('agent.') && h.kind !== 'room.create') d.add(create.label);
    return [st.label, d];
  }));
  const done = new Set(), order = [];
  while (order.length < steps.length) {
    const ready = steps.filter((st) => !done.has(st.label) && [...deps.get(st.label)].every((l) => done.has(l)));
    const pick = ready[Math.floor(random() * ready.length)];
    done.add(pick.label);
    order.push(pick);
  }
  return order;
}

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const v = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const base = replay(v.steps);
  let problem = null;
  for (let seed = 1; seed <= ORDERS && !problem; seed++) {
    const got = replay(randomOrder(v.steps, mulberry32(seed)));
    for (const [label, want] of base.outcomes) {
      if (got.outcomes.get(label) !== want) { problem = `order ${seed}: ${label} ${got.outcomes.get(label)}, in vector order ${want}`; break; }
    }
    if (!problem && got.heads !== base.heads) problem = `order ${seed}: heads differ`;
    if (!problem && got.state !== base.state) problem = `order ${seed}: state differs\n    ${got.state.replaceAll('\n', '\n    ')}`;
  }
  if (problem) {
    failed++;
    console.log(`FAIL converge/${file}\n  ${problem}`);
  } else {
    console.log(`ok   converge/${file} (${ORDERS} orders)`);
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
