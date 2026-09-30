// Connect Claude (SPEC §16.7.1): writes one agent's bridge entry into Claude
// Desktop's configuration file, or removes it. The file is Claude Desktop's:
// read it whole, change only this agent's entry under mcpServers, write it
// back in one atomic step, and never touch a file that does not parse. The
// window shows the change and asks before calling add().
//
// Claude Desktop keeps its own settings in the same file, and while it runs it
// writes back the copy it loaded at startup, dropping an entry added meanwhile
// (seen 2026-09-29). So the entry is added only while Claude Desktop is closed.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface BridgeEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Whether Claude Desktop is running: true, false, or null when this computer
 * cannot tell. Claude Code's own claude.exe (under a claude-code folder) is not
 * Claude Desktop and does not count.
 */
export const isDesktopRunning = (executablePaths: string) =>
  executablePaths.split(/\r?\n/).some((p) => p.trim() !== '' && !/[\\/]claude-code[\\/]/i.test(p));

export function claudeDesktopRunning(platform = process.platform): Promise<boolean | null> {
  const run = (cmd: string, args: string[]) => new Promise<string | null>((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err && !stdout ? ((err as any).code === 1 ? '' : null) : String(stdout)));
  });
  if (platform === 'win32') {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { $_.ExecutablePath }"])
      .then((out) => (out === null ? null : isDesktopRunning(out)));
  }
  if (platform === 'darwin') return run('pgrep', ['-f', 'Claude.app/Contents/MacOS/Claude']).then((out) => (out === null ? null : out.trim().length > 0));
  return Promise.resolve(null); // no official Claude Desktop on Linux; the dialog advises quitting it
}

/**
 * Where Claude Desktop reads claude_desktop_config.json on this platform.
 *
 * On Windows, Claude Desktop installed as a packaged (MSIX) app has its
 * %APPDATA% redirected into its package folder,
 * %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming. Once that private
 * copy of the file exists (Claude writes its own settings there), Claude reads
 * only it, and the file under %APPDATA%\Claude is ignored without a word,
 * although Claude's own Edit Config button still opens that one (seen by a
 * tester, 2026-09-29; anthropics/claude-code#26073). So when the package is
 * installed, the entry goes into the package's copy.
 */
export function claudeDesktopConfigPath(platform = process.platform, env = process.env, home = homedir(), list = listDir): string {
  if (platform === 'win32') {
    const packages = join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Packages');
    const pkg = list(packages).filter((n) => /^Claude_[a-z0-9]+$/i.test(n)).sort()[0];
    if (pkg) return join(packages, pkg, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

/** The entry's name in Claude Desktop, from the agent's network name: its tools show under it. */
export const entryName = (networkName: string) => `meadow-${networkName}`;

/**
 * The entry: the app's own executable runs the bridge as Node
 * (ELECTRON_RUN_AS_NODE), so the person installs nothing else.
 */
export function bridgeEntry({ appExecutable, bridgeScript, port, token }: { appExecutable: string; bridgeScript: string; port: number; token: string }): BridgeEntry {
  return {
    command: appExecutable,
    args: [bridgeScript],
    env: { ELECTRON_RUN_AS_NODE: '1', MEADOW_URL: `http://127.0.0.1:${port}/mcp`, MEADOW_TOKEN: token, MEADOW_APP: appExecutable },
  };
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The file a packaged Claude Desktop falls back to while its own copy does not
 * exist yet: Windows shows it the real %APPDATA% file then. Null for any other path.
 */
export function unpackagedPath(path: string): string | null {
  const m = /^(.*)[\\/]Local[\\/]Packages[\\/]Claude_[^\\/]+[\\/]LocalCache[\\/]Roaming[\\/](.*)$/i.exec(path);
  return m ? join(m[1], 'Roaming', m[2]) : null;
}

type Read = { data: Record<string, any> | null; found: boolean; unreadable: boolean };

function read(path: string): Read {
  if (!existsSync(path)) {
    // A packaged Claude with no copy of its own reads the real file: so do we, and a
    // first write carries that file's settings into the copy instead of hiding them.
    const real = unpackagedPath(path);
    return real && existsSync(real) ? read(real) : { data: null, found: false, unreadable: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { data: null, found: true, unreadable: true };
    return { data: parsed, found: true, unreadable: false };
  } catch {
    return { data: null, found: true, unreadable: true };
  }
}

function write(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.meadow-tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, path);
}

const unreadable = (path: string) => ({ ok: false as const, error: `Claude Desktop's settings file could not be read, so nothing was changed (${path}).` });

export function status(path: string, name: string, want: BridgeEntry) {
  const r = read(path);
  const e = r.data?.mcpServers?.[name];
  return { path, found: r.found, unreadable: r.unreadable, installed: !!e, upToDate: !!e && JSON.stringify(e) === JSON.stringify(want) };
}

export function add(path: string, name: string, entry: BridgeEntry): { ok: true } | { ok: false; error: string } {
  const r = read(path);
  if (r.unreadable) return unreadable(path);
  const cfg = r.data ?? {};
  write(path, { ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}), [name]: entry } });
  return { ok: true };
}

export function remove(path: string, name: string): { ok: true } | { ok: false; error: string } {
  const r = read(path);
  if (!r.found) return { ok: true };
  if (r.unreadable) return unreadable(path);
  if (!r.data!.mcpServers || !(name in r.data!.mcpServers)) return { ok: true };
  const servers = { ...r.data!.mcpServers };
  delete servers[name];
  write(path, { ...r.data, mcpServers: servers });
  return { ok: true };
}
