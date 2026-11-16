import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { serverMessageSchema, workerMessageSchema } from '../shared/feedSchema.ts';
import type { AlpacaKey, FetchRequest, FetchResult } from '../shared/feedSchema.ts';

export interface FeedTransport {
  // Starts the worker if needed. True once it proves its containment. False means isolation
  // can't be proven: the proof failed or the sandbox couldn't start. Null means the server
  // stopped the worker before it proved itself, which says nothing about isolation; the next
  // call starts a fresh one.
  ready(): Promise<boolean | null>;
  fetch(request: FetchRequest): Promise<FetchResult>;
  setCredentials(key: AlpacaKey | null): void;
  stop(): void;
}

const ISOLATION: FetchResult = { ok: false, error: 'isolation' };

// For callers with no sandbox: nothing starts, and every request is refused.
export const unavailableTransport: FeedTransport = {
  ready: async () => false,
  fetch: async () => ISOLATION,
  setCredentials: () => undefined,
  stop: () => undefined,
};

// Paths arrive through -D and (param ...), never pasted into the text. The NODE line sits after
// the home deny because node may live under the home folder, and it must stay readable.
export const SANDBOX_PROFILE = [
  '(version 1)',
  '(allow default)',
  '(deny file-write*)',
  '(allow file-write* (literal "/dev/null"))',
  '(deny file-read* (subpath (param "HOME")))',
  '(allow file-read* (subpath (param "NODE")))',
  '(allow file-read* (subpath (param "APP")))',
  '(allow file-read-metadata)',
  '(deny file-read* (subpath (param "DATA")))',
  '(deny network*)',
  '(allow network-outbound (remote tcp "*:443"))',
  '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
  '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
  '(deny mach-lookup (global-name "com.apple.securityd.xpc"))',
  '(deny process-fork)',
  '',
].join('\n');

export interface WorkerPaths {
  dataDir: string;
  appDir: string;
  worker: string; // absolute path of the worker file, .ts from source or .js from build/
  home?: string;
  keysDir?: string; // the Linux key folder, which must stay out of the sandbox too
}
export type WorkerCommand = (paths: WorkerPaths) => { command: string; args: string[] };

// True when folder is path or one of its parents. A child named like '..keys' is still inside.
const holds = (folder: string, path: string): boolean => {
  const within = relative(folder, path);
  const outside = within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within);
  return !outside;
};

const NODE_HOLDS_HOME =
  'node is installed at or above the home folder, so the sandbox cannot protect it';
const APP_HOLDS_HOME = 'AllIn is at or above the home folder, so the sandbox cannot protect it';

// The sandbox matches resolved paths, so every path goes through realpathSync.
export function workerCommand(
  paths: WorkerPaths,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'darwin') return sandboxExec(paths);
  if (platform === 'linux') return bubblewrap(paths);
  throw new Error('the feed sandbox runs on macOS and Linux only');
}

function sandboxExec(paths: WorkerPaths): { command: string; args: string[] } {
  // The account's home, not $HOME, which a caller may have overridden.
  const home = realpathSync(paths.home ?? userInfo().homedir);
  const app = realpathSync(paths.appDir);
  const data = realpathSync(paths.dataDir);
  const node = realpathSync(process.execPath);
  const nodeDir = dirname(dirname(node));
  // The NODE and APP allows come after the HOME deny. If either folder holds the home folder,
  // its allow would undo the deny, so the feed refuses to run rather than weaken the sandbox.
  if (holds(nodeDir, home)) throw new Error(NODE_HOLDS_HOME);
  if (holds(app, home)) throw new Error(APP_HOLDS_HOME);
  return {
    command: '/usr/bin/sandbox-exec',
    args: [
      '-p',
      SANDBOX_PROFILE,
      '-D',
      `HOME=${home}`,
      '-D',
      `APP=${app}`,
      '-D',
      `DATA=${data}`,
      '-D',
      `NODE=${nodeDir}`,
      node,
      realpathSync(paths.worker),
      data,
    ],
  };
}

