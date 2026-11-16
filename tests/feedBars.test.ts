import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LATE_MS,
  RETAINED_BARS,
  SETTLE_MS,
  MAX_BARS_BEHIND,
  alertId,
  barRequest,
  barsStopped,
  isLiveBar,
  mergeBars,
  settledBars,
} from '../server/feedBars.ts';
import { evaluate } from '../server/replay.ts';
import type { Bar, Decision } from '../shared/fixtures.ts';
import type { FeedBar } from '../shared/feedSchema.ts';

const BAR = 900_000;
const iso = (ms: number) => new Date(ms).toISOString();
const row = (time: number, closeMinor = 100_00, volume = 5, symbol = 'BTC-USD'): FeedBar => ({
  symbol,
  time: iso(time),
  closeMinor,
  volume,
});
const T0 = Date.parse('2026-11-07T10:00:00Z');
const RECEIVED = '2026-11-08T12:00:00.000Z';

test('constants', () => {
  assert.equal(SETTLE_MS, 30_000);
  assert.equal(LATE_MS, 300_000);
  assert.equal(RETAINED_BARS, 4000);
});

test('a bar under 30 seconds past its close is dropped', () => {
  const close = T0 + BAR;
  const rows = [row(T0)];
  assert.equal(settledBars(rows, 'continuous', close + SETTLE_MS - 1).length, 0);
  assert.equal(settledBars(rows, 'continuous', close + SETTLE_MS).length, 1);
});
test('the forming bar and a future bar are dropped', () => {
  const now = T0 + 5 * BAR + 60_000;
  const rows = [row(T0 + 4 * BAR), row(T0 + 5 * BAR), row(T0 + 6 * BAR)];
  assert.deepEqual(
    settledBars(rows, 'continuous', now).map((r) => r.time),
    [iso(T0 + 4 * BAR)],
  );
});
test('a stock bar outside the session is dropped; a crypto bar at night is kept', () => {
  const night = Date.parse('2026-11-09T03:00:00Z'); // Sunday evening ET
  const session = Date.parse('2026-11-06T20:45:00Z');
  const now = Date.parse('2026-11-09T14:00:00Z');
  assert.deepEqual(
    settledBars(
      [row(night, 1, 1, 'AAPL'), row(session, 1, 1, 'AAPL')],
      'us-equity-regular',
      now,
    ).map((r) => r.time),
    [iso(session)],
  );
  assert.equal(settledBars([row(night)], 'continuous', now).length, 1);
});
test('a bar with an unparseable time is dropped', () => {
  assert.equal(
    settledBars([{ ...row(T0), time: 'nonsense' }], 'continuous', T0 + 10 * BAR).length,
    0,
  );
});

