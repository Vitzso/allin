// Dedicated browser test entry point. Never used by npm start or npm run dev.
import { createApp } from '../server/app.ts';
import { FeedSupervisor } from '../server/feedSupervisor.ts';
import { providerWorld, scriptedTransport } from './feedHelpers.ts';
import { profile } from './helpers.ts';
const p = profile();
// Bars are served relative to the real clock, and nothing here reaches the network. A key whose
// ID holds REJECT is answered as a provider would answer a bad key.
const world = providerWorld({ now: () => Date.now() });
const transport = scriptedTransport((request) =>
  request.feed === 'alpaca' && transport.credentials?.keyId.includes('REJECT')
    ? { ok: false, error: 'unauthorized' }
    : world.handler(request),
);
const feeds = new FeedSupervisor({ vault: p.vault, transport });
const server = createApp(p.vault, { port: 4311, dist: 'dist', feeds });
server.listen(4311, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close();
    p.cleanup();
    process.exit(0);
  });
