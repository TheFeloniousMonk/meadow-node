// Packs a plugin folder into a zip the app can install (SPEC §16.26.3), checking it first the way
// the app will. A plugin folder holds plugin.json and, optionally, icon.png. By default the zip is
// written into the folder itself, as <folder>.zip: the ready-to-install file the repository's
// plugins/ directory offers for download. plugin.json is packed with LF line endings, so the zip is
// the same whichever system builds it.
//
//   node scripts/pack-plugin.ts ../plugins/rich-media-embeds            (writes ../plugins/rich-media-embeds/rich-media-embeds.zip)
//   node scripts/pack-plugin.ts ../plugins/rich-media-embeds other.zip

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readZip, writeZip } from '../src/core/plugins/zip.ts';
import { checkManifest } from '../src/core/plugins/manifest.ts';

const [dir, outArg] = process.argv.slice(2);
if (!dir) {
  console.error('Usage: node scripts/pack-plugin.ts <plugin folder> [out.zip]');
  process.exit(2);
}
const out = outArg ?? join(dir, `${basename(resolve(dir))}.zip`);
const json = readFileSync(join(dir, 'plugin.json'), 'utf8').replace(/\r\n/g, '\n');
const manifest = checkManifest(JSON.parse(json));
const files: { name: string; data: Buffer | string }[] = [{ name: 'plugin.json', data: json }];
if (readdirSync(dir).includes('icon.png')) files.push({ name: 'icon.png', data: readFileSync(join(dir, 'icon.png')) });
const zip = writeZip(files);
readZip(zip); // the app's own reader must open it
writeFileSync(out, zip);
console.log(`${manifest.name} ${manifest.version} (${Object.keys(manifest.types).length} types) -> ${out}, ${zip.length} bytes`);
