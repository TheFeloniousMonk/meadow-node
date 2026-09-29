// Rewrites the Scoop manifest (bucket/meadow.json at the repository root) for
// a released version, with the zip's hash from SHA256SUMS (SPEC §16.3).
//   node scripts/release/update-bucket.mjs <version> <SHA256SUMS> <owner/repo> <manifest>
import { readFileSync, writeFileSync } from 'node:fs';

const [version, sumsPath, repo, path] = process.argv.slice(2);
if (!version || !sumsPath || !repo || !path) {
  console.error('usage: update-bucket.mjs <version> <SHA256SUMS> <owner/repo> <manifest>');
  process.exit(1);
}
const zip = `Meadow-${version}-win-x64.zip`;
const line = readFileSync(sumsPath, 'utf8').split(/\r?\n/).find((l) => l.trim().endsWith(`  ${zip}`));
if (!line) {
  console.error(`${zip} not found in ${sumsPath}`);
  process.exit(1);
}
const hash = line.trim().split(/\s+/)[0];
const manifest = JSON.parse(readFileSync(path, 'utf8'));
manifest.version = version;
manifest.architecture['64bit'].url = `https://github.com/${repo}/releases/download/app-v${version}/${zip}`;
manifest.architecture['64bit'].hash = hash;
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
console.log(`bucket updated to ${version} (${hash})`);
