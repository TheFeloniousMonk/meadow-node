// Safe mode (SPEC §16.26.7): when the window keeps failing, every plugin is off until the person turns
// them back on one at a time; the reason and the last error are kept, never message text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/core/db.ts';
import { writeZip } from '../src/core/plugins/zip.ts';
import { PluginStore } from '../src/core/plugins/store.ts';
import { FAILURE_WINDOW_MS, WindowHealth } from '../src/app/window-health.ts';

const MIN = 60_000;

test('two starts that never finish mean safe mode at the next start; a finished start clears the count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meadow-wh-'));
  let t = 1_000_000;
  const at = () => new WindowHealth({ dir, now: () => t });
  let h = at();
  assert.equal(h.start({ asked: false }).on, false);
  h.loading();
  h.ready();
  h.loading(); // never finishes
  h = at(); // the app was closed and opened again
  assert.equal(h.start({ asked: false }).on, false, 'one unfinished start is not enough');
  h.loading(); // never finishes again
  h = at();
  const s = h.start({ asked: false });
  assert.deepEqual([s.on, s.reason], [true, 'the window did not finish starting twice in a row']);
  // The count starts again: the next start after that is normal unless it fails again.
  h = at();
  assert.equal(h.start({ asked: false }).on, false);
});

test('two crashes within ten minutes switch safe mode on at once; spread out, they do not', () => {
  let t = 5_000_000;
  const h = new WindowHealth({ dir: null, now: () => t });
  h.start({ asked: false });
  assert.equal(h.failure('the window crashed (crashed)'), false);
  t += FAILURE_WINDOW_MS + MIN;
  assert.equal(h.failure('the window crashed (crashed)'), false, 'the first was too long ago');
  t += 2 * MIN;
  h.embedFailed('media.formula', 'Maximum call stack size exceeded');
  t += 1000;
  assert.equal(h.failure('the window stopped responding'), true);
  assert.equal(h.safe.on, true);
  assert.deepEqual(h.safe.last, { at: t, reason: 'the window stopped responding', type: 'media.formula' }, 'names the type that failed just before');
  assert.equal(h.failure('again'), false, 'already in safe mode');
});

test('--safe-mode asks for it; the last trouble is kept across starts for Troubleshoot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meadow-wh-'));
  const h = new WindowHealth({ dir });
  h.start({ asked: false });
  h.failure('the window crashed (oom)');
  const again = new WindowHealth({ dir });
  assert.deepEqual([again.start({ asked: true }).on, again.safe.reason], [true, 'you asked Meadow to start without plugins']);
  assert.equal(again.lastTrouble()!.reason, 'the window crashed (oom)');
  assert.ok(!readFileSync(join(dir, 'window-health.json'), 'utf8').includes('text'), 'no message text kept');
});

test('in safe mode no plugin is active until turned back on, one at a time; choices are kept', () => {
  const s = new PluginStore({ dir: mkdtempSync(join(tmpdir(), 'meadow-sm-')), db: openDb(':memory:') });
  const media = JSON.parse(readFileSync(new URL('../../plugins/rich-media-embeds/plugin.json', import.meta.url), 'utf8'));
  s.install(writeZip([{ name: 'plugin.json', data: JSON.stringify(media) }]));
  s.install(writeZip([{ name: 'plugin.json', data: JSON.stringify({ ...media, id: 'other', name: 'Other' }) }]));
  s.safeMode = true;
  assert.deepEqual(s.active(), []);
  s.safeAllow.add('other');
  assert.deepEqual(s.active().map((m) => m.id), ['other']);
  assert.deepEqual(s.list().map((p) => p.enabled), [true, true], 'what the person chose is unchanged');
});
