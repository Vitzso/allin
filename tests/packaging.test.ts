import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Builds the Linux release folder and inspects it. Nothing here runs the installer: that needs
// root on a Linux box.
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');
const made: string[] = [];
let release = '';

before(async () => {
  if (!existsSync(join(repo, 'build')) || !existsSync(join(repo, 'dist'))) {
    const built = spawnSync('npm', ['run', 'build'], { cwd: repo, encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
  }
  // Loaded by variable so the type checker doesn't need a declaration for the .mjs file.
  const module = await import(pathToFileURL(join(repo, 'scripts/package-linux.mjs')).href);
  const out = mkdtempSync(join(tmpdir(), 'allin-release-'));
  made.push(out);
  release = module.packageLinux(out);
});
after(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })));

function walk(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(folder, entry.name)) : [join(folder, entry.name)],
  );
}

test('the release folder holds exactly the listed entries', () => {
  assert.match(release, /allin-linux-\d+\.\d+\.\d+$/);
  assert.deepEqual(readdirSync(release).sort(), [
    '.dockerignore',
    'Dockerfile',
    'INSTALL_DOCKER.md',
    'INSTALL_LINUX.md',
    'allin.env.example',
    'allin.service',
    'build',
    'compose.env.example',
    'compose.wireguard.yaml',
    'compose.yaml',
    'dist',
    'docker.env.example',
    'install-linux.sh',
    'package-lock.json',
    'package.json',
  ]);
});

test('the release holds no data, key, certificate or environment file', () => {
  const banned = /(\.sqlite.*|\.allin-backup|\.pem|\.key|\.crt)$|^\.env|^(vault|lockout)\.json$/;
  for (const file of walk(release)) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    assert.doesNotMatch(name, banned, file);
    assert.ok(!file.includes('node_modules'), file);
  }
});

test('the unit runs as allin, from the compiled build, with the documented protections', () => {
  const unit = readFileSync(join(release, 'allin.service'), 'utf8');
  for (const line of [
    'User=allin',
    'Group=allin',
    'EnvironmentFile=/etc/allin/allin.env',
    'WorkingDirectory=/opt/allin',
    'ExecStart=/usr/bin/env node /opt/allin/build/server/index.js',
    'Restart=on-failure',
    'RestartSec=5',
    'UMask=0077',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'PrivateTmp=yes',
    'ReadWritePaths=/var/lib/allin',
    'WantedBy=multi-user.target',
  ])
    assert.ok(unit.split('\n').includes(line), `missing ${line}`);
});

test('the example environment sets the data and key folders and leaves the address unset', () => {
  const lines = readFileSync(join(release, 'allin.env.example'), 'utf8').split('\n');
  assert.ok(lines.includes('ALLIN_PORT=4310'));
  assert.ok(lines.includes('ALLIN_DATA_DIR=/var/lib/allin/vault'));
  assert.ok(lines.includes('ALLIN_KEYSTORE_DIR=/var/lib/allin/keys'));
  for (const name of ['ALLIN_LISTEN', 'ALLIN_ORIGIN', 'ALLIN_TLS_CERT', 'ALLIN_TLS_KEY'])
    assert.ok(!lines.some((line) => line.startsWith(`${name}=`)), `${name} must stay unset`);
  assert.ok(lines.includes('#ALLIN_TLS_CERT=/etc/allin/tls/server.crt'));
  assert.ok(lines.includes('#ALLIN_TLS_KEY=/etc/allin/tls/server.key'));
});

test('the installer is valid shell and never removes or changes /var/lib/allin', () => {
  const syntax = spawnSync('bash', ['-n', join(repo, 'scripts/install-linux.sh')], {
    encoding: 'utf8',
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  const code = read('scripts/install-linux.sh')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));
  for (const line of code) {
    if (/(^|[\s;|&])(rm|chown|chmod|mv|cp)\b/.test(line) && line.includes('/var/lib/allin'))
      // Creating the folders is allowed, and only inside the "only if missing" guard.
      assert.match(line, /^\s*(install -d|mkdir)\b|\bchown "?allin/, line);
    // A recursive change is allowed only on the staging copy of the app.
    if (/\b(chown|chmod) +-R/.test(line)) assert.match(line, /"\$staging"$/, line);
  }
  assert.doesNotMatch(code.join('\n'), /rm\b[^\n]*(\/var\/lib|\$\{?(vault|keys|data))/i);
});

// See tests/docker.test.ts: without --ignore-scripts npm compiles the database module, as root.
test('the installer installs runtime dependencies without running install scripts', () => {
  const installs = read('scripts/install-linux.sh')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line) && /\bnpm (ci|install)\b/.test(line));
  assert.equal(installs.length, 1);
  assert.match(installs[0]!, /npm ci --omit=dev --ignore-scripts\)$/);
});

test('the installer does not start the service', () => {
  const code = read('scripts/install-linux.sh')
    .split('\n')
    .filter((line) => !/^\s*(#|echo|printf)/.test(line));
  for (const line of code) {
    assert.doesNotMatch(line, /systemctl +(start|restart)/, line);
    assert.doesNotMatch(line, /enable --now/, line);
  }
});

test('the installer checks bubblewrap as the allin user, after creating that user', () => {
  const text = read('scripts/install-linux.sh');
  assert.match(text, /runuser -u allin -- .*bwrap --unshare-all --ro-bind \/ \/ true/);
  assert.ok(text.indexOf('useradd') !== -1);
  assert.ok(text.indexOf('useradd') < text.indexOf('runuser -u allin'));
});

test('the installer checks the Node that the service will find, on systemd’s default PATH', () => {
  const text = read('scripts/install-linux.sh');
  assert.match(text, /env -i PATH="\$svc_path" node/);
  assert.match(
    text,
    /svc_path=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/,
  );
  assert.doesNotMatch(text, /readlink -f "\$\(command -v node\)"/);
});

test('the installer makes the copied app readable, in the staging folder only', () => {
  const text = read('scripts/install-linux.sh');
  assert.match(text, /chmod -R u=rwX,go=rX "\$staging"\n/);
  assert.ok(text.indexOf('chmod -R u=rwX') < text.indexOf('mv "$staging" /opt/allin'));
});

test('the installer refuses to swap the app while the service is running, and does not stop it', () => {
  const text = read('scripts/install-linux.sh');
  const check = text.indexOf('systemctl is-active --quiet allin');
  assert.ok(check !== -1);
  assert.ok(check < text.indexOf('mv "$staging" /opt/allin'));
  assert.match(text.slice(check, check + 200), /systemctl stop allin first/);
});
