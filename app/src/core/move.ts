// Moving a wallet's money out (SPEC §16.9.1). The wallet holds USDC but a
// transfer on Base is paid for in ETH, which the person has no easy way to get.
// So, when the wallet has too little ETH, the app first swaps a little of its
// USDC for ETH through CoW Protocol: it signs a USDC permit (the approval, as a
// signature) and an order, and CoW's solvers settle the swap and pay its gas.
// Then the app sends every remaining USDC to the destination in one ordinary
// transaction. Nothing here is a payment: it never counts against a budget,
// and only the person, from the window, can start it.

import type { Db } from './db.ts';
import { BASE, USDC, formatUsd } from './catalog.ts';
import { callUint, ethBalance, rpcCall, rpcQuantity, tokenBalance, type RpcOptions } from './balance.ts';
import {
  cowOrderDigest, erc20TransferData, keccakHex, permitCallData, permitDigest, sameAddress, signDigest, signTx1559, validAddress,
  checksumAddress, type CowOrder, type Hex, type Permit, type Tx1559,
} from './evm.ts';
import type { Wallets } from './wallets.ts';
import { REPLY_LIMITS, readJson } from './deps.ts';

export const COW_API = 'https://api.cow.fi/base';
/** CoW Protocol's contracts on Base (the same on every chain), checked on-chain 2026-09-29. */
export const COW = {
  settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as Hex,
  vaultRelayer: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as Hex,
  /** What CoW calls native ETH as a buy token. */
  eth: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Hex,
};
/** OP Stack's gas price oracle, for the L1 part of a Base transaction's fee. */
const GAS_ORACLE = '0x420000000000000000000000000000000000000F';

/** The first swap tried: ten cents of USDC. */
const FIRST_SWAP = 100_000n;
/** No swap bigger than this: past it, network fees are too high to move now. */
const MAX_SWAP = 2_000_000n;
/** Buy enough ETH for this many transfers at today's fee, so a later move needs no swap. */
const FEE_HEADROOM = 10n;
const SLIPPAGE_PCT = 5n;
const ORDER_LIFE_S = 20 * 60;
const PERMIT_GAS = '80000';

const NEVER_TO = [USDC.address, COW.settlement, COW.vaultRelayer, COW.eth, GAS_ORACLE, '0x0000000000000000000000000000000000000000'];

export interface MovePlan {
  from: Hex;
  to: Hex;
  /** USDC in the wallet now, in base units. */
  usdc: bigint;
  /** Whether a swap for gas comes first, and how much USDC it sells. */
  swap: bigint | null;
  /** About what arrives: everything, less the swap. */
  arrives: bigint;
  /** The destination has code (a smart wallet or other contract). */
  contract: boolean;
}

export type MoveStep = 'checking' | 'swapping' | 'sending' | 'done' | 'sent' | 'failed';
export interface MoveState {
  step: MoveStep;
  to: Hex;
  amount?: string;
  swapOrder?: string;
  tx?: Hex;
  error?: string;
}

export class MoveError extends Error {}

const refuse = (message: string): never => {
  throw new MoveError(message);
};

/** ABI for `getL1Fee(bytes)`. */
const l1FeeCall = (raw: Hex) => {
  const body = raw.slice(2);
  const len = body.length / 2;
  return '0x49948e0e' + (32).toString(16).padStart(64, '0') + len.toString(16).padStart(64, '0') + body.padEnd(Math.ceil(len / 32) * 64, '0');
};

export class Mover {
  #wallets: Wallets;
  #db: Db;
  #rpc: RpcOptions;
  #cowApi: string;
  #fetch: typeof fetch;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
  /** A random key for the transfer-fee estimate, so it never signs with the wallet's own. */
  #probeKey = new Uint8Array(32).fill(7);

