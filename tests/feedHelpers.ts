import { mergeBars, SETTLE_MS } from '../server/feedBars.ts';
import { saveAlpacaKey } from '../server/feedKeys.ts';
import { FeedSupervisor } from '../server/feedSupervisor.ts';
import type { FeedTransport } from '../server/feedSandbox.ts';
import { evaluate } from '../server/replay.ts';
import { FEEDS } from '../shared/feedSchema.ts';
import type {
  AlpacaKey,
  FeedBar,
  FeedName,
  FetchRequest,
  FetchResult,
} from '../shared/feedSchema.ts';
import { instruments } from '../shared/fixtures.ts';
import { isSessionBar, type MarketCalendar } from '../shared/marketCalendar.ts';
import { password, profile } from './helpers.ts';

const BAR_MS = 900_000;
const iso = (ms: number) => new Date(ms).toISOString();
type Clock = { now(): number };
type Handler = (request: FetchRequest) => FetchResult | Promise<FetchResult>;

export const feedOf = (symbol: string): FeedName =>
  FEEDS.coinbase.symbols.includes(symbol) ? 'coinbase' : 'alpaca';
const baseOf = (symbol: string) => instruments.find((i) => i.symbol === symbol)!.base;

export function fakeClock(start: string): { now(): number; advance(ms: number): void } {
  let time = Date.parse(start);
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

/** Lets answers that were released, or settled, reach the code awaiting them. */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Records every request. With no handler, every request fails as if offline. While `holding`
 * matches a request, its answer is worked out when it is asked, as a provider would, but only
 * delivered by release(), so answers can land late or out of order. While `slowStart` is set, a
 * worker that starts says ready only at releaseStart().
 */
export function scriptedTransport(handler?: Handler) {
  let starting: {
    proven: Promise<boolean | null>;
    settle: (ready: boolean | null) => void;
  } | null = null;
  // A worker still starting stops, as the sandboxed transport's does: no proof, and no failure.
  const stopStarting = () => {
    const stopped = starting;
    starting = null;
    stopped?.settle(null);
  };
  const cutParked = () => {
    const cut = transport.parked;
    transport.parked = [];
    for (const p of cut) p.cut();
  };
  const transport = {
    requests: [] as FetchRequest[],
    credentials: null as AlpacaKey | null,
    started: false,
    handler,
    holding: null as ((request: FetchRequest) => boolean) | null,
    parked: [] as { request: FetchRequest; deliver: () => void; cut: () => void }[],
    slowStart: false,
    /** Delivers the held answers that match, oldest first, and says how many. */
    release(match: (request: FetchRequest) => boolean = () => true): number {
      const due = transport.parked.filter((p) => match(p.request));
      transport.parked = transport.parked.filter((p) => !match(p.request));
      for (const p of due) p.deliver();
      return due.length;
    },
    /** The worker that is starting says ready. */
    releaseStart(): void {
      const proven = starting;
      starting = null;
      proven?.settle(true);
    },
    // Fetches don't wait for a start: the supervisor only fetches once ready() says true.
    ready(): Promise<boolean | null> {
      if (starting) return starting.proven;
      const fresh = !transport.started;
      transport.started = true;
      if (!fresh || !transport.slowStart) return Promise.resolve(true);
      let settle: (ready: boolean | null) => void = () => undefined;
      const proven = new Promise<boolean | null>((resolve) => (settle = resolve));
      starting = { proven, settle };
      return proven;
    },
    async fetch(request: FetchRequest): Promise<FetchResult> {
      transport.started = true;
      transport.requests.push(request);
      const offline: FetchResult = { ok: false, error: 'network' };
      const answer = Promise.resolve(transport.handler ? transport.handler(request) : offline);
      if (!transport.holding?.(request)) return answer;
      return new Promise((resolve) =>
        transport.parked.push({
          request,
          deliver: () => void answer.then(resolve),
          cut: () => resolve({ ok: false, error: 'timeout' }),
        }),
      );
    },
    // Like the sandboxed transport, clearing the key retires the worker: requests in flight still
    // get their answers, the next request starts a fresh worker, and a worker still starting stops.
    setCredentials(key: AlpacaKey | null) {
      transport.credentials = key;
      if (key !== null || !transport.started) return;
      transport.started = false;
      stopStarting();
    },
    // Like the sandboxed transport, stopping answers every request still out with a timeout.
    stop() {
      transport.started = false;
      stopStarting();
      cutParked();
    },
  };
  return transport satisfies FeedTransport;
}

/** Session bar times, oldest first, from `from` to `to` inclusive. */
function sessionTimes(from: number, to: number, calendar: MarketCalendar): number[] {
  const times: number[] = [];
  for (let time = Math.ceil(from / BAR_MS) * BAR_MS; time <= to; time += BAR_MS)
    if (isSessionBar(time, calendar)) times.push(time);
  return times;
}

/** `count` session bar times ending at `last`, oldest first, walking the calendar backward. */
export function timesEndingAt(last: number, count: number, calendar: MarketCalendar): number[] {
  if (!isSessionBar(last, calendar)) throw new Error('timesEndingAt: not a session bar');
  const times = [last];
  for (let time = last - BAR_MS; times.length < count; time -= BAR_MS)
    if (isSessionBar(time, calendar)) times.push(time);
  return times.reverse();
}

/** Bars at a constant close, which never cross, for times after the given ones. */
export function flatAfter(bars: FeedBar[], count: number, calendar: MarketCalendar): FeedBar[] {
  const last = bars.at(-1)!;
  const out: FeedBar[] = [];
  for (let time = Date.parse(last.time) + BAR_MS; out.length < count; time += BAR_MS)
    if (isSessionBar(time, calendar))
      out.push({ symbol: last.symbol, time: iso(time), closeMinor: last.closeMinor, volume: 10 });
  return out;
}

/**
 * A provider that answers bars and prices from the bars it holds, up to and including the
 * forming one. A symbol given no bars holds a constant close at every session bar, which never
 * produces a setup.
 */
export function providerWorld(clock: Clock) {
  const series = new Map<string, FeedBar[]>();
  const held = (symbol: string, from: number, to: number): FeedBar[] => {
    const explicit = series.get(symbol);
    if (explicit)
      return explicit.filter((b) => Date.parse(b.time) >= from && Date.parse(b.time) <= to);
    return sessionTimes(from, to, FEEDS[feedOf(symbol)].calendar).map((time) => ({
      symbol,
      time: iso(time),
      closeMinor: baseOf(symbol),
      volume: 10,
    }));
  };
  const world = {
    paused: new Set<string>(),
    noPrice: new Set<string>(),
    hidden: new Set<string>(), // `${symbol}|${time}` left out of bar responses
    prices: new Map<string, number>(), // a quote in minor units, instead of the forming close
    forming: 0, // added to the close of a bar still forming when it is asked for
    setBars(symbol: string, bars: FeedBar[]) {
      series.set(
        symbol,
        [...bars].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)),
      );
    },
    edit(symbol: string, time: string, change: Partial<FeedBar>) {
      series.set(
        symbol,
        series.get(symbol)!.map((b) => (b.time === time ? { ...b, ...change } : b)),
      );
    },
    handler(request: FetchRequest): FetchResult {
      const now = clock.now();
      if (request.kind === 'prices') {
        const prices = [];
        for (const symbol of request.symbols) {
          if (world.noPrice.has(symbol)) continue;
          const explicit = series.get(symbol);
          const priceMinor =
            world.prices.get(symbol) ??
            (explicit
              ? explicit.filter((b) => Date.parse(b.time) <= now).at(-1)?.closeMinor
              : baseOf(symbol));
          if (priceMinor === undefined) continue;
          prices.push({ symbol, priceMinor, paused: world.paused.has(symbol) });
        }
        return { ok: true, prices };
      }
      const bars: FeedBar[] = [];
      for (const symbol of request.symbols) {
        const from =
          request.start !== undefined
            ? Date.parse(request.start)
            : Math.floor(now / BAR_MS) * BAR_MS - ((request.limit ?? 4) - 1) * BAR_MS;
        let rows = held(symbol, from, now).filter((b) => !world.hidden.has(`${symbol}|${b.time}`));
        if (request.limit !== undefined) rows = rows.slice(-request.limit);
        for (const row of rows)
          bars.push(
            Date.parse(row.time) + BAR_MS > now
              ? { ...row, closeMinor: row.closeMinor + world.forming }
              : row,
          );
      }
      return { ok: true, bars };
    },
  };
  world.handler = world.handler.bind(world);
  return world;
}

