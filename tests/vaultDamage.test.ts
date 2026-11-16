import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { AppError, Vault } from '../server/vault.ts';
import { KDF_V1 } from '../server/crypto.ts';
import { MIGRATIONS } from '../server/migrations.ts';
import { addDays } from '../shared/time.ts';
import { profile, password } from './helpers.ts';

const isFault = (error: AppError) => error instanceof AppError && error.status >= 500;

// Writes straight to the unlocked database, because the app's own API refuses invalid records.
function storeRaw(vault: Vault, id: string, data: string) {
  (
    vault as unknown as {
      db(name: string): { prepare(sql: string): { run(...a: string[]): void } };
    }
  )
    .db('tasks')
    .prepare('INSERT OR REPLACE INTO records(id,data) VALUES (?,?)')
    .run(id, data);
}

// Far-future recurring tasks: the next date was computed in a loop that could never end.
function completeRecurring(dueDay: string, recurring: 'daily' | 'weekly') {
  const p = profile();
  try {
    p.vault.setup(password);
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T12:00:00Z') });
    const task = p.vault.createTask({ title: 'Someday', recurring, dueDay });
    const done = p.vault.updateTask(task.id, 1, { status: 'done' });
    assert.equal(done.status, 'done');
    return p.vault.tasks().filter((t) => t.status === 'open');
  } finally {
    mock.timers.reset();
    p.cleanup();
  }
}
test('completing a daily task on the last representable day finishes, with no next occurrence', () => {
  assert.deepEqual(completeRecurring('9999-12-31', 'daily'), []);
});
test('completing a weekly task whose next date would pass the last day finishes too', () => {
  assert.deepEqual(completeRecurring('9999-12-25', 'weekly'), []);
});
test('the day before the last representable day still gets its next occurrence', () => {
  assert.equal(completeRecurring('9999-12-30', 'daily')[0].dueDay, '9999-12-31');
});
test('a very old overdue task jumps straight to the next date on its cadence', () => {
  // 2000-01-03 was a Monday, and so is 2026-11-09.
  assert.equal(completeRecurring('2000-01-03', 'weekly')[0].dueDay, '2026-11-09');
});
test('adding days past the last representable day is an error, not a malformed date', () => {
  assert.throws(() => addDays('9999-12-31', 1), RangeError);
  assert.equal(addDays('9999-12-30', 1), '9999-12-31');
});

// Saved data that can't be read is a fault on this device, not a problem with the request.
for (const [name, id, data] of [
  ['a task that fails validation', '33333333-3333-4333-8333-333333333333', '{"title":""}'],
  ['a task that is not JSON', '33333333-3333-4333-8333-333333333333', '{ not json'],
] as const)
  test(`${name} is reported as a fault when tasks are read`, () => {
    const p = profile();
    try {
      p.vault.setup(password);
      storeRaw(p.vault, id, data);
      assert.throws(() => p.vault.tasks(), isFault);
      assert.throws(() => p.vault.export('a long recovery phrase 12345'), isFault);
    } finally {
      p.cleanup();
    }
  });
test('invalid saved settings are reported as a fault', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    storeRaw(p.vault, 'settings', '{"timezone":"Not/AZone"}');
    assert.throws(() => p.vault.settings(), isFault);
  } finally {
    p.cleanup();
  }
});
test('over HTTP, an unreadable saved task is a logged 500 that does not blame the request', async () => {
  const p = profile();
  const port = 44000 + Math.floor(Math.random() * 15000);
  const origin = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const server = createApp(p.vault, { port, log: (line) => logs.push(line) });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    const status = await fetch(`${origin}/api/status`);
    const boot = status.headers.get('set-cookie')!.split(';')[0];
    const made = await fetch(`${origin}/api/vault/setup`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: boot,
        'X-AllIn-CSRF': (await status.json()).csrf,
      },
      body: JSON.stringify({ password }),
    });
    const cookie = made.headers.get('set-cookie')!.split(';')[0];
    const { csrf } = await made.json();
    storeRaw(p.vault, '33333333-3333-4333-8333-333333333333', '{"title":"PRIVATE-SENTINEL"}');
    const response = await fetch(`${origin}/api/tasks`, {
      headers: { Cookie: cookie, 'X-AllIn-CSRF': csrf },
    });
    assert.equal(response.status, 500);
    assert.doesNotMatch((await response.json()).error, /check the fields|file format|SENTINEL/i);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0], /SENTINEL/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    p.cleanup();
  }
});

