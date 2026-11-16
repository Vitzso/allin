import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Text checks only: nothing here builds or runs an image, because Docker isn't on the machines
// these tests run on. The image build and the running container are checked by the owner.
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');
const lines = (path: string) =>
  read(path)
    .split('\n')
    .map((line) => line.trim());
// A Dockerfile or compose line that isn't blank or a comment.
const code = (path: string) => lines(path).filter((line) => line && !line.startsWith('#'));

test('the image runs as a fixed non-root user from the compiled build', () => {
  const file = code('scripts/Dockerfile');
  assert.ok(file.includes('USER 10001:10001'));
  assert.ok(file.includes('CMD ["node", "build/server/index.js"]'));
  assert.ok(file.indexOf('USER 10001:10001') < file.findIndex((l) => l.startsWith('CMD')));
  assert.match(read('scripts/Dockerfile'), /useradd --uid 10001 --gid 10001/);
});

test('the image installs runtime dependencies only and copies no source, data, key or certificate', () => {
  const file = code('scripts/Dockerfile');
  assert.ok(file.some((line) => line.includes('npm ci --omit=dev --ignore-scripts')));
  const sources = file
    .filter((line) => line.startsWith('COPY'))
    .map((line) => line.split(/\s+/).slice(1, -1).join(' '));
  assert.deepEqual(sources, ['package.json package-lock.json', 'build', 'dist']);
  assert.ok(!file.some((line) => /^(ADD|COPY .*--from)/.test(line)));
});

// The release folder also holds tls/ and docker.env, which must not reach the Docker daemon.
test('the build context holds only what the image copies', () => {
  const ignore = code('scripts/dockerignore');
  assert.equal(ignore[0], '*');
  const kept = ignore.slice(1).map((line) => line.replace(/^!/, ''));
  assert.ok(ignore.slice(1).every((line) => line.startsWith('!')));
  const copied = code('scripts/Dockerfile')
    .filter((line) => line.startsWith('COPY'))
    .flatMap((line) => line.split(/\s+/).slice(1, -1));
  assert.deepEqual(kept.sort(), copied.sort());
});

test('the image creates the vault and key folders owner-only, apart from each other', () => {
  const text = read('scripts/Dockerfile');
  assert.match(text, /install -d -o allin -g allin -m 0700 \/data\/vault \/data\/keys/);
  const env = code('scripts/Dockerfile').find((line) => line.startsWith('ENV ALLIN_DATA_DIR'));
  assert.ok(env?.includes('ALLIN_DATA_DIR=/data/vault'));
  assert.ok(env?.includes('ALLIN_KEYSTORE_DIR=/data/keys'));
  // The user and the folders exist before the volumes are declared, so the volumes inherit them.
  assert.ok(text.indexOf('install -d') < text.indexOf('VOLUME'));
});

test('the image does not install bubblewrap', () => {
  assert.doesNotMatch(read('scripts/Dockerfile'), /bubblewrap|bwrap|apt-get|apt install/i);
});

test('compose uses host networking, a read-only file system, no capabilities and no-new-privileges', () => {
  const file = code('scripts/compose.yaml');
  for (const line of [
    'network_mode: host',
    'read_only: true',
    'cap_drop: [ALL]',
    "security_opt: ['no-new-privileges:true']",
    "tmpfs: ['/tmp']",
    'restart: unless-stopped',
    'env_file: docker.env',
  ])
    assert.ok(file.includes(line), `missing ${line}`);
});

test('compose keeps the vault and the keys in separate named volumes and mounts the certificate read-only', () => {
  const file = code('scripts/compose.yaml');
  assert.ok(file.includes('- allin-vault:/data/vault'));
  assert.ok(file.includes('- allin-keys:/data/keys'));
  assert.ok(file.includes('- ./tls:/etc/allin/tls:ro'));
  assert.ok(file.includes('allin-vault:') && file.includes('allin-keys:'));
});

// Compose names the volumes after the project. Without a fixed name that is the release folder,
// whose name carries the version, so an update would start on new, empty volumes.
test('compose fixes the project name, so the volume names survive an update', () => {
  assert.equal(code('scripts/compose.yaml')[0], 'name: allin');
});