  constructor({ wallets, db, rpc = {}, cowApi = COW_API, fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: {
    wallets: Wallets; db: Db; rpc?: RpcOptions; cowApi?: string; fetchImpl?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>;
  }) {
    this.#wallets = wallets;
    this.#db = db;
    this.#rpc = { fetchImpl, ...rpc };
    this.#cowApi = cowApi;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#sleep = sleep;
  }

  /** The destination, checked: a valid address that is not this wallet or a contract the move uses. */
  destination(wallet: string, to: string): Hex {
    const t = to.trim();
    if (!validAddress(t)) refuse('That is not a valid address. Copy it again, whole: it starts with 0x and has 40 more letters and digits.');
    const from = this.#wallets.address(wallet);
    if (sameAddress(t, from)) refuse('That is this wallet\'s own address.');
    if (NEVER_TO.some((a) => sameAddress(a, t))) refuse('That address is a contract, not a wallet. Money sent there would be lost.');
    return checksumAddress(t);
  }

  /** What a move would do now, without signing anything. */
  async plan(wallet: string, to: string): Promise<MovePlan> {
    const dest = this.destination(wallet, to);
    const from = this.#wallets.address(wallet);
    const [usdc, eth, code] = await Promise.all([
      tokenBalance(from, USDC.address, this.#rpc), ethBalance(from, this.#rpc), rpcCall('eth_getCode', [dest, 'latest'], this.#rpc),
    ]);
    if (usdc === 0n) refuse('This wallet is empty: there is nothing to move.');
    const need = await this.#transferCost(from, dest, usdc);
    const swap = eth >= need ? null : FIRST_SWAP;
    if (swap !== null && usdc < swap + 10_000n) {
      refuse(`This wallet holds ${formatUsd(usdc)}. Moving it needs about ${formatUsd(FIRST_SWAP)} of it to pay Base's network fee, so there is too little to move.`);
    }
    return { from, to: dest, usdc, swap, arrives: usdc - (swap ?? 0n), contract: typeof code === 'string' && code !== '0x' };
  }

  /**
   * Moves every USDC in the wallet to `to`. Reports each step through
   * `onState`; resolves once the transfer is in a block, or has been sent and
   * not yet seen (`sent`, with its hash to look up).
   */
  async run(wallet: string, to: string, onState: (s: MoveState) => void): Promise<MoveState> {
    const dest = this.destination(wallet, to);
    const from = this.#wallets.address(wallet);
    const seq = Number(this.#db.prepare("INSERT INTO moves (wallet, address, to_address, status, at) VALUES (?, ?, ?, 'sending', ?)").run(wallet, from, dest, this.#now()).lastInsertRowid);
    const record = (s: MoveState) => {
      this.#db.prepare('UPDATE moves SET amount = ?, swap_order = COALESCE(?, swap_order), tx = ?, status = ?, error = ? WHERE seq = ?')
        .run(s.amount ?? null, s.swapOrder ?? null, s.tx ?? null, s.step === 'swapping' || s.step === 'checking' ? 'sending' : s.step, s.error ?? null, seq);
      onState(s);
      return s;
    };
    try {
      record({ step: 'checking', to: dest });
      let usdc = await tokenBalance(from, USDC.address, this.#rpc);
      if (usdc === 0n) refuse('This wallet is empty: there is nothing to move.');
      let need = await this.#transferCost(from, dest, usdc);
      if ((await ethBalance(from, this.#rpc)) < need) {
        const { uid, sell } = await this.#openSwap(from) ?? await this.#placeSwap(wallet, from, usdc, need);
        record({ step: 'swapping', to: dest, swapOrder: uid });
        this.#db.prepare('UPDATE moves SET swap_order = ?, swap_sell = ? WHERE seq = ?').run(uid, formatUsd(sell), seq);
        await this.#waitForSwap(uid);
        // The swap is settled; wait for the node we read from to show the ETH.
        for (let i = 0; i < 30 && (await ethBalance(from, this.#rpc)) < need; i++) await this.#sleep(2000);
        usdc = await tokenBalance(from, USDC.address, this.#rpc);
        need = await this.#transferCost(from, dest, usdc);
        if ((await ethBalance(from, this.#rpc)) < need) refuse('The swap settled, but the wallet still has too little ETH for the fee. Network fees may have jumped; try again in a few minutes.');
      }
      const amount = formatUsd(usdc);
      record({ step: 'sending', to: dest, amount });
      const tx = await this.#send(wallet, from, dest, usdc);
      for (let i = 0; i < 45; i++) {
        const receipt = await rpcCall('eth_getTransactionReceipt', [tx], this.#rpc).catch(() => null);
        if (receipt?.status === '0x1') return record({ step: 'done', to: dest, amount, tx });
        if (receipt?.status === '0x0') refuse('Base did not accept the transfer. No USDC moved; the fee was spent. Try again.');
        await this.#sleep(2000);
      }
      return record({ step: 'sent', to: dest, amount, tx });
    } catch (err) {
      const error = err instanceof MoveError ? err.message : `The move stopped: ${err instanceof Error ? err.message : String(err)}`;
      return record({ step: 'failed', to: dest, error });
    }
  }

  /** The most a USDC transfer can cost now, in wei: gas at twice today's base fee, plus Base's L1 fee, with room. */
  async #transferCost(from: Hex, to: Hex, amount: bigint): Promise<bigint> {
    const t = await this.#txFor(from, to, amount);
    const l1 = await callUint(GAS_ORACLE, l1FeeCall(signTx1559(this.#probeKey, t).raw), this.#rpc);
    return t.gas * t.maxFeePerGas + l1 * 2n;
  }

  async #txFor(from: Hex, to: Hex, amount: bigint): Promise<Tx1559> {
    const data = erc20TransferData(to, amount);
    const [block, tip, nonce, estimate] = await Promise.all([
      rpcCall('eth_getBlockByNumber', ['latest', false], this.#rpc),
      rpcCall('eth_maxPriorityFeePerGas', [], this.#rpc).then(rpcQuantity),
      rpcCall('eth_getTransactionCount', [from, 'pending'], this.#rpc).then(rpcQuantity),
      rpcCall('eth_estimateGas', [{ from, to: USDC.address, data }], this.#rpc).then(rpcQuantity).catch(() => 90_000n),
    ]);
    const base = rpcQuantity(block?.baseFeePerGas);
    return { chainId: BASE.chainId, nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, gas: (estimate * 13n) / 10n, to: USDC.address, value: 0n, data };
  }

  async #send(wallet: string, from: Hex, to: Hex, amount: bigint): Promise<Hex> {
    const t = await this.#txFor(from, to, amount);
    const { raw, hash } = this.#wallets.signWith(wallet, (key, address) => {
      if (!sameAddress(address, from)) throw new Error('wallet changed');
      return signTx1559(key, t);
    });
    const sent = await rpcCall('eth_sendRawTransaction', [raw], this.#rpc);
    if (typeof sent === 'string' && sent.toLowerCase() !== hash.toLowerCase()) throw new Error('the Base RPC reported a different transaction');
    return hash;
  }

  // --- The swap for gas, through CoW Protocol ---------------------------------------

  async #cow(path: string, init?: RequestInit): Promise<any> {
    const res = await this.#fetch(`${this.#cowApi}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    const body: any = await readJson(res, REPLY_LIMITS.cow).catch(() => null);
    if (!res.ok) throw new MoveError(`CoW Protocol refused the swap for the network fee: ${body?.description ?? body?.errorType ?? res.status}.`);
    return body;
  }

  /** An open USDC-to-ETH order from an earlier try that has not settled yet: wait on it rather than place another. */
  async #openSwap(from: Hex): Promise<{ uid: string; sell: bigint } | null> {
    const orders: any[] = await this.#cow(`/api/v1/account/${from}/orders?limit=10`).catch(() => []);
    const open = orders.find((o) => o?.status === 'open' && sameAddress(o.sellToken, USDC.address) && sameAddress(o.buyToken, COW.eth) && sameAddress(o.receiver ?? from, from));
    return open ? { uid: open.uid, sell: BigInt(open.sellAmount) } : null;
  }

  async #placeSwap(wallet: string, from: Hex, usdc: bigint, need: bigint): Promise<{ uid: string; sell: bigint }> {
    const validTo = Math.floor(this.#now() / 1000) + ORDER_LIFE_S;
    const nonce = await callUint(USDC.address, '0x7ecebe00' + from.slice(2).toLowerCase().padStart(64, '0'), this.#rpc); // nonces(owner)
    const usdcDomain = { name: USDC.name, version: USDC.version, chainId: BASE.chainId, verifyingContract: USDC.address as Hex };
    const cowDomain = { name: 'Gnosis Protocol', version: 'v2', chainId: BASE.chainId, verifyingContract: COW.settlement };

    // The permit, the app data carrying it as a pre-hook, and a quote for that app data.
    const prepare = async (sell: bigint) => {
      const permit: Permit = { owner: from, spender: COW.vaultRelayer, value: sell.toString(), nonce: nonce.toString(), deadline: String(validTo) };
      const sig = this.#wallets.signWith(wallet, (key) => signDigest(key, permitDigest(usdcDomain, permit)));
      const appData = JSON.stringify({
        appCode: 'Meadow',
        metadata: { hooks: { pre: [{ target: USDC.address, callData: permitCallData(permit, sig), gasLimit: PERMIT_GAS }], version: '0.2.0' } },
        version: '1.6.0',
      });
      const appDataHash = keccakHex(appData);
      const q = await this.#cow('/api/v1/quote', {
        method: 'POST',
        body: JSON.stringify({
          sellToken: USDC.address, buyToken: COW.eth, receiver: from, from, kind: 'sell', sellAmountBeforeFee: sell.toString(),
          validTo, appData, appDataHash, partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
          signingScheme: 'eip712', onchainOrder: false, priceQuality: 'optimal',
        }),
      });
      const buy = (BigInt(q.quote.buyAmount) * (100n - SLIPPAGE_PCT)) / 100n;
      return { appData, appDataHash, quoteId: q.id, buy };
    };

    const target = need * FEE_HEADROOM;
    let sell = FIRST_SWAP;
    let p = await prepare(sell);
    if (p.buy < target) {
      // Scale up to buy the target, once, within the cap and what the wallet holds.
      const scaled = (sell * target) / (p.buy > 0n ? p.buy : 1n) + 1n;
      if (scaled > MAX_SWAP) refuse('Base\'s network fees are unusually high right now. Try again later.');
      if (scaled + 10_000n > usdc) refuse(`This wallet holds ${formatUsd(usdc)}, too little to pay today's network fee and still move something.`);
      sell = scaled;
      p = await prepare(sell);
    }
    if (p.buy < need) refuse('Base\'s network fees are unusually high right now. Try again later.');

    const order: CowOrder = {
      sellToken: USDC.address, buyToken: COW.eth, receiver: from, sellAmount: sell.toString(), buyAmount: p.buy.toString(),
      validTo, appData: p.appDataHash, feeAmount: '0', kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
    };
    const signature = this.#wallets.signWith(wallet, (key) => signDigest(key, cowOrderDigest(cowDomain, order)));
    const uid = await this.#cow('/api/v1/orders', {
      method: 'POST',
      body: JSON.stringify({ ...order, appData: p.appData, appDataHash: p.appDataHash, signingScheme: 'eip712', signature, from, quoteId: p.quoteId }),
    });
    if (typeof uid !== 'string' || !/^0x[0-9a-fA-F]{112}$/.test(uid)) throw new Error('CoW Protocol did not return an order ID');
    return { uid, sell };
  }

  async #waitForSwap(uid: string) {
    const deadline = this.#now() + (ORDER_LIFE_S + 60) * 1000;
    while (this.#now() < deadline) {
      const o = await this.#cow(`/api/v1/orders/${uid}`).catch(() => null);
      if (o?.status === 'fulfilled') return;
      if (o?.status === 'expired' || o?.status === 'cancelled') refuse('No one took the swap for the network fee in time, so nothing moved. Try again; it usually settles within a minute or two.');
      await this.#sleep(4000);
    }
    refuse('The swap for the network fee took too long, so nothing moved. Try again.');
  }
}
