import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError, Vault } from '../server/vault.ts';
import { MIGRATIONS } from '../server/migrations.ts';
import {
  KDF_V1,
  KDF_V2,
  decryptBackup,
  derivePassword,
  domainKey,
  encryptBackup,
  seal,
  unseal,
  type Envelope,
  type Kdf,
} from '../server/crypto.ts';
import { MemoryKeyStore, password, preM1Profile, profile, recovery } from './helpers.ts';

// Only the tests that need the new cost build a Vault with KDF_V2; profile() uses KDF_V1.
const metadataFile = (directory: string) => join(directory, 'vault.json');
const tempFile = (directory: string) => join(directory, 'vault.json.tmp');
const readMetadata = (directory: string) =>
  JSON.parse(readFileSync(metadataFile(directory), 'utf8'));
const actions = (vault: Vault) => (vault.events() as { action: string }[]).map((e) => e.action);
const isStatus = (status: number) => (error: unknown) =>
  error instanceof AppError && error.status === status;

// Rewrites a fresh KDF_V1 vault.json in the exact shape older AllIn wrote: version 1, no kdf.
function makeVersion1(directory: string) {
  const { kdf, ...rest } = readMetadata(directory);
  assert.deepEqual(kdf, KDF_V1);
  writeFileSync(metadataFile(directory), JSON.stringify({ ...rest, version: 1 }));
}

test('a new vault records N=131072 and opens again', () => {
  const p = profile();
  const vault = new Vault(p.directory, p.keys, MIGRATIONS, KDF_V2);
  try {
    vault.setup(password);
    vault.createTask({ title: 'Kept' });
    vault.lock();
    const metadata = readMetadata(p.directory);
    assert.equal(metadata.version, 2);
    assert.deepEqual(metadata.kdf, KDF_V2);
    vault.unlock(password);
    assert.equal(vault.tasks()[0].title, 'Kept');
  } finally {
    vault.lock();
    p.cleanup();
  }
});

test('a version 1 vault still unlocks', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    p.vault.createTask({ title: 'Older' });
    p.vault.lock();
    makeVersion1(p.directory);
    const before = readFileSync(metadataFile(p.directory));
    const vault = new Vault(p.directory, p.keys, MIGRATIONS, KDF_V1);
    vault.unlock(password);
    assert.equal(vault.tasks()[0].title, 'Older');
    vault.lock();
    assert.deepEqual(readFileSync(metadataFile(p.directory)), before);
  } finally {
    p.cleanup();
  }
});

test('unlocking a version 1 vault with the new default upgrades it', () => {
  // The committed pre-M1 fixture is a genuine version 1 file written by older AllIn.
  const p = preM1Profile();
  let vault = new Vault(p.directory, p.keys);
  try {
    const before = readMetadata(p.directory);
    assert.equal(before.version, 1);
    assert.equal('kdf' in before, false);
    vault.unlock(password);
    const after = readMetadata(p.directory);
    assert.equal(after.version, 2);
    assert.deepEqual(after.kdf, KDF_V2);
    assert.equal(after.id, before.id);
    assert.notEqual(after.salt, before.salt);
    assert.equal(statSync(metadataFile(p.directory)).mode & 0o777, 0o600);
    assert.equal(existsSync(tempFile(p.directory)), false);
    assert.ok(actions(vault).includes('vault.kdf-upgrade'));
    vault.lock();
    const upgraded = readFileSync(metadataFile(p.directory));
    vault = new Vault(p.directory, p.keys);
    vault.unlock(password);
    assert.equal(vault.tasks()[0].title, 'Pre-M1 synthetic task');
    assert.deepEqual(readFileSync(metadataFile(p.directory)), upgraded);
  } finally {
    vault.lock();
    p.cleanup();
  }
});

