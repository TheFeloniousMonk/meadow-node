// Plugins for the window (SPEC §16.26.4): components with checked addresses, images fetched only
// from active plugins' hosts and only if they are really images, links only to those hosts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/core/db.ts';
import { writeZip } from '../src/core/plugins/zip.ts';
import { PluginStore } from '../src/core/plugins/store.ts';
import { fetchEmbedImage, messageEmbeds, onActiveHost, pluginsView } from '../src/app/plugin-views.ts';

function store() {
  const s = new PluginStore({ dir: mkdtempSync(join(tmpdir(), 'meadow-pv-')), db: openDb(':memory:') });
  s.install(writeZip([{ name: 'plugin.json', data: readFileSync(new URL('../../plugins/rich-media-embeds/plugin.json', import.meta.url)) }]));
  return s;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const fake = (body: Buffer, status = 200) => {
  const calls: { url: string; init: any }[] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { f, calls };
};

test('messages: components with final addresses, the block removed; uninstalled or bad data says so', () => {
  const s = store();
  const text = 'Hi\nVideo: https://youtu.be/M7lc1UVf-VE\n[meadow:embed media.video {"id":"M7lc1UVf-VE"}]\n[meadow:embed media.image {"id":"x","ext":"png","alt":"a"}]\n[meadow:embed maps.pin {"lat":1}]';
  const v = messageEmbeds(s, text);
  assert.equal(v.text, 'Hi\nVideo: https://youtu.be/M7lc1UVf-VE');
  assert.deepEqual(v.embeds![0], { type: 'media.video', shown: true, plugin: 'Rich Media Embeds', component: 'video', fields: { src: 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE' }, host: 'www.youtube-nocookie.com' });
  assert.equal(v.embeds![1].shown, false);
  assert.equal((v.embeds![1] as any).why, 'bad_data');
  assert.equal((v.embeds![2] as any).why, 'not_installed');
  assert.equal((v.embeds![2] as any).line, '[meadow:embed maps.pin {"lat":1}]');
  assert.deepEqual(messageEmbeds(s, 'no block here'), { text: 'no block here' });
  s.setEnabled('media', false);
  assert.equal((messageEmbeds(s, text).embeds![0] as any).why, 'not_installed', 'off: shown as not installed');
});

test('the plugin list for the window', () => {
  const v = pluginsView(store());
  assert.equal(v[0].name, 'Rich Media Embeds');
  assert.deepEqual(v[0].types.map((t) => t.component), ['video', 'audio', 'image', 'image', 'video', 'image', 'math']);
  assert.deepEqual(v[0].hosts, ['www.youtube-nocookie.com', 'w.soundcloud.com', 'i.imgur.com', 'lh3.googleusercontent.com', 'drive.google.com', 'dl.dropboxusercontent.com']);
});

test('only https addresses on an active plugin\'s hosts are allowed', () => {
  const s = store();
  assert.ok(onActiveHost(s, 'https://i.imgur.com/abc.png'));
  assert.equal(onActiveHost(s, 'http://i.imgur.com/abc.png'), null);
  assert.equal(onActiveHost(s, 'https://evil.example.com/abc.png'), null);
  assert.equal(onActiveHost(s, 'https://user:pw@i.imgur.com/abc.png'), null);
  assert.equal(onActiveHost(s, 'https://i.imgur.com:8443/abc.png'), null);
  assert.equal(onActiveHost(s, 'not a url'), null);
  s.setEnabled('media', false);
  assert.equal(onActiveHost(s, 'https://i.imgur.com/abc.png'), null, 'a plugin that is off allows nothing');
});

test('images: fetched only from declared hosts, without cookies, referrer, or redirects, and only real images under 5 MiB', async () => {
  const s = store();
  const ok = fake(PNG);
  const r = await fetchEmbedImage(s, 'https://i.imgur.com/abcde.png', ok.f);
  assert.ok('data' in r && r.data.startsWith('data:image/png;base64,'));
  assert.equal(ok.calls[0].init.redirect, 'manual', 'a redirect is answered, never followed');
  assert.equal(ok.calls[0].init.referrerPolicy, 'no-referrer');
  assert.equal(ok.calls[0].init.credentials, 'omit');

  const elsewhere = fake(PNG);
  assert.match(((await fetchEmbedImage(s, 'https://evil.example.com/x.png', elsewhere.f)) as any).error, /not from a site/);
  assert.equal(elsewhere.calls.length, 0, 'never even asked');

  const svg = await fetchEmbedImage(s, 'https://i.imgur.com/abcde.png', fake(Buffer.from('<svg onload="alert(1)"/>')).f);
  assert.match((svg as any).error, /not a PNG, JPEG, GIF, or WebP/);
  const html = await fetchEmbedImage(s, 'https://i.imgur.com/abcde.png', fake(Buffer.from('<!doctype html><script>x</script>')).f);
  assert.match((html as any).error, /not a PNG/);
  const big = await fetchEmbedImage(s, 'https://i.imgur.com/abcde.png', fake(Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)])).f);
  assert.match((big as any).error, /larger than 5 MiB/);
  // Imgur sends a missing image's request to its "removed" picture: not followed, and said plainly.
  const moved = await fetchEmbedImage(s, 'https://i.imgur.com/abcde.png', fake(Buffer.alloc(0), 302).f);
  assert.match((moved as any).error, /pointed somewhere else instead of sending the image/);
  const missing = await fetchEmbedImage(s, 'https://i.imgur.com/abcde.png', fake(Buffer.alloc(0), 404).f);
  assert.match((missing as any).error, /answered 404/);
});
