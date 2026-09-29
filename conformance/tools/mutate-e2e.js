// Mutation test for the end-to-end vectors (SPEC §8.11): breaks one §8 rule at
// a time in the reference receiver and confirms at least one vector fails.
// Restores e2e.js when done, even on error.
//
//   node conformance/tools/mutate-e2e.js

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = `${root}/conformance/tools/e2e.js`;
const original = readFileSync(file, 'utf8');

const mutations = [
  ['no sender check', "if (pt.sender !== author) return 'discarded:sender';", ''],
  ['no recipient check', "if (pt.recipient !== this.id) return 'discarded:recipient';", ''],
  ['no room check (share)', "    if (pt.room !== room) return 'discarded:room';\n    if (pt.sender", '    if (pt.sender'],
  ['no type check (share)', "if (pt.t !== 'meadow.room_key') return 'discarded:type';", ''],
  ['export needs no proof', 'proof = new wasm.InboundGroupSession(pt.proof);', 'proof = wasm.InboundGroupSession.import(pt.key);'],
  ['session form accepts exports', "        proof = new wasm.InboundGroupSession(pt.key);\n        ig = new wasm.InboundGroupSession(pt.key);", "        proof = wasm.InboundGroupSession.import(pt.key);\n        ig = wasm.InboundGroupSession.import(pt.key);"],
  ['no session binding', "if (boundTo && boundTo !== author) return 'discarded:bound';", ''],
  ['no session-id match', "if (pt.session !== c.session || ig.sessionId !== pt.session || proof.sessionId !== pt.session) return 'discarded:session';", ''],
  ['no replay detection', "for (const id of ids.slice(1)) statuses.set(id, 'replayed');", "for (const id of ids.slice(1)) statuses.set(id, `shown:${parse(decrypted.get(id).plaintext)?.body?.text}`);"],
  ['no commitment check', "if (!valid || commitment(kf, body) !== ev.header.commitment) statuses.set(id, 'bad_commitment');", "if (!valid) statuses.set(id, 'bad_commitment');"],
  ['no first-known-index check', "if (index < ig.firstKnownIndex) return { status: 'missing_key' };", ''],
  ['session looked up by ID, any author', "const ig = this.inbound.get(k);\n      if (!ig) return { status: 'missing_key' };", "const ig = this.inbound.get(k) ?? [...this.inbound].find(([kk]) => kk.endsWith(`|${c.session}`))?.[1];\n      if (!ig) return { status: 'missing_key' };"],
  ['entitlement ignores the suffix rule', "      if (!recipients(room.stateAt(ev.header.parents), this.id).has(requester)) break;\n", ''],
  ['entitlement ignores current membership', "    if (!now.has(requester)) return null;\n", ''],
  ['no requester check', "if (pt.requester !== author) return 'discarded:requester';", ''],
  ['no owner check', "if (pt.owner !== this.id) return 'discarded:owner';", ''],
  ['invitees are not recipients', "if (['join', 'invite'].includes(ev.header.data.membership))", "if (['join'].includes(ev.header.data.membership))"],
  ['no-content shares treated as unsupported', "if (ev.content === undefined) return 'ignored:no_content';", ''],
];

let survived = 0;
try {
  for (const [name, from, to] of mutations) {
    if (!original.includes(from)) {
      console.log(`SKIP  ${name}: pattern not found`);
      survived++;
      continue;
    }
    writeFileSync(file, original.replace(from, to));
    let out = '';
    let failedVectors = [];
    try {
      out = execFileSync(process.execPath, [`${root}/conformance/run.js`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = e.stdout ?? '';
    }
    failedVectors = out.split('\n').filter((l) => l.startsWith('FAIL e2e/')).map((l) => l.slice(9));
    if (failedVectors.length) console.log(`caught ${name}: ${failedVectors.join(', ')}`);
    else {
      console.log(`MISSED ${name}`);
      survived++;
    }
  }
} finally {
  writeFileSync(file, original);
}
console.log(survived ? `\n${survived} mutation(s) survived` : '\nevery mutation was caught');
