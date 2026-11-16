import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import { AppError, Vault } from '../server/vault.ts';
import { KDF_V1 } from '../server/crypto.ts';
import {
  MIGRATIONS,
  MigrationError,
  NewerDatabaseError,
  migrate,
  type Migration,
} from '../server/migrations.ts';
import {
  domainDb,
  importRequest,
  password,
  preM1Profile,
  profile,
  userVersion,
} from './helpers.ts';

const version = (db: Database.Database) => db.pragma('user_version', { simple: true });
const tableNames = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
    (r) => r.name,
  );

test('pending migrations run in order and set the version', () => {
  const db = new Database(':memory:');
  const calls: string[] = [];
  migrate(db, [() => calls.push('a'), () => calls.push('b')]);
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(version(db), 2);
});

test('a second run does nothing', () => {
  const db = new Database(':memory:');
  let count = 0;
  const migrations: Migration[] = [() => count++, () => count++];
  migrate(db, migrations);
  migrate(db, migrations);
  assert.equal(count, 2);
  assert.equal(version(db), 2);
});

test('a failed migration rolls back and keeps the earlier version', () => {
  const db = new Database(':memory:');
  const bad: Migration = (d) => {
    d.exec('CREATE TABLE t2(x)');
    throw new Error('boom');
  };
  assert.throws(
    () => migrate(db, [(d) => d.exec('CREATE TABLE t1(x)'), bad]),
    (e: Error) => e instanceof MigrationError && (e.cause as Error).message === 'boom',
  );
  assert.equal(version(db), 1);
  assert.deepEqual(tableNames(db), ['t1']);
});

test('a database newer than the app knows is refused untouched', () => {
  const db = new Database(':memory:');
  db.pragma('user_version = 3');
  let called = false;
  assert.throws(
    () =>
      migrate(db, [
        () => {
          called = true;
        },
      ]),
    NewerDatabaseError,
  );
  assert.equal(called, false);
  assert.equal(version(db), 3);
});

test('a new vault starts at the current version for every database', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    for (const d of ['tasks', 'health', 'markets'] as const) {
      assert.equal(userVersion(p.vault, d), MIGRATIONS[d].length);
      const expected =
        d === 'health'
          ? [
              'events',
              'health_coverage',
              'health_settings',
              'records',
              'weight_days',
              'workout_days',
            ]
          : d === 'markets'
            ? ['events', 'feed_settings', 'market_alerts', 'market_bars', 'records']
            : ['events', 'records'];
      assert.deepEqual(tableNames(domainDb(p.vault, d)).sort(), expected);
    }
  } finally {
    p.cleanup();
  }
});

test('a vault made before migrations existed upgrades and keeps its data', () => {
  const p = preM1Profile();
  try {
    p.vault.unlock(password);
    assert.equal(p.vault.tasks()[0].title, 'Pre-M1 synthetic task');
    assert.equal(p.vault.settings().timezone, 'UTC');
    for (const d of ['tasks', 'health', 'markets'] as const)
      assert.equal(userVersion(p.vault, d), MIGRATIONS[d].length);
    p.vault.lock();
    p.vault.unlock(password); // a second unlock has nothing to migrate
    assert.equal(p.vault.tasks().length, 1);
  } finally {
    p.cleanup();
  }
});

test('a newer vault is refused with a message that says so, and it can still open later', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    p.vault.createTask({ title: 'Kept task' });
    p.vault.lock();
    // An app that knows no migrations sees databases ahead of it.
    const older = new Vault(p.directory, p.keys, { tasks: [], health: [], markets: [] }, KDF_V1);
    assert.throws(
      () => older.unlock(password),
      (e: AppError) =>
        e.status === 500 && /newer version of AllIn/.test(e.message) && !/damaged/.test(e.message),
    );
    assert.equal(older.unlocked, false);
    p.vault.unlock(password);
    assert.equal(p.vault.tasks()[0].title, 'Kept task');
  } finally {
    p.cleanup();
  }
});

test('a failed migration stops the unlock clearly and leaves the data usable', () => {
  const p = preM1Profile();
  try {
    const failing = {
      ...MIGRATIONS,
      health: [
        ...MIGRATIONS.health,
        () => {
          throw new Error('PRIVATE-MARKER');
        },
      ],
    };
    const broken = new Vault(p.directory, p.keys, failing, KDF_V1);
    assert.throws(
      () => broken.unlock(password),
      (e: AppError) =>
        e.status === 500 &&
        /could not upgrade/.test(e.message) &&
        /check AllIn's log\.$/.test(e.message) &&
        !/terminal|PRIVATE-MARKER/.test(e.message),
    );
    assert.equal(broken.unlocked, false);
    p.vault.unlock(password);
    assert.equal(p.vault.tasks()[0].title, 'Pre-M1 synthetic task');
  } finally {
    p.cleanup();
  }
});

test('an upgraded pre-M1 vault accepts an import', () => {
  const p = preM1Profile();
  try {
    p.vault.unlock(password);
    const result = p.vault.health.importRows(importRequest());
    assert.equal(result.workouts?.added, 4);
    assert.equal(result.weight?.added, 3);
    const db = domainDb(p.vault, 'health');
    assert.equal(
      (db.prepare('SELECT count(*) AS n FROM workout_days').get() as { n: number }).n,
      4,
    );
    assert.equal((db.prepare('SELECT count(*) AS n FROM weight_days').get() as { n: number }).n, 3);
    assert.equal(
      (db.prepare('SELECT count(*) AS n FROM health_coverage').get() as { n: number }).n,
      2,
    );
    assert.equal(p.vault.tasks()[0].title, 'Pre-M1 synthetic task');
  } finally {
    p.cleanup();
  }
});
