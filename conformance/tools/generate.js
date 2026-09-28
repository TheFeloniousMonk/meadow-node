// Regenerates conformance/vectors/ from scenarios.js, agent-scenarios.js, and
// report-scenarios.js. Fails, writing
// nothing, if the reference implementation disagrees with any hand-derived
// expectation.
//
//   node conformance/tools/generate.js

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder } from './builder.js';
import { scenarios } from './scenarios.js';
import { reportCases } from './report-scenarios.js';
import { agentScenarios } from './agent-scenarios.js';
import { b64u, canonicalize, sha256 } from '../../backend/src/proto/encoding.js';
import { verifyReport } from '../../backend/src/proto/report.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors');

function describe(result) {
  if (result.outcome === 'accepted') return result.soft_failed ? 'soft_failed' : 'accepted';
  return `${result.outcome}:${result.reason ?? result.missing}`;
}

function toExpect(outcome) {
  if (outcome === 'accepted') return { outcome: 'accepted', soft_failed: false };
  if (outcome === 'soft_failed') return { outcome: 'accepted', soft_failed: true };
  const [kind, reason] = outcome.split(':');
  return { outcome: kind, reason };
}

const vectors = [];
const failures = [];

scenarios.forEach((sc, i) => {
  const s = new Builder();
  sc.build(s);
  const exp = sc.expect(s);
  const labelOf = new Map(s.steps.map((st) => [st.event.id, st.label]));
  const fail = (msg) => failures.push(`${sc.name}: ${msg}`);

  for (const st of s.steps) {
    const want = exp.outcomes[st.label];
    const got = describe(st.result);
    if (want === undefined) fail(`no expectation for ${st.label}`);
    else if (want !== got) fail(`${st.label}: expected ${want}, implementation says ${got}`);
  }
  const heads = s.room.heads().map((id) => labelOf.get(id)).sort();
  if (JSON.stringify(heads) !== JSON.stringify([...exp.heads].sort())) fail(`heads: expected ${exp.heads}, got ${heads}`);

  const wantState = Object.fromEntries(exp.state.map(([kind, agent, label]) => [`${kind}|${agent && s.agents.get(agent).id}`, label]));
  const gotState = Object.fromEntries([...s.room.currentState()].map(([k, ev]) => [k, labelOf.get(ev.id)]));
  const keys = new Set([...Object.keys(wantState), ...Object.keys(gotState)]);
  for (const k of keys) if (wantState[k] !== gotState[k]) fail(`state ${k}: expected ${wantState[k]}, got ${gotState[k]}`);

  vectors.push({
    file: `${String(i + 1).padStart(2, '0')}-${sc.name}.json`,
    body: {
      name: sc.name,
      description: sc.description,
      spec_sections: sc.sections,
      agents: Object.fromEntries([...s.agents].map(([n, a]) => [n, a.id])),
      steps: s.steps.map((st) => ({ label: st.label, event: st.event, expect: toExpect(exp.outcomes[st.label]) })),
      final: {
        heads: [...exp.heads].sort(),
        state: Object.fromEntries(Object.entries(wantState).sort(([a], [b]) => (a < b ? -1 : 1))),
      },
    },
  });
});

const reportVectors = reportCases().map((c, i) => {
  const got = verifyReport(c.report);
  const expect = c.expect.valid
    ? { valid: true, id: 'p_' + b64u(sha256(canonicalize(c.report))) }
    : { valid: false, reason: c.expect.reason };
  const same = c.expect.valid ? got.id === expect.id : got.reason === expect.reason;
  if (!same) failures.push(`report ${c.name}: expected ${JSON.stringify(expect)}, implementation says ${JSON.stringify(got)}`);
  return {
    file: `${String(i + 1).padStart(2, '0')}-${c.name}.json`,
    body: { name: c.name, description: c.description, spec_sections: ['9.2'], report: c.report, expect },
  };
});

const agentVectors = agentScenarios.map((sc, i) => {
  const s = new Builder();
  sc.build(s);
  const exp = sc.expect(s);
  const fail = (msg) => failures.push(`agent ${sc.name}: ${msg}`);
  for (const st of s.steps) {
    const want = exp.outcomes[st.label];
    const got = describe(st.result);
    if (want === undefined) fail(`no expectation for ${st.label}`);
    else if (want !== got) fail(`${st.label}: expected ${want}, implementation says ${got}`);
  }
  const heads = {};
  for (const [name, want] of Object.entries(exp.heads)) {
    const agentId = s.agents.get(name).id;
    const got = s.agentLog.head(agentId);
    if (got?.id !== s.id(want.head)) fail(`${name} head: expected ${want.head}, got ${got?.id}`);
    if (JSON.stringify(got?.state) !== JSON.stringify(want.state)) {
      fail(`${name} state: expected ${JSON.stringify(want.state)}, got ${JSON.stringify(got?.state)}`);
    }
    heads[agentId] = { head: want.head, state: want.state };
  }
  return {
    file: `${String(i + 1).padStart(2, '0')}-${sc.name}.json`,
    body: {
      name: sc.name,
      description: sc.description,
      spec_sections: ['5.4'],
      agents: Object.fromEntries([...s.agents].map(([n, a]) => [n, a.id])),
      steps: s.steps.map((st) => ({ label: st.label, event: st.event, expect: toExpect(exp.outcomes[st.label]) })),
      final: { heads },
    },
  };
});

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`\n${failures.length} disagreement(s); no vectors written.`);
  process.exit(1);
}

for (const [sub, list] of [['state', vectors], ['agent', agentVectors], ['report', reportVectors]]) {
  const dir = join(outDir, sub);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) rmSync(join(dir, f));
  for (const v of list) writeFileSync(join(dir, v.file), JSON.stringify(v.body, null, 2) + '\n');
  console.log(`wrote ${list.length} vectors to ${dir}`);
}
