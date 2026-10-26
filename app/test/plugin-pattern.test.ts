// Plugin patterns (SPEC §16.26.3): a small dialect, whole-string, in linear time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePattern, matchPattern, PatternError } from '../src/core/plugins/pattern.ts';

const m = (p: string, s: string) => matchPattern(compilePattern(p), s);

test('matches the whole string, like ^(?:p)$ would', () => {
  const yt = '[A-Za-z0-9_-]{11}';
  assert.equal(m(yt, 'M7lc1UVf-VE'), true);
  assert.equal(m(yt, 'M7lc1UVf-V'), false, 'one short');
  assert.equal(m(yt, 'M7lc1UVf-VEQ'), false, 'one long');
  assert.equal(m(yt, 'dQw4w9WgX<Q'), false);
  assert.equal(m('\\d+', '2026'), true);
  assert.equal(m('\\d+', ''), false);
  assert.equal(m('a*', ''), true);
  assert.equal(m('[^/]+\\.png', 'cat.png'), true);
  assert.equal(m('[^/]+\\.png', 'a/cat.png'), false);
  assert.equal(m('ab?c{2,}', 'acc'), true);
  assert.equal(m('ab?c{2,}', 'abc'), false);
  assert.equal(m('ab?c{2,3}', 'abcccc'), false);
  assert.equal(m('.', '\n'), false);
  assert.equal(m('\\w\\s\\S', 'a b'), true);
  assert.equal(m('é+', 'éé'), true, 'whole characters, not halves');
});

test('agrees with JavaScript RegExp on a spread of inputs', () => {
  const pats = ['[a-z]{2,5}', 'x*y+z?', '[0-9a-f]{1,8}', '.\\..', '\\d{3}-\\d{4}', '[^aeiou]*'];
  const inputs = ['', 'abc', 'abcdef', 'xxyz', 'yyy', 'deadbeef', 'dead beef', 'a.b', '555-1234', 'rhythm', 'audio'];
  for (const p of pats) for (const s of inputs) assert.equal(m(p, s), new RegExp(`^(?:${p})$`, 'u').test(s), `${p} on ${JSON.stringify(s)}`);
});

test('the inputs that stall a backtracking RegExp take no time here', () => {
  // (a*)*b-style blow-ups need groups, which are refused; the worst allowed shapes stay linear.
  const t0 = performance.now();
  assert.equal(m('a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(2048)), false);
  assert.equal(m('[a-z]*[a-z]*[a-z]*x', 'q'.repeat(2048)), false);
  assert.ok(performance.now() - t0 < 1000, `took ${Math.round(performance.now() - t0)} ms`);
});

test('groups, alternation, anchors, backreferences, and bad counts are refused', () => {
  for (const p of ['(a)', 'a|b', '^a', 'a$', '\\1', '(?=a)', 'a**', 'a{3,1}', 'a{99999}', '[a', '[]', '\\', '\\b', '\\p{L}', 'a{2', '[a-\\d]', 'z-a'.replace('z-a', '[z-a]'), '']) {
    assert.throws(() => compilePattern(p), PatternError, p);
  }
  assert.throws(() => compilePattern('a'.repeat(33)), /at most 32 parts/);
});
