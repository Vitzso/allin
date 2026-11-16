import { readFileSync } from 'node:fs';
import { ConfigError, type Config } from './config.ts';
import { FileKeyStore, keyStoreFor } from './fileKeyStore.ts';
import type { KeyStore } from './keychain.ts';

// The launcher's checks after the configuration is read. Each refusal is a ConfigError, so the
// launcher prints one line and exits before it listens.

// On Linux the key folder is checked now, not at the first setup or unlock.
export function openKeyStore(config: Config, platform: NodeJS.Platform): KeyStore {
  const store = keyStoreFor(config, platform);
  if (store instanceof FileKeyStore)
    try {
      store.check();
    } catch {
      throw new ConfigError(
        'The key store folder is not safe to use. It must exist, be owned by the user running AllIn, be mode 700, and sit outside the data folder.',
      );
    }
  return store;
}

// A key owned by another user passes the mode check and fails here. The code only: messages carry paths.
export function readTls(files: { cert: string; key: string }): { cert: Buffer; key: Buffer } {
  try {
    return { cert: readFileSync(files.cert), key: readFileSync(files.key) };
  } catch (error) {
    throw new ConfigError(
      `The TLS certificate or key file could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'}).`,
    );
  }
}
