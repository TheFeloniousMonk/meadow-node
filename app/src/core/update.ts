// How this copy was installed, where it can be started from after an update,
// and the update check (SPEC §16.3). Nothing here depends on Electron.
//
// The app's releases share the repository with the node's, so the app's tags
// are app-v<version> and the check ignores every other release. It asks
// GitHub on start and once a day, and only says a newer version exists: on
// Windows the person runs `scoop update meadow`, elsewhere they download it.

import { join } from 'node:path';

export const REPO = 'TheFeloniousMonk/meadow-node';
export const TAG_PREFIX = 'app-v';
export const SCOOP_APP = 'meadow';
const RELEASES = `https://api.github.com/repos/${REPO}/releases?per_page=50`;
const DAY = 24 * 60 * 60_000;

export type InstallKind = 'scoop' | 'appimage' | 'package' | 'dev';

/** A Scoop install lives under ...\scoop\apps\meadow\<version>\; an AppImage runs from a temporary mount. */
export function installKind(execPath: string, env: NodeJS.ProcessEnv, packaged: boolean): InstallKind {
  if (!packaged) return 'dev';
  if (/[\\/]scoop[\\/]apps[\\/]/i.test(execPath)) return 'scoop';
  if (env.APPIMAGE) return 'appimage';
  return 'package';
}

/**
 * The executable to write into other programs' settings (Claude Desktop's):
 * one that still exists after an update. Scoop replaces the version folder
 * and keeps a `current` junction; an AppImage's own path is its file, not the
 * mount it runs from.
 */
export function launchPath(execPath: string, env: NodeJS.ProcessEnv, kind: InstallKind): string {
  if (kind === 'appimage' && env.APPIMAGE) return env.APPIMAGE;
  if (kind === 'scoop') {
    const parts = execPath.split(/[\\/]/);
    const i = parts.findIndex((p, n) => p.toLowerCase() === 'apps' && parts[n - 1]?.toLowerCase() === 'scoop');
    if (i >= 0 && parts.length > i + 3) {
      parts[i + 2] = 'current';
      return parts.join(execPath.includes('\\') ? '\\' : '/');
    }
  }
  return execPath;
}

/** Where the bridge is copied, so Claude Desktop's entry survives updates: the data folder. */
export const bridgeCopyPath = (userData: string) => join(userData, 'bridge', 'meadow-bridge.js');

/** Numeric x.y.z comparison; anything that is not x.y.z sorts below every version. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  const x = parse(a), y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export interface UpdateInfo {
  version: string;
  /** The release page, for the download link. */
  url: string;
  /** What the person runs, when the install has a command (Scoop). */
  command: string | null;
}

interface Release { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }

/** The newest app release in a GitHub releases listing, or null. */
export function latestRelease(list: unknown): { version: string; url: string } | null {
  if (!Array.isArray(list)) return null;
  let best: { version: string; url: string } | null = null;
  for (const r of list as Release[]) {
    if (!r || r.draft || r.prerelease || typeof r.tag_name !== 'string' || !r.tag_name.startsWith(TAG_PREFIX)) continue;
    const version = r.tag_name.slice(TAG_PREFIX.length);
    const url = typeof r.html_url === 'string' && r.html_url.startsWith(`https://github.com/${REPO}/releases/`) ? r.html_url : `https://github.com/${REPO}/releases/tag/${r.tag_name}`;
    if (compareVersions(version, '0.0.0') < 0) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, url };
  }
  return best;
}

export class UpdateCheck {
  readonly version: string;
  readonly kind: InstallKind;
  available: UpdateInfo | null = null;
  checkedAt: number | null = null;
  #fetch: typeof fetch;
  #timer: NodeJS.Timeout | null = null;

  constructor({ version, kind, fetchImpl = fetch }: { version: string; kind: InstallKind; fetchImpl?: typeof fetch }) {
    this.version = version;
    this.kind = kind;
    this.#fetch = fetchImpl;
  }

  /** One check. A failure (offline, rate-limited) keeps the last answer and says nothing. */
  async check(): Promise<UpdateInfo | null> {
    try {
      const res = await this.#fetch(RELEASES, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `meadow-app/${this.version}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return this.available;
      const latest = latestRelease(await res.json());
      this.checkedAt = Date.now();
      this.available = latest && compareVersions(latest.version, this.version) > 0
        ? { version: latest.version, url: latest.url, command: this.kind === 'scoop' ? `scoop update ${SCOOP_APP}` : null }
        : null;
    } catch {
      // Keep what we knew.
    }
    return this.available;
  }

  /** On start and once a day. A development copy never checks. */
  start(changed: () => void) {
    if (this.kind === 'dev' || this.#timer) return;
    const run = () => void this.check().then(changed);
    run();
    this.#timer = setInterval(run, DAY);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
