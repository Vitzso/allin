import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The worker's proof that it runs sandboxed. The worker imports this on Node's built-in
// TypeScript support, so it is erasable syntax only and imports nothing but node: modules.

interface FileSystem {
  readFileSync(path: string): unknown;
  statSync(path: string): unknown;
}

const failure = (action: () => unknown): string | null => {
  try {
    action();
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'error';
  }
};

// macOS: the profile denies the data folder, so reading the vault file fails with EPERM.
// Linux: bwrap never mounts the data folder, so neither the file nor the folder exists. A
// permission error there means the folder is mounted, which proves nothing.
export function contained(
  dataDir: string,
  platform: string,
  fs: FileSystem = { readFileSync, statSync },
): boolean {
  const read = failure(() => fs.readFileSync(join(dataDir, 'vault.json')));
  if (platform === 'darwin') return read === 'EPERM';
  if (platform === 'linux')
    return read === 'ENOENT' && failure(() => fs.statSync(dataDir)) === 'ENOENT';
  return false;
}
