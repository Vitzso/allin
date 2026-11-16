import type { Server } from 'node:http';
import type { FeedSupervisor } from './feedSupervisor.ts';
import type { Vault } from './vault.ts';

/**
 * What quitting does. The feeds stop first, while the vault is still open, so bars and alerts
 * waiting for the next wake are saved. Only then does the vault lock.
 */
export function shutdown(parts: {
  vault: Vault;
  feeds: FeedSupervisor;
  server: Pick<Server, 'close'>;
}): void {
  parts.feeds.stop();
  parts.vault.lock();
  parts.server.close();
}
