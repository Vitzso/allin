import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SANDBOX_PROFILE,
  sandboxedTransport,
  unavailableTransport,
  workerCommand,
} from '../server/feedSandbox.ts';
import type { FetchRequest } from '../shared/feedSchema.ts';

const appDir = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const workerPath = join(appDir, 'server', 'feedWorker.ts');
const probePath = join(appDir, 'tests', 'fixtures', 'feed-probe.mjs');
const request: FetchRequest = { feed: 'coinbase', kind: 'prices', symbols: ['BTC-USD'] };

const made: string[] = [];
const servers: Server[] = [];
const children: number[] = [];
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'allin-feed-')));
  made.push(dir);
  return dir;
};
const dataFolder = (): string => {
  const dir = scratch();
  writeFileSync(join(dir, 'vault.json'), '{"secret":"vault contents"}');
  return dir;
};
// The same at-or-above test the sandbox uses, for expectations that depend on where node lives.
const holdsPath = (folder: string, path: string): boolean => {
  const within = relative(folder, path);
  return within === '' || !(within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within));
};
after(() => {
  for (const server of servers) server.close();
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  for (const pid of children)
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
});

function loopbackServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy());
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

// The probe runs under the real sandbox-exec, profile, and -D values; only the program differs.
function run(dataDir: string, sandboxed: boolean, port: number): Promise<Record<string, string>> {
  const writeDir = scratch();
  const { command, args } = workerCommand({ dataDir, appDir, worker: workerPath }, 'darwin');
  const probeArgs = [probePath, dataDir, writeDir, String(port), ...(sandboxed ? [] : ['no-http'])];
  const full = sandboxed
    ? { command, args: [...args.slice(0, -2), ...probeArgs] }
    : { command: process.execPath, args: probeArgs };
  return new Promise((resolve, reject) => {
    const child = spawn(full.command, full.args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

test('workerCommand builds the sandbox-exec line from real paths', () => {
  const real = realpathSync(scratch());
  const link = join(scratch(), 'link');
  symlinkSync(real, link);
  const { command, args } = workerCommand(
    { dataDir: link, appDir, worker: workerPath, home: link },
    'darwin',
  );
  const node = realpathSync(process.execPath);
  assert.equal(command, '/usr/bin/sandbox-exec');
  assert.deepEqual(args.slice(0, 2), ['-p', SANDBOX_PROFILE]);
  const defines = args.filter((_, i) => args[i - 1] === '-D');
  assert.deepEqual(defines, [
    `HOME=${real}`,
    `APP=${realpathSync(appDir)}`,
    `DATA=${real}`,
    `NODE=${join(node, '..', '..')}`,
  ]);
  assert.deepEqual(args.slice(-3), [node, realpathSync(workerPath), real]);
  assert.equal(args.at(-2), realpathSync(workerPath));
  assert.ok(!SANDBOX_PROFILE.includes(real), 'paths are passed with -D, never pasted in');
});

// The Linux branch only builds arguments here, so it runs on any host; bwrap itself is exercised
// in tests/feedSandboxLinux.test.ts.
test('on Linux, workerCommand builds the bwrap line from real paths', () => {
  const data = dataFolder();
  const keys = scratch();
  const dataLink = join(scratch(), 'data-link');
  const keysLink = join(scratch(), 'keys-link');
  symlinkSync(data, dataLink);
  symlinkSync(keys, keysLink);
  const node = realpathSync(process.execPath);
  const nodeDir = dirname(dirname(node));
  const app = realpathSync(appDir);
  const { command, args } = workerCommand(
    { dataDir: dataLink, appDir, worker: workerPath, keysDir: keysLink },
    'linux',
  );
  assert.equal(command, '/usr/bin/bwrap');
  assert.deepEqual(args, [
    '--unshare-all',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind-try',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
    '--ro-bind-try',
    '/etc/resolv.conf',
    '/etc/resolv.conf',
    '--ro-bind-try',
    '/etc/hosts',
    '/etc/hosts',
    '--ro-bind-try',
    '/etc/nsswitch.conf',
    '/etc/nsswitch.conf',
    '--ro-bind',
    nodeDir,
    nodeDir,
    '--ro-bind',
    app,
    app,
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--chdir',
    '/',
    node,
    realpathSync(workerPath),
    data,
  ]);
});

test('on Linux, workerCommand refuses when vault.json is missing', () => {
  assert.throws(
    () =>
      workerCommand(
        { dataDir: scratch(), appDir, worker: workerPath, keysDir: scratch() },
        'linux',
      ),
    { message: 'the vault file is missing, so the sandbox cannot be proven' },
  );
});

test('on Linux, workerCommand refuses an app or node folder that holds the data or key folder', () => {
  const nodeDir = dirname(dirname(realpathSync(process.execPath)));
  const linux = (paths: { dataDir: string; appDir?: string; keysDir?: string }) => () =>
    workerCommand({ appDir, worker: workerPath, ...paths }, 'linux');
  const refusal = (name: string, what: 'data' | 'key') => ({
    message: `${name} holds the ${what} folder, so the sandbox cannot protect it`,
  });
  // The app folder at or above the data or key folder.
  const data = dataFolder();
  assert.throws(
    linux({ dataDir: data, appDir: data, keysDir: scratch() }),
    refusal('the AllIn folder', 'data'),
  );
  assert.throws(
    linux({ dataDir: data, appDir: dirname(data), keysDir: scratch() }),
    refusal('the AllIn folder', 'data'),
  );
  // Only the key folder is under this app folder, so the refusal must be about the key folder.
  const parent = scratch();
  const keys = join(parent, 'keys');
  mkdirSync(keys);
  assert.throws(
    linux({ dataDir: dataFolder(), appDir: parent, keysDir: keys }),
    refusal('the AllIn folder', 'key'),
  );
  // The node folder at or above them. The node rule is checked before the system folders, so
  // this holds wherever node is installed, /usr/local included.
  assert.throws(
    linux({ dataDir: nodeDir, keysDir: scratch() }),
    refusal('the node folder', 'data'),
  );
  assert.throws(
    linux({ dataDir: dataFolder(), keysDir: join(nodeDir, 'bin') }),
    refusal('the node folder', 'key'),
  );
  // A data or key folder under /usr, which is always shown. A node installed in /usr itself
  // would be named first.
  const usr = holdsPath(nodeDir, '/usr/bin') ? 'the node folder' : 'the system folder /usr';
  assert.throws(linux({ dataDir: '/usr/bin', keysDir: scratch() }), refusal(usr, 'data'));
  assert.throws(linux({ dataDir: dataFolder(), keysDir: '/usr/bin' }), refusal(usr, 'key'));
  // Separate folders, the usual layout, are fine.
  assert.doesNotThrow(linux({ dataDir: dataFolder(), keysDir: scratch() }));
});

test('on Linux, a folder whose name starts with two dots is still inside its parent', () => {
  const app = scratch();
  const keys = join(app, '..keys');
  mkdirSync(keys);
  assert.throws(
    () =>
      workerCommand(
        { dataDir: dataFolder(), appDir: app, worker: workerPath, keysDir: keys, home: scratch() },
        'linux',
      ),
    { message: 'the AllIn folder holds the key folder, so the sandbox cannot protect it' },
  );
});

test('on Linux, workerCommand refuses a node or app folder at or above the home folder', () => {
  const nodeDir = dirname(dirname(realpathSync(process.execPath)));
  const linux = (paths: { home: string; appDir?: string }) => () =>
    workerCommand(
      { dataDir: dataFolder(), keysDir: scratch(), appDir, worker: workerPath, ...paths },
      'linux',
    );
  const node = {
    message: 'node is installed at or above the home folder, so the sandbox cannot protect it',
  };
  const app = { message: 'AllIn is at or above the home folder, so the sandbox cannot protect it' };
  // Node in ~/bin makes the node folder the home folder.
  assert.throws(linux({ home: nodeDir }), node);
  assert.throws(linux({ home: join(nodeDir, 'bin') }), node);
  const home = scratch();
  const inside = join(home, 'allin');
  mkdirSync(inside);
  assert.throws(linux({ home, appDir: home }), app);
  assert.throws(linux({ home, appDir: dirname(home) }), app);
  // Node or AllIn inside the home folder (~/.nvm, ~/allin) is fine.
  assert.doesNotThrow(linux({ home: dirname(nodeDir) }));
  assert.doesNotThrow(linux({ home, appDir: inside }));
});

test('on Linux, a transport whose data folder has no vault reports isolation unavailable', async () => {
  const t = sandboxedTransport({
    dataDir: scratch(),
    keysDir: scratch(),
    appDir,
    worker: workerPath,
    command: (paths) => workerCommand(paths, 'linux'),
  });
  assert.equal(await t.ready(), false);
  assert.deepEqual(await t.fetch(request), { ok: false, error: 'isolation' });
  t.stop();
});

test('the transport passes the key folder to the command builder', async () => {
  const keysDir = scratch();
  const seen: (string | undefined)[] = [];
  const t = sandboxedTransport({
    dataDir: dataFolder(),
    keysDir,
    appDir,
    worker: workerPath,
    command: (paths) => {
      seen.push(paths.keysDir);
      throw new Error('stop here');
    },
  });
  assert.equal(await t.ready(), false);
  assert.deepEqual(seen, [keysDir]);
  t.stop();
});

test('workerCommand refuses a platform with no sandbox', () => {
  assert.throws(() =>
    workerCommand({ dataDir: dataFolder(), appDir, worker: workerPath }, 'win32'),
  );
});

test('the profile matches the spec, with the node allowance after the home deny', () => {
  const lines = SANDBOX_PROFILE.split('\n');
  const at = (text: string): number => lines.indexOf(text);
  assert.ok(at('(deny file-read* (subpath (param "HOME")))') >= 0);
  assert.ok(
    at('(allow file-read* (subpath (param "NODE")))') >
      at('(deny file-read* (subpath (param "HOME")))'),
  );
  assert.ok(
    at('(deny file-read* (subpath (param "DATA")))') >
      at('(allow file-read* (subpath (param "APP")))'),
  );
  for (const line of [
    '(deny file-write*)',
    '(deny network*)',
    '(deny process-fork)',
    '(allow network-outbound (remote tcp "*:443"))',
  ])
    assert.ok(at(line) >= 0, line);
});

test(
  'inside the sandbox, the vault folder is unreadable',
  { skip: process.platform !== 'darwin' },
  async () => {
    const outcome = await run(dataFolder(), true, await loopbackServer());
    assert.equal(outcome.readVault, 'EPERM');
    assert.equal(outcome.listVault, 'EPERM');
  },
);

test('outside the sandbox, the probe can do all of it', async () => {
  const outcome = await run(dataFolder(), false, await loopbackServer());
  assert.equal(outcome.readVault, 'ok');
  assert.equal(outcome.listVault, 'ok');
  assert.equal(outcome.write, 'ok');
  assert.equal(outcome.loopback, 'ok');
  assert.equal(outcome.spawn, 'ok');
});

test(
  'inside the sandbox, nothing can be written',
  { skip: process.platform !== 'darwin' },
  async () => {
    const outcome = await run(dataFolder(), true, await loopbackServer());
    assert.equal(outcome.write, 'EPERM');
  },
);

test(
  'inside the sandbox, loopback is unreachable',
  { skip: process.platform !== 'darwin' },
  async () => {
    const outcome = await run(dataFolder(), true, await loopbackServer());
    assert.equal(outcome.loopback, 'EPERM');
  },
);

test(
  'inside the sandbox, plain HTTP is unreachable',
  { skip: process.platform !== 'darwin' },
  async () => {
    const outcome = await run(dataFolder(), true, await loopbackServer());
    assert.equal(outcome.http, 'EPERM');
  },
);

test(
  'inside the sandbox, no child process starts',
  { skip: process.platform !== 'darwin' },
  async () => {
    const outcome = await run(dataFolder(), true, await loopbackServer());
    assert.equal(outcome.spawn, 'EPERM');
  },
);

test(
  'a symlinked data path is still blocked',
  { skip: process.platform !== 'darwin' },
  async () => {
    const real = dataFolder();
    const link = join(scratch(), 'vault-link');
    symlinkSync(real, link);
    const outcome = await run(link, true, await loopbackServer());
    assert.equal(outcome.readVault, 'EPERM');
    assert.equal(outcome.listVault, 'EPERM');
  },
);

test(
  'the real worker starts and proves its containment',
  { skip: process.platform !== 'darwin' },
  async () => {
    const t = sandboxedTransport({ dataDir: dataFolder(), appDir, worker: workerPath });
    try {
      assert.equal(await t.ready(), true);
    } finally {
      t.stop();
    }
  },
);

test(
  'the real worker answers a request over stdin',
  { skip: process.platform !== 'darwin' },
  async () => {
    const t = sandboxedTransport({ dataDir: dataFolder(), appDir, worker: workerPath });
    try {
      // Alpaca with no key is refused before any request is made, so this never touches the network.
      const result = await t.fetch({ feed: 'alpaca', kind: 'prices', symbols: ['AAPL'] });
      assert.deepEqual(result, { ok: false, error: 'unauthorized' });
    } finally {
      t.stop();
    }
  },
);

test('a worker started without the sandbox fails its proof', async () => {
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

test('sandbox-exec missing means isolation is unavailable', async () => {
  const t = sandboxedTransport({
    dataDir: dataFolder(),
    appDir,
    worker: workerPath,
    command: () => ({ command: '/nonexistent/sandbox-exec', args: [] }),
  });
  assert.equal(await t.ready(), false);
  assert.deepEqual(await t.fetch(request), { ok: false, error: 'isolation' });
  t.stop();
});

test(
  'the worker exits when its stdin closes',
  { skip: process.platform !== 'darwin' },
  async () => {
    const dataDir = dataFolder();
    const { command, args } = workerCommand({ dataDir, appDir, worker: workerPath }, 'darwin');
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    if (child.pid) children.push(child.pid);
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    const first = await new Promise<string>((resolve) =>
      child.stdout.once('data', (d) => resolve(String(d))),
    );
    assert.equal(first.trim(), '{"type":"ready"}');
    child.stdin.end();
    await exited;
  },
);

// A stand-in worker: a small script run with plain node, so the transport's line handling can be
// driven without the sandbox. `body` runs for each line the transport sends.
function fakeWorker(dataDir: string, body: string, extra: string[] = []) {
  const script = `
    const fs = require('node:fs');
    process.stdout.write('{"type":"ready"}\\n');
    let buffer = '';
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        const message = JSON.parse(line);
        ${body}
      }
    });
    process.stdin.on('end', () => process.exit(0));
  `;
  return sandboxedTransport({
    dataDir,
    appDir,
    worker: workerPath,
    command: () => ({ command: process.execPath, args: ['-e', script, ...extra] }),
  });
}

test('stop() ends the worker process', async () => {
  const pidFile = join(scratch(), 'pid');
  const script = `
    require('node:fs').writeFileSync(process.argv[1], String(process.pid));
    process.stdout.write('{"type":"ready"}\\n');
    setInterval(() => {}, 1000);
  `;
  const t = sandboxedTransport({
    dataDir: dataFolder(),
    appDir,
    worker: workerPath,
    command: () => ({ command: process.execPath, args: ['-e', script, pidFile] }),
  });
  assert.equal(await t.ready(), true);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  children.push(pid);
  t.stop();
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('the worker is still running after stop()');
});

test('a bad worker line stops the worker and reports worker-crashed', async () => {
  const t = fakeWorker(dataFolder(), `process.stdout.write('this is not json\\n');`);
  try {
    assert.equal(await t.ready(), true);
    assert.deepEqual(await t.fetch(request), { ok: false, error: 'worker-crashed' });
  } finally {
    t.stop();
  }
});

test('a line that parses but breaks the schema stops the worker', async () => {
  const t = fakeWorker(
    dataFolder(),
    `process.stdout.write(JSON.stringify({ type: 'result', id: message.id, ok: true, bars: [], extra: 1 }) + '\\n');`,
  );
  try {
    assert.equal(await t.ready(), true);
    assert.deepEqual(await t.fetch(request), { ok: false, error: 'worker-crashed' });
  } finally {
    t.stop();
  }
});

test('an answer for a request nobody made stops the worker', async () => {
  const t = fakeWorker(
    dataFolder(),
    `process.stdout.write(JSON.stringify({ type: 'result', id: message.id + 99, ok: true, bars: [] }) + '\\n');`,
  );
  try {
    assert.equal(await t.ready(), true);
    assert.deepEqual(await t.fetch(request), { ok: false, error: 'worker-crashed' });
  } finally {
    t.stop();
  }
});

test('a good answer is matched by id and returned without the envelope', async () => {
  const t = fakeWorker(
    dataFolder(),
    `process.stdout.write(JSON.stringify({ type: 'result', id: message.id, ok: false, error: 'rate-limited', retryAfterSeconds: 7 }) + '\\n');`,
  );
  try {
    assert.deepEqual(await t.fetch(request), {
      ok: false,
      error: 'rate-limited',
      retryAfterSeconds: 7,
    });
    assert.deepEqual(await t.fetch(request), {
      ok: false,
      error: 'rate-limited',
      retryAfterSeconds: 7,
    });
  } finally {
    t.stop();
  }
});

test('a line over 16 MB stops the worker', async () => {
  const t = fakeWorker(dataFolder(), `process.stdout.write('a'.repeat(17 * 1024 * 1024) + '\\n');`);
  try {
    assert.equal(await t.ready(), true);
    assert.deepEqual(await t.fetch(request), { ok: false, error: 'worker-crashed' });
  } finally {
    t.stop();
  }
});

test('a worker that exits mid-request reports worker-crashed, and the next request restarts it', async () => {
  const marker = join(scratch(), 'first');
  const t = fakeWorker(
    dataFolder(),
    `if (!fs.existsSync(process.argv[1])) { fs.writeFileSync(process.argv[1], 'x'); process.exit(1); }
     process.stdout.write(JSON.stringify({ type: 'result', id: message.id, ok: true, prices: [] }) + '\\n');`,
    [marker],
  );
  try {
    assert.deepEqual(await t.fetch(request), { ok: false, error: 'worker-crashed' });
    assert.deepEqual(await t.fetch(request), { ok: true, prices: [] });
  } finally {
    t.stop();
  }
});

test('credentials go over stdin only', async () => {
  const dump = join(scratch(), 'dump.json');
  const marker = 'SECRETMARKER123';
  const t = fakeWorker(
    dataFolder(),
    `fs.appendFileSync(process.argv[1], JSON.stringify({ argv: process.argv, env: process.env, message }) + '\\n');
     if (message.type === 'fetch') process.stdout.write(JSON.stringify({ type: 'result', id: message.id, ok: true, prices: [] }) + '\\n');`,
    [dump],
  );
  try {
    t.setCredentials({ keyId: 'KEYIDMARKER123', secret: marker });
    assert.deepEqual(await t.fetch(request), { ok: true, prices: [] });
    const rows = readFileSync(dump, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    for (const row of rows) {
      assert.ok(!JSON.stringify(row.argv).includes(marker));
      assert.ok(!JSON.stringify(row.env).includes(marker));
      assert.ok(!JSON.stringify(row.env).includes('KEYIDMARKER123'));
    }
    const sent = rows.map((r) => r.message);
    assert.deepEqual(sent[0], { type: 'credentials', keyId: 'KEYIDMARKER123', secret: marker });
    assert.equal(sent[1].type, 'fetch');
  } finally {
    t.stop();
  }
});

test('removing credentials restarts the worker so the key leaves its memory', async () => {
  const pids = join(scratch(), 'pids');
  const t = fakeWorker(
    dataFolder(),
    `fs.appendFileSync(process.argv[1], process.pid + ':' + message.type + '\\n');
     if (message.type === 'fetch') process.stdout.write(JSON.stringify({ type: 'result', id: message.id, ok: true, prices: [] }) + '\\n');`,
    [pids],
  );
  try {
    t.setCredentials({ keyId: 'KEYIDMARKER123', secret: 'SECRETMARKER123' });
    await t.fetch(request);
    t.setCredentials(null);
    await t.fetch(request);
    const rows = readFileSync(pids, 'utf8').trim().split('\n');
    const first = rows.filter((r) => !r.endsWith('credentials'))[0].split(':')[0];
    const last = rows[rows.length - 1].split(':')[0];
    assert.notEqual(first, last, 'a new process answered after the key was removed');
    assert.equal(
      rows.filter((r) => r.startsWith(`${last}:`) && r.endsWith('credentials')).length,
      0,
    );
  } finally {
    t.stop();
  }
});

const SILENT = `process.stdin.on('data', () => {});`; // answers nothing
const prices = { ok: true, prices: [] };

test('a hung request times out after 15 s, and the other request in flight gets timeout too', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const t = fakeWorker(dataFolder(), SILENT);
  try {
    assert.equal(await t.ready(), true);
    const first = t.fetch(request);
    const second = t.fetch(request);
    await new Promise((resolve) => setImmediate(resolve)); // both timers are now set
    mock.timers.tick(15_000);
    assert.deepEqual(await first, { ok: false, error: 'timeout' });
    assert.deepEqual(await second, { ok: false, error: 'timeout' });
  } finally {
    mock.timers.reset();
    t.stop();
  }
});

test('a worker that never says ready is given up on after 10 s', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const script = 'setInterval(() => {}, 1000);';
  const t = sandboxedTransport({
    dataDir: dataFolder(),
    appDir,
    worker: workerPath,
    command: () => ({ command: process.execPath, args: ['-e', script] }),
  });
  try {
    const ready = t.ready();
    mock.timers.tick(10_000);
    assert.equal(await ready, false);
    const request2 = t.fetch(request); // starts a fresh worker, which also never answers
    mock.timers.tick(10_000);
    assert.deepEqual(await request2, { ok: false, error: 'isolation' });
  } finally {
    mock.timers.reset();
    t.stop();
  }
});

const written = () => new Promise((resolve) => setImmediate(resolve)); // the request is on stdin
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function ended(pid: number): Promise<void> {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false, `worker ${pid} is still running`);
}
const BTC = { ok: true, prices: [{ symbol: 'BTC-USD', priceMinor: 6_512_345, paused: false }] };
// Answers each request 300 ms after it arrives, and logs pid:type:keyId for every line.
const LOGGED_SLOW = `fs.appendFileSync(process.argv[1], process.pid + ':' + message.type + ':' + (message.keyId ?? '') + '\\n');
  if (message.type === 'fetch')
    setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', id: message.id, ...${JSON.stringify(BTC)} }) + '\\n'), 300);`;
const logRows = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((row) => row.split(':'));

test('clearing the key lets a Coinbase request in flight finish with its real answer', async () => {
  const log = join(scratch(), 'log');
  const t = fakeWorker(dataFolder(), LOGGED_SLOW, [log]);
  try {
    t.setCredentials({ keyId: 'KEYIDMARKER123', secret: 'SECRETMARKER123' });
    assert.equal(await t.ready(), true);
    const inFlight = t.fetch(request);
    await written();
    t.setCredentials(null);
    assert.deepEqual(await inFlight, BTC);
  } finally {
    t.stop();
  }
});

test('a retired worker never receives a new key, new requests go to a fresh worker, and it ends after its last answer', async () => {
  const log = join(scratch(), 'log');
  const t = fakeWorker(dataFolder(), LOGGED_SLOW, [log]);
  try {
    t.setCredentials({ keyId: 'FIRSTKEYID123', secret: 'FIRSTSECRET123' });
    assert.equal(await t.ready(), true);
    const old = t.fetch(request);
    await written();
    t.setCredentials(null);
    t.setCredentials({ keyId: 'SECONDKEYID123', secret: 'SECONDSECRET123' });
    const fresh = t.fetch(request);
    assert.deepEqual(await old, BTC);
    assert.deepEqual(await fresh, BTC);
    const rows = logRows(log);
    const first = rows[0][0];
    const second = rows.find((row) => row[0] !== first)?.[0];
    assert.ok(second, 'a second worker took the new request');
    const sent = (pid: string) =>
      rows.filter((row) => row[0] === pid).map(([, type, keyId]) => [type, keyId]);
    assert.deepEqual(sent(first), [
      ['credentials', 'FIRSTKEYID123'],
      ['fetch', ''],
    ]);
    assert.deepEqual(sent(second), [
      ['credentials', 'SECONDKEYID123'],
      ['fetch', ''],
    ]);
    await ended(Number(first));
  } finally {
    t.stop();
  }
});

test('a request on a retired worker that never answers times out after 15 s, not worker-crashed', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const t = fakeWorker(dataFolder(), SILENT);
  try {
    assert.equal(await t.ready(), true);
    const inFlight = t.fetch(request);
    let settled = false;
    void inFlight.then(() => (settled = true));
    await written();
    t.setCredentials(null);
    await written();
    assert.equal(settled, false, 'the retired worker keeps its request until it answers');
    mock.timers.tick(15_000);
    assert.deepEqual(await inFlight, { ok: false, error: 'timeout' });
  } finally {
    mock.timers.reset();
    t.stop();
  }
});

test('stop() also ends a retired worker, and gives its request timeout', async () => {
  const log = join(scratch(), 'log');
  const t = fakeWorker(
    dataFolder(),
    `fs.appendFileSync(process.argv[1], process.pid + ':' + message.type + ':\\n');`,
    [log],
  );
  try {
    assert.equal(await t.ready(), true);
    const inFlight = t.fetch(request);
    for (let i = 0; i < 100 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 20));
    const pid = Number(logRows(log)[0][0]);
    children.push(pid);
    t.setCredentials(null);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(pid), true, 'a retired worker runs on while it holds a request');
    t.stop();
    assert.deepEqual(await inFlight, { ok: false, error: 'timeout' });
    await ended(pid);
  } finally {
    t.stop();
  }
});

test('stop() gives requests in flight timeout, not worker-crashed', async () => {
  const t = fakeWorker(dataFolder(), SILENT);
  assert.equal(await t.ready(), true);
  const inFlight = t.fetch(request);
  t.stop();
  assert.deepEqual(await inFlight, { ok: false, error: 'timeout' });
});

test('an old worker exiting late does not fail the new worker requests', async () => {
  const t = fakeWorker(
    dataFolder(),
    `process.stdout.write(JSON.stringify({ type: 'result', id: message.id, ok: true, prices: [] }) + '\\n');`,
  );
  try {
    assert.equal(await t.ready(), true);
    t.stop();
    const next = t.fetch(request);
    const end = Date.now() + 1500; // the event loop is busy while both children change state
    while (Date.now() < end);
    assert.deepEqual(await next, prices);
  } finally {
    t.stop();
  }
});

test('a worker stopped during startup gives timeout, not isolation', async () => {
  const t = fakeWorker(dataFolder(), SILENT);
  try {
    const started = t.fetch(request);
    t.setCredentials(null);
    assert.deepEqual(await started, { ok: false, error: 'timeout' });
  } finally {
    t.stop();
  }
});

// Says ready only after 400 ms, so the server can stop it while it starts.
const SLOW_READY = `setTimeout(() => process.stdout.write('{"type":"ready"}\\n'), 400);
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => process.exit(0));`;

test('a worker the server stops while it starts is not an isolation failure, and the next call starts afresh', async () => {
  const t = sandboxedTransport({
    dataDir: dataFolder(),
    appDir,
    worker: workerPath,
    command: () => ({ command: process.execPath, args: ['-e', SLOW_READY] }),
  });
  try {
    const cleared = t.ready();
    t.setCredentials(null);
    assert.equal(await cleared, null);
    const stopped = t.ready();
    t.stop();
    assert.equal(await stopped, null);
    assert.equal(await t.ready(), true);
  } finally {
    t.stop();
  }
});

test('a worker that proved itself and then sent junk in the same chunk gives worker-crashed', async () => {
  const script = `process.stdout.write('{"type":"ready"}\\nnot json\\n'); setInterval(() => {}, 1000);`;
  const t = sandboxedTransport({
    dataDir: dataFolder(),
    appDir,
    worker: workerPath,
    command: () => ({ command: process.execPath, args: ['-e', script] }),
  });
  try {
    assert.deepEqual(await t.fetch(request), { ok: false, error: 'worker-crashed' });
  } finally {
    t.stop();
  }
});

test('a request that fails the schema is refused before it is written', async () => {
  const dump = join(scratch(), 'dump');
  const t = fakeWorker(dataFolder(), `fs.appendFileSync(process.argv[1], 'line\\n');`, [dump]);
  try {
    const bad = { feed: 'coinbase', kind: 'prices', symbols: ['not a symbol'] } as FetchRequest;
    assert.deepEqual(await t.fetch(bad), { ok: false, error: 'malformed' });
    assert.equal(existsSync(dump), false);
  } finally {
    t.stop();
  }
});

test('workerCommand refuses a layout where node sits at or above the home folder', () => {
  const node = realpathSync(process.execPath);
  const nodeDir = dirname(dirname(node));
  assert.throws(() =>
    workerCommand({ dataDir: scratch(), appDir, worker: workerPath, home: nodeDir }, 'darwin'),
  );
  assert.throws(() =>
    workerCommand(
      { dataDir: scratch(), appDir, worker: workerPath, home: join(nodeDir, 'bin') },
      'darwin',
    ),
  );
  // A home folder that merely holds node (the usual ~/.nvm layout) is fine.
  assert.doesNotThrow(() =>
    workerCommand(
      { dataDir: scratch(), appDir, worker: workerPath, home: dirname(nodeDir) },
      'darwin',
    ),
  );
  assert.doesNotThrow(() =>
    workerCommand({ dataDir: scratch(), appDir, worker: workerPath, home: scratch() }, 'darwin'),
  );
});

test('workerCommand refuses an app folder that is the home folder or above it', () => {
  const home = scratch();
  const inside = join(home, 'project');
  mkdirSync(inside);
  assert.throws(() =>
    workerCommand({ dataDir: scratch(), worker: workerPath, appDir: home, home }, 'darwin'),
  );
  assert.throws(() =>
    workerCommand(
      { dataDir: scratch(), worker: workerPath, appDir: dirname(home), home },
      'darwin',
    ),
  );
  assert.throws(() =>
    workerCommand({ dataDir: scratch(), worker: workerPath, appDir: '/', home }, 'darwin'),
  );
  // A project folder inside the home folder, the usual layout, is fine.
  assert.doesNotThrow(() =>
    workerCommand({ dataDir: scratch(), worker: workerPath, appDir: inside, home }, 'darwin'),
  );
  assert.doesNotThrow(() =>
    workerCommand({ dataDir: scratch(), appDir, worker: workerPath, home: scratch() }, 'darwin'),
  );
});

test('a transport whose app folder holds the home folder reports isolation unavailable', async () => {
  const home = scratch();
  const t = sandboxedTransport({
    dataDir: dataFolder(),
    appDir: dirname(home),
    worker: workerPath,
    command: (paths) => workerCommand({ ...paths, home }, 'darwin'),
  });
  assert.equal(await t.ready(), false);
  t.stop();
});

test('a transport on such a layout reports isolation unavailable', async () => {
  const home = dirname(dirname(realpathSync(process.execPath)));
  const t = sandboxedTransport({
    dataDir: dataFolder(),
    appDir,
    worker: workerPath,
    command: (paths) => workerCommand({ ...paths, home }, 'darwin'),
  });
  assert.equal(await t.ready(), false);
  assert.deepEqual(await t.fetch(request), { ok: false, error: 'isolation' });
  t.stop();
});

test('the home folder comes from the account, not from $HOME', () => {
  const saved = process.env.HOME;
  process.env.HOME = scratch();
  try {
    const { args } = workerCommand({ dataDir: scratch(), appDir, worker: workerPath }, 'darwin');
    const home = args[args.indexOf('-D') + 1];
    assert.equal(home, `HOME=${realpathSync(userInfo().homedir)}`);
  } finally {
    process.env.HOME = saved;
  }
});

test('with no transport, nothing starts', async () => {
  const processes = (): number =>
    process.getActiveResourcesInfo().filter((name) => name === 'ProcessWrap').length;
  const before = processes();
  assert.equal(await unavailableTransport.ready(), false);
  assert.deepEqual(await unavailableTransport.fetch(request), { ok: false, error: 'isolation' });
  unavailableTransport.setCredentials({ keyId: 'KEYIDMARKER123', secret: 'SECRETMARKER123' });
  unavailableTransport.stop();
  assert.equal(processes(), before);
});
