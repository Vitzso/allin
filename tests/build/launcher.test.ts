import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeCertificate } from '../tlsHelpers.ts';

// Refusals happen before any vault or Keychain access, and the launcher exits at once.
const repo = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const made: string[] = [];
after(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })));
// Linux needs a key folder: owner-only (mkdtemp makes it 0700) and apart from the data folder.
// macOS ignores it.
const keyFolder = () => {
  const keys = mkdtempSync(join(tmpdir(), 'allin-launch-keys-'));
  made.push(keys);
  return keys;
};

function launch(env: Record<string, string>) {
  const data = mkdtempSync(join(tmpdir(), 'allin-launch-'));
  made.push(data);
  const port = 44000 + Math.floor(Math.random() * 15000);
  const run = spawnSync(process.execPath, [join(repo, 'build/server/index.js')], {
    env: {
      ...process.env,
      ALLIN_DATA_DIR: data,
      ALLIN_KEYSTORE_DIR: keyFolder(),
      ALLIN_PORT: String(port),
      ...env,
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { run, port };
}
const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

test('a wildcard listen address is refused with one line, no stack, and no listener', async () => {
  const { run, port } = launch({ ALLIN_LISTEN: '0.0.0.0' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr, 'ALLIN_LISTEN must be one address, not a wildcard.\n');
  assert.equal(await listening(port), false);
});

// Needs an address that really is on this machine; without one, these tests are skipped.
const privateAddress = Object.values(networkInterfaces())
  .flat()
  .find(
    (entry) =>
      entry?.family === 'IPv4' &&
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address),
  )?.address;
const skip = privateAddress ? false : 'no private address on this machine';

test('a private listen address without an origin and TLS files is refused', { skip }, () => {
  const { run } = launch({ ALLIN_LISTEN: privateAddress! });
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    'Set ALLIN_ORIGIN, ALLIN_TLS_CERT and ALLIN_TLS_KEY to listen on a private address.\n',
  );
});

test('development mode with a private address is refused', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'allin-launch-'));
  made.push(dir);
  makeCertificate(dir, 'allin.test');
  chmodSync(join(dir, 'allin.test.key'), 0o600);
  const port = 44000 + Math.floor(Math.random() * 15000);
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(repo, 'server/index.ts'), '--dev'],
    {
      cwd: repo,
      env: {
        ...process.env,
        ALLIN_DATA_DIR: dir,
        ALLIN_KEYSTORE_DIR: keyFolder(),
        ALLIN_PORT: String(port),
        ALLIN_LISTEN: privateAddress!,
        ALLIN_ORIGIN: `https://allin.test:${port}`,
        ALLIN_TLS_CERT: join(dir, 'allin.test.crt'),
        ALLIN_TLS_KEY: join(dir, 'allin.test.key'),
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(run.status, 1);
  assert.equal(run.stderr, 'Development mode runs on 127.0.0.1 only.\n');
});
