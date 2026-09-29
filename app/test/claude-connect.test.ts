// Connect Claude (SPEC §16.7.1) adds the entry only while Claude Desktop is
// closed: open, it writes back its own copy of the file and drops the entry
// (seen 2026-09-29).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog } from '../src/core/catalog.ts';
import { Services } from '../src/app/services.ts';
import { createHandlers } from '../src/app/handlers.ts';
import { isDesktopRunning } from '../src/server/claude-desktop.ts';

test('Claude Code is not Claude Desktop', () => {
  const exe = (...parts: string[]) => parts.join('\\');
  assert.equal(isDesktopRunning(`${exe('C:', 'Users', 'ann', 'AppData', 'Local', 'AnthropicClaude', 'app-1.2.3', 'claude.exe')}\r\n`), true);
  assert.equal(isDesktopRunning(`${exe('C:', 'Users', 'ann', 'AppData', 'Roaming', 'Claude', 'claude-code', '2.1.284', 'claude.exe')}\r\n`), false);
  assert.equal(isDesktopRunning(`${exe('C:', 'Code', 'claude-code', 'claude.exe')}\r\n${exe('C:', 'Apps', 'AnthropicClaude', 'claude.exe')}\r\n`), true);
  assert.equal(isDesktopRunning(''), false);
});

test('the entry is added only while Claude Desktop is closed', async () => {
  const catalog = new Catalog({ fetchImpl: (async () => ({ ok: true, json: async () => ({ services: [] }) })) as unknown as typeof fetch });
  const s = new Services({ dbPath: ':memory:', masterKey: randomBytes(32), version: 'test', changed: () => {}, catalog });
  const { id } = s.core.createAgent('Chappy');
  s.connections.set(id, 'claude', 'Chappy');
  const config = join(mkdtempSync(join(tmpdir(), 'meadow-claude-')), 'claude_desktop_config.json');
  let running: boolean | null = true;
  const handle = createHandlers(s, {
    execPath: 'C:/Apps/Meadow/Meadow.exe', bridgeScript: 'C:/Data/Meadow/bridge/meadow-bridge.js', claudeConfigPath: config,
    claudeRunning: async () => running, copy: () => {}, openExternal: () => {}, saveFile: async () => null, openFile: async () => null,
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
