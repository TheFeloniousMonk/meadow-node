// A plugin's plugin.json (SPEC §16.26.3): checked field by field, unknown fields refused, with
// the reason in plain words. Also the schema subset embed data is checked against, and the
// templates that fill a built-in component (§16.26.4) and the fallback text from checked data.

import { compilePattern, matchPattern, PatternError } from './pattern.ts';

export class PluginError extends Error {}

export const FORMAT = 'meadow-plugin/1';
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const LIMITS = { types: 32, hosts: 16, properties: 16, text: 500, string: 2048, enum: 64, description: 500, name: 64 };

/** The built-in components, and the fields each takes: a URL template, a text template, or a fixed value. */
export const COMPONENTS = {
  video: { src: 'url', title: 'text?' },
  audio: { src: 'url', title: 'text?', kind: ['player', 'file'] },
  image: { src: 'url', alt: 'text' },
  math: { tex: 'text', display: 'boolean?' },
  code: { code: 'text', language: 'text?' },
  card: { title: 'text', text: 'text?', href: 'url' },
} as const;
export type Component = keyof typeof COMPONENTS;

export type PropSchema =
  | { type: 'string'; maxLength: number; pattern?: string; enum?: string[]; description?: string }
  | { type: 'integer' | 'number'; minimum: number; maximum: number; description?: string }
  | { type: 'boolean'; description?: string };
export interface DataSchema {
  type: 'object';
  additionalProperties: false;
  properties: Record<string, PropSchema>;
  required?: string[];
}
export interface TypeDef {
  description: string;
  example: Record<string, unknown>;
  schema: DataSchema;
  render: { component: Component } & Record<string, unknown>;
  fallback: string;
}
export interface Manifest {
  format: typeof FORMAT;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  hosts: string[];
  types: Record<string, TypeDef>;
}

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const onlyKeys = (o: Record<string, unknown>, keys: string[], where: string) => {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new PluginError(`${where} has a field this app does not know: ${extra[0]}.`);
};
const text = (x: unknown, max: number, where: string, optional = false): string | undefined => {
  if (x === undefined && optional) return undefined;
  if (typeof x !== 'string' || !x.trim() || x.length > max) throw new PluginError(`${where} must be text of 1 to ${max} characters.`);
  return x;
};

/** The placeholders in a template: {name}; any other brace is refused. */
function placeholders(t: string, where: string): string[] {
  const names: string[] = [];
  const rest = t.replace(/\{([a-z][a-z0-9_]{0,31})\}/gi, (_, n) => {
    names.push(n);
    return '';
  });
  if (/[{}]/.test(rest)) throw new PluginError(`${where} has a brace that is not a {field} placeholder.`);
  return names;
}

function checkSchema(s: unknown, where: string): DataSchema {
  if (!isObject(s)) throw new PluginError(`${where} must be an object schema.`);
  onlyKeys(s, ['type', 'additionalProperties', 'properties', 'required'], where);
  if (s.type !== 'object' || s.additionalProperties !== false || !isObject(s.properties)) {
    throw new PluginError(`${where} must be {"type": "object", "additionalProperties": false, "properties": {…}}.`);
  }
  const props = Object.entries(s.properties);
  if (!props.length || props.length > LIMITS.properties) throw new PluginError(`${where} must have 1 to ${LIMITS.properties} properties.`);
  for (const [name, p] of props) {
    const at = `${where}, property ${name}`;
    if (!/^[a-z][a-z0-9_]{0,31}$/i.test(name)) throw new PluginError(`${at}: names are letters, digits, and _, starting with a letter.`);
    if (!isObject(p)) throw new PluginError(`${at} must be an object.`);
    if (p.description !== undefined) text(p.description, LIMITS.description, `${at}'s description`);
    if (p.type === 'string') {
      onlyKeys(p, ['type', 'maxLength', 'pattern', 'enum', 'description'], at);
      if (!Number.isInteger(p.maxLength) || p.maxLength < 1 || p.maxLength > LIMITS.string) throw new PluginError(`${at} needs a maxLength from 1 to ${LIMITS.string}.`);
      if ((p.pattern === undefined) === (p.enum === undefined)) throw new PluginError(`${at} needs exactly one of pattern or enum.`);
      if (p.pattern !== undefined) {
        try {
          compilePattern(p.pattern);
        } catch (e) {
          throw new PluginError(`${at}: ${(e as PatternError).message}`);
        }
      }
      if (p.enum !== undefined && (!Array.isArray(p.enum) || !p.enum.length || p.enum.length > LIMITS.enum || !p.enum.every((v: unknown) => typeof v === 'string' && v.length <= p.maxLength))) {
        throw new PluginError(`${at}: enum must be 1 to ${LIMITS.enum} strings within maxLength.`);
      }
    } else if (p.type === 'integer' || p.type === 'number') {
      onlyKeys(p, ['type', 'minimum', 'maximum', 'description'], at);
      if (!Number.isFinite(p.minimum) || !Number.isFinite(p.maximum) || p.minimum > p.maximum) throw new PluginError(`${at} needs a minimum and a maximum.`);
    } else if (p.type === 'boolean') {
      onlyKeys(p, ['type', 'description'], at);
    } else throw new PluginError(`${at}: the type must be string, integer, number, or boolean.`);
  }
  if (s.required !== undefined && (!Array.isArray(s.required) || !s.required.every((r: unknown) => typeof r === 'string' && r in s.properties) || new Set(s.required).size !== s.required.length)) {
    throw new PluginError(`${where}: required must list properties it has, once each.`);
  }
  return s as DataSchema;
}

