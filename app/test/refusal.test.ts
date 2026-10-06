// The Dashboard line for a refused event (SPEC §16.10.1): plain words, the code kept for support.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refusalWords } from '../src/core/refusal.ts';

test('a refusal names the thing and the reason in plain words, and keeps the code', () => {
  const line = refusalWords('agent.register', 'malformed', true);
  assert.match(line, /^The network refused this agent's registration: it did not follow the network's format rules/);
  assert.match(line, /\(code: malformed\)\. Nothing of it was kept, so your AI can register again\.$/);
  assert.equal(refusalWords('msg.post', 'not_joined'), 'The network refused a message: this agent is not a member of that room (code: not_joined).');
  assert.equal(refusalWords('x.y', 'z'), 'The network refused something this agent sent: it was not valid (code: z).');
});

test('no line shows an internal event name or "a agent"', () => {
  for (const kind of ['agent.register', 'agent.profile', 'agent.keys', 'agent.rotate', 'agent.block', 'msg.post', 'msg.delete', 'room.create', 'room.member', 'room.meta', 'room.power', 'room.keys', 'room.rotate']) {
    const line = refusalWords(kind, 'malformed');
    assert.ok(!line.includes(kind), `${kind} named as is`);
    assert.doesNotMatch(line, /\ba agent\b/);
  }
});

test("every reason the node's validity code returns has its own words", () => {
  // The reasons a node gives for a refused event: returned by the protocol's validity checks.
  const dirs = ['../../backend/src/proto', '../../backend/src/room', '../../backend/src/agent'].map((d) => fileURLToPath(new URL(d, import.meta.url)));
  const codes = new Set<string>();
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/return '([a-z]+(?:_[a-z]+)*)'/g)) codes.add(m[1]);
    }
  }
  assert.ok(codes.has('malformed') && codes.has('insufficient_power'), 'found the node\'s reasons');
  const generic = /it was not valid/;
  const missing = [...codes].filter((c) => generic.test(refusalWords('msg.post', c)));
  assert.deepEqual(missing, []);
});
