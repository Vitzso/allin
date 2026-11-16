import { existsSync, statSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from './app.ts';
import { ConfigError, readConfig } from './config.ts';
import { FeedSupervisor } from './feedSupervisor.ts';
import { sandboxedTransport } from './feedSandbox.ts';
import { appPaths } from './paths.ts';
import { shutdown } from './shutdown.ts';
import { openKeyStore, readTls } from './startup.ts';
import { Vault } from './vault.ts';

process.umask(0o077);
const dev = process.argv.includes('--dev');
// A refusal is one line and exit 1, before anything listens.
function orRefuse<T>(make: () => T): T {
  try {
    return make();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
const config = orRefuse(() =>
  readConfig(process.env, {
    platform: process.platform,
    homedir: homedir(),
    cwd: process.cwd(),
    addresses: Object.values(networkInterfaces())
      .flat()
      .flatMap((entry) => (entry ? [entry.address] : [])),
    mode: (path) => {
      try {
        return statSync(path).mode & 0o777;
      } catch {
        return null;
      }
    },
  }),
);
if (dev && config.network) {
  console.error('Development mode runs on 127.0.0.1 only.');
  process.exit(1);
}
const { port, listen, origin, dataDir: directory } = config;
const { appDir, dist, worker } = appPaths(import.meta.url);
if (!dev && !existsSync(resolve(dist, 'index.html'))) {
  console.error(
    'AllIn has not been built. Run npm run build from the project folder, then npm start.',
  );
  process.exit(1);
}
const vault = new Vault(
  directory,
  orRefuse(() => openKeyStore(config, process.platform)),
);
const tls = config.tls && orRefuse(() => readTls(config.tls!));
const vite = dev
  ? await (
      await import('vite')
    ).createServer({ server: { middlewareMode: true, hmr: false }, appType: 'spa' })
  : undefined;
const feeds = new FeedSupervisor({
  vault,
  transport: sandboxedTransport({
    dataDir: directory,
    keysDir: config.keystoreDir,
    appDir,
    worker,
  }),
});
const server = createApp(vault, {
  port,
  dist,
  middleware: vite?.middlewares,
  feeds,
  lockoutFile: join(directory, 'lockout.json'),
  origin,
  maxSessions: config.network ? 3 : 1,
  tls,
});
server.listen(port, listen, () =>
  console.log(
    `\n  AllIn · local foundation\n  Open ${origin}\n  Offline until you turn on a market feed · models disabled\n  ${dev ? 'Development server' : 'Production build'}\n`,
  ),
);
server.on('error', (error: NodeJS.ErrnoException) => {
  // The code only: messages can carry paths.
  console.error(
    `Could not start AllIn (${error.code ?? 'error'}). ${
      error.code === 'EADDRINUSE'
        ? 'The port may already be in use.'
        : error.code === 'EADDRNOTAVAIL'
          ? 'The address in ALLIN_LISTEN is not available yet.'
          : ''
    }`.trim(),
  );
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    shutdown({ vault, feeds, server });
    void vite?.close();
    setTimeout(() => process.exit(0), 500).unref();
  });
