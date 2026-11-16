import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contained } from '../server/containment.ts';

const failing = (code: string) => () => {
  throw Object.assign(new Error(code), { code });
};
const fine = () => Buffer.from('{}');
// A stand-in file system: what reading vault.json and looking at the data folder each do.
const fs = (read: () => unknown, stat: () => unknown) => ({
  readFileSync: read,
  statSync: stat,
});

test('on macOS, EPERM on the vault file proves containment', () => {
  assert.equal(contained('/data', 'darwin', fs(failing('EPERM'), fine)), true);
});

test('on macOS, ENOENT does not', () => {
  assert.equal(contained('/data', 'darwin', fs(failing('ENOENT'), failing('ENOENT'))), false);
});

test('on Linux, ENOENT on both the file and the folder proves containment', () => {
  assert.equal(contained('/data', 'linux', fs(failing('ENOENT'), failing('ENOENT'))), true);
});

test('on Linux, a folder that can be seen does not, even if the file is missing', () => {
  assert.equal(contained('/data', 'linux', fs(failing('ENOENT'), fine)), false);
  assert.equal(contained('/data', 'linux', fs(failing('ENOENT'), failing('EACCES'))), false);
});

test('on Linux, EPERM or EACCES does not', () => {
  for (const code of ['EPERM', 'EACCES'])
    assert.equal(contained('/data', 'linux', fs(failing(code), failing('ENOENT'))), false, code);
});

test('a readable vault file never proves containment', () => {
  for (const platform of ['darwin', 'linux'])
    assert.equal(contained('/data', platform, fs(fine, failing('ENOENT'))), false, platform);
});

test('an unknown platform never proves containment', () => {
  for (const code of ['EPERM', 'ENOENT'])
    assert.equal(contained('/data', 'win32', fs(failing(code), failing(code))), false, code);
});

test('the vault file is looked for inside the data folder', () => {
  const seen: string[] = [];
  const read = (path: string) => {
    seen.push(path);
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  };
  contained('/srv/allin', 'darwin', { readFileSync: read, statSync: fine });
  assert.deepEqual(seen, ['/srv/allin/vault.json']);
});