test("a new bar starts at revision 1 with the feed's identity", () => {
  const { bars, added, corrected } = mergeBars([], [row(T0, 123_45, 7)], 'coinbase', RECEIVED);
  assert.deepEqual(bars, added);
  assert.equal(corrected.length, 0);
  assert.deepEqual(bars, [
    {
      symbol: 'BTC-USD',
      assetClass: 'crypto',
      provider: 'Coinbase',
      venue: 'Coinbase',
      currency: 'USD',
      calendar: 'continuous',
      time: iso(T0),
      receivedAt: RECEIVED,
      interval: '15m',
      revision: 1,
      closeMinor: 123_45,
      volume: 7,
    },
  ]);
  const alpaca = mergeBars(
    [],
    [row(Date.parse('2026-11-06T20:45:00Z'), 1, 1, 'AAPL')],
    'alpaca',
    RECEIVED,
  ).bars[0];
  assert.equal(alpaca.provider, 'Alpaca');
  assert.equal(alpaca.venue, 'IEX');
  assert.equal(alpaca.assetClass, 'equity');
  assert.equal(alpaca.calendar, 'us-equity-regular');
});
test('a re-read bar with the same close is ignored, even if its volume changed', () => {
  const first = mergeBars([], [row(T0, 100_00, 5)], 'coinbase', RECEIVED);
  const again = mergeBars(
    first.bars,
    [row(T0, 100_00, 99)],
    'coinbase',
    '2026-11-07T21:00:00.000Z',
  );
  assert.deepEqual(again.bars, first.bars);
  assert.equal(again.added.length, 0);
  assert.equal(again.corrected.length, 0);
  const twice = mergeBars([], [row(T0, 100_00, 5), row(T0, 100_00, 6)], 'coinbase', RECEIVED);
  assert.equal(twice.bars.length, 1);
});
test('a changed close saves the next revision and reports the correction', () => {
  const first = mergeBars([], [row(T0, 100_00)], 'coinbase', RECEIVED);
  const later = '2026-11-07T21:00:00.000Z';
  const fixed = mergeBars(first.bars, [row(T0, 101_00)], 'coinbase', later);
  assert.equal(fixed.bars.length, 2);
  assert.equal(fixed.added.length, 0);
  assert.deepEqual(
    fixed.corrected.map((b) => [b.revision, b.closeMinor, b.receivedAt]),
    [[2, 101_00, later]],
  );
  const third = mergeBars(fixed.bars, [row(T0, 102_00)], 'coinbase', later);
  assert.equal(third.corrected[0].revision, 3);
  // Going back to a close seen in an older revision is still a change from the newest one.
  const back = mergeBars(third.bars, [row(T0, 100_00)], 'coinbase', later);
  assert.equal(back.corrected[0].revision, 4);
});
test('merged bars stay in time and revision order, and evaluate reads a correction as one', () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    row(T0 + i * BAR, 100_00 + ((i * 37) % 11) * 10),
  );
  const first = mergeBars([], rows, 'coinbase', RECEIVED);
  const fixedRow = row(T0 + 55 * BAR, rows[55].closeMinor + 10);
  const out = mergeBars(first.bars, [fixedRow, row(T0 + 60 * BAR, 100_00)], 'coinbase', RECEIVED);
  const times = out.bars.map((b) => [Date.parse(b.time), b.revision]);
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  );
  assert.equal(out.bars.length, 62);
  const decisions = evaluate(out.bars);
  const corrected = decisions.find((d) => d.time === fixedRow.time && d.revision === 2)!;
  assert.equal(corrected.corrected, true);
  assert.equal(corrected.state, 'Signal unavailable');
  assert.equal(corrected.inputCount, 1);
  // Same result as the rule's own handling of a correction appended after the history.
  const appended = evaluate([...first.bars, out.corrected[0]]).at(-1)!;
  assert.equal(appended.corrected, true);
  assert.equal(appended.state, corrected.state);
});
test('rows out of order and held bars from another symbol merge correctly', () => {
  const eth = mergeBars([], [row(T0, 5, 1, 'ETH-USD')], 'coinbase', RECEIVED).bars;
  const out = mergeBars(eth, [row(T0 + BAR), row(T0)], 'coinbase', RECEIVED);
  assert.equal(out.bars.length, 3);
  assert.equal(out.added.length, 2);
  assert.deepEqual(
    out.bars.filter((b) => b.symbol === 'BTC-USD').map((b) => b.time),
    [iso(T0), iso(T0 + BAR)],
  );
});
test('at most 4000 bar times are kept per symbol, dropping the oldest', () => {
  const rows = Array.from({ length: RETAINED_BARS + 5 }, (_, i) => row(T0 + i * BAR));
  const { bars } = mergeBars([], rows, 'coinbase', RECEIVED);
  assert.equal(bars.length, RETAINED_BARS);
  assert.equal(bars[0].time, iso(T0 + 5 * BAR));
  const eth = rows.slice(0, 3).map((r) => ({ ...r, symbol: 'ETH-USD' }));
  const both = mergeBars(bars, eth, 'coinbase', RECEIVED);
  assert.equal(both.bars.length, RETAINED_BARS + 3);
  // Revisions of a kept time stay with it.
  const fixed = mergeBars(bars, [row(T0 + 6 * BAR, 1)], 'coinbase', RECEIVED);
  assert.equal(fixed.bars.length, RETAINED_BARS + 1);
});

test('Coinbase request', () => {
  const now = Date.parse('2026-11-07T20:16:00Z'); // newest closed bar opened at 20:00
  const newest = Date.parse('2026-11-07T20:00:00Z');
  assert.deepEqual(barRequest('coinbase', null, now), { limit: 350 });
  assert.deepEqual(barRequest('coinbase', iso(newest), now), { limit: 4 });
  assert.deepEqual(barRequest('coinbase', iso(newest - BAR), now), { limit: 4 });
  assert.deepEqual(barRequest('coinbase', iso(newest - 10 * BAR), now), { limit: 13 });
  assert.deepEqual(barRequest('coinbase', iso(newest - 346 * BAR), now), { limit: 349 });
  assert.deepEqual(barRequest('coinbase', iso(newest - 347 * BAR), now), { limit: 350 });
  assert.deepEqual(barRequest('coinbase', iso(newest - 5000 * BAR), now), { limit: 350 });
});
test('Alpaca request', () => {
  const now = Date.parse('2026-11-09T15:00:00Z');
  const fourteenDays = iso(now - 14 * 86_400_000);
  assert.deepEqual(barRequest('alpaca', null, now), { start: fourteenDays });
  assert.deepEqual(barRequest('alpaca', '2026-11-09T14:30:00.000Z', now), {
    start: '2026-11-09T14:00:00.000Z',
  });
  assert.deepEqual(barRequest('alpaca', '2026-10-01T14:30:00.000Z', now), { start: fourteenDays });
});

