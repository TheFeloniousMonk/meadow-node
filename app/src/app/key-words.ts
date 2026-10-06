// What the person is told when Meadow cannot open its saved key (SPEC §16.1). A tester's Mac kept
// asking for the login keychain password after an update and refused their current one
// (2026-10-06); they rightly feared that resetting the keychain item would lose their agent. The
// words say first that nothing is lost, then what not to do, then how to fix it.

export const KEY_HELP_URL = 'https://meadowprotocol.com/app#keychain';

export interface KeyWords {
  title: string;
  message: string;
  detail: string;
}

export function keyUnreadableWords(platform: NodeJS.Platform): KeyWords {
  const title = 'Meadow cannot open its saved key';
  if (platform === 'darwin') {
    return {
      title,
      message: 'Meadow could not open its key in your Mac\'s keychain. Your agents, messages, and wallets are safe: nothing has been changed or deleted.',
      detail: [
        'Please do not delete "Meadow Safe Storage" in Keychain Access, or Meadow\'s folder: they unlock your agents\' data, and without them it cannot be read again.',
        '',
        'After each update, macOS asks again before Meadow may read its key. It wants the password of your login keychain, which is not always your current Mac password: if your Mac password was ever changed or reset, try the previous one. When it works, choose Always Allow.',
        '',
        'To make your current Mac password work again: open Keychain Access, select the login keychain, then Edit, Change Password for Keychain "login".',
      ].join('\n'),
    };
  }
  if (platform === 'win32') {
    return {
      title,
      message: 'Meadow could not open its key, which Windows keeps for your user account. Your agents, messages, and wallets are safe: nothing has been changed or deleted.',
      detail: [
        'Please do not delete Meadow\'s folder: it holds your agents\' data.',
        '',
        'This can happen when Meadow is opened under another Windows user, or after the account\'s password was reset by someone else. Sign in to Windows as the user who set Meadow up, and open it again.',
      ].join('\n'),
    };
  }
  return {
    title,
    message: 'Meadow could not open its key in your desktop keyring. Your agents, messages, and wallets are safe: nothing has been changed or deleted.',
    detail: [
      'Please do not delete Meadow\'s entry in your keyring, or Meadow\'s folder: they unlock your agents\' data.',
      '',
      'Unlock your keyring (GNOME Keyring or KWallet) with the password it asks for, which may be an earlier login password, and open Meadow again.',
    ].join('\n'),
  };
}
