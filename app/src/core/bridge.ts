// Moving USDC to Base (SPEC §16.9.3). The finder (§16.9.2) tells the person
// that USDC sent on another network is still theirs; this brings it to Base.
// The wallet holds no gas on that network, and must never need any:
//
// - Native USDC (Ethereum, Arbitrum, Polygon, Optimism when offered) goes
//   through Relay. The wallet signs one EIP-3009 ReceiveWithAuthorization on
//   that network's USDC, usable only by Relay's pinned approvalProxy; Relay's
//   solvers pay every network fee and take theirs from the USDC. If a move
//   fails, Relay refunds it to this wallet on the original network.
// - USDbC (on Base) goes through CoW Protocol: one approval transaction (for
//   exactly the amount; its fee in ETH, bought with a little Base USDC as Move
//   money does, §16.9.1), then a signed order selling all of it for USDC to
//   this same wallet, with a minimum the guard checks.
//
// Nothing here is a payment: it never counts against a budget, and only the
// person, from the window, can start it. Every quote passes the guard before
// anything is signed, and refusals are in plain words.

import type { Db } from './db.ts';
import { BASE, USDC, formatUsd } from './catalog.ts';
import { ethBalance, tokenBalance, type RpcOptions } from './balance.ts';
import { ELSEWHERE, type ElsewhereToken } from './elsewhere.ts';
import { COW, type Mover } from './move.ts';
import { cowOrderDigest, erc20ApproveData, keccakHex, receiveDigest, sameAddress, signDigest, type Authorization, type CowOrder, type Hex } from './evm.ts';
import type { Wallets } from './wallets.ts';
import { REPLY_LIMITS, readJson } from './deps.ts';

export const RELAY_API = 'https://api.relay.link';
/** Relay's approvalProxy, the same on all six networks (its chains API, read 2026-10-01). */
export const RELAY_PROXY: Hex = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
/** The authorization may live no longer than this. */
export const MAX_VALID_S = 30 * 60;
/** Above this share in fees, the dialog says so in bold; past half, the move is refused. */
export const HIGH_FEE = 0.05;
/** How long the app follows a move before saying it does not know yet. */
const FOLLOW_MS = 30 * 60 * 1000;
const USDBC_SLIPPAGE_PCT = 1n;
/** A USDbC quote that buys less than this share of what it sells is refused (they are both dollars). */
const USDBC_MIN_PCT = 95n;
const ORDER_LIFE_S = 20 * 60;

export class BridgeError extends Error {}
const refuse = (m: string): never => {
  throw new BridgeError(m);
};

/**
 * The finds that can be moved: native USDC with a gasless authorization (Ethereum, Arbitrum,
 * Optimism, Polygon), and USDbC on Base. BNB Smart Chain's USDC (18 decimals, no EIP-3009) and
 * the older bridged USDC need gas on their own network: not yet (§17 q12).
 */
export function movable(network: string, kind: string): ElsewhereToken | null {
  return ELSEWHERE.find((t) => t.network === network && t.kind === kind && (t.kind === 'usdbc' || (t.kind === 'usdc' && t.chainId !== 56))) ?? null;
}

export interface BridgePlan {
  network: string;
  kind: 'usdc' | 'usdbc';
  route: 'relay' | 'cow';
  amount: bigint;
  amountUsd: string;
  /** What Relay or CoW takes, and at least what arrives (the quote's minimum). */
  feeUsd: string;
  arrivesUsd: string;
  /** More than 5% in fees. */
  high: boolean;
  /** USDbC: some Base USDC first buys ETH for the approval's fee. */
  gasFromUsdc: boolean;
}

export type BridgeStep = 'checking' | 'buying_gas' | 'approving' | 'signing' | 'moving' | 'done' | 'refunded' | 'failed' | 'unknown';
export interface BridgeState {
  step: BridgeStep;
  network: string;
  kind: string;
  amount?: string;
  arrived?: string;
  requestId?: string;
  error?: string;
}

/** A quote from Relay, checked: what to sign, where to post it, and what arrives. */
export interface CheckedQuote {
  requestId: Hex;
  domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
  message: Authorization;
  postBody: { kind: string; requestId: string; api?: string };
  minOut: bigint;
  out: bigint;
}

