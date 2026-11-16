import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { appPaths } from '../server/paths.ts';

test('from source, the app folder is the parent of server/ and the worker is the .ts file', () => {
  const p = appPaths(pathToFileURL('/x/app/server/index.ts').href);
  assert.deepEqual(p, {
    appDir: '/x/app',
    dist: '/x/app/dist',
    worker: '/x/app/server/feedWorker.ts',
  });
});

test('from build/, the app folder is two levels up and the worker is the compiled file', () => {
  const p = appPaths(pathToFileURL('/x/app/build/server/index.js').href);
  assert.deepEqual(p, {
    appDir: '/x/app',
    dist: '/x/app/dist',
    worker: '/x/app/build/server/feedWorker.js',
  });
});
