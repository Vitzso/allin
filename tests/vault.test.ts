import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { AppError, Vault } from '../server/vault.ts';
import { KDF_V1, encryptBackup } from '../server/crypto.ts';
import { MIGRATIONS } from '../server/migrations.ts';
import { MAX_BACKUP_BYTES, MAX_TASKS } from '../shared/schema.ts';
import { backupDataSchema } from '../shared/backupSchema.ts';
import { MAX_COVERAGE_RANGES, MAX_HEALTH_ROWS } from '../shared/healthSchema.ts';
import { addDays } from '../shared/time.ts';
import { importRequest, profile, password, recovery } from './helpers.ts';

test('locked vault refuses reads/writes and tasks survive a full vault restart', () => {
  const p = profile();
  try {
    assert.throws(() => p.vault.tasks(), /Unlock/);
    assert.throws(() => p.vault.createTask({ title: 'blocked' }), /Unlock/);
    p.vault.setup(password);
    const task = p.vault.createTask({ title: 'Persisted synthetic task' });
    p.vault.lock();
    const restarted = new Vault(p.directory, p.keys, MIGRATIONS, KDF_V1);
    assert.throws(() => restarted.tasks(), /Unlock/);
    assert.throws(() => restarted.unlock('not the right passphrase'), /Could not unlock/);
    restarted.unlock(password);
    assert.equal(restarted.tasks()[0].title, task.title);
    restarted.lock();
  } finally {
    p.cleanup();
  }
});
test('encrypted pages and on-disk artifacts contain no plaintext task marker; unkeyed SQLite fails', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    const marker = 'PRIVATE-SENTINEL-ALLIN-2938-synthetic';
    p.vault.createTask({ title: marker });
    for (const file of readdirSync(p.directory)) {
      const bytes = readFileSync(join(p.directory, file));
      assert.equal(bytes.includes(Buffer.from(marker)), false, file);
      assert.equal(bytes.includes(Buffer.from(password)), false, file);
      assert.equal(bytes.includes(Buffer.from('SQLite format 3')), false, file);
    }
    const db = new Database(join(p.directory, 'tasks.sqlite'));
    try {
      assert.throws(() => db.prepare('SELECT * FROM records').all());
    } finally {
      db.close();
    }
    assert.equal(
      readdirSync(p.directory).some((name) => name.endsWith('-wal') || name.endsWith('-journal')),
      false,
    );
  } finally {
    p.cleanup();
  }
});
test('authenticated encrypted backup restores on a clean profile with independent device key and password', () => {
  const source = profile(),
    target = profile();
  try {
    source.vault.setup(password);
    const task = source.vault.createTask({
      title: 'Recovery sentinel',
      project: 'Work',
      estimate: 45,
    });
    source.vault.updateTask(task.id, task.version, { status: 'done', actual: 40 });
    source.vault.setSettings({ timezone: 'UTC', weekAdjustment: 'Protect focus' });
    const backup = source.vault.export(recovery);
    assert.equal(JSON.stringify(backup).includes('Recovery sentinel'), false);
    target.vault.setup('different test passphrase 789', { backup, secret: recovery });
    assert.deepEqual(target.vault.tasks(), source.vault.tasks());
    assert.deepEqual(target.vault.settings(), source.vault.settings());
    target.vault.lock();
    target.vault.unlock('different test passphrase 789');
    assert.equal(target.vault.tasks().length, 1);
  } finally {
    source.cleanup();
    target.cleanup();
  }
});
test('wrong secret, tampered backup, unsupported schema, and duplicate IDs leave clean profile intact', () => {
  const source = profile(),
    target = profile();
  try {
    source.vault.setup(password);
    source.vault.createTask({ title: 'Original' });
    const backup = source.vault.export(recovery);
    assert.throws(() =>
      target.vault.setup(password, { backup, secret: 'wrong recovery phrase is wrong' }),
    );
    assert.equal(target.vault.initialized, false);
    assert.deepEqual(readdirSync(target.directory), []);
    const bad = structuredClone(backup);
    bad.payload.ciphertext =
      (bad.payload.ciphertext[0] === 'A' ? 'B' : 'A') + bad.payload.ciphertext.slice(1);
    assert.throws(() => target.vault.setup(password, { backup: bad, secret: recovery }));
    assert.deepEqual(readdirSync(target.directory), []);
    for (const data of [
      { format: 'allin-data', version: 999, tasks: [], settings: source.vault.settings() },
      {
        format: 'allin-data',
        version: 1,
        tasks: [...source.vault.tasks(), ...source.vault.tasks()],
        settings: source.vault.settings(),
      },
    ])
      assert.throws(() =>
        target.vault.setup(password, {
          backup: encryptBackup(data, recovery, KDF_V1),
          secret: recovery,
        }),
      );
    assert.deepEqual(readdirSync(target.directory), []);
    target.vault.setup(password);
    target.vault.createTask({ title: 'Keep existing state' });
    assert.throws(
      () => target.vault.setup(password, { backup, secret: recovery }),
      /already exists/,
    );
    assert.equal(target.vault.tasks()[0].title, 'Keep existing state');
  } finally {
    source.cleanup();
    target.cleanup();
  }
});
test('optimistic versions reject stale edits and capture retry is idempotent', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    const id = '22222222-2222-4222-8222-222222222222';
    const first = p.vault.createTask({ title: 'One task' }, id);
    assert.deepEqual(p.vault.createTask({ title: 'One task' }, id), first);
    assert.equal(p.vault.tasks().length, 1);
    assert.throws(() => p.vault.createTask({ title: 'Different task' }, id), /already used/);
    p.vault.updateTask(id, 1, { priority: 'high' });
    assert.throws(() => p.vault.updateTask(id, 1, { title: 'Stale write' }), /changed/);
    assert.throws(() => p.vault.deleteTask(id, 1), /changed/);
    assert.equal(p.vault.tasks()[0].title, 'One task');
  } finally {
    p.cleanup();
  }
});
// Completes a recurring task at a fixed instant and returns the next occurrence's due day.
function nextDue(
  input: { recurring: 'daily' | 'weekly'; dueDay?: string },
  completedAt: string,
  timezone = 'Asia/Jerusalem',
) {
  const p = profile();
  try {
    p.vault.setup(password);
    p.vault.setSettings({ timezone, weekAdjustment: '' });
    mock.timers.enable({ apis: ['Date'], now: Date.parse(completedAt) });
    const task = p.vault.createTask({ title: 'Recurring', ...input });
    p.vault.updateTask(task.id, 1, { status: 'done' });
    return p.vault.tasks().find((t) => t.status === 'open')!.dueDay;
  } finally {
    mock.timers.reset();
    p.cleanup();
  }
}
for (const [name, input, completedAt, timezone, want] of [
  // 22:30 UTC on Nov 6 is already 00:30 on Nov 7 in Jerusalem.
  [
    'undated, just past local midnight',
    { recurring: 'daily' },
    '2026-11-06T22:30:00Z',
    'Asia/Jerusalem',
    '2026-11-08',
  ],
  [
    'undated, same instant in New York',
    { recurring: 'daily' },
    '2026-11-06T22:30:00Z',
    'America/New_York',
    '2026-11-07',
  ],
  ['undated weekly', { recurring: 'weekly' }, '2026-11-06T12:00:00Z', 'UTC', '2026-11-13'],
  [
    'daily, on time',
    { recurring: 'daily', dueDay: '2026-11-06' },
    '2026-11-06T12:00:00Z',
    'UTC',
    '2026-11-07',
  ],
  [
    'daily, six days overdue',
    { recurring: 'daily', dueDay: '2026-11-01' },
    '2026-11-07T12:00:00Z',
    'UTC',
    '2026-11-08',
  ],
  [
    'weekly, overdue, keeps its weekday',
    { recurring: 'weekly', dueDay: '2026-11-02' },
    '2026-11-12T12:00:00Z',
    'UTC',
    '2026-11-16',
  ],
  [
    'daily, completed early',
    { recurring: 'daily', dueDay: '2026-11-10' },
    '2026-11-07T12:00:00Z',
    'UTC',
    '2026-11-11',
  ],
  [
    'weekly, completed early',
    { recurring: 'weekly', dueDay: '2026-11-13' },
    '2026-11-07T12:00:00Z',
    'UTC',
    '2026-11-20',
  ],
] as const)
  test(`next occurrence: ${name}`, () => {
    assert.equal(nextDue(input, completedAt, timezone), want);
  });
