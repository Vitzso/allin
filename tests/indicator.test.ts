import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, marketFixtures, ruleOverview, setupOutcomes } from '../server/replay.ts';
import { fixtureBars, type Bar, type Decision } from '../shared/fixtures.ts';

const withoutIndex = <T>(list: T[], index: number) => list.filter((_, i) => i !== index);

test('an unfinished bar does not restart warm-up or block its final delivery', () => {
  const bars = fixtureBars(0);
  const partial = { ...bars[61], receivedAt: bars[61].time };
  const decisions = evaluate([...bars.slice(0, 61), partial, ...bars.slice(61)]);
  assert.equal(decisions[61].state, 'Signal unavailable');
  assert.equal(decisions[61].inputCount, 61);
  assert.deepEqual(withoutIndex(decisions, 61), evaluate(bars));
});
test('repeated deliveries of the same unfinished bar add one entry', () => {
  const bars = fixtureBars(0);
  const partial = { ...bars[61], receivedAt: bars[61].time };
  const decisions = evaluate([...bars.slice(0, 61), partial, partial, ...bars.slice(61)]);
  assert.equal(decisions.length, bars.length + 1);
});
test('an unreadable receipt time counts as not yet closed, so it cannot signal', () => {
  const bars = fixtureBars(0);
  const decision = evaluate([...bars.slice(0, 61), { ...bars[61], receivedAt: 'nonsense' }]).at(
    -1,
  )!;
  assert.equal(decision.state, 'Signal unavailable');
  assert.equal(decision.inputCount, 61);
});
test('a continuous-market bar off the 15-minute grid is rejected', () => {
  const bar = {
    ...fixtureBars(0)[0],
    time: '2026-10-30T00:07:00.000Z',
    receivedAt: '2026-10-30T01:00:00.000Z',
  };
  assert.equal(evaluate([bar])[0].inputCount, 0);
});
test('a stale revision after a same-value revision bump is ignored', () => {
  const bars = fixtureBars(0);
  const bump = { ...bars[60], revision: 3 };
  const stale = { ...bars[60], closeMinor: bars[60].closeMinor + 5, revision: 2 };
  assert.deepEqual(
    evaluate([...bars.slice(0, 61), bump, stale, ...bars.slice(61)]),
    evaluate(bars),
  );
});
test('a feed that never bumps revisions can redeliver the original value after a correction', () => {
  const bars = fixtureBars(0);
  const corrected = { ...bars[60], closeMinor: bars[60].closeMinor + 10 };
  const once = evaluate([...bars.slice(0, 61), corrected]);
  assert.deepEqual(evaluate([...bars.slice(0, 61), corrected, bars[60]]), once);
});
test('a higher revision returning to an earlier value is still a correction', () => {
  const bars = fixtureBars(0);
  const corrected = { ...bars[60], closeMinor: bars[60].closeMinor + 10, revision: 2 };
  const reverted = { ...bars[60], revision: 3 };
  assert.equal(evaluate([...bars.slice(0, 61), corrected, reverted]).at(-1)!.corrected, true);
});
test('each reason for an unavailable signal is explained separately', () => {
  const bars = fixtureBars(0);
  const gap = evaluate(withoutIndex(bars, 60))[60].reason;
  const correction = evaluate([
    ...bars.slice(0, 61),
    { ...bars[60], closeMinor: bars[60].closeMinor + 10, revision: 2 },
  ]).at(-1)!.reason;
  const badPrice = evaluate([{ ...bars[0], closeMinor: -1 }])[0].reason;
  const outside = evaluate([{ ...bars[0], calendar: 'us-equity-regular' as const }])[0].reason;
  assert.match(gap, /missing/i);
  assert.match(correction, /corrected/i);
  assert.match(badPrice, /price/i);
  assert.match(outside, /session|calendar/i);
  assert.equal(new Set([gap, correction, badPrice, outside]).size, 4);
});
test('the evidence digest depends on every earlier bar in the run', () => {
  const bars = fixtureBars(0);
  const changed = bars.map((b, i) => (i === 10 ? { ...b, closeMinor: b.closeMinor + 1 } : b));
  assert.notEqual(evaluate(bars)[60].inputDigest, evaluate(changed)[60].inputDigest);
  assert.equal(evaluate(bars)[60].inputDigest, evaluate(bars)[60].inputDigest);
});
test('a long run is evaluated in linear time', () => {
  const template = fixtureBars(3)[0];
  const start = Date.parse('2026-01-01T00:00:00Z');
  const bars = Array.from({ length: 20000 }, (_, i) => ({
    ...template,
    time: new Date(start + i * 900000).toISOString(),
    receivedAt: new Date(start + (i + 1) * 900000).toISOString(),
    closeMinor: 100000 + (i % 500),
  }));
  const began = performance.now();
  assert.equal(evaluate(bars).length, 20000);
  assert.ok(performance.now() - began < 5000);
});

