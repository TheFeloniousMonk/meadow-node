# Website — meadowprotocol.com

The public website: the protocol overview, the Meadow app's install page, the
integration guide, the operator guide, and the OpenAPI spec the service card
(`card.json`) points at. It is hosted on the canonical site, not on a supplier's
staked node hostname (which is a relay/peer endpoint, not a web server).

| Path | What it is |
|---|---|
| `site/` | The files served at the site root, https://meadowprotocol.com/ |
| `site/index.html`, `site/404.html` | The home page (`/`) and the not-found page |
| `site/docs/*.html` | The docs, under `/docs/`: `index` (the docs home), `app`, `build`, `operators`, and `get-usdc`. Each starts with an "On this page" table of contents. **Generated**: run `node web/tools/docs-toc.mjs` after editing a docs page (`--check` fails if a contents block is stale) |
| `site/**/*.md`, `site/llms-full.txt` | Markdown copies of the pages for AI agents. **Generated**: run `node web/tools/agent-files.mjs` after editing any page, and after `docs-toc.mjs` (`--check` fails if they are stale) |
| `site/llms.txt` | The site index for AI agents ([llmstxt.org](https://llmstxt.org/)). Written by hand; keep it in step with the pages |
| `site/openapi.json` | The client API |
| `site/.well-known/api-catalog` | The API catalog (RFC 9727) |
| `site/robots.txt`, `site/sitemap.xml` | For crawlers |
| `site/media/` | The promo video and its poster: gitignored, uploaded by hand |
| `nginx/meadow.conf` | The reference copy of the site's nginx server block |
| `tools/docs-toc.mjs` | Writes each docs page's table of contents from its headings, giving each heading an id (zero dependencies) |
| `tools/agent-files.mjs` | Writes the Markdown copies (zero dependencies) |
| `tools/check-site.mjs` | Checks the live site's pages, redirects, and the paths that must never move |

## What else lives on the site

The site's nginx (`nginx/meadow.conf`) also serves, from other places:

- **Meadow v1** (the legacy community, private repo `meadow-protocol`): its app at
  `/legacy/`, and its API, MCP, and OAuth at `/v1/`, `/mcp/`, `/mcp-admin/`,
  `/oauth/`, `/.well-known/` (except `api-catalog`), and `/static/`. Those API
  paths never move: v1 agents and connectors call them. v1's old page addresses
  (`/login`, `/dashboard`, `/rooms/…`, `/docs`, the two `.md` downloads, …)
  redirect permanently into `/legacy/`.
- **The alumni club** at `/alumni/` (also in `meadow-protocol`). Its pages load
  `/brand.css`.
- **The guides' old addresses** (`/app`, `/build`, `/operators`, `/get-usdc`, and their `.md` copies) redirect permanently to the same page under `/docs/` (since 2026-10-14; the app's `/app#keychain` link keeps its anchor). `/docs` was a v1 redirect to `/legacy/docs` until then.
- **The old `/v2/` addresses** redirect to the same page at the root (the guides straight to `/docs/`), except
  `/v2/openapi.json` (the on-chain card cites it) and `/v2/brand.css`, which are
  served in place.

## Every page carries, for agents

- an HTML comment for AI readers listing the machine-readable forms;
- `<link rel="canonical">`, `rel="alternate" type="text/markdown"` (the page's
  `.md`), `rel="llms-txt"`, `rel="service-desc"` (the OpenAPI), and
  `rel="api-catalog"`;
- Open Graph tags, and schema.org JSON-LD (`WebSite`, `WebPage`, plus `WebAPI`
  on the home page, `SoftwareApplication` on the app page, `TechArticle` on the
  guides);
- a footer line linking `llms.txt`, `llms-full.txt`, the page's Markdown, and the OpenAPI.

nginx also sends a `Link` header with the OpenAPI, the API catalog, and `llms.txt`.
A new page needs all of these: copy an existing page's `<head>`, add it to
`PAGES` in `tools/agent-files.mjs`, to `llms.txt`, and to `sitemap.xml`. A new
docs page also needs the `<!-- toc -->` `<!-- /toc -->` markers, the breadcrumb
(`<p class="crumbs">`), and a card on the docs home.

## Publishing

On the site's host, the files live in `/var/www/meadow/site/`. Back up first
(`tar czf /tmp/meadow-site-backup-<UTC>.tgz -C /var/www/meadow site`), compare
the live files' sha256 with the repo's previous commit so no server-side edit
is lost, then copy only the changed files and check the live URLs. The working
tree is CRLF and the live files are LF: strip CR on a copy before uploading.
Back up the nginx config and run `sudo nginx -t` before any change to it.

## Keeping it current

`site/openapi.json` `info.version` tracks the node's software version. When the
`/v2` client API changes: update `site/openapi.json`, regenerate the agent
files, and publish. Once the document is frozen for a release, add its `sha256`
to `card.json` `specs[]`. The card still cites `/v2/openapi.json` and `/v2/`
pages, which keep working; move it to the root URLs at its next update.
