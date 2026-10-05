// Suppliers staked for the Meadow service, for discovery (SPEC §11.1): from the
// chain indexer, only what changed since the last run when it can, with the
// chain's REST API (LCD) as the fallback.

import { REPLY_LIMITS, readJson } from './read.js';

export const LCD = {
  beta: 'https://sauron-api.beta.infra.pocket.network',
  main: 'https://sauron-api.infra.pocket.network',
};

export const INDEXER = {
  beta: 'https://data.beta.pocket.network/graphql',
  main: 'https://data.pocket.network/graphql',
};

export const SERVICE_ID = 'meadow';

// Supplier records list every service the supplier serves, so they are large
// (23-47 KB each on MainNet, measured 2026-09-30). The list is read 50 at a
// time, each page up to 8 MiB, for at most 40 pages (SPEC §11.1).
export const LCD_PAGING = { perPage: 50, maxPages: 40 };
// The indexer returns only the Meadow service's own config per supplier (about 300 bytes).
export const INDEXER_PAGING = { perPage: 100, maxPages: 50 };
// An indexer this many blocks behind the chain it follows is not used.
export const INDEXER_MAX_LAG = 50;

// { suppliers: [{ operator, urls }], removed: [operator], height, full, source, fallback? }
// `since`: the height an earlier answer gave; then only suppliers whose Meadow service was
// activated or (re)staked after it, or that began unbonding after it, are listed, and those
// no longer staked come back in `removed`. Without `since` the list is complete (`full`).
// When the indexer fails, the LCD's complete list is used and `fallback` says why.
export async function listSuppliers(network, { since = null, indexer = INDEXER[network], base = LCD[network], fetch = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  let fallback = null;
  if (indexer) {
    try {
      return { ...(await indexerSuppliers(network, { since, url: indexer, fetch, timeoutMs })), source: 'indexer' };
    } catch (err) {
      fallback = err.message;
    }
  }
  const suppliers = await lcdSuppliers(network, { base, fetch, timeoutMs });
  return { suppliers, removed: [], height: null, full: true, source: 'chain API', ...(fallback && { fallback }) };
}

const STAKED = 'Staked';
const ENTRY = 'supplierId endpoints supplier { stakeStatus }';

async function graphql(url, query, variables, { fetch, timeoutMs }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await readJson(res, REPLY_LIMITS.lcdPage);
  if (!res.ok || body?.errors?.length || !body?.data) {
    throw new Error(`indexer: ${res.status}${body?.errors?.[0]?.message ? ` ${String(body.errors[0].message).slice(0, 120)}` : ''}`);
  }
  return body.data;
}

export async function indexerSuppliers(network, { since = null, url = INDEXER[network], serviceId = SERVICE_ID, fetch = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  if (!url) throw new Error(`no indexer for network "${network}"`);
  const full = since === null || since === undefined;
  // Complete: every staked supplier's Meadow config. Changed: configs activated after `since`
  // (or not yet activated: a new stake), and suppliers that began unbonding after it.
  const filter = full
    ? '{ serviceId: { equalTo: $service }, supplier: { stakeStatus: { equalTo: Staked } } }'
    : '{ serviceId: { equalTo: $service }, or: [{ activatedAtId: { isNull: true } }, { activatedAtId: { greaterThan: $since } }, { supplier: { unstakingBeginBlockId: { greaterThan: $since } } }] }';
  const query = `query($service: String!, $first: Int!, $after: Cursor${full ? '' : ', $since: BigFloat!'}) {
    _metadata { lastProcessedHeight targetHeight }
    supplierServiceConfigs(filter: ${filter}, first: $first, after: $after, orderBy: ID_ASC) {
      nodes { ${ENTRY} } pageInfo { hasNextPage endCursor }
    }
  }`;
  const suppliers = [];
  const removed = [];
  let height = null;
  let after = null;
  for (let page = 0; page < INDEXER_PAGING.maxPages; page++) {
    const data = await graphql(url, query, { service: serviceId, first: INDEXER_PAGING.perPage, after, ...(!full && { since: String(since) }) }, { fetch, timeoutMs });
    if (page === 0) {
      const m = data._metadata ?? {};
      const processed = Number(m.lastProcessedHeight);
      if (!Number.isSafeInteger(processed)) throw new Error('indexer: no processed height');
      if (Number(m.targetHeight) - processed > INDEXER_MAX_LAG) throw new Error(`indexer: ${Number(m.targetHeight) - processed} blocks behind`);
      height = processed;
    }
    const conn = data.supplierServiceConfigs ?? {};
    for (const n of conn.nodes ?? []) {
      if (typeof n.supplierId !== 'string') continue;
      const urls = (Array.isArray(n.endpoints) ? n.endpoints : []).map((e) => e?.url).filter((u) => typeof u === 'string');
      if (n.supplier?.stakeStatus === STAKED && urls.length) suppliers.push({ operator: n.supplierId, urls });
      else removed.push(n.supplierId);
    }
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return { suppliers, removed, height, full };
}

// [{ operator, urls }] for suppliers staked for `serviceId` on `network` and
// not unbonding, from the LCD.
export async function lcdSuppliers(network, { base = LCD[network], serviceId = SERVICE_ID, fetch = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  if (!base) throw new Error(`no chain API for network "${network}"`);
  const root = `${base.replace(/\/+$/, '')}/pokt-network/poktroll/supplier/supplier?service_id=${encodeURIComponent(serviceId)}&pagination.limit=${LCD_PAGING.perPage}`;
  const suppliers = [];
  let key = null;
  for (let page = 0; page < LCD_PAGING.maxPages; page++) {
    const url = key ? `${root}&pagination.key=${encodeURIComponent(key)}` : root;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`chain API ${network}: ${res.status}`);
    const body = await readJson(res, REPLY_LIMITS.lcdPage);
    // Keep only what discovery needs from each page, so the large records are let go at once.
    for (const s of body.supplier ?? []) {
      if (Number(s.unstake_session_end_height ?? 0)) continue;
      const urls = (s.services ?? []).filter((x) => x.service_id === serviceId).flatMap((x) => (x.endpoints ?? []).map((e) => e.url));
      if (urls.length) suppliers.push({ operator: s.operator_address, urls });
    }
    key = body.pagination?.next_key;
    if (!key) break;
  }
  return suppliers;
}
