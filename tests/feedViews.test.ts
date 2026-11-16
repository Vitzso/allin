import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertId } from '../server/feedBars.ts';
import type { MarketAlert, MarketSource } from '../shared/feedSchema.ts';
import { LIVE_DISCLAIMER, MARKET_DISCLAIMER, type Decision } from '../shared/fixtures.ts';
import {
  alertLine,
  changeLabel,
  decisionLabel,
  deriveFeedState,
  rowLabel,
  sourceSummary,
  volumeHeights,
} from '../shared/feedViews.ts';

const base = {
  enabled: true,
  failure: null,
  reconciled: true,
  failures: 0,
  marketOpen: true,
  priceAgeMs: 1000 as number | null,
  barLateMs: null as number | null,
  paused: false,
  barsStopped: false,
};

for (const [name, change, want] of [
  ['the feed is off', { enabled: false }, 'off'],
  ['off beats a failure', { enabled: false, failure: 'key-rejected' as const }, 'off'],
  ['a rejected key', { failure: 'key-rejected' as const }, 'failing'],
  [
    'a failure beats paused and closed',
    { failure: 'calendar' as const, paused: true, marketOpen: false },
    'failing',
  ],
  ['trading paused', { paused: true }, 'paused'],
  ['paused beats closed', { paused: true, marketOpen: false }, 'paused'],
  ['market closed', { marketOpen: false }, 'closed'],
  ['market closed beats an unreconciled feed', { marketOpen: false, reconciled: false }, 'closed'],
  ['not yet reconciled, no failures', { reconciled: false }, 'catching-up'],
  [
    'not reconciled and the market is closed is closed',
    { marketOpen: false, reconciled: false, failures: 0 },
    'closed',
  ],
  ['not reconciled, one failure', { reconciled: false, failures: 1 }, 'stale'],
  ['a price exactly 180 s old', { priceAgeMs: 180_000 }, 'live'],
  ['a price 180.001 s old', { priceAgeMs: 180_001 }, 'stale'],
  ['a bar exactly 300 s late', { barLateMs: 300_000 }, 'live'],
  ['a bar 300.001 s late', { barLateMs: 300_001 }, 'stale'],
  ['answers succeed but the bars stopped', { barsStopped: true }, 'stale'],
  ['bars stopped beats an unreconciled feed', { barsStopped: true, reconciled: false }, 'stale'],
  ['market closed beats bars stopped', { barsStopped: true, marketOpen: false }, 'closed'],
  ['paused beats bars stopped', { barsStopped: true, paused: true }, 'paused'],
  [
    'a failure beats bars stopped',
    { barsStopped: true, failure: 'unexpected-response' as const },
    'failing',
  ],
  ['fresh and reconciled', {}, 'live'],
] as const)
  test(`feed state: ${name}`, () => assert.equal(deriveFeedState({ ...base, ...change }), want));

