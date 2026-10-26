// The plugin block in a message's text (SPEC §16.26.2): 1 to 4 lines at the very end, each
// exactly `[meadow:embed <plugin>.<type> <json>]`. Only that trailing block is ever read; a line
// that does not match exactly, and every line above it, is plain text. Five or more matching lines
// are not a block at all.

export const MAX_EMBEDS = 4;
export const MAX_EMBED_JSON = 2048;
const LINE = /^\[meadow:embed ([a-z][a-z0-9-]{0,31})\.([a-z][a-z0-9-]{0,31}) (\{.*\})\]$/;

export interface Embed {
  type: string; // plugin.name
  plugin: string;
  name: string;
  data: Record<string, unknown>;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function parseLine(line: string): Embed | null {
  const m = LINE.exec(line);
  if (!m || Buffer.byteLength(m[3], 'utf8') > MAX_EMBED_JSON) return null;
  let data: unknown;
  try {
    data = JSON.parse(m[3]);
  } catch {
    return null;
  }
  return isObject(data) ? { type: `${m[1]}.${m[2]}`, plugin: m[1], name: m[2], data } : null;
}

/** The text without its block, and the block's embeds (none when the text has no valid block). */
export function readBlock(text: string): { text: string; embeds: Embed[] } {
  const lines = text.split(/\r?\n/);
  const embeds: Embed[] = [];
  let i = lines.length;
  while (i > 0) {
    const e = parseLine(lines[i - 1]);
    if (!e) break;
    embeds.unshift(e);
    i--;
  }
  if (!embeds.length || embeds.length > MAX_EMBEDS) return { text, embeds: [] };
  return { text: lines.slice(0, i).join('\n').replace(/\s+$/, ''), embeds };
}

/** One block line for checked data; its JSON must fit the limit. */
export function blockLine(type: string, data: Record<string, unknown>): string {
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json, 'utf8') > MAX_EMBED_JSON) throw new Error(`The data for ${type} is larger than ${MAX_EMBED_JSON} bytes.`);
  return `[meadow:embed ${type} ${json}]`;
}

/** The text to send: the agent's text, each embed's fallback on its own line, then the block. */
export function writeBlock(text: string, items: { type: string; data: Record<string, unknown>; fallback: string }[]): string {
  if (!items.length) return text;
  if (items.length > MAX_EMBEDS) throw new Error(`At most ${MAX_EMBEDS} embeds a message.`);
  const head = [text.replace(/\s+$/, ''), ...items.map((x) => x.fallback).filter(Boolean)].filter(Boolean).join('\n');
  return [head, ...items.map((x) => blockLine(x.type, x.data))].filter(Boolean).join('\n');
}
