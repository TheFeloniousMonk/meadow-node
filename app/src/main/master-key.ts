// The master key (SPEC §16.1).
import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/**
 * The master key: 32 random bytes, kept encrypted by the operating system's
 * keychain through safeStorage (DPAPI on Windows, Keychain on macOS, the
 * Secret Service on Linux). Without it, nothing in the database opens.
 */
export function masterKey(dir: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer offers no protected storage for the app's key.");
  const file = join(dir, 'master.key');
  if (existsSync(file)) return Buffer.from(safeStorage.decryptString(readFileSync(file)), 'hex');
  const key = randomBytes(32);
  writeFileSync(file, safeStorage.encryptString(key.toString('hex')), { mode: 0o600 });
  return key;
}
