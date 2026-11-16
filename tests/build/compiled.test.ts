import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandboxedTransport } from '../../server/feedSandbox.ts';

// Runs the output of `npm run build`. It never sets up or unlocks a vault, so it never reaches
// the Keychain.
const repo = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const made: string[] = [];
const folder = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'allin-build-'));
  made.push(path);
  return path;
};
after(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })));

test('the compiled server starts from another folder and serves the page and status', async () => {
  const data = folder();
  const port = 44000 + Math.floor(Math.random() * 15000);
  const child = spawn(process.execPath, [join(repo, 'build/server/index.js')], {
    cwd: folder(),
    // Linux needs a key folder: owner-only (mkdtemp makes it 0700) and apart from the data folder.
    env: {
      ...process.env,
      ALLIN_DATA_DIR: data,
      ALLIN_KEYSTORE_DIR: folder(),
      ALLIN_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  try {
    const origin = `http://127.0.0.1:${port}`;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no start line: ${out} / ${err}`)), 15_000);
      child.on('exit', () => reject(new Error(`exited early: ${out} / ${err}`)));
      child.stdout.on('data', (d) => {
        out += d;
        if (out.includes(`Open ${origin}`)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    assert.equal((await fetch(`${origin}/api/status`)).status, 200);
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type')!, /text\/html/);
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
  assert.ok(!existsSync(join(data, 'vault.json')));
});

test(
  'the compiled worker proves its containment inside the Mac sandbox',
  { skip: process.platform !== 'darwin' },
  async () => {
    const data = folder();
    writeFileSync(join(data, 'vault.json'), '{}');
    const transport = sandboxedTransport({
      dataDir: data,
      appDir: repo,
      worker: join(repo, 'build/server/feedWorker.js'),
    });
    try {
      assert.equal(await transport.ready(), true);
    } finally {
      transport.stop();
    }
  },
);