// Damage must stop the unlock with a clear message, rather than showing an empty vault.
function vaultWithTasks() {
  const p = profile();
  p.vault.setup(password);
  for (let i = 0; i < 300; i++)
    p.vault.createTask({ title: `Synthetic task number ${i} `.repeat(4) });
  p.vault.lock();
  return p;
}
for (const [name, damage] of [
  ['an emptied tasks database', (d: string) => writeFileSync(join(d, 'tasks.sqlite'), '')],
  ['a deleted tasks database', (d: string) => rmSync(join(d, 'tasks.sqlite'))],
  ['a deleted health database', (d: string) => rmSync(join(d, 'health.sqlite'))],
  ['an emptied markets database', (d: string) => writeFileSync(join(d, 'markets.sqlite'), '')],
  [
    'a corrupted page in the middle of the tasks database',
    (d: string) => {
      const file = join(d, 'tasks.sqlite');
      const bytes = readFileSync(file);
      bytes.fill(0x41, 8192, 12288);
      writeFileSync(file, bytes);
    },
  ],
] as const)
  test(`${name} stops the unlock and is reported as damage`, () => {
    const p = vaultWithTasks();
    try {
      damage(p.directory);
      assert.throws(
        () => p.vault.unlock(password),
        (error: AppError) => isFault(error) && /damaged/.test(error.message),
      );
      assert.equal(p.vault.unlocked, false);
    } finally {
      p.cleanup();
    }
  });
test('a deleted database is not silently recreated by a failed unlock', () => {
  const p = vaultWithTasks();
  try {
    rmSync(join(p.directory, 'tasks.sqlite'));
    assert.throws(() => p.vault.unlock(password));
    assert.equal(readdirSync(p.directory).includes('tasks.sqlite'), false);
  } finally {
    p.cleanup();
  }
});
test('an intact vault still unlocks with all its tasks', () => {
  const p = vaultWithTasks();
  try {
    p.vault.unlock(password);
    assert.equal(p.vault.tasks().length, 300);
  } finally {
    p.cleanup();
  }
});

// Setup must never destroy files it did not create.
test('setup refuses to run over existing databases and leaves them byte for byte', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    p.vault.createTask({ title: 'Precious' });
    p.vault.lock();
    const metadata = readFileSync(join(p.directory, 'vault.json'));
    rmSync(join(p.directory, 'vault.json'));
    const before = readFileSync(join(p.directory, 'tasks.sqlite'));
    assert.equal(p.vault.initialized, false);
    assert.throws(
      () => p.vault.setup(password),
      (error: AppError) => isFault(error) && /already/.test(error.message),
    );
    assert.deepEqual(readdirSync(p.directory).sort(), [
      'health.sqlite',
      'markets.sqlite',
      'tasks.sqlite',
    ]);
    assert.deepEqual(readFileSync(join(p.directory, 'tasks.sqlite')), before);
    // Putting the lost file back recovers everything.
    writeFileSync(join(p.directory, 'vault.json'), metadata);
    p.vault.unlock(password);
    assert.equal(p.vault.tasks()[0].title, 'Precious');
  } finally {
    p.cleanup();
  }
});
test('a setup that fails on its own still removes only what it created', () => {
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
    assert.deepEqual(readdirSync(p.directory), []);
    p.vault.setup(password);
    assert.equal(p.vault.unlocked, true);
  } finally {
    p.cleanup();
  }
});
