// Plugins through the tools (SPEC §16.26.5): send with embeds, the plugins tool, and embeds in
// inbox, in a public room and in an encrypted DM. Through the app's real services, paying the mock
// portal in front of a node.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { writeZip } from '../src/core/plugins/zip.ts';
import { startMockPortal, type MockPortal } from './mock-portal.ts';

const MEDIA = writeZip([{ name: 'plugin.json', data: readFileSync(new URL('../examples/plugins/media/plugin.json', import.meta.url)) }]);

let portal: MockPortal;
before(async () => {
  portal = await startMockPortal();
});
after(() => portal.close());

async function computer(name: string, { withMedia }: { withMedia: boolean }) {
  const catalog = new Catalog({ url: portal.catalogUrl });
  await catalog.refresh();
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog, notify: () => {}, pluginsDir: mkdtempSync(join(tmpdir(), 'meadow-pl-')) });
  if (withMedia) s.plugins.install(MEDIA);
  const wallet = s.wallets.create('Test', '5.00').id;
  const { id } = s.core.createAgent(name);
  s.wallets.assign(id, wallet);
  s.connections.set(id, 'claude', name);
  await s.core.register(id);
  return { s, id, handle: s.core.agents().find((a) => a.id === id)!.handle };
}

test('the plugins tool lists the types in use, with examples and the data each takes', async () => {
  const A = await computer('alice', { withMedia: true });
  const list: any = (await A.s.tools.call(A.id, 'plugins', {})).data;
  assert.deepEqual(list.plugins.map((p: any) => p.id), ['media']);
  assert.deepEqual(list.plugins[0].types.map((t: any) => t.type), ['media.video', 'media.track', 'media.image', 'media.drive-image', 'media.drive-file', 'media.dropbox-image', 'media.formula']);
  assert.equal(list.plugins[0].types[0].data.properties.id.pattern, '[A-Za-z0-9_-]{11}');
  const B = await computer('bob', { withMedia: false });
  assert.match(((await B.s.tools.call(B.id, 'plugins', {})).data as any).note, /No plugins are installed/);
});

test('send with embeds: in a public room, read richly by an app with the plugin and plainly without it', async () => {
  const A = await computer('alice', { withMedia: true });
  const B = await computer('bob', { withMedia: true });
  const C = await computer('carol', { withMedia: false });
  const { result: room } = await A.s.core.createRoom(A.id, { type: 'public', name: 'Watch party' });
  await B.s.core.joinRoom(B.id, room);
  await C.s.core.joinRoom(C.id, room);
  await A.s.core.sync(A.id);

  const sent: any = (await A.s.tools.call(A.id, 'send', { room, text: 'Tonight:', embeds: [{ type: 'media.video', data: { id: 'M7lc1UVf-VE', title: 'The talk' } }, { type: 'media.formula', data: { tex: 'E=mc^2' } }] })).data;
  assert.equal(sent.sent, true);
  const raw = A.s.core.messages(A.id, { room }).at(-1)!.text!;
  assert.equal(raw, 'Tonight:\nVideo: https://youtu.be/M7lc1UVf-VE\nFormula: E=mc^2\n[meadow:embed media.video {"id":"M7lc1UVf-VE","title":"The talk"}]\n[meadow:embed media.formula {"tex":"E=mc^2"}]');

  await B.s.core.sync(B.id);
  const b: any = (await B.s.tools.call(B.id, 'inbox', { room })).data;
  const mb = b.rooms[0].messages[0];
  assert.equal(mb.text, 'Tonight:\nVideo: https://youtu.be/M7lc1UVf-VE\nFormula: E=mc^2', 'the block lines are removed');
  assert.deepEqual(mb.embeds, [
    { type: 'media.video', data: { id: 'M7lc1UVf-VE', title: 'The talk' }, shown: true },
    { type: 'media.formula', data: { tex: 'E=mc^2' }, shown: true },
  ]);

  await C.s.core.sync(C.id);
  const c: any = (await C.s.tools.call(C.id, 'inbox', { room })).data;
  const mc = c.rooms[0].messages[0];
  assert.equal(mc.text, mb.text, 'the fallback lines read the same');
  assert.deepEqual(mc.embeds.map((e: any) => e.shown), [false, false], 'given as data, not shown, without the plugin');
});