test('reopening an undated recurring task on a later day does not create a second successor', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-07T12:00:00Z') });
    const task = p.vault.createTask({ title: 'Recurring', recurring: 'daily' });
    p.vault.updateTask(task.id, 1, { status: 'done' });
    p.vault.updateTask(task.id, 2, { status: 'open' });
    mock.timers.setTime(Date.parse('2026-11-09T12:00:00Z'));
    p.vault.updateTask(task.id, 3, { status: 'done' });
    assert.equal(p.vault.tasks().length, 2);
  } finally {
    mock.timers.reset();
    p.cleanup();
  }
});
test('a damaged database is reported as damage, not as a wrong passphrase', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    p.vault.lock();
    const file = join(p.directory, 'tasks.sqlite');
    const bytes = readFileSync(file);
    bytes.fill(0x41, 0, 4096);
    writeFileSync(file, bytes);
    assert.throws(
      () => p.vault.unlock('not the right passphrase'),
      (error: AppError) => error.status === 401,
    );
    assert.throws(
      () => p.vault.unlock(password),
      (error: AppError) => error.status === 500 && !/check your passphrase/i.test(error.message),
    );
    assert.equal(p.vault.unlocked, false);
  } finally {
    p.cleanup();
  }
});
test('an unavailable credential store is reported as such, not as a wrong passphrase', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    p.vault.lock();
    const blocked = new Vault(
      p.directory,
      {
        label: 'macOS Keychain',
        get: () => {
          throw new Error('denied');
        },
        set: () => {},
        delete: () => {},
      },
      MIGRATIONS,
      KDF_V1,
    );
    assert.throws(
      () => blocked.unlock(password),
      (error: AppError) =>
        error.status === 503 &&
        error.message ===
          'macOS Keychain did not provide the device key. Allow access to it and try again.',
    );
  } finally {
    p.cleanup();
  }
});
test('a key store other than the Keychain is named, without asking to allow access', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    p.vault.lock();
    const blocked = new Vault(
      p.directory,
      {
        label: 'Linux key file',
        get: () => {
          throw new Error('The key store folder is not safe to use.');
        },
        set: () => {},
        delete: () => {},
      },
      MIGRATIONS,
      KDF_V1,
    );
    assert.throws(
      () => blocked.unlock(password),
      (error: AppError) =>
        error.status === 503 &&
        error.message ===
          "The key store (Linux key file) did not provide the device key. Try again, and if it keeps happening check AllIn's log.",
    );
  } finally {
    p.cleanup();
  }
});
test('a damaged vault file is reported as damage, not as an invalid request', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    p.vault.lock();
    writeFileSync(join(p.directory, 'vault.json'), '{ not json');
    assert.throws(
      () => p.vault.unlock(password),
      (error: AppError) => error.status === 500 && /vault file/i.test(error.message),
    );
  } finally {
    p.cleanup();
  }
});
test('a backup that cannot be opened is a 400 that names the file and phrase', () => {
  const source = profile(),
    target = profile();
  try {
    source.vault.setup(password);
    const backup = source.vault.export(recovery);
    assert.throws(
      () => target.vault.setup(password, { backup, secret: 'wrong recovery phrase is wrong' }),
      (error: AppError) => error.status === 400 && /recovery phrase/.test(error.message),
    );
  } finally {
    source.cleanup();
    target.cleanup();
  }
});
test('recurrence creates exactly one next occurrence and missing effort remains null', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T12:00:00Z') });
    const task = p.vault.createTask({
      title: 'Weekly chore',
      recurring: 'weekly',
      dueDay: '2026-11-06',
    });
    p.vault.updateTask(task.id, 1, { status: 'done' });
    assert.equal(p.vault.tasks().length, 2);
    const next = p.vault.tasks().find((t) => t.status === 'open')!;
    assert.equal(next.dueDay, '2026-11-13');
    assert.equal(next.actual, null);
    assert.throws(() => p.vault.updateTask(task.id, 1, { status: 'done' }), /changed/);
    assert.equal(p.vault.tasks().length, 2);
  } finally {
    mock.timers.reset();
    p.cleanup();
  }
});
test('failed credential store setup leaves no usable vault', () => {
  const p = profile();
  try {
    const blocked = new Vault(
      p.directory,
      {
        label: 'unavailable',
        get: () => null,
        set: () => {
          throw new Error('not available');
        },
        delete: () => {},
      },
      MIGRATIONS,
      KDF_V1,
    );
    assert.throws(() => blocked.setup(password), /not available/);
    assert.equal(blocked.initialized, false);
    assert.equal(blocked.unlocked, false);
  } finally {
    p.cleanup();
  }
});
test('partial edits preserve all omitted fields, including completion and recurring settings', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    const original = p.vault.createTask({
      title: 'Keep details',
      project: 'Work',
      priority: 'high',
      estimate: 60,
      dueDay: '2026-11-07',
      scheduledAt: '2026-11-06T23:30:00.000Z',
      recurring: 'weekly',
      actual: 45,
    });
    const done = p.vault.updateTask(original.id, 1, { status: 'done' });
    for (const field of [
      'project',
      'priority',
      'estimate',
      'dueDay',
      'scheduledAt',
      'recurring',
      'actual',
    ] as const)
      assert.equal(done[field], original[field], field);
    const renamed = p.vault.updateTask(original.id, done.version, { title: 'New title' });
    assert.equal(renamed.status, 'done');
    assert.equal(renamed.completedAt, done.completedAt);
    assert.equal(renamed.project, 'Work');
  } finally {
    p.cleanup();
  }
});
test('reopening and completing a recurring occurrence does not create duplicate successors', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    const task = p.vault.createTask({
      title: 'Recurring',
      recurring: 'daily',
      dueDay: '2026-11-06',
    });
    p.vault.updateTask(task.id, 1, { status: 'done' });
    p.vault.updateTask(task.id, 2, { status: 'open' });
    p.vault.updateTask(task.id, 3, { status: 'done' });
    assert.equal(p.vault.tasks().length, 2);
  } finally {
    p.cleanup();
  }
});
test('largest supported task snapshot fits the shared recovery file and request limits', () => {
  const tasks = Array.from({ length: MAX_TASKS }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    title: '界'.repeat(240),
    project: 'Wellbeing',
    priority: 'medium',
    estimate: 480,
    dueDay: '2026-11-07',
    scheduledAt: '2026-11-07T01:00:00.000Z',
    recurring: 'weekly',
    actual: 1440,
    status: 'done',
    version: 999999,
    createdAt: '2026-11-06T01:00:00.000Z',
    completedAt: '2026-11-06T02:00:00.000Z',
  }));
  const day = (i: number) => addDays('1900-01-01', i);
  const data = backupDataSchema.parse({
    format: 'allin-data',
    version: 2,
    tasks,
    settings: { timezone: 'America/Argentina/Buenos_Aires', weekAdjustment: '界'.repeat(240) },
    health: {
      workouts: Array.from({ length: MAX_HEALTH_ROWS }, (_, i) => ({ day: day(i), workouts: 100 })),
      weights: Array.from({ length: MAX_HEALTH_ROWS }, (_, i) => ({
        day: day(i),
        weightKg: 999.123456789012,
      })),
      coverage: Array.from({ length: MAX_COVERAGE_RANGES }, (_, i) => ({
        category: i % 2 === 0 ? 'workouts' : 'weight',
        from: day(i),
        to: day(i),
        sourceVersion: 1,
        exportedAt: '2026-11-06T18:00:00.123456Z',
        importedAt: '2026-11-06T20:00:00.123Z',
      })),
      workoutGoal: 14,
    },
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(encryptBackup(data, recovery, KDF_V1))) < MAX_BACKUP_BYTES,
  );
});
const NOW = new Date('2026-11-06T20:00:00.000Z');
test('a backup carries Health data to a clean profile', () => {
  const source = profile(),
    target = profile();
  try {
    source.vault.setup(password);
    source.vault.health.importRows(importRequest(), NOW);
    source.vault.health.setGoal({ workoutGoal: 3 });
    const backup = source.vault.export(recovery);
    assert.equal(backup.version, 2);
    target.vault.setup('different test passphrase 789', { backup, secret: recovery });
    const restored = target.vault.health.backupData();
    assert.ok(restored.workouts.length > 0 && restored.weights.length > 0);
    assert.equal(restored.workoutGoal, 3);
    assert.deepEqual(restored, source.vault.health.backupData());
    assert.deepEqual(target.vault.health.summary(NOW), source.vault.health.summary(NOW));
    assert.equal(target.vault.health.summary(NOW).state, 'imported');
  } finally {
    source.cleanup();
    target.cleanup();
  }
});
test('a version 1 backup restores with empty Health and Monday weeks', () => {
  const target = profile();
  try {
    const backup = encryptBackup(
      {
        format: 'allin-data',
        version: 1,
        tasks: [],
        settings: { timezone: 'UTC', weekAdjustment: '' },
      },
      recovery,
      KDF_V1,
    );
    target.vault.setup(password, { backup, secret: recovery });
    assert.equal(target.vault.health.summary(NOW).state, 'empty');
    assert.equal(target.vault.settings().weekStart, 1);
  } finally {
    target.cleanup();
  }
});
const damaged: [string, (health: any) => void][] = [
  ['duplicate workout days', (h) => h.workouts.push({ ...h.workouts[0] })],
  ['a zero weight', (h) => (h.weights[0].weightKg = 0)],
  ['an unknown field', (h) => (h.extra = true)],
  [
    'a coverage range that runs backwards',
    (h) => ([h.coverage[0].from, h.coverage[0].to] = [h.coverage[0].to, '0001-01-01']),
  ],
  [
    'a coverage time with an offset the summary rejects',
    (h) => (h.coverage[0].exportedAt = 'yesterday'),
  ],
];
for (const [name, damage] of damaged)
  test(`a backup with ${name} leaves the profile clean`, () => {
    const source = profile(),
      target = profile();
    try {
      source.vault.setup(password);
      source.vault.health.importRows(importRequest(), NOW);
      const health = structuredClone(source.vault.health.backupData());
      damage(health);
      const backup = encryptBackup(
        { format: 'allin-data', version: 2, tasks: [], settings: source.vault.settings(), health },
        recovery,
        KDF_V1,
      );
      assert.throws(
        () => target.vault.setup(password, { backup, secret: recovery }),
        (error: any) => error instanceof AppError && error.status === 400,
      );
      assert.deepEqual(readdirSync(target.directory), []);
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });
