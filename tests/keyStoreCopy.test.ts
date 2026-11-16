import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyStoreCopy } from '../shared/keyStoreCopy.ts';

const mac = {
  setup: 'Protect your tasks with a passphrase and a key held in your Mac’s Keychain.',
  privacy:
    'Encrypted local storage · macOS Keychain + your passphrase · automatic lock after 15 idle minutes',
  alpacaSaved:
    'AllIn tests the key with one request, and saves it to your Keychain only if that works.',
  alpacaKept: 'Your Alpaca key stays in Keychain until you remove it.',
};

test('the macOS Keychain keeps today’s wording', () => {
  assert.deepEqual(keyStoreCopy('macOS Keychain'), mac);
});

// The browser tests run on a memory store and assert the Mac wording.
test('any store other than the Linux key file reads as on a Mac', () => {
  assert.deepEqual(keyStoreCopy('Test-only ephemeral key store'), mac);
});

test('the Linux key file is named as a file in the key folder on the server', () => {
  const copy = keyStoreCopy('Linux key file');
  for (const text of Object.values(copy)) assert.doesNotMatch(text, /Keychain|Mac/);
  assert.equal(
    copy.setup,
    'Protect your tasks with a passphrase and a key held in a file in the key folder on the server, protected by that folder’s permissions.',
  );
  assert.equal(
    copy.privacy,
    'Encrypted storage on the server · a key file in the key folder + your passphrase · automatic lock after 15 idle minutes',
  );
  assert.equal(
    copy.alpacaSaved,
    'AllIn tests the key with one request, and saves it only if that works, as a file in the key folder on the server, protected by that folder’s permissions.',
  );
  assert.equal(
    copy.alpacaKept,
    'Your Alpaca key stays in a file in the key folder on the server until you remove it.',
  );
});
