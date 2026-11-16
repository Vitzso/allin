import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { password, profile } from './helpers.ts';
import { setup } from './httpHelpers.ts';
import { makeCertificate } from './tlsHelpers.ts';

type Reply = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

async function start() {
  const p = profile(),
    dir = mkdtempSync(join(tmpdir(), 'allin-tls-')),
    tls = makeCertificate(dir, 'allin.test'),
    port = 44000 + Math.floor(Math.random() * 15000),
    origin = `https://allin.test:${port}`,
    server = createApp(p.vault, { port, origin, tls, log: () => {} });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const call = (
    path: string,
    o: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      maxVersion?: 'TLSv1.2';
    } = {},
  ) =>
    new Promise<Reply>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: o.method ?? 'GET',
          servername: 'allin.test',
          ca: tls.cert,
          maxVersion: o.maxVersion,
          headers: {
            Host: `allin.test:${port}`,
            ...(o.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...o.headers,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end(o.body === undefined ? undefined : JSON.stringify(o.body));
    });
  return {
    port,
    origin,
    call,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      p.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('status answers over HTTPS for the configured host', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/api/status')).status, 200);
  } finally {
    await s.close();
  }
});

test('the old loopback host is refused in network mode', async () => {
  const s = await start();
  try {
    const r = await s.call('/api/status', { headers: { Host: `127.0.0.1:${s.port}` } });
    assert.equal(r.status, 403);
    assert.match(r.body, /Open the address AllIn was set up with/);
  } finally {
    await s.close();
  }
});

test('a request with another Origin is refused', async () => {
  const s = await start();
  try {
    for (const origin of [
      `https://127.0.0.1:${s.port}`,
      `http://allin.test:${s.port}`,
      'https://evil.test',
    ])
      assert.equal((await s.call('/api/status', { headers: { Origin: origin } })).status, 403);
  } finally {
    await s.close();
  }
});

test('cookies are Secure and HSTS is sent', async () => {
  const s = await start();
  try {
    const r = await s.call('/api/status');
    assert.match(String(r.headers['set-cookie']), /; Secure/);
    assert.ok(r.headers['strict-transport-security']);
  } finally {
    await s.close();
  }
});

test('setup and a task round trip work over HTTPS', async () => {
  const s = await start();
  try {
    const status = await s.call('/api/status');
    let cookie = String(status.headers['set-cookie']).split(';')[0];
    let csrf = JSON.parse(status.body).csrf as string;
    const post = (path: string, body: unknown) =>
      s.call(path, {
        method: 'POST',
        body,
        headers: { Origin: s.origin, Cookie: cookie, 'X-AllIn-CSRF': csrf },
      });
    const setupReply = await post('/api/vault/setup', { password });
    assert.equal(setupReply.status, 200);
    assert.match(String(setupReply.headers['set-cookie']), /; Secure/);
    cookie = String(setupReply.headers['set-cookie']).split(';')[0];
    csrf = JSON.parse(setupReply.body).csrf;
    const made = await post('/api/tasks', { task: { title: 'Over TLS' } });
    assert.equal(made.status, 201);
    const list = await s.call('/api/tasks', { headers: { Cookie: cookie, 'X-AllIn-CSRF': csrf } });
    assert.match(list.body, /Over TLS/);
  } finally {
    await s.close();
  }
});

test('TLS 1.2 is refused', async () => {
  const s = await start();
  try {
    await assert.rejects(
      s.call('/api/status', { maxVersion: 'TLSv1.2' }),
      /ERR_SSL|protocol version|alert/i,
    );
  } finally {
    await s.close();
  }
});

test('in loopback mode cookies are not Secure and no HSTS is sent', async () => {
  const s = await setup();
  try {
    const r = await s.call('/status');
    assert.doesNotMatch(r.headers.get('set-cookie')!, /Secure/);
    assert.equal(r.headers.get('strict-transport-security'), null);
  } finally {
    await s.close();
  }
});

test('tls without an https origin, or an https origin without tls, is refused', () => {
  const p = profile(),
    dir = mkdtempSync(join(tmpdir(), 'allin-tls-'));
  try {
    const tls = makeCertificate(dir, 'allin.test');
    assert.throws(() => createApp(p.vault, { port: 44001, tls }), /together/);
    assert.throws(
      () => createApp(p.vault, { port: 44001, origin: 'https://allin.test:44001' }),
      /together/,
    );
  } finally {
    p.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
