import { alpacaKeySchema, type AlpacaKey } from '../shared/feedSchema.ts';
import { AppError } from './errors.ts';
import type { Vault } from './vault.ts';

const keyId = (vault: Vault) => `alpaca:${vault.id}`;

// Null when there is no key, or the stored one can't be read. The caller treats both as "no key".
export function loadAlpacaKey(vault: Vault): AlpacaKey | null {
  try {
    const stored = vault.keyStore.get(keyId(vault));
    return stored === null ? null : alpacaKeySchema.parse(JSON.parse(stored));
  } catch {
    return null;
  }
}

// The key lives only in the key store. The vault logs that it changed, never what it is.
export function saveAlpacaKey(vault: Vault, key: AlpacaKey): void {
  const valid = alpacaKeySchema.parse(key);
  if (!vault.unlocked) throw new AppError(401, 'Unlock your vault to continue.');
  vault.keyStore.set(keyId(vault), JSON.stringify(valid));
  vault.event('feed.key-saved');
}

export function removeAlpacaKey(vault: Vault): void {
  const id = keyId(vault);
  if (vault.keyStore.get(id) === null) return;
  vault.keyStore.delete(id);
  vault.event('feed.key-removed');
}
