// Suppliers staked for the Meadow service, from the chain's REST API (LCD).
// Used by discovery (SPEC §11.1).

import { REPLY_LIMITS, readJson } from './read.js';

export const LCD = {
  beta: 'https://sauron-api.beta.infra.pocket.network',
  main: 'https://sauron-api.infra.pocket.network',
};

export const SERVICE_ID = 'meadow';

// Supplier records list every service the supplier serves, so they are large
// (23-47 KB each on MainNet, measured 2026-09-30). The list is read 50 at a
// time, each page up to 8 MiB, for at most 40 pages (SPEC §11.1).
export const LCD_PAGING = { perPage: 50, maxPages: 40 };

// [{ operator, urls }] for suppliers staked for `serviceId` on `network` and
// not unbonding.
export async function listSuppliers(network, { base = LCD[network], serviceId = SERVICE_ID, fetch = globalThis.fetch, timeoutMs = 20_000 } = {}) {
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
