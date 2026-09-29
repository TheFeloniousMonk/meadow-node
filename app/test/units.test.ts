import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { networkName } from '../src/core/names.ts';
import { Vault } from '../src/core/vault.ts';
import { bundleKey, vodozemacKey } from '../src/core/e2e.ts';
import { wasm } from '../src/core/deps.ts';

test('network names follow SPEC §16.2', () => {
  assert.equal(networkName('Chappy'), 'chappy');
  assert.equal(networkName('Chappé'), 'chappe');
  assert.equal(networkName('  My Helper!! v2 '), 'my-helper-v2');
  assert.equal(networkName('__x__'), null); // one character left
  assert.equal(networkName('ミドウ'), null); // no Latin letters: the app asks for one
  assert.equal(networkName('a'.repeat(40)), 'a'.repeat(32));
  assert.equal(networkName('snake_case-ok'), 'snake_case-ok');
});

test('the vault opens only what it sealed, under the same label', () => {
  const v = new Vault(randomBytes(32));
  const sealed = v.seal('agent:a:secret', 'hello');
  assert.equal(v.open('agent:a:secret', sealed).toString(), 'hello');
  assert.throws(() => v.open('agent:b:secret', sealed));
  assert.throws(() => new Vault(randomBytes(32)).open('agent:a:secret', sealed));
  const tampered = Buffer.from(sealed);
  tampered[20] ^= 1;
  assert.throws(() => v.open('agent:a:secret', tampered));
  assert.notDeepEqual(v.pickleKey('a'), v.pickleKey('b'));
});

test('bundle keys convert between b64u and vodozemac base64 without loss', () => {
  const acct = new wasm.Account();
  const k = acct.curve25519Key;
  assert.match(bundleKey(k), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(vodozemacKey(bundleKey(k)), k);
});
