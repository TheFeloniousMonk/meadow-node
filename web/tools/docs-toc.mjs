#!/usr/bin/env node
// Writes the "On this page" table of contents at the top of every docs page
// (web/site/docs/*.html), between <!-- toc --> and <!-- /toc -->, from the
// page's <h2> and <h3> headings inside <main>. A heading without an id gets one
// from its text. Run it after editing a docs page, before agent-files.mjs;
// `--check` fails if a contents block is stale. Zero dependencies.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'docs');
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&(#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)).trim();
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'section';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const check = process.argv.includes('--check');
let stale = 0;
for (const name of readdirSync(DOCS).filter((f) => f.endsWith('.html'))) {
  const file = join(DOCS, name);
  const raw = readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let html = raw.replace(/\r\n/g, '\n');
  if (!html.includes('<!-- toc -->')) { console.error(`no <!-- toc --> marker: web/site/docs/${name}`); stale++; continue; }

  // Give every h2/h3 in <main> an id, keeping the ones it has.
  const [before, rest] = html.split(/(?=<main)/);
  const [main, after] = rest.split(/(?<=<\/main>)/);
  const used = new Set([...main.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const items = [];
  const body = main.replace(/<(h[23])((?:\s[^>]*)?)>([\s\S]*?)<\/\1>/g, (m, tag, attrs, inner) => {
    if (/class="[^"]*\bno-toc\b/.test(attrs)) return m;
    let id = attrs.match(/\sid="([^"]+)"/)?.[1];
    if (!id) {
      const base = slug(text(inner)); id = base;
      for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
      used.add(id);
      attrs += ` id="${id}"`;
    }
    items.push({ level: tag === 'h2' ? 2 : 3, id, label: text(inner) });
    return `<${tag}${attrs}>${inner}</${tag}>`;
  });

  // Nested list: h3s under the h2 before them.
  const groups = [];
  for (const it of items) {
    if (it.level === 3 && groups.length) groups.at(-1).kids.push(it);
    else groups.push({ ...it, kids: [] });
  }
  const link = (it) => `<a href="#${it.id}">${esc(it.label)}</a>`;
  let list = '';
  for (const g of groups) {
    list += g.kids.length
      ? `      <li>${link(g)}\n        <ol>\n${g.kids.map((k) => `          <li>${link(k)}</li>\n`).join('')}        </ol>\n      </li>\n`
      : `      <li>${link(g)}</li>\n`;
  }
  const toc = `<!-- toc -->\n  <nav class="toc" aria-label="On this page">\n    <p class="toc-title">On this page</p>\n    <ol>\n${list}    </ol>\n  </nav>\n  <!-- /toc -->`;  let out = before + body.replace(/<!-- toc -->[\s\S]*?<!-- \/toc -->/, toc) + after;
  if (crlf) out = out.replace(/\n/g, '\r\n');
  if (out === raw) continue;
  if (check) { console.error(`stale contents: web/site/docs/${name}`); stale++; continue; }
  writeFileSync(file, out);
  console.log(`wrote contents: web/site/docs/${name}`);
}
if (stale) { console.error('Run: node web/tools/docs-toc.mjs'); process.exit(1); }