/**
 * The guard (§16.9.3): a Relay quote is signed only when it is exactly one off-chain
 * authorization, on this token's own contract, from this wallet to Relay's pinned proxy,
 * for exactly the amount, short-lived, delivering Base USDC to this same wallet, and
 * leaving at least half. Throws a refusal in plain words otherwise.
 */
export function checkRelayQuote(q: any, ctx: { wallet: Hex; src: ElsewhereToken; amount: bigint; nowS: number }): CheckedQuote {
  const bad = (why: string) => refuse(`Relay's offer was not what the app expected (${why}), so nothing was signed.`);
  const { wallet, src, amount, nowS } = ctx;
  if (!Array.isArray(q?.steps) || q.steps.length !== 1) bad('more than one step');
  const step = q.steps[0];
  if (step?.kind !== 'signature' || !Array.isArray(step.items) || step.items.length !== 1) bad('a transaction where only a signature was expected');
  const d = step.items[0]?.data;
  const sign = d?.sign;
  if (sign?.signatureKind !== 'eip712' || sign.primaryType !== 'ReceiveWithAuthorization') bad('another kind of signature');
  const dom = sign.domain ?? {};
  if (dom.name !== 'USD Coin' || dom.version !== '2' || Number(dom.chainId) !== src.chainId || !sameAddress(String(dom.verifyingContract), src.token)) bad('another token or network');
  const m = sign.value ?? sign.message ?? {};
  if (!sameAddress(String(m.from), wallet)) bad('another wallet');
  if (!sameAddress(String(m.to), RELAY_PROXY)) bad('an unknown receiver');
  if (BigInt(m.value ?? -1) !== amount) bad('another amount');
  const after = BigInt(m.validAfter ?? -1);
  const before = BigInt(m.validBefore ?? 0);
  if (after < 0n || after > BigInt(nowS)) bad('not valid yet');
  if (before <= BigInt(nowS) || before > BigInt(nowS + MAX_VALID_S)) bad('valid for too long');
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(m.nonce))) bad('a malformed nonce');
  const post = d?.post;
  const requestId = String(post?.body?.requestId ?? '');
  if (post?.endpoint !== '/execute/permits' || String(post?.method ?? 'POST').toUpperCase() !== 'POST' || !/^0x[0-9a-fA-F]{64}$/.test(requestId)) bad('an unknown submission');
  const det = q.details ?? {};
  const cin = det.currencyIn ?? {};
  const cout = det.currencyOut ?? {};
  if (!sameAddress(String(det.recipient), wallet)) bad('another recipient');
  if (Number(cin.currency?.chainId) !== src.chainId || !sameAddress(String(cin.currency?.address), src.token) || BigInt(cin.amount ?? -1) !== amount) bad('another source');
  if (Number(cout.currency?.chainId) !== BASE.chainId || !sameAddress(String(cout.currency?.address), USDC.address)) bad('another destination');
  const minOut = BigInt(cout.minimumAmount ?? 0);
  const out = BigInt(cout.amount ?? 0);
  // Relay's own order, when it shows one: refunds and payments to this wallet only, and no calls at the destination.
  const order = q.protocol?.v2?.orderData;
  if (order) {
    const refunds = (order.inputs ?? []).flatMap((i: any) => i.refunds ?? []);
    if (refunds.some((r: any) => !sameAddress(String(r.recipient), wallet))) bad('refunds to someone else');
    if ((order.output?.payments ?? []).some((p: any) => !sameAddress(String(p.recipient), wallet))) bad('a payment to someone else');
    if ((order.output?.calls ?? []).length) bad('calls at the destination');
  }
  // Decimals: both sides are 6-decimal USDC here (BNB Smart Chain's 18-decimal USDC is not movable).
  if (src.decimals !== 6) bad('a token this app does not move');
  if (minOut * 2n < amount) refuse('Moving this now would cost more than half of it in fees. Wait until there is more there, or until its network fee falls.');
  return {
    requestId: requestId as Hex,
    domain: { name: dom.name, version: dom.version, chainId: src.chainId, verifyingContract: src.token as Hex },
    message: { from: wallet, to: RELAY_PROXY, value: amount.toString(), validAfter: after.toString(), validBefore: before.toString(), nonce: m.nonce as Hex },
    postBody: { kind: String(post.body.kind ?? 'eip3009'), requestId, ...(post.body.api && { api: String(post.body.api) }) },
    minOut, out,
  };
}

