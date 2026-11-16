import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, readConfig, type HostFacts } from '../server/config.ts';

const facts = (over: Partial<HostFacts> = {}): HostFacts => ({
  platform: 'darwin',
  homedir: '/Users/o',
  cwd: '/work',
  addresses: ['127.0.0.1', '10.8.0.1', '192.168.1.5', '8.8.4.4'],
  mode: () => 0o600,
  ...over,
});
const net = {
  ALLIN_LISTEN: '10.8.0.1',
  ALLIN_ORIGIN: 'https://10.8.0.1:4310',
  ALLIN_TLS_CERT: '/tls/c.pem',
  ALLIN_TLS_KEY: '/tls/k.pem',
};
const refuses = (env: Record<string, string>, message: string, host = facts()) =>
  assert.throws(
    () => readConfig(env, host),
    (e) => e instanceof ConfigError && e.message === message,
  );

test('with nothing set on macOS, the result is today’s loopback setup', () => {
  assert.deepEqual(readConfig({}, facts()), {
    port: 4310,
    listen: '127.0.0.1',
    origin: 'http://127.0.0.1:4310',
    network: false,
    tls: undefined,
    dataDir: '/Users/o/Library/Application Support/AllIn',
    keystoreDir: undefined,
  });
});
test('a platform other than macOS or Linux is refused', () =>
  refuses({}, 'AllIn runs on macOS and Linux only.', facts({ platform: 'win32' })));
for (const port of ['80', '1023', '65536', 'abc', '4310.5'])
  test(`port ${port} is refused`, () =>
    refuses({ ALLIN_PORT: port }, 'ALLIN_PORT must be between 1024 and 65535.'));
for (const listen of ['0.0.0.0', '::', 'localhost', 'nonsense'])
  test(`listen address ${listen} is refused as a wildcard or invalid`, () =>
    refuses({ ALLIN_LISTEN: listen }, 'ALLIN_LISTEN must be one address, not a wildcard.'));
for (const listen of ['8.8.4.4', '172.32.0.1', '100.128.0.1', '::1'])
  test(`public address ${listen} is refused`, () =>
    refuses(
      { ALLIN_LISTEN: listen },
      'ALLIN_LISTEN must be 127.0.0.1 or a private address, such as your WireGuard address.',
      facts({ addresses: [listen] }),
    ));
test('an address not on this machine is refused', () =>
  refuses({ ...net, ALLIN_LISTEN: '10.9.9.9' }, 'ALLIN_LISTEN is not an address on this machine.'));
for (const key of ['ALLIN_ORIGIN', 'ALLIN_TLS_CERT', 'ALLIN_TLS_KEY'])
  test(`${key} with loopback is refused`, () =>
    refuses(
      { [key]: 'x' },
      'ALLIN_ORIGIN and the TLS settings apply only when ALLIN_LISTEN is a private address.',
    ));
for (const key of ['ALLIN_ORIGIN', 'ALLIN_TLS_CERT', 'ALLIN_TLS_KEY'])
  test(`network mode without ${key} is refused`, () => {
    const env: Record<string, string> = { ...net };
    delete env[key];
    refuses(
      env,
      'Set ALLIN_ORIGIN, ALLIN_TLS_CERT and ALLIN_TLS_KEY to listen on a private address.',
    );
  });
for (const origin of [
  'http://10.8.0.1:4310',
  'https://u:p@10.8.0.1:4310',
  'https://10.8.0.1:4310?x=1',
  'https://10.8.0.1:4310#f',
  'nonsense',
])
  test(`origin ${origin} is refused`, () =>
    refuses(
      { ...net, ALLIN_ORIGIN: origin },
      'ALLIN_ORIGIN must look like https://host:port, with nothing after the port.',
    ));
test('an origin with a path is refused', () =>
  refuses(
    { ...net, ALLIN_ORIGIN: 'https://allin.home:4310/app' },
    'ALLIN_ORIGIN must look like https://host:port, with nothing after the port.',
  ));