/** Falling then rising closes, walking the calendar backward, whose last bar is a buy setup. */
export function seriesEndingInSetup(
  symbol: string,
  lastBarTime: number,
  calendar: MarketCalendar,
): FeedBar[] {
  const base = baseOf(symbol);
  const falling = 80;
  for (let rising = 1; rising <= 200; rising++) {
    const times = timesEndingAt(lastBarTime, falling + rising, calendar);
    const low = base * (1 - 0.002 * (falling - 1));
    const rows = times.map((time, i) => ({
      symbol,
      time: iso(time),
      closeMinor: Math.round(
        i < falling ? base * (1 - 0.002 * i) : low * (1 + 0.004 * (i - falling + 1)),
      ),
      volume: 10,
    }));
    const bars = mergeBars([], rows, feedOf(symbol), iso(lastBarTime + BAR_MS + SETTLE_MS)).bars;
    if (evaluate(bars).at(-1)?.state === 'Buy setup') return rows;
  }
  throw new Error('seriesEndingInSetup: no setup found');
}

export const TEST_KEY: AlpacaKey = { keyId: 'PKTESTKEY123456', secret: 'testsecret0987654321' };
// Wednesday 4 November 2026, 10:05 in New York: both markets open.
export const DEFAULT_START = '2026-11-04T15:05:00.000Z';

