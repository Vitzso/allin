// Run inside the worker sandbox by tests/feedSandbox.test.ts. Tries each forbidden action and
// prints a JSON object of action to outcome ('ok' or the error code). Plain JavaScript, so it
// runs the same with or without Node's TypeScript support.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { get } from 'node:http';
import { spawnSync } from 'node:child_process';

// A fourth argument of 'no-http' skips the plain HTTP attempt, so the unsandboxed control run
// never touches the internet.
const [vaultDir, writeDir, loopbackPort, mode] = process.argv.slice(2);

const code = (error) => error?.code ?? error?.errors?.[0]?.code ?? error?.name ?? 'error';
const attempt = (action) => {
  try {
    action();
    return 'ok';
  } catch (error) {
    return code(error);
  }
};
const settle = (start) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 4000);
    start(
      () => {
        clearTimeout(timer);
        resolve('ok');
      },
      (error) => {
        clearTimeout(timer);
        resolve(code(error));
      },
    );
  });

const outcome = {
  readVault: attempt(() => readFileSync(join(vaultDir, 'vault.json'))),
  listVault: attempt(() => readdirSync(vaultDir)),
  write: attempt(() => writeFileSync(join(writeDir, 'probe.txt'), 'x')),
  spawn: attempt(() => {
    const result = spawnSync('/bin/echo', ['hi']);
    if (result.error) throw result.error;
  }),
};
outcome.loopback = await settle((ok, bad) => {
  const socket = connect(Number(loopbackPort), '127.0.0.1', () => {
    socket.destroy();
    ok();
  });
  socket.on('error', bad);
});
outcome.http =
  mode === 'no-http'
    ? 'skipped'
    : await settle((ok, bad) => {
  const req = get('http://93.184.216.34:80/', (res) => {
    res.destroy();
    ok();
  });
  req.on('error', bad);
});
console.log(JSON.stringify(outcome));
process.exit(0);
