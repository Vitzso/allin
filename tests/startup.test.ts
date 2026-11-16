import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { ConfigError, type Config } from '../server/config.ts';
import { FileKeyStore } from '../server/fileKeyStore.ts';
import { OSKeyStore } from '../server/keychain.ts';
import { openKeyStore, readTls } from '../server/startup.ts';

// The launcher's start-up checks, run here with platform 'linux' because the launcher only
// builds the file store on Linux.
const roots: string[] = [];
function folders() {
  const root = mkdtempSync(join(tmpdir(), 'allin-start-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const keystoreDir = join(root, 'keys');
  mkdirSync(dataDir);
  mkdirSync(keystoreDir, { mode: 0o700 });
  chmodSync(keystoreDir, 0o700);
  return { root, config: { dataDir, keystoreDir } as Config };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const unsafe = (e: unknown) =>
  e instanceof ConfigError &&
  e.message ===
    'The key store folder is not safe to use. It must exist, be owned by the user running AllIn, be mode 700, and sit outside the data folder.';

test('on Linux, a safe key folder gives the file store', () => {
  const { config } = folders();
  assert.ok(openKeyStore(config, 'linux') instanceof FileKeyStore);
});

test('on Linux, a key folder open to others stops the start', () => {
  const { config } = folders();
  chmodSync(config.keystoreDir!, 0o755);
  assert.throws(() => openKeyStore(config, 'linux'), unsafe);
});

test('on Linux, a missing key folder or one inside the data folder stops the start', () => {
  const { root, config } = folders();
  assert.throws(
    () => openKeyStore({ ...config, keystoreDir: join(root, 'nope') }, 'linux'),
    unsafe,
  );
  const inside = join(config.dataDir, 'keys');
  mkdirSync(inside, { mode: 0o700 });
  assert.throws(() => openKeyStore({ ...config, keystoreDir: inside }, 'linux'), unsafe);
});

test('on a Mac the Keychain store is built and nothing is checked', () => {
  const { config } = folders();
  chmodSync(config.keystoreDir!, 0o755);
  assert.ok(openKeyStore(config, 'darwin') instanceof OSKeyStore);
});

test('readable TLS files are read', () => {
  const { root } = folders();
  writeFileSync(join(root, 'c.pem'), 'cert');
  writeFileSync(join(root, 'k.pem'), 'key', { mode: 0o600 });
  const tls = readTls({ cert: join(root, 'c.pem'), key: join(root, 'k.pem') });
  assert.equal(tls.cert.toString(), 'cert');
  assert.equal(tls.key.toString(), 'key');
});

test('a TLS key that cannot be read stops the start with its error code only', () => {
  const { root } = folders();
  writeFileSync(join(root, 'c.pem'), 'cert');
  writeFileSync(join(root, 'k.pem'), 'key', { mode: 0o600 });
  // Mode 000 passes the owner-only check and fails the read, as a key owned by another user does.
  chmodSync(join(root, 'k.pem'), 0o000);
  assert.throws(
    () => readTls({ cert: join(root, 'c.pem'), key: join(root, 'k.pem') }),
    (e: unknown) =>
      e instanceof ConfigError &&
      e.message === 'The TLS certificate or key file could not be read (EACCES).',
  );
  assert.throws(
    () => readTls({ cert: join(root, 'gone.pem'), key: join(root, 'k.pem') }),
    (e: unknown) =>
      e instanceof ConfigError &&
      e.message === 'The TLS certificate or key file could not be read (ENOENT).',
  );
});
