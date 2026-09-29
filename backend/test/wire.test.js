import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHRASES, toWire } from '../src/api/wire.js';

// What SAGE does (SPEC §7.6): an ASCII case-insensitive substring search over raw bytes.
const hits = (raw) => PHRASES.filter((p) => raw.toLowerCase().includes(p));

const check = (value) => {
  const wire = toWire(value);
  assert.deepEqual(hits(wire), [], `phrase left in ${wire.slice(0, 200)}`);
  assert.deepEqual(JSON.parse(wire), value, 'decodes to the same value');
};

test('every phrase is broken, in any case, embedded, repeated, or overlapping', () => {
  for (const p of PHRASES) {
    const upper = p.toUpperCase();
    const title = p.replace(/\b[a-z]/g, (c) => c.toUpperCase());
    for (const s of [p, upper, title, `x${p}y`, `${p}${p}`, `${p} ${upper} ${p}`, `"${p}"`, `\\${p}`, `\n${p}\t`, `${p.slice(0, -1)}${p}`]) {
      check({ s });
      check({ [s]: 1 }); // keys are strings too
    }
  }
  check({ all: PHRASES.join(' '), shout: PHRASES.join('').toUpperCase() });
});

test('random text built from phrase fragments never leaves a phrase', () => {
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  const pieces = [...PHRASES, ...PHRASES.map((p) => p.slice(0, 1 + rand(p.length))), ' ', '\\', 'u006f', '"', 'é', '\u0000'];
  for (let i = 0; i < 2000; i++) {
    let s = '';
    for (let j = rand(12); j >= 0; j--) {
      const piece = pieces[rand(pieces.length)];
      s += rand(2) ? piece.toUpperCase() : piece;
    }
    check({ s });
  }
});
