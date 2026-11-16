import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { z } from 'zod';
import { AppError, Vault } from './vault.ts';
import { marketFixtures } from './replay.ts';
import { FeedSupervisor } from './feedSupervisor.ts';
import { unavailableTransport } from './feedSandbox.ts';
import { healthFixture } from '../shared/fixtures.ts';
import type { Connect } from 'vite';
import { MAX_BACKUP_BYTES } from '../shared/schema.ts';
import { Lockout } from './lockout.ts';
import { deviceName } from '../shared/device.ts';
import { alpacaToggleSchema, feedToggleSchema } from '../shared/feedSchema.ts';

// Each signed-in device has its own cookie value and token. The key is only for showing the list.
type Session = {
  id: string;
  csrf: string;
  last: number;
  created: number;
  key: string;
  device: string;
};
export function createApp(
  vault: Vault,
  options: {
    port: number;
    dist?: string;
    middleware?: Connect.Server;
    idleMs?: number;
    maxSessions?: number; // how many devices may be signed in at once; default 1
    log?: (line: string) => void;
    feeds?: FeedSupervisor;
    lockoutFile?: string;
    origin?: string; // the one address the browser may use; default is loopback over HTTP
    tls?: { cert: Buffer; key: Buffer };
  },
): Server {
  if (
    options.maxSessions !== undefined &&
    !(Number.isInteger(options.maxSessions) && options.maxSessions >= 1)
  )
    throw new Error('createApp needs maxSessions to be a whole number of at least 1.');
  if (!!options.tls !== (options.origin?.startsWith('https:') ?? false))
    throw new Error('createApp needs tls and an https origin together.');
  const origin = options.origin ?? `http://127.0.0.1:${options.port}`,
    secure = origin.startsWith('https:') ? '; Secure' : '',
    network = secure !== '',
    maxBody = MAX_BACKUP_BYTES + 4096,
    // Browsers share cookies across ports, so the port keeps two profiles from colliding.
    sessionCookie = `allin_session_${options.port}`,
    bootstrapCookie = `allin_bootstrap_${options.port}`;
  let sessions: Session[] = [];
  const lockout = new Lockout(options.lockoutFile);
  const preAuth = new Map<string, { csrf: string; expires: number }>();
  const replay = marketFixtures();
  // Without a transport nothing can start a worker or reach the network.
  const feeds = options.feeds ?? new FeedSupervisor({ vault, transport: unavailableTransport });
  feeds.start();
  const equal = (a: string, b: string) => {
    const left = Buffer.from(a),
      right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  const cookie = (req: IncomingMessage, name: string) =>
    req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? '';
  const maxSessions = options.maxSessions ?? 1;
  // The vault stays unlocked while any session remains, and locks when the last one goes.
  const dropSessions = (gone: (s: Session) => boolean) => {
    if (!sessions.length) return;
    sessions = sessions.filter((s) => !gone(s));
    if (!sessions.length) vault.lock();
  };
  // Always locks, even with no session, as before. Only the expiry sweep skips an empty list.
  const clearSession = () => {
    sessions = [];
    vault.lock();
  };
  const expired = (s: Session) =>
    Date.now() - s.last > (options.idleMs ?? 15 * 60000) || Date.now() - s.created > 8 * 3600000;
  const timer = setInterval(() => {
    dropSessions(expired);
    for (const [id, value] of preAuth) if (value.expires < Date.now()) preAuth.delete(id);
  }, 1000);
  timer.unref();
  // Cookies are shared across every port on 127.0.0.1, so any local server the browser visits can
  // receive the session cookie. A session therefore also needs the token, which only this origin
  // can read. A cookie on its own reveals nothing and does not extend the session.
  const sessionToken = (req: IncomingMessage) => String(req.headers['x-allin-csrf'] ?? '');
  const sessionFromCookie = (req: IncomingMessage) => {
    dropSessions(expired);
    const value = cookie(req, sessionCookie);
    return vault.unlocked ? sessions.find((s) => equal(value, s.id)) : undefined;
  };
  function authenticate(req: IncomingMessage, tokenMismatch: 401 | 403, extend = true) {
    const active = sessionFromCookie(req);
    if (!active) throw new AppError(401, 'Unlock your vault to continue.');
    if (!equal(sessionToken(req), active.csrf))
      throw new AppError(
        tokenMismatch,
        tokenMismatch === 401 ? 'Unlock your vault to continue.' : 'Request token did not match.',
      );
    if (extend) active.last = Date.now();
    return active;
  }
  const newSession = (req: IncomingMessage, res: ServerResponse) => {
    // The same browser signing in again takes over its own row. Past the limit, the device idle
    // longest goes, without locking the vault because the new session follows at once.
    const own = cookie(req, sessionCookie);
    sessions = sessions.filter((s) => !equal(own, s.id));
    while (sessions.length >= maxSessions) {
      const oldest = sessions.reduce((a, b) => (b.last < a.last ? b : a));
      sessions = sessions.filter((s) => s !== oldest);
    }
    const added: Session = {
      id: randomBytes(32).toString('hex'),
      csrf: randomBytes(32).toString('hex'),
      last: Date.now(),
      created: Date.now(),
      key: randomBytes(8).toString('hex'),
      device: deviceName(req.headers['user-agent']),
    };
    sessions.push(added);
    res.setHeader(
      'Set-Cookie',
      `${sessionCookie}=${added.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`,
    );
    return added;
  };
  const endCookie = (res: ServerResponse) =>
    res.setHeader(
      'Set-Cookie',
      `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
    );
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  async function body(req: IncomingMessage) {
    if (req.headers['content-type'] !== 'application/json')
      throw new AppError(415, 'Send JSON only.');
    if (Number(req.headers['content-length'] ?? 0) > maxBody)
      throw new AppError(413, 'This file is too large. Maximum backup size is 24 MB.');
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const part of req) {
      length += part.length;
      if (length > maxBody)
        throw new AppError(413, 'This file is too large. Maximum backup size is 24 MB.');
      chunks.push(part);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new AppError(400, 'The request is not valid JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new AppError(400, 'The request must be a JSON object.');
    return parsed as Record<string, unknown>;
  }
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'${options.middleware ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${options.middleware ? ` ws://127.0.0.1:${options.port}` : ''}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
    );
    try {
      if (req.headers.host !== new URL(origin).host)
        throw new AppError(
          403,
          network
            ? 'Unrecognized host. Open the address AllIn was set up with.'
            : 'Unrecognized host. Open the 127.0.0.1 address shown in your terminal.',
        );
      if (req.headers.origin && req.headers.origin !== origin)
        throw new AppError(403, 'Cross-origin access is not allowed.');
      if (req.headers['sec-fetch-site'] === 'cross-site')
        throw new AppError(403, 'Cross-site access is not allowed.');
      let url: URL;
      try {
        url = new URL(req.url ?? '/', origin);
      } catch {
        throw new AppError(400, 'Invalid path.');
      }
      const path = url.pathname,
        method = req.method ?? 'GET';
      if (path === '/api/status' && method === 'GET') {
        const owned = sessionFromCookie(req);
        const active = owned && equal(sessionToken(req), owned.csrf) ? owned : undefined;
        let csrf = active?.csrf;
        if (!csrf) {
          const id = randomBytes(24).toString('hex');
          csrf = randomBytes(32).toString('hex');
          if (preAuth.size > 100) preAuth.clear();
          preAuth.set(id, { csrf, expires: Date.now() + 10 * 60000 });
          res.setHeader(
            'Set-Cookie',
            `${bootstrapCookie}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=600${secure}`,
          );
        }
        return json(res, 200, {
          initialized: vault.initialized,
          unlocked: !!active,
          csrf,
          keyStore: vault.keyStore.label,
          milestone: 'M4 · Live market feeds',
        });
      }
      if (path.startsWith('/api/')) {
        const publicRead =
          method === 'GET' && (path === '/api/demo/markets' || path === '/api/demo/health');
        let caller: Session | undefined;
        const login =
          path === '/api/vault/setup' ||
          path === '/api/vault/unlock' ||
          path === '/api/vault/restore';
        if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method))
          throw new AppError(405, 'Method not allowed.');
        if (method !== 'GET' && req.headers.origin !== origin)
          throw new AppError(403, 'A same-origin request is required.');
        if (login) {
          if (method !== 'GET') {
            const auth = preAuth.get(cookie(req, bootstrapCookie));
            if (!auth || auth.expires < Date.now() || !equal(sessionToken(req), auth.csrf))
              throw new AppError(403, 'Refresh the page and try again.');
          }
        } else if (!publicRead)
          // Markets is read every 30 seconds by an open page, and the device list is only looked
          // at, so neither keeps the session alive.
          caller = authenticate(
            req,
            method === 'GET' ? 401 : 403,
            !(method === 'GET' && (path === '/api/markets' || path === '/api/sessions')),
          );
        if (login && method === 'POST') {
          const wait = lockout.waitMs();
          if (wait > 0) {
            const minutes = Math.ceil(wait / 60000);
            throw new AppError(
              429,
              `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
            );
          }
          // The correct passphrase may take over an open vault, for example from a new tab. A
          // session lost with its cookie or tab would otherwise be unreachable until it expired.
          if (vault.unlocked && !path.endsWith('/unlock'))
            throw new AppError(409, 'Lock the existing session first.');
          const input = await body(req);
          try {
            const password = z.string().min(12).max(256).parse(input.password);
            if (path.endsWith('/unlock')) vault.unlock(password);
            else if (path.endsWith('/restore'))
              vault.setup(password, {
                backup: input.backup,
                secret: z.string().min(16).max(256).parse(input.secret),
              });
            else vault.setup(password);
          } catch (error) {
            // A failed open leaves the vault locked, so no session may linger to revive later.
            if (!vault.unlocked) clearSession();
            // Only a rejected guess counts. A fault on this device says nothing about the passphrase.
            if (error instanceof z.ZodError || (error instanceof AppError && error.status < 500))
              lockout.fail();
            throw error;
          }
          lockout.succeed();
          preAuth.delete(cookie(req, bootstrapCookie));
          const active = newSession(req, res);
          return json(res, 200, { csrf: active.csrf, unlocked: true });
        }
        if (path === '/api/demo/markets' && method === 'GET') return json(res, 200, replay);
        if (path === '/api/demo/health' && method === 'GET') return json(res, 200, healthFixture);
        if (path === '/api/tasks' && method === 'GET') return json(res, 200, vault.tasks());
        if (path === '/api/tasks' && method === 'POST') {
          const input = await body(req);
          return json(res, 201, vault.createTask(input.task, input.id as string | undefined));
        }
        const match = path.match(/^\/api\/tasks\/([a-f0-9-]{36})$/);
        if (match && (method === 'PATCH' || method === 'DELETE')) {
          const input = await body(req);
          const version = z.number().int().positive().parse(input.version);
          return json(
            res,
            200,
            method === 'PATCH'
              ? vault.updateTask(match[1], version, input.changes)
              : (vault.deleteTask(match[1], version), { ok: true }),
          );
        }
        if (path === '/api/settings' && method === 'GET') return json(res, 200, vault.settings());
        if (path === '/api/settings' && method === 'POST')
          return json(res, 200, vault.setSettings(await body(req)));
        if (path === '/api/markets' && method === 'GET') return json(res, 200, feeds.snapshot());
        if (path === '/api/feeds/coinbase' && method === 'POST') {
          feeds.setCoinbase(feedToggleSchema.parse(await body(req)).enabled);
          return json(res, 200, { feeds: feeds.snapshot().feeds });
        }
        if (path === '/api/feeds/alpaca' && method === 'POST') {
          const { enabled, keyId, secret } = alpacaToggleSchema.parse(await body(req));
          await feeds.setAlpaca({
            enabled,
            key: keyId !== undefined && secret !== undefined ? { keyId, secret } : undefined,
          });
          return json(res, 200, { feeds: feeds.snapshot().feeds });
        }
        if (path === '/api/feeds/alpaca/remove-key' && method === 'POST') {
          await body(req);
          feeds.removeAlpacaKey();
          return json(res, 200, { feeds: feeds.snapshot().feeds });
        }
        if (path === '/api/feeds/purge' && method === 'POST') {
          await body(req);
          feeds.purge();
          return json(res, 200, { ok: true });
        }
        if (path === '/api/alerts/dismiss' && method === 'POST') {
          feeds.dismiss(await body(req));
          return json(res, 200, { ok: true });
        }
        if (path === '/api/health/summary' && method === 'GET')
          return json(res, 200, vault.health.summary());
        if (path === '/api/health/import' && method === 'POST')
          return json(res, 200, vault.health.importRows(await body(req)));
        if (path === '/api/health/goal' && method === 'POST')
          return json(res, 200, vault.health.setGoal(await body(req)));
        if (path === '/api/health/purge' && method === 'POST') {
          await body(req);
          vault.health.purge();
          return json(res, 200, { ok: true });
        }
        if (path === '/api/events' && method === 'GET') return json(res, 200, vault.events());
        if (path === '/api/vault/lock' && method === 'POST') {
          vault.event('vault.lock');
          clearSession();
          endCookie(res);
          return json(res, 200, { ok: true });
        }
        if (path === '/api/sessions' && method === 'GET')
          return json(res, 200, {
            sessions: [...sessions]
              .reverse()
              .sort((a, b) => b.created - a.created)
              .map((s) => ({
                key: s.key,
                device: s.device,
                startedAt: new Date(s.created).toISOString(),
                lastActiveAt: new Date(s.last).toISOString(),
                current: s === caller,
              })),
          });
        if (path === '/api/sessions/sign-out' && method === 'POST') {
          const { key } = z
            .object({ key: z.string().regex(/^[0-9a-f]{16}$/) })
            .strict()
            .parse(await body(req));
          const target = sessions.find((s) => s.key === key);
          if (!target) throw new AppError(404, 'That device is already signed out.');
          if (sessions.length === 1) vault.event('vault.lock');
          dropSessions((s) => s === target);
          if (target === caller) endCookie(res);
          return json(res, 200, { ok: true });
        }
        if (path === '/api/vault/backup' && method === 'POST') {
          const input = await body(req);
          return json(res, 200, vault.export(z.string().min(16).max(256).parse(input.secret)));
        }
        throw new AppError(404, 'This operation is not available.');
      }
      if (!['GET', 'HEAD'].includes(method)) throw new AppError(405, 'Method not allowed.');
      if (options.middleware)
        return options.middleware(req, res, () => json(res, 404, { error: 'Not found' }));
      const root = resolve(options.dist ?? 'dist');
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(path);
      } catch {
        throw new AppError(400, 'Invalid path.');
      }
      const requested = resolve(root, `.${decodedPath}`);
      if (!requested.startsWith(root + sep) && requested !== root)
        throw new AppError(403, 'Invalid path.');
      let file = requested;
      try {
        if (!(await stat(file)).isFile()) file = resolve(root, 'index.html');
      } catch {
        file = resolve(root, 'index.html');
      }
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
        '.png': 'image/png',
        '.webmanifest': 'application/manifest+json',
      };
      let bytes: Buffer;
      try {
        bytes = await readFile(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        throw new AppError(
          503,
          'AllIn has not been built. Run npm run build, then npm start.',
          error,
        );
      }
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status =
        error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500;
      if (status >= 500) {
        // Name and code only: error messages can quote private data. For example, JSON.parse
        // errors include a snippet of their input.
        const source = ((error instanceof AppError && error.cause) || error) as {
          name?: string;
          code?: string;
        };
        const target = (req.url ?? '').split('?')[0];
        const route = target.startsWith('/api/')
          ? target.replace(/[a-f0-9-]{36}/g, ':id')
          : 'static file';
        (options.log ?? console.error)(
          `AllIn: ${req.method} ${route} failed: ${source.name ?? 'Error'}${source.code ? ` (${source.code})` : ''}`,
        );
      }
      json(res, status, {
        error:
          error instanceof AppError
            ? error.message
            : error instanceof z.ZodError
              ? 'Check the fields and supported file format.'
              : "AllIn hit an unexpected problem. Try again. If it keeps happening, check AllIn's log.",
      });
    }
  };
  // createTlsServer returns an https.Server, which the callers use only through the shared API.
  const server = (
    options.tls
      ? createTlsServer({ ...options.tls, minVersion: 'TLSv1.3' }, handler)
      : createServer(handler)
  ) as Server;
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('close', () => {
    clearInterval(timer);
    feeds.stop();
    clearSession();
  });
  return server;
}
