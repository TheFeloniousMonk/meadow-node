// A small zip reader for plugins (SPEC §16.26.3), in-house so every rule is ours (user, 2026-10-26).
// It reads only the two plain methods, stored and deflate (Node's zlib inflates), and refuses
// anything that can carry a trick: 64-bit records, encryption, several disks, symlinks, paths that
// are absolute or climb out, backslashes, drive letters, duplicates, too many files or bytes, a
// file that inflates past its declared size, or a bad checksum. Also a writer, for tests and for
// packing a plugin.

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export const ZIP_LIMITS = { files: 64, bytes: 2 * 1024 * 1024, name: 128 };

export class ZipError extends Error {}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** A safe relative path: lowercase-insensitive unique, no climbing out, no Windows tricks. */
function safeName(name: string): string | null {
  if (!name || name.length > ZIP_LIMITS.name) return null;
  if (name.includes('\\') || name.includes(':') || name.startsWith('/')) return null;
  if (/[\x00-\x1f\x7f]/.test(name)) return null;
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || /[. ]$/.test(p))) return null;
  return name;
}

/** The files in a zip, by path; directories are skipped. Throws ZipError with the reason in plain words. */
export function readZip(buf: Buffer, limits = ZIP_LIMITS): Map<string, Buffer> {
  if (buf.length < 22) throw new ZipError('This is not a zip file.');
  // The end record is in the last 22 bytes plus its comment (at most 65,535).
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError('This is not a zip file.');
  const disk = buf.readUInt16LE(end + 4);
  const cdDisk = buf.readUInt16LE(end + 6);
  const onDisk = buf.readUInt16LE(end + 8);
  const total = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new ZipError('Zips split across several parts are not supported.');
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('Large-format (zip64) archives are not supported.');
  if (cdOffset + cdSize > end) throw new ZipError('The zip file is damaged.');

  const out = new Map<string, Buffer>();
  const seen = new Set<string>();
  let bytes = 0;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== CENTRAL) throw new ZipError('The zip file is damaged.');
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (p > end) throw new ZipError('The zip file is damaged.');
    // Names must be UTF-8 or plain ASCII; anything else is refused rather than guessed.
    const name = rawName.toString('utf8');
    if (Buffer.from(name, 'utf8').compare(rawName) !== 0) throw new ZipError('A file name in the zip is not valid text.');
    if (!safeName(name)) throw new ZipError(`The zip holds a file with a path that is not allowed: ${JSON.stringify(name.slice(0, 80))}.`);
    if (flags & 0x41) throw new ZipError('Encrypted zips are not supported.');
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new ZipError('Large-format (zip64) archives are not supported.');
    // A Unix symlink: file type bits in the high half of the external attributes.
    if (madeBy >> 8 === 3 && ((external >>> 16) & 0o170000) === 0o120000) throw new ZipError(`The zip holds a link (${name}); links are not allowed.`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipError(`The zip holds ${name} twice.`);
    seen.add(key);
    if (name.endsWith('/')) {
      if (usize !== 0) throw new ZipError('The zip file is damaged.');
      continue;
    }
    if (out.size + 1 > limits.files) throw new ZipError(`The zip holds more than ${limits.files} files.`);
    bytes += usize;
    if (bytes > limits.bytes) throw new ZipError(`The zip unpacks to more than ${Math.round(limits.bytes / 1024 / 1024)} MiB.`);
    if (method !== 0 && method !== 8) throw new ZipError(`${name} uses a compression method that is not supported.`);

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new ZipError('The zip file is damaged.');
    const lName = buf.subarray(local + 30, local + 30 + buf.readUInt16LE(local + 26));
    if (lName.compare(rawName) !== 0) throw new ZipError('The zip file is damaged.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > cdOffset) throw new ZipError('The zip file is damaged.');
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) {
      if (csize !== usize) throw new ZipError('The zip file is damaged.');
      data = Buffer.from(raw);
    } else {
      try {
        // Never inflate past the declared size: a "zip bomb" stops here.
        data = inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
      } catch {
        throw new ZipError(`${name} could not be unpacked, or unpacks larger than it says.`);
      }
      if (data.length !== usize) throw new ZipError('The zip file is damaged.');
    }
    if ((crc32(data) >>> 0) !== crc) throw new ZipError(`${name} fails its checksum: the zip is damaged.`);
    out.set(name, data);
  }
  return out;
}

/** A zip of the given files (deflated), for tests and for packing a plugin. */
export function writeZip(files: { name: string; data: Buffer | string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = deflateRawSync(data);
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(LOCAL, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(CENTRAL, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
