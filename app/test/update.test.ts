// The install kinds, launch paths, and update check (SPEC §16.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpdateCheck, compareVersions, installKind, latestRelease, launchPath } from '../src/core/update.ts';

const scoopExe = 'C:\\Users\\ann\\scoop\\apps\\meadow\\0.1.0\\Meadow.exe';

test('install kinds', () => {
  assert.equal(installKind(scoopExe, {}, true), 'scoop');
  assert.equal(installKind('/tmp/.mount_MeadowX/meadow', { APPIMAGE: '/home/ann/Meadow.AppImage' }, true), 'appimage');
  assert.equal(installKind('/opt/Meadow/meadow', {}, true), 'package');
  assert.equal(installKind(scoopExe, {}, false), 'dev');
});

test('launch paths survive updates', () => {
  assert.equal(launchPath(scoopExe, {}, 'scoop'), 'C:\\Users\\ann\\scoop\\apps\\meadow\\current\\Meadow.exe');
  assert.equal(launchPath('D:/scoop/apps/meadow/0.2.3/Meadow.exe', {}, 'scoop'), 'D:/scoop/apps/meadow/current/Meadow.exe');
  assert.equal(launchPath('/tmp/.mount_MeadowX/meadow', { APPIMAGE: '/home/ann/Meadow.AppImage' }, 'appimage'), '/home/ann/Meadow.AppImage');
  assert.equal(launchPath('/opt/Meadow/meadow', {}, 'package'), '/opt/Meadow/meadow');
});

test('versions compare numerically', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('0.1.0', 'banana') > 0);
});

const releases = [
  { tag_name: 'v0.9.0', html_url: 'https://github.com/TheFeloniousMonk/meadow-node/releases/tag/v0.9.0' }, // the node's
  { tag_name: 'app-v0.3.0', draft: true },
  { tag_name: 'app-v0.2.5', prerelease: true },
  { tag_name: 'app-v0.2.0', html_url: 'https://github.com/TheFeloniousMonk/meadow-node/releases/tag/app-v0.2.0' },
  { tag_name: 'app-v0.10.0', html_url: 'https://evil.example/' },
  { tag_name: 'app-vnope' },
];

test('only published app releases count', () => {
  // The node's tag, drafts, prereleases, and malformed tags are skipped; a foreign link is replaced.
  assert.deepEqual(latestRelease(releases), { version: '0.10.0', url: 'https://github.com/TheFeloniousMonk/meadow-node/releases/tag/app-v0.10.0' });
  assert.equal(latestRelease({ message: 'rate limited' }), null);
});

const fake = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

test('the check says what to do per install', async () => {
  const scoop = new UpdateCheck({ version: '0.2.0', kind: 'scoop', fetchImpl: fake(releases) });
  assert.deepEqual(await scoop.check(), { version: '0.10.0', url: 'https://github.com/TheFeloniousMonk/meadow-node/releases/tag/app-v0.10.0', command: 'scoop update meadow' });
  const mac = new UpdateCheck({ version: '0.2.0', kind: 'package', fetchImpl: fake(releases) });
  assert.equal((await mac.check())?.command, null);
  const current = new UpdateCheck({ version: '0.10.0', kind: 'scoop', fetchImpl: fake(releases) });
  assert.equal(await current.check(), null);
});

test('a failed check keeps the last answer', async () => {
  let body: unknown = releases;
  let ok = true;
  const u = new UpdateCheck({ version: '0.2.0', kind: 'scoop', fetchImpl: (async () => ({ ok, json: async () => body })) as unknown as typeof fetch });
  await u.check();
  ok = false;
  assert.equal((await u.check())?.version, '0.10.0');
  const offline = new UpdateCheck({ version: '0.2.0', kind: 'scoop', fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
  assert.equal(await offline.check(), null);
});
