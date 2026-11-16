import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import { AppError, Vault } from '../server/vault.ts';
import { KDF_V1 } from '../server/crypto.ts';
import { MIGRATIONS } from '../server/migrations.ts';
import { weeklyReview } from '../shared/taskViews.ts';
import type { Task } from '../shared/schema.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profile, password } from './helpers.ts';

async function start(vault: Vault, lockoutFile?: string) {
  const port = 44000 + Math.floor(Math.random() * 15000);
  const origin = `http://127.0.0.1:${port}`;
  const server = createApp(vault, { port, log: () => {}, lockoutFile });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const post = async (path: string, body: unknown) => {
    const status = await fetch(`${origin}/api/status`);
    return fetch(`${origin}/api${path}`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: status.headers.get('set-cookie')!.split(';')[0],
        'X-AllIn-CSRF': (await status.json()).csrf,
      },
      body: JSON.stringify(body),
    });
  };
  return {
    port,
    origin,
    post,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('a missing device key is a device fault, not a passphrase failure', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    p.vault.lock();
    const missing = new Vault(
      p.directory,
      {
        label: 'macOS Keychain',
        get: () => null,
        set: () => {},
        delete: () => {},
      },
      MIGRATIONS,
      KDF_V1,
    );
    assert.throws(
      () => missing.unlock(password),
      (error: AppError) => error.status === 503,
    );
  } finally {
    p.cleanup();
  }
});
test('device faults never trigger the passphrase lockout', async () => {
  const p = profile();
  p.vault.setup(password);
  p.vault.lock();
  const missing = new Vault(
    p.directory,
    {
      label: 'macOS Keychain',
      get: () => null,
      set: () => {},
      delete: () => {},
    },
    MIGRATIONS,
    KDF_V1,
  );
  const app = await start(missing);
  try {
    for (let i = 0; i < 6; i++)
      assert.equal((await app.post('/vault/unlock', { password })).status, 503);
  } finally {
    await app.close();
    p.cleanup();
  }
});
test('a credential store failure during setup never triggers the lockout', async () => {
  const p = profile();
  const blocked = new Vault(
    p.directory,
    {
      label: 'macOS Keychain',
      get: () => null,
      set: () => {
        throw new Error('not available');
      },
      delete: () => {},
    },
    MIGRATIONS,
    KDF_V1,
  );
  const app = await start(blocked);
  try {
    for (let i = 0; i < 6; i++) {
      const response = await app.post('/vault/setup', { password });
      assert.equal(response.status, 500);
      // True on a Mac and on a server, where there is no terminal to look at.
      assert.equal(
        (await response.json()).error,
        "AllIn hit an unexpected problem. Try again. If it keeps happening, check AllIn's log.",
      );
    }
  } finally {
    await app.close();
    p.cleanup();
  }
});
test('cookies carry the port, so two profiles in one browser do not sign each other out', async () => {
  const p = profile();
  const app = await start(p.vault);
  try {
    const response = await app.post('/vault/setup', { password });
    assert.match(response.headers.get('set-cookie')!, new RegExp(`^allin_session_${app.port}=`));
    const status = await fetch(`${app.origin}/api/status`);
    assert.match(status.headers.get('set-cookie')!, new RegExp(`^allin_bootstrap_${app.port}=`));
  } finally {
    await app.close();
    p.cleanup();
  }
});
test('a planned task finished before its week still counts as completed', () => {
  const task: Task = {
    id: crypto.randomUUID(),
    version: 2,
    title: 'Finished early',
    project: 'Work',
    priority: 'medium',
    estimate: 45,
    dueDay: '2026-11-04',
    scheduledAt: null,
    recurring: 'none',
    actual: 45,
    status: 'done',
    createdAt: '2026-10-01T00:00:00.000Z',
    completedAt: '2026-10-30T10:00:00.000Z',
  };
  const review = weeklyReview([task], 'UTC', new Date('2026-11-06T12:00:00Z'), 1);
  assert.equal(review.plannedCount, 1);
  assert.equal(review.plannedCompletedCount, 1);
  assert.equal(review.completedCount, 0);
  assert.equal(review.plannedMissingEffort, 0);
});

const wrong = 'not the right passphrase';
async function failFive(app: Awaited<ReturnType<typeof start>>) {
  const last = [];
  for (let i = 0; i < 5; i++) last.push(await app.post('/vault/unlock', { password: wrong }));
  return last;
}
test('the lockout survives a server restart', async () => {
  const p = profile();
  const dir = mkdtempSync(join(tmpdir(), 'allin-lockout-'));
  const lockoutFile = join(dir, 'lockout.json');
  p.vault.setup(password);
  p.vault.lock();
  const first = await start(p.vault, lockoutFile);
  await failFive(first);
  await first.close();
  const second = await start(p.vault, lockoutFile);
  try {
    assert.equal((await second.post('/vault/unlock', { password })).status, 429);
  } finally {
    await second.close();
    rmSync(dir, { recursive: true, force: true });
    p.cleanup();
  }
});
test('the fifth wrong guess is told to try again in 1 minute', async () => {
  const p = profile();
  p.vault.setup(password);
  p.vault.lock();
  const app = await start(p.vault);
  try {
    const responses = await failFive(app);
    assert.deepEqual(
      responses.map((r) => r.status),
      [401, 401, 401, 401, 401],
    );
    const refused = await app.post('/vault/unlock', { password: wrong });
    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).error, 'Too many attempts. Try again in 1 minute.');
  } finally {
    await app.close();
    p.cleanup();
  }
});
test('a correct passphrase during the wait is still refused', async () => {
  const p = profile();
  p.vault.setup(password);
  p.vault.lock();
  const app = await start(p.vault);
  try {
    await failFive(app);
    assert.equal((await app.post('/vault/unlock', { password })).status, 429);
    assert.equal(p.vault.unlocked, false);
  } finally {
    await app.close();
    p.cleanup();
  }
});
