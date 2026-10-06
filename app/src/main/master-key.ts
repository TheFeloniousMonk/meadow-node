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
/**
 * An existing key the keychain would not open (a refused or failed keychain prompt, a locked
 * keyring). Nothing is changed: the caller explains, and never creates a new key over it (§16.1).
 */
export class KeyUnreadable extends Error {
  name = 'KeyUnreadable';
}

export function masterKey(dir: string): Buffer {
  const file = join(dir, 'master.key');
  const existing = existsSync(file);
  // On Linux, Chromium falls back to a fixed built-in password when no keyring
  // runs: available in name only. Refuse it rather than seal wallets with it.
  const linuxNoKeyring = process.platform === 'linux' && (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend() === 'basic_text');
  if (linuxNoKeyring && !existing) throw new Error('Meadow keeps its key in your desktop keyring, and none is running. Install and start GNOME Keyring or KWallet (on most desktops it is already there), then open Meadow again.');
  if (existing && (linuxNoKeyring || !safeStorage.isEncryptionAvailable())) throw new KeyUnreadable('protected storage is not available');
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer offers no protected storage for the app's key.");
  if (existing) {
    try {
      return Buffer.from(safeStorage.decryptString(readFileSync(file)), 'hex');
    } catch (err) {
      throw new KeyUnreadable(err instanceof Error ? err.message : String(err));
    }
  }
  const key = randomBytes(32);
  writeFileSync(file, safeStorage.encryptString(key.toString('hex')), { mode: 0o600 });
  return key;
}
