// Plugins, the core (SPEC §16.26): plugin.json checks, the message block, and the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/core/db.ts';
import { writeZip } from '../src/core/plugins/zip.ts';
import { checkData, checkManifest, fallbackText, PluginError, renderEmbed } from '../src/core/plugins/manifest.ts';
import { readBlock, writeBlock } from '../src/core/plugins/block.ts';
import { PluginNotInstalled, PluginStore } from '../src/core/plugins/store.ts';

const MEDIA = JSON.parse(readFileSync(new URL('../examples/plugins/media/plugin.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(MEDIA);
const zipOf = (manifest: unknown, extra: { name: string; data: string | Buffer }[] = []) => writeZip([{ name: 'plugin.json', data: JSON.stringify(manifest) }, ...extra]);
const refused = (m: unknown, why: RegExp) => assert.throws(() => checkManifest(m), (e: any) => e instanceof PluginError && why.test(e.message));

test('the sample Media plugin passes; every type fills its component from its example', () => {
  const m = checkManifest(clone());
  const v = renderEmbed(m.types.video, m.types.video.example);
  assert.deepEqual(v, { component: 'video', fields: { src: 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE', title: 'A video' } });
  assert.equal(renderEmbed(m.types.track, m.types.track.example).fields.src, 'https://w.soundcloud.com/player/?url=https%3A//soundcloud.com/an-artist/a-track');
  assert.equal(renderEmbed(m.types.formula, m.types.formula.example).fields.display, true);
  assert.equal(fallbackText(m.types.image, m.types.image.example), 'Image (A picture): https://i.imgur.com/abc1234.png');
});

test('plugin.json: unknown fields, bad ids, hosts, schemas, components, and templates are refused', () => {
  refused({ ...clone(), extra: 1 }, /field this app does not know: extra/);
  refused({ ...clone(), format: 'other' }, /format/);
  refused({ ...clone(), id: 'Media' }, /id must be/);
  refused({ ...clone(), hosts: ['https://www.youtube-nocookie.com'] }, /hosts must be/);
  const noHost = clone();
  noHost.hosts = ['w.soundcloud.com', 'i.imgur.com'];
  refused(noHost, /youtube-nocookie\.com, which is not in the plugin's hosts/);
  const http = clone();
  http.types.video.render.src = 'http://www.youtube-nocookie.com/embed/{id}';
  refused(http, /must start with https/);
  const inHost = clone();
  inHost.types.video.render.src = 'https://{id}.youtube-nocookie.com/embed';
  refused(inHost, /must start with https:\/\/ and a host/);
  const unknownField = clone();
  unknownField.types.video.render.src = 'https://www.youtube-nocookie.com/embed/{secret}';
  refused(unknownField, /\{secret\}, which the schema does not have/);
  const comp = clone();
  comp.types.video.render.component = 'html';
  refused(comp, /must name a component/);
  const script = clone();
  script.types.video.render.onload = 'alert(1)';
  refused(script, /field this app does not know: onload/);
  const noPattern = clone();
  delete noPattern.types.video.schema.properties.id.pattern;
  refused(noPattern, /exactly one of pattern or enum/);
  const groups = clone();
  groups.types.video.schema.properties.id.pattern = '(a+)+b';
  refused(groups, /no groups/);
  const badExample = clone();
  badExample.types.video.example = { id: 'short' };
  refused(badExample, /example does not fit its schema/);
});

test('data is checked: extra fields, missing fields, forms, lengths, and enums', () => {
  const m = checkManifest(clone());
  const s = m.types.image.schema;
  assert.deepEqual(checkData(s, { id: 'abcde', ext: 'gif', alt: 'x' }), { id: 'abcde', ext: 'gif', alt: 'x' });
  assert.throws(() => checkData(s, { id: 'abcde', ext: 'gif', alt: 'x', onerror: 'y' }), /does not take: onerror/);
  assert.throws(() => checkData(s, { id: 'abcde', ext: 'gif' }), /missing alt/);
  assert.throws(() => checkData(s, { id: 'abc/../e', ext: 'gif', alt: 'x' }), /not in the form/);
  assert.throws(() => checkData(s, { id: 'abcde', ext: 'svg', alt: 'x' }), /one of/);
  assert.throws(() => checkData(s, { id: 'abcde', ext: 'gif', alt: 'x'.repeat(301) }), /longer than 300/);
  assert.throws(() => checkData(s, ['not', 'an', 'object']), /must be an object/);
});

test('the block: written after the text and fallbacks, read back exactly; anything else is plain text', () => {
  const text = writeBlock('Look at this', [
    { type: 'media.video', data: { id: 'M7lc1UVf-VE' }, fallback: 'Video: https://youtu.be/M7lc1UVf-VE' },
    { type: 'media.formula', data: { tex: 'a^2+b^2=c^2' }, fallback: 'Formula: a^2+b^2=c^2' },
  ]);
  assert.equal(text, 'Look at this\nVideo: https://youtu.be/M7lc1UVf-VE\nFormula: a^2+b^2=c^2\n[meadow:embed media.video {"id":"M7lc1UVf-VE"}]\n[meadow:embed media.formula {"tex":"a^2+b^2=c^2"}]');
  const r = readBlock(text);
  assert.equal(r.text, 'Look at this\nVideo: https://youtu.be/M7lc1UVf-VE\nFormula: a^2+b^2=c^2');
  assert.deepEqual(r.embeds.map((e) => [e.type, e.data]), [['media.video', { id: 'M7lc1UVf-VE' }], ['media.formula', { tex: 'a^2+b^2=c^2' }]]);

  const none = (t: string) => assert.deepEqual(readBlock(t), { text: t, embeds: [] }, t);
  none('[meadow:embed media.video {"id":"x"}] and then more text');
  none('Hi\n[meadow:embed media.video {"id":"x"}]\nmore text after');
  none('Hi\n[meadow:embed Media.video {"id":"x"}]');
  none('Hi\n[meadow:embed media.video ["x"]]');
  none('Hi\n[meadow:embed media.video {"id":}]');
  none('Hi\n[meadow:embed media.video {"id":"x"}] ');
  none(`Hi\n${Array.from({ length: 5 }, () => '[meadow:embed media.video {"id":"x"}]').join('\n')}`);
  none(`Hi\n[meadow:embed media.video {"id":"${'x'.repeat(2100)}"}]`);
  // A matching line in the middle of the text is never read.
  const mid = 'a\n[meadow:embed media.video {"id":"x"}]\nb';
  assert.deepEqual(readBlock(mid).embeds, []);
  // Windows line breaks read the same.
  assert.equal(readBlock('Hi\r\n[meadow:embed media.video {"id":"x"}]').embeds.length, 1);
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'meadow-plugins-'));
  const db = openDb(':memory:');
  return { dir, db, s: new PluginStore({ dir, db }) };
}

test('the store: preview keeps nothing; install, on/off, remove; types in use; send preparation', () => {
  const { dir, db, s } = store();
  const p = s.preview(zipOf(clone()));
  assert.equal(p.manifest.name, 'Media');
  assert.equal(existsSync(join(dir, 'media')), false, 'a preview writes nothing');

  s.install(zipOf(clone()));
  assert.deepEqual(s.active().map((m) => m.id), ['media']);
  const ready = s.prepare({ type: 'media.video', data: { id: 'M7lc1UVf-VE' } });
  assert.equal(ready.fallback, 'Video: https://youtu.be/M7lc1UVf-VE');
  assert.throws(() => s.prepare({ type: 'other.video', data: {} }), PluginNotInstalled);
  assert.throws(() => s.prepare({ type: 'media.video', data: { id: 'nope' } }), /not in the form/);
  assert.equal(s.shows({ type: 'media.video', plugin: 'media', name: 'video', data: { id: 'M7lc1UVf-VE' } }), true);
  assert.equal(s.shows({ type: 'media.video', plugin: 'media', name: 'video', data: { id: 'bad' } }), false);
  assert.equal(s.type('media.constructor'), null, 'only the plugin\'s own types');

  s.setEnabled('media', false);
  assert.deepEqual(s.active(), []);
  // On/off survives a restart.
  const again = new PluginStore({ dir, db });
  again.load();
  assert.equal(again.list()[0].enabled, false);
  again.setEnabled('media', true);
  again.safeMode = true;
  assert.deepEqual(again.active(), [], 'safe mode: none in use, the choice kept');
  assert.equal(again.list()[0].enabled, true);

  again.remove('media');
  assert.equal(existsSync(join(dir, 'media')), false);
  assert.deepEqual(again.list(), []);
});

test('a zip with anything but plugin.json and a small PNG icon is refused; a newer version replaces', () => {
  const { s } = store();
  assert.throws(() => s.preview(zipOf(clone(), [{ name: 'run.js', data: 'alert(1)' }])), /only plugin.json and icon.png; this one also has run.js/);
  assert.throws(() => s.preview(zipOf(clone(), [{ name: 'icon.png', data: '<svg/>' }])), /PNG image/);
  assert.throws(() => s.preview(writeZip([{ name: 'media/plugin.json', data: JSON.stringify(clone()) }])), /only plugin.json/);
  s.install(zipOf(clone()));
  const v2 = clone();
  v2.version = '1.1.0';
  assert.equal(s.preview(zipOf(v2)).replaces, '1.0.0');
  s.install(zipOf(v2));
  assert.equal(s.list()[0].manifest.version, '1.1.0');
  assert.equal(s.list().length, 1);
});

test('at startup, a plugin edited on disk or out of place is switched off, with the reason', () => {
  const { dir, db, s } = store();
  s.install(zipOf(clone()));
  writeFileSync(join(dir, 'media', 'plugin.json'), JSON.stringify({ ...clone(), hosts: ['evil.example.com'] }));
  mkdirSync(join(dir, 'stray'));
  writeFileSync(join(dir, 'stray', 'plugin.json'), JSON.stringify(clone()));
  const again = new PluginStore({ dir, db });
  again.load();
  const media = again.list().find((p) => p.manifest.id === 'media')!;
  assert.equal(media.enabled, false);
  assert.match(media.error!, /failed its check when Meadow started: .*not in the plugin's hosts/);
  const stray = again.list().find((p) => p.manifest.id === 'stray')!;
  assert.match(stray.error!, /folder is stray, but plugin.json says media/);
  assert.deepEqual(again.active(), []);
  assert.throws(() => again.setEnabled('media', true), /install it again/);
});
