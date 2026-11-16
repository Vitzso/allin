import { createInterface } from 'node:readline';
import { contained } from './containment.ts';
import { fetchFeed } from './feeds/fetchFeed.ts';
import { serverMessageSchema } from '../shared/feedSchema.ts';
import type { AlpacaKey } from '../shared/feedSchema.ts';

// The sandboxed worker. It runs on Node's built-in TypeScript support, so everything it imports
// is erasable syntax only, and it must not import server/errors.ts or server/vault.ts.
// Usage: node feedWorker.ts <dataDir>. JSON lines in on stdin, JSON lines out on stdout.

const send = (message: object): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const dataDir = process.argv[2];
if (typeof dataDir !== 'string' || !contained(dataDir, process.platform)) {
  process.stdout.write(`${JSON.stringify({ type: 'refused' })}\n`, () => process.exit(0));
} else {
  let key: AlpacaKey | null = null;
  send({ type: 'ready' });
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = serverMessageSchema.safeParse(parsed);
    if (!message.success) return;
    const body = message.data;
    if (body.type === 'credentials') {
      key = { keyId: body.keyId, secret: body.secret };
      return;
    }
    const { id, type: _type, ...request } = body;
    void fetchFeed(request, key).then((result) => send({ type: 'result', id, ...result }));
  });
  lines.on('close', () => process.exit(0));
}