const NOW = Date.parse('2026-11-04T15:05:40.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
type Live = Extract<MarketSource, { kind: 'live' }>;
const replay: MarketSource = { kind: 'replay' };
const live = (change: Partial<Live> = {}): Live => ({
  kind: 'live',
  feed: 'coinbase',
  provider: 'Coinbase',
  venue: 'Coinbase',
  state: 'live',
  reason: null,
  lastUpdate: ago(40_000),
  lastBarAt: null,
  ...change,
});
const alpaca = (change: Partial<Live> = {}) =>
  live({ feed: 'alpaca', provider: 'Alpaca', venue: 'IEX', ...change });

for (const [name, source, want] of [
  ['replay', replay, 'Synthetic replay'],
  ['live Coinbase', live(), 'Live · Coinbase · updated 40 sec ago'],
  ['live Alpaca', alpaca(), 'Live · Alpaca · IEX only · updated 40 sec ago'],
  ['catching up', live({ state: 'catching-up' }), 'Catching up · signals paused'],
  [
    'stale, 6 min ago',
    live({ state: 'stale', lastUpdate: ago(6 * 60_000) }),
    'Stale · last update 6 min ago · signals paused',
  ],
  [
    'stale, no update yet',
    live({ state: 'stale', lastUpdate: null }),
    'Stale · no update yet · signals paused',
  ],
  [
    'closed, last bar Fri 15:45 ET',
    alpaca({ state: 'closed', lastBarAt: '2026-10-30T19:45:00.000Z' }),
    'Market closed · last close Fri 4:00 PM ET',
  ],
  ['paused', live({ state: 'paused' }), 'Trading paused on Coinbase'],
  [
    'failing, key rejected',
    alpaca({ state: 'failing', reason: 'key-rejected' }),
    'Feed failing · key rejected',
  ],
  [
    'failing, key missing',
    alpaca({ state: 'failing', reason: 'key-missing' }),
    'Feed failing · key unavailable, enter it again',
  ],
  [
    'failing, unexpected response',
    live({ state: 'failing', reason: 'unexpected-response' }),
    'Feed failing · unexpected response',
  ],
  [
    'failing, isolation',
    live({ state: 'failing', reason: 'isolation' }),
    'Feed failing · isolation unavailable',
  ],
  [
    'failing, worker crashes',
    live({ state: 'failing', reason: 'worker-crashes' }),
    'Feed failing · restart AllIn or toggle the feed',
  ],
  [
    'failing, calendar',
    alpaca({ state: 'failing', reason: 'calendar' }),
    'Market calendar needs updating',
  ],
] as const)
  test(`row label: ${name}`, () => assert.equal(rowLabel(source, NOW), want));

test('a live row reads hours and days for older updates', () => {
  assert.equal(
    rowLabel(live({ state: 'stale', lastUpdate: ago(3 * 3_600_000) }), NOW),
    'Stale · last update 3 hr ago · signals paused',
  );
  assert.equal(
    rowLabel(live({ lastUpdate: ago(1000) }), NOW),
    'Live · Coinbase · updated 1 sec ago',
  );
});

test('a day is singular at exactly one', () => {
  const stale = (ms: number) => rowLabel(live({ state: 'stale', lastUpdate: ago(ms) }), NOW);
  assert.equal(stale(86_400_000), 'Stale · last update 1 day ago · signals paused');
  assert.equal(stale(2 * 86_400_000), 'Stale · last update 2 days ago · signals paused');
});

test('source summary', () => {
  const closed = alpaca({ state: 'closed' }),
    catchingUp = live({ state: 'catching-up' });
  assert.equal(sourceSummary([live(), live(), replay, replay, replay]), '2 live · 3 replay');
  assert.equal(sourceSummary([live(), live(), closed, closed, closed]), '2 live · 3 market closed');
  assert.equal(sourceSummary([catchingUp, replay]), '1 paused · 1 replay');
  assert.equal(sourceSummary([replay, replay]), '2 replay');
});

const alertOf = (change: Partial<MarketAlert> = {}): MarketAlert => ({
  id: 'x',
  symbol: 'BTC-USD',
  time: '2026-11-04T20:15:00.000Z', // 10:15 PM in Jerusalem
  state: 'Buy setup',
  provider: 'Coinbase',
  venue: 'Coinbase',
  closeMinor: 6_842_000,
  fast: 6_840_000,
  slow: 6_830_000,
  reason: 'EMA20 crossed above EMA50',
  ruleVersion: 'ema-20-50/v3',
  alertedAt: '2026-11-04T20:30:30.000Z',
  dismissedAt: null,
  correctedAt: null,
  ...change,
});
test('alert line', () =>
  assert.equal(
    alertLine(alertOf(), 'Asia/Jerusalem'),
    'Buy setup · EMA20 crossed above EMA50 · BTC-USD · Coinbase · 10:15 PM',
  ));
test('the sell line says crossed below', () => {
  assert.equal(
    alertLine(alertOf({ state: 'Sell setup' }), 'Asia/Jerusalem'),
    'Sell setup · EMA20 crossed below EMA50 · BTC-USD · Coinbase · 10:15 PM',
  );
  assert.equal(
    alertLine(alertOf({ symbol: 'AAPL', provider: 'Alpaca' }), 'America/New_York'),
    'Buy setup · EMA20 crossed above EMA50 · AAPL · Alpaca · 3:15 PM',
  );
});

const decisionOf = (): Decision => ({
  id: 'd1',
  symbol: 'BTC-USD',
  time: '2026-11-04T20:15:00.000Z',
  state: 'Buy setup',
  provider: 'Coinbase',
  venue: 'Coinbase',
  currency: 'USD',
  interval: '15m',
  revision: 1,
  receivedAt: '2026-11-04T20:30:30.000Z',
  closeMinor: 6_842_000,
  fast: 1,
  slow: 1,
  previousFast: 1,
  previousSlow: 1,
  reason: 'r',
  version: 'ema-20-50/v3',
  inputCount: 80,
  inputDigest: 'abc',
  corrected: false,
});
test('decision labels', () => {
  const decision = decisionOf();
  assert.equal(decisionLabel(decision, replay, []), 'Simulation');
  assert.equal(decisionLabel(decision, replay, [alertOf({ id: alertId(decision) })]), 'Simulation');
  assert.equal(decisionLabel(decision, live(), [alertOf({ id: alertId(decision) })]), 'Live alert');
  assert.equal(decisionLabel(decision, live(), []), 'Historical');
  assert.equal(decisionLabel(decision, live(), [alertOf({ id: 'other' })]), 'Historical');
});
test('change labels', () => {
  assert.equal(changeLabel(replay), 'over fixture');
  assert.equal(changeLabel(live()), 'over 20 hours');
  assert.equal(changeLabel(alpaca()), 'over 20 market hours');
});
test('volume heights scale to the window, including BTC-sized volumes', () => {
  assert.deepEqual(volumeHeights([5, 20, 10]), [25, 100, 50]);
  assert.deepEqual(volumeHeights([0.0004, 0.002]), [20, 100]);
  assert.deepEqual(volumeHeights([90000, 45000]), [100, 50]);
});
test('all-zero volumes give zero heights, with no NaN', () => {
  assert.deepEqual(volumeHeights([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(volumeHeights([]), []);
});
test('the live disclaimer drops only the synthetic sentence', () => {
  assert.equal(MARKET_DISCLAIMER.replace('Prices here are synthetic. ', ''), LIVE_DISCLAIMER);
  assert.doesNotMatch(LIVE_DISCLAIMER, /synthetic/i);
  assert.match(LIVE_DISCLAIMER, /not financial advice/);
});
