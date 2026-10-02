// Writes a release's notes from its section of app/CHANGELOG.md, so the
// release page says what changed.
//   node scripts/release/release-notes.mjs <version> <out file> <owner/repo>
import { readFileSync, writeFileSync } from 'node:fs';

const [version, out, repo] = process.argv.slice(2);
if (!version || !out || !repo) {
  console.error('usage: release-notes.mjs <version> <out file> <owner/repo>');
  process.exit(1);
}
const lines = readFileSync('CHANGELOG.md', 'utf8').replace(/\r/g, '').split('\n');
const start = lines.findIndex((l) => /^## \[?/.test(l) && l.replace(/^## \[?([^\]\s]+).*$/, '$1') === version);
let section = '';
if (start >= 0) {
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  section = (end >= 0 ? rest.slice(0, end) : rest).join('\n').trim();
}
if (!section) console.log(`::warning::app/CHANGELOG.md has no "## ${version}" section`);
const install = [
  '## Install',
  '',
  '- **Windows:** through Scoop only (the zip below is what Scoop installs): see the README. To update by hand: `scoop update`, then `scoop update meadow` (or press Update now in the app).',
  '- **macOS:** the zip for your Mac (arm64 for Apple silicon, x64 for Intel), then System Settings, Privacy & Security, Open Anyway.',
  '- **Linux:** the .deb (Ubuntu and Debian), or the AppImage (needs libfuse2).',
  '',
  'Check a download against `SHA256SUMS`.',
].join('\n');
writeFileSync(out, `${section || 'No notes were written for this version.'}\n\n${install}\n\nEvery change: https://github.com/${repo}/blob/app-v${version}/app/CHANGELOG.md\n`);
console.log(`release notes for ${version}: ${section ? section.split('\n').length : 0} lines`);
