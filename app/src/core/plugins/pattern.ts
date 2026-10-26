// Plugin schema patterns (SPEC §16.26.3): a small dialect matched in linear time, never with
// JavaScript's backtracking RegExp, since a plugin's pattern runs on other agents' messages in the
// main process, and a pathological regex could stall it. The whole string must match.
//
//   atom       .  literal  \d \w \s \D \W \S  \<punctuation>  [class]  [^class]
//   quantifier ?  *  +  {n}  {n,}  {n,m}      (n, m at most 2048)
//
// No groups, alternation, anchors, backreferences, or lookaround.

export class PatternError extends Error {}

type Test = (c: number) => boolean;
export interface Atom {
  test: Test;
  min: number;
  max: number; // Infinity for unbounded
}

const MAX_REPEAT = 2048;
const MAX_ATOMS = 32;
const PUNCT = new Set('\\.^$|?*+()[]{}-/'.split(''));

const isDigit: Test = (c) => c >= 48 && c <= 57;
const isWord: Test = (c) => isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isSpace: Test = (c) => c === 32 || (c >= 9 && c <= 13);
const CLASSES: Record<string, Test> = { d: isDigit, w: isWord, s: isSpace, D: (c) => !isDigit(c), W: (c) => !isWord(c), S: (c) => !isSpace(c) };

/** Compiles a pattern; throws PatternError with what is not allowed. */
export function compilePattern(src: string): Atom[] {
  if (typeof src !== 'string' || !src || src.length > 200) throw new PatternError('A pattern must be 1 to 200 characters.');
  const cs = [...src];
  const atoms: Atom[] = [];
  let i = 0;
  const escape = (): Test => {
    const e = cs[++i];
    if (e === undefined) throw new PatternError('A pattern ends with a lone backslash.');
    if (CLASSES[e]) return CLASSES[e];
    if (PUNCT.has(e)) {
      const code = e.codePointAt(0)!;
      return (c) => c === code;
    }
    throw new PatternError(`\\${e} is not allowed in a pattern.`);
  };
  while (i < cs.length) {
    const ch = cs[i];
    let test: Test;
    if (ch === '.') test = (c) => c !== 10 && c !== 13;
    else if (ch === '\\') test = escape();
    else if (ch === '[') {
      const parts: Test[] = [];
      let negate = false;
      i++;
      if (cs[i] === '^') {
        negate = true;
        i++;
      }
      while (i < cs.length && cs[i] !== ']') {
        let lo: Test | number;
        if (cs[i] === '\\') lo = escape();
        else lo = cs[i].codePointAt(0)!;
        if (typeof lo === 'number' && cs[i + 1] === '-' && cs[i + 2] !== undefined && cs[i + 2] !== ']') {
          i += 2;
          if (cs[i] === '\\') throw new PatternError('A class range cannot end in an escape.');
          const from = lo;
          const to = cs[i].codePointAt(0)!;
          if (to < from) throw new PatternError('A class range runs backwards.');
          parts.push((c) => c >= from && c <= to);
        } else if (typeof lo === 'number') {
          const code = lo;
          parts.push((c) => c === code);
        } else parts.push(lo);
        i++;
      }
      if (cs[i] !== ']' || !parts.length) throw new PatternError('A character class is not closed, or is empty.');
      test = negate ? (c) => !parts.some((p) => p(c)) : (c) => parts.some((p) => p(c));
    } else if ('^$|()?*+{}'.includes(ch)) throw new PatternError(`"${ch}" is not allowed here: patterns have no groups, alternatives, or anchors.`);
    else {
      const code = ch.codePointAt(0)!;
      test = (c) => c === code;
    }
    i++;
    let min = 1;
    let max = 1;
    const q = cs[i];
    if (q === '?') [min, max, i] = [0, 1, i + 1];
    else if (q === '*') [min, max, i] = [0, Infinity, i + 1];
    else if (q === '+') [min, max, i] = [1, Infinity, i + 1];
    else if (q === '{') {
      const m = /^\{(\d{1,4})(,(\d{0,4}))?\}/.exec(cs.slice(i).join(''));
      if (!m) throw new PatternError('A {n,m} count is not written right.');
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      if (min > MAX_REPEAT || (max !== Infinity && (max > MAX_REPEAT || max < min))) throw new PatternError('A count is out of range.');
      i += m[0].length;
    }
    if (cs[i] !== undefined && '?*+{'.includes(cs[i])) throw new PatternError('Two quantifiers in a row are not allowed.');
    atoms.push({ test, min, max });
    if (atoms.length > MAX_ATOMS) throw new PatternError(`A pattern may have at most ${MAX_ATOMS} parts.`);
  }
  return atoms;
}

/**
 * Whether the whole string matches: a set of states (atom, repeats so far) stepped once per
 * character, so the time is the string's length times a bounded number of states.
 */
export function matchPattern(atoms: Atom[], s: string): boolean {
  // A state is atom index k with c repeats of atom k taken; c is capped at min(k) once max is unbounded.
  const key = (k: number, c: number) => k * (MAX_REPEAT + 2) + c;
  const close = (states: Set<number>) => {
    // Add the states reachable without reading a character: leaving an atom once its minimum is met.
    const stack = [...states];
    while (stack.length) {
      const st = stack.pop()!;
      const k = Math.floor(st / (MAX_REPEAT + 2));
      const c = st % (MAX_REPEAT + 2);
      if (k < atoms.length && c >= atoms[k].min) {
        const next = key(k + 1, 0);
        if (!states.has(next)) {
          states.add(next);
          stack.push(next);
        }
      }
    }
    return states;
  };
  let states = close(new Set([key(0, 0)]));
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    const next = new Set<number>();
    for (const st of states) {
      const k = Math.floor(st / (MAX_REPEAT + 2));
      const c = st % (MAX_REPEAT + 2);
      if (k >= atoms.length) continue;
      const a = atoms[k];
      if (c < a.max && a.test(code)) next.add(key(k, a.max === Infinity ? Math.min(c + 1, a.min) : c + 1));
    }
    if (!next.size) return false;
    states = close(next);
  }
  return states.has(key(atoms.length, 0));
}
