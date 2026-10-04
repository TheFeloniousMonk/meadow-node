// The install kinds, launch paths, and update check (SPEC §16.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpdateCheck, assetFor, compareVersions, downloadRelease, installKind, latestRelease, launchPath, scoopUpdateScript } from '../src/core/update.ts';

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

const fake = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

test('the check says what to do per install', async () => {
  const scoop = new UpdateCheck({ version: '0.2.0', kind: 'scoop', fetchImpl: fake(releases) });
  assert.deepEqual(await scoop.check(), { version: '0.10.0', url: 'https://github.com/TheFeloniousMonk/meadow-node/releases/tag/app-v0.10.0', command: 'scoop update; scoop update meadow', action: 'scoop', asset: null });
  const mac = new UpdateCheck({ version: '0.2.0', kind: 'package', fetchImpl: fake(releases) });
  assert.equal((await mac.check())?.command, null);
  const current = new UpdateCheck({ version: '0.10.0', kind: 'scoop', fetchImpl: fake(releases) });
  assert.equal(await current.check(), null);
});

test('a failed check keeps the last answer', async () => {
  let body: unknown = releases;
  let ok = true;
  const u = new UpdateCheck({ version: '0.2.0', kind: 'scoop', fetchImpl: (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch });
  await u.check();
  ok = false;
  assert.equal((await u.check())?.version, '0.10.0');
  const offline = new UpdateCheck({ version: '0.2.0', kind: 'scoop', fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
  assert.equal(await offline.check(), null);
});

test('links the window may open are matched exactly (security review F10)', async () => {
  const { linkAllowed } = await import('../src/shared/api.ts');
  for (const ok of ['https://meadowprotocol.com', 'https://meadowprotocol.com/support', 'https://github.com/TheFeloniousMonk/meadow-node/releases/tag/app-v0.1.0', 'https://chatgpt.com/']) assert.ok(linkAllowed(ok), ok);
  for (const bad of ['https://meadowprotocol.com.evil.example', 'https://meadowprotocol.com@evil.example/', 'https://github.com/TheFeloniousMonk/meadow-node-evil', 'http://meadowprotocol.com', 'https://meadowprotocol.com:8443/', 'file:///C:/x', 'nope']) assert.ok(!linkAllowed(bad), bad);
});

test('Update now picks the right file per computer, and none where Scoop or a dev copy updates', () => {
  assert.equal(assetFor('darwin', 'arm64', 'package'), 'Meadow-mac-arm64.zip');
  assert.equal(assetFor('darwin', 'x64', 'package'), 'Meadow-mac-x64.zip');
  assert.equal(assetFor('linux', 'x64', 'package'), 'meadow_amd64.deb');
  assert.equal(assetFor('linux', 'x64', 'appimage'), 'Meadow-linux-x86_64.AppImage');
  assert.equal(assetFor('win32', 'x64', 'scoop'), null);
  assert.equal(assetFor('darwin', 'arm64', 'dev'), null);
  const mac = new UpdateCheck({ version: '0.1.0', kind: 'package', platform: 'darwin', arch: 'arm64', fetchImpl: fake(releases) });
  return mac.check().then((u) => assert.deepEqual([u?.action, u?.asset], ['download', 'Meadow-mac-arm64.zip']));
});

test('a download is kept only if it matches SHA256SUMS', async () => {
  const { createHash } = await import('node:crypto');
  const { existsSync, mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const good = Buffer.from('the new app');
  const sums = `${createHash('sha256').update(good).digest('hex')}  Meadow-mac-arm64.zip\n`;
  const serve = (file: Buffer) => (async (url: string) => (url.endsWith('SHA256SUMS')
    ? new Response(sums)
    : new Response(file))) as unknown as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), 'meadow-update-'));
  const file = await downloadRelease({ version: '0.1.1', name: 'Meadow-mac-arm64.zip', dir, fetchImpl: serve(good) });
  assert.deepEqual(readFileSync(file), good);
  const dir2 = mkdtempSync(join(tmpdir(), 'meadow-update-'));
  await assert.rejects(downloadRelease({ version: '0.1.1', name: 'Meadow-mac-arm64.zip', dir: dir2, fetchImpl: serve(Buffer.from('tampered')) }), /does not match its checksum/);
  assert.equal(existsSync(join(dir2, 'Meadow-mac-arm64.zip')), false);
  await assert.rejects(downloadRelease({ version: '0.1.1', name: 'Meadow-mac-x64.zip', dir: dir2, fetchImpl: serve(good) }), /no checksum for/);
});

test('the Scoop update script waits for Meadow to quit, updates, and opens it again', () => {
  const s = scoopUpdateScript('C:\Users\ann\scoop\apps\meadow\current\Meadow.exe');
  const lines = s.split('\r\n');
  assert.ok(lines.indexOf('timeout /t 3 /nobreak >nul') < lines.indexOf('call scoop update meadow'));
  // Buckets first, or Scoop may call the installed version the latest.
  assert.ok(lines.includes('call scoop update') && lines.indexOf('call scoop update') < lines.indexOf('call scoop update meadow'));
  assert.ok(lines.includes('start "" "C:\Users\ann\scoop\apps\meadow\current\Meadow.exe"'));
  assert.ok(lines.includes('pause >nul') && lines.includes('echo Press any key to close this window.'), 'a failure stays on screen and says how to close it');
  // Never from Meadow's folder: PowerShell cannot remove its own working folder (2026-10-04).
  assert.ok(lines.includes('cd /d "%TEMP%"') && lines.indexOf('cd /d "%TEMP%"') < lines.indexOf('call scoop update'));
});
