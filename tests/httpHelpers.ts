import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import type { FeedSupervisor } from '../server/feedSupervisor.ts';
import type { Vault } from '../server/vault.ts';
import { profile, password } from './helpers.ts';

export async function setup(
  idleMs = 15 * 60000,
  dist?: string,
  feeds?: (vault: Vault) => FeedSupervisor,
  options: { maxSessions?: number } = {},
) {
  const p = profile();
  const port = 44000 + Math.floor(Math.random() * 15000);
  const origin = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const server = createApp(p.vault, {
    port,
    idleMs,
    maxSessions: options.maxSessions,
    dist,
    feeds: feeds?.(p.vault),
    log: (line) => logs.push(line),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  // Each client has its own cookie jar and token, like a separate browser.
  function client(userAgent?: string) {
    let cookie = '',
      csrf = '';
    async function call(
      path: string,
      method = 'GET',
      body?: unknown,
      headers: Record<string, string> = {},
    ) {
      const response = await fetch(`${origin}/api${path}`, {
        method,
        headers: {
          ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
          ...(userAgent ? { 'User-Agent': userAgent } : {}),
          'X-AllIn-CSRF': csrf,
          Cookie: cookie,
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return response;
    }
    async function signIn(route: string) {
      const status = await call('/status');
      cookie = status.headers.get('set-cookie')!.split(';')[0];
      csrf = (await status.json()).csrf;
      const response = await call(route, 'POST', { password });
      assert.equal(response.status, 200);
      cookie = response.headers.get('set-cookie')!.split(';')[0];
      csrf = (await response.json()).csrf;
    }
    return { call, signIn, session: () => ({ cookie, csrf }) };
  }
  const main = client();
  return {
    p,
    origin,
    call: main.call,
    login: () => main.signIn('/vault/setup'),
    // A second browser on a vault the first one already set up.
    device(userAgent?: string) {
      const other = client(userAgent);
      return {
        call: other.call,
        login: () => other.signIn('/vault/unlock'),
        session: other.session,
      };
    },
    server,
    logs,
    session: main.session,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      p.cleanup();
    },
  };
}