const stock = (time: string, calendar: Bar['calendar'] = 'us-equity-regular'): Bar => ({
  symbol: 'AAPL',
  assetClass: 'equity',
  provider: 'Alpaca',
  venue: 'IEX',
  currency: 'USD',
  calendar,
  time,
  receivedAt: time,
  interval: '15m',
  revision: 1,
  closeMinor: 1,
  volume: 1,
});
const live = { reconciledBeforePoll: true, previousHeldBeforePoll: true };
const barTime = '2026-11-09T14:30:00.000Z';
const closeAt = Date.parse(barTime) + BAR;
test('a live bar', () => {
  const bar = stock(barTime);
  assert.equal(isLiveBar({ ...live, bar, now: closeAt + 31_000 }), true);
  assert.equal(isLiveBar({ ...live, bar, now: closeAt + SETTLE_MS }), true);
  assert.equal(isLiveBar({ ...live, bar, now: closeAt + LATE_MS }), true);
  const monday = stock('2026-11-06T20:45:00.000Z');
  assert.equal(isLiveBar({ ...live, bar: monday, now: Date.parse('2026-11-06T21:00:31Z') }), true);
});
test('a bar over 5 minutes after its close is historical', () => {
  assert.equal(isLiveBar({ ...live, bar: stock(barTime), now: closeAt + LATE_MS + 1 }), false);
});
test('a bar that is not the newest closed is historical', () => {
  const now = closeAt + 31_000 + BAR;
  assert.equal(isLiveBar({ ...live, bar: stock(barTime), now }), false);
  assert.equal(isLiveBar({ ...live, bar: stock(barTime), now: closeAt + 29_000 }), false);
});
test('a bar without its predecessor is historical', () => {
  assert.equal(
    isLiveBar({
      ...live,
      previousHeldBeforePoll: false,
      bar: stock(barTime),
      now: closeAt + 31_000,
    }),
    false,
  );
});
test('a bar from an unreconciled feed is historical', () => {
  assert.equal(
    isLiveBar({ ...live, reconciledBeforePoll: false, bar: stock(barTime), now: closeAt + 31_000 }),
    false,
  );
});

test('the alert id has no digest in it', () => {
  const decision = (id: string, inputDigest: string, inputCount: number): Decision => ({
    id,
    symbol: 'BTC-USD',
    time: '2026-11-07T20:00:00.000Z',
    state: 'Buy setup',
    provider: 'Coinbase',
    venue: 'Coinbase',
    currency: 'USD',
    interval: '15m',
    revision: 1,
    receivedAt: RECEIVED,
    closeMinor: 1,
    fast: 1,
    slow: 1,
    previousFast: 1,
    previousSlow: 1,
    reason: '',
    version: 'ema-20-50/v3',
    inputCount,
    inputDigest,
    corrected: false,
  });
  const a = alertId(decision('aaa', 'digest-one', 60));
  const b = alertId(decision('bbb', 'digest-two', 3000));
  assert.equal(a, b);
  assert.equal(a, 'Coinbase:Coinbase:BTC-USD:15m:2026-11-07T20:00:00.000Z:Buy setup:ema-20-50/v3');
});

test('bars stop counting once the newest held bar is more than 3 bars behind', () => {
  assert.equal(MAX_BARS_BEHIND, 3);
  const newest = Date.parse('2026-11-04T15:00:00.000Z');
  // Asked once the bar at `due` had settled.
  const askedWhenDue = (due: number) => due + BAR + SETTLE_MS;
  assert.equal(barsStopped(iso(newest), 'continuous', askedWhenDue(newest)), false);
  assert.equal(barsStopped(iso(newest), 'continuous', askedWhenDue(newest + BAR)), false); // a gap
  assert.equal(barsStopped(iso(newest), 'continuous', askedWhenDue(newest + 3 * BAR)), false);
  assert.equal(barsStopped(iso(newest), 'continuous', askedWhenDue(newest + 4 * BAR) - 1), false);
  assert.equal(barsStopped(iso(newest), 'continuous', askedWhenDue(newest + 4 * BAR)), true);
  // With nothing held, an answer after a bar was due has stopped too.
  assert.equal(barsStopped(undefined, 'continuous', askedWhenDue(newest)), true);
});

test('stock bars count session bars, so a weekend is not a stop', () => {
  const friday = Date.parse('2026-11-06T20:45:00.000Z'); // 15:45 in New York, the last bar
  const monday = (time: string) => Date.parse(`2026-11-09T${time}.000Z`);
  // Monday 9:30, 9:45, and 10:00 are missing: 3 behind.
  assert.equal(barsStopped(iso(friday), 'us-equity-regular', monday('15:15:30')), false);
  assert.equal(barsStopped(iso(friday), 'us-equity-regular', monday('15:30:30')), true);
  // Saturday asks find nothing due after Friday's last bar.
  assert.equal(
    barsStopped(iso(friday), 'us-equity-regular', Date.parse('2026-11-07T17:00:00.000Z')),
    false,
  );
  // Past the calendar's coverage nothing can be counted.
  assert.equal(
    barsStopped(iso(friday), 'us-equity-regular', Date.parse('2031-01-06T16:00:00.000Z')),
    false,
  );
});
