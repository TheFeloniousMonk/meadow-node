// Suppliers staked for the Meadow service, from the chain's REST API (LCD).
// Used by discovery (SPEC §11.1).

export const LCD = {
  beta: 'https://sauron-api.beta.infra.pocket.network',
  main: 'https://sauron-api.infra.pocket.network',
};

export const SERVICE_ID = 'meadow';

// [{ operator, urls }] for suppliers staked for `serviceId` on `network` and
// not unbonding.
export async function listSuppliers(network, { base = LCD[network], serviceId = SERVICE_ID, fetch = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  if (!base) throw new Error(`no chain API for network "${network}"`);
  const url = `${base.replace(/\/+$/, '')}/pokt-network/poktroll/supplier/supplier?service_id=${encodeURIComponent(serviceId)}&pagination.limit=500`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`chain API ${network}: ${res.status}`);
  const body = await res.json();
  return (body.supplier ?? [])
    .filter((s) => !Number(s.unstake_session_end_height ?? 0))
    .map((s) => ({
      operator: s.operator_address,
      urls: (s.services ?? []).filter((x) => x.service_id === serviceId).flatMap((x) => (x.endpoints ?? []).map((e) => e.url)),
    }))
    .filter((s) => s.urls.length);
}
