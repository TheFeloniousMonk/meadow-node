// The plugin zip reader (SPEC §16.26.3): plain zips open; every trick a zip can carry is refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readZip, writeZip, ZipError } from '../src/core/plugins/zip.ts';

const CENTRAL = 0x02014b50;

/** Offsets of each central directory record in a zip from writeZip. */
function centrals(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === CENTRAL) out.push(i);
  return out;
}

const refused = (buf: Buffer, why: RegExp) => assert.throws(() => readZip(buf), (e: any) => e instanceof ZipError && why.test(e.message));

test('a plain zip opens: files by path, directories skipped, contents exact', () => {
  const z = writeZip([{ name: 'plugin.json', data: '{"a":1}' }, { name: 'img/icon.png', data: Buffer.from([1, 2, 3]) }]);
  const files = readZip(z);
  assert.deepEqual([...files.keys()], ['plugin.json', 'img/icon.png']);
  assert.equal(files.get('plugin.json')!.toString(), '{"a":1}');
  assert.deepEqual([...files.get('img/icon.png')!], [1, 2, 3]);
});

test('paths that climb out, are absolute, use backslashes or drive letters, or repeat, are refused', () => {
  for (const name of ['../evil.json', 'a/../../evil', '/etc/passwd', 'a\\b.json', 'C:/x.json', 'a/./b', 'trailing. ']) {
    refused(writeZip([{ name, data: 'x' }]), /path that is not allowed/);
  }
  refused(writeZip([{ name: 'Plugin.json', data: 'x' }, { name: 'plugin.json', data: 'y' }]), /twice/);
});

test('symlinks and encryption are refused', () => {
  const link = writeZip([{ name: 'plugin.json', data: '/etc/passwd' }]);
  const c = centrals(link)[0];
  link.writeUInt16LE((3 << 8) | 20, c + 4); // made by Unix
  link.writeUInt32LE(((0o120777 << 16) >>> 0), c + 38); // a symlink
  refused(link, /link/);

  const enc = writeZip([{ name: 'plugin.json', data: 'x' }]);
  enc.writeUInt16LE(0x0801, centrals(enc)[0] + 8);
  refused(enc, /Encrypted/);
});

test('too many files, or too many bytes, are refused', () => {
  refused(writeZip(Array.from({ length: 65 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }))), /more than 64 files/);
  refused(writeZip([{ name: 'big.bin', data: Buffer.alloc(3 * 1024 * 1024) }]), /more than 2 MiB/);
});

test('a zip bomb stops at its declared size; a wrong checksum or damage is refused', () => {
  // Declares 10 bytes, inflates to a megabyte.
  const bomb = writeZip([{ name: 'plugin.json', data: Buffer.alloc(10) }]);
  const huge = deflateRawSync(Buffer.alloc(1024 * 1024));
  const c = centrals(bomb)[0];
  const at = 30 + 'plugin.json'.length;
  const rebuilt = Buffer.concat([bomb.subarray(0, at), huge, bomb.subarray(at + bomb.readUInt32LE(c + 20))]);
  const c2 = centrals(rebuilt)[0];
  rebuilt.writeUInt32LE(huge.length, c2 + 20);
  rebuilt.writeUInt32LE(rebuilt.readUInt32LE(rebuilt.length - 6) + huge.length - bomb.readUInt32LE(c + 20), rebuilt.length - 6);
  refused(rebuilt, /larger than it says/);

  const bad = writeZip([{ name: 'plugin.json', data: 'hello' }]);
  bad.writeUInt32LE(0xdeadbeef, centrals(bad)[0] + 16);
  refused(bad, /checksum/);

  refused(Buffer.from('not a zip at all, just some text that is long enough'), /not a zip/);
  const cut = writeZip([{ name: 'plugin.json', data: 'hello' }]);
  refused(cut.subarray(10), /damaged|not a zip/);
});

test('zip64 markers and unknown compression are refused', () => {
  const z64 = writeZip([{ name: 'plugin.json', data: 'x' }]);
  z64.writeUInt32LE(0xffffffff, centrals(z64)[0] + 24);
  refused(z64, /zip64/);
  const bz = writeZip([{ name: 'plugin.json', data: 'x' }]);
  bz.writeUInt16LE(12, centrals(bz)[0] + 10); // bzip2
  refused(bz, /compression method/);
});
