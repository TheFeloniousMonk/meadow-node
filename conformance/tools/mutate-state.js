// Mutation test for the state vectors and the convergence check (SPEC §6.8,
// §6.9): breaks one rule at a time in the reference room code and confirms that
// at least one vector, or the convergence replay, fails. Restores every file
// when done, even on error.
//
//   node conformance/tools/mutate-state.js

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = {
  resolve: `${root}/backend/src/room/resolve.js`,
  auth: `${root}/backend/src/room/auth.js`,
  room: `${root}/backend/src/room/room.js`,
};
const originals = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(f, 'utf8')]));

const mutations = [
  ['resolve', 'power order ignores sender power', 'key.get(b).power - key.get(a).power || ', ''],
  ['resolve', 'power order: later ts first',
    'key.get(a).ts - key.get(b).ts || byId(a, b);', 'key.get(b).ts - key.get(a).ts || byId(a, b);'],
  ['resolve', 'mainline ignores depth', 'key.get(a).depth - key.get(b).depth || ', ''],
  ['resolve', 'mainline: higher ID first on a tie', '|| byId(a, b));', '|| byId(b, a));'],
  ['resolve', 'no conflicted subgraph',
    'const full = new Set([...conflicted, ...conflictedSubgraph(conflicted, ctx)]);', 'const full = new Set([...conflicted]);'],
  ['resolve', 'no auth difference', 'for (const [id, n] of counts) if (n < states.length) full.add(id);', ''],
  ['resolve', "iterative auth keeps the event's own auth events",
    'for (const k of authKeys(ev.header)) if (S.has(k)) A.set(k, S.get(k));', ''],
  ['resolve', 'no mainline root from the unconflicted state',
    "partial.get('room.power|') ?? unconflicted.get('room.power|') ?? null", "partial.get('room.power|') ?? null"],
  ['resolve', 'unconflicted state not set last', 'for (const [k, ev] of unconflicted) partial.set(k, ev);', ''],
  ['resolve', 'power events without their auth chains',
    'for (const a of ctx.authChain(id)) if (full.has(a)) powerIds.add(a);', ''],
  ['auth', 'bindings may move backward', '!agents.descends(h.data.chain, previous.header.data.chain)', 'false'],
  ['room', 'validity checked against the current state',
    'authorize(ev, this.stateAt(h.parents), this.#agents)', 'authorize(ev, this.currentState(), this.#agents)'],
  ['room', 'soft-failed events are not heads',
    "if (result.outcome !== 'accepted') return;", "if (result.outcome !== 'accepted' || result.soft_failed) return;"],
];

const restore = () => { for (const [k, f] of Object.entries(files)) writeFileSync(f, originals[k]); };
let survived = 0;
try {
  for (const [which, name, from, to] of mutations) {
    restore();
    if (!originals[which].includes(from)) {
      console.log(`SKIP   ${name}: pattern not found`);
      survived++;
      continue;
    }
    writeFileSync(files[which], originals[which].replace(from, to));
    let out = '';
    try {
      out = execFileSync(process.execPath, [`${root}/conformance/run.js`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = e.stdout ?? '';
    }
    const failed = out.split('\n').filter((l) => /^FAIL (converge\/)?\d/.test(l)).map((l) => l.slice(5));
    if (failed.length) console.log(`caught ${name}: ${failed.join(', ')}`);
    else {
      console.log(`MISSED ${name}`);
      survived++;
    }
  }
} finally {
  restore();
}
console.log(survived ? `\n${survived} mutation(s) survived` : '\nevery mutation was caught');
