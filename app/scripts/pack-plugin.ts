// Packs a plugin folder into a zip the app can install (SPEC §16.26.3), checking it first the way
// the app will. A plugin folder holds plugin.json and, optionally, icon.png.
//
//   node scripts/pack-plugin.ts examples/plugins/media media.zip

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readZip, writeZip } from '../src/core/plugins/zip.ts';
import { checkManifest } from '../src/core/plugins/manifest.ts';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
  console.error('Usage: node scripts/pack-plugin.ts <plugin folder> <out.zip>');
  process.exit(2);
}
const files = readdirSync(dir).filter((f) => f === 'plugin.json' || f === 'icon.png').map((name) => ({ name, data: readFileSync(join(dir, name)) }));
const manifest = checkManifest(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')));
const zip = writeZip(files);
readZip(zip); // the app's own reader must open it
writeFileSync(out, zip);
console.log(`${manifest.name} ${manifest.version} (${Object.keys(manifest.types).length} types) -> ${out}, ${zip.length} bytes`);