/** Checks a URL template: https, a literal host the plugin lists, placeholders only after the host. */
function checkUrl(t: unknown, hosts: string[], props: string[], where: string) {
  if (typeof t !== 'string' || t.length > LIMITS.text) throw new PluginError(`${where} must be a URL template of at most ${LIMITS.text} characters.`);
  const m = /^https:\/\/([a-z0-9.-]+)(\/[^\s]*)?$/.exec(t);
  if (!m) throw new PluginError(`${where} must start with https:// and a host, with no spaces.`);
  if (!hosts.includes(m[1])) throw new PluginError(`${where} uses ${m[1]}, which is not in the plugin's hosts.`);
  for (const n of placeholders(m[2] ?? '', where)) if (!props.includes(n)) throw new PluginError(`${where} uses {${n}}, which the schema does not have.`);
}

function checkText(t: unknown, props: string[], where: string, optional: boolean) {
  if (t === undefined && optional) return;
  if (typeof t !== 'string' || t.length > LIMITS.text) throw new PluginError(`${where} must be a text template of at most ${LIMITS.text} characters.`);
  for (const n of placeholders(t, where)) if (!props.includes(n)) throw new PluginError(`${where} uses {${n}}, which the schema does not have.`);
}

/** Checks a whole plugin.json; returns it typed, or throws PluginError with the first problem. */
export function checkManifest(m: unknown): Manifest {
  if (!isObject(m)) throw new PluginError('plugin.json must hold a JSON object.');
  onlyKeys(m, ['format', 'id', 'name', 'version', 'description', 'author', 'homepage', 'hosts', 'types'], 'plugin.json');
  if (m.format !== FORMAT) throw new PluginError(`plugin.json must say "format": "${FORMAT}".`);
  if (typeof m.id !== 'string' || !ID.test(m.id)) throw new PluginError('The id must be 1 to 32 lowercase letters, digits, or hyphens, starting with a letter.');
  text(m.name, LIMITS.name, 'The name');
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) throw new PluginError('The version must look like 1.0.0.');
  text(m.description, LIMITS.description, 'The description');
  text(m.author, 100, 'The author', true);
  if (m.homepage !== undefined && (typeof m.homepage !== 'string' || !/^https:\/\/[^\s]{1,300}$/.test(m.homepage))) throw new PluginError('The homepage must be an https address.');
  if (!Array.isArray(m.hosts) || m.hosts.length > LIMITS.hosts || !m.hosts.every((h: unknown) => typeof h === 'string' && HOST.test(h)) || new Set(m.hosts).size !== m.hosts.length) {
    throw new PluginError(`hosts must be up to ${LIMITS.hosts} different host names, like www.youtube-nocookie.com (no https://, no paths).`);
  }
  if (!isObject(m.types) || !Object.keys(m.types).length || Object.keys(m.types).length > LIMITS.types) throw new PluginError(`types must hold 1 to ${LIMITS.types} embed types.`);
  for (const [name, t] of Object.entries(m.types)) {
    const where = `Type ${name}`;
    if (!ID.test(name)) throw new PluginError(`${where}: type names are 1 to 32 lowercase letters, digits, or hyphens.`);
    if (!isObject(t)) throw new PluginError(`${where} must be an object.`);
    onlyKeys(t, ['description', 'example', 'schema', 'render', 'fallback'], where);
    text(t.description, LIMITS.description, `${where}'s description`);
    const schema = checkSchema(t.schema, `${where}'s schema`);
    const props = Object.keys(schema.properties);
    if (!isObject(t.render) || !(t.render.component in COMPONENTS)) throw new PluginError(`${where}'s render must name a component: ${Object.keys(COMPONENTS).join(', ')}.`);
    const fields = COMPONENTS[t.render.component as Component] as Record<string, string | readonly string[]>;
    onlyKeys(t.render, ['component', ...Object.keys(fields)], `${where}'s render`);
    for (const [f, kind] of Object.entries(fields)) {
      const at = `${where}'s render ${f}`;
      const v = t.render[f];
      if (typeof kind !== 'string') {
        if (v !== undefined && !kind.includes(v)) throw new PluginError(`${at} must be one of ${kind.join(', ')}.`);
      } else if (kind.startsWith('boolean')) {
        if (v !== undefined && typeof v !== 'boolean') throw new PluginError(`${at} must be true or false.`);
      } else if (kind === 'url') checkUrl(v, m.hosts, props, at);
      else checkText(v, props, at, kind.endsWith('?'));
    }
    checkText(t.fallback, props, `${where}'s fallback`, false);
    try {
      checkData(schema, t.example);
    } catch (e) {
      throw new PluginError(`${where}'s example does not fit its schema: ${(e as Error).message}`);
    }
  }
  return m as Manifest;
}

