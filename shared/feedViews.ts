import type { FeedFailure, FeedState, MarketAlert, MarketSource } from './feedSchema.ts';
import type { Decision } from './fixtures.ts';

const PRICE_STALE_MS = 180_000,
  BAR_STALE_MS = 300_000;

/**
 * What a feed's state is, checked in this order: off, failing, paused, closed, bars stopped,
 * unreconciled, then age.
 */
export function deriveFeedState(input: {
  enabled: boolean;
  failure: FeedFailure | null;
  reconciled: boolean;
  failures: number;
  marketOpen: boolean;
  priceAgeMs: number | null;
  barLateMs: number | null;
  paused: boolean;
  // Answers succeed, but the newest bar is more than 3 bars behind: stale, not catching up.
  barsStopped: boolean;
}): FeedState {
  if (!input.enabled) return 'off';
  if (input.failure) return 'failing';
  if (input.paused) return 'paused';
  if (!input.marketOpen) return 'closed';
  if (input.barsStopped) return 'stale';
  if (!input.reconciled) return input.failures > 0 ? 'stale' : 'catching-up';
  if (input.priceAgeMs !== null && input.priceAgeMs > PRICE_STALE_MS) return 'stale';
  if (input.barLateMs !== null && input.barLateMs > BAR_STALE_MS) return 'stale';
  return 'live';
}

const clock = (instant: string | number, timezone: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...options })
    .format(typeof instant === 'string' ? Date.parse(instant) : instant)
    .replace(/\u202f/g, ' ');

function age(since: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  if (seconds < 60) return `${seconds} sec ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  const days = Math.floor(seconds / 86400);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

const FAILURE_TEXT: Record<FeedFailure, string> = {
  'key-rejected': 'key rejected',
  'key-missing': 'key unavailable, enter it again',
  'unexpected-response': 'unexpected response',
  isolation: 'isolation unavailable',
  'worker-crashes': 'restart AllIn or toggle the feed',
  calendar: '',
};

/** The line under a row: what its prices are and how fresh they are. */
export function rowLabel(source: MarketSource, now: number): string {
  if (source.kind === 'replay') return 'Synthetic replay';
  const { state, reason, provider, feed, lastUpdate, lastBarAt } = source;
  switch (state) {
    case 'live':
      return [
        'Live',
        provider,
        feed === 'alpaca' ? 'IEX only' : null,
        lastUpdate ? `updated ${age(lastUpdate, now)}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'catching-up':
      return 'Catching up · signals paused';
    case 'stale':
      return `Stale · ${lastUpdate ? `last update ${age(lastUpdate, now)}` : 'no update yet'} · signals paused`;
    case 'closed': {
      if (!lastBarAt) return 'Market closed';
      const close = Date.parse(lastBarAt) + 900_000;
      const day = clock(close, 'America/New_York', { weekday: 'short' });
      const time = clock(close, 'America/New_York', { hour: 'numeric', minute: '2-digit' });
      return `Market closed · last close ${day} ${time} ET`;
    }
    case 'paused':
      return `Trading paused on ${provider}`;
    case 'failing':
      if (reason === 'calendar') return 'Market calendar needs updating';
      return reason ? `Feed failing · ${FAILURE_TEXT[reason]}` : 'Feed failing';
    case 'off':
      return 'Feed off';
  }
}

/** The banner's counts, for the parts above zero. Anything that isn't live or closed has signals paused. */
export function sourceSummary(sources: MarketSource[]): string {
  const count = { live: 0, closed: 0, paused: 0, replay: 0 };
  for (const source of sources) {
    if (source.kind === 'replay') count.replay++;
    else if (source.state === 'live') count.live++;
    else if (source.state === 'closed') count.closed++;
    else count.paused++;
  }
  return [
    ['live', count.live],
    ['market closed', count.closed],
    ['paused', count.paused],
    ['replay', count.replay],
  ]
    .filter(([, n]) => (n as number) > 0)
    .map(([name, n]) => `${n} ${name}`)
    .join(' · ');
}

/** "Buy setup · EMA20 crossed above EMA50 · BTC-USD · Coinbase · 10:15 PM" */
export function alertLine(alert: MarketAlert, timezone: string): string {
  const direction = alert.state === 'Buy setup' ? 'above' : 'below';
  const time = clock(alert.time, timezone, { hour: 'numeric', minute: '2-digit' });
  return `${alert.state} · EMA20 crossed ${direction} EMA50 · ${alert.symbol} · ${alert.provider} · ${time}`;
}

/** The key server/feedBars.ts gives an alert, so a decision finds its alert. */
const alertKey = (d: Decision) =>
  `${d.provider}:${d.venue}:${d.symbol}:${d.interval}:${d.time}:${d.state}:${d.version}`;

export function decisionLabel(
  decision: Decision,
  source: MarketSource,
  alerts: MarketAlert[],
): 'Simulation' | 'Live alert' | 'Historical' {
  if (source.kind === 'replay') return 'Simulation';
  const key = alertKey(decision);
  return alerts.some((a) => a.id === key) ? 'Live alert' : 'Historical';
}

export function changeLabel(
  source: MarketSource,
): 'over fixture' | 'over 20 hours' | 'over 20 market hours' {
  if (source.kind === 'replay') return 'over fixture';
  return source.feed === 'alpaca' ? 'over 20 market hours' : 'over 20 hours';
}

/** Each volume as a percent of the window's largest, and 0 when all are 0. */
export function volumeHeights(volumes: number[]): number[] {
  const largest = Math.max(0, ...volumes);
  return volumes.map((v) => (largest > 0 ? (v / largest) * 100 : 0));
}