test('compose publishes no ports and is not privileged', () => {
  const text = code('scripts/compose.yaml').join('\n');
  assert.doesNotMatch(text, /ports:|privileged|seccomp|apparmor|cap_add|pid:|userns|devices/);
});

test('the example environment leaves the address unset and does not set the data or key folders', () => {
  const file = lines('scripts/docker.env.example');
  for (const name of ['ALLIN_LISTEN', 'ALLIN_ORIGIN'])
    assert.ok(!file.some((line) => line.startsWith(`${name}=`)), `${name} must stay unset`);
  assert.ok(file.some((line) => line.startsWith('#ALLIN_LISTEN=')));
  assert.ok(file.some((line) => line.startsWith('#ALLIN_ORIGIN=')));
  assert.ok(file.includes('ALLIN_TLS_CERT=/etc/allin/tls/server.crt'));
  assert.ok(file.includes('ALLIN_TLS_KEY=/etc/allin/tls/server.key'));
  for (const name of ['ALLIN_DATA_DIR', 'ALLIN_KEYSTORE_DIR'])
    assert.ok(!file.some((line) => line.includes(name)), `${name} is set by the image`);
});

// For a box where WireGuard itself runs in a container. The file is an override used after
// compose.yaml, so every hardening line above still comes from that one file.
test('the WireGuard compose file changes the network line and nothing else', () => {
  const file = code('scripts/compose.wireguard.yaml');
  assert.equal(file.length, 3);
  assert.deepEqual(file.slice(0, 2), ['services:', 'allin:']);
  assert.match(file[2]!, /^network_mode: 'container:\$\{ALLIN_WIREGUARD_CONTAINER:\?[^}']+\}'$/);
  // It is an override: the service name is the one compose.yaml defines.
  assert.ok(code('scripts/compose.yaml').includes('allin:'));
});

// ${NAME:?message} stops compose when the name is unset or empty, so AllIn can't come up on
// some other network by accident.
test('the WireGuard compose file cannot run without a container name', () => {
  assert.match(read('scripts/compose.wireguard.yaml'), /\$\{ALLIN_WIREGUARD_CONTAINER:\?/);
  assert.doesNotMatch(read('scripts/compose.wireguard.yaml'), /\$\{ALLIN_WIREGUARD_CONTAINER:?-/);
  assert.ok(lines('scripts/compose.env.example').includes('ALLIN_WIREGUARD_CONTAINER='));
});

test('the example compose settings load both files, the base file first', () => {
  const file = code('scripts/compose.env.example');
  assert.deepEqual(file, [
    'COMPOSE_FILE=compose.yaml:compose.wireguard.yaml',
    'ALLIN_WIREGUARD_CONTAINER=',
  ]);
});

// npm ci reads the lock file, which doesn't record a package's "gypfile: false". So npm sees
// binding.gyp in the database module and runs node-gyp, which fails in the image (no Python or
// compiler) and is wasted work anywhere else: the module loads its shipped binary and never the
// compiled one. Installing with --ignore-scripts skips it. These checks keep that safe.
test('no runtime dependency needs an install script', () => {
  const lock = JSON.parse(read('package-lock.json')) as {
    packages: Record<string, { dev?: boolean; hasInstallScript?: boolean }>;
  };
  const needing = Object.entries(lock.packages)
    .filter(([, entry]) => !entry.dev && entry.hasInstallScript)
    .map(([path]) => path);
  assert.deepEqual(needing, []);
});

test('the only runtime dependency npm would compile ships Linux binaries instead', () => {
  const lock = JSON.parse(read('package-lock.json')) as {
    packages: Record<string, { dev?: boolean }>;
  };
  const compiled = Object.entries(lock.packages)
    .filter(([path, entry]) => path && !entry.dev && existsSync(join(repo, path, 'binding.gyp')))
    .map(([path]) => path);
  assert.deepEqual(compiled, ['node_modules/better-sqlite3-multiple-ciphers']);
  for (const target of ['linux-x64', 'linux-arm64'])
    assert.ok(existsSync(join(repo, compiled[0]!, 'prebuilds', `${target}.node`)), target);
});
