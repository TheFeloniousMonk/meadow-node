#!/usr/bin/env node
// Checks meadowprotocol.com's routing: every page, every old address and its
// redirect, the agent files, and the v1 API, MCP, OAuth, and alumni paths that
// must never move. Usage: node web/tools/check-site.mjs [base-url]
const BASE = (process.argv[2] ?? 'https://meadowprotocol.com').replace(/\/$/, '');

// [path, expected status, expected Location (redirects) or content-type prefix]
const CHECKS = [
  // The website
  ['/', 200, 'text/html'],
  ['/app', 200, 'text/html'],
  ['/build', 200, 'text/html'],
  ['/operators', 200, 'text/html'],
  ['/get-usdc', 200, 'text/html'],
  ['/brand.css', 200, 'text/css'],
  ['/favicon.svg', 200, 'image/svg+xml'],
  ['/openapi.json', 200, 'application/json'],
  ['/llms.txt', 200, 'text/plain'],
  ['/llms-full.txt', 200, 'text/plain'],
  ['/index.md', 200, 'text/markdown'],
  ['/app.md', 200, 'text/markdown'],
  ['/build.md', 200, 'text/markdown'],
  ['/operators.md', 200, 'text/markdown'],
  ['/get-usdc.md', 200, 'text/markdown'],
  ['/robots.txt', 200, 'text/plain'],
  ['/sitemap.xml', 200, ''],
  ['/.well-known/api-catalog', 200, 'application/linkset+json'],
  ['/media/meadow-v2-poster.jpg', 200, 'image/jpeg'],
  ['/no-such-page', 404, 'text/html'],
  // Old /v2/ addresses
  ['/v2', 301, '/'],
  ['/v2/', 301, '/'],
  ['/v2/app', 301, '/app'],
  ['/v2/build', 301, '/build'],
  ['/v2/operators', 301, '/operators'],
  ['/v2/get-usdc', 301, '/get-usdc'],
  ['/v2/openapi.json', 200, 'application/json'],
  ['/v2/brand.css', 200, 'text/css'],
  // Meadow v1, now at /legacy/
  ['/legacy', 301, '/legacy/'],
  ['/legacy/', 200, 'text/html'],
  ['/legacy/login', 200, 'text/html'],
  ['/legacy/docs', 200, 'text/html'],
  ['/legacy/llms.txt', 200, 'text/plain'],
  ['/legacy/meadow-full-onboarding.md', 200, ''],
  ['/legacy/meadow-connect-your-construct.md', 200, ''],
  // Old v1 page addresses
  ['/login', 301, '/legacy/login'],
  ['/register', 301, '/legacy/register'],
  ['/support', 301, '/legacy/support'],
  ['/reset-password?token=abc', 301, '/legacy/reset-password?token=abc'],
  ['/docs', 301, '/legacy/docs'],
  ['/guide', 301, '/legacy/guide'],
  ['/dashboard', 301, '/legacy/dashboard'],
  ['/dashboard?tab=trust', 301, '/legacy/dashboard?tab=trust'],
  ['/profile', 301, '/legacy/profile'],
  ['/moderation', 301, '/legacy/moderation'],
  ['/rooms/r_example', 301, '/legacy/rooms/r_example'],
  ['/agents/new', 301, '/legacy/agents/new'],
  ['/agents/a_example', 301, '/legacy/agents/a_example'],
  ['/meadow-full-onboarding.md', 301, '/legacy/meadow-full-onboarding.md'],
  ['/meadow-connect-your-construct.md', 301, '/legacy/meadow-connect-your-construct.md'],
  // Must never move: v1 API, MCP, OAuth, and the alumni club
  ['/v1/', 200, 'application/json'],
  ['/v1/docs', 200, 'application/json'],
  ['/.well-known/oauth-authorization-server', 200, 'application/json'],
  ['/mcp/sse', 401, 'application/json'],
  ['/alumni', 301, '/alumni/'],
  ['/alumni/', 200, 'text/html'],
];

let failed = 0;
for (const [path, status, expect] of CHECKS) {
  let res;
  try {
    res = await fetch(BASE + path, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  } catch (e) {
    console.log(`FAIL ${path}: ${e.message}`); failed++; continue;
  }
  await res.body?.cancel();
  const loc = res.headers.get('location') ?? '';
  const type = res.headers.get('content-type') ?? '';
  let ok = res.status === status;
  if (ok && status >= 300 && status < 400) ok = loc === expect || loc === BASE + expect;
  else if (ok && expect) ok = type.startsWith(expect);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${path} -> ${res.status}${loc ? ' ' + loc : ''}${type ? ' (' + type + ')' : ''}${ok ? '' : `   expected ${status} ${expect}`}`);
}
console.log(failed ? `\n${failed} of ${CHECKS.length} failed` : `\nall ${CHECKS.length} passed`);
process.exit(failed ? 1 : 0);
