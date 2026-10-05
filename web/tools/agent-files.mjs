#!/usr/bin/env node
// Writes the agent-readable copies of the site: one Markdown file per page
// (<page>.md next to <page>.html) and llms-full.txt (llms.txt's summary, then
// every page). Run it after editing any page; `--check` fails if they are stale.
// Zero dependencies: the pages are our own simple HTML, so a small parser does.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const BASE = 'https://meadowprotocol.com';
// Order of llms-full.txt; [file, public path].
const PAGES = [
  ['index', '/'],
  ['app', '/app'],
  ['get-usdc', '/get-usdc'],
  ['build', '/build'],
  ['operators', '/operators'],
];

const VOID = new Set(['br', 'img', 'source', 'meta', 'link', 'hr', 'input', 'wbr']);
const SKIP = new Set(['script', 'style', 'figure', 'button', 'video', 'svg']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←', middot: '·', times: '×', copy: '©' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    : (ENTITIES[e.toLowerCase()] ?? m));

// HTML -> tree of {tag, attrs, children} and text strings.
function parse(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith('<!--')) continue;
    if (m[5] !== undefined) { top.children.push(decode(m[5])); continue; }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const i = stack.map((n) => n.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    const node = { tag, attrs, children: [] };
    top.children.push(node);
    if (!VOID.has(tag) && !m[4]) stack.push(node);
  }
  return root;
}

const cls = (n) => (n.attrs?.class ?? '').split(/\s+/);
const textOf = (n) => typeof n === 'string' ? n : n.children.map(textOf).join('');

function href(h, page) {
  if (!h) return '';
  if (h.startsWith('#')) return BASE + page + h;
  if (h.startsWith('/')) return BASE + h;
  return h;
}

function inline(nodes, page) {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') { out += n.replace(/\s+/g, ' '); continue; }
    if (SKIP.has(n.tag)) continue;
    const inner = () => inline(n.children, page);
    switch (n.tag) {
      case 'a': { const t = inner().trim(); out += `[${t}](${href(n.attrs.href, page)})`; break; }
      case 'code': out += '`' + textOf(n) + '`'; break;
      case 'strong': case 'b': { const t = inner().trim(); out += t ? `**${t}**` : ''; break; }
      case 'em': case 'i': { const t = inner().trim(); out += t ? `*${t}*` : ''; break; }
      case 'br': out += '  \n'; break;
      default: out += inner();
    }
  }
  return out;
}

const clean = (s) => s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();

function blocks(nodes, page, depth = 0) {
  const out = [];
  let run = [];
  const flush = () => { const t = clean(inline(run, page)); if (t) out.push(t); run = []; };
  for (const n of nodes) {
    if (typeof n === 'string' || !isBlock(n)) { run.push(n); continue; }
    flush();
    if (SKIP.has(n.tag)) continue;
    const c = cls(n);
    if (/^h[1-6]$/.test(n.tag)) {
      out.push('#'.repeat(Number(n.tag[1])) + ' ' + clean(inline(n.children, page)));
    } else if (n.tag === 'p') {
      const t = clean(inline(n.children, page)); if (t) out.push(t);
    } else if (n.tag === 'ul' || n.tag === 'ol') {
      out.push(list(n, page, depth));
    } else if (n.tag === 'pre') {
      out.push('```\n' + textOf(n).replace(/^\n/, '').replace(/\s+$/, '') + '\n```');
    } else if (n.tag === 'table') {
      out.push(table(n, page));
    } else if (n.tag === 'dl') {
      let dt = '';
      for (const k of n.children) {
        if (typeof k === 'string') continue;
        if (k.tag === 'dt') dt = clean(inline(k.children, page));
        if (k.tag === 'dd') out.push(`**${dt}**: ${clean(inline(k.children, page))}`);
      }
    } else if (c.includes('callout')) {
      out.push(blocks(n.children, page, depth).split('\n').map((l) => '> ' + l).join('\n').replace(/> $/gm, '>'));
    } else if (c.includes('cards')) {
      const items = n.children.filter((k) => typeof k !== 'string' && k.tag === 'a').map((a) => {
        const title = textOf(a.children.find((k) => k.tag === 'strong') ?? '').replace(/\s*→\s*$/, '').trim();
        const desc = clean(inline(a.children.filter((k) => k.tag !== 'strong'), page));
        return `- [${title}](${href(a.attrs.href, page)})${desc ? ': ' + desc : ''}`;
      });
      out.push(items.join('\n'));
    } else if (c.includes('prompt-head')) {
      const t = textOf(n.children.find((k) => k.tag === 'strong') ?? '').trim();
      if (t) out.push(`**${t}:**`);
    } else {
      const t = blocks(n.children, page, depth); if (t) out.push(t);
    }
  }
  flush();
  return out.join('\n\n');
}

