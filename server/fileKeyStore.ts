import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import type { Config } from './config.ts';
import { OSKeyStore, type KeyStore } from './keychain.ts';

const unsafe = () => new Error('The key store folder is not safe to use.');
const within = (path: string, folder: string) =>
  path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

// A folder that doesn't exist yet is placed by resolving its nearest existing parent.
function resolveEventually(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(resolveEventually(parent), basename(path));
  }
}

// The Linux device-secret store: one owner-only file per id in a folder kept apart from the data.
export class FileKeyStore implements KeyStore {
  label = 'Linux key file';
  constructor(
    private dir: string,
    private dataDir: string,
  ) {}
  // The launcher calls this at start, so a bad folder stops AllIn before it listens.
  check(): void {
    this.checked();
  }
  // Checked on every call, so a folder changed while running is caught before it is used.
  private checked(): string {
    try {
      const real = realpathSync(this.dir);
      const stat = statSync(real);
      const data = resolveEventually(this.dataDir);
      if (
        !stat.isDirectory() ||
        stat.mode & 0o077 ||
        stat.uid !== process.getuid!() ||
        within(real, data) ||
        within(data, real)
      )
        throw unsafe();
      return real;
    } catch {
      throw unsafe();
    }
  }
  private file(real: string, id: string) {
    return join(real, createHash('sha256').update(id).digest('hex'));
  }
  get(id: string) {
    const file = this.file(this.checked(), id);
    try {
      // A zero-length file is a torn write, not a secret.
      return readFileSync(file, 'utf8') || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  set(id: string, secret: string) {
    const real = this.checked();
    const file = this.file(real, id);
    const temp = `${file}.tmp`;
    rmSync(temp, { force: true });
    try {
      // Flushed before the rename so a power loss can't leave an empty file under the real name.
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeSync(fd, secret);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    try {
      const dir = openSync(real, 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch {
      // The rename already happened; a folder that can't be synced is not a failed write.
    }
  }
  delete(id: string) {
    rmSync(this.file(this.checked(), id), { force: true });
  }
}

// Constructing an OSKeyStore doesn't touch the Keychain; using it does.
export function keyStoreFor(config: Config, platform: NodeJS.Platform): KeyStore {
  return platform === 'linux'
    ? new FileKeyStore(config.keystoreDir!, config.dataDir)
    : new OSKeyStore();
}