export class Bridger {
  #wallets: Wallets;
  #db: Db;
  #mover: Mover;
  #fetch: typeof fetch;
  #relay: string;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
  #rpcFor: (t: ElsewhereToken) => RpcOptions;
  #base: RpcOptions;

  constructor({ wallets, db, mover, fetchImpl = fetch, relayApi = RELAY_API, rpcFor, baseRpc, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: {
    wallets: Wallets; db: Db; mover: Mover; fetchImpl?: typeof fetch; relayApi?: string; rpcFor?: (t: ElsewhereToken) => RpcOptions;
    /** Base, for the wallet's own USDC and ETH. */
    baseRpc?: RpcOptions; now?: () => number; sleep?: (ms: number) => Promise<void>;
  }) {
    this.#wallets = wallets;
    this.#db = db;
    this.#mover = mover;
    this.#fetch = fetchImpl;
    this.#relay = relayApi;
    this.#now = now;
    this.#sleep = sleep;
    this.#rpcFor = rpcFor ?? ((t) => ({ rpc: t.rpc, fetchImpl }));
    this.#base = { fetchImpl, ...baseRpc };
  }

  async #relayCall(path: string, init?: RequestInit): Promise<any> {
    const res = await this.#fetch(`${this.#relay}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    const body: any = await readJson(res, REPLY_LIMITS.cow).catch(() => null);
    if (!res.ok) {
      if (body?.errorCode === 'NO_SWAP_ROUTES_FOUND') refuse('Relay cannot move USDC from this network right now. Try again later.');
      throw new BridgeError(`Relay refused: ${body?.message ?? res.status}.`);
    }
    return body;
  }

  async #balance(src: ElsewhereToken, wallet: Hex): Promise<bigint> {
    return tokenBalance(wallet, src.token, this.#rpcFor(src));
  }