// The published claim that setups also appear in pure noise.
test('the rule fires regularly on random prices, as the rule notes state', () => {
  const template = fixtureBars(3)[0];
  const start = Date.parse('2026-01-01T00:00:00Z');
  let setups = 0;
  const runs = 20;
  for (let run = 0; run < runs; run++) {
    let seed = run + 1;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let price = 10000000;
    const bars = Array.from({ length: 2880 }, (_, i) => {
      price *=
        1 +
        0.002 *
          Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) *
          Math.cos(2 * Math.PI * random());
      return {
        ...template,
        time: new Date(start + i * 900000).toISOString(),
        receivedAt: new Date(start + (i + 1) * 900000).toISOString(),
        closeMinor: Math.round(price),
      };
    });
    setups += evaluate(bars).filter((d) => d.state.endsWith('setup')).length;
  }
  const perMonth = setups / runs;
  assert.ok(perMonth > 40 && perMonth < 75, `${perMonth} setups per 30 days`);
});

const decision = (overrides: Partial<Decision>): Decision => ({
  id: 'd',
  symbol: 'TEST',
  time: '2026-10-30T00:00:00.000Z',
  state: 'No trigger',
  provider: 'p',
  venue: 'v',
  currency: 'USD',
  interval: '15m',
  revision: 1,
  receivedAt: '2026-10-30T00:15:00.000Z',
  closeMinor: 10000,
  fast: 2,
  slow: 1,
  previousFast: 2,
  previousSlow: 1,
  reason: '',
  version: 'v',
  inputCount: 60,
  inputDigest: '',
  corrected: false,
  ...overrides,
});
for (const [name, latest, want] of [
  ['above', { fast: 2, slow: 1 }, 'above'],
  ['below', { fast: 1, slow: 2 }, 'below'],
  ['level', { fast: 1, slow: 1 }, 'level'],
  ['unavailable', { state: 'Signal unavailable' as const, fast: 2, slow: 1 }, 'unavailable'],
] as const)
  test(`rule overview: EMA position ${name}`, () => {
    assert.equal(ruleOverview([decision(latest)]).position, want);
  });
test('rule overview finds the latest setup and how long ago it fired', () => {
  const overview = ruleOverview([
    decision({ id: 'a', state: 'Buy setup', time: 't1' }),
    decision({ id: 'b' }),
    decision({ id: 'c', state: 'Sell setup', time: 't3' }),
    decision({ id: 'd' }),
    decision({ id: 'e' }),
  ]);
  assert.deepEqual(overview.lastSetup, { state: 'Sell setup', time: 't3', barsAgo: 2 });
  assert.equal(overview.setups, 2);
});
test('rule overview with no setups and no decisions', () => {
  assert.equal(ruleOverview([decision({})]).lastSetup, null);
  assert.deepEqual(ruleOverview([]), { position: 'unavailable', lastSetup: null, setups: 0 });
});

const closes = (values: number[]): Bar[] =>
  values.map((closeMinor, i) => ({
    ...fixtureBars(0)[0],
    time: new Date(Date.parse('2026-10-30T00:00:00Z') + i * 900000).toISOString(),
    closeMinor,
  }));
test('setup outcomes report the later price move, and null when bars have not happened yet', () => {
  const values = Array.from({ length: 5 }, (_, i) => (i === 4 ? 10100 : 10000));
  const bars = closes(values);
  const outcomes = setupOutcomes(
    [decision({ id: 'buy', state: 'Buy setup', time: bars[0].time, closeMinor: 10000 })],
    bars,
  );
  assert.equal(outcomes.buy[0].bars, 4);
  assert.ok(Math.abs(outcomes.buy[0].changePercent! - 1) < 1e-9);
  assert.equal(outcomes.buy[1].bars, 16);
  assert.equal(outcomes.buy[1].changePercent, null);
});
test('setup outcomes use the latest revision of a later bar and skip non-setups', () => {
  const bars = closes([10000, 10000, 10000, 10000, 10100]);
  const revised = { ...bars[4], closeMinor: 9900, revision: 2 };
  const outcomes = setupOutcomes(
    [
      decision({ id: 'sell', state: 'Sell setup', time: bars[0].time, closeMinor: 10000 }),
      decision({ id: 'none', time: bars[1].time }),
    ],
    [...bars, revised],
  );
  assert.ok(Math.abs(outcomes.sell[0].changePercent! + 1) < 1e-9);
  assert.equal(outcomes.none, undefined);
});
test('market data sent to the page includes the overview and outcomes', () => {
  const market = marketFixtures()[0];
  assert.equal(
    market.overview.setups,
    market.decisions.filter((d) => d.state.endsWith('setup')).length,
  );
  assert.ok(market.overview.lastSetup);
  const setup = market.decisions.find((d) => d.state.endsWith('setup'))!;
  assert.equal(market.outcomes[setup.id].length, 2);
});
