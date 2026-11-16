import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.ts';
import { alertId, mergeBars } from '../server/feedBars.ts';
import { loadAlpacaKey, saveAlpacaKey } from '../server/feedKeys.ts';
import { sandboxedTransport } from '../server/feedSandbox.ts';
import { FeedSupervisor } from '../server/feedSupervisor.ts';
import { MarketStore } from '../server/markets.ts';
import { evaluate, marketFixtures, ruleOverview, setupOutcomes } from '../server/replay.ts';
import { shutdown } from '../server/shutdown.ts';
import { AppError } from '../server/vault.ts';
import {
  FEEDS,
  type AlpacaKey,
  type FeedBar,
  type FeedName,
  type FetchError,
  type FetchRequest,
  type FetchResult,
  type MarketAlert,
  type MarketSource,
} from '../shared/feedSchema.ts';
import { rowLabel } from '../shared/feedViews.ts';
import { instruments, type Bar } from '../shared/fixtures.ts';
import { dumpMarkets, password, profile } from './helpers.ts';
import {
  DEFAULT_START,
  TEST_KEY,
  fakeClock,
  feedOf,
  flatAfter,
  seriesEndingInSetup,
  settle,
  supervised,
  timesEndingAt,
} from './feedHelpers.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const MIN = 60_000,
  HOUR = 3_600_000,
  DAY = 86_400_000,
  BAR = 900_000;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse(DEFAULT_START); // Wednesday 15:05Z, 10:05 in New York
const SETUP = Date.parse('2026-11-04T15:00:00.000Z'); // closes 15:15:00
const SETTLED = '2026-11-04T15:15:30.000Z'; // 30 seconds after that close
const CORRECTED = 'This bar was corrected after it was first evaluated: warm-up restarted.';

type Scenario = ReturnType<typeof supervised>;
async function scenario(
  options: Parameters<typeof supervised>[0],
  body: (s: Scenario) => Promise<void>,
) {
  const s = supervised(options);
  try {
    await body(s);
  } finally {
    s.cleanup();
  }
}
type Snapshot = ReturnType<FeedSupervisor['snapshot']>;
const rowOf = (snap: Snapshot, symbol: string) =>
  snap.instruments.find((i) => i.symbol === symbol)!;
const statusOf = (snap: Snapshot, feed: FeedName) => snap.feeds.find((f) => f.feed === feed)!;
const row = (s: Scenario, symbol: string) => rowOf(s.feeds.snapshot(), symbol);
const status = (s: Scenario, feed: FeedName) => statusOf(s.feeds.snapshot(), feed);
const alerts = (s: Scenario) => s.feeds.snapshot().alerts;
const events = (s: Scenario) => (s.p.vault.events() as { action: string }[]).map((e) => e.action);
const callTimes = (s: Scenario, feed: FeedName, kind: FetchRequest['kind']) =>
  s.calls.filter((c) => c.feed === feed && c.kind === kind).map((c) => c.at);
// Minutes after T0 at which any request went out.
const wakes = (s: Scenario) => [...new Set(s.calls.map((c) => (Date.parse(c.at) - T0) / MIN))];
const live = (instrument: { source: MarketSource }) => {
  assert.equal(instrument.source.kind, 'live');
  return instrument.source as Extract<MarketSource, { kind: 'live' }>;
};
const OTHER_KEY: AlpacaKey = { keyId: 'PKOTHERKEY12345', secret: 'othersecret1234567' };
const BUSY = 'AllIn is already checking an Alpaca key.',
  CHANGED = 'Alpaca was changed while the key was being checked. Try again.';