/** Checks embed data against a type's schema; throws PluginError with what is wrong. */
export function checkData(schema: DataSchema, data: unknown): Record<string, string | number | boolean> {
  if (!isObject(data)) throw new PluginError('The data must be an object.');
  for (const k of Object.keys(data)) if (!(k in schema.properties)) throw new PluginError(`The data has a field the type does not take: ${k}.`);
  for (const r of schema.required ?? []) if (!(r in data)) throw new PluginError(`The data is missing ${r}.`);
  for (const [k, v] of Object.entries(data)) {
    const p = schema.properties[k];
    if (p.type === 'string') {
      if (typeof v !== 'string') throw new PluginError(`${k} must be text.`);
      if ([...v].length > p.maxLength) throw new PluginError(`${k} is longer than ${p.maxLength} characters.`);
      if (p.enum && !p.enum.includes(v)) throw new PluginError(`${k} must be one of: ${p.enum.join(', ')}.`);
      if (p.pattern && !matchPattern(compilePattern(p.pattern), v)) throw new PluginError(`${k} is not in the form the type takes.`);
    } else if (p.type === 'integer' || p.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || (p.type === 'integer' && !Number.isInteger(v))) throw new PluginError(`${k} must be ${p.type === 'integer' ? 'a whole number' : 'a number'}.`);
      if (v < p.minimum || v > p.maximum) throw new PluginError(`${k} must be from ${p.minimum} to ${p.maximum}.`);
    } else if (typeof v !== 'boolean') throw new PluginError(`${k} must be true or false.`);
  }
  return data as Record<string, string | number | boolean>;
}

const fill = (t: string, data: Record<string, unknown>, encode: (s: string) => string) =>
  t.replace(/\{([a-z][a-z0-9_]{0,31})\}/gi, (_, n) => (data[n] === undefined ? '' : encode(String(data[n]))));

/** The readable fallback text for checked data. */
export function fallbackText(def: TypeDef, data: Record<string, unknown>): string {
  return fill(def.fallback, data, (s) => s).replace(/\s+/g, ' ').trim();
}

/** A component filled from checked data: URLs encoded and checked again for https and the declared host. */
export function renderEmbed(def: TypeDef, data: Record<string, unknown>): { component: Component; fields: Record<string, string | boolean> } {
  const fields: Record<string, string | boolean> = {};
  const spec = COMPONENTS[def.render.component] as Record<string, string | readonly string[]>;
  for (const [f, kind] of Object.entries(spec)) {
    const v = def.render[f];
    if (v === undefined) continue;
    if (typeof kind !== 'string' || typeof v === 'boolean') fields[f] = v as string | boolean;
    else if (kind === 'url') {
      const url = fill(v as string, data, encodeURIComponent);
      const u = new URL(url);
      const declared = new URL(fill(v as string, {}, () => '')).hostname;
      if (u.protocol !== 'https:' || u.hostname !== declared || u.username || u.password) throw new PluginError('The filled address left its declared host.');
      fields[f] = u.href;
    } else fields[f] = fill(v as string, data, (s) => s);
  }
  return { component: def.render.component, fields };
}
