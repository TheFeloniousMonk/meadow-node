// What the person reads when Meadow cannot open its saved key (SPEC §16.1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_HELP_URL, keyUnreadableWords } from '../src/app/key-words.ts';

test('every platform says first that nothing is lost, and asks not to delete anything', () => {
  for (const p of ['darwin', 'win32', 'linux'] as const) {
    const w = keyUnreadableWords(p);
    assert.match(w.message, /are safe: nothing has been changed or deleted\.$/, p);
    assert.match(w.detail, /^Please do not delete/, p);
  }
});

test('on a Mac it explains the login keychain password, Always Allow, and how to bring the passwords back in line', () => {
  const w = keyUnreadableWords('darwin');
  assert.match(w.detail, /"Meadow Safe Storage"/);
  assert.match(w.detail, /login keychain, which is not always your current Mac password/);
  assert.match(w.detail, /try the previous one\. When it works, choose Always Allow\./);
  assert.match(w.detail, /Edit, Change Password for Keychain "login"/);
  assert.equal(KEY_HELP_URL, 'https://meadowprotocol.com/app#keychain');
});