test('in an encrypted DM the block travels inside the ciphertext and reads the same', async () => {
  const A = await computer('alice', { withMedia: true });
  const B = await computer('bob', { withMedia: true });
  await A.s.core.resolveAgent(A.id, B.handle);
  const dm = await A.s.core.startDm(A.id, B.id);
  await B.s.core.sync(B.id);
  await B.s.core.joinRoom(B.id, dm.result ?? dm);
  await A.s.core.sync(A.id);
  const room = A.s.core.rooms(A.id).find((r) => r.type === 'dm')!.room;
  const sent: any = (await A.s.tools.call(A.id, 'send', { room, text: 'Listen', embeds: [{ type: 'media.track', data: { artist: 'an-artist', track: 'a-track' } }] })).data;
  assert.equal(sent.sent, true);
  await B.s.core.sync(B.id);
  const b: any = (await B.s.tools.call(B.id, 'inbox', { room })).data;
  const m = b.rooms[0].messages.at(-1);
  assert.equal(m.text, 'Listen\nListen: https://soundcloud.com/an-artist/a-track');
  assert.deepEqual(m.embeds, [{ type: 'media.track', data: { artist: 'an-artist', track: 'a-track' }, shown: true }]);
});

test('a bad or uninstalled embed is refused before anything is written or paid', async () => {
  const A = await computer('alice', { withMedia: true });
  const { result: room } = await A.s.core.createRoom(A.id, { type: 'public', name: 'Room' });
  await A.s.core.sync(A.id);
  const paid = () => A.s.wallets.paymentCount(A.s.wallets.walletOf(A.id)!);
  const before = paid();
  const count = () => A.s.core.messages(A.id, { room }).length;
  const n = count();

  const notInstalled: any = (await A.s.tools.call(A.id, 'send', { room, text: 'x', embeds: [{ type: 'maps.pin', data: {} }] })).data;
  assert.equal(notInstalled.refused_code, 'plugin_not_installed');
  const bad: any = (await A.s.tools.call(A.id, 'send', { room, text: 'x', embeds: [{ type: 'media.video', data: { id: 'not-an-id', onload: 'x' } }] })).data;
  assert.equal(bad.refused_code, 'bad_embed');
  assert.match(bad.refused, /media\.video: The data has a field the type does not take: onload\. Nothing was sent or charged\./);
  A.s.plugins.setEnabled('media', false);
  const off: any = (await A.s.tools.call(A.id, 'send', { room, text: 'x', embeds: [{ type: 'media.video', data: { id: 'M7lc1UVf-VE' } }] })).data;
  assert.equal(off.refused_code, 'plugin_not_installed');
  assert.equal(paid(), before, 'nothing paid');
  assert.equal(count(), n, 'nothing written');
});

test('a block an AI typed by hand is read the same: the receiver never trusts how it was made', async () => {
  const A = await computer('alice', { withMedia: false });
  const B = await computer('bob', { withMedia: true });
  const { result: room } = await A.s.core.createRoom(A.id, { type: 'public', name: 'Room' });
  await B.s.core.joinRoom(B.id, room);
  await A.s.core.sync(A.id);
  // Without the plugin, Alice's AI writes the block itself, once valid and once not.
  await A.s.tools.call(A.id, 'send', { room, text: 'Hand made\n[meadow:embed media.video {"id":"M7lc1UVf-VE"}]' });
  await A.s.tools.call(A.id, 'send', { room, text: 'Forged\n[meadow:embed media.video {"id":"<script>"}]' });
  await B.s.core.sync(B.id);
  const msgs: any[] = ((await B.s.tools.call(B.id, 'inbox', { room })).data as any).rooms[0].messages;
  assert.deepEqual(msgs.map((m) => m.embeds?.[0]?.shown), [true, false], 'valid data shows; data that fails the schema is never shown');
});
