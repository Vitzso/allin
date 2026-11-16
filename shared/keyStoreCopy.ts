// What the UI says about where the device secret and the Alpaca key are kept, from the key store
// label in GET /api/status. Only the Linux key file reads differently; every other store,
// the test store included, keeps the Mac wording.
export type KeyStoreCopy = {
  setup: string;
  privacy: string;
  alpacaSaved: string;
  alpacaKept: string;
};

const MAC: KeyStoreCopy = {
  setup: 'Protect your tasks with a passphrase and a key held in your Mac’s Keychain.',
  privacy:
    'Encrypted local storage · macOS Keychain + your passphrase · automatic lock after 15 idle minutes',
  alpacaSaved:
    'AllIn tests the key with one request, and saves it to your Keychain only if that works.',
  alpacaKept: 'Your Alpaca key stays in Keychain until you remove it.',
};

const LINUX: KeyStoreCopy = {
  setup:
    'Protect your tasks with a passphrase and a key held in a file in the key folder on the server, protected by that folder’s permissions.',
  privacy:
    'Encrypted storage on the server · a key file in the key folder + your passphrase · automatic lock after 15 idle minutes',
  alpacaSaved:
    'AllIn tests the key with one request, and saves it only if that works, as a file in the key folder on the server, protected by that folder’s permissions.',
  alpacaKept:
    'Your Alpaca key stays in a file in the key folder on the server until you remove it.',
};

export const keyStoreCopy = (label: string): KeyStoreCopy =>
  label === 'Linux key file' ? LINUX : MAC;
