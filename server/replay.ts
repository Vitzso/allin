import { createHash } from 'node:crypto';
import {
  fixtureBars,
  instruments,
  RULE,
  type Bar,
  type Decision,
  type MarketInstrument,
  type RuleOverview,
  type SetupOutcome,
} from '../shared/fixtures.ts';
import { isSessionBar, nextBarTime } from '../shared/marketCalendar.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const EMPTY_DIGEST = sha256('');
const isSetup = (state: Decision['state']) => state === 'Buy setup' || state === 'Sell setup';

export function evaluate(bars: Bar[]): Decision[] {
  const decisions: Decision[] = [];
  const seen = new Map<string, { current: string; revision: number; values: Set<string> }>();
  const unfinished = new Set<string>();
  let fast: number | null = null,
    slow: number | null = null,
    last: Bar | undefined,
    count = 0,
    // Each digest covers the previous one, so it depends on every bar in the current run.
    inputDigest = EMPTY_DIGEST;
  const record = (
    bar: Bar,
    fingerprint: string,
    state: Decision['state'],
    reason: string,
    corrected: boolean,
    previousFast: number | null,
    previousSlow: number | null,
  ) => {
    const identity = `${bar.provider}:${bar.venue}:${bar.symbol}:${bar.interval}:${bar.time}`;
    decisions.push({
      id: sha256(`${identity}:${fingerprint}:${RULE.version}:${inputDigest}`).slice(0, 24),
      symbol: bar.symbol,
      time: bar.time,
      state,
      provider: bar.provider,
      venue: bar.venue,
      currency: bar.currency,
      interval: bar.interval,
      revision: bar.revision,
      receivedAt: bar.receivedAt,
      closeMinor: bar.closeMinor,
      fast,
      slow,
      previousFast,
      previousSlow,
      reason,
      version: RULE.version,
      inputCount: count,
      inputDigest,
      corrected,
    });
  };
  for (const bar of bars) {
    const identity = `${bar.provider}:${bar.venue}:${bar.symbol}:${bar.interval}:${bar.time}`;
    // Only the market values identify a change. Receipt time and revision number differ when a
    // feed redelivers the same bar, for example after a reconnect.
    const fingerprint = sha256(
      JSON.stringify([bar.closeMinor, bar.volume, bar.currency, bar.assetClass]),
    );
    const time = Date.parse(bar.time);
    const badPrice = !Number.isSafeInteger(bar.closeMinor) || bar.closeMinor <= 0;
    const outsideSession = !isSessionBar(time, bar.calendar);
    const invalid = badPrice || outsideSession;

    // A bar that hasn't closed is not part of the run yet. It changes nothing, and its final
    // delivery is evaluated normally.
    if (!invalid && !(Date.parse(bar.receivedAt) >= time + 900000)) {
      const key = `${identity}:${fingerprint}`;
      if (!unfinished.has(key)) {
        unfinished.add(key);
        record(
          bar,
          fingerprint,
          'Signal unavailable',
          'This bar has not closed yet, so it was not evaluated.',
          false,
          fast,
          slow,
        );
      }
      continue;
    }

    const known = seen.get(identity);
    if (known) {
      if (known.current === fingerprint) {
        known.revision = Math.max(known.revision, bar.revision);
        continue;
      }
      if (bar.revision < known.revision) continue;
      if (bar.revision === known.revision && known.values.has(fingerprint)) continue;
    }
    const correction = !!known;
    const values = known?.values ?? new Set<string>();
    values.add(fingerprint);
    seen.set(identity, { current: fingerprint, revision: bar.revision, values });

    const gap =
      last &&
      (time !== nextBarTime(Date.parse(last.time), last.calendar) ||
        bar.symbol !== last.symbol ||
        bar.venue !== last.venue ||
        bar.provider !== last.provider ||
        bar.currency !== last.currency ||
        bar.calendar !== last.calendar ||
        bar.interval !== last.interval);
    const unavailable = invalid || gap || correction;
    if (unavailable) {
      fast = null;
      slow = null;
      count = 0;
      inputDigest = EMPTY_DIGEST;
    }
    const previousFast = fast,
      previousSlow = slow;
    if (!invalid) {
      fast = fast === null ? bar.closeMinor : bar.closeMinor * (2 / 21) + fast * (19 / 21);
      slow = slow === null ? bar.closeMinor : bar.closeMinor * (2 / 51) + slow * (49 / 51);
      count++;
      inputDigest = sha256(inputDigest + JSON.stringify(bar));
    }
    let state: Decision['state'] = 'Signal unavailable';
    let reason = badPrice
      ? 'This bar has an invalid price: warm-up restarted.'
      : outsideSession
        ? 'This bar is outside the market session or calendar coverage: warm-up restarted.'
        : correction
          ? 'This bar was corrected after it was first evaluated: warm-up restarted.'
          : gap
            ? 'An expected bar is missing or the data source changed: warm-up restarted.'
            : `Warm-up: ${count}/50 closed bars.`;
    if (!unavailable && count >= 50) {
      state = 'No trigger';
      reason = 'The fast and slow EMAs did not cross on this closed bar.';
      if (
        count > 50 &&
        previousFast !== null &&
        previousSlow !== null &&
        fast !== null &&
        slow !== null
      ) {
        if (previousFast <= previousSlow && fast > slow) {
          state = 'Buy setup';
          reason = 'EMA20 crossed above EMA50 on a closed bar.';
        } else if (previousFast >= previousSlow && fast < slow) {
          state = 'Sell setup';
          reason = 'EMA20 crossed below EMA50 on a closed bar.';
        }
      }
    }
    record(bar, fingerprint, state, reason, correction, previousFast, previousSlow);
    last = bar;
  }
  return decisions;
}