test('a failed upgrade leaves the old file and still unlocks', () => {
  const p = profile();
  const vault = new Vault(p.directory, p.keys);
  try {
    p.vault.setup(password);
    p.vault.createTask({ title: 'Still here' });
    p.vault.lock();
    const before = readFileSync(metadataFile(p.directory));
    mkdirSync(tempFile(p.directory)); // a directory cannot be removed or written as a file
    vault.unlock(password);
    assert.equal(vault.tasks()[0].title, 'Still here');
    assert.deepEqual(readFileSync(metadataFile(p.directory)), before);
    assert.ok(statSync(tempFile(p.directory)).isDirectory());
    assert.equal(actions(vault).includes('vault.kdf-upgrade'), false);
  } finally {
    vault.lock();
    p.cleanup();
  }
});

test('a leftover vault.json.tmp does not block the next unlock, and the upgrade completes', () => {
  const p = profile();
  const vault = new Vault(p.directory, p.keys);
  try {
    p.vault.setup(password);
    p.vault.lock();
    writeFileSync(tempFile(p.directory), '{"version":2,"partial');
    vault.unlock(password);
    assert.deepEqual(readMetadata(p.directory).kdf, KDF_V2);
    assert.equal(existsSync(tempFile(p.directory)), false);
    assert.ok(actions(vault).includes('vault.kdf-upgrade'));
  } finally {
    vault.lock();
    p.cleanup();
  }
});

test('a vault never downgrades', () => {
  const p = profile();
  const stronger = new Vault(p.directory, p.keys, MIGRATIONS, KDF_V2);
  try {
    stronger.setup(password);
    stronger.lock();
    const before = readFileSync(metadataFile(p.directory));
    p.vault.unlock(password); // KDF_V1
    assert.deepEqual(readFileSync(metadataFile(p.directory)), before);
    assert.equal(readMetadata(p.directory).version, 2);
    assert.deepEqual(readMetadata(p.directory).kdf, KDF_V2);
  } finally {
    stronger.lock();
    p.cleanup();
  }
});

test('vault.json with out-of-range scrypt values is reported as damaged', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    p.vault.lock();
    const metadata = readMetadata(p.directory);
    for (const kdf of [
      { N: 2 ** 30, r: 8, p: 1 },
      { N: 32768, r: 64, p: 1 },
      { N: 32768, r: 8, p: 0 },
      { N: 1000, r: 8, p: 1 },
      undefined,
    ]) {
      writeFileSync(metadataFile(p.directory), JSON.stringify({ ...metadata, kdf }));
      assert.throws(() => p.vault.unlock(password), isStatus(500));
      assert.throws(() => p.vault.id, isStatus(500));
      assert.equal(p.vault.unlocked, false);
    }
  } finally {
    p.cleanup();
  }
});