// bwrap starts from an empty root and shows the worker only what is bound below, read-only.
// The data and key folders are never bound, so inside they do not exist at all.
function bubblewrap(paths: WorkerPaths): { command: string; args: string[] } {
  const home = realpathSync(paths.home ?? userInfo().homedir);
  const app = realpathSync(paths.appDir);
  const data = realpathSync(paths.dataDir);
  const keys = paths.keysDir === undefined ? undefined : realpathSync(paths.keysDir);
  const node = realpathSync(process.execPath);
  const nodeDir = dirname(dirname(node));
  // A bound folder at or above the home folder would show all of it, ~/.ssh included.
  if (holds(nodeDir, home)) throw new Error(NODE_HOLDS_HOME);
  if (holds(app, home)) throw new Error(APP_HOLDS_HOME);
  // Anything under a bound folder is visible inside. /lib and /lib64 are often links into /usr,
  // and a system folder the host lacks is never bound.
  const bound = [
    { name: 'the AllIn folder', root: app },
    { name: 'the node folder', root: nodeDir },
    ...['/usr', '/lib', '/lib64']
      .filter((root) => existsSync(root))
      .map((root) => ({ name: `the system folder ${root}`, root: realpathSync(root) })),
  ];
  for (const { name, root } of bound) {
    if (holds(root, data))
      throw new Error(`${name} holds the data folder, so the sandbox cannot protect it`);
    if (keys !== undefined && holds(root, keys))
      throw new Error(`${name} holds the key folder, so the sandbox cannot protect it`);
  }
  // The worker proves itself by not finding the vault file, which only means something if the
  // file is there.
  try {
    accessSync(join(data, 'vault.json'), constants.R_OK);
  } catch {
    throw new Error('the vault file is missing, so the sandbox cannot be proven');
  }
  return {
    command: '/usr/bin/bwrap',
    args: [
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
      realpathSync(paths.worker),
      data,
    ],
  };
}

const READY_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

interface Pending {
  resolve: (result: FetchResult) => void;
  timer: NodeJS.Timeout;
}
// One started worker and everything that belongs to it, so a late event from an old worker
// can never touch a newer one.
interface Running {
  child: ChildProcess | null;
  ready: Promise<boolean>;
  settle: (ready: boolean) => void;
  isReady: boolean;
  done: boolean;
  stopped: boolean; // the server chose to end it, as opposed to it dying or misbehaving
  // Replaced when the key was cleared: it takes no new request and no key, and ends once every
  // request it holds has answered or timed out.
  retired: boolean;
  pending: Map<number, Pending>;
}

