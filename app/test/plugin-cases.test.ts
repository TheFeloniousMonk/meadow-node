// Dry-run cases (SPEC §16.26.7): every example, and values at each schema's edges, all valid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkManifest, checkData } from '../src/core/plugins/manifest.ts';
import { dryRunCases } from '../src/core/plugins/cases.ts';

const MEDIA = checkManifest(JSON.parse(readFileSync(new URL('../../plugins/rich-media-embeds/plugin.json', import.meta.url), 'utf8')));

test('each type gets its example and edge cases, every one valid for its schema', () => {
  const cases = dryRunCases(MEDIA);
  for (const c of cases) assert.doesNotThrow(() => checkData(MEDIA.types[c.type.split('.')[1]].schema, c.data), c.label);
  const labels = (type: string) => cases.filter((c) => c.type === type).map((c) => c.label);
  assert.ok(labels('media.video').includes('its example'));
  assert.ok(labels('media.formula').includes('tex set to the longest allowed value (1000 characters)'));
  assert.ok(labels('media.formula').includes('tex set to unusual characters'));
  assert.deepEqual(labels('media.image').filter((l) => l.startsWith('ext set to')), ['ext set to "png"', 'ext set to "jpg"', 'ext set to "jpeg"', 'ext set to "gif"', 'ext set to "webp"']);
  const longTex = cases.find((c) => c.label === 'tex set to the longest allowed value (1000 characters)')!;
  assert.equal([...(longTex.data.tex as string)].length, 1000);
  // A fixed-form ID has no unusual characters to try, and its longest is its only length.
  assert.equal(cases.find((c) => c.type === 'media.video' && c.label.startsWith('id set to the longest'))!.data.id, 'aaaaaaaaaaa');
  assert.ok(!labels('media.video').includes('id set to unusual characters'));
});

test('numbers and booleans are tried at their edges', () => {
  const m = checkManifest({
    format: 'meadow-plugin/1', id: 'demo', name: 'Demo', version: '1.0.0', description: 'A demo.', hosts: [],
    types: { score: {
      description: 'A score.', example: { n: 3, big: true },
      schema: { type: 'object', additionalProperties: false, properties: { n: { type: 'integer', minimum: 0, maximum: 10 }, big: { type: 'boolean' } }, required: ['n'] },
      render: { component: 'code', code: '{n}' }, fallback: 'Score {n}',
    } },
  });
  const cs = dryRunCases(m).map((c) => [c.label, c.data]);
  assert.deepEqual(cs.find(([l]) => l === 'n set to its maximum')![1], { n: 10, big: true });
  assert.deepEqual(cs.find(([l]) => l === 'big set to false')![1], { n: 3, big: false });
  assert.deepEqual(cs.find(([l]) => l === 'only its required fields')![1], { n: 3 });
});
