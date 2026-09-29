// A stand-in for the agentic portal, for tests only: x402 version 2 as the
// real portal serves it (checked live 2026-09-29), in front of a node running
// in this process. It quotes with PAYMENT-REQUIRED, and on a paid retry checks
// the payload as a facilitator would (signature recovered with viem, terms,
// amount, payee, validity window) before forwarding the call and wrapping the
// answer as {portal, data}.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { recoverTypedDataAddress } from 'viem';
import { createServer } from '../../backend/src/server.js';
import { Store } from '../../backend/src/store/store.js';

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const PAY_TO = '0xF732ea490c5766071785a2310523f7fA2CEbB829';

export interface MockPortal {
  url: string;
  catalogUrl: string;
  price: { usd: string; amount: string };
  /** Overrides for the quoted terms (to test the guard), or 'always402' to refuse every payment. */
  quote: Partial<{ amount: string; payTo: string; asset: string; network: string; scheme: string }>;
  always402: boolean;
  catalogPriceUsd: string;
  paid: { from: string; value: string; nonce: string }[];
  close(): Promise<void>;
}

export async function startMockPortal(): Promise<MockPortal> {
  const node: any = createServer(new Store(), { network: 'main', version: 'test' });
  await new Promise<void>((r) => node.listen(0, '127.0.0.1', r));
  const nodeUrl = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
  const seen = new Set<string>();

  const m: MockPortal = {
    url: '', catalogUrl: '', price: { usd: '0.005000', amount: '5000' }, quote: {}, always402: false, catalogPriceUsd: '0.005000', paid: [],
    close: async () => {
      server.close();
      node.close();
    },
  };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/services.json') {
      const rail = { id: 'base', network: 'eip155:8453', chainId: 8453, tokenAddress: USDC, tokenDecimals: 6, payToAddress: PAY_TO };
      return send(200, {
        registryVersion: 'test', services: [
          { serviceId: 'meadow', displayName: 'Meadow Protocol', resourceUrl: `${m.url}/v1/meadow`, priceUsd: m.catalogPriceUsd, rails: [rail] },
          { serviceId: 'prompt-injection-detect', displayName: 'Prompt Injection Detection', resourceUrl: `${m.url}/v1/prompt-injection-detect`, priceUsd: m.catalogPriceUsd, rails: [rail] },
        ],
      });
    }
    const match = /^\/v1\/meadow(\/.*)$/.exec(req.url ?? '');
    if (!match || req.method !== 'POST') return send(404, { error: 'not found' });
    const terms = {
      scheme: 'exact', network: 'eip155:8453', amount: m.price.amount, asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2' }, ...m.quote,
    };
    const offer = { x402Version: 2, resource: { url: `${m.url}/v1/meadow`, serviceName: 'Pocket Network' }, accepts: [terms] };
    const quote = () => send(402, offer, { 'payment-required': Buffer.from(JSON.stringify(offer), 'utf8').toString('base64') });
    const header = req.headers['payment-signature'];
    if (typeof header !== 'string') return quote();
    if (m.always402) return send(402, { error: 'payment_rejected' });

    // What a facilitator checks before it settles.
    const p = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const a = p.payload?.authorization;
    const fail = (why: string) => send(402, { error: why });
    if (p.x402Version !== 2 || JSON.stringify(p.accepted) !== JSON.stringify(terms)) return fail('accepted differs from the quote');
    if (a.to.toLowerCase() !== PAY_TO.toLowerCase() || a.value !== terms.amount) return fail('wrong payee or amount');
    const now = Math.floor(Date.now() / 1000);
    if (!(Number(a.validAfter) <= now && now < Number(a.validBefore))) return fail('outside the validity window');
    if (seen.has(a.nonce)) return fail('nonce reused');
    const signer = await recoverTypedDataAddress({
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
      types: { TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
      primaryType: 'TransferWithAuthorization',
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
      signature: p.payload.signature,
    });
    if (signer.toLowerCase() !== a.from.toLowerCase()) return fail('bad signature');
    seen.add(a.nonce);
    m.paid.push({ from: a.from, value: a.value, nonce: a.nonce });

    const upstream = await fetch(nodeUrl + match[1], { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const data = await upstream.json();
    send(upstream.status, { portal: { provenance: 'test', serviceId: 'meadow' }, data }, {
      'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:8453' })).toString('base64'),
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  m.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  m.catalogUrl = `${m.url}/services.json`;
  return m;
}
