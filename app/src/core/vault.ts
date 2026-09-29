// Secrets at rest (SPEC §16.1). Everything secret is sealed with AES-256-GCM
// under keys derived from one 32-byte master key. The app's main process gets
// the master key from the operating system's keychain through Electron's
// safeStorage (optionally wrapped by an app passphrase, §16.14); the core only
// ever sees the derived keys.
//
// A sealed value is: version byte 1, a 12-byte nonce, the ciphertext, and the
// 16-byte tag. The additional data names what the value is and whose it is,
// so a sealed value cannot be moved to another row or agent and still open.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 1;
const derive = (master: Uint8Array, info: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `meadow-app/v1/${info}`, 32));

export class Vault {
  #data: Buffer;
  #master: Buffer;

  constructor(master: Uint8Array) {
    if (master.length !== 32) throw new Error('the master key is 32 bytes');
    this.#master = Buffer.from(master);
    this.#data = derive(master, 'data');
  }

  seal(aad: string, plaintext: Uint8Array | string): Uint8Array {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#data, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext), cipher.final()]);
    return Buffer.concat([Buffer.of(VERSION), nonce, ct, cipher.getAuthTag()]);
  }

  open(aad: string, sealed: Uint8Array): Buffer {
    const buf = Buffer.from(sealed);
    if (buf.length < 29 || buf[0] !== VERSION) throw new Error('not a sealed value');
    const decipher = createDecipheriv('aes-256-gcm', this.#data, buf.subarray(1, 13));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([decipher.update(buf.subarray(13, buf.length - 16)), decipher.final()]);
  }

  sealJson(aad: string, value: unknown): Uint8Array {
    return this.seal(aad, JSON.stringify(value));
  }

  openJson<T = any>(aad: string, sealed: Uint8Array): T {
    return JSON.parse(this.open(aad, sealed).toString('utf8'));
  }

  /** The key vodozemac pickles one agent's encryption state with (SPEC §8.9). */
  pickleKey(agent: string): Uint8Array {
    return derive(this.#master, `pickle/${agent}`);
  }
}
