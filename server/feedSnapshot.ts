import {
  FEEDS,
  type FeedFailure,
  type FeedName,
  type FeedState,
  type FeedStatus,
  type FetchRequest,
  type MarketAlert,
  type MarketSource,
} from '../shared/feedSchema.ts';
import { deriveFeedState } from '../shared/feedViews.ts';
import {
  instruments,
  type Bar,
  type Decision,
  type MarketInstrument,
  type RuleOverview,
  type SetupOutcome,
} from '../shared/fixtures.ts';
import { isMarketOpen, latestClosedBar } from '../shared/marketCalendar.ts';
import { SETTLE_MS, barsStopped } from './feedBars.ts';
import { evaluate, ruleOverview, setupOutcomes } from './replay.ts';

// The read side of the feed supervisor: the state it keeps, and how that state reads as rows,
// feed statuses, and the alerts a page needs. Nothing here changes the state, except the caches.

const BAR_MS = 900_000,
  PRICE_FRESH_MS = 180_000,
  WINDOW_BARS = 80;

export type Kind = FetchRequest['kind'];
export type LiveSource = Extract<MarketSource, { kind: 'live' }>;
export interface InFlight {
  token: number;
  startedAt: number;
}
export interface FeedRun {
  name: FeedName;
  enabled: boolean;
  generation: number; // bumped on every toggle, so an answer from before it is dropped
  failure: FeedFailure | null; // a terminal one, or unexpected-response until reconciled
  failures: number; // the backoff step, cleared when the feed reconciles
  lastFailureAt: number;
  retryAt: number;
  crashes: number[];
  lastCrashAt: number;
  reconciled: boolean;
  // Bumped whenever the feed stops being reconciled. An answer to a request from an older epoch,
  // such as one sent before a detected sleep, can't reconcile it.
  epoch: number;
  // A bar answer that would reconcile the feed waits for this earlier price request to succeed.
  awaiting: number | null;
  // Set once, at the first reconcile since the toggle. With no price yet, the price is this old.
  firstReconciledAt: number | null;
  checked: Map<string, number>; // per symbol, the newest closed bar held or found missing
  inflight: Record<Kind, InFlight | null>;
  lastStart: Record<Kind, number>;
  barsTarget: number | null; // the newest closed bar the last bar request was for
  lastBarsOkAt: number | null; // when the newest successful bar request went out
  // A session's last bar, once an answer of this epoch left nothing to ask about it while a
  // symbol's bars are stopped. No bar request goes out until the next session's first bar is due.
  quietAfter: number | null;
}
export interface Window {
  bars: Bar[];
  decisions: Decision[];
  overview: RuleOverview;
  outcomes: Record<string, SetupOutcome[]>;
  times: Set<string>;
}
export interface Held {
  symbol: string;
  feed: FeedName;
  bars: Bar[]; // every retained bar, oldest first, with revisions of one time together
  price: number | null;
  priceAt: number | null;
  paused: boolean;
  decisions?: Decision[]; // cached until the bars change
  window?: Window;
}
// What the calendar says at one moment, worked out once per wake or snapshot.
export interface View {
  open: boolean;
  due: number | null; // the newest bar that should have settled
  failure: FeedFailure | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function calendarView(run: FeedRun, now: number): View {
  const calendar = FEEDS[run.name].calendar;
  // The stock calendar runs out after its last published year.
  const calendarGone = latestClosedBar(now, calendar) === null;
  return {
    open: isMarketOpen(now, calendar),
    due: latestClosedBar(now - SETTLE_MS, calendar),
    failure: run.failure ?? (calendarGone ? 'calendar' : null),
  };
}

/** The rule's decisions on every retained bar, cached until the bars change. */
export function decisionsOf(held: Held): Decision[] {
  return (held.decisions ??= evaluate(held.bars));
}

/** The newest 80 bar times, each at its newest revision, and their decisions. */
export function windowOf(held: Held): Window {
  if (held.window) return held.window;
  const bars: Bar[] = [];
  for (let i = held.bars.length - 1; i >= 0 && bars.length < WINDOW_BARS; i--)
    if (bars.at(-1)?.time !== held.bars[i].time) bars.push(held.bars[i]);
  bars.reverse();
  const byBar = new Map(decisionsOf(held).map((d) => [`${d.time}|${d.revision}`, d]));
  const decisions = bars.flatMap((b) => byBar.get(`${b.time}|${b.revision}`) ?? []);
  return (held.window = {
    bars,
    decisions,
    overview: ruleOverview(decisions),
    outcomes: setupOutcomes(decisions, bars),
    times: new Set(bars.map((b) => b.time)),
  });
}

// How late the newest due bar is. Nothing is late once it's checked, or once a successful
// answer came after it was due: a missing bar is retried, then becomes a gap, and stays live.
function barLate(run: FeedRun, held: Held, view: View, now: number): number {
  if (view.due === null || (run.checked.get(held.symbol) ?? -Infinity) >= view.due) return 0;
  if (run.lastBarsOkAt !== null && run.lastBarsOkAt >= view.due + BAR_MS + SETTLE_MS) return 0;
  return Math.max(0, now - (view.due + BAR_MS));
}

// Whether the provider stopped sending this symbol's bars, as of the newest successful answer. A
// paused symbol is left out, as the supervisor leaves it out.
function stopped(run: FeedRun, held: Held): boolean {
  if (run.lastBarsOkAt === null || held.paused) return false;
  return barsStopped(held.bars.at(-1)?.time, FEEDS[run.name].calendar, run.lastBarsOkAt);
}

// When a row last got anything: its quote or its newest bar's receipt.
function updatedAt(held: Held): number {
  const newest = held.bars.at(-1);
  return Math.max(held.priceAt ?? -Infinity, newest ? Date.parse(newest.receivedAt) : -Infinity);
}

function stateOf(
  run: FeedRun,
  view: View,
  now: number,
  row: { priceAt: number | null; barLateMs: number; paused: boolean; barsStopped: boolean },
): FeedState {
  // With no price yet, a reconciled feed's price is as old as its first reconcile.
  const priceAt = row.priceAt ?? run.firstReconciledAt;
  return deriveFeedState({
    enabled: run.enabled,
    failure: view.failure,
    reconciled: run.reconciled,
    failures: run.failures,
    marketOpen: view.open,
    priceAgeMs: run.reconciled && priceAt !== null ? now - priceAt : null,
    barLateMs: row.barLateMs,
    paused: row.paused,
    barsStopped: row.barsStopped,
  });
}

/**
 * A live row's source: its own state, since rows of one feed can differ. A row whose bars
 * stopped dates its last update from its newest bar, since fresh quotes don't make it current.
 */
export function rowSource(run: FeedRun, held: Held, view: View, now: number): LiveSource {
  const newest = held.bars.at(-1);
  const barsStopped = stopped(run, held);
  const updated = barsStopped ? (newest ? Date.parse(newest.time) : -Infinity) : updatedAt(held);
  return {
    kind: 'live',
    feed: run.name,
    provider: FEEDS[run.name].provider,
    venue: FEEDS[run.name].venue,
    state: stateOf(run, view, now, {
      priceAt: held.priceAt,
      barLateMs: barLate(run, held, view, now),
      paused: held.paused,
      barsStopped,
    }),
    reason: view.failure,
    lastUpdate: Number.isFinite(updated) ? iso(updated) : null,
    lastBarAt: newest?.time ?? null,
  };
}

/**
 * A feed's status. It reads paused only when every one of its symbols is paused, and stale when
 * any symbol's bars stopped. Its last update is when anything last arrived.
 */
export function feedStatus(
  run: FeedRun,
  held: Held[],
  view: View,
  now: number,
  hasKey: boolean,
): FeedStatus {
  const priceAts = held.flatMap((h) => (h.priceAt === null ? [] : [h.priceAt]));
  const rows = held.map((h) => rowSource(run, h, view, now));
  const newest = (values: (string | null)[]) =>
    values.reduce<string | null>((a, b) => (b !== null && (a === null || b > a) ? b : a), null);
  const updated = Math.max(...held.map(updatedAt));
  return {
    feed: run.name,
    enabled: run.enabled,
    state: stateOf(run, view, now, {
      priceAt: priceAts.length ? Math.max(...priceAts) : null,
      barLateMs: Math.max(...held.map((h) => barLate(run, h, view, now))),
      paused: held.every((h) => h.paused),
      barsStopped: held.some((h) => stopped(run, h)),
    }),
    failure: view.failure,
    hasKey,
    lastUpdate: Number.isFinite(updated) ? iso(updated) : null,
    lastBarAt: newest(rows.map((r) => r.lastBarAt)),
  };
}

/**
 * Every instrument, feed status, and the alerts to show. A row whose feed is off is its replay
 * row. A live row's price is the quote while it is no more than 3 minutes old, otherwise the last
 * close. Dismissed alerts stay while their bar is in a window, so the journal labels stay right.
 */
export function readSnapshot(input: {
  runs: Record<FeedName, FeedRun>;
  held: Map<string, Held>;
  replay: MarketInstrument[];
  alerts: () => MarketAlert[];
  hasKey: boolean;
  now: number;
}): { instruments: MarketInstrument[]; feeds: FeedStatus[]; alerts: MarketAlert[] } {
  const { runs, held, now } = input;
  const views = {
    coinbase: calendarView(runs.coinbase, now),
    alpaca: calendarView(runs.alpaca, now),
  };
  const windows = new Map<string, Set<string>>();
  const rows = instruments.map((instrument, index): MarketInstrument => {
    const own = held.get(instrument.symbol)!;
    const run = runs[own.feed];
    if (!run.enabled) return input.replay[index];
    const window = windowOf(own);
    windows.set(own.symbol, window.times);
    const fresh = own.priceAt !== null && now - own.priceAt <= PRICE_FRESH_MS ? own.price : null;
    const priceMinor = fresh ?? window.bars.at(-1)?.closeMinor ?? null;
    const first = window.bars[0]?.closeMinor;
    return {
      symbol: instrument.symbol,
      name: instrument.name,
      assetClass: instrument.assetClass,
      color: instrument.color,
      bars: window.bars,
      decisions: window.decisions,
      overview: window.overview,
      outcomes: window.outcomes,
      price: priceMinor === null ? null : priceMinor / 100,
      change: priceMinor === null || first === undefined ? null : (priceMinor / first - 1) * 100,
      source: rowSource(run, own, views[run.name], now),
    };
  });
  const alerts = input
    .alerts()
    .filter((a) => a.dismissedAt === null || windows.get(a.symbol)?.has(a.time));
  const feeds = [runs.coinbase, runs.alpaca].map((run) =>
    feedStatus(
      run,
      FEEDS[run.name].symbols.map((symbol) => held.get(symbol)!),
      views[run.name],
      now,
      run.name === 'alpaca' && input.hasKey,
    ),
  );
  return { instruments: rows, feeds, alerts };
}
