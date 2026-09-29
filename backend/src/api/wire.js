// JSON on the wire (SPEC §7.6). Gateways grade a relay as failed when the
// first 2 KB contain certain error phrases, so no JSON string may contain one
// in its raw bytes. Plain letters are \u-escaped until none does; the decoded
// JSON is unchanged.

// The phrases SAGE looks for in the first 2 KB of a response body, raw bytes,
// ASCII case-insensitive (SPEC §7.6; pokt-network/sage @ 224cf05,
// heuristic/indicators.go and overserved.go). Any one fails the relay:
// supplier phrases penalize the supplier, chain and over-servicing phrases make
// the gateway retry elsewhere, where the same content fails again.
export const PHRASES = [
  // Supplier errors. "gateway timeout" and the "50x ..." forms are covered by these.
  'timeout', 'bad gateway', 'service unavailable', 'connection refused', 'connection reset',
  // Blockchain data errors.
  'missing trie node', 'node is unhealthy', 'block not found', 'header not found', 'state not available',
  'pruned state', 'metadata is not found', 'historical state', 'state has been pruned', 'block has been pruned',
  'is pruned', 'height is not available', 'lowest height is', "haven't been fully indexed", 'not been fully indexed',
  'lite fullnode', 'api is not supported', 'excluded from account secondary indexes',
  // Over-servicing.
  'offchain rate limit hit by relayer proxy', 'session relay limit reached', 'claimable portion fully consumed',
];
const PHRASE = new RegExp(PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
const PHRASE_G = new RegExp(PHRASE.source, 'gi');
const STRING = /"(?:[^"\\]|\\.)*"/g;
// An escape, or one UTF-16 code unit.
const TOKEN = /\\u[0-9a-fA-F]{4}|\\.|[\s\S]/g;
const LETTER = /^[a-zA-Z]$/;
// Bound on re-scan rounds. Each round breaks every phrase currently present by
// \u-escaping a plain letter in it; a round is only needed again if escaping a
// letter's hex nibble happened to form a new phrase across the boundary, which
// converges in 1–2 rounds for any real content. The cap keeps a pathological
// input linear (it can never spin per-letter as the old rescan-per-letter did).
const MAX_ROUNDS = 24;

const escapeToken = (t) => '\\u' + t.charCodeAt(0).toString(16).padStart(4, '0');

// Smallest index k with starts[k] >= x (starts is ascending).
function firstAtOrAfter(starts, x) {
  let lo = 0, hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Escape enough plain letters that the raw bytes contain no forbidden phrase.
// Single left-to-right sweep per round (O(n) matches, each advancing the regex),
// so the whole function is O(rounds * n) rather than the old O(matches * n).
function escapeString(literal) {
  let inner = literal.slice(1, -1);
  if (!PHRASE.test(inner)) return literal;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const tokens = inner.match(TOKEN);
    const starts = new Array(tokens.length);
    let raw = '';
    for (let i = 0; i < tokens.length; i++) { starts[i] = raw.length; raw += tokens[i]; }

    const toEscape = new Set();
    PHRASE_G.lastIndex = 0;
    let m;
    while ((m = PHRASE_G.exec(raw))) {
      const end = m.index + m[0].length;
      // First plain-letter token inside the match — a phrase always spells its
      // letters with real code units (an escape's hex ends in a digit for the
      // ASCII letters phrases use), so there is always one to escape.
      for (let k = firstAtOrAfter(starts, m.index); k < tokens.length && starts[k] < end; k++) {
        if (LETTER.test(tokens[k])) { toEscape.add(k); break; }
      }
      PHRASE_G.lastIndex = m.index + 1; // catch overlapping matches
    }
    if (!toEscape.size) break;

    let out = '';
    for (let i = 0; i < tokens.length; i++) out += toEscape.has(i) ? escapeToken(tokens[i]) : tokens[i];
    inner = out;
  }
  return '"' + inner + '"';
}

export function toWire(value) {
  return JSON.stringify(value).replace(STRING, escapeString);
}