/** Where the rule stands now. A description of the rule's output, never a recommendation. */
export function ruleOverview(decisions: Decision[]): RuleOverview {
  const latest = decisions.at(-1);
  let position: RuleOverview['position'] = 'unavailable';
  if (
    latest &&
    latest.state !== 'Signal unavailable' &&
    latest.fast !== null &&
    latest.slow !== null
  )
    position = latest.fast > latest.slow ? 'above' : latest.fast < latest.slow ? 'below' : 'level';
  const setups = decisions.filter((d) => isSetup(d.state));
  const setup = setups.at(-1);
  return {
    position,
    setups: setups.length,
    lastSetup: setup
      ? {
          state: setup.state as 'Buy setup' | 'Sell setup',
          time: setup.time,
          barsAgo: decisions.length - 1 - decisions.lastIndexOf(setup),
        }
      : null,
  };
}

const OUTCOME_BARS = [4, 16];
/**
 * How the price moved after each setup. These are later results kept apart from the recorded
 * decision, and they are not used by the rule.
 */
export function setupOutcomes(decisions: Decision[], bars: Bar[]) {
  const latest = new Map<string, Bar>();
  for (const bar of bars) {
    const known = latest.get(bar.time);
    if (!known || bar.revision >= known.revision) latest.set(bar.time, bar);
  }
  const times = [...latest.keys()].sort();
  const outcomes: Record<string, SetupOutcome[]> = {};
  for (const decision of decisions) {
    if (!isSetup(decision.state)) continue;
    const index = times.indexOf(decision.time);
    outcomes[decision.id] = OUTCOME_BARS.map((count) => {
      const later = index < 0 ? undefined : latest.get(times[index + count]);
      return {
        bars: count,
        changePercent: later ? (later.closeMinor / decision.closeMinor - 1) * 100 : null,
      };
    });
  }
  return outcomes;
}

export function marketFixtures(): MarketInstrument[] {
  return instruments.map((instrument, index) => {
    const bars = fixtureBars(index);
    const decisions = evaluate(bars);
    return {
      ...instrument,
      bars,
      decisions,
      overview: ruleOverview(decisions),
      outcomes: setupOutcomes(decisions, bars),
      price: bars.at(-1)!.closeMinor / 100,
      change: (bars.at(-1)!.closeMinor / bars[0].closeMinor - 1) * 100,
      source: { kind: 'replay' },
    };
  });
}
