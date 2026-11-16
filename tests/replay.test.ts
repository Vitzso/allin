import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, marketFixtures } from '../server/replay.ts';
import { fixtureBars, type Bar } from '../shared/fixtures.ts';

// Thirty trading days, all in US daylight time, so each session opens at 13:30 UTC.
// Weekends and Labor Day (Sep 7) are excluded by hand, independently of the calendar code.
const tradingDays = () => {
  const days: string[] = [];
  for (let at = Date.parse('2026-08-03T12:00:00Z'); days.length < 30; at += 86400000) {
    const date = new Date(at),
      day = date.toISOString().slice(0, 10);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && day !== '2026-09-07') days.push(day);
  }
  return days;
};
const sessionBars = (days: string[]): Bar[] => {
  const bars: Bar[] = [];
  for (const day of days)
    for (let i = 0; i < 26; i++) {
      const time = Date.parse(`${day}T13:30:00Z`) + i * 900000;
      bars.push({
        symbol: 'TEST',
        assetClass: 'equity',
        provider: 'Test',
        venue: 'TEST',
        currency: 'USD',
        calendar: 'us-equity-regular',
        time: new Date(time).toISOString(),
        receivedAt: new Date(time + 900000).toISOString(),
        interval: '15m',
        revision: 1,
        closeMinor: 20000 + Math.round(500 * Math.sin(bars.length / 40)),
        volume: 1000,
      });
    }
  return bars;
};

test('regular-hours equities warm up and signal across overnight closes, weekends and holidays', () => {
  const decisions = evaluate(sessionBars(tradingDays()));
  assert.equal(decisions.length, 780);
  assert.equal(decisions[48].state, 'Signal unavailable');
  assert.equal(decisions[49].state, 'No trigger');
  assert.equal(decisions.slice(49).filter((d) => d.state === 'Signal unavailable').length, 0);
  assert.ok(decisions.some((d) => d.state === 'Buy setup'));
  assert.ok(decisions.some((d) => d.state === 'Sell setup'));
  assert.equal(decisions.at(-1)!.inputCount, 780);
});
test('a bar missing inside a regular session still resets warm-up', () => {
  const bars = sessionBars(tradingDays());
  const decisions = evaluate(bars.filter((_, i) => i !== 100));
  assert.equal(decisions[100].time, bars[101].time);
  assert.equal(decisions[100].state, 'Signal unavailable');
  assert.equal(decisions[100].inputCount, 1);
});
test('a whole missing trading day is a gap, not a market closure', () => {
  const days = tradingDays();
  const decisions = evaluate(sessionBars(days.filter((_, i) => i !== 10)));
  // Day index 10 is gone, so the first bar of the following session must reset warm-up.
  assert.equal(decisions[260].state, 'Signal unavailable');
  assert.equal(decisions[260].inputCount, 1);
});
test('bars outside the session or past calendar coverage cannot produce a signal', () => {
  const bars = sessionBars(tradingDays());
  const preMarket = {
    ...bars[26],
    time: '2026-08-04T13:15:00.000Z',
    receivedAt: '2026-08-04T13:30:00.000Z',
  };
  assert.equal(evaluate([preMarket])[0].state, 'Signal unavailable');
  assert.equal(evaluate([preMarket])[0].inputCount, 0);
  const uncovered = sessionBars(['2029-01-02']);
  assert.equal(
    evaluate(uncovered).every((d) => d.state === 'Signal unavailable' && d.inputCount === 0),
    true,
  );
});
test('a bar redelivered with a later receipt time changes nothing', () => {
  const bars = fixtureBars(0);
  const redelivered = { ...bars[60], receivedAt: '2026-10-31T09:00:00.000Z' };
  assert.deepEqual(
    evaluate([...bars.slice(0, 61), redelivered, ...bars.slice(61)]),
    evaluate(bars),
  );
});
test('a higher revision with the same values is not treated as a correction', () => {
  const bars = fixtureBars(0);
  const sameValues = { ...bars[60], revision: 2, receivedAt: '2026-10-31T09:00:00.000Z' };
  assert.deepEqual(evaluate([...bars.slice(0, 61), sameValues, ...bars.slice(61)]), evaluate(bars));
});
test('an older revision arriving after a correction is ignored', () => {
  const bars = fixtureBars(0);
  const corrected = { ...bars[60], closeMinor: bars[60].closeMinor + 10, revision: 2 };
  const withCorrection = evaluate([...bars.slice(0, 61), corrected]);
  const withStaleReplay = evaluate([...bars.slice(0, 61), corrected, bars[60]]);
  assert.deepEqual(withStaleReplay, withCorrection);
});
test('a decision records the provenance of the exact bar revision it used', () => {
  const bars = fixtureBars(0);
  const correction = {
    ...bars[65],
    closeMinor: bars[65].closeMinor + 10,
    revision: 2,
    receivedAt: '2026-10-31T09:00:00.000Z',
  };
  const decision = evaluate([...bars, correction]).at(-1)!;
  assert.equal(decision.revision, 2);
  assert.equal(decision.receivedAt, '2026-10-31T09:00:00.000Z');
  assert.equal(decision.provider, 'AllIn fixture v1');
  assert.equal(decision.venue, 'SIMULATED');
  assert.equal(decision.interval, '15m');
  assert.equal(decision.currency, 'USD');
});
test('identical fixture inputs produce identical evidence and rule decisions', () => {
  assert.deepEqual(marketFixtures(), marketFixtures());
  const results = evaluate(fixtureBars(0));
  assert.equal(
    results.slice(0, 49).every((d) => d.state === 'Signal unavailable'),
    true,
  );
  assert.equal(results[49].state, 'No trigger');
  assert.ok(results.some((d) => d.state === 'Buy setup'));
  assert.ok(results.every((d) => d.inputDigest.length === 64));
});
test('duplicate events never duplicate decisions', () => {
  const bars = fixtureBars(0);
  assert.deepEqual(evaluate(bars.flatMap((b) => [b, b])), evaluate(bars));
});
test('gaps and late corrections suppress signals and reset warm-up', () => {
  const bars = fixtureBars(0),
    gapped = bars.filter((_, i) => i !== 60);
  assert.equal(evaluate(gapped)[60].state, 'Signal unavailable');
  const corrected = evaluate([
    ...bars,
    { ...bars[65], closeMinor: bars[65].closeMinor + 10, revision: 2 },
  ]).at(-1)!;
  assert.equal(corrected.corrected, true);
  assert.equal(corrected.state, 'Signal unavailable');
  assert.equal(corrected.inputCount, 1);
});
test('invalid or unfinished bars cannot produce setups', () => {
  const bars = fixtureBars(0);
  const invalid = { ...bars[79], closeMinor: -1 };
  assert.equal(evaluate([...bars.slice(0, 79), invalid]).at(-1)?.state, 'Signal unavailable');
  assert.equal(evaluate([{ ...bars[0], receivedAt: bars[0].time }])[0].state, 'Signal unavailable');
});