const BLOCK = new Set(['p', 'ul', 'ol', 'li', 'pre', 'table', 'div', 'section', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dl', 'dt', 'dd', 'script', 'style', 'blockquote', 'details', 'summary', 'nav', 'header', 'footer', 'video']);
const isBlock = (n) => BLOCK.has(n.tag);

function list(n, page, depth) {
  const ordered = n.tag === 'ol';
  let i = Number(n.attrs.start ?? 1);
  const pad = '   '.repeat(depth);
  return n.children.filter((k) => typeof k !== 'string' && k.tag === 'li').map((li) => {
    const mark = ordered ? `${i++}.` : '-';
    const body = blocks(li.children, page, depth + 1);
    const [first, ...rest] = body.split('\n');
    return pad + mark + ' ' + first + rest.map((l) => '\n' + (l && !l.startsWith(pad + '   ') ? pad + '   ' : '') + l).join('');
  }).join('\n');
}

function table(n, page) {
  const rows = [];
  const walk = (k) => { if (typeof k === 'string') return; if (k.tag === 'tr') rows.push(k); else k.children.forEach(walk); };
  walk(n);
  const cells = rows.map((r) => r.children.filter((k) => typeof k !== 'string' && (k.tag === 'td' || k.tag === 'th'))
    .map((c) => clean(inline(c.children, page)).replace(/\|/g, '\\|').replace(/\n/g, ' ')));
  if (!cells.length) return '';
  const w = Math.max(...cells.map((r) => r.length));
  const line = (r) => '| ' + Array.from({ length: w }, (_, i) => r[i] ?? '').join(' | ') + ' |';
  return [line(cells[0]), line(Array(w).fill('---')), ...cells.slice(1).map(line)].join('\n');
}

function pageMarkdown(file, path) {
  const html = readFileSync(join(SITE, file + '.html'), 'utf8').replace(/\r/g, '');
  const title = decode(html.match(/<title>([^<]*)<\/title>/)[1]);
  const desc = decode(html.match(/<meta name="description" content="([^"]*)">/)[1]);
  const main = html.match(/<main[^>]*>([\s\S]*)<\/main>/)[1];
  const body = blocks(parse(main).children, path);
  return `<!-- ${title}. Markdown copy of ${BASE}${path}, generated from the page. -->\n\n> ${desc}\n\n${body}\n`;
}

const outputs = {};
const parts = [];
for (const [file, path] of PAGES) {
  const md = pageMarkdown(file, path);
  outputs[file + '.md'] = md;
  parts.push(`<!-- ${BASE}${path} -->\n\n` + md.replace(/^<!--.*-->\n\n/, ''));
}
const llms = readFileSync(join(SITE, 'llms.txt'), 'utf8').replace(/\r/g, '');
const intro = llms.split(/\n## /)[0].trim();
outputs['llms-full.txt'] = intro + '\n\nThis file holds every page of ' + BASE + ' as Markdown, in this order: ' +
  PAGES.map(([, p]) => BASE + p).join(', ') + '. The machine-readable API is ' + BASE + '/openapi.json.\n\n' +
  parts.join('\n---\n\n');

const check = process.argv.includes('--check');
let stale = 0;
for (const [name, text] of Object.entries(outputs)) {
  const file = join(SITE, name);
  const old = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r/g, '') : null;
  if (old === text) continue;
  if (check) { console.error(`stale: web/site/${name}`); stale++; continue; }
  writeFileSync(file, text);
  console.log(`wrote web/site/${name}`);
}
if (stale) { console.error('Run: node web/tools/agent-files.mjs'); process.exit(1); }
