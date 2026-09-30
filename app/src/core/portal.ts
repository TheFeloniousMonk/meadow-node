// The app's one transport (SPEC §16.1, §16.9): calls to services through the
// PNF agentic portal, paid per call with x402 version 2. The URL of every call
// is the catalog's resourceUrl for the service plus the endpoint path, so the
// core only ever pays for a call it is making itself (§16.9 check 1). A 402's
// terms go through the spend guard; a second 402 in answer to a paid retry is
// a failure, never a new round. The portal wraps a service's answer as
// {portal, data}; callers get `data`.

import type { Catalog } from './catalog.ts';
import { formatUsd } from './catalog.ts';
import { TransportError, type CallResult, type Transport } from './transport.ts';
import type { Wallets } from './wallets.ts';
import { REPLY_LIMITS, ReplyTooLarge, readJson } from './deps.ts';

export const MEADOW_SERVICE = 'meadow';

const decode = (header: string | null): any => {
  if (!header) return undefined;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
};

export class PortalTransport implements Transport {
  #catalog: Catalog;
  #wallets: Wallets;
  #fetch: typeof fetch;

  constructor({ catalog, wallets, fetchImpl = fetch }: { catalog: Catalog; wallets: Wallets; fetchImpl?: typeof fetch }) {
    this.#catalog = catalog;
    this.#wallets = wallets;
    this.#fetch = fetchImpl;
  }

  call(path: string, body: unknown, agent: string | null): Promise<CallResult> {
    return this.callService(MEADOW_SERVICE, path, body, agent);
  }

  async callService(serviceId: string, path: string, body: unknown, agent: string | null): Promise<CallResult> {
    try {
      await this.#catalog.ensureFresh();
    } catch {
      if (!this.#catalog.fetchedAt) throw new TransportError('network', 'The app could not read the portal\'s price list, so it did not make the call.');
    }
    const service = this.#catalog.service(serviceId);
    if (!service) throw new TransportError('refused', `${serviceId} is not in the portal's price list, so the app will not call it.`);
    const url = service.resourceUrl + path;
    const json = JSON.stringify(body);

    let res = await this.#post(url, json);
    let cost: CallResult['cost'];
    if (res.status === 402) {
      const offer = decode(res.headers.get('payment-required')) ?? (await readJson(res, REPLY_LIMITS.portal).catch(() => undefined));
      let paid;
      try {
        paid = this.#wallets.authorize({ agent, serviceId, path, offer });
      } catch (err) {
        // Terms that do not match may mean a price or rail changed since the catalog was read: read it again, once.
        if (!(err instanceof TransportError) || !err.catalogMismatch) throw err;
        await this.#catalog.refresh().catch(() => {});
        paid = this.#wallets.authorize({ agent, serviceId, path, offer });
      }
      res = await this.#post(url, json, { 'payment-signature': paid.header });
      const settlement = decode(res.headers.get('payment-response'));
      if (res.status === 402) {
        const why = ((await readJson(res, REPLY_LIMITS.portal).catch(() => undefined)) as any)?.error ?? 'no reason given';
        this.#wallets.failed(paid.seq, typeof why === 'string' ? why : JSON.stringify(why));
        throw new TransportError('http', `The portal did not accept the payment (${typeof why === 'string' ? why : 'see the Wallets screen'}). Nothing more was signed for this call.`);
      }
      if (settlement?.success === true) this.#wallets.settled(paid.seq, settlement.transaction);
      else this.#wallets.failed(paid.seq, settlement?.errorReason ?? `no settlement (HTTP ${res.status})`);
      cost = { usd: formatUsd(paid.amount, paid.decimals), wallet: paid.wallet };
    }

    let parsed: any;
    try {
      parsed = await readJson(res, REPLY_LIMITS.portal);
    } catch (err) {
      // An answer past the limit is refused unread (§16.8): no node answers more than 4 MiB.
      if (err instanceof ReplyTooLarge) throw new TransportError('http', `The portal answered with more than ${REPLY_LIMITS.portal / 1048576} MiB, which no node sends. The answer was not read.`);
      throw new TransportError('http', `The portal answered ${res.status} with something that is not JSON.`);
    }
    const data = parsed && typeof parsed === 'object' && 'portal' in parsed && 'data' in parsed ? parsed.data : parsed;
    return { status: res.status, data, ...(cost && { cost }) };
  }

  async #post(url: string, json: string, headers: Record<string, string> = {}): Promise<Response> {
    try {
      return await this.#fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: json });
    } catch {
      throw new TransportError('network', 'The app could not reach the portal. Check the internet connection.');
    }
  }
}