  async #relayQuote(src: ElsewhereToken, wallet: Hex, amount: bigint) {
    return this.#relayCall('/quote/v2', {
      method: 'POST',
      body: JSON.stringify({
        user: wallet, recipient: wallet, refundTo: wallet, originChainId: src.chainId, destinationChainId: BASE.chainId,
        originCurrency: src.token, destinationCurrency: USDC.address, amount: amount.toString(), tradeType: 'EXACT_INPUT', usePermit: true,
      }),
    });
  }

  /** What moving this find would do now: reads and a quote, nothing signed. */
  async plan(walletId: string, network: string, kind: string): Promise<BridgePlan> {
    const src = movable(network, kind) ?? refuse('The app cannot move this kind of USDC to Base yet.');
    const wallet = this.#wallets.address(walletId);
    const amount = await this.#balance(src, wallet);
    if (amount === 0n) refuse(`There is no ${kind === 'usdbc' ? 'USDbC' : 'USDC'} on ${network} in this wallet any more.`);
    if (src.kind === 'usdbc') return this.#planUsdbc(wallet, src, amount);
    const c = checkRelayQuote(await this.#relayQuote(src, wallet, amount), { wallet, src, amount, nowS: Math.floor(this.#now() / 1000) });
    return {
      network, kind: 'usdc', route: 'relay', amount, amountUsd: formatUsd(amount), feeUsd: formatUsd(amount - c.out), arrivesUsd: formatUsd(c.minOut),
      high: Number(amount - c.out) > Number(amount) * HIGH_FEE, gasFromUsdc: false,
    };
  }

  async #planUsdbc(wallet: Hex, src: ElsewhereToken, amount: bigint): Promise<BridgePlan> {
    const need = await this.#mover.callCost(wallet, src.token as Hex, erc20ApproveData(COW.vaultRelayer, amount));
    const { buy } = await this.#cowQuote(wallet, src, amount);
    const eth = await ethBalance(wallet, this.#base);
    const gasFromUsdc = eth < need;
    if (gasFromUsdc) {
      const usdc = await tokenBalance(wallet, USDC.address, this.#base);
      if (usdc < 110_000n) refuse('Moving USDbC needs one transaction on Base, and its network fee is paid with a little of this wallet\'s USDC on Base. Put at least $0.11 of USDC on Base in this wallet first.');
    }
    return {
      network: src.network, kind: 'usdbc', route: 'cow', amount, amountUsd: formatUsd(amount), feeUsd: formatUsd(amount - buy), arrivesUsd: formatUsd(buy),
      high: Number(amount - buy) > Number(amount) * HIGH_FEE, gasFromUsdc,
    };
  }

  /** CoW's quote to sell all the USDbC for Base USDC to this wallet, with our slippage; refused below 95%. */
  async #cowQuote(wallet: Hex, src: ElsewhereToken, amount: bigint) {
    const validTo = Math.floor(this.#now() / 1000) + ORDER_LIFE_S;
    const appData = JSON.stringify({ appCode: 'Meadow', metadata: {}, version: '1.6.0' });
    const appDataHash = keccakHex(appData);
    const q = await this.#mover.cow('/api/v1/quote', {
      method: 'POST',
      body: JSON.stringify({
        sellToken: src.token, buyToken: USDC.address, receiver: wallet, from: wallet, kind: 'sell', sellAmountBeforeFee: amount.toString(),
        validTo, appData, appDataHash, partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
        signingScheme: 'eip712', onchainOrder: false, priceQuality: 'optimal',
      }),
    });
    const buy = (BigInt(q?.quote?.buyAmount ?? 0) * (100n - USDBC_SLIPPAGE_PCT)) / 100n;
    if (buy * 100n < amount * USDBC_MIN_PCT) refuse('CoW Protocol offered too little USDC for this USDbC right now. Try again later.');
    return { buy, validTo, appData, appDataHash, quoteId: q.id };
  }

  /**
   * Moves all of one find to Base, reporting each step. Resolves when it is done, refunded,
   * failed, or still unknown after 30 minutes.
   */
  async run(walletId: string, network: string, kind: string, onState: (s: BridgeState) => void): Promise<BridgeState> {
    const base = { network, kind };
    const seq = Number(this.#db.prepare("INSERT INTO bridges (wallet, network, kind, status, at) VALUES (?, ?, ?, 'checking', ?)").run(walletId, network, kind, this.#now()).lastInsertRowid);
    const record = (s: BridgeState) => {
      this.#db.prepare('UPDATE bridges SET status = ?, amount = COALESCE(?, amount), arrived = COALESCE(?, arrived), request_id = COALESCE(?, request_id), error = ? WHERE seq = ?')
        .run(s.step, s.amount ?? null, s.arrived ?? null, s.requestId ?? null, s.error ?? null, seq);
      onState(s);
      return s;
    };
    try {
      record({ step: 'checking', ...base });
      const src = movable(network, kind) ?? refuse('The app cannot move this kind of USDC to Base yet.');
      const wallet = this.#wallets.address(walletId);
      const amount = await this.#balance(src, wallet);
      if (amount === 0n) refuse(`There is no ${kind === 'usdbc' ? 'USDbC' : 'USDC'} on ${network} in this wallet any more.`);
      const usd = formatUsd(amount);
      const before = await tokenBalance(wallet, USDC.address, this.#base);
      if (src.kind === 'usdbc') return await this.#runUsdbc(walletId, wallet, src, amount, record, base, before);

      const c = checkRelayQuote(await this.#relayQuote(src, wallet, amount), { wallet, src, amount, nowS: Math.floor(this.#now() / 1000) });
      record({ step: 'signing', ...base, amount: usd, requestId: c.requestId });
      const signature = this.#wallets.signWith(walletId, (key, address) => {
        if (!sameAddress(address, wallet)) throw new Error('wallet changed');
        return signDigest(key, receiveDigest(c.domain, c.message));
      });
      await this.#relayCall(`/execute/permits?signature=${signature}`, { method: 'POST', body: JSON.stringify(c.postBody) });
      record({ step: 'moving', ...base, amount: usd, requestId: c.requestId });
      const deadline = this.#now() + FOLLOW_MS;
      while (this.#now() < deadline) {
        const st = await this.#relayCall(`/intents/status/v3?requestId=${c.requestId}`).catch(() => null);
        const s = String(st?.status ?? '');
        if (s === 'success') {
          const after = await tokenBalance(wallet, USDC.address, this.#base).catch(() => null);
          return record({ step: 'done', ...base, amount: usd, requestId: c.requestId, ...(after !== null && after > before && { arrived: formatUsd(after - before) }) });
        }
        if (s === 'refund' || s === 'refunded') return record({ step: 'refunded', ...base, amount: usd, requestId: c.requestId, error: `Relay could not complete the move and refunded it to this wallet on ${network}.` });
        if (s === 'failure') return record({ step: 'failed', ...base, amount: usd, requestId: c.requestId, error: 'Relay reported that the move failed. Nothing should have left the wallet; if it did, Relay refunds it on the original network.' });
        await this.#sleep(3000);
      }
      return record({ step: 'unknown', ...base, amount: usd, requestId: c.requestId, error: `No final answer after 30 minutes. Relay's reference for this move is ${c.requestId}.` });
    } catch (err) {
      const error = err instanceof BridgeError ? err.message : `The move stopped: ${err instanceof Error ? err.message : String(err)}`;
      return record({ step: 'failed', ...base, error });
    }
  }

  async #runUsdbc(walletId: string, wallet: Hex, src: ElsewhereToken, amount: bigint, record: (s: BridgeState) => BridgeState, base: { network: string; kind: string }, before: bigint): Promise<BridgeState> {
    const usd = formatUsd(amount);
    const approve = erc20ApproveData(COW.vaultRelayer, amount);
    const need = await this.#mover.callCost(wallet, src.token as Hex, approve);
    record({ step: 'buying_gas', ...base, amount: usd });
    await this.#mover.ensureEth(walletId, wallet, need);
    record({ step: 'approving', ...base, amount: usd });
    const tx = await this.#mover.sendCall(walletId, wallet, src.token as Hex, approve);
    const ok = await this.#mover.waitReceipt(tx);
    if (ok === false) refuse('Base did not accept the approval. Nothing moved; the network fee was spent. Try again.');
    if (ok === null) refuse('The approval has not shown up on Base yet. Nothing moved; try again in a minute.');
    const q = await this.#cowQuote(wallet, src, amount);
    const order: CowOrder = {
      sellToken: src.token as Hex, buyToken: USDC.address as Hex, receiver: wallet, sellAmount: amount.toString(), buyAmount: q.buy.toString(),
      validTo: q.validTo, appData: q.appDataHash, feeAmount: '0', kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
    };
    const domain = { name: 'Gnosis Protocol', version: 'v2', chainId: BASE.chainId, verifyingContract: COW.settlement };
    record({ step: 'signing', ...base, amount: usd });
    const signature = this.#wallets.signWith(walletId, (key, address) => {
      if (!sameAddress(address, wallet)) throw new Error('wallet changed');
      return signDigest(key, cowOrderDigest(domain, order));
    });
    const uid = await this.#mover.cow('/api/v1/orders', {
      method: 'POST',
      body: JSON.stringify({ ...order, appData: q.appData, appDataHash: q.appDataHash, signingScheme: 'eip712', signature, from: wallet, quoteId: q.quoteId }),
    });
    if (typeof uid !== 'string' || !/^0x[0-9a-fA-F]{112}$/.test(uid)) refuse('CoW Protocol did not take the order. Nothing moved; try again.');
    record({ step: 'moving', ...base, amount: usd, requestId: uid });
    const deadline = this.#now() + (ORDER_LIFE_S + 60) * 1000;
    while (this.#now() < deadline) {
      const o = await this.#mover.cow(`/api/v1/orders/${uid}`).catch(() => null);
      if (o?.status === 'fulfilled') {
        const after = await tokenBalance(wallet, USDC.address, this.#base).catch(() => null);
        return record({ step: 'done', ...base, amount: usd, requestId: uid, ...(after !== null && after > before && { arrived: formatUsd(after - before) }) });
      }
      if (o?.status === 'expired' || o?.status === 'cancelled') refuse('No one took the swap in time, so the USDbC is still in the wallet. Try again; it usually settles within a minute or two.');
      await this.#sleep(4000);
    }
    return record({ step: 'unknown', ...base, amount: usd, requestId: uid, error: 'The swap took too long to settle; the USDbC may still be in the wallet. Look again in a few minutes.' });
  }
}
