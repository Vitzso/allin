import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { profile, password, recovery } from './helpers.ts';
import { setup } from './httpHelpers.ts';

test('API refuses locked and unauthenticated reads and writes, but synthetic modules are independent', async () => {
  const app = await setup();
  try {
    assert.equal((await app.call('/tasks')).status, 401);
    assert.equal((await app.call('/tasks', 'POST', { task: { title: 'blocked' } })).status, 401);
    assert.equal((await app.call('/demo/markets')).status, 200);
    assert.equal((await app.call('/demo/health')).status, 200);
    await app.login();
    assert.equal((await app.call('/tasks')).status, 200);
    assert.equal((await app.call('/tasks', 'GET', undefined, { Cookie: '' })).status, 401);
    await app.call('/vault/lock', 'POST', {});
    assert.equal((await app.call('/tasks')).status, 401);
    assert.equal((await app.call('/demo/health')).status, 200);
  } finally {
    await app.close();
  }
});
test('exact Host, Origin, fetch metadata and CSRF are enforced', async () => {
  const app = await setup();
  try {
    await app.login();
    for (const headers of [
      { Origin: 'https://hostile.example' },
      { Origin: 'null' },
      { 'X-AllIn-CSRF': 'wrong' },
      { Origin: '' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ] as Record<string, string>[])
      assert.equal(
        (await app.call('/tasks', 'POST', { task: { title: 'blocked' } }, headers)).status,
        403,
      );
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        app.origin + '/api/status',
        { headers: { Host: 'hostile.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
    assert.equal(app.p.vault.tasks().length, 0);
    assert.equal((await app.call('/tasks', 'POST', { task: { title: 'allowed' } })).status, 201);
  } finally {
    await app.close();
  }
});
test('session expiry revokes private reads and closes the vault', async () => {
  const app = await setup(40);
  try {
    await app.login();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((await app.call('/tasks')).status, 401);
    assert.equal(app.p.vault.unlocked, false);
  } finally {
    await app.close();
  }
});
test('mutations reject non-JSON, invalid schema, oversized input, and stale record versions', async () => {
  const app = await setup();
  try {
    await app.login();
    assert.equal(
      (await app.call('/tasks', 'POST', { task: { title: 'Bad', unknown: 'not allowed' } })).status,
      400,
    );
    assert.equal(
      (
        await app.call(
          '/tasks',
          'POST',
          { task: { title: 'Bad' } },
          { 'Content-Type': 'text/plain' },
        )
      ).status,
      415,
    );
    assert.equal(
      (await app.call('/tasks', 'POST', { task: { title: 'x'.repeat(24_005_000) } })).status,
      413,
    );
    const created = await (await app.call('/tasks', 'POST', { task: { title: 'Task' } })).json();
    assert.equal(
      (
        await app.call(`/tasks/${created.id}`, 'PATCH', {
          version: 1,
          changes: { title: 'Changed' },
        })
      ).status,
      200,
    );
    assert.equal(
      (await app.call(`/tasks/${created.id}`, 'PATCH', { version: 1, changes: { title: 'Stale' } }))
        .status,
      409,
    );
  } finally {
    await app.close();
  }
});
type App = Awaited<ReturnType<typeof setup>>;
// A browser or tab with no session of its own, starting from the public status endpoint.
async function freshClient(app: App) {
  const status = await fetch(`${app.origin}/api/status`);
  const cookie = status.headers.get('set-cookie')!.split(';')[0];
  const { csrf, unlocked } = await status.json();
  return { cookie, csrf, unlocked };
}
const unlockAs = (app: App, client: { cookie: string; csrf: string }, passphrase: string) =>
  app.call(
    '/vault/unlock',
    'POST',
    { password: passphrase },
    {
      Cookie: client.cookie,
      'X-AllIn-CSRF': client.csrf,
    },
  );

test('a stolen session cookie alone cannot read, write, or obtain the session token', async () => {
  const app = await setup();
  try {
    await app.login();
    const cookieOnly = { Cookie: app.session().cookie };
    const status = await (await fetch(`${app.origin}/api/status`, { headers: cookieOnly })).json();
    assert.equal(status.unlocked, false);
    assert.notEqual(status.csrf, app.session().csrf);
    assert.equal((await fetch(`${app.origin}/api/tasks`, { headers: cookieOnly })).status, 401);
    const write = await fetch(`${app.origin}/api/tasks`, {
      method: 'POST',
      headers: {
        ...cookieOnly,
        Origin: app.origin,
        'Content-Type': 'application/json',
        'X-AllIn-CSRF': status.csrf,
      },
      body: JSON.stringify({ task: { title: 'blocked' } }),
    });
    assert.equal(write.status, 403);
    assert.equal(app.p.vault.tasks().length, 0);
  } finally {
    await app.close();
  }
});
test('a page reload keeps the session when it presents both cookie and token', async () => {
  const app = await setup();
  try {
    await app.login();
    const status = await (await app.call('/status')).json();
    assert.equal(status.unlocked, true);
    assert.equal(status.csrf, app.session().csrf);
    assert.equal((await app.call('/tasks')).status, 200);
  } finally {
    await app.close();
  }
});
test('cookie-only requests do not keep an idle vault open', async () => {
  const app = await setup(300);
  try {
    await app.login();
    const cookieOnly = { Cookie: app.session().cookie };
    for (let i = 0; i < 8; i++) {
      await fetch(`${app.origin}/api/tasks`, { headers: cookieOnly });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await app.call('/tasks')).status, 401);
    assert.equal(app.p.vault.unlocked, false);
  } finally {
    await app.close();
  }
});
test('the correct passphrase takes over an open vault from another browser', async () => {
  const app = await setup();
  try {
    await app.login();
    const original = app.session();
    const client = await freshClient(app);
    assert.equal(client.unlocked, false);
    const taken = await unlockAs(app, client, password);
    assert.equal(taken.status, 200);
    const next = {
      Cookie: taken.headers.get('set-cookie')!.split(';')[0],
      'X-AllIn-CSRF': (await taken.json()).csrf,
    };
    assert.equal((await app.call('/tasks', 'GET', undefined, next)).status, 200);
    assert.equal(
      (
        await app.call('/tasks', 'GET', undefined, {
          Cookie: original.cookie,
          'X-AllIn-CSRF': original.csrf,
        })
      ).status,
      401,
    );
  } finally {
    await app.close();
  }
});
test('a wrong passphrase leaves the open session untouched', async () => {
  const app = await setup();
  try {
    await app.login();
    const client = await freshClient(app);
    assert.equal((await unlockAs(app, client, 'not the right passphrase')).status, 401);
    assert.equal((await app.call('/tasks')).status, 200);
    assert.equal(app.p.vault.unlocked, true);
  } finally {
    await app.close();
  }
});
test('repeated wrong passphrases still trigger the lockout', async () => {
  const app = await setup();
  try {
    await app.login();
    const client = await freshClient(app);
    for (let i = 0; i < 5; i++)
      assert.equal((await unlockAs(app, client, 'not the right passphrase')).status, 401);
    assert.equal((await unlockAs(app, client, password)).status, 429);
  } finally {
    await app.close();
  }
});
test('a damaged vault does not consume passphrase attempts', async () => {
  const app = await setup();
  try {
    await app.login();
    await app.call('/vault/lock', 'POST', {});
    const file = join(app.p.directory, 'tasks.sqlite');
    const bytes = readFileSync(file);
    bytes.fill(0x41, 0, 4096);
    writeFileSync(file, bytes);
    const client = await freshClient(app);
    for (let i = 0; i < 6; i++) {
      const response = await unlockAs(app, client, password);
      assert.equal(response.status, 500);
      assert.doesNotMatch((await response.json()).error, /check your passphrase/i);
    }
  } finally {
    await app.close();
  }
});
test('an unexpected failure is a 500 that does not blame the input or log private data', async () => {
  const app = await setup();
  try {
    await app.login();
    app.p.vault.tasks = () => {
      throw new Error('PRIVATE-SENTINEL task title');
    };
    const response = await app.call('/tasks');
    assert.equal(response.status, 500);
    const { error } = await response.json();
    assert.doesNotMatch(error, /input|recovery phrase|device key|PRIVATE-SENTINEL/i);
    assert.equal(app.logs.length, 1);
    assert.match(app.logs[0], /GET \/api\/tasks/);
    assert.doesNotMatch(app.logs[0], /PRIVATE-SENTINEL/);
  } finally {
    await app.close();
  }
});
test('a task id is not written to the log when a task route fails', async () => {
  const app = await setup();
  try {
    await app.login();
    const created = await (await app.call('/tasks', 'POST', { task: { title: 'Task' } })).json();
    app.p.vault.updateTask = () => {
      throw new Error('failure');
    };
    const response = await app.call(`/tasks/${created.id}`, 'PATCH', {
      version: 1,
      changes: { title: 'x' },
    });
    assert.equal(response.status, 500);
    assert.doesNotMatch(app.logs.join('\n'), new RegExp(created.id));
  } finally {
    await app.close();
  }
});
test('expected request errors stay 4xx and are not logged', async () => {
  const app = await setup();
  try {
    await app.login();
    for (const body of [null, [], 'text', 7])
      assert.equal((await app.call('/tasks', 'POST', body)).status, 400, JSON.stringify(body));
    assert.equal((await app.call('/tasks', 'POST', { task: { title: '' } })).status, 400);
    assert.equal((await fetch(`${app.origin}/%E0%A4%A`)).status, 400);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(app.origin, { path: '//' }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 400);
    assert.deepEqual(app.logs, []);
  } finally {
    await app.close();
  }
});
test('a wrong recovery phrase on restore is a 400 and counts as an attempt', async () => {
  const source = profile();
  const app = await setup();
  try {
    source.vault.setup(password);
    const backup = source.vault.export(recovery);
    const client = await freshClient(app);
    const attempt = () =>
      app.call(
        '/vault/restore',
        'POST',
        { password, backup, secret: 'wrong recovery phrase is wrong' },
        { Cookie: client.cookie, 'X-AllIn-CSRF': client.csrf },
      );
    for (let i = 0; i < 5; i++) assert.equal((await attempt()).status, 400);
    assert.equal((await attempt()).status, 429);
    assert.deepEqual(app.logs, []);
  } finally {
    source.cleanup();
    await app.close();
  }
});
test('opening the app without a build says how to build it', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'allin-no-dist-'));
  const app = await setup(undefined, empty);
  try {
    const response = await fetch(`${app.origin}/`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /npm run build/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    await app.close();
  }
});
test('npm start refuses to launch without a build', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'allin-no-dist-'));
  const root = resolve(import.meta.dirname, '..');
  // The launcher looks for dist beside itself, so a copy of the source with no dist is the
  // unbuilt case, whatever the launch folder holds.
  const copy = join(empty, 'app');
  mkdirSync(copy);
  for (const name of ['server', 'shared', 'package.json'])
    cpSync(join(root, name), join(copy, name), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'));
  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(join(root, 'node_modules/tsx/dist/esm/index.mjs')).href,
      join(copy, 'server/index.ts'),
    ],
    {
      cwd: empty,
      env: { ...process.env, ALLIN_DATA_DIR: join(empty, 'data'), ALLIN_PORT: '47399' },
    },
  );
  let stderr = '';
  child.stderr.on('data', (part) => (stderr += part));
  const killer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    const code = await new Promise((done) => child.on('exit', (exit) => done(exit)));
    assert.equal(code, 1);
    assert.match(stderr, /npm run build/);
  } finally {
    clearTimeout(killer);
    child.kill('SIGKILL');
    rmSync(empty, { recursive: true, force: true });
  }
});
test('response policy disables caching, framing and external destinations', async () => {
  const app = await setup();
  try {
    const response = await app.call('/status');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy')!, /connect-src 'self';/);
    assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  } finally {
    await app.close();
  }
});
