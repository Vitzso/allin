import { Entry } from '@napi-rs/keyring';
export interface KeyStore {
  label: string;
  get(id: string): string | null;
  set(id: string, secret: string): void;
  delete(id: string): void;
}
export class OSKeyStore implements KeyStore {
  label = 'macOS Keychain';
  private entry(id: string) {
    return new Entry('com.allin.local.v1', id);
  }
  get(id: string) {
    return this.entry(id).getPassword();
  }
  set(id: string, secret: string) {
    this.entry(id).setPassword(secret);
  }
  delete(id: string) {
    this.entry(id).deletePassword();
  }
}
