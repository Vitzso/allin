import type { FeedFailure, FeedName, FetchError } from '../shared/feedSchema.ts';

// The feed supervisor's failure policy: what each error does to a feed, how long it waits before
// trying again, and when worker crashes stop it. Plain functions with no state of their own.

export const BACKOFF_MS = [1, 2, 4, 8, 15].map((minutes) => minutes * 60_000);
export const MAX_RETRY_AFTER_S = 3600,
  CRASH_WINDOW_MS = 300_000,
  CRASH_LIMIT = 3;
// These stop a feed until it is toggled or given a new key.
const TERMINAL: FeedFailure[] = ['key-rejected', 'key-missing', 'isolation', 'worker-crashes'];

export const isTerminal = (failure: FeedFailure | null) =>
  failure !== null && TERMINAL.includes(failure);

/**
 * The failure a request error sets, or null when it only takes the backoff. Alpaca rejecting the
 * key is terminal. Coinbase needs no key, so a refusal from it is an unexpected response.
 */
export function failureFor(feed: FeedName, error: FetchError): FeedFailure | null {
  if (error === 'isolation') return 'isolation';
  if (error === 'unauthorized') return feed === 'alpaca' ? 'key-rejected' : 'unexpected-response';
  if (error === 'malformed' || error === 'too-large') return 'unexpected-response';
  return null;
}

/**
 * How long to wait after the `step`th failure in a row: 1, 2, 4, 8, then every 15 minutes, or a
 * Retry-After the provider sent if that is longer, up to an hour.
 */
export function retryWait(step: number, retryAfterSeconds?: number): number {
  const backoff = BACKOFF_MS[Math.min(Math.max(step, 1), BACKOFF_MS.length) - 1];
  return Math.max(backoff, Math.min(retryAfterSeconds ?? 0, MAX_RETRY_AFTER_S) * 1000);
}

/** Adds a crash at `now` to the ones inside the window, and says whether that stops the feed. */
export function recordCrash(crashes: number[], now: number): { crashes: number[]; stop: boolean } {
  const recent = [...crashes.filter((at) => now - at <= CRASH_WINDOW_MS), now];
  return { crashes: recent, stop: recent.length >= CRASH_LIMIT };
}
