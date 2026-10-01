// Wallet keys and what the app signs (SPEC §16.9): a BIP-39 recovery phrase,
// the standard Ethereum path, and the account's address; for payments, an
// EIP-3009 TransferWithAuthorization as EIP-712 typed data; for moving money
// out (§16.9.1), a USDC permit, a CoW Protocol order, and one EIP-1559
// transaction. The primitives are the audited noble and scure libraries; the
// encodings below cover only those types, and the tests check each against viem.

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export const ETH_PATH = "m/44'/60'/0'/0/0";

export type Hex = `0x${string}`;

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Uint8Array => Buffer.from(h.replace(/^0x/, ''), 'hex');
const utf8 = (s: string) => new TextEncoder().encode(s);

/** A new 12-word recovery phrase (128 bits). */
export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

export function normalizeMnemonic(phrase: string): string {
  return phrase.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
}

export function isMnemonic(phrase: string): boolean {
  return validateMnemonic(normalizeMnemonic(phrase), wordlist);
}

/** The account key at the standard Ethereum path. */
export function privateKeyFromMnemonic(phrase: string): Uint8Array {
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(normalizeMnemonic(phrase))).derive(ETH_PATH);
  if (!node.privateKey) throw new Error('no private key at the derivation path');
  return node.privateKey;
}

/** EIP-55 mixed-case checksum. */
export function checksumAddress(address: string): Hex {
  const lower = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error('not an address');
  const h = hex(keccak_256(utf8(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out as Hex;
}

export function addressOf(privateKey: Uint8Array): Hex {
  const pub = secp256k1.getPublicKey(privateKey, false); // 65 bytes, 0x04 prefix
  return checksumAddress(hex(keccak_256(pub.subarray(1)).subarray(12)));
}

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// --- EIP-712 for TransferWithAuthorization (EIP-3009) -----------------------------

export interface Authorization {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Hex;
}

const DOMAIN_TYPE = keccak_256(utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const TRANSFER_TYPE = keccak_256(utf8('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'));

const word = (b: Uint8Array) => {
  if (b.length > 32) throw new Error('word over 32 bytes');
  const w = new Uint8Array(32);
  w.set(b, 32 - b.length);
  return w;
};
const uint = (v: bigint | number | string) => {
  const n = BigInt(v);
  if (n < 0n || n >= 1n << 256n) throw new Error('uint256 out of range');
  return word(fromHex(n.toString(16).padStart(64, '0')));
};
const address = (a: string) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('not an address');
  return word(fromHex(a));
};
const bytes32 = (h: string) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error('not bytes32');
  return fromHex(h);
};
const concat = (...parts: Uint8Array[]) => Buffer.concat(parts);

/** The EIP-712 digest of a struct already hashed, under `domain`. */
export function typedDigest(domain: Domain, structHash: Uint8Array): Uint8Array {
  const domainSeparator = keccak_256(concat(DOMAIN_TYPE, keccak_256(utf8(domain.name)), keccak_256(utf8(domain.version)), uint(domain.chainId), address(domain.verifyingContract)));
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), domainSeparator, structHash));
}

export function transferDigest(domain: Domain, a: Authorization): Uint8Array {
  return typedDigest(domain, keccak_256(concat(TRANSFER_TYPE, address(a.from), address(a.to), uint(a.value), uint(a.validAfter), uint(a.validBefore), bytes32(a.nonce))));
}

/** Signs a 32-byte digest: 65 bytes r || s || v, v = 27 + recovery, as Ethereum wallets produce. */
export function signDigest(privateKey: Uint8Array, digest: Uint8Array): Hex {
  const sig = secp256k1.sign(digest, privateKey, { prehash: false, format: 'recovered' });
  // noble's recovered format is recovery || r || s.
  return `0x${hex(sig.subarray(1, 65))}${(27 + sig[0]).toString(16)}` as Hex;
}

const RECEIVE_TYPE = keccak_256(utf8('ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'));

/** EIP-3009 ReceiveWithAuthorization: like a transfer authorization, but only `to` can use it (Move to Base, §16.9.3). */
export function receiveDigest(domain: Domain, a: Authorization): Uint8Array {
  return typedDigest(domain, keccak_256(concat(RECEIVE_TYPE, address(a.from), address(a.to), uint(a.value), uint(a.validAfter), uint(a.validBefore), bytes32(a.nonce))));
}

export function signTransfer(privateKey: Uint8Array, domain: Domain, a: Authorization): Hex {
  return signDigest(privateKey, transferDigest(domain, a));
}

// --- EIP-2612 permit (USDC) --------------------------------------------------------

export interface Permit {
  owner: Hex;
  spender: Hex;
  value: string;
  nonce: string;
  deadline: string;
}

