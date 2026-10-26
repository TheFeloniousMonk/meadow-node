// The repository's plugins/ directory (SPEC §16.26.6): every plugin folder holds a valid plugin.json
// and the ready-to-install <folder>.zip made from it by scripts/pack-plugin.ts, and plugins/README.md
// lists it with its download link.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readZip } from '../src/core/plugins/zip.ts';
import { checkManifest } from '../src/core/plugins/manifest.ts';

const DIR = fileURLToPath(new URL('../../plugins/', import.meta.url));
const folders = readdirSync(DIR).filter((f) => statSync(join(DIR, f)).isDirectory());
const readme = readFileSync(join(DIR, 'README.md'), 'utf8');

test('the plugins directory has at least one plugin', () => assert.ok(folders.length > 0));

for (const folder of folders) {
  test(`plugins/${folder}: valid, its zip matches, and the README lists it`, () => {
    const json = JSON.parse(readFileSync(join(DIR, folder, 'plugin.json'), 'utf8'));
    const m = checkManifest(json);

    const zipPath = join(DIR, folder, `${folder}.zip`);
    assert.ok(existsSync(zipPath), `missing ${folder}.zip: run node scripts/pack-plugin.ts ../plugins/${folder}`);
    const files = readZip(readFileSync(zipPath));
    for (const name of files.keys()) assert.ok(name === 'plugin.json' || name === 'icon.png', `unexpected ${name} in the zip`);
    assert.deepEqual(JSON.parse(files.get('plugin.json')!.toString('utf8')), json, `${folder}.zip is out of date: pack it again`);
    const icon = join(DIR, folder, 'icon.png');
    assert.equal(files.has('icon.png'), existsSync(icon));
    if (existsSync(icon)) assert.ok(files.get('icon.png')!.equals(readFileSync(icon)), 'icon.png differs from the zip');

    assert.ok(readme.includes(`/plugins/${folder}/${folder}.zip`), `README.md has no download link for ${folder}`);
    assert.ok(readme.includes(m.name), `README.md does not name ${m.name}`);
    assert.ok(readme.includes(m.version), `README.md does not show version ${m.version}`);
  });
}
