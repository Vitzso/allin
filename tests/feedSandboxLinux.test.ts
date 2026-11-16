import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxedTransport, workerCommand } from '../server/feedSandbox.ts';
import type { FetchRequest } from '../shared/feedSchema.ts';

// These run real bwrap, so only on Linux. They mirror the macOS tests in feedSandbox.test.ts.
const linux = { skip: process.platform !== 'linux' };

const appDir = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const workerPath = join(appDir, 'server', 'feedWorker.ts');
const request: FetchRequest = { feed: 'coinbase', kind: 'prices', symbols: ['BTC-USD'] };

// Scratch folders sit beside the checkout, not under /tmp: the sandbox mounts its own empty /tmp,
// which would hide a folder there whether or not it was bound. Beside it and not inside it,
// because the app folder is bound. Made on first use, so nothing is created when skipped.
const beside = join(dirname(appDir), `.allin-sandbox-test-${process.pid}`);
// Inside the app folder, for the tests that need a folder the sandbox does show. Git-ignored.
const insideApp = join(appDir, '.allin-test');
const made: string[] = [];
const scratch = (root = beside): string => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = realpathSync(mkdtempSync(join(root, 'run-')));
  made.push(dir);
  return dir;
};
const dataFolder = (root = beside): string => {
  const dir = scratch(root);
  writeFileSync(join(dir, 'vault.json'), '{"secret":"vault contents"}');
  return dir;
};
const marker = `allin-bwrap-write-${process.pid}`;
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  rmSync(beside, { recursive: true, force: true });
  rmSync(insideApp, { recursive: true, force: true });
  rmSync(join(appDir, marker), { force: true });
});

// A small script run under the real bwrap line in place of the worker: only the program differs.
// It prints a JSON object of action to outcome ('ok' or the error code). The script looks at
// `seen`, which is the data and key folders unless a test asks about other folders.
function probe(
  script: string,
  dataDir: string,
  keysDir: string,
  seen: [string, string] = [dataDir, keysDir],
): Promise<Record<string, string>> {
  const { command, args } = workerCommand(
    { dataDir, keysDir, appDir, worker: workerPath },
    'linux',
  );
  const full = [...args.slice(0, -2), '--input-type=module', '-e', script, ...seen];
  return new Promise((resolve, reject) => {
    const child = spawn(command, full, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`probe printed ${out} / ${err}`));
      }
    });
  });
}
const PRELUDE = `
  import * as fs from 'node:fs';
  const [dataDir, keysDir] = process.argv.slice(1);
  const attempt = (action) => {
    try { action(); return 'ok'; } catch (error) { return error?.code ?? 'error'; }
  };
`;

test('inside bwrap, the vault folder and the key folder do not exist', linux, async () => {
  const outcome = await probe(
    `${PRELUDE}
    console.log(JSON.stringify({
      readVault: attempt(() => fs.readFileSync(dataDir + '/vault.json')),
      statData: attempt(() => fs.statSync(dataDir)),
      statKeys: attempt(() => fs.statSync(keysDir)),
    }));`,
    dataFolder(),
    scratch(),
  );
  assert.deepEqual(outcome, { readVault: 'ENOENT', statData: 'ENOENT', statKeys: 'ENOENT' });
});

// The check above can fail: the same probe finds a vault file in a folder that is bound.
test('inside bwrap, a folder under the bound app folder is visible', linux, async () => {
  const outcome = await probe(
    `${PRELUDE}
    console.log(JSON.stringify({
      readVault: attempt(() => fs.readFileSync(dataDir + '/vault.json')),
    }));`,
    dataFolder(),
    scratch(),
    [dataFolder(insideApp), scratch()],
  );
  assert.deepEqual(outcome, { readVault: 'ok' });
});

// So a data folder there is refused before any worker starts.
test('a data folder inside the app folder is refused', linux, () => {
  assert.throws(
    () =>
      workerCommand(
        { dataDir: dataFolder(insideApp), keysDir: scratch(), appDir, worker: workerPath },
        'linux',
      ),
    { message: 'the AllIn folder holds the data folder, so the sandbox cannot protect it' },
  );
});

test('inside bwrap, nothing can be written outside /tmp', linux, async () => {
  const nodeDir = dirname(dirname(realpathSync(process.execPath)));
  const outcome = await probe(
    `${PRELUDE}
    const write = (folder) => attempt(() => fs.writeFileSync(folder + '/${marker}', 'x'));
    console.log(JSON.stringify({
      app: write(${JSON.stringify(realpathSync(appDir))}),
      node: write(${JSON.stringify(nodeDir)}),
      usr: write('/usr'),
      tmp: write('/tmp'),
    }));`,
    dataFolder(),
    scratch(),
  );
  assert.equal(outcome.tmp, 'ok');
  for (const where of ['app', 'node', 'usr'] as const)
    assert.notEqual(outcome[where], 'ok', `${where} was writable`);
});

test('the real worker starts and proves its containment', linux, async () => {
  const t = sandboxedTransport({
    dataDir: dataFolder(),
    keysDir: scratch(),
    appDir,
    worker: workerPath,
  });
  try {
    assert.equal(await t.ready(), true);
  } finally {
    t.stop();
  }
});

test('the real worker answers a request over stdin', linux, async () => {
  const t = sandboxedTransport({
    dataDir: dataFolder(),
    keysDir: scratch(),
    appDir,
    worker: workerPath,
  });
  try {
    // Alpaca with no key is refused before any request is made, so this never touches the network.
    const result = await t.fetch({ feed: 'alpaca', kind: 'prices', symbols: ['AAPL'] });
    assert.deepEqual(result, { ok: false, error: 'unauthorized' });
  } finally {
    t.stop();
  }
});

test('a worker started without bwrap fails its proof', linux, async () => {
  const dataDir = dataFolder();
  const t = sandboxedTransport({
    dataDir,
    appDir,
    worker: workerPath,
    command: () => ({ command: process.execPath, args: [workerPath, dataDir] }),
  });
  try {
    assert.equal(await t.ready(), false);
    assert.deepEqual(await t.fetch(request), { ok: false, error: 'isolation' });
  } finally {
    t.stop();
  }
});

// The Docker install relies on this: no bwrap means no feed, and never a worker run without it.
test('bwrap missing means isolation is unavailable', linux, async () => {
  const dataDir = dataFolder();
  const t = sandboxedTransport({
    dataDir,
    keysDir: scratch(),
    appDir,
    worker: workerPath,
    command: (paths) => ({
      ...workerCommand(paths, 'linux'),
      command: join(scratch(), 'bwrap'), // a path where nothing is installed
    }),
  });
  try {
    assert.equal(await t.ready(), false);
    assert.deepEqual(await t.fetch(request), { ok: false, error: 'isolation' });
    // Every worker is started with the data folder as its last argument, so a worker started
    // some other way would show up here.
    const running = readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .filter((pid) => {
        try {
          return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(dataDir);
        } catch {
          return false;
        }
      });
    assert.deepEqual(running, []);
  } finally {
    t.stop();
  }
});