/** A profile set up and unlocked, and run() advances the clock in 5-second wakes. */
export function supervised(
  options: {
    start?: string;
    coinbase?: boolean;
    alpaca?: boolean;
    key?: AlpacaKey;
    handler?: Handler;
  } = {},
) {
  const p = profile();
  p.vault.setup(password);
  const clock = fakeClock(options.start ?? DEFAULT_START);
  const world = providerWorld(clock);
  const transport = scriptedTransport(options.handler ?? world.handler);
  // When each request went out, beside transport.requests.
  const calls: { at: string; feed: FeedName; kind: FetchRequest['kind'] }[] = [];
  const fetch = transport.fetch;
  transport.fetch = (request) => {
    calls.push({ at: iso(clock.now()), feed: request.feed, kind: request.kind });
    return fetch(request);
  };
  const now = new Date(clock.now());
  if (options.coinbase) p.vault.markets.setEnabled('coinbase', true, now);
  if (options.alpaca) {
    saveAlpacaKey(p.vault, options.key ?? TEST_KEY);
    p.vault.markets.setEnabled('alpaca', true, now);
  }
  const logs: string[] = [];
  const feeds = new FeedSupervisor({
    vault: p.vault,
    transport,
    now: clock.now,
    tickMs: 0,
    log: (line) => logs.push(line),
  });
  return {
    p,
    clock,
    transport,
    world,
    feeds,
    calls,
    logs,
    async run(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 5000) {
        clock.advance(5000);
        await feeds.tick();
      }
    },
    /**
     * Wakes every 5 seconds, or every `step` ms, until the clock reads `time`. Wakes up to 90
     * seconds apart aren't a sleep, so a longer step can cross a weekend quickly.
     */
    async until(time: string, step = 5000) {
      while (clock.now() < Date.parse(time)) {
        clock.advance(step);
        await feeds.tick();
      }
    },
    cleanup() {
      feeds.stop();
      p.cleanup();
    },
  };
}
