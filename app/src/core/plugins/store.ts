// Installed plugins (SPEC §16.26.3, §16.26.6, §16.26.7): each in `<data>/plugins/<id>/`, holding
// only plugin.json and an optional icon.png. A zip is checked fully before anything is kept; an
// install is written to a temporary folder and then swapped in. At startup every plugin is checked
// again, and one that fails is switched off with the reason. On/off state lives in one meta row.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.ts';
import { readZip, ZipError } from './zip.ts';
import { checkData, checkManifest, fallbackText, PluginError, renderEmbed, type Manifest, type TypeDef } from './manifest.ts';
import type { Embed } from './block.ts';

const ALLOWED = new Set(['plugin.json', 'icon.png']);
const ICON_MAX = 64 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const META = 'plugins_state';

export interface InstalledPlugin {
  manifest: Manifest;
  enabled: boolean;
  installedAt: number;
  hasIcon: boolean;
  /** Why it was switched off by the app, if it was (a failed check at startup). */
  error: string | null;
}

interface State {
  [id: string]: { enabled: boolean; installedAt: number; error?: string | null };
}

/** Checks a plugin's files: only the allowed ones, a valid plugin.json, a real small PNG icon. */
function checkFiles(files: Map<string, Buffer>): { manifest: Manifest; icon: Buffer | null } {
  for (const name of files.keys()) if (!ALLOWED.has(name)) throw new PluginError(`A plugin holds only plugin.json and icon.png; this one also has ${name}.`);
  const raw = files.get('plugin.json');
  if (!raw) throw new PluginError('There is no plugin.json at the top of the zip.');
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new PluginError('plugin.json is not valid JSON.');
  }
  const manifest = checkManifest(json);
  const icon = files.get('icon.png') ?? null;
  if (icon && (icon.length > ICON_MAX || !icon.subarray(0, 8).equals(PNG))) throw new PluginError('icon.png must be a PNG image of at most 64 KiB.');
  return { manifest, icon };
}

export class PluginStore {
  #dir: string | null;
  #db: Db;
  #now: () => number;
  #loaded = new Map<string, InstalledPlugin>();
  /** Safe mode (§16.26.7): every plugin treated as off, without changing what the person chose. */
  safeMode = false;

  constructor({ dir, db, now = Date.now }: { dir: string | null; db: Db; now?: () => number }) {
    this.#dir = dir;
    this.#db = db;
    this.#now = now;
  }

