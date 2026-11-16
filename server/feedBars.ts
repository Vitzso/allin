import { FEEDS, type FeedBar, type FeedName } from '../shared/feedSchema.ts';
import type { Bar, Decision } from '../shared/fixtures.ts';
import {
  isSessionBar,
  latestClosedBar,
  nextBarTime,
  type MarketCalendar,
} from '../shared/marketCalendar.ts';

export const SETTLE_MS = 30_000,
  LATE_MS = 300_000,
  RETAINED_BARS = 4000,
  MAX_BARS_BEHIND = 3;
const BAR_MS = 900_000,
  COINBASE_MAX = 350,
  CATCH_UP_MS = 14 * 86_400_000,
  ALPACA_OVERLAP_MS = 2 * BAR_MS;

/**
 * Whether the provider has stopped sending bars, as of an answer asked at `askedAt` that
 * succeeded: the newest held bar is more than 3 bars behind the newest bar settled by then, or
 * nothing is held. Bars are counted on the calendar, so a weekend or a night isn't a stop. A
 * single missing bar is a gap, and the feed stays live.
 */
export function barsStopped(
  newest: string | undefined,
  calendar: MarketCalendar,
  askedAt: number,
): boolean {
  const due = latestClosedBar(askedAt - SETTLE_MS, calendar);
  if (due === null) return false;
  if (newest === undefined) return true;
  let time: number | null = Date.parse(newest);
  for (let behind = 0; behind <= MAX_BARS_BEHIND; behind++) {
    time = time === null ? null : nextBarTime(time, calendar);
    if (time === null || time > due) return false;
  }
  return true;
}

/** Provider rows that have closed at least 30 seconds ago and, for stocks, belong to a session. */
export function settledBars(rows: FeedBar[], calendar: MarketCalendar, now: number): FeedBar[] {
  return rows.filter((row) => {
    const time = Date.parse(row.time);
    return time + BAR_MS + SETTLE_MS <= now && isSessionBar(time, calendar);
  });
}

/**
 * Adds provider rows to the held bars. A row whose close matches the newest held revision of that
 * bar is ignored, whatever its volume. A different close is saved as the next revision.
 */
export function mergeBars(
  held: Bar[],
  rows: FeedBar[],
  feed: FeedName,
  receivedAt: string,
): { bars: Bar[]; added: Bar[]; corrected: Bar[] } {
  const identity = FEEDS[feed];
  const newest = new Map<string, Bar>();
  for (const bar of held) {
    const key = `${bar.symbol}|${bar.time}`;
    if (!newest.has(key) || newest.get(key)!.revision < bar.revision) newest.set(key, bar);
  }
  const added: Bar[] = [],
    corrected: Bar[] = [];
  for (const row of rows) {
    const key = `${row.symbol}|${row.time}`;
    const current = newest.get(key);
    if (current && current.closeMinor === row.closeMinor) continue;
    const bar: Bar = {
      symbol: row.symbol,
      assetClass: identity.assetClass,
      provider: identity.provider,
      venue: identity.venue,
      currency: 'USD',
      calendar: identity.calendar,
      time: row.time,
      receivedAt,
      interval: '15m',
      revision: current ? current.revision + 1 : 1,
      closeMinor: row.closeMinor,
      volume: row.volume,
    };
    newest.set(key, bar);
    (current ? corrected : added).push(bar);
  }
  const all = [...held, ...added, ...corrected].sort(
    (a, b) => Date.parse(a.time) - Date.parse(b.time) || a.revision - b.revision,
  );
  // Keep the newest RETAINED_BARS times of each symbol. All revisions of a kept time stay.
  const timesBySymbol = new Map<string, Set<string>>();
  for (const bar of all) {
    const times = timesBySymbol.get(bar.symbol) ?? new Set<string>();
    times.add(bar.time);
    timesBySymbol.set(bar.symbol, times);
  }
  const dropped = new Map<string, Set<string>>();
  for (const [symbol, times] of timesBySymbol)
    if (times.size > RETAINED_BARS)
      dropped.set(symbol, new Set([...times].slice(0, times.size - RETAINED_BARS)));
  const kept = (bar: Bar) => !dropped.get(bar.symbol)?.has(bar.time);
  return {
    bars: all.filter(kept),
    added: added.filter(kept),
    corrected: corrected.filter(kept),
  };
}

/** What to ask a provider for, given the newest bar held and the clock. */
export function barRequest(
  feed: FeedName,
  lastHeld: string | null,
  now: number,
): { limit?: number; start?: string } {
  if (feed === 'coinbase') {
    const held = lastHeld === null ? NaN : Date.parse(lastHeld);
    const newest = latestClosedBar(now, 'continuous');
    if (!Number.isFinite(held) || newest === null) return { limit: COINBASE_MAX };
    // The forming bar and the three latest closed, plus every bar missing since the last held.
    const missing = Math.max(1, Math.round((newest - held) / BAR_MS));
    return { limit: Math.min(COINBASE_MAX, missing + 3) };
  }
  const floor = now - CATCH_UP_MS;
  const held = lastHeld === null ? NaN : Date.parse(lastHeld);
  const start = Number.isFinite(held) ? Math.max(held - ALPACA_OVERLAP_MS, floor) : floor;
  return { start: new Date(start).toISOString() };
}

/** Whether a setup on `bar` may alert: see "Live or historical" in the design. */
export function isLiveBar(input: {
  reconciledBeforePoll: boolean;
  bar: Bar;
  previousHeldBeforePoll: boolean;
  now: number;
}): boolean {
  const time = Date.parse(input.bar.time);
  return (
    input.reconciledBeforePoll &&
    input.previousHeldBeforePoll &&
    latestClosedBar(input.now - SETTLE_MS, input.bar.calendar) === time &&
    input.now - (time + BAR_MS) <= LATE_MS
  );
}

/** One alert per setup. The rule's own decision id depends on how much history was evaluated. */
export const alertId = (decision: Decision) =>
  `${decision.provider}:${decision.venue}:${decision.symbol}:${decision.interval}:${decision.time}:${decision.state}:${decision.version}`;
