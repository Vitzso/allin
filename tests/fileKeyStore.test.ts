import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, test } from 'node:test';
import { AppError } from '../server/errors.ts';
import { KDF_V1 } from '../server/crypto.ts';
import { FileKeyStore, keyStoreFor } from '../server/fileKeyStore.ts';
import { OSKeyStore } from '../server/keychain.ts';
import { MIGRATIONS } from '../server/migrations.ts';
import { Vault } from '../server/vault.ts';
import { password } from './helpers.ts';
import type { Config } from '../server/config.ts';

const roots: string[] = [];
function layout() {
  const root = mkdtempSync(join(tmpdir(), 'allin-keys-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const keys = join(root, 'keys');
  mkdirSync(dataDir);
  mkdirSync(keys, { mode: 0o700 });
  chmodSync(keys, 0o700);
  return { root, dataDir, keys };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function assertRefused(store: FileKeyStore) {
  for (const act of [
    () => store.check(),
    () => store.get('a'),
    () => store.set('a', 'b'),
    () => store.delete('a'),
  ])
    assert.throws(act, (e: Error) => e.message === 'The key store folder is not safe to use.');
}

test('set, get and delete round trip', () => {
  const { dataDir, keys } = layout();
  const store = new FileKeyStore(keys, dataDir);
  store.set('vault-id', 'secret one');
  assert.equal(store.get('vault-id'), 'secret one');
  store.set('vault-id', 'secret two');
  assert.equal(store.get('vault-id'), 'secret two');
  store.delete('vault-id');
  assert.equal(store.get('vault-id'), null);
});

test('check passes on a safe folder and touches nothing', () => {
  const { dataDir, keys } = layout();
  assert.doesNotThrow(() => new FileKeyStore(keys, dataDir).check());
  assert.deepEqual(readdirSync(keys), []);
});

test('a missing entry reads as null, and deleting it does nothing', () => {
  const { dataDir, keys } = layout();
  const store = new FileKeyStore(keys, dataDir);
  assert.equal(store.get('nothing'), null);
  assert.doesNotThrow(() => store.delete('nothing'));
});

test('an entry file is owner-only and named by the hash of its id', () => {
  const { dataDir, keys } = layout();
  const store = new FileKeyStore(keys, dataDir);
  store.set('alpaca:3f2b8c1e-0000-4000-8000-000000000000', 'k');
  const files = readdirSync(keys);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{64}$/);
  assert.equal(statSync(join(keys, files[0])).mode & 0o777, 0o600);
});

test('an empty entry file reads as null', () => {
  const { dataDir, keys } = layout();
  const store = new FileKeyStore(keys, dataDir);
  store.set('id', 'x');
  writeFileSync(join(keys, readdirSync(keys)[0]), '');
  assert.equal(store.get('id'), null);
});

test('a folder open to group or others is refused', () => {
  const { dataDir, keys } = layout();
  const store = new FileKeyStore(keys, dataDir);
  chmodSync(keys, 0o750);
  assertRefused(store);
  chmodSync(keys, 0o707);
  assertRefused(store);
});

test('a folder inside the data folder is refused', () => {
  const { dataDir } = layout();
  const inside = join(dataDir, 'keys');
  mkdirSync(inside, { mode: 0o700 });
  assertRefused(new FileKeyStore(inside, dataDir));
  assertRefused(new FileKeyStore(dataDir, dataDir));
});

test('a folder that holds the data folder is refused', () => {
  const { root } = layout();
  const outer = join(root, 'outer');
  mkdirSync(outer, { mode: 0o700 });
  const dataDir = join(outer, 'data');
  assertRefused(new FileKeyStore(outer, dataDir));
});

test('a data folder that does not exist yet is compared by its resolved parent', () => {
  const { root, keys } = layout();
  const later = join(root, 'later');
  const store = new FileKeyStore(keys, later);
  store.set('a', 'b');
  assert.equal(store.get('a'), 'b');
  assertRefused(new FileKeyStore(root, later));
  const inside = join(later, 'keys');
  assert.throws(() => new FileKeyStore(inside, later).get('a'), /not safe/);
});

test('a symlink that resolves inside the data folder is refused', () => {
  const { root, dataDir } = layout();
  const real = join(dataDir, 'keys');
  mkdirSync(real, { mode: 0o700 });
  const link = join(root, 'link');
  symlinkSync(real, link);
  assertRefused(new FileKeyStore(link, dataDir));
});

test('a relative path that resolves inside the data folder is refused', () => {
  const { dataDir } = layout();
  const real = join(dataDir, 'keys');
  mkdirSync(real, { mode: 0o700 });
  const rel = relative(process.cwd(), real);
  assert.ok(!rel.startsWith('/'));
  assertRefused(new FileKeyStore(rel, dataDir));
});

test('a missing folder is refused, not created', () => {
  const { root, dataDir } = layout();
  const missing = join(root, 'nope');
  assertRefused(new FileKeyStore(missing, dataDir));
  assert.equal(existsSync(missing), false);
});

test('a file in place of the folder is refused', () => {
  const { root, dataDir } = layout();
  const file = join(root, 'file');
  writeFileSync(file, 'x', { mode: 0o700 });
  assertRefused(new FileKeyStore(file, dataDir));
});

test('a stale temp file does not block a write', () => {
  const { dataDir, keys } = layout();
  const store = new FileKeyStore(keys, dataDir);
  store.set('id', 'first');
  const [name] = readdirSync(keys);
  writeFileSync(join(keys, `${name}.tmp`), 'stale', { mode: 0o600 });
  store.set('id', 'second');
  assert.equal(store.get('id'), 'second');
  assert.deepEqual(readdirSync(keys), [name]);
});

test('a vault set up on a FileKeyStore unlocks after a new store is built on the same folder', () => {
  const { dataDir, keys } = layout();
  const vault = new Vault(dataDir, new FileKeyStore(keys, dataDir), MIGRATIONS, KDF_V1);
  vault.setup(password);
  vault.lock();
  const rebooted = new Vault(dataDir, new FileKeyStore(keys, dataDir), MIGRATIONS, KDF_V1);
  rebooted.unlock(password);
  rebooted.lock();
});

test('a vault whose key folder was emptied reports the device key unavailable', () => {
  const { dataDir, keys } = layout();
  const vault = new Vault(dataDir, new FileKeyStore(keys, dataDir), MIGRATIONS, KDF_V1);
  vault.setup(password);
  vault.lock();
  for (const name of readdirSync(keys)) rmSync(join(keys, name));
  const again = new Vault(dataDir, new FileKeyStore(keys, dataDir), MIGRATIONS, KDF_V1);
  assert.throws(
    () => again.unlock(password),
    (e: unknown) => e instanceof AppError && e.status === 503,
  );
});

test('the launcher picks the file store on Linux and the Keychain on a Mac', () => {
  const { dataDir, keys } = layout();
  const config = { dataDir, keystoreDir: keys } as Config;
  assert.ok(keyStoreFor(config, 'linux') instanceof FileKeyStore);
  assert.ok(keyStoreFor(config, 'darwin') instanceof OSKeyStore);
});
