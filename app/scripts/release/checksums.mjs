// Writes <dir>/SHA256SUMS for every release file in <dir> (SPEC §16.3).
//   node scripts/release/checksums.mjs <dir>
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'release';
const files = readdirSync(dir).filter((f) => /\.(zip|deb|AppImage)$/.test(f)).sort();
if (!files.length) {
  console.error(`no release files in ${dir}`);
  process.exit(1);
}
const lines = files.map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}`);
writeFileSync(join(dir, 'SHA256SUMS'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
