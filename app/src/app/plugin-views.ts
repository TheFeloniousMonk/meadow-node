// Plugins for the window (SPEC §16.26.4, §16.26.6). The main process does all the address work:
// the window gets components with final, checked addresses, never a template or raw data to fill.
// Images are fetched here, on the person's click, only from an active plugin's declared hosts, and
// only if their bytes are really PNG, JPEG, GIF, or WebP; links open only to those hosts too.

import type { EmbedView, PluginPreview, PluginView } from '../shared/api.ts';
import { readBlock } from '../core/plugins/block.ts';
import { checkData, renderEmbed, type Manifest } from '../core/plugins/manifest.ts';
import type { PluginStore } from '../core/plugins/store.ts';
import { readBytes } from '../core/deps.ts';
import { dryRunCases } from '../core/plugins/cases.ts';

export const IMAGE_LIMIT = 5 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 15_000;

/** A shown message's text and its embeds for the window: block lines removed once there is a block. */
export function messageEmbeds(store: PluginStore, text: string): { text: string; embeds?: EmbedView[] } {
  const b = readBlock(text);
  if (!b.embeds.length) return { text };
  return {
    text: b.text,
    embeds: b.embeds.map((e): EmbedView => {
      const t = store.type(e.type);
      const line = `[meadow:embed ${e.type} ${JSON.stringify(e.data)}]`;
      if (!t) return { type: e.type, shown: false, why: 'not_installed', line };
      try {
        const r = renderEmbed(t.def, checkData(t.def.schema, e.data));
        const src = typeof r.fields.src === 'string' ? r.fields.src : typeof r.fields.href === 'string' ? r.fields.href : null;
        return { type: e.type, shown: true, plugin: t.manifest.name, component: r.component, fields: r.fields, ...(src && { host: new URL(src).hostname }) };
      } catch (err) {
        return { type: e.type, shown: false, why: 'bad_data', detail: (err as Error).message, line };
      }
    }),
  };
}

const typesOf = (m: Manifest) => Object.entries(m.types).map(([name, t]) => ({ type: `${m.id}.${name}`, description: t.description, component: t.render.component }));

export function pluginsView(store: PluginStore): PluginView[] {
  return store.list().map((p) => {
    const icon = store.icon(p.manifest.id);
    return {
      id: p.manifest.id, name: p.manifest.name, version: p.manifest.version ?? null, description: p.manifest.description ?? null,
      author: p.manifest.author ?? null, homepage: p.manifest.homepage ?? null, enabled: p.enabled, error: p.error,
      hosts: p.manifest.hosts ?? [], types: p.manifest.types ? typesOf(p.manifest) : [],
      icon: icon ? `data:image/png;base64,${icon.toString('base64')}` : null,
    };
  });
}

export function previewView(p: { manifest: Manifest; hasIcon: boolean; replaces: string | null }, icon: Buffer | null): PluginPreview {
  const m = p.manifest;
  return {
    id: m.id, name: m.name, version: m.version, description: m.description, author: m.author ?? null, homepage: m.homepage ?? null,
    hosts: m.hosts, types: typesOf(m), replaces: p.replaces, icon: icon ? `data:image/png;base64,${icon.toString('base64')}` : null,
  };
}

/** Whether an address is https on a host an active plugin declared (no user, password, or port). */
export function onActiveHost(store: PluginStore, url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  return store.active().some((m) => m.hosts.includes(u.hostname)) ? u : null;
}

const MAGIC: [string, (b: Buffer) => boolean][] = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a'],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];

/** Fetches an image an embed shows, on the person's click: as a data address, or an error in plain words. */
export async function fetchEmbedImage(store: PluginStore, url: string, fetchImpl: typeof fetch = fetch): Promise<{ data: string } | { error: string }> {
  const u = onActiveHost(store, url);
  if (!u) return { error: 'That image is not from a site an installed plugin may load from.' };
  try {
    // No cookies or referrer go with it, and redirects to anywhere else are refused.
    const res = await fetchImpl(u.href, { redirect: 'error', referrerPolicy: 'no-referrer', credentials: 'omit', signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!res.ok) return { error: `${u.hostname} answered ${res.status}.` };
    const bytes = await readBytes(res, IMAGE_LIMIT);
    const type = MAGIC.find(([, is]) => is(bytes))?.[0];
    if (!type) return { error: 'That is not a PNG, JPEG, GIF, or WebP image, so it is not shown.' };
    return { data: `data:${type};base64,${bytes.toString('base64')}` };
  } catch (e) {
    const msg = (e as Error).message ?? '';
    return { error: /over \d+ bytes/.test(msg) ? 'That image is larger than 5 MiB, so it is not shown.' : `The image could not be loaded from ${u.hostname}.` };
  }
}

/** One dry-run case, ready for the hidden window (§16.26.7). */
export interface DryRunCase {
  label: string;
  view: EmbedView;
}

/**
 * The dry run's cases as the window would get them, built exactly as for a real message. A template
 * that fails here (an address that leaves its host) is a failure of the dry run itself.
 */
export function dryRunViews(m: Manifest): { cases: DryRunCase[] } | { error: string } {
  const cases: DryRunCase[] = [];
  for (const c of dryRunCases(m)) {
    const def = m.types[c.type.split('.')[1]];
    const label = `${c.type} with ${c.label}`;
    try {
      const r = renderEmbed(def, c.data);
      const src = typeof r.fields.src === 'string' ? r.fields.src : typeof r.fields.href === 'string' ? r.fields.href : null;
      cases.push({ label, view: { type: c.type, shown: true, plugin: m.name, component: r.component, fields: r.fields, ...(src && { host: new URL(src).hostname }) } });
    } catch (e) {
      return { error: `${label}: ${(e as Error).message}` };
    }
  }
  return { cases };
}