export function sandboxedTransport(options: {
  dataDir: string;
  appDir: string;
  worker: string;
  keysDir?: string;
  command?: WorkerCommand;
}): FeedTransport {
  const build = options.command ?? workerCommand;
  let running: Running | null = null;
  const retired = new Set<Running>();
  let credentials: AlpacaKey | null = null;
  let nextId = 0;

  function writeLine(child: ChildProcess | null, message: object): void {
    if (child?.stdin && !child.stdin.destroyed)
      child.stdin.write(`${JSON.stringify(message)}\n`, () => undefined);
  }

  // Ends one worker, once. A stop the server chose leaves other requests timed out, so they are
  // retried; an unrequested exit or a bad line is a crash.
  function terminate(state: Running, stopped: boolean): void {
    if (state.done) return;
    state.done = true;
    state.stopped = stopped;
    if (running === state) running = null;
    retired.delete(state);
    state.settle(false);
    state.child?.stdin?.destroy();
    state.child?.kill('SIGKILL');
    const waiting = [...state.pending.values()];
    state.pending.clear();
    for (const { resolve, timer } of waiting) {
      clearTimeout(timer);
      resolve({ ok: false, error: stopped ? 'timeout' : 'worker-crashed' });
    }
  }

  // New requests go to a fresh worker, and this one never hears from the server again. It still
  // holds the key it had until it ends, which is once its last request is in, at most 15 s.
  function retire(state: Running): void {
    if (running === state) running = null;
    state.retired = true;
    if (state.pending.size === 0) terminate(state, true);
    else retired.add(state);
  }

  function start(): Running {
    let settle: (ready: boolean) => void = () => undefined;
    const ready = new Promise<boolean>((resolve) => (settle = resolve));
    const state: Running = {
      child: null,
      ready,
      settle,
      isReady: false,
      done: false,
      stopped: false,
      retired: false,
      pending: new Map(),
    };
    let child: ChildProcess;
    try {
      const { command, args } = build({
        dataDir: options.dataDir,
        appDir: options.appDir,
        worker: options.worker,
        keysDir: options.keysDir,
      });
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], env: {} });
    } catch {
      state.done = true;
      settle(false);
      return state;
    }
    state.child = child;
    const readyTimer = setTimeout(() => terminate(state, false), READY_TIMEOUT_MS);

    const hostile = (): void => terminate(state, false);
    const handle = (line: Buffer): void => {
      let parsed: ReturnType<typeof workerMessageSchema.safeParse>;
      try {
        parsed = workerMessageSchema.safeParse(JSON.parse(line.toString('utf8')));
      } catch {
        return hostile();
      }
      if (!parsed.success) return hostile();
      const message = parsed.data;
      if (message.type === 'refused') return hostile();
      if (message.type === 'ready') {
        if (state.isReady) return hostile();
        state.isReady = true;
        clearTimeout(readyTimer);
        // A retired worker never gets a key. One still starting is killed when retired, so this
        // guard only states the rule.
        if (credentials && !state.retired)
          writeLine(child, { type: 'credentials', ...credentials });
        return settle(true);
      }
      const waiting = state.pending.get(message.id);
      if (!state.isReady || !waiting) return hostile();
      state.pending.delete(message.id);
      clearTimeout(waiting.timer);
      const { type: _type, id: _id, ...result } = message;
      waiting.resolve(result as FetchResult);
      if (state.retired && state.pending.size === 0) terminate(state, true);
    };

    let partial: Buffer[] = [];
    let partialBytes = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      let rest = chunk;
      for (;;) {
        if (state.done) return;
        const newline = rest.indexOf(10);
        if (newline < 0) {
          partial.push(rest);
          partialBytes += rest.length;
          if (partialBytes > MAX_LINE_BYTES) hostile();
          return;
        }
        if (partialBytes + newline > MAX_LINE_BYTES) return hostile();
        const line = Buffer.concat([...partial, rest.subarray(0, newline)]);
        partial = [];
        partialBytes = 0;
        handle(line);
        rest = rest.subarray(newline + 1);
      }
    });
    child.stdout?.on('error', () => undefined);
    child.stdin?.on('error', () => undefined);
    const gone = (): void => {
      clearTimeout(readyTimer);
      terminate(state, false);
    };
    child.on('error', gone);
    child.on('exit', gone);
    running = state;
    return state;
  }

  return {
    async ready() {
      const state = running ?? start();
      if (await state.ready) return true;
      return state.stopped ? null : false;
    },
    async fetch(request) {
      const state = running ?? start();
      // Isolation is only for a worker that never proved itself or could not start.
      if (!(await state.ready)) return state.stopped ? { ok: false, error: 'timeout' } : ISOLATION;
      if (state.done) return { ok: false, error: state.stopped ? 'timeout' : 'worker-crashed' };
      if (state.retired) return { ok: false, error: 'timeout' }; // never written to a retired worker
      const id = nextId++;
      const message = { type: 'fetch', id, ...request };
      if (!serverMessageSchema.safeParse(message).success) return { ok: false, error: 'malformed' };
      return new Promise<FetchResult>((resolve) => {
        const timer = setTimeout(() => {
          state.pending.delete(id);
          resolve({ ok: false, error: 'timeout' });
          terminate(state, true);
        }, REQUEST_TIMEOUT_MS);
        state.pending.set(id, { resolve, timer });
        writeLine(state.child, message);
      });
    },
    // Clearing the key retires the worker rather than killing it, so requests in flight, Coinbase's
    // among them, still get their answers. A worker still starting holds no key yet, and stops.
    setCredentials(key) {
      credentials = key;
      if (!running) return;
      if (key === null) retire(running);
      else if (running.isReady) writeLine(running.child, { type: 'credentials', ...key });
    },
    stop() {
      if (running) terminate(running, true);
      for (const state of [...retired]) terminate(state, true);
    },
  };
}
