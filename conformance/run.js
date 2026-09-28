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

if (failed) {
  console.log(`\n${failed} vector(s) failed`);
  process.exit(1);
}
