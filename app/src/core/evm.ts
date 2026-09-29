// Wallet keys and the one message the app signs (SPEC §16.9): a BIP-39
// recovery phrase, the standard Ethereum path, the account's address, and an
// EIP-3009 TransferWithAuthorization as EIP-712 typed data. The primitives are
// the audited noble and scure libraries; the EIP-712 encoding below covers only
// that one type, and the tests check it against viem.

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

export function transferDigest(domain: Domain, a: Authorization): Uint8Array {
  const domainSeparator = keccak_256(concat(DOMAIN_TYPE, keccak_256(utf8(domain.name)), keccak_256(utf8(domain.version)), uint(domain.chainId), address(domain.verifyingContract)));
  const structHash = keccak_256(concat(TRANSFER_TYPE, address(a.from), address(a.to), uint(a.value), uint(a.validAfter), uint(a.validBefore), bytes32(a.nonce)));
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), domainSeparator, structHash));
}

/** Signs the authorization: 65 bytes r || s || v, v = 27 + recovery, as Ethereum wallets produce. */
export function signTransfer(privateKey: Uint8Array, domain: Domain, a: Authorization): Hex {
  const sig = secp256k1.sign(transferDigest(domain, a), privateKey, { prehash: false, format: 'recovered' });
  // noble's recovered format is recovery || r || s.
  return `0x${hex(sig.subarray(1, 65))}${(27 + sig[0]).toString(16)}` as Hex;
}