const offline = (): FetchResult => ({ ok: false, error: 'network' });
const rejectsWith = (status: number, message: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.message === message;
// The same closes reflected about the first, so the last bar is a sell setup.
const mirrored = (rows: FeedBar[]) =>
  rows.map((r) => ({ ...r, closeMinor: 2 * rows[0].closeMinor - r.closeMinor }));
const setupWorld = (s: Scenario, symbol = 'BTC-USD', time = SETUP) => {
  const series = seriesEndingInSetup(symbol, time, FEEDS[feedOf(symbol)].calendar);
  s.world.setBars(symbol, series);
  return series;
};

// Off and on

test('with both feeds off, the transport is never used', () =>
  scenario({}, async (s) => {
    await s.feeds.tick();
    await s.run(HOUR);
    assert.equal(s.transport.started, false);
    assert.deepEqual(s.transport.requests, []);
    const snap = s.feeds.snapshot();
    assert.ok(snap.instruments.every((i) => i.source.kind === 'replay'));
    assert.deepEqual(
      snap.feeds.map((f) => [f.feed, f.enabled, f.state]),
      [
        ['coinbase', false, 'off'],
        ['alpaca', false, 'off'],
      ],
    );
    assert.equal(s.transport.started, false);
  }));

test('a feed saved as on starts at the first unlock, and not before', () =>
  scenario({ coinbase: true }, async (s) => {
    s.p.vault.lock();
    await s.feeds.tick();
    await s.run(10 * MIN);
    assert.equal(s.transport.started, false);
    assert.deepEqual(s.transport.requests, []);
    s.p.vault.unlock(password);
    await s.run(5000);
    assert.deepEqual(s.calls.map((c) => [c.at, c.feed, c.kind]).sort(), [
      ['2026-11-04T15:15:05.000Z', 'coinbase', 'bars'],
      ['2026-11-04T15:15:05.000Z', 'coinbase', 'prices'],
    ]);
    assert.equal(status(s, 'coinbase').state, 'live');
  }));

test('turning a feed on catches up, then reads live, and raises no alert from history', () =>
  scenario({}, async (s) => {
    const past = SETUP - BAR; // closed at 15:00, before the clock starts
    setupWorld(s, 'BTC-USD', past);
    s.feeds.setCoinbase(true);
    assert.equal(status(s, 'coinbase').state, 'catching-up');
    await s.feeds.tick();
    assert.deepEqual(
      s.transport.requests.find((r) => r.kind === 'bars'),
      { feed: 'coinbase', kind: 'bars', symbols: ['BTC-USD', 'ETH-USD'], limit: 350 },
    );
    assert.equal(status(s, 'coinbase').state, 'live');
    const last = row(s, 'BTC-USD').decisions.at(-1)!;
    assert.deepEqual([last.time, last.state], [iso(past), 'Buy setup']);
    assert.deepEqual(alerts(s), []);
    await s.run(5 * MIN);
    assert.deepEqual(alerts(s), []);
    assert.deepEqual(dumpMarkets(s.p.vault).market_alerts, []);
    assert.ok(events(s).includes('feed.on'));
  }));

// M4: alerts

test('an on-time bar with a setup raises one alert', () =>
  scenario({ coinbase: true }, async (s) => {
    const series = setupWorld(s);
    await s.feeds.tick();
    await s.until('2026-11-04T15:15:25.000Z');
    assert.deepEqual(alerts(s), []);
    await s.run(5000);
    const snap = s.feeds.snapshot();
    const decision = rowOf(snap, 'BTC-USD').decisions.at(-1)!;
    assert.deepEqual([decision.time, decision.state], [iso(SETUP), 'Buy setup']);
    assert.deepEqual(snap.alerts, [
      {
        id: alertId(decision),
        symbol: 'BTC-USD',
        time: iso(SETUP),
        state: 'Buy setup',
        provider: 'Coinbase',
        venue: 'Coinbase',
        closeMinor: series.at(-1)!.closeMinor,
        fast: decision.fast,
        slow: decision.slow,
        reason: 'EMA20 crossed above EMA50 on a closed bar.',
        ruleVersion: 'ema-20-50/v3',
        alertedAt: SETTLED,
        dismissedAt: null,
        correctedAt: null,
      },
    ]);
    assert.equal(dumpMarkets(s.p.vault).market_alerts.length, 1);
  }));

test('a real 78-character alert id is saved and read back', () =>
  scenario({}, async (s) => {
    const series = mirrored(seriesEndingInSetup('BTC-USD', SETUP, 'continuous'));
    const decision = evaluate(mergeBars([], series, 'coinbase', SETTLED).bars).at(-1)!;
    assert.equal(decision.state, 'Sell setup');
    const id = alertId(decision);
    assert.equal(id, `Coinbase:Coinbase:BTC-USD:15m:${iso(SETUP)}:Sell setup:ema-20-50/v3`);
    assert.equal(id.length, 78);
    const alert: MarketAlert = {
      id,
      symbol: 'BTC-USD',
      time: decision.time,
      state: 'Sell setup',
      provider: 'Coinbase',
      venue: 'Coinbase',
      closeMinor: decision.closeMinor,
      fast: decision.fast!,
      slow: decision.slow!,
      reason: decision.reason,
      ruleVersion: decision.version,
      alertedAt: SETTLED,
      dismissedAt: null,
      correctedAt: null,
    };
    s.p.vault.markets.saveBatch({ bars: [], alerts: [alert], corrections: [] });
    assert.deepEqual(s.p.vault.markets.alerts(), [alert]);
  }));

test('an alert with a 78-character id is dismissed by id', () =>
  scenario({ coinbase: true }, async (s) => {
    s.world.setBars('BTC-USD', mirrored(seriesEndingInSetup('BTC-USD', SETUP, 'continuous')));
    await s.feeds.tick();
    await s.until(SETTLED);
    const [alert] = alerts(s);
    assert.deepEqual(
      [alert.state, alert.reason, alert.id.length],
      ['Sell setup', 'EMA20 crossed below EMA50 on a closed bar.', 78],
    );
    s.feeds.dismiss({ id: alert.id });
    // Still listed while its bar is inside the 80-bar window, so the journal can label it.
    assert.deepEqual(alerts(s), [{ ...alert, dismissedAt: SETTLED }]);
    s.feeds.setCoinbase(false);
    assert.deepEqual(alerts(s), []);
  }));

test('a repeated poll of the same bar raises no second alert', () =>
  scenario({ coinbase: true }, async (s) => {
    const series = seriesEndingInSetup('BTC-USD', SETUP, 'continuous');
    s.world.setBars('BTC-USD', [...series, ...flatAfter(series, 4, 'continuous')]);
    await s.feeds.tick();
    await s.until(SETTLED);
    assert.equal(alerts(s).length, 1);
    const bars = () => s.transport.requests.filter((r) => r.kind === 'bars').length;
    const before = bars();
    // The next two closes ask for 4 bars, which includes the setup bar again.
    await s.until('2026-11-04T15:45:30.000Z');
    // A sleep: the catch-up reads it once more.
    s.clock.advance(2 * MIN);
    await s.feeds.tick();
    assert.equal(bars(), before + 3);
    const [alert, ...rest] = alerts(s);
    assert.deepEqual(rest, []);
    assert.equal(alert.alertedAt, SETTLED);
    assert.equal(dumpMarkets(s.p.vault).market_alerts.length, 1);
  }));

// The last wake before the gap, then one wake at 15:15:35, 35 seconds after the close.
async function wakeAfterGap(s: Scenario, gap: number) {
  setupWorld(s);
  await s.feeds.tick();
  await s.until(iso(Date.parse(SETTLED) + 5000 - gap));
  s.clock.advance(gap);
  await s.feeds.tick();
  assert.equal(row(s, 'BTC-USD').decisions.at(-1)!.state, 'Buy setup');
  assert.equal(status(s, 'coinbase').state, 'live');
}

test('after a detected sleep, setups found while catching up are historical', () =>
  scenario({ coinbase: true }, async (s) => {
    await wakeAfterGap(s, 95_000); // wakes over 90 s apart
    assert.deepEqual(alerts(s), []);
  }));

test('wakes exactly 90 seconds apart are not a sleep', () =>
  scenario({ coinbase: true }, async (s) => {
    await wakeAfterGap(s, 90_000);
    assert.deepEqual(
      alerts(s).map((a) => a.alertedAt),
      ['2026-11-04T15:15:35.000Z'],
    );
  }));

test('after a failed poll, a setup on the next bar is historical until reconciled', () =>
  scenario({ coinbase: true }, async (s) => {
    setupWorld(s, 'BTC-USD', SETUP);
    setupWorld(s, 'ETH-USD', SETUP + BAR); // a second setup, on the bar after
    await s.feeds.tick();
    await s.until('2026-11-04T15:15:25.000Z');
    s.transport.handler = (r) => (r.kind === 'bars' ? offline() : s.world.handler(r));
    await s.run(5000); // the 15:15:30 bar poll fails
    assert.equal(status(s, 'coinbase').state, 'stale');
    s.transport.handler = s.world.handler;
    await s.until('2026-11-04T15:16:30.000Z'); // the retry catches up
    assert.equal(status(s, 'coinbase').state, 'live');
    assert.equal(row(s, 'BTC-USD').decisions.at(-1)!.state, 'Buy setup');
    assert.deepEqual(alerts(s), []);
    // Reconciled now, so the setup on the next bar is live.
    await s.until('2026-11-04T15:30:30.000Z');
    assert.deepEqual(
      alerts(s).map((a) => [a.symbol, a.time]),
      [['ETH-USD', iso(SETUP + BAR)]],
    );
  }));

test('a bar arriving over 5 minutes late is historical', () =>
  scenario({ coinbase: true }, async (s) => {
    setupWorld(s);
    s.world.hidden.add(`BTC-USD|${iso(SETUP)}`);
    await s.feeds.tick();
    await s.until('2026-11-04T15:20:25.000Z');
    s.world.hidden.clear();
    await s.run(5000); // 15:20:30, five and a half minutes after the close
    assert.deepEqual(
      callTimes(s, 'coinbase', 'bars').map((at) => at.slice(11, 19)),
      ['15:05:00', '15:15:30', '15:16:30', '15:17:30', '15:18:30', '15:19:30', '15:20:30'],
    );
    assert.deepEqual(
      [row(s, 'BTC-USD').decisions.at(-1)!.time, row(s, 'BTC-USD').decisions.at(-1)!.state],
      [iso(SETUP), 'Buy setup'],
    );
    assert.deepEqual(alerts(s), []);
    assert.equal(status(s, 'coinbase').state, 'live');
  }));

test('stale data suppresses alerts', () =>
  scenario({ alpaca: true }, async (s) => {
    setupWorld(s, 'AAPL');
    setupWorld(s, 'NVDA');
    s.world.noPrice.add('AAPL'); // Alpaca has no latest trade for it, so its price never arrives
    await s.feeds.tick();
    await s.until(SETTLED);
    const snap = s.feeds.snapshot();
    assert.deepEqual(
      snap.alerts.map((a) => a.symbol),
      ['NVDA'],
    );
    assert.equal(live(rowOf(snap, 'AAPL')).state, 'stale');
    assert.equal(live(rowOf(snap, 'NVDA')).state, 'live');
    assert.equal(rowOf(snap, 'AAPL').decisions.at(-1)!.state, 'Buy setup');
  }));

// Timing

test('prices poll every 60 seconds, and bars 30 seconds after each close', () =>
  scenario({ coinbase: true, alpaca: true }, async (s) => {
    await s.feeds.tick();
    await s.until('2026-11-04T15:50:00.000Z');
    for (const feed of ['coinbase', 'alpaca'] as const) {
      assert.deepEqual(
        callTimes(s, feed, 'prices'),
        Array.from({ length: 46 }, (_, i) => iso(T0 + i * MIN)),
      );
      assert.deepEqual(callTimes(s, feed, 'bars'), [
        '2026-11-04T15:05:00.000Z',
        '2026-11-04T15:15:30.000Z',
        '2026-11-04T15:30:30.000Z',
        '2026-11-04T15:45:30.000Z',
      ]);
    }
    const bars = (feed: FeedName) =>
      s.transport.requests.filter((r) => r.feed === feed && r.kind === 'bars') as Extract<
        FetchRequest,
        { kind: 'bars' }
      >[];
    assert.deepEqual(
      bars('coinbase').map((r) => r.limit),
      [350, 4, 4, 4],
    );
    assert.deepEqual(
      bars('alpaca').map((r) => r.start),
      [
        iso(T0 - 14 * DAY),
        '2026-11-04T14:15:00.000Z',
        '2026-11-04T14:30:00.000Z',
        '2026-11-04T14:45:00.000Z',
      ],
    );
  }));

test('a bar missing from a successful response is retried each minute, then becomes a gap at 5 minutes', () =>
  scenario({ coinbase: true }, async (s) => {
    s.world.hidden.add(`BTC-USD|${iso(SETUP)}`);
    await s.feeds.tick();
    const states = new Set<string>();
    while (s.clock.now() < Date.parse('2026-11-04T15:45:30.000Z')) {
      await s.run(5000);
      states.add(status(s, 'coinbase').state);
    }
    // The feed stays live throughout.
    assert.deepEqual([...states], ['live']);
    assert.deepEqual(
      callTimes(s, 'coinbase', 'bars').map((at) => at.slice(11, 19)),
      [
        '15:05:00',
        '15:15:30',
        '15:16:30',
        '15:17:30',
        '15:18:30',
        '15:19:30',
        '15:20:30',
        '15:30:30',
        '15:45:30',
      ],
    );
    const decisions = row(s, 'BTC-USD').decisions;
    const at = (time: number) => decisions.find((d) => d.time === iso(time))!;
    assert.equal(
      decisions.some((d) => d.time === iso(SETUP)),
      false,
    );
    assert.equal(
      at(SETUP + BAR).reason,
      'An expected bar is missing or the data source changed: warm-up restarted.',
    );
    assert.equal(at(SETUP + 2 * BAR).reason, 'Warm-up: 2/50 closed bars.');
  }));

test('a late bar inside 5 minutes still alerts', () =>
  scenario({ coinbase: true }, async (s) => {
    setupWorld(s);
    s.world.hidden.add(`BTC-USD|${iso(SETUP)}`);
    await s.feeds.tick();
    await s.until('2026-11-04T15:19:25.000Z');
    s.world.hidden.clear();
    await s.run(5000); // 15:19:30, four and a half minutes after the close
    assert.deepEqual(
      alerts(s).map((a) => [a.time, a.alertedAt]),
      [[iso(SETUP), '2026-11-04T15:19:30.000Z']],
    );
  }));

// A constant close at every bar up to `last`, and none after: the provider stops sending bars.
const flatUntil = (symbol: string, last: number): FeedBar[] => {
  const base = instruments.find((i) => i.symbol === symbol)!.base;
  return timesEndingAt(last, 360, FEEDS[feedOf(symbol)].calendar).map((time) => ({
    symbol,
    time: iso(time),
    closeMinor: base,
    volume: 10,
  }));
};

test("answers that succeed while a symbol's bars stop: 3 missing stay live, a 4th reads stale from the newest bar", () =>
  scenario({ coinbase: true }, async (s) => {
    s.world.setBars('BTC-USD', flatUntil('BTC-USD', SETUP)); // the 15:00 bar is the last
    await s.feeds.tick();
    await s.until('2026-11-04T16:15:25.000Z'); // 15:15, 15:30, and 15:45 are missing: gaps
    assert.equal(live(row(s, 'BTC-USD')).state, 'live');
    assert.equal(status(s, 'coinbase').state, 'live');
    await s.run(5000); // 16:15:30: the 16:00 bar has settled, and is missing too
    const btc = live(row(s, 'BTC-USD'));
    assert.deepEqual([btc.state, btc.lastUpdate], ['stale', iso(SETUP)]);
    assert.equal(status(s, 'coinbase').state, 'stale');
    // The answers still succeed, so the feed's own last update stays recent.
    assert.ok(Date.parse(status(s, 'coinbase').lastUpdate!) >= s.clock.now() - MIN);
    assert.deepEqual(s.logs, []);
    // Three hours on, it still reads stale, keyed to the newest bar, and keeps asking each minute.
    const asked = callTimes(s, 'coinbase', 'bars').length;
    await s.run(3 * HOUR);
    assert.equal(
      rowLabel(live(row(s, 'BTC-USD')), s.clock.now()),
      'Stale · last update 4 hr ago · signals paused',
    );
    assert.equal(callTimes(s, 'coinbase', 'bars').length - asked, 180);
    // The feed stays unreconciled, so its other symbol's signals are paused too.
    assert.equal(live(row(s, 'ETH-USD')).state, 'catching-up');
    // Bars coming back read live again.
    s.world.setBars('BTC-USD', flatUntil('BTC-USD', Date.parse('2026-11-05T12:00:00.000Z')));
    await s.run(MIN);
    assert.equal(live(row(s, 'BTC-USD')).state, 'live');
    assert.equal(status(s, 'coinbase').state, 'live');
    assert.deepEqual(alerts(s), []);
  }));

test("while a symbol's bars are stopped, a setup on the feed's other symbol raises no alert", () =>
  scenario({ coinbase: true }, async (s) => {
    s.world.setBars('BTC-USD', flatUntil('BTC-USD', SETUP - 6 * BAR)); // 5 bars behind at the start
    const series = setupWorld(s, 'ETH-USD');
    s.world.setBars('ETH-USD', [...series, ...flatAfter(series, 20, 'continuous')]);
    await s.feeds.tick();
    await s.until(iso(Date.parse(SETTLED) + MIN));
    const setup = row(s, 'ETH-USD').decisions.find((d) => d.time === iso(SETUP));
    assert.equal(setup?.state, 'Buy setup');
    assert.deepEqual(alerts(s), []);
    assert.equal(live(row(s, 'BTC-USD')).state, 'stale');
  }));

// Stocks (Review Focus 3)

test('on a weekend, stocks read closed, poll no prices, and request no bars after catching up', () =>
  scenario({ alpaca: true, start: '2026-11-07T17:00:00.000Z' }, async (s) => {
    await s.feeds.tick();
    await s.run(HOUR);
    assert.deepEqual(s.calls, [{ at: '2026-11-07T17:00:00.000Z', feed: 'alpaca', kind: 'bars' }]);
    const snap = s.feeds.snapshot();
    assert.equal(statusOf(snap, 'alpaca').state, 'closed');
    assert.equal(statusOf(snap, 'alpaca').lastBarAt, '2026-11-06T20:45:00.000Z');
    const aapl = rowOf(snap, 'AAPL');
    assert.deepEqual(
      [live(aapl).state, live(aapl).lastBarAt],
      ['closed', '2026-11-06T20:45:00.000Z'],
    );
    assert.equal(aapl.price, 226.5); // the last close
  }));

test("Monday's first bar after Friday's last raises a live alert, not a gap", () =>
  scenario({ alpaca: true, start: '2026-11-09T14:00:00.000Z' }, async (s) => {
    const monday = Date.parse('2026-11-09T14:30:00.000Z'); // 9:30 in New York
    const series = setupWorld(s, 'AAPL', monday);
    assert.equal(series.at(-2)!.time, '2026-11-06T20:45:00.000Z'); // Friday's last bar
    await s.feeds.tick();
    assert.equal(status(s, 'alpaca').state, 'closed');
    await s.until('2026-11-09T14:45:30.000Z');
    assert.equal(callTimes(s, 'alpaca', 'prices')[0], '2026-11-09T14:30:00.000Z');
    assert.deepEqual(
      alerts(s).map((a) => [a.symbol, a.time, a.alertedAt]),
      [['AAPL', iso(monday), '2026-11-09T14:45:30.000Z']],
    );
    const decisions = row(s, 'AAPL').decisions;
    assert.equal(decisions.at(-1)!.reason, 'EMA20 crossed above EMA50 on a closed bar.');
    assert.equal(decisions.at(-2)!.time, '2026-11-06T20:45:00.000Z');
  }));

test('the first bar after a holiday raises a live alert', () =>
  scenario({ alpaca: true, start: '2026-11-27T14:00:00.000Z' }, async (s) => {
    const friday = Date.parse('2026-11-27T14:30:00.000Z'); // the day after Thanksgiving
    const series = setupWorld(s, 'AAPL', friday);
    assert.equal(series.at(-2)!.time, '2026-11-25T20:45:00.000Z'); // Wednesday's last bar
    await s.feeds.tick();
    await s.until('2026-11-27T14:45:30.000Z');
    assert.deepEqual(
      alerts(s).map((a) => [a.symbol, a.time, a.alertedAt]),
      [['AAPL', iso(friday), '2026-11-27T14:45:30.000Z']],
    );
  }));

test("a setup on a session's last bar raises a live alert", async () => {
  const last = Date.parse('2026-11-04T20:45:00.000Z'); // 15:45 to 16:00 in New York
  for (const arrives of ['2026-11-04T21:00:30.000Z', '2026-11-04T21:04:30.000Z'])
    await scenario({ alpaca: true, start: '2026-11-04T20:30:00.000Z' }, async (s) => {
      setupWorld(s, 'AAPL', last);
      s.world.hidden.add(`AAPL|${iso(last)}`);
      await s.feeds.tick();
      await s.until(iso(Date.parse(arrives) - 5000));
      s.world.hidden.clear();
      await s.run(5000);
      const snap = s.feeds.snapshot();
      // The market has closed, and prices stopped with it, by the time the bar arrives.
      assert.equal(live(rowOf(snap, 'AAPL')).state, 'closed');
      assert.equal(callTimes(s, 'alpaca', 'prices').at(-1), '2026-11-04T20:59:00.000Z');
      assert.deepEqual(
        snap.alerts.map((a) => [a.symbol, a.time, a.alertedAt]),
        [['AAPL', iso(last), arrives]],
        arrives,
      );
    });
});

test('a setup whose previous bar arrived in the same poll is historical', () =>
  scenario({ coinbase: true }, async (s) => {
    const next = SETUP + BAR;
    setupWorld(s, 'BTC-USD', next);
    s.world.hidden.add(`BTC-USD|${iso(SETUP)}`); // missing, so a gap from 15:20:30
    await s.feeds.tick();
    await s.until('2026-11-04T15:30:25.000Z');
    s.world.hidden.clear(); // the provider fills it in, and sends it with the next bar
    await s.run(5000);
    const last = row(s, 'BTC-USD').decisions.at(-1)!;
    assert.deepEqual([last.time, last.state], [iso(next), 'Buy setup']);
    assert.equal(status(s, 'coinbase').state, 'live');
    assert.deepEqual(alerts(s), []);
  }));

test('an early close: no bars are expected after it', () =>
  scenario({ alpaca: true, start: '2026-11-27T17:40:00.000Z' }, async (s) => {
    // The day after Thanksgiving closes at 13:00 in New York, 18:00Z.
    await s.feeds.tick();
    await s.until('2026-11-27T19:30:00.000Z');
    assert.deepEqual(callTimes(s, 'alpaca', 'bars'), [
      '2026-11-27T17:40:00.000Z',
      '2026-11-27T17:45:30.000Z',
      '2026-11-27T18:00:30.000Z',
    ]);
    const prices = callTimes(s, 'alpaca', 'prices');
    assert.equal(prices.length, 20);
    assert.equal(prices.at(-1), '2026-11-27T17:59:00.000Z');
    assert.equal(status(s, 'alpaca').state, 'closed');
    assert.equal(status(s, 'alpaca').lastBarAt, '2026-11-27T17:45:00.000Z');
  }));

test("the reviewer's probe: a stock whose bars stop before the close makes one bar request after the last bar settles, then none until Monday's first bar is due", () =>
  scenario({ alpaca: true, start: '2026-11-06T20:50:00.000Z' }, async (s) => {
    // Friday 15:50 in New York. NVDA's bars end at 13:45; AAPL and MSFT run to the close.
    const stop = Date.parse('2026-11-06T18:45:00.000Z');
    s.world.setBars('NVDA', flatUntil('NVDA', stop));
    const monday = Date.parse('2026-11-09T14:30:00.000Z'); // 9:30 in New York
    setupWorld(s, 'AAPL', monday); // a setup on Monday's first bar
    await s.feeds.tick();
    await s.until('2026-11-06T20:59:00.000Z');
    const stale = () => {
      const nvda = live(row(s, 'NVDA'));
      assert.deepEqual([nvda.state, nvda.lastUpdate], ['stale', iso(stop)]);
    };
    stale(); // the market is open, and NVDA is more than 3 bars behind
    await s.until('2026-11-06T21:01:00.000Z'); // 16:01, after the last bar's request
    // A wake each minute from here keeps the test quick. A bar request that came due would still
    // go out within the minute.
    await s.until('2026-11-07T21:00:00.000Z', MIN); // Saturday 16:00 in New York
    const nvda = live(row(s, 'NVDA'));
    assert.deepEqual(
      [nvda.state, nvda.lastUpdate, nvda.lastBarAt],
      ['closed', iso(stop), iso(stop)],
    );
    await s.until('2026-11-09T14:40:00.000Z', MIN); // Monday 9:40: open, with no new bar due yet
    stale();
    // Prices start again at the open.
    assert.equal(
      callTimes(s, 'alpaca', 'prices').find((at) => at >= '2026-11-09'),
      '2026-11-09T14:30:00.000Z',
    );
    await s.until('2026-11-09T14:45:30.000Z'); // Monday's first bar has settled
    assert.deepEqual(
      callTimes(s, 'alpaca', 'bars').filter((at) => at >= '2026-11-06T21:00:30.000Z'),
      ['2026-11-06T21:00:30.000Z', '2026-11-09T14:45:30.000Z'],
    );
    stale(); // NVDA's bars are still stopped, so nothing alerts
    assert.deepEqual(alerts(s), []);
    assert.deepEqual(s.logs, []);
  }));

test('with bars stopped after the close, a missing last bar, a detected sleep, and a failure are still asked about', () =>
  scenario({ alpaca: true, start: '2026-11-06T20:50:00.000Z' }, async (s) => {
    s.world.setBars('NVDA', flatUntil('NVDA', Date.parse('2026-11-06T18:45:00.000Z')));
    s.world.hidden.add('AAPL|2026-11-06T20:45:00.000Z'); // Friday's last bar, missing at first
    const since = (time: string) => callTimes(s, 'alpaca', 'bars').filter((at) => at >= time);
    await s.feeds.tick();
    await s.until('2026-11-06T21:10:00.000Z');
    // The missing last bar is asked for each minute until it is 5 minutes late, then a gap.
    assert.deepEqual(since('2026-11-06T21:00:30.000Z'), [
      '2026-11-06T21:00:30.000Z',
      '2026-11-06T21:01:30.000Z',
      '2026-11-06T21:02:30.000Z',
      '2026-11-06T21:03:30.000Z',
      '2026-11-06T21:04:30.000Z',
      '2026-11-06T21:05:30.000Z',
    ]);
    await s.until('2026-11-07T01:00:00.000Z', MIN);
    assert.deepEqual(since('2026-11-06T21:06:00.000Z'), []);
    // A detected sleep catches up once.
    s.clock.advance(2 * HOUR);
    await s.feeds.tick();
    await s.until('2026-11-07T04:00:00.000Z', MIN);
    assert.deepEqual(since('2026-11-07T01:00:00.000Z'), ['2026-11-07T03:00:00.000Z']);
    // A failure is retried on the backoff, until an answer succeeds.
    s.transport.handler = offline;
    s.clock.advance(2 * HOUR);
    await s.feeds.tick();
    await s.until('2026-11-07T06:14:00.000Z', MIN);
    s.transport.handler = s.world.handler;
    await s.until('2026-11-07T08:00:00.000Z', MIN);
    assert.deepEqual(since('2026-11-07T04:00:00.000Z'), [
      '2026-11-07T06:00:00.000Z',
      '2026-11-07T06:01:00.000Z',
      '2026-11-07T06:03:00.000Z',
      '2026-11-07T06:07:00.000Z',
      '2026-11-07T06:15:00.000Z',
    ]);
    assert.equal(live(row(s, 'NVDA')).state, 'closed');
    assert.deepEqual(alerts(s), []);
  }));

test('with bars stopped, a holiday and an early close each end with one bar request, and the next session asks again', () =>
  scenario({ alpaca: true, start: '2026-11-25T20:50:00.000Z' }, async (s) => {
    // Wednesday 15:50 in New York, before Thanksgiving. NVDA's bars end at 13:45.
    s.world.setBars('NVDA', flatUntil('NVDA', Date.parse('2026-11-25T18:45:00.000Z')));
    await s.feeds.tick();
    await s.until('2026-11-25T21:01:00.000Z');
    await s.until('2026-11-27T14:45:00.000Z', MIN); // Thursday is a holiday
    await s.until('2026-11-27T18:01:00.000Z'); // Friday closes at 13:00 in New York
    await s.until('2026-11-30T14:45:00.000Z', MIN);
    await s.until('2026-11-30T14:45:30.000Z');
    // Outside Friday's session, where NVDA's bars are still asked for each minute.
    const friday = (at: string) =>
      at > '2026-11-27T14:45:30.000Z' && at < '2026-11-27T18:00:30.000Z';
    assert.deepEqual(
      callTimes(s, 'alpaca', 'bars').filter(
        (at) => at >= '2026-11-25T21:00:30.000Z' && !friday(at),
      ),
      [
        '2026-11-25T21:00:30.000Z',
        '2026-11-27T14:45:30.000Z',
        '2026-11-27T18:00:30.000Z',
        '2026-11-30T14:45:30.000Z',
      ],
    );
    assert.ok(callTimes(s, 'alpaca', 'bars').filter(friday).length > 100);
    assert.deepEqual(alerts(s), []);
  }));

test('past calendar coverage reads failing with reason calendar, and no signals', () =>
  scenario({ alpaca: true, start: '2029-01-03T15:00:00.000Z' }, async (s) => {
    await s.feeds.tick();
    await s.run(30 * MIN);
    assert.deepEqual(s.transport.requests, []);
    const snap = s.feeds.snapshot();
    assert.deepEqual(
      [statusOf(snap, 'alpaca').state, statusOf(snap, 'alpaca').failure],
      ['failing', 'calendar'],
    );
    const aapl = live(rowOf(snap, 'AAPL'));
    assert.deepEqual([aapl.state, aapl.reason], ['failing', 'calendar']);
    assert.deepEqual(snap.alerts, []);
  }));

// Corrections

test("a changed close saves a revision, restarts warm-up, and marks the bar's alert corrected", () =>
  scenario({ coinbase: true }, async (s) => {
    const series = seriesEndingInSetup('BTC-USD', SETUP, 'continuous');
    const close = series.at(-1)!.closeMinor;
    s.world.setBars('BTC-USD', [...series, ...flatAfter(series, 2, 'continuous')]);
    await s.feeds.tick();
    await s.until(SETTLED);
    const [alert] = alerts(s);
    s.world.edit('BTC-USD', iso(SETUP), { closeMinor: close + 100 });
    await s.until('2026-11-04T15:30:30.000Z'); // that poll asks for 4 bars, so it re-reads 15:00
    const snap = s.feeds.snapshot();
    assert.deepEqual(snap.alerts, [{ ...alert, correctedAt: '2026-11-04T15:30:30.000Z' }]);
    const saved = (dumpMarkets(s.p.vault).market_bars as Record<string, unknown>[]).filter(
      (b) => b.symbol === 'BTC-USD' && b.time === iso(SETUP),
    );
    assert.deepEqual(
      saved.map((b) => [b.revision, b.close_minor, b.received_at]),
      [
        [1, close, SETTLED],
        [2, close + 100, '2026-11-04T15:30:30.000Z'],
      ],
    );
    const btc = rowOf(snap, 'BTC-USD');
    assert.equal(btc.bars.find((b) => b.time === iso(SETUP))!.revision, 2);
    assert.equal(new Set(btc.bars.map((b) => b.time)).size, btc.bars.length);
    const decision = (time: number) => btc.decisions.find((d) => d.time === iso(time))!;
    assert.equal(decision(SETUP).reason, CORRECTED);
    assert.equal(decision(SETUP + BAR).reason, 'Warm-up: 2/50 closed bars.');
  }));

test('a changed volume saves nothing', () =>
  scenario({ coinbase: true }, async (s) => {
    const series = seriesEndingInSetup('BTC-USD', SETUP, 'continuous');
    s.world.setBars('BTC-USD', [...series, ...flatAfter(series, 2, 'continuous')]);
    await s.feeds.tick();
    await s.until(SETTLED);
    s.feeds.snapshot(); // writes the bars that wake fetched
    const before = dumpMarkets(s.p.vault).market_bars.length;
    s.world.edit('BTC-USD', iso(SETUP), { volume: 999 });
    await s.until('2026-11-04T15:30:35.000Z');
    const saved = dumpMarkets(s.p.vault).market_bars as Record<string, unknown>[];
    // Only the two new 15:15 bars, one for each symbol.
    assert.equal(saved.length, before + 2);
    assert.deepEqual(
      saved.filter((b) => b.symbol === 'BTC-USD' && b.time === iso(SETUP)).map((b) => b.revision),
      [1],
    );
    assert.equal(alerts(s)[0].correctedAt, null);
    assert.notEqual(
      row(s, 'BTC-USD').decisions.find((d) => d.time === iso(SETUP))!.reason,
      CORRECTED,
    );
  }));

// Locking (Review Focus 4)

test('while locked, polling continues and nothing is written', (t: TestContext) =>
  scenario({ coinbase: true }, async (s) => {
    await s.feeds.tick();
    s.feeds.snapshot(); // writes what the first wake fetched
    const before = dumpMarkets(s.p.vault);
    const save = t.mock.method(MarketStore.prototype, 'saveBatch');
    s.p.vault.lock();
    const sent = s.transport.requests.length;
    await s.run(20 * MIN); // past the 15:15:30 close
    assert.equal(s.transport.requests.length, sent + 21);
    assert.equal(save.mock.callCount(), 0);
    s.p.vault.unlock(password);
    assert.deepEqual(dumpMarkets(s.p.vault), before);
    assert.deepEqual(s.logs, []);
  }));

test('at the next unlock, bars and alerts are saved in one batch, with their original times', (t: TestContext) =>
  scenario({ coinbase: true }, async (s) => {
    setupWorld(s);
    await s.feeds.tick();
    s.feeds.snapshot();
    const before = dumpMarkets(s.p.vault).market_bars.length;
    s.p.vault.lock();
    await s.until('2026-11-04T15:40:00.000Z'); // the setup arrives at 15:15:30, while locked
    s.p.vault.unlock(password);
    const save = t.mock.method(MarketStore.prototype, 'saveBatch');
    await s.run(5000);
    assert.equal(save.mock.callCount(), 1);
    const [batch] = save.mock.calls[0].arguments as [{ bars: Bar[]; alerts: MarketAlert[] }];
    const saved = dumpMarkets(s.p.vault) as Record<string, Record<string, unknown>[]>;
    assert.equal(saved.market_bars.length, before + batch.bars.length);
    assert.deepEqual(
      saved.market_alerts.map((a) => [a.time, a.alerted_at]),
      [[iso(SETUP), SETTLED]],
    );
    const receivedAt = (symbol: string, time: number) =>
      saved.market_bars.find((b) => b.symbol === symbol && b.time === iso(time))!.received_at;
    assert.equal(receivedAt('BTC-USD', SETUP), SETTLED);
    assert.equal(receivedAt('ETH-USD', SETUP + BAR), '2026-11-04T15:30:30.000Z');
    assert.equal(alerts(s)[0].alertedAt, SETTLED);
  }));

test('a poll that finishes after the lock is buffered, with no error', () =>
  scenario({ coinbase: true }, async (s) => {
    setupWorld(s);
    await s.feeds.tick();
    await s.until('2026-11-04T15:15:25.000Z');
    s.transport.handler = (r) => {
      if (r.kind === 'bars') s.p.vault.lock();
      return s.world.handler(r);
    };
    await s.run(5000);
    assert.equal(s.p.vault.unlocked, false);
    assert.throws(
      () => s.feeds.snapshot(),
      (e: unknown) => e instanceof AppError && e.status === 401,
    );
    assert.deepEqual(s.logs, []);
    s.transport.handler = s.world.handler;
    s.p.vault.unlock(password);
    await s.run(5000);
    assert.deepEqual(
      alerts(s).map((a) => a.alertedAt),
      [SETTLED],
    );
    assert.ok(
      (dumpMarkets(s.p.vault).market_bars as Record<string, unknown>[]).some(
        (b) => b.symbol === 'BTC-USD' && b.time === iso(SETUP),
      ),
    );
  }));

test('an unlock takeover mid-poll loses nothing', () =>
  scenario({ coinbase: true }, async (s) => {
    const series = setupWorld(s);
    await s.feeds.tick();
    await s.until('2026-11-04T15:15:25.000Z');
    s.transport.handler = (r) => {
      if (r.kind === 'bars') s.p.vault.unlock(password); // locks, then opens again
      return s.world.handler(r);
    };
    await s.run(5000);
    s.transport.handler = s.world.handler;
    await s.run(5000);
    assert.deepEqual(s.logs, []);
    const saved = dumpMarkets(s.p.vault) as Record<string, Record<string, unknown>[]>;
    assert.deepEqual(
      saved.market_bars.filter((b) => b.symbol === 'BTC-USD').map((b) => b.time),
      series.map((b) => b.time),
    );
    assert.equal(saved.market_alerts.length, 1);
    assert.equal(alerts(s).length, 1);
  }));

test('quitting while locked loses the buffer: a new supervisor catches up, and the setup is historical', () =>
  scenario({ coinbase: true }, async (s) => {
    setupWorld(s);
    await s.feeds.tick();
    s.feeds.snapshot();
    s.p.vault.lock();
    await s.until('2026-11-04T15:16:00.000Z'); // the setup arrived live, held in memory
    s.feeds.stop();
    const next = new FeedSupervisor({
      vault: s.p.vault,
      transport: s.transport,
      now: s.clock.now,
      tickMs: 0,
      log: (line) => s.logs.push(line),
    });
    try {
      s.p.vault.unlock(password);
      await next.tick();
      const snap = next.snapshot();
      assert.deepEqual(snap.alerts, []);
      const last = rowOf(snap, 'BTC-USD').decisions.at(-1)!;
      assert.deepEqual([last.time, last.state], [iso(SETUP), 'Buy setup']);
      assert.deepEqual(dumpMarkets(s.p.vault).market_alerts, []);
    } finally {
      next.stop();
    }
  }));

test('quitting while unlocked saves the pending batch, in the order index.ts quits', () =>
  scenario({ coinbase: true }, async (s) => {
    const server = createApp(s.p.vault, { port: 44999, feeds: s.feeds });
    const closed = once(server, 'close');
    await s.feeds.tick(); // the catch-up waits for the next wake to be written
    assert.deepEqual(dumpMarkets(s.p.vault).market_bars, []);
    shutdown({ vault: s.p.vault, feeds: s.feeds, server });
    await closed;
    assert.equal(s.p.vault.unlocked, false);
    s.p.vault.unlock(password);
    assert.equal(dumpMarkets(s.p.vault).market_bars.length, 2 * 349);
  }));

test('stopping while unlocked writes what is pending', () =>
  scenario({ coinbase: true }, async (s) => {
    await s.feeds.tick(); // the catch-up waits for the next wake to be written
    assert.deepEqual(dumpMarkets(s.p.vault).market_bars, []);
    s.feeds.stop();
    assert.equal(dumpMarkets(s.p.vault).market_bars.length, 2 * 349);
  }));

// Failures

test('backoff is 1, 2, 4, 8, then every 15 minutes, and a success resets it', () =>
  scenario({ coinbase: true, handler: offline }, async (s) => {
    await s.feeds.tick();
    await s.until(iso(T0 + 59 * MIN));
    assert.deepEqual(wakes(s), [0, 1, 3, 7, 15, 30, 45]);
    assert.equal(status(s, 'coinbase').state, 'stale');
    s.transport.handler = s.world.handler;
    await s.until(iso(T0 + 60 * MIN));
    assert.equal(status(s, 'coinbase').state, 'live');
    s.transport.handler = offline;
    await s.until(iso(T0 + 70 * MIN));
    assert.deepEqual(wakes(s).slice(7), [60, 61, 62, 64, 68]);
  }));

test('a failed price poll keeps the feed catching up even when its bar poll succeeds', () =>
  scenario({ coinbase: true }, async (s) => {
    s.transport.handler = (r) =>
      r.kind === 'prices' ? { ok: false, error: 'timeout' } : s.world.handler(r);
    await s.feeds.tick();
    await s.until(iso(T0 + 10 * MIN));
    // Each wake's two requests are one step, and the bar successes don't reset it.
    assert.deepEqual(wakes(s), [0, 1, 3, 7]);
    assert.equal(status(s, 'coinbase').state, 'stale');
  }));

test('Retry-After is honoured up to 3600 seconds', () =>
  scenario({ coinbase: true }, async (s) => {
    const plan: Record<number, FetchResult> = {
      0: { ok: false, error: 'rate-limited', retryAfterSeconds: 120 }, // beats the 1-minute step
      2: { ok: false, error: 'rate-limited', retryAfterSeconds: 86_400 }, // capped at an hour
      62: { ok: false, error: 'network', retryAfterSeconds: 300 }, // a 5xx, beats the 4-minute step
      67: { ok: false, error: 'rate-limited', retryAfterSeconds: 10 }, // the 8-minute step wins
    };
    s.transport.handler = () => plan[(s.clock.now() - T0) / MIN] ?? offline();
    await s.feeds.tick();
    await s.until(iso(T0 + 80 * MIN));
    assert.deepEqual(wakes(s), [0, 2, 62, 67, 75]);
  }));

test('one bad response saves nothing, and reads failing with unexpected-response', async () => {
  const swapped = (s: Scenario) => (r: FetchRequest) =>
    s.world.handler(
      r.kind === 'bars'
        ? { feed: r.feed, kind: 'prices', symbols: r.symbols }
        : { feed: r.feed, kind: 'bars', symbols: r.symbols },
    );
  const cases: [string, (s: Scenario) => (r: FetchRequest) => FetchResult][] = [
    ['malformed', () => () => ({ ok: false, error: 'malformed' })],
    ['too-large', () => () => ({ ok: false, error: 'too-large' })],
    ['each answer of the wrong kind', swapped],
    ['Coinbase refusing a public request', () => () => ({ ok: false, error: 'unauthorized' })],
  ];
  for (const [name, handler] of cases)
    await scenario({ coinbase: true }, async (s) => {
      s.transport.handler = handler(s);
      await s.feeds.tick();
      await s.run(5000);
      const saved = dumpMarkets(s.p.vault);
      assert.deepEqual([saved.market_bars, saved.market_alerts], [[], []], name);
      const snap = s.feeds.snapshot();
      assert.deepEqual(
        [statusOf(snap, 'coinbase').state, statusOf(snap, 'coinbase').failure],
        ['failing', 'unexpected-response'],
        name,
      );
      const btc = rowOf(snap, 'BTC-USD');
      assert.deepEqual([btc.bars, btc.price], [[], null], name);
      assert.equal(live(btc).reason, 'unexpected-response', name);
    });
});

test('rows for a symbol the request did not ask for are dropped', () =>
  scenario({ coinbase: true, alpaca: true }, async (s) => {
    // Each feed's answers also carry a row for a symbol of the other feed.
    const stray = { coinbase: 'AAPL', alpaca: 'BTC-USD' } as const;
    s.transport.handler = (r) => {
      const symbol = stray[r.feed];
      const answer = s.world.handler(r);
      if (answer.ok && 'bars' in answer)
        return {
          ok: true,
          bars: [
            ...answer.bars,
            { symbol, time: '2026-11-04T14:30:00.000Z', closeMinor: 1, volume: 1 },
          ],
        };
      if (answer.ok && 'prices' in answer)
        return { ok: true, prices: [...answer.prices, { symbol, priceMinor: 1, paused: true }] };
      return answer;
    };
    await s.feeds.tick();
    await s.run(5000);
    const saved = dumpMarkets(s.p.vault).market_bars as Record<string, unknown>[];
    assert.ok(saved.length > 0);
    assert.ok(saved.every((b) => b.close_minor !== 1));
    const snap = s.feeds.snapshot();
    for (const symbol of ['AAPL', 'BTC-USD']) {
      const instrument = rowOf(snap, symbol);
      assert.equal(live(instrument).state, 'live', symbol);
      assert.equal(
        instrument.price,
        instruments.find((i) => i.symbol === symbol)!.base / 100,
        symbol,
      );
    }
  }));

test('it retries after a bad response, and recovers through catching up', () =>
  scenario({ coinbase: true }, async (s) => {
    s.transport.handler = (r) =>
      r.kind === 'bars' ? { ok: false, error: 'malformed' } : s.world.handler(r);
    await s.feeds.tick();
    assert.equal(status(s, 'coinbase').failure, 'unexpected-response');
    s.transport.handler = s.world.handler;
    await s.until(iso(T0 + MIN));
    const bars = s.transport.requests.filter((r) => r.kind === 'bars') as { limit?: number }[];
    assert.deepEqual(
      bars.map((r) => r.limit),
      [350, 350],
    );
    assert.deepEqual([status(s, 'coinbase').state, status(s, 'coinbase').failure], ['live', null]);
    assert.equal(dumpMarkets(s.p.vault).market_bars.length, 2 * 349);
    assert.deepEqual(s.logs, ['AllIn: feed coinbase failed: malformed']);
  }));

test('Alpaca unauthorized stops requests until a new key', () =>
  scenario({ alpaca: true }, async (s) => {
    s.transport.handler = () => ({ ok: false, error: 'unauthorized' });
    await s.feeds.tick();
    const sent = s.transport.requests.length;
    assert.equal(sent, 2);
    await s.run(HOUR);
    assert.equal(s.transport.requests.length, sent);
    assert.deepEqual(
      [status(s, 'alpaca').state, status(s, 'alpaca').failure],
      ['failing', 'key-rejected'],
    );
    assert.equal(live(row(s, 'AAPL')).reason, 'key-rejected');
    s.transport.handler = s.world.handler;
    const fresh: AlpacaKey = { keyId: 'PKNEWKEY7654321', secret: 'newsecret1234567890' };
    await s.feeds.setAlpaca({ enabled: true, key: fresh });
    await s.run(5000);
    assert.ok(s.transport.requests.length > sent + 1);
    assert.deepEqual(loadAlpacaKey(s.p.vault), fresh);
    assert.deepEqual([status(s, 'alpaca').state, status(s, 'alpaca').failure], ['live', null]);
  }));

test('3 crashes in 5 minutes stop the feed; 3 spread wider do not', async () => {
  await scenario(
    { coinbase: true, handler: () => ({ ok: false, error: 'worker-crashed' }) },
    async (s) => {
      await s.feeds.tick();
      await s.until(iso(T0 + 30 * MIN));
      assert.deepEqual(wakes(s), [0, 1, 3]);
      assert.deepEqual(
        [status(s, 'coinbase').state, status(s, 'coinbase').failure],
        ['failing', 'worker-crashes'],
      );
    },
  );
  await scenario({ coinbase: true }, async (s) => {
    // Crashes at 0, 3, and 6 minutes, each followed by a success.
    s.transport.handler = (r) =>
      [0, 3, 6].includes((s.clock.now() - T0) / MIN)
        ? { ok: false, error: 'worker-crashed' }
        : s.world.handler(r);
    await s.feeds.tick();
    await s.until(iso(T0 + 10 * MIN));
    assert.deepEqual(wakes(s), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual([status(s, 'coinbase').state, status(s, 'coinbase').failure], ['live', null]);
  });
});

test('a worker crash puts both feeds back to catching up', () =>
  scenario({ coinbase: true, alpaca: true }, async (s) => {
    await s.feeds.tick();
    s.transport.handler = (r) =>
      r.feed === 'coinbase' ? { ok: false, error: 'worker-crashed' } : s.world.handler(r);
    await s.until(iso(T0 + MIN));
    assert.equal(status(s, 'coinbase').state, 'stale');
    assert.equal(status(s, 'alpaca').state, 'catching-up');
    s.transport.handler = s.world.handler;
    await s.run(5000);
    assert.deepEqual(callTimes(s, 'alpaca', 'bars'), [iso(T0), iso(T0 + MIN + 5000)]);
    assert.equal(status(s, 'alpaca').state, 'live');
  }));

test('isolation unavailable reads failing, and stays that way', () =>
  scenario({ coinbase: true }, async (s) => {
    let readies = 0;
    s.transport.ready = async () => {
      readies++;
      return false;
    };
    await s.feeds.tick();
    await s.run(HOUR);
    assert.equal(readies, 1);
    assert.deepEqual(s.transport.requests, []);
    assert.deepEqual(
      [status(s, 'coinbase').state, status(s, 'coinbase').failure],
      ['failing', 'isolation'],
    );
    assert.deepEqual(s.logs, ['AllIn: feed coinbase failed: isolation']);
    // A worker that starts but can't prove itself on a request is latched the same way.
    s.transport.ready = async () => true;
    s.transport.handler = () => ({ ok: false, error: 'isolation' });
    s.feeds.setCoinbase(false);
    s.feeds.setCoinbase(true);
    await s.run(5000);
    const sent = s.transport.requests.length;
    assert.equal(sent, 2);
    await s.run(HOUR);
    assert.equal(s.transport.requests.length, sent);
    assert.equal(status(s, 'coinbase').failure, 'isolation');
  }));

test('one failing feed leaves the other running', () =>
  scenario({ coinbase: true, alpaca: true }, async (s) => {
    s.transport.handler = (r) =>
      r.feed === 'alpaca' ? { ok: false, error: 'unauthorized' } : s.world.handler(r);
    await s.feeds.tick();
    await s.until('2026-11-04T15:16:00.000Z');
    const snap = s.feeds.snapshot();
    assert.equal(statusOf(snap, 'coinbase').state, 'live');
    assert.equal(statusOf(snap, 'alpaca').state, 'failing');
    assert.ok(callTimes(s, 'coinbase', 'bars').includes(SETTLED));
    assert.equal(statusOf(snap, 'coinbase').lastBarAt, iso(SETUP));
  }));

test('turning a feed off drops a late answer', () =>
  scenario({ coinbase: true }, async (s) => {
    s.transport.handler = (r) => {
      if (r.kind === 'bars') s.feeds.setCoinbase(false);
      return s.world.handler(r);
    };
    await s.feeds.tick();
    await s.run(5000);
    assert.equal(s.transport.requests.length, 2);
    assert.equal(status(s, 'coinbase').state, 'off');
    assert.deepEqual(row(s, 'BTC-USD'), marketFixtures()[3]);
    assert.deepEqual(dumpMarkets(s.p.vault).market_bars, []);
    assert.ok(events(s).includes('feed.off'));
    // Turned on again, it starts from nothing.
    s.transport.handler = s.world.handler;
    s.feeds.setCoinbase(true);
    await s.run(5000);
    assert.equal((s.transport.requests.at(-1) as { limit?: number }).limit, 350);
  }));

test('turning both off stops the transport', () =>
  scenario({ coinbase: true, alpaca: true }, async (s) => {
    await s.feeds.tick();
    assert.equal(s.transport.started, true);
    s.feeds.setCoinbase(false);
    assert.equal(s.transport.started, true);
    await s.feeds.setAlpaca({ enabled: false });
    assert.equal(s.transport.started, false);
    const sent = s.transport.requests.length;
    await s.run(HOUR);
    assert.equal(s.transport.requests.length, sent);
    assert.equal(s.transport.started, false);
    assert.deepEqual(
      s.feeds.snapshot().feeds.map((f) => f.state),
      ['off', 'off'],
    );
    assert.deepEqual(loadAlpacaKey(s.p.vault), TEST_KEY); // turning off keeps the key
  }));

test('a Coinbase paused product reads paused, and raises no alert; the other symbol carries on', () =>
  scenario({ coinbase: true }, async (s) => {
    setupWorld(s, 'BTC-USD');
    setupWorld(s, 'ETH-USD');
    s.world.paused.add('ETH-USD');
    await s.feeds.tick();
    await s.until(SETTLED);
    const snap = s.feeds.snapshot();
    assert.deepEqual(
      snap.alerts.map((a) => a.symbol),
      ['BTC-USD'],
    );
    const eth = rowOf(snap, 'ETH-USD'),
      btc = rowOf(snap, 'BTC-USD');
    assert.equal(live(eth).state, 'paused');
    assert.equal(live(btc).state, 'live');
    assert.deepEqual(
      [eth.decisions.at(-1)!.time, eth.decisions.at(-1)!.state],
      [iso(SETUP), 'Buy setup'],
    );
    assert.equal(statusOf(snap, 'coinbase').state, 'live');
  }));

test("the reviewer's probe: a paused Coinbase symbol whose bars stopped doesn't hold the other back", () =>
  scenario({ coinbase: true }, async (s) => {
    setupWorld(s, 'BTC-USD');
    s.world.setBars('ETH-USD', flatUntil('ETH-USD', SETUP - 2 * HOUR)); // ended 2 hours earlier
    s.world.paused.add('ETH-USD');
    await s.feeds.tick();
    await s.until(SETTLED);
    let snap = s.feeds.snapshot();
    assert.equal(live(rowOf(snap, 'ETH-USD')).state, 'paused');
    assert.equal(live(rowOf(snap, 'BTC-USD')).state, 'live');
    assert.equal(statusOf(snap, 'coinbase').state, 'live');
    assert.deepEqual(
      snap.alerts.map((a) => [a.symbol, a.time, a.alertedAt]),
      [['BTC-USD', iso(SETUP), SETTLED]],
    );
    // Trading resumes, but its bars are still old: they stopped, and the feed waits for them.
    s.world.paused.delete('ETH-USD');
    await s.until('2026-11-04T15:30:35.000Z');
    snap = s.feeds.snapshot();
    assert.equal(live(rowOf(snap, 'ETH-USD')).state, 'stale');
    assert.equal(live(rowOf(snap, 'BTC-USD')).state, 'catching-up');
    assert.equal(statusOf(snap, 'coinbase').state, 'stale');
    assert.deepEqual(s.logs, []);
  }));

test('logs hold only the feed and error code', () =>
  scenario(
    {
      coinbase: true,
      alpaca: true,
      key: { keyId: 'PKMARKER1234567', secret: 'markersecret12345678' },
    },
    async (s) => {
      const errors: FetchError[] = [
        'network',
        'timeout',
        'rate-limited',
        'malformed',
        'too-large',
        'worker-crashed',
      ];
      let n = 0;
      s.transport.handler = (r) =>
        r.feed === 'alpaca'
          ? { ok: false, error: 'unauthorized' }
          : { ok: false, error: errors[n++ % errors.length], retryAfterSeconds: 30 };
      await s.feeds.tick();
      await s.run(HOUR);
      assert.ok(s.logs.length >= 7);
      for (const line of s.logs) assert.match(line, /^AllIn: feed \w+ failed: [\w-]+$/);
      for (const error of errors)
        assert.ok(s.logs.includes(`AllIn: feed coinbase failed: ${error}`));
      assert.ok(s.logs.includes('AllIn: feed alpaca failed: unauthorized'));
      const text = s.logs.join('\n');
      for (const secret of [
        'PKMARKER',
        'markersecret',
        'BTC',
        'ETH',
        'AAPL',
        'http',
        'coinbase.com',
      ])
        assert.ok(!text.includes(secret), secret);
    },
  ));

test('a failed save keeps the batch, logs only its error type, and writes it at the next wake', (t: TestContext) =>
  scenario({ coinbase: true }, async (s) => {
    await s.feeds.tick(); // what this wake fetched waits for the next one
    const save = t.mock.method(MarketStore.prototype, 'saveBatch', () => {
      throw new RangeError('disk full while saving BTC-USD');
    });
    await s.run(5000);
    await s.run(5000); // a second failing wake logs nothing new
    assert.deepEqual(s.logs, ['AllIn: feed save failed: RangeError']);
    assert.deepEqual(dumpMarkets(s.p.vault).market_bars, []);
    save.mock.restore();
    await s.run(5000);
    assert.equal(dumpMarkets(s.p.vault).market_bars.length, 2 * 349);
  }));

// Answers that land late or out of order

test('a bar answer does not reconcile the feed while an earlier price request is still out', () =>
  scenario({ coinbase: true }, async (s) => {
    s.transport.holding = (r) => r.kind === 'prices';
    const wake = s.feeds.tick();
    await settle(); // the bar answer has landed, the price answer hasn't
    assert.equal(s.transport.parked.length, 1);
    assert.equal(status(s, 'coinbase').state, 'catching-up');
    assert.equal(live(row(s, 'BTC-USD')).state, 'catching-up');
    s.transport.release();
    await wake;
    assert.equal(status(s, 'coinbase').state, 'live');
  }));

test('a price failure landing after the bar answer keeps the feed catching up, and no setup alerts', () =>
  scenario({ coinbase: true, start: '2026-11-04T15:14:25.000Z' }, async (s) => {
    setupWorld(s); // the 15:00 bar settles at 15:15:30 and is a buy setup
    const start = s.clock.now();
    s.transport.handler = (r) =>
      r.kind === 'prices' ? { ok: false, error: 'timeout' } : s.world.handler(r);
    s.transport.holding = (r) => r.kind === 'prices';
    const states = new Set<string>();
    const wake = async () => {
      const done = s.feeds.tick();
      await settle();
      states.add(status(s, 'coinbase').state);
      states.add(live(row(s, 'BTC-USD')).state);
      s.transport.release(); // the timeout lands after the bar answer
      await done;
      states.add(status(s, 'coinbase').state);
    };
    await wake();
    while (s.clock.now() < start + 40 * MIN) {
      s.clock.advance(5000);
      await wake();
    }
    assert.deepEqual(
      [...new Set(s.calls.map((c) => (Date.parse(c.at) - start) / MIN))],
      [0, 1, 3, 7, 15, 30],
    );
    assert.ok(!states.has('live'), [...states].join());
    assert.equal(
      row(s, 'BTC-USD').decisions.find((d) => d.time === iso(SETUP))!.state,
      'Buy setup',
    );
    assert.deepEqual(alerts(s), []);
  }));

test('a symbol with no price stays stale when the feed reconciles again', () =>
  scenario({ alpaca: true }, async (s) => {
    s.world.noPrice.add('AAPL');
    await s.feeds.tick();
    await s.until('2026-11-04T15:09:00.000Z');
    assert.equal(live(row(s, 'AAPL')).state, 'stale');
    s.clock.advance(2 * MIN); // a sleep, then a catch-up that reconciles the feed again
    await s.feeds.tick();
    assert.equal(status(s, 'alpaca').state, 'live');
    assert.equal(live(row(s, 'NVDA')).state, 'live');
    assert.equal(live(row(s, 'AAPL')).state, 'stale');
  }));

for (const order of ['the wake first', 'the answer first'] as const)
  test(`an answer processed long after its request is settled as of the request (${order})`, () =>
    scenario({ coinbase: true }, async (s) => {
      s.world.forming = 100; // a forming bar reads differently from its final close
      await s.feeds.tick();
      await s.until('2026-11-04T15:15:25.000Z');
      s.transport.holding = (r) => r.kind === 'bars';
      s.clock.advance(5000);
      const asked = s.feeds.tick(); // 15:15:30: the provider answers now, with 15:15 still forming
      await settle();
      s.transport.holding = null;
      s.clock.advance(2 * HOUR + 6 * MIN); // the Mac sleeps before the answer is handled
      if (order === 'the wake first') {
        await s.feeds.tick();
        s.transport.release();
        await asked;
        // The wake saw the sleep, so this answer from before it can't reconcile the feed.
        assert.equal(status(s, 'coinbase').state, 'catching-up');
      } else {
        s.transport.release();
        await asked;
        await s.feeds.tick();
      }
      await s.run(10_000); // the catch-up
      const btc = row(s, 'BTC-USD');
      const times = btc.bars.map((b) => Date.parse(b.time));
      assert.equal(times.at(-1), Date.parse('2026-11-04T17:00:00.000Z'));
      assert.ok(
        times.every((time, i) => i === 0 || time - times[i - 1] === BAR),
        'no hole',
      );
      const formed = btc.bars.find((b) => b.time === iso(SETUP + BAR))!;
      assert.deepEqual([formed.revision, formed.closeMinor], [1, 6_842_000]);
      assert.ok(btc.decisions.every((d) => d.state === 'No trigger'));
      assert.equal(status(s, 'coinbase').state, 'live');
    }));

test('a bar missing from an answer that lands late is asked for again, not marked a gap', () =>
  scenario({ coinbase: true }, async (s) => {
    s.world.hidden.add(`BTC-USD|${iso(SETUP)}`);
    await s.feeds.tick();
    await s.until('2026-11-04T15:15:25.000Z');
    s.transport.holding = (r) => r.kind === 'bars';
    s.clock.advance(5000);
    const asked = s.feeds.tick(); // 15:15:30: the provider doesn't have the 15:00 bar yet
    await settle();
    s.transport.holding = null;
    while (s.clock.now() < Date.parse('2026-11-04T15:21:00.000Z')) {
      s.clock.advance(5000);
      await s.feeds.tick();
    }
    s.world.hidden.clear(); // it has the bar now
    s.transport.release(); // the old answer, without it, lands five and a half minutes late
    await asked;
    await s.run(5000);
    assert.deepEqual(callTimes(s, 'coinbase', 'bars').slice(1), [
      SETTLED,
      '2026-11-04T15:21:05.000Z',
    ]);
    assert.ok(row(s, 'BTC-USD').bars.some((b) => b.time === iso(SETUP)));
  }));

test('a request spanning a bar settling keeps only what had settled when it went out', () =>
  scenario({ coinbase: true, start: '2026-11-04T15:15:25.000Z' }, async (s) => {
    const rows = timesEndingAt(SETUP, 100, 'continuous').map((time) => ({
      symbol: 'BTC-USD',
      time: iso(time),
      closeMinor: 6_842_000,
      volume: 10,
    }));
    s.world.setBars('BTC-USD', rows);
    s.transport.holding = (r) => r.kind === 'bars';
    const first = s.feeds.tick(); // 15:15:25: the 15:00 bar closed 25 s ago and may still change
    await settle();
    s.transport.holding = null;
    s.world.edit('BTC-USD', iso(SETUP), { closeMinor: 6_850_000 }); // it settles on another close
    s.clock.advance(10_000);
    s.transport.release(); // the answer lands at 15:15:35, after the bar settled
    await first;
    await s.until('2026-11-04T15:16:00.000Z');
    const saved = (dumpMarkets(s.p.vault).market_bars as Record<string, unknown>[]).filter(
      (b) => b.symbol === 'BTC-USD' && b.time === iso(SETUP),
    );
    assert.deepEqual(
      saved.map((b) => [b.revision, b.close_minor]),
      [[1, 6_850_000]],
    );
  }));

test('a quote that lands late is as old as its request', () =>
  scenario({ coinbase: true }, async (s) => {
    s.world.prices.set('BTC-USD', 7_000_000);
    await s.feeds.tick();
    await s.until(iso(T0 + 55_000));
    s.transport.holding = (r) => r.kind === 'prices';
    s.clock.advance(5000);
    const asked = s.feeds.tick(); // T0 + 1 min: the provider quotes now, and the answer is held
    await settle();
    s.transport.holding = null;
    for (let i = 0; i < 42; i++) {
      s.clock.advance(5000); // wakes go on, with that request still out
      await s.feeds.tick();
    }
    s.transport.release(); // lands at T0 + 4.5 min, a quote 3.5 minutes old
    await asked;
    const btc = row(s, 'BTC-USD');
    assert.equal(btc.price, 68_420); // the last close, not the old quote
    assert.equal(live(btc).state, 'stale');
  }));

test('a late answer does not undo a failure that stopped the feed', () =>
  scenario({ alpaca: true }, async (s) => {
    s.transport.handler = (r) =>
      r.kind === 'prices'
        ? { ok: false, error: 'unauthorized' }
        : { ok: false, error: 'malformed' };
    await s.feeds.tick(); // the price answer stops the feed, then the bar answer lands
    await s.run(HOUR);
    assert.equal(s.transport.requests.length, 2);
    assert.equal(status(s, 'alpaca').failure, 'key-rejected');
    assert.deepEqual(s.logs, ['AllIn: feed alpaca failed: unauthorized']);
  }));

test('a feed that fails for good stops the worker once no other feed runs', async () => {
  await scenario(
    { alpaca: true, handler: () => ({ ok: false, error: 'unauthorized' }) },
    async (s) => {
      await s.feeds.tick();
      assert.equal(status(s, 'alpaca').failure, 'key-rejected');
      assert.equal(s.transport.started, false);
    },
  );
  await scenario({ coinbase: true, alpaca: true }, async (s) => {
    s.transport.handler = (r) =>
      r.feed === 'alpaca' ? { ok: false, error: 'unauthorized' } : s.world.handler(r);
    await s.feeds.tick();
    assert.equal(status(s, 'alpaca').failure, 'key-rejected');
    assert.equal(s.transport.started, true); // Coinbase still uses it
  });
});

test('Alpaca on with a key that is missing or unreadable reads key unavailable, and sends nothing until a key is entered', async () => {
  const stored: [string, (s: Scenario) => void][] = [
    ['missing', (s) => s.p.keys.delete(`alpaca:${s.p.vault.id}`)],
    ['unreadable', (s) => s.p.keys.set(`alpaca:${s.p.vault.id}`, 'not a key')],
  ];
  for (const [name, spoil] of stored)
    await scenario({ coinbase: true, alpaca: true }, async (s) => {
      spoil(s);
      await s.feeds.tick();
      await s.run(HOUR);
      const alpaca = status(s, 'alpaca');
      assert.deepEqual(
        [alpaca.enabled, alpaca.state, alpaca.failure, alpaca.hasKey],
        [true, 'failing', 'key-missing', false],
        name,
      );
      assert.deepEqual(
        s.transport.requests.filter((r) => r.feed === 'alpaca'),
        [],
        name,
      );
      assert.equal(s.transport.credentials, null, name);
      assert.equal(status(s, 'coinbase').state, 'live', name);
      const aapl = live(row(s, 'AAPL'));
      assert.equal(
        rowLabel(aapl, s.clock.now()),
        'Feed failing · key unavailable, enter it again',
        name,
      );
      // Toggling clears it, and a new key turns the feed on.
      await s.feeds.setAlpaca({ enabled: false });
      assert.equal(status(s, 'alpaca').state, 'off', name);
      await s.feeds.setAlpaca({ enabled: true, key: TEST_KEY });
      await s.run(5000);
      assert.deepEqual(
        [status(s, 'alpaca').state, status(s, 'alpaca').failure],
        ['live', null],
        name,
      );
    });
});

test('isolation unavailable latches every enabled feed, not only the ones due', () =>
  scenario({ coinbase: true, alpaca: true, start: '2026-11-07T17:00:00.000Z' }, async (s) => {
    await s.feeds.tick(); // Saturday: Alpaca catches up, then has nothing due
    s.transport.ready = async () => false;
    await s.run(MIN); // only Coinbase's price poll is due
    assert.deepEqual(
      s.feeds.snapshot().feeds.map((f) => [f.feed, f.state, f.failure]),
      [
        ['coinbase', 'failing', 'isolation'],
        ['alpaca', 'failing', 'isolation'],
      ],
    );
  }));

test('a key removed while the worker starts leaves the other feed running', () =>
  scenario({ coinbase: true }, async (s) => {
    saveAlpacaKey(s.p.vault, TEST_KEY); // saved, with Alpaca off
    s.transport.slowStart = true;
    const wake = s.feeds.tick(); // the worker starts, and hasn't said ready
    await settle();
    s.feeds.removeAlpacaKey(); // clearing the key stops the worker still starting
    await wake;
    assert.deepEqual(
      [status(s, 'coinbase').state, status(s, 'coinbase').failure],
      ['catching-up', null],
    );
    assert.deepEqual(s.transport.requests, []);
    assert.deepEqual(s.logs, []);
    // The next wake starts a fresh worker.
    s.transport.slowStart = false;
    await s.run(5000);
    assert.equal(status(s, 'coinbase').state, 'live');
  }));

test('a Coinbase bar answer in flight while the Alpaca key is removed still lands, and alerts', () =>
  scenario({ coinbase: true, alpaca: true }, async (s) => {
    setupWorld(s);
    await s.feeds.tick();
    await s.until(iso(Date.parse(SETTLED) - 5000));
    assert.equal(status(s, 'coinbase').state, 'live');
    s.transport.holding = (r) => r.feed === 'coinbase' && r.kind === 'bars';
    s.clock.advance(5000);
    const wake = s.feeds.tick(); // the setup bar's request goes out, and is held
    await settle();
    s.feeds.removeAlpacaKey();
    assert.equal(s.transport.credentials, null);
    assert.equal(s.transport.release(), 1);
    await wake;
    assert.equal(status(s, 'coinbase').state, 'live');
    assert.deepEqual(
      alerts(s).map((a) => [a.symbol, a.time]),
      [['BTC-USD', iso(SETUP)]],
    );
    assert.deepEqual(s.logs, []);
  }));

test('a key test whose worker is stopped while it starts says AllIn could not reach Alpaca', () =>
  scenario({}, async (s) => {
    s.transport.slowStart = true;
    const trying = s.feeds.setAlpaca({ enabled: true, key: TEST_KEY });
    await settle();
    s.feeds.stop(); // AllIn quitting
    await assert.rejects(
      trying,
      rejectsWith(502, "AllIn couldn't reach Alpaca, so nothing was saved. Try again."),
    );
    assert.equal(loadAlpacaKey(s.p.vault), null);
    assert.equal(s.p.vault.markets.settings().alpaca, false);
  }));

// Says ready after 400 ms, then answers every request as if offline.
const SLOW_WORKER = `
  setTimeout(() => process.stdout.write('{"type":"ready"}\\n'), 400);
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (message.type === 'fetch')
        process.stdout.write(JSON.stringify({ type: 'result', id: message.id, ok: false, error: 'network' }) + '\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
`;

test("the reviewer's probe: a key removed while the real transport starts its worker leaves Coinbase running", async () => {
  const p = profile();
  p.vault.setup(password);
  const clock = fakeClock(DEFAULT_START);
  p.vault.markets.setEnabled('coinbase', true, new Date(clock.now()));
  saveAlpacaKey(p.vault, TEST_KEY); // saved, with Alpaca off
  const logs: string[] = [];
  const feeds = new FeedSupervisor({
    vault: p.vault,
    transport: sandboxedTransport({
      dataDir: p.directory,
      appDir: APP_DIR,
      worker: join(APP_DIR, 'server', 'feedWorker.ts'),
      command: () => ({ command: process.execPath, args: ['-e', SLOW_WORKER] }),
    }),
    now: clock.now,
    tickMs: 0,
    log: (line) => logs.push(line),
  });
  const coinbase = () => statusOf(feeds.snapshot(), 'coinbase');
  try {
    const wake = feeds.tick();
    await new Promise((resolve) => setTimeout(resolve, 100));
    feeds.removeAlpacaKey();
    await wake;
    assert.deepEqual([coinbase().state, coinbase().failure], ['catching-up', null]);
    assert.deepEqual(logs, []);
    // The next wake starts a fresh worker, which answers its price and bar requests.
    clock.advance(5000);
    await feeds.tick();
    assert.deepEqual([coinbase().state, coinbase().failure], ['stale', null]);
    assert.deepEqual(logs, [
      'AllIn: feed coinbase failed: network',
      'AllIn: feed coinbase failed: network',
    ]);
  } finally {
    feeds.stop();
    p.cleanup();
  }
});

// Keys

test('turning Alpaca on tests the key, and stores it only on success', () =>
  scenario({}, async (s) => {
    let during: unknown;
    s.transport.handler = (r) => {
      during = {
        stored: loadAlpacaKey(s.p.vault),
        credentials: s.transport.credentials,
        enabled: s.p.vault.markets.settings().alpaca,
      };
      return s.world.handler(r);
    };
    await s.feeds.setAlpaca({ enabled: true, key: TEST_KEY });
    assert.deepEqual(s.transport.requests, [
      {
        feed: 'alpaca',
        kind: 'bars',
        symbols: ['AAPL', 'NVDA', 'MSFT'],
        start: iso(T0 - 14 * DAY),
      },
    ]);
    assert.deepEqual(during, { stored: null, credentials: TEST_KEY, enabled: false });
    assert.deepEqual(loadAlpacaKey(s.p.vault), TEST_KEY);
    assert.equal(s.p.vault.markets.settings().alpaca, true);
    const alpaca = status(s, 'alpaca');
    assert.deepEqual([alpaca.enabled, alpaca.hasKey, alpaca.state], [true, true, 'catching-up']);
    assert.ok(events(s).includes('feed.key-saved'));
    assert.ok(events(s).includes('feed.on'));
    await s.run(5000);
    assert.equal(status(s, 'alpaca').state, 'live');
  }));

test('a rejected key is not stored, keeps any earlier key, and throws a 400', () =>
  scenario({}, async (s) => {
    s.transport.handler = (r) =>
      s.transport.credentials?.keyId.includes('REJECT')
        ? { ok: false, error: 'unauthorized' }
        : s.world.handler(r);
    const rejected: AlpacaKey = { keyId: 'PKREJECTED12345', secret: 'badsecret123456789' };
    const refusal = rejectsWith(400, 'Alpaca rejected this key. Check the key ID and secret.');
    // With no earlier key.
    await assert.rejects(s.feeds.setAlpaca({ enabled: true, key: rejected }), refusal);
    assert.equal(loadAlpacaKey(s.p.vault), null);
    assert.equal(s.transport.credentials, null);
    assert.equal(s.p.vault.markets.settings().alpaca, false);
    assert.deepEqual([status(s, 'alpaca').enabled, status(s, 'alpaca').hasKey], [false, false]);
    // With an earlier key, which the feed keeps using.
    await s.feeds.setAlpaca({ enabled: true, key: TEST_KEY });
    await s.run(5000);
    await assert.rejects(s.feeds.setAlpaca({ enabled: true, key: rejected }), refusal);
    assert.deepEqual(loadAlpacaKey(s.p.vault), TEST_KEY);
    assert.deepEqual(s.transport.credentials, TEST_KEY);
    assert.deepEqual([status(s, 'alpaca').enabled, status(s, 'alpaca').hasKey], [true, true]);
    await s.run(5000);
    assert.equal(status(s, 'alpaca').state, 'live');
  }));

test('while a key is being tried, the feed sends nothing else', () =>
  scenario({ alpaca: true }, async (s) => {
    await s.feeds.tick();
    assert.equal(status(s, 'alpaca').state, 'live');
    const other: AlpacaKey = { keyId: 'PKREJECTED12345', secret: 'badsecret123456789' };
    const tried: FetchRequest[] = [];
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    s.transport.handler = async (r) => {
      if (s.transport.credentials?.keyId !== other.keyId) return s.world.handler(r);
      tried.push(r);
      if (tried.length === 1) await answered; // the key test is slow to answer
      return { ok: false, error: 'unauthorized' };
    };
    const trying = s.feeds.setAlpaca({ enabled: true, key: other });
    await s.run(2 * MIN);
    assert.equal(tried.length, 1);
    answer();
    await assert.rejects(
      trying,
      rejectsWith(400, 'Alpaca rejected this key. Check the key ID and secret.'),
    );
    await s.run(5000);
    assert.deepEqual([status(s, 'alpaca').state, status(s, 'alpaca').failure], ['live', null]);
  }));

test("a key test that can't reach Alpaca, or can't read its answer, throws a 502 that says which, and stores nothing", async () => {
  const unreachable = "AllIn couldn't reach Alpaca, so nothing was saved. Try again.",
    unreadable = "Alpaca answered, but AllIn couldn't read the answer, so the key wasn't saved.";
  const answers: [FetchResult, string][] = [
    [{ ok: false, error: 'network' }, unreachable],
    [{ ok: false, error: 'timeout' }, unreachable],
    [{ ok: false, error: 'rate-limited', retryAfterSeconds: 30 }, unreachable],
    [{ ok: false, error: 'worker-crashed' }, unreachable],
    // Alpaca did answer: a 400, 404, or 422, or a body that fails the schema.
    [{ ok: false, error: 'malformed' }, unreadable],
    [{ ok: false, error: 'too-large' }, unreadable],
    [{ ok: true, prices: [] }, unreadable], // the wrong kind
  ];
  for (const [answer, message] of answers)
    await scenario({ handler: () => answer }, async (s) => {
      await assert.rejects(
        s.feeds.setAlpaca({ enabled: true, key: TEST_KEY }),
        rejectsWith(502, message),
        JSON.stringify(answer),
      );
      assert.equal(loadAlpacaKey(s.p.vault), null);
      assert.equal(s.p.vault.markets.settings().alpaca, false);
      assert.equal(s.transport.credentials, null);
      assert.equal(s.transport.started, false);
    });
});

test('no sandbox while testing throws a 503, and stores nothing', () =>
  scenario({}, async (s) => {
    const refusal = rejectsWith(503, "AllIn couldn't isolate the feed, so it stayed off.");
    s.transport.ready = async () => false;
    await assert.rejects(s.feeds.setAlpaca({ enabled: true, key: TEST_KEY }), refusal);
    assert.deepEqual(s.transport.requests, []);
    s.transport.ready = async () => true;
    s.transport.handler = () => ({ ok: false, error: 'isolation' });
    await assert.rejects(s.feeds.setAlpaca({ enabled: true, key: TEST_KEY }), refusal);
    assert.equal(loadAlpacaKey(s.p.vault), null);
    assert.equal(s.p.vault.markets.settings().alpaca, false);
    assert.equal(s.transport.credentials, null);
  }));

test('turning on with no key and none saved throws a 400', () =>
  scenario({}, async (s) => {
    await assert.rejects(
      s.feeds.setAlpaca({ enabled: true }),
      rejectsWith(400, 'Enter your Alpaca key ID and secret.'),
    );
    assert.deepEqual(s.transport.requests, []);
    assert.equal(s.transport.started, false);
    assert.equal(s.p.vault.markets.settings().alpaca, false);
  }));

test('turning Alpaca off while a key is being tried wins', () =>
  scenario({}, async (s) => {
    s.transport.holding = (r) => r.feed === 'alpaca';
    const trying = s.feeds.setAlpaca({ enabled: true, key: TEST_KEY });
    await settle();
    await s.feeds.setAlpaca({ enabled: false });
    // On again with another key while the first test is still out: one test at a time.
    const again = assert.rejects(
      s.feeds.setAlpaca({ enabled: true, key: OTHER_KEY }),
      rejectsWith(409, BUSY),
    );
    await settle();
    s.transport.release(); // the first key passes, but the feed was turned off meanwhile
    await again;
    await assert.rejects(trying, rejectsWith(409, CHANGED));
    assert.equal(s.p.vault.markets.settings().alpaca, false);
    assert.equal(loadAlpacaKey(s.p.vault), null);
    assert.equal(s.transport.credentials, null); // the key current now, not one from before
    assert.deepEqual(
      [status(s, 'alpaca').enabled, status(s, 'alpaca').state, status(s, 'alpaca').hasKey],
      [false, 'off', false],
    );
    assert.equal(s.transport.started, false);
    s.transport.holding = null;
    await s.feeds.setAlpaca({ enabled: true, key: OTHER_KEY });
    assert.deepEqual(s.transport.credentials, OTHER_KEY);
    assert.deepEqual(loadAlpacaKey(s.p.vault), OTHER_KEY);
  }));

test('removing the key during a key test supersedes it, whether the key passes or fails', async () => {
  for (const passes of [true, false])
    await scenario({ alpaca: true }, async (s) => {
      await s.feeds.tick(); // live with TEST_KEY
      if (!passes)
        s.transport.handler = (r) =>
          s.transport.credentials?.keyId === OTHER_KEY.keyId
            ? { ok: false, error: 'unauthorized' }
            : s.world.handler(r);
      s.transport.holding = (r) => r.feed === 'alpaca';
      const trying = s.feeds.setAlpaca({ enabled: true, key: OTHER_KEY });
      await settle();
      s.feeds.removeAlpacaKey();
      s.transport.release();
      await assert.rejects(trying, rejectsWith(409, CHANGED), String(passes));
      assert.equal(s.transport.credentials, null);
      assert.equal(loadAlpacaKey(s.p.vault), null);
      assert.deepEqual([status(s, 'alpaca').enabled, status(s, 'alpaca').hasKey], [false, false]);
    });
});

test('only one key test runs at a time', () =>
  scenario({}, async (s) => {
    s.transport.holding = (r) => r.feed === 'alpaca';
    const first = s.feeds.setAlpaca({ enabled: true, key: TEST_KEY });
    await settle();
    const second = assert.rejects(
      s.feeds.setAlpaca({ enabled: true, key: OTHER_KEY }),
      rejectsWith(409, BUSY),
    );
    const saved = assert.rejects(s.feeds.setAlpaca({ enabled: true }), rejectsWith(409, BUSY));
    await settle();
    s.transport.release();
    await second;
    await saved;
    await first;
    assert.deepEqual(loadAlpacaKey(s.p.vault), TEST_KEY);
    assert.deepEqual(s.transport.credentials, TEST_KEY);
    assert.equal(s.transport.requests.length, 1);
  }));

test('a feed failing for good during a key test does not stop the worker the test is using', () =>
  scenario({ alpaca: true }, async (s) => {
    await s.feeds.tick(); // live with TEST_KEY
    await s.until(iso(T0 + 55_000));
    s.transport.handler = (r) =>
      r.kind === 'prices' ? { ok: false, error: 'unauthorized' } : s.world.handler(r);
    s.transport.holding = (r) => r.feed === 'alpaca';
    s.clock.advance(5000);
    const wake = s.feeds.tick(); // the feed's price request goes out, and is held
    await settle();
    const trying = s.feeds.setAlpaca({ enabled: true, key: OTHER_KEY }); // its request is held too
    await settle();
    s.transport.release((r) => r.kind === 'prices'); // the old key is rejected
    await wake;
    assert.equal(status(s, 'alpaca').failure, 'key-rejected');
    assert.equal(s.transport.started, true);
    s.transport.release(); // the new key passes
    await trying;
    assert.deepEqual(loadAlpacaKey(s.p.vault), OTHER_KEY);
    assert.deepEqual(s.transport.credentials, OTHER_KEY);
    assert.deepEqual([status(s, 'alpaca').enabled, status(s, 'alpaca').failure], [true, null]);
  }));

test('a purge during a key test does not stop the feed turning on', () =>
  scenario({}, async (s) => {
    s.transport.holding = (r) => r.feed === 'alpaca';
    const trying = s.feeds.setAlpaca({ enabled: true, key: TEST_KEY });
    await settle();
    s.feeds.purge(); // removes data only
    s.transport.release();
    await trying;
    assert.equal(s.p.vault.markets.settings().alpaca, true);
    assert.deepEqual(loadAlpacaKey(s.p.vault), TEST_KEY);
    assert.deepEqual(s.transport.credentials, TEST_KEY);
    assert.deepEqual([status(s, 'alpaca').enabled, status(s, 'alpaca').hasKey], [true, true]);
  }));

test('a purge while a new key is tried leaves the running feed polling', () =>
  scenario({ alpaca: true }, async (s) => {
    await s.feeds.tick();
    s.transport.holding = (r) => r.feed === 'alpaca';
    const other: AlpacaKey = { keyId: 'PKOTHERKEY12345', secret: 'othersecret1234567' };
    const trying = s.feeds.setAlpaca({ enabled: true, key: other });
    await settle();
    s.transport.holding = null;
    s.feeds.purge();
    s.transport.release();
    await trying;
    const sent = s.transport.requests.length;
    await s.run(MIN);
    assert.ok(s.transport.requests.length > sent);
    assert.equal(status(s, 'alpaca').state, 'live');
  }));

test('removing the key turns the feed off in the vault first, and clears memory and the worker whatever fails', async (t: TestContext) => {
  const removedFromMemory = async (s: Scenario) => {
    assert.equal(s.transport.credentials, null);
    assert.deepEqual([status(s, 'alpaca').hasKey, status(s, 'alpaca').state], [false, 'off']);
    const sent = s.transport.requests.length;
    await s.run(5 * MIN);
    assert.equal(s.transport.requests.length, sent);
  };
  // The key store refuses to delete: the vault already says off, so the next launch starts off.
  await scenario({}, async (s) => {
    await s.feeds.setAlpaca({ enabled: true, key: TEST_KEY });
    await s.run(5000);
    s.p.keys.delete = () => {
      throw new Error('the key store refused');
    };
    assert.throws(() => s.feeds.removeAlpacaKey(), /the key store refused/);
    assert.equal(s.p.vault.markets.settings().alpaca, false);
    await removedFromMemory(s);
  });
  // The setting can't be saved: nothing is deleted, and memory and the worker drop the key anyway.
  await scenario({}, async (s) => {
    await s.feeds.setAlpaca({ enabled: true, key: TEST_KEY });
    await s.run(5000);
    t.mock.method(MarketStore.prototype, 'setEnabled', () => {
      throw new Error('the settings could not be saved');
    });
    assert.throws(() => s.feeds.removeAlpacaKey(), /could not be saved/);
    assert.deepEqual(loadAlpacaKey(s.p.vault), TEST_KEY);
    await removedFromMemory(s);
  });
});

test('removing the key turns Alpaca off, and clears the worker credentials', () =>
  scenario({}, async (s) => {
    await s.feeds.setAlpaca({ enabled: true, key: TEST_KEY });
    await s.run(5000);
    assert.deepEqual(s.transport.credentials, TEST_KEY);
    // Locked, nothing changes: removing the key logs an event, which needs the vault open.
    s.p.vault.lock();
    assert.throws(
      () => s.feeds.removeAlpacaKey(),
      (e: unknown) => e instanceof AppError && e.status === 401,
    );
    assert.ok(s.p.keys.get(`alpaca:${s.p.vault.id}`));
    s.p.vault.unlock(password);
    s.feeds.removeAlpacaKey();
    assert.equal(s.transport.credentials, null);
    assert.equal(loadAlpacaKey(s.p.vault), null);
    assert.equal(s.p.vault.markets.settings().alpaca, false);
    const alpaca = status(s, 'alpaca');
    assert.deepEqual([alpaca.enabled, alpaca.hasKey, alpaca.state], [false, false, 'off']);
    assert.ok(events(s).includes('feed.key-removed'));
    assert.ok(events(s).includes('feed.off'));
    assert.equal(s.transport.started, false);
    const sent = s.transport.requests.length;
    await s.run(HOUR);
    assert.equal(s.transport.requests.length, sent);
  }));

// Snapshot

test('a row with its feed on and no data has no price, no change, and no bars', () =>
  scenario({ coinbase: true, handler: offline }, async (s) => {
    const check = (state: string) => {
      const btc = row(s, 'BTC-USD');
      assert.deepEqual(
        [btc.price, btc.change, btc.bars, btc.decisions, btc.outcomes],
        [null, null, [], [], {}],
      );
      assert.deepEqual(btc.overview, { position: 'unavailable', setups: 0, lastSetup: null });
      assert.deepEqual(btc.source, {
        kind: 'live',
        feed: 'coinbase',
        provider: 'Coinbase',
        venue: 'Coinbase',
        state,
        reason: null,
        lastUpdate: null,
        lastBarAt: null,
      });
    };
    check('catching-up');
    await s.feeds.tick();
    check('stale');
  }));

test('a live row uses the fresh price, then the last close once stale', () =>
  scenario({ coinbase: true }, async (s) => {
    s.world.prices.set('BTC-USD', 7_000_000);
    await s.feeds.tick();
    let btc = row(s, 'BTC-USD');
    assert.equal(btc.price, 70_000);
    assert.equal(btc.change, (7_000_000 / 6_842_000 - 1) * 100);
    assert.equal(live(btc).state, 'live');
    assert.equal(live(btc).lastUpdate, iso(T0));
    s.transport.handler = (r) =>
      r.kind === 'prices' ? { ok: false, error: 'timeout' } : s.world.handler(r);
    await s.until(iso(T0 + 3 * MIN));
    assert.equal(row(s, 'BTC-USD').price, 70_000); // exactly 3 minutes old
    await s.run(5000);
    btc = row(s, 'BTC-USD');
    assert.equal(btc.price, 68_420); // the last close
    assert.equal(btc.change, 0);
    assert.equal(live(btc).state, 'stale');
  }));

test('instruments hold the newest 80 bars and their decisions; the rule ran on them all', () =>
  scenario({ coinbase: true }, async (s) => {
    // A setup 20 bars back, then flat bars up to the newest closed one at 14:45.
    const series = seriesEndingInSetup('BTC-USD', SETUP - 21 * BAR, 'continuous');
    const held = [...series, ...flatAfter(series, 20, 'continuous')];
    s.world.setBars('BTC-USD', held);
    await s.feeds.tick();
    const btc = row(s, 'BTC-USD');
    assert.equal(btc.bars.length, 80);
    assert.equal(btc.bars.at(-1)!.time, iso(SETUP - BAR));
    assert.equal(btc.bars[0].time, iso(SETUP - 80 * BAR));
    assert.deepEqual(
      btc.decisions.map((d) => [d.time, d.revision]),
      btc.bars.map((b) => [b.time, b.revision]),
    );
    assert.equal(btc.decisions[0].inputCount, held.length - 79);
    assert.equal(btc.decisions.at(-1)!.inputCount, held.length);
    assert.deepEqual(btc.overview, ruleOverview(btc.decisions));
    assert.equal(btc.overview.setups, 1);
    assert.deepEqual(btc.outcomes, setupOutcomes(btc.decisions, btc.bars));
    assert.equal(Object.keys(btc.outcomes).length, 1);
  }));

test('replay rows stay synthetic when a feed is off, even with saved bars', () =>
  scenario({}, async (s) => {
    for (const feed of ['coinbase', 'alpaca'] as const) {
      const answer = s.world.handler({
        feed,
        kind: 'bars',
        symbols: [...FEEDS[feed].symbols],
        start: iso(T0 - DAY),
      });
      assert.ok(answer.ok && 'bars' in answer);
      s.p.vault.markets.saveBatch({
        bars: mergeBars([], answer.bars, feed, iso(T0)).bars,
        alerts: [],
        corrections: [],
      });
    }
    await s.feeds.tick();
    assert.deepEqual(s.feeds.snapshot().instruments, marketFixtures());
  }));

test('purge empties memory and store, and catches up again', () =>
  scenario({ coinbase: true }, async (s) => {
    setupWorld(s);
    await s.feeds.tick();
    await s.until(SETTLED);
    assert.equal(alerts(s).length, 1);
    s.feeds.purge();
    const saved = dumpMarkets(s.p.vault);
    assert.deepEqual([saved.market_bars, saved.market_alerts], [[], []]);
    assert.equal(saved.feed_settings.length, 1);
    const snap = s.feeds.snapshot();
    assert.deepEqual([rowOf(snap, 'BTC-USD').bars, snap.alerts], [[], []]);
    assert.equal(statusOf(snap, 'coinbase').state, 'catching-up');
    assert.ok(events(s).includes('feed.purge'));
    const sent = s.transport.requests.length;
    await s.run(5000);
    assert.deepEqual(
      s.transport.requests.slice(sent).map((r) => (r as { limit?: number }).limit),
      [350],
    );
    const last = row(s, 'BTC-USD').decisions.at(-1)!;
    assert.deepEqual([last.time, last.state], [iso(SETUP), 'Buy setup']);
    assert.deepEqual(alerts(s), []); // caught up, so historical
    assert.ok(dumpMarkets(s.p.vault).market_bars.length > 0);
  }));

test('a full snapshot of 4000 bars per symbol takes under 2 seconds, and a repeat under 50 ms', () =>
  scenario({ coinbase: true, alpaca: true }, async (s) => {
    const last = SETUP - BAR; // the newest closed bar at the start, on both calendars
    const bars: Bar[] = [];
    for (const feed of ['coinbase', 'alpaca'] as const) {
      const times = timesEndingAt(last, 4000, FEEDS[feed].calendar);
      for (const symbol of FEEDS[feed].symbols) {
        const base = instruments.find((i) => i.symbol === symbol)!.base;
        const rows = times.map((time, i) => ({
          symbol,
          time: iso(time),
          closeMinor: base + (i % 13) * 7,
          volume: 10,
        }));
        s.world.setBars(symbol, rows);
        bars.push(...mergeBars([], rows, feed, iso(last + BAR + 30_000)).bars);
      }
    }
    s.p.vault.markets.saveBatch({ bars, alerts: [], corrections: [] });
    await s.feeds.tick();
    let started = performance.now();
    const snap = s.feeds.snapshot();
    const first = performance.now() - started;
    started = performance.now();
    s.feeds.snapshot();
    const repeat = performance.now() - started;
    assert.ok(first < 2000, `the first snapshot took ${first} ms`);
    assert.ok(repeat < 50, `the repeat took ${repeat} ms`);
    for (const instrument of snap.instruments) {
      assert.equal(instrument.source.kind, 'live');
      assert.equal(instrument.bars.length, 80);
      assert.equal(instrument.decisions[0].inputCount, 3921);
    }
  }));
