// The inputs a plugin's dry run renders before it is installed (SPEC §16.26.7): every type's
// example, and inputs at the edges of its schema: the longest value a pattern allows, unusual but
// valid characters, every enum value, the ends of each number range, and both booleans. Every case
// is checked against the schema, so the dry run only tries what a real message could carry.

import { compilePattern, matchPattern, type Atom } from './pattern.ts';
import { checkData, type DataSchema, type Manifest, type PropSchema } from './manifest.ts';

export interface DryCase {
  type: string; // plugin.name
  label: string; // what this case tries, for the error message
  data: Record<string, unknown>;
}

const MAX_CASES = 200;
// Plain characters first, then the unusual ones a pattern may also accept.
const PLAIN = ['a', 'Z', '0', '9', '_', '-', '.', ' ', '/', ':', '~', '%', '^', '{', '}', '\\'];
const UNUSUAL = ['é', 'ß', 'Ω', '中', '文', '😀', '​', '‮'];

/** The longest string the atoms allow within maxLength, from the first candidate each atom accepts; null if none fits. */
function longest(atoms: Atom[], maxLength: number, candidates: string[]): string | null {
  const pick = atoms.map((a) => candidates.find((c) => a.test(c.codePointAt(0)!)) ?? null);
  if (pick.some((p, i) => p === null && atoms[i].min > 0)) return null;
  const counts = atoms.map((a) => a.min);
  let total = counts.reduce((x, y) => x + y, 0);
  if (total > maxLength) return null;
  // Fill each atom toward its maximum, in order, while characters remain.
  for (let i = 0; i < atoms.length && total < maxLength; i++) {
    if (pick[i] === null) continue;
    const room = Math.min(atoms[i].max, counts[i] + (maxLength - total)) - counts[i];
    counts[i] += room;
    total += room;
  }
  return atoms.map((_, i) => (pick[i] ?? '').repeat(counts[i])).join('');
}

function edgeValues(p: PropSchema): { label: string; value: unknown }[] {
  if (p.type === 'boolean') return [{ label: 'true', value: true }, { label: 'false', value: false }];
  if (p.type === 'integer' || p.type === 'number') return [{ label: 'its minimum', value: p.minimum }, { label: 'its maximum', value: p.maximum }];
  if (p.type !== 'string') return [];
  if (p.enum) return p.enum.map((v) => ({ label: `"${v}"`, value: v }));
  const atoms = compilePattern(p.pattern!);
  const out: { label: string; value: unknown }[] = [];
  const plain = longest(atoms, p.maxLength, PLAIN);
  if (plain !== null) out.push({ label: `the longest allowed value (${[...plain].length} characters)`, value: plain });
  const odd = longest(atoms, p.maxLength, [...UNUSUAL, ...PLAIN]);
  if (odd !== null && odd !== plain) out.push({ label: 'unusual characters', value: odd });
  const shortest = longest(atoms, atoms.reduce((n, a) => n + a.min, 0), PLAIN);
  if (shortest !== null && shortest !== plain) out.push({ label: 'the shortest allowed value', value: shortest });
  return out.filter((v) => typeof v.value === 'string' && matchPattern(atoms, v.value as string));
}

/** The dry-run cases for a plugin, capped at 200. */
export function dryRunCases(m: Manifest): DryCase[] {
  const cases: DryCase[] = [];
  const add = (c: DryCase, schema: DataSchema) => {
    if (cases.length >= MAX_CASES) return;
    try {
      checkData(schema, c.data);
      cases.push(c);
    } catch {
      // Not a value a real message could carry: not tried.
    }
  };
  for (const [name, t] of Object.entries(m.types)) {
    const type = `${m.id}.${name}`;
    add({ type, label: 'its example', data: t.example }, t.schema);
    for (const [prop, p] of Object.entries(t.schema.properties)) {
      for (const v of edgeValues(p)) add({ type, label: `${prop} set to ${v.label}`, data: { ...t.example, [prop]: v.value } }, t.schema);
    }
    // Everything at its longest at once, and only the required fields.
    const all: Record<string, unknown> = { ...t.example };
    for (const [prop, p] of Object.entries(t.schema.properties)) {
      const first = edgeValues(p)[0];
      if (first) all[prop] = first.value;
    }
    add({ type, label: 'every field at its edge at once', data: all }, t.schema);
    const required = Object.fromEntries(Object.entries(t.example).filter(([k]) => t.schema.required?.includes(k)));
    add({ type, label: 'only its required fields', data: required }, t.schema);
  }
  return cases;
}