  #state(): State {
    const r = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(META) as { value: string } | undefined;
    try {
      return r ? JSON.parse(r.value) : {};
    } catch {
      return {};
    }
  }

  #save(s: State) {
    this.#db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(META, JSON.stringify(s));
  }

  /** Reads and checks every installed plugin again (startup, §16.26.7). One that fails is switched off with the reason. */
  load() {
    this.#loaded.clear();
    const state = this.#state();
    if (!this.#dir || !existsSync(this.#dir)) return;
    for (const id of readdirSync(this.#dir)) {
      if (id.startsWith('.')) continue; // temporary folders of an install that was interrupted
      const dir = join(this.#dir, id);
      if (!statSync(dir).isDirectory()) continue;
      const st = state[id] ?? { enabled: false, installedAt: this.#now() };
      try {
        const files = new Map(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f))] as const));
        const { manifest, icon } = checkFiles(files);
        if (manifest.id !== id) throw new PluginError(`Its folder is ${id}, but plugin.json says ${manifest.id}.`);
        this.#loaded.set(id, { manifest, enabled: st.enabled && !st.error, installedAt: st.installedAt, hasIcon: !!icon, error: st.error ?? null });
      } catch (e) {
        const error = `It failed its check when Meadow started: ${(e as Error).message}`;
        state[id] = { ...st, enabled: false, error };
        this.#loaded.set(id, { manifest: { id, name: id } as Manifest, enabled: false, installedAt: st.installedAt, hasIcon: false, error });
      }
    }
    this.#save(state);
  }

  list(): InstalledPlugin[] {
    return [...this.#loaded.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  /** Checks a zip without keeping anything: what it would add (§16.26.6), or a PluginError/ZipError in plain words. */
  preview(zip: Buffer): { manifest: Manifest; hasIcon: boolean; replaces: string | null } {
    const { manifest, icon } = checkFiles(readZip(zip));
    const old = this.#loaded.get(manifest.id);
    return { manifest, hasIcon: !!icon, replaces: old && !old.error ? old.manifest.version : null };
  }

  /** Keeps a plugin (checked again), switched on. A newer or other version of the same id replaces it. */
  install(zip: Buffer): InstalledPlugin {
    if (!this.#dir) throw new PluginError('This app has no folder for plugins.');
    const { manifest, icon } = checkFiles(readZip(zip));
    mkdirSync(this.#dir, { recursive: true });
    const final = join(this.#dir, manifest.id);
    const tmp = join(this.#dir, `.installing-${manifest.id}-${process.pid}`);
    const old = join(this.#dir, `.replaced-${manifest.id}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
    mkdirSync(tmp);
    writeFileSync(join(tmp, 'plugin.json'), JSON.stringify(manifest, null, 2));
    if (icon) writeFileSync(join(tmp, 'icon.png'), icon);
    if (existsSync(final)) renameSync(final, old);
    renameSync(tmp, final);
    rmSync(old, { recursive: true, force: true });
    const state = this.#state();
    state[manifest.id] = { enabled: true, installedAt: this.#now(), error: null };
    this.#save(state);
    const p: InstalledPlugin = { manifest, enabled: true, installedAt: state[manifest.id].installedAt, hasIcon: !!icon, error: null };
    this.#loaded.set(manifest.id, p);
    return p;
  }

  setEnabled(id: string, on: boolean) {
    const p = this.#loaded.get(id);
    if (!p) throw new PluginError('There is no such plugin installed.');
    if (on && p.error) throw new PluginError('It failed its check; install it again to use it.');
    const state = this.#state();
    state[id] = { ...(state[id] ?? { installedAt: p.installedAt }), enabled: on };
    this.#save(state);
    p.enabled = on;
  }

  remove(id: string) {
    if (!this.#loaded.has(id)) throw new PluginError('There is no such plugin installed.');
    if (this.#dir) rmSync(join(this.#dir, id), { recursive: true, force: true });
    const state = this.#state();
    delete state[id];
    this.#save(state);
    this.#loaded.delete(id);
  }

  icon(id: string): Buffer | null {
    const p = this.#loaded.get(id);
    if (!p?.hasIcon || !this.#dir) return null;
    try {
      return readFileSync(join(this.#dir, id, 'icon.png'));
    } catch {
      return null;
    }
  }

  /** The plugins in use now: installed, on, passed their check, and not in safe mode. */
  active(): Manifest[] {
    if (this.safeMode) return [];
    return [...this.#loaded.values()].filter((p) => p.enabled && !p.error).map((p) => p.manifest);
  }

  /** A type in use now, by `plugin.name`. */
  type(type: string): { manifest: Manifest; def: TypeDef } | null {
    const [id, name] = type.split('.');
    const manifest = this.active().find((m) => m.id === id);
    const def = manifest && Object.hasOwn(manifest.types, name) ? manifest.types[name] : undefined;
    return manifest && def ? { manifest, def } : null;
  }

  /** For send (§16.26.5): checks an item against its installed type and gives its fallback, or throws with what is wrong. */
  prepare(item: { type: unknown; data: unknown }): { type: string; data: Record<string, unknown>; fallback: string } {
    if (typeof item?.type !== 'string') throw new PluginError('Each embed needs a type, like media.video.');
    const t = this.type(item.type);
    if (!t) throw new PluginNotInstalled(item.type);
    const data = checkData(t.def.schema, item.data);
    renderEmbed(t.def, data); // fails here, not at the receiver, if a filled address would leave its host
    return { type: item.type, data, fallback: fallbackText(t.def, data) };
  }

  /** For a received embed: whether this app shows it (installed, on, and the data checks out). */
  shows(e: Embed): boolean {
    const t = this.type(e.type);
    if (!t) return false;
    try {
      renderEmbed(t.def, checkData(t.def.schema, e.data));
      return true;
    } catch {
      return false;
    }
  }
}

export class PluginNotInstalled extends PluginError {
  readonly pluginType: string;

  constructor(pluginType: string) {
    super(`No plugin for ${pluginType} is installed and on in this app. The plugins tool lists the types it has.`);
    this.pluginType = pluginType;
  }
}

export { PluginError, ZipError };
