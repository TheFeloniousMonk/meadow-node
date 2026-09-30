// Connect Claude (SPEC §16.7.1) adds the entry only while Claude Desktop is
// closed: open, it writes back its own copy of the file and drops the entry
// (seen 2026-09-29).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { createHandlers } from '../src/app/handlers.ts';
import { add, bridgeEntry, claudeDesktopConfigPath, isDesktopRunning, status, unpackagedPath } from '../src/server/claude-desktop.ts';

test('Claude Code is not Claude Desktop', () => {
  const exe = (...parts: string[]) => parts.join('\\');
  assert.equal(isDesktopRunning(`${exe('C:', 'Users', 'ann', 'AppData', 'Local', 'AnthropicClaude', 'app-1.2.3', 'claude.exe')}\r\n`), true);
  assert.equal(isDesktopRunning(`${exe('C:', 'Users', 'ann', 'AppData', 'Roaming', 'Claude', 'claude-code', '2.1.284', 'claude.exe')}\r\n`), false);
  assert.equal(isDesktopRunning(`${exe('C:', 'Code', 'claude-code', 'claude.exe')}\r\n${exe('C:', 'Apps', 'AnthropicClaude', 'claude.exe')}\r\n`), true);
  assert.equal(isDesktopRunning(''), false);
});

test('the entry is added only while Claude Desktop is closed', async () => {
  const catalog = new Catalog({ fetchImpl: (async () => new Response(JSON.stringify({ services: [] }))) as unknown as typeof fetch });
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog });
  const { id } = s.core.createAgent('Chappy');
  s.connections.set(id, 'claude', 'Chappy');
  const config = join(mkdtempSync(join(tmpdir(), 'meadow-claude-')), 'claude_desktop_config.json');
  let running: boolean | null = true;
  const handle = createHandlers(s, {
    execPath: 'C:/Apps/Meadow/Meadow.exe', bridgeScript: 'C:/Data/Meadow/bridge/meadow-bridge.js', claudeConfigPath: config,
    claudeRunning: async () => running, copy: () => {}, openExternal: () => {}, saveFile: async () => null, openFile: async () => null, confirmMove: async () => false,
  });
  assert.deepEqual(await handle('claudeRunning', {}), { running: true });
  const refused: any = await handle('connectClaude', { agent: id });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Quit it/);
  running = false;
  assert.deepEqual(await handle('connectClaude', { agent: id }), { ok: true });
  assert.ok(JSON.parse(readFileSync(config, 'utf8')).mcpServers['meadow-chappy']);
  running = null; // cannot tell: the dialog advises, and adding goes ahead
  assert.deepEqual(await handle('connectClaude', { agent: id }), { ok: true });
  s.stop();
});

test('a packaged (MSIX) Claude Desktop on Windows gets the entry in its own copy of the file', () => {
  const home = join('C:', 'Users', 'ann');
  const env = { APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') };
  const classic = join(env.APPDATA, 'Claude', 'claude_desktop_config.json');
  assert.equal(claudeDesktopConfigPath('win32', env, home, () => []), classic);
  assert.equal(claudeDesktopConfigPath('win32', env, home, () => ['Microsoft.Photos_8wekyb3d8bbwe']), classic);
  const packaged = claudeDesktopConfigPath('win32', env, home, () => ['Microsoft.Photos_8wekyb3d8bbwe', 'Claude_pzs8sxrjxfjjc']);
  assert.equal(packaged, join(env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  assert.equal(unpackagedPath(packaged), classic);
  assert.equal(unpackagedPath(classic), null);
});

test('a first write into the packaged copy keeps the settings of the file Claude read until then', () => {
  const home = mkdtempSync(join(tmpdir(), 'meadow-msix-'));
  const classic = join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
  const packaged = join(home, 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
  mkdirSync(join(home, 'AppData', 'Roaming', 'Claude'), { recursive: true });
  writeFileSync(classic, JSON.stringify({ preferences: { theme: 'dark' }, mcpServers: { other: { command: 'x', args: [], env: {} } } }));
  const entry = bridgeEntry({ appExecutable: 'C:/Meadow/Meadow.exe', bridgeScript: 'C:/b.js', port: 47733, token: 'mdw_t' });
  assert.equal(status(packaged, 'meadow-ann', entry).installed, false);
  assert.deepEqual(add(packaged, 'meadow-ann', entry), { ok: true });
  const written = JSON.parse(readFileSync(packaged, 'utf8'));
  assert.deepEqual(written.preferences, { theme: 'dark' });
  assert.deepEqual(Object.keys(written.mcpServers).sort(), ['meadow-ann', 'other']);
  assert.equal(status(packaged, 'meadow-ann', entry).upToDate, true);
  // The real file is left as it was.
  assert.equal(JSON.parse(readFileSync(classic, 'utf8')).mcpServers['meadow-ann'], undefined);
});
