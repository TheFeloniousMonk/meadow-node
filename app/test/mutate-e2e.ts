// Mutation test for the app's end-to-end encryption (SPEC §8.11, §16.15):
// breaks one §8 rule at a time in the app's own code and confirms that at
// least one e2e vector fails. Restores every file when done, even on error.
//
//   npm run mutate

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const app = join(import.meta.dirname, '..');
const E2E = join(app, 'src', 'core', 'e2e.ts');
const CORE = join(app, 'src', 'core', 'core.ts');
const originals = new Map([E2E, CORE].map((f) => [f, readFileSync(f, 'utf8')]));

const mutations: [string, string, string, string][] = [
  ['no sender check', E2E, "if (pt.sender !== author) return { outcome: 'discarded:sender', prekey };", ''],
  ['no recipient check', E2E, "if (pt.recipient !== this.agent) return { outcome: 'discarded:recipient', prekey };", ''],
  ['no room check (share)', E2E, "    if (pt.room !== room) return { outcome: 'discarded:room', prekey };\n    if (pt.sender", '    if (pt.sender'],
  ['no type check (share)', E2E, "if (pt.t !== 'meadow.room_key') return { outcome: 'discarded:type', prekey };", ''],
  ['export needs no proof', E2E, 'proof = new wasm.InboundGroupSession(pt.proof);', 'proof = wasm.InboundGroupSession.import(pt.key);'],
  ['session form accepts exports', E2E,
    '        proof = new wasm.InboundGroupSession(pt.key);\n        ig = new wasm.InboundGroupSession(pt.key);',
    '        proof = wasm.InboundGroupSession.import(pt.key);\n        ig = wasm.InboundGroupSession.import(pt.key);'],
  ['no session-id match', E2E, "if (pt.session !== c.session || ig.sessionId !== pt.session || proof.sessionId !== pt.session) return { outcome: 'discarded:session', prekey };", ''],
  ['no session binding', E2E, "if (boundTo && boundTo !== author) return { outcome: 'discarded:bound', prekey };", ''],
  ['no replay detection', CORE, "const status = i > 0 ? 'replayed' : r.checked === 'ok' ? 'shown' : 'bad_commitment';", "const status = r.checked === 'ok' ? 'shown' : 'bad_commitment';"],
  ['no commitment check', E2E, 'if (commitment(kf, body) !== headerCommitment) return null;', ''],
  ['no first-known-index check', E2E, "if (index < ig.firstKnownIndex) return { status: 'missing_key', session: c.session, index };", ''],
  ['session looked up by ID, any author', E2E, 'const ig = this.#inbound.get(k);', 'const ig = this.#inbound.get(k) ?? [...this.#inbound].find(([kk]) => kk.endsWith(`|${c.session}`))?.[1];'],
  ['entitlement ignores the suffix rule', E2E, 'if (!ev || !recipients(room.stateAt(ev.header.parents), this.agent).has(requester)) break;', 'if (!ev) break;'],
  ['entitlement ignores current membership', E2E, 'if (!recipients(room.currentState(), this.agent).has(requester)) return null;', ''],
  ['no requester check', E2E, "if (pt.requester !== author) return { outcome: 'discarded:requester', prekey };", ''],
  ['no owner check', E2E, "if (pt.owner !== this.agent) return { outcome: 'discarded:owner', prekey };", ''],
  ['invitees are not recipients', E2E, "['join', 'invite'].includes(ev.header.data.membership)", "['join'].includes(ev.header.data.membership)"],
  ['no-content shares treated as unsupported', E2E, "if (ev.content === undefined) return { outcome: 'ignored:no_content' };", ''],
  ['missing keys never retried', CORE, 'this.#decryptInto(ctx, { ...stored, content: w.content }, slots);', ''],
];

let survived = 0;
try {
  for (const [name, file, from, to] of mutations) {
    const original = originals.get(file)!;
    if (!original.includes(from)) {
      console.log(`SKIP   ${name}: pattern not found`);
      survived++;
      continue;
    }
    writeFileSync(file, original.replace(from, to));
    let out = '';
    try {
      out = execFileSync(process.execPath, ['--test', '--test-reporter=spec', join(app, 'test', 'vectors.test.ts')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      out = e.stdout ?? '';
    }
    writeFileSync(file, original);
    const failed = [...new Set(out.split('\n').filter((l) => /✖ e2e\//.test(l)).map((l) => l.replace(/.*✖ e2e\/(\S+).*/, '$1')))];
    if (failed.length) console.log(`caught ${name}: ${failed.join(', ')}`);
    else {
      console.log(`MISSED ${name}`);
      survived++;
    }
  }
} finally {
  for (const [f, s] of originals) writeFileSync(f, s);
}
console.log(survived ? `\n${survived} mutation(s) survived` : '\nevery mutation was caught');
if (survived) process.exitCode = 1;
