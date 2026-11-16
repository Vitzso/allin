import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import { password, profile } from './helpers.ts';
import { setup } from './httpHelpers.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';
const PHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';
const three = (idleMs?: number) => setup(idleMs, undefined, undefined, { maxSessions: 3 });
type Row = {
  key: string;
  device: string;
  startedAt: string;
  lastActiveAt: string;
  current: boolean;
};
const list = async (who: { call: (path: string) => Promise<Response> }) =>
  ((await (await who.call('/sessions')).json()) as { sessions: Row[] }).sessions;

test('with one slot, a second sign-in replaces the first', async () => {
  const app = await setup();
  try {
    await app.login();
    const second = app.device();
    await second.login();
    assert.equal((await app.call('/tasks')).status, 401);
    assert.equal((await second.call('/tasks')).status, 200);
    assert.equal(app.p.vault.unlocked, true);
  } finally {
    await app.close();
  }
});
test('with three slots, three devices stay signed in', async () => {
  const app = await three();
  try {
    await app.login();
    const b = app.device(),
      c = app.device();
    await b.login();
    await c.login();
    for (const who of [app, b, c]) assert.equal((await who.call('/tasks')).status, 200);
    assert.equal((await list(app)).length, 3);
  } finally {
    await app.close();
  }
});
test('a fourth sign-in replaces the device idle the longest', async () => {
  const app = await three();
  try {
    await app.login();
    const b = app.device(),
      c = app.device(),
      d = app.device();
    await b.login();
    await c.login();
    await wait(10);
    await app.call('/tasks');
    await wait(10);
    await c.call('/tasks');
    await wait(10);
    await d.login();
    assert.equal((await b.call('/tasks')).status, 401);
    for (const who of [app, c, d]) assert.equal((await who.call('/tasks')).status, 200);
    assert.equal(app.p.vault.unlocked, true);
  } finally {
    await app.close();
  }
});
test('one device expiring leaves the others signed in and the vault unlocked', async () => {
  const app = await three(1000);
  try {
    await app.login();
    const b = app.device();
    await wait(600);
    await b.login();
    await wait(600);
    assert.equal((await b.call('/tasks')).status, 200);
    assert.equal((await app.call('/tasks')).status, 401);
    assert.equal(app.p.vault.unlocked, true);
    assert.equal((await list(b)).length, 1);
  } finally {
    await app.close();
  }
});
test('the vault locks when the last session expires', async () => {
  const app = await three(200);
  try {
    await app.login();
    const b = app.device();
    await b.login();
    await wait(1500);
    assert.equal(app.p.vault.unlocked, false);
    assert.equal((await b.call('/tasks')).status, 401);
  } finally {
    await app.close();
  }
});
test('lock ends every session', async () => {
  const app = await three();
  try {
    await app.login();
    const b = app.device();
    await b.login();
    assert.equal((await app.call('/vault/lock', 'POST', {})).status, 200);
    assert.equal(app.p.vault.unlocked, false);
    assert.equal((await b.call('/tasks')).status, 401);
    assert.equal((await app.call('/tasks')).status, 401);
  } finally {
    await app.close();
  }
});
test('the list shows each device once, marks the caller, and never holds a cookie or token', async () => {
  const app = await three();
  try {
    await app.login();
    const phone = app.device(PHONE),
      mac = app.device(MAC);
    await phone.login();
    await mac.login();
    const response = await mac.call('/sessions');
    const text = await response.text();
    for (const who of [app, phone, mac]) {
      const { cookie, csrf } = who.session();
      assert.ok(!text.includes(cookie.split('=')[1]));
      assert.ok(!text.includes(csrf));
    }
    const { sessions } = JSON.parse(text) as { sessions: Row[] };
    assert.equal(sessions.length, 3);
    assert.deepEqual(
      sessions.map((s) => s.device),
      ['Safari on Mac', 'Safari on iPhone', 'Browser on this device'],
    );
    assert.deepEqual(
      sessions.map((s) => s.current),
      [true, false, false],
    );
    assert.equal(new Set(sessions.map((s) => s.key)).size, 3);
    for (const s of sessions) {
      assert.deepEqual(Object.keys(s).sort(), [
        'current',
        'device',
        'key',
        'lastActiveAt',
        'startedAt',
      ]);
      assert.match(s.key, /^[0-9a-f]{16}$/);
      assert.ok(
        !Number.isNaN(Date.parse(s.startedAt)) && !Number.isNaN(Date.parse(s.lastActiveAt)),
      );
    }
  } finally {
    await app.close();
  }
});
test('signing out another device ends only that one', async () => {
  const app = await three();
  try {
    await app.login();
    const b = app.device(PHONE);
    await b.login();
    const target = (await list(app)).find((s) => !s.current)!;
    const out = await app.call('/sessions/sign-out', 'POST', { key: target.key });
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { ok: true });
    assert.equal((await b.call('/tasks')).status, 401);
    assert.equal((await app.call('/tasks')).status, 200);
    assert.equal(app.p.vault.unlocked, true);
    assert.equal((await list(app)).length, 1);
  } finally {
    await app.close();
  }
});
test('signing out your own session ends it, and locks the vault if it was the last', async () => {
  const app = await three();
  try {
    await app.login();
    const b = app.device();
    await b.login();
    const mine = (await list(b)).find((s) => s.current)!;
    assert.equal((await b.call('/sessions/sign-out', 'POST', { key: mine.key })).status, 200);
    assert.equal((await b.call('/tasks')).status, 401);
    assert.equal(app.p.vault.unlocked, true);
    const last = (await list(app)).find((s) => s.current)!;
    assert.equal((await app.call('/sessions/sign-out', 'POST', { key: last.key })).status, 200);
    assert.equal(app.p.vault.unlocked, false);
    assert.equal((await app.call('/tasks')).status, 401);
  } finally {
    await app.close();
  }
});
test('signing out a key that no longer exists is a 404 and changes nothing', async () => {
  const app = await three();
  try {
    await app.login();
    const b = app.device();
    await b.login();
    const target = (await list(app)).find((s) => !s.current)!;
    assert.equal((await app.call('/sessions/sign-out', 'POST', { key: target.key })).status, 200);
    const again = await app.call('/sessions/sign-out', 'POST', { key: target.key });
    assert.equal(again.status, 404);
    assert.deepEqual(await again.json(), { error: 'That device is already signed out.' });
    const unknown = await app.call('/sessions/sign-out', 'POST', { key: '0123456789abcdef' });
    assert.equal(unknown.status, 404);
    assert.equal((await app.call('/tasks')).status, 200);
    assert.equal((await list(app)).length, 1);
    assert.equal(app.p.vault.unlocked, true);
  } finally {
    await app.close();
  }
});
test('reading the list does not keep a session alive', async () => {
  const app = await three(1000);
  try {
    await app.login();
    await wait(600);
    assert.equal((await app.call('/sessions')).status, 200);
    await wait(600);
    assert.equal((await app.call('/sessions')).status, 401);
  } finally {
    await app.close();
  }
});
test('one device’s token does not work with another device’s cookie', async () => {
  const app = await three();
  try {
    await app.login();
    const b = app.device();
    await b.login();
    const theirs = { 'X-AllIn-CSRF': b.session().csrf };
    assert.equal((await app.call('/tasks', 'GET', undefined, theirs)).status, 401);
    assert.equal((await app.call('/tasks', 'POST', { task: { title: 'x' } }, theirs)).status, 403);
  } finally {
    await app.close();
  }
});
test('signing in again from the same browser replaces its row instead of adding one', async () => {
  const app = await three();
  try {
    await app.login();
    // A new tab shares the cookie jar but has no token, so it sees the lock screen.
    const held = app.session().cookie;
    const status = await fetch(`${app.origin}/api/status`, { headers: { Cookie: held } });
    const bootstrap = status.headers.get('set-cookie')!.split(';')[0];
    const csrf = (await status.json()).csrf;
    const again = await fetch(`${app.origin}/api/vault/unlock`, {
      method: 'POST',
      headers: {
        Origin: app.origin,
        'Content-Type': 'application/json',
        'X-AllIn-CSRF': csrf,
        Cookie: `${held}; ${bootstrap}`,
      },
      body: JSON.stringify({ password }),
    });
    assert.equal(again.status, 200);
    const next = {
      Cookie: again.headers.get('set-cookie')!.split(';')[0],
      'X-AllIn-CSRF': (await again.json()).csrf,
    };
    assert.equal((await app.call('/tasks', 'GET', undefined, next)).status, 200);
    const { sessions } = (await (await app.call('/sessions', 'GET', undefined, next)).json()) as {
      sessions: Row[];
    };
    assert.equal(sessions.length, 1);
  } finally {
    await app.close();
  }
});
test('closing the server locks an unlocked vault', async () => {
  const app = await three();
  await app.login();
  assert.equal(app.p.vault.unlocked, true);
  await new Promise<void>((resolve, reject) =>
    app.server.close((error) => (error ? reject(error) : resolve())),
  );
  assert.equal(app.p.vault.unlocked, false);
  app.p.cleanup();
});
test('maxSessions must be a whole number of at least 1', () => {
  const p = profile();
  try {
    for (const maxSessions of [0, -1, 1.5, Number.NaN])
      assert.throws(() => createApp(p.vault, { port: 44001, maxSessions }), /maxSessions/);
  } finally {
    p.cleanup();
  }
});