test('an origin without a port is refused', () =>
  refuses(
    { ...net, ALLIN_ORIGIN: 'https://allin.home' },
    'The port in ALLIN_ORIGIN must match ALLIN_PORT.',
  ));
test('an origin with another port is refused', () =>
  refuses(
    { ...net, ALLIN_ORIGIN: 'https://allin.home:4311' },
    'The port in ALLIN_ORIGIN must match ALLIN_PORT.',
  ));
test('a missing certificate or key file is refused', () =>
  refuses(net, 'The TLS certificate or key file was not found.', facts({ mode: () => null })));
test('a key file with group or other bits is refused', () => {
  for (const mode of [0o640, 0o604, 0o644])
    refuses(
      net,
      'The TLS key file must be readable only by its owner (chmod 600).',
      facts({ mode: (p) => (p === '/tls/k.pem' ? mode : 0o644) }),
    );
});
test('on Linux, the data and keystore folders are required', () => {
  const linux = facts({ platform: 'linux' });
  refuses({}, 'On Linux, set ALLIN_DATA_DIR and ALLIN_KEYSTORE_DIR.', linux);
  refuses({ ALLIN_DATA_DIR: '/d' }, 'On Linux, set ALLIN_DATA_DIR and ALLIN_KEYSTORE_DIR.', linux);
  refuses(
    { ALLIN_KEYSTORE_DIR: '/k' },
    'On Linux, set ALLIN_DATA_DIR and ALLIN_KEYSTORE_DIR.',
    linux,
  );
  const c = readConfig({ ALLIN_DATA_DIR: '/d', ALLIN_KEYSTORE_DIR: '/k' }, linux);
  assert.equal(c.dataDir, '/d');
  assert.equal(c.keystoreDir, '/k');
});
// An empty value used to mean the default, which on a Mac is the real profile.
test('an empty data or keystore folder is refused, on either platform', () => {
  const empty = 'ALLIN_DATA_DIR and ALLIN_KEYSTORE_DIR must not be empty when set.';
  for (const platform of ['darwin', 'linux'] as const) {
    const host = facts({ platform });
    refuses({ ALLIN_DATA_DIR: '', ALLIN_KEYSTORE_DIR: '/k' }, empty, host);
    refuses({ ALLIN_DATA_DIR: '/d', ALLIN_KEYSTORE_DIR: '' }, empty, host);
  }
  refuses({ ALLIN_DATA_DIR: '' }, empty);
});
test('a full network setup is accepted', () => {
  const c = readConfig(net, facts());
  assert.equal(c.network, true);
  assert.equal(c.listen, '10.8.0.1');
  assert.equal(c.origin, 'https://10.8.0.1:4310');
  assert.deepEqual(c.tls, { cert: '/tls/c.pem', key: '/tls/k.pem' });
});
test('the origin is normalised', () =>
  assert.equal(
    readConfig({ ...net, ALLIN_ORIGIN: 'https://ALLIN.home:4310/' }, facts()).origin,
    'https://allin.home:4310',
  ));
test('a relative data folder resolves from the launch folder', () => {
  const c = readConfig({ ALLIN_DATA_DIR: 'data', ALLIN_KEYSTORE_DIR: '../k' }, facts());
  assert.equal(c.dataDir, '/work/data');
  assert.equal(c.keystoreDir, '/k');
});
test('private ranges are accepted', () => {
  for (const a of [
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.1',
    '192.168.0.9',
    '100.64.0.1',
    'fd00::1',
  ])
    assert.equal(
      readConfig(
        { ...net, ALLIN_LISTEN: a, ALLIN_ORIGIN: 'https://h.test:4310' },
        facts({ addresses: [a] }),
      ).network,
      true,
    );
});

for (const listen of ['::ffff:10.0.0.1', '::FFFF:10.0.0.1', 'fd00::1%en0'])
  test(`mapped or zone-scoped address ${listen} is refused`, () =>
    refuses(
      { ...net, ALLIN_LISTEN: listen },
      'ALLIN_LISTEN must be one address, not a wildcard.',
      facts({ addresses: [listen] }),
    ));