test('a version 1 backup still restores', () => {
  const source = profile(),
    target = profile();
  try {
    source.vault.setup(password);
    source.vault.createTask({ title: 'From an old backup' });
    const data = decryptBackup(source.vault.export(recovery), recovery);
    const salt = randomBytes(16);
    const key = derivePassword(recovery, salt, KDF_V1);
    const backup = {
      format: 'allin-backup',
      version: 1,
      salt: salt.toString('base64'),
      payload: seal(Buffer.from(JSON.stringify(data)), key, 'allin-backup:v1'),
    };
    target.vault.setup(password, { backup, secret: recovery });
    assert.equal(target.vault.tasks()[0].title, 'From an old backup');
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

test('a new backup is version 2 and restores', () => {
  const source = profile(),
    target = profile();
  try {
    source.vault.setup(password);
    source.vault.createTask({ title: 'In a new backup' });
    // Export records the vault's own parameters.
    assert.deepEqual(source.vault.export(recovery).kdf, KDF_V1);
    const data = decryptBackup(source.vault.export(recovery), recovery);
    const backup = encryptBackup(data, recovery);
    assert.equal(backup.version, 2);
    assert.deepEqual(backup.kdf, KDF_V2);
    target.vault.setup(password, { backup, secret: recovery });
    assert.equal(target.vault.tasks()[0].title, 'In a new backup');
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

test('a backup with out-of-range scrypt values is refused', () => {
  const source = profile(),
    target = profile();
  try {
    source.vault.setup(password);
    const backup = source.vault.export(recovery);
    for (const kdf of [
      { N: 2 ** 30, r: 8, p: 1 },
      { N: 32768, r: 64, p: 1 },
      { N: 32768, r: 8, p: 0 },
      undefined,
    ]) {
      assert.throws(
        () => target.vault.setup(password, { backup: { ...backup, kdf }, secret: recovery }),
        isStatus(400),
      );
      assert.deepEqual(readdirSync(target.directory), []);
    }
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

test('a wrong passphrase on a version 2 vault is still a 401', () => {
  const p = profile();
  const vault = new Vault(p.directory, p.keys, MIGRATIONS, KDF_V2);
  try {
    vault.setup(password);
    vault.lock();
    assert.throws(() => vault.unlock('not the right passphrase'), isStatus(401));
    assert.equal(vault.unlocked, false);
  } finally {
    vault.lock();
    p.cleanup();
  }
});

// The upgrade must prove the new file opens, with the intended parameters, before it replaces the
// only wrapped copy of the key. These vaults change what reaches the disk through the write step.
type Metadata = { version: number; id: string; salt: string; kdf?: Kdf; master: Envelope };
class RewritingVault extends Vault {
  constructor(
    p: ReturnType<typeof profile>,
    private readonly rewrite: (metadata: Metadata, keys: MemoryKeyStore) => Metadata,
  ) {
    super(p.directory, p.keys);
  }
  protected override writeUpgradeFile(path: string, text: string) {
    super.writeUpgradeFile(
      path,
      JSON.stringify(this.rewrite(JSON.parse(text), this.keyStore as MemoryKeyStore)),
    );
  }
}
// The wrapping key as Vault derives it, from the passphrase, the device key and the file's salt.
function wrappingKey(metadata: Metadata, keys: MemoryKeyStore, kdf: Kdf) {
  const passwordKey = derivePassword(password, Buffer.from(metadata.salt, 'hex'), kdf);
  const device = Buffer.from(keys.get(metadata.id)!, 'hex');
  return domainKey(Buffer.concat([passwordKey, device]), 'device-and-password');
}
const context = (metadata: Metadata) => `allin-vault:${metadata.id}:v1`;
const rewrites: [string, (metadata: Metadata, keys: MemoryKeyStore) => Metadata][] = [
  [
    'does not unseal to the same master key',
    // Still a valid file, but its salt no longer derives the key that sealed the master key.
    (m) => ({ ...m, salt: (m.salt[0] === 'a' ? 'b' : 'a') + m.salt.slice(1) }),
  ],
  [
    'unseals to another master key',
    (m, keys) => ({
      ...m,
      master: seal(randomBytes(32), wrappingKey(m, keys, KDF_V2), context(m)),
    }),
  ],
  [
    'records other scrypt parameters',
    // Opens to the right master key, but at N=65536 rather than the N=131072 this vault asked for.
    (m, keys) => {
      const kdf = { N: 65536, r: 8, p: 1 };
      const master = unseal(m.master, wrappingKey(m, keys, KDF_V2), context(m));
      return { ...m, kdf, master: seal(master, wrappingKey(m, keys, kdf), context(m)) };
    },
  ],
];
for (const [name, rewrite] of rewrites)
  test(`a temp file that ${name} is discarded and vault.json is unchanged`, () => {
    const p = profile();
    const vault = new RewritingVault(p, rewrite);
    try {
      p.vault.setup(password);
      p.vault.createTask({ title: 'Unharmed' });
      p.vault.lock();
      const before = readFileSync(metadataFile(p.directory));
      vault.unlock(password);
      assert.equal(vault.tasks()[0].title, 'Unharmed');
      assert.deepEqual(readFileSync(metadataFile(p.directory)), before);
      assert.equal(existsSync(tempFile(p.directory)), false);
      assert.equal(actions(vault).includes('vault.kdf-upgrade'), false);
      vault.lock();
      p.vault.unlock(password);
      assert.equal(p.vault.tasks()[0].title, 'Unharmed');
    } finally {
      vault.lock();
      p.cleanup();
    }
  });
