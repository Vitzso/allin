import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything is found from the launcher's own location, never the launch folder. A module
// under build/server is compiled output, and its worker is the compiled .js beside it.
export function appPaths(moduleUrl: string): { appDir: string; dist: string; worker: string } {
  const here = dirname(fileURLToPath(moduleUrl));
  const compiled = moduleUrl.endsWith('.js') && here.endsWith(`${sep}build${sep}server`);
  const appDir = resolve(here, compiled ? '../..' : '..');
  return {
    appDir,
    dist: resolve(appDir, 'dist'),
    worker: resolve(here, compiled ? 'feedWorker.js' : 'feedWorker.ts'),
  };
}
