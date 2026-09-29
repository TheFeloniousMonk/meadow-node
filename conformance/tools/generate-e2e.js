// Writes conformance/vectors/e2e/ (SPEC §8.11) from e2e-scenarios.js and the
// primitive cases below. Encryption is randomized, so every run produces new
// ciphertext: run it only when the vectors should change, and commit the result.
// It writes nothing if the reference implementation disagrees with any
// hand-derived expectation, or if any event the receiver must judge has none.
//
//   node conformance/tools/generate-e2e.js

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2eScenarios, world } from './e2e-scenarios.js';
import { E2EClient, PICKLE_KEY, wasm } from './e2e.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors', 'e2e');
const vectors = [];
const failures = [];

// --- Primitives ---------------------------------------------------------------

{
  const alice = new wasm.Account();
  const bob = new wasm.Account();
  const fallback = bob.generateFallbackKey();
  const out = alice.createOutboundSession(bob.curve25519Key, fallback);
  const plaintexts = ['first pre-key message', 'second, still a pre-key message'];
  const messages = plaintexts.map((p) => out.encrypt(p));
  // Check: the first creates the inbound session, the second decrypts on it.
  const check = wasm.Account.fromPickle(bob.pickle(PICKLE_KEY), PICKLE_KEY);
  const r = check.createInboundSession(alice.curve25519Key, messages[0].body);
  const s = r.takeSession();
  const got = [r.plaintext, s.decrypt(messages[1].type, messages[1].body)];
  if (JSON.stringify(got) !== JSON.stringify(plaintexts) || messages.some((m) => m.type !== 0)) failures.push('olm-prekey: round trip failed');
  vectors.push({
    file: '01-olm-prekey.json',
    body: {
      name: 'olm-prekey',
      description: 'Olm, version 1 (§8.1, §8.3). The receiver\'s account (pickled with the all-zero key) decrypts two pre-key messages from a sender identified by its Curve25519 key: the first creates the inbound session, the second decrypts on it.',
      sections: ['8.1', '8.3'],
      type: 'olm',
      receiver_account: bob.pickle(PICKLE_KEY),
      receiver_bundle: { curve25519: bob.curve25519Key, fallback },
      sender_curve25519: alice.curve25519Key,
      messages: messages.map((m, i) => ({ type: m.type, body: m.body, plaintext: plaintexts[i] })),
    },
  });
}

{
  const gs = new wasm.GroupSession();
  const copy = gs.inboundCopy();
  const plaintexts = ['index 0', 'index 1', 'index 2'];
  const messages = plaintexts.map((p) => gs.encrypt(p));
  const sessionKey0 = copy.exportAt(0);
  const exported1 = copy.exportAt(1);
  const current = gs.sessionKey;
  const check = wasm.InboundGroupSession.import(exported1);
  let ok = check.firstKnownIndex === 1;
  try {
    check.decrypt(messages[0]);
    ok = false;
  } catch {}
  if (!ok || check.decrypt(messages[2]).plaintext !== 'index 2') failures.push('megolm: round trip failed');
  vectors.push({
    file: '02-megolm.json',
    body: {
      name: 'megolm',
      description: 'Megolm, version 1 (§8.1, §8.4-8.6). `exported_0` and `exported_1` are the session exported at indexes 0 and 1; `session_key` is the signed key at index 3, after three messages. An import at 0 decrypts all three; an import at 1 decrypts 1 and 2 and refuses 0. `session_key` parses as a signed key; an exported key does not.',
      sections: ['8.1', '8.5', '8.6'],
      type: 'megolm',
      session_id: gs.sessionId,
      exported_0: sessionKey0,
      exported_1: exported1,
      session_key: current,
      messages: messages.map((m, i) => ({ body: m, index: i, plaintext: plaintexts[i] })),
    },
  });
}

// --- Scenarios ------------------------------------------------------------------

e2eScenarios.forEach((sc, i) => {
  const fail = (msg) => failures.push(`${sc.name}: ${msg}`);
  const w = world();
  sc.build(w);
  const receiver = w.clients[sc.receiver];
  const state = receiver.snapshot();
  const withhold = new Set((sc.withhold ?? []).map((l) => w.b.id(l)));
  const steps = w.b.steps.map((s) => {
    if (!withhold.has(s.event.id)) return { label: s.label, event: s.event };
    const { content, ...rest } = s.event;
    return { label: s.label, event: { ...rest, withheld: 'expired' } };
  });
  const labelOf = new Map(steps.map((s) => [s.event.id, s.label]));
  const exp = sc.expect(w);

  const client = E2EClient.fromSnapshot(receiver.agent, state);
  const { statuses, requests } = client.receive(steps.map((s) => s.event), sc.roomType, w.bundles);
  const judged = steps.filter((s) => s.event.header.author !== receiver.id && ['msg.post', 'room.keys'].includes(s.event.header.kind));
  for (const s of judged) {
    const want = exp.statuses[s.label];
    const got = statuses.get(s.event.id);
    if (want === undefined) fail(`no expectation for ${s.label} (implementation says ${got})`);
    else if (want !== got) fail(`${s.label}: expected ${want}, implementation says ${got}`);
  }
  for (const label of Object.keys(exp.statuses)) if (!judged.some((s) => s.label === label)) fail(`expectation for ${label}, which the receiver does not judge`);

  const answers = {};
  for (const [id, req] of requests) {
    answers[labelOf.get(id)] = req.sessions.map((q) => client.entitlement(w.b.room, req.requester, q.session, q.from));
  }
  if (JSON.stringify(answers, Object.keys(answers).sort()) !== JSON.stringify(exp.answers ?? {}, Object.keys(exp.answers ?? {}).sort())) {
    fail(`answers: expected ${JSON.stringify(exp.answers ?? {})}, implementation says ${JSON.stringify(answers)}`);
  }

  vectors.push({
    file: `${String(i + 3).padStart(2, '0')}-${sc.name}.json`,
    body: {
      name: sc.name,
      description: sc.description,
      sections: sc.sections,
      type: 'room',
      room_type: sc.roomType,
      receiver: { name: sc.receiver, agent: receiver.id },
      pickle_key: Buffer.from(PICKLE_KEY).toString('hex'),
      state,
      bundles: w.bundles,
      steps,
      expect: { statuses: exp.statuses, answers: exp.answers ?? {} },
    },
  });
});

if (failures.length) {
  console.error(`not writing e2e vectors: the reference implementation disagrees with the expectations\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const v of vectors) writeFileSync(join(outDir, v.file), JSON.stringify(v.body, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors to ${outDir}`);
console.log(readdirSync(outDir).join('\n'));