const PERMIT_TYPE = keccak_256(utf8('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));

export function permitDigest(domain: Domain, p: Permit): Uint8Array {
  return typedDigest(domain, keccak_256(concat(PERMIT_TYPE, address(p.owner), address(p.spender), uint(p.value), uint(p.nonce), uint(p.deadline))));
}

/** The call data of `permit(owner, spender, value, deadline, v, r, s)`, from a signDigest signature. */
export function permitCallData(p: Permit, signature: Hex): Hex {
  const sig = fromHex(signature);
  return `0xd505accf${hex(concat(address(p.owner), address(p.spender), uint(p.value), uint(p.deadline), uint(sig[64]), sig.subarray(0, 32), sig.subarray(32, 64)))}` as Hex;
}

// --- CoW Protocol order (GPv2Order) ----------------------------------------------

export interface CowOrder {
  sellToken: Hex;
  buyToken: Hex;
  receiver: Hex;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  appData: Hex;
  feeAmount: string;
  kind: 'sell' | 'buy';
  partiallyFillable: boolean;
  sellTokenBalance: 'erc20';
  buyTokenBalance: 'erc20';
}

const ORDER_TYPE = keccak_256(utf8('Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,bool partiallyFillable,string sellTokenBalance,string buyTokenBalance)'));

export function cowOrderDigest(domain: Domain, o: CowOrder): Uint8Array {
  return typedDigest(domain, keccak_256(concat(ORDER_TYPE, address(o.sellToken), address(o.buyToken), address(o.receiver), uint(o.sellAmount), uint(o.buyAmount),
    uint(o.validTo), bytes32(o.appData), uint(o.feeAmount), keccak_256(utf8(o.kind)), uint(o.partiallyFillable ? 1 : 0),
    keccak_256(utf8(o.sellTokenBalance)), keccak_256(utf8(o.buyTokenBalance)))));
}

export const keccakHex = (data: Uint8Array | string): Hex => `0x${hex(keccak_256(typeof data === 'string' ? utf8(data) : data))}` as Hex;

// --- One EIP-1559 transaction (type 2) ---------------------------------------------

export interface Tx1559 {
  chainId: number;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gas: bigint;
  to: Hex;
  value: bigint;
  data: Hex;
}

type Rlp = Uint8Array | Rlp[];
const rlpLength = (len: number, offset: number): Uint8Array => {
  if (len < 56) return Uint8Array.of(offset + len);
  const l = qty(len);
  return concat(Uint8Array.of(offset + 55 + l.length), l);
};
function rlp(item: Rlp): Uint8Array {
  if (item instanceof Uint8Array) return item.length === 1 && item[0] < 0x80 ? item : concat(rlpLength(item.length, 0x80), item);
  const body = concat(...item.map(rlp));
  return concat(rlpLength(body.length, 0xc0), body);
}
/** A quantity as RLP wants it: big-endian, no leading zeros, zero as empty. */
function qty(n: bigint | number): Uint8Array {
  const v = BigInt(n);
  if (v < 0n) throw new Error('negative quantity');
  if (v === 0n) return new Uint8Array(0);
  const h = v.toString(16);
  return fromHex(h.length % 2 ? '0' + h : h);
}

const txFields = (t: Tx1559): Rlp[] =>
  [qty(t.chainId), qty(t.nonce), qty(t.maxPriorityFeePerGas), qty(t.maxFeePerGas), qty(t.gas), fromHex(t.to), qty(t.value), fromHex(t.data), []];

/** Signs the transaction; returns the raw bytes for eth_sendRawTransaction and its hash. */
export function signTx1559(privateKey: Uint8Array, t: Tx1559): { raw: Hex; hash: Hex } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(t.to) || !/^0x([0-9a-fA-F]{2})*$/.test(t.data)) throw new Error('bad transaction');
  const sig = secp256k1.sign(keccak_256(concat(Uint8Array.of(2), rlp(txFields(t)))), privateKey, { prehash: false, format: 'recovered' });
  const raw = concat(Uint8Array.of(2), rlp([...txFields(t), qty(sig[0]), qty(BigInt('0x' + hex(sig.subarray(1, 33)))), qty(BigInt('0x' + hex(sig.subarray(33, 65))))]));
  return { raw: `0x${hex(raw)}` as Hex, hash: keccakHex(raw) };
}

/** Call data of the ERC-20 `transfer(to, amount)`. */
export function erc20TransferData(to: Hex, amount: bigint): Hex {
  return `0xa9059cbb${hex(concat(address(to), uint(amount)))}` as Hex;
}

/** Call data of the ERC-20 `approve(spender, amount)`. */
export function erc20ApproveData(spender: Hex, amount: bigint): Hex {
  return `0x095ea7b3${hex(concat(address(spender), uint(amount)))}` as Hex;
}

/** Whether `a` is a well-formed address; mixed case must carry a valid EIP-55 checksum. */
export function validAddress(a: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return checksumAddress(a) === a;
}
