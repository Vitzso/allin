import {
  FEEDS,
  type AlpacaKey,
  type FeedBar,
  type FeedFailure,
  type FeedName,
  type FeedPrice,
  type FeedStatus,
  type FetchError,
  type FetchRequest,
  type FetchResult,
  type MarketAlert,
} from '../shared/feedSchema.ts';
import { deriveFeedState } from '../shared/feedViews.ts';
import type { Bar, MarketInstrument } from '../shared/fixtures.ts';
import { latestClosedBar, nextBarTime } from '../shared/marketCalendar.ts';
import { AppError } from './errors.ts';
import {
  LATE_MS,
  SETTLE_MS,
  alertId,
  barRequest,
  barsStopped,
  isLiveBar,
  mergeBars,
  settledBars,
} from './feedBars.ts';
import { loadAlpacaKey, removeAlpacaKey as deleteAlpacaKey, saveAlpacaKey } from './feedKeys.ts';
import { failureFor, isTerminal, recordCrash, retryWait } from './feedPolicy.ts';
import type { FeedTransport } from './feedSandbox.ts';
import {
  calendarView,
  decisionsOf,
  readSnapshot,
  type FeedRun,
  type Held,
  type Kind,
} from './feedSnapshot.ts';
import type { MarketBatch } from './markets.ts';
import { marketFixtures } from './replay.ts';
import type { Vault } from './vault.ts';

const BAR_MS = 900_000,
  WAKE_MS = 5000,
  PRICE_EVERY_MS = 60_000,
  BAR_RETRY_MS = 60_000,
  SLEEP_MS = 90_000;
const NO_KEY = 'Enter your Alpaca key ID and secret.',
  KEY_REJECTED = 'Alpaca rejected this key. Check the key ID and secret.',
  NO_SANDBOX = "AllIn couldn't isolate the feed, so it stayed off.",
  UNREACHABLE = "AllIn couldn't reach Alpaca, so nothing was saved. Try again.",
  UNREADABLE = "Alpaca answered, but AllIn couldn't read the answer, so the key wasn't saved.",
  BUSY = 'AllIn is already checking an Alpaca key.',
  CHANGED = 'Alpaca was changed while the key was being checked. Try again.';

const iso = (ms: number) => new Date(ms).toISOString();
const sameKey = (a: AlpacaKey | null, b: AlpacaKey | null) =>
  a === b || (a !== null && b !== null && a.keyId === b.keyId && a.secret === b.secret);
const emptyBatch = (): MarketBatch => ({ bars: [], alerts: [], corrections: [] });
const errorType = (error: unknown) =>
  (error instanceof Error ? error.constructor.name || error.name : 'Error').replace(/[^\w-]/g, '');
const newRun = (name: FeedName, enabled = false, generation = 0): FeedRun => ({
  name,
  enabled,
  generation,
  failure: null,
  failures: 0,
  lastFailureAt: -Infinity,
  retryAt: 0,
  crashes: [],
  lastCrashAt: -Infinity,
  reconciled: false,
  epoch: 0,
  awaiting: null,
  firstReconciledAt: null,
  checked: new Map(),
  inflight: { prices: null, bars: null },
  lastStart: { prices: -Infinity, bars: -Infinity },
  barsTarget: null,
  lastBarsOkAt: null,
  quietAfter: null,
});

/** Whether the newest held bar before `bar` is the one the calendar puts right before it. */
function followsHeld(held: Bar[], bar: Bar): boolean {
  const time = Date.parse(bar.time);
  for (let i = held.length - 1; i >= 0; i--) {
    const previous = Date.parse(held[i].time);
    if (previous < time) return nextBarTime(previous, bar.calendar) === time;
  }
  return false;
}
function holds(bars: Bar[], time: number): boolean {
  for (let i = bars.length - 1; i >= 0 && Date.parse(bars[i].time) >= time; i--)
    if (Date.parse(bars[i].time) === time) return true;
  return false;
}
function keyTestError(result: FetchResult): AppError {
  // Alpaca answered something other than bars: a refusal such as a 400, 404, or 422, a body that
  // fails the schema or is too large, or an answer of the wrong kind.
  if (result.ok) return new AppError(502, UNREADABLE);
  if (result.error === 'unauthorized') return new AppError(400, KEY_REJECTED);
  if (result.error === 'isolation') return new AppError(503, NO_SANDBOX);
  if (result.error === 'malformed' || result.error === 'too-large')
    return new AppError(502, UNREADABLE);
  return new AppError(502, UNREACHABLE);
}

export class FeedSupervisor {
  private readonly vault: Vault;
  private readonly transport: FeedTransport;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly log: (line: string) => void;
  private readonly replay = marketFixtures();
  private readonly runs: Record<FeedName, FeedRun> = {
    coinbase: newRun('coinbase'),
    alpaca: newRun('alpaca'),
  };
  private readonly held = new Map<string, Held>();
  private pending: MarketBatch = emptyBatch(); // written at the next wake with the vault open
  private key: AlpacaKey | null = null; // the stored key
  private sentKey: AlpacaKey | null = null; // the key the worker holds
  // The Alpaca key test running, if any. Only one runs at a time. Turning Alpaca off or removing
  // the key supersedes it; a purge doesn't, since it only removes data.
  private keyTest: { superseded: boolean } | null = null;
  private loaded = false;
  private lastWake: number | null = null;
  private lastProblem: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tokens = 0;

  constructor(deps: {
    vault: Vault;
    transport: FeedTransport;
    now?: () => number;
    tickMs?: number;
    log?: (line: string) => void;
  }) {
    this.vault = deps.vault;
    this.transport = deps.transport;
    this.now = deps.now ?? Date.now;
    this.tickMs = deps.tickMs ?? WAKE_MS;
    this.log = deps.log ?? console.error;
    for (const feed of ['coinbase', 'alpaca'] as const)
      for (const symbol of FEEDS[feed].symbols)
        this.held.set(symbol, {
          symbol,
          feed,
          bars: [],
          price: null,
          priceAt: null,
          paused: false,
        });
  }

  start(): void {
    if (this.timer || this.tickMs <= 0) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.problem(`AllIn: feed wake failed: ${errorType(error)}`));
    }, this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const run of this.list()) {
      run.generation++;
      run.inflight = { prices: null, bars: null };
    }
    if (this.loaded && this.vault.unlocked) this.flush();
    this.transport.stop();
  }

  /** One wake, awaiting the requests it started. */
  async tick(): Promise<void> {
    const now = this.now();
    this.sync();
    // Wakes this far apart mean the Mac slept or the process stalled.
    if (this.lastWake !== null && now - this.lastWake > SLEEP_MS)
      for (const run of this.list())
        if (run.enabled) {
          this.unreconcile(run);
          run.retryAt = 0;
        }
    this.lastWake = now;
    const generations = this.list().map((run) => run.generation);
    const due: { run: FeedRun; kind: Kind; token: number; generation: number }[] = [];
    for (const run of this.list())
      for (const kind of this.dueKinds(run, now)) {
        const token = ++this.tokens;
        run.inflight[kind] = { token, startedAt: now };
        due.push({ run, kind, token, generation: run.generation });
      }
    if (!due.length) return;
    const proven = await this.transport.ready().catch(() => false);
    if (proven !== true) {
      for (const { run, kind, token } of due)
        if (run.inflight[kind]?.token === token) run.inflight[kind] = null;
      // The server stopped the worker before it proved itself, as clearing the key does. That
      // says nothing about isolation, and the next wake starts a fresh worker.
      if (proven === null) return;
      // Isolation can't be proven, and one worker serves both feeds, so every enabled feed is
      // latched. Nothing starts again until it is toggled.
      this.list().forEach((run, i) => {
        if (run.enabled && run.generation === generations[i]) this.fail(run, 'isolation', now, now);
      });
      return;
    }
    await Promise.all(due.map((entry) => this.request(entry)));
  }

  setCoinbase(enabled: boolean): void {
    this.open();
    this.vault.markets.setEnabled('coinbase', enabled, new Date(this.now()));
    this.toggle(this.runs.coinbase, enabled);
  }

  /** Turning on tries the key with one bar request, and stores it only if that succeeds. */
  async setAlpaca(input: { enabled: boolean; key?: AlpacaKey }): Promise<void> {
    this.open();
    const run = this.runs.alpaca;
    if (!input.enabled) {
      this.supersedeKeyTest();
      this.vault.markets.setEnabled('alpaca', false, new Date(this.now()));
      return this.toggle(run, false);
    }
    if (this.keyTest) throw new AppError(409, BUSY);
    const key = input.key ?? this.key;
    if (!key) throw new AppError(400, NO_KEY);
    const test = { superseded: false };
    this.keyTest = test;
    try {
      const proven = await this.transport.ready().catch(() => false);
      if (test.superseded) throw new AppError(409, CHANGED);
      if (proven === false) throw new AppError(503, NO_SANDBOX);
      // Stopped before it proved itself, as quitting does: the key was never tried.
      if (proven === null) throw new AppError(502, UNREACHABLE);
      this.useKey(key);
      const request: FetchRequest = {
        feed: 'alpaca',
        kind: 'bars',
        symbols: [...FEEDS.alpaca.symbols],
        ...barRequest('alpaca', this.lastKnown(run), this.now()),
      };
      const result = await this.transport
        .fetch(request)
        .catch((): FetchResult => ({ ok: false, error: 'network' }));
      // Turned off or the key removed meanwhile: the result is discarded, whatever it was.
      if (test.superseded) throw new AppError(409, CHANGED);
      if (!result.ok || !('bars' in result)) throw keyTestError(result);
      if (input.key) saveAlpacaKey(this.vault, key);
      this.key = key;
      this.vault.markets.setEnabled('alpaca', true, new Date(this.now()));
      this.toggle(run, true);
    } finally {
      this.keyTest = null;
      // Whatever happened, the worker holds the key that is current now.
      this.useKey(this.key);
      this.stopIfIdle();
    }
  }

  removeAlpacaKey(): void {
    this.open();
    const run = this.runs.alpaca;
    this.supersedeKeyTest();
    try {
      // Off in the vault first, so a key store that fails to delete can't leave the next launch
      // starting Alpaca with no key.
      if (run.enabled) this.vault.markets.setEnabled('alpaca', false, new Date(this.now()));
      deleteAlpacaKey(this.vault);
    } finally {
      // Whatever failed above, the key leaves memory and the worker, and the feed stops.
      this.key = null;
      if (run.enabled) this.toggle(run, false);
      this.useKey(null);
    }
  }

  purge(): void {
    this.open();
    this.vault.markets.purge();
    this.pending = emptyBatch();
    for (const held of this.held.values()) this.setBars(held, []);
    for (const run of this.list()) {
      run.generation++;
      run.inflight = { prices: null, bars: null };
      run.checked.clear();
      run.lastBarsOkAt = null;
      this.unreconcile(run);
    }
  }

  dismiss(input: unknown): void {
    this.open();
    this.flush();
    this.vault.markets.dismiss(input, new Date(this.now()));
  }

  /** Needs the vault unlocked. */
  snapshot(): { instruments: MarketInstrument[]; feeds: FeedStatus[]; alerts: MarketAlert[] } {
    this.open();
    this.flush();
    return readSnapshot({
      runs: this.runs,
      held: this.held,
      replay: this.replay,
      alerts: () => this.vault.markets.alerts(),
      hasKey: this.key !== null,
      now: this.now(),
    });
  }

  private list(): FeedRun[] {
    return [this.runs.coinbase, this.runs.alpaca];
  }
  private heldOf(run: FeedRun): Held[] {
    return FEEDS[run.name].symbols.map((symbol) => this.held.get(symbol)!);
  }
  private setBars(held: Held, bars: Bar[]): void {
    held.bars = bars;
    held.decisions = undefined;
    held.window = undefined;
  }
  // A save or load problem is logged once until it clears, rather than at every wake.
  private problem(line: string): void {
    if (line !== this.lastProblem) this.log(line);
    this.lastProblem = line;
  }

  // Every public change and read needs the vault open, checked before anything changes: the key
  // store and the activity log must never get out of step.
  private open(): void {
    if (!this.vault.unlocked) throw new AppError(401, 'Unlock your vault to continue.');
    this.ensureLoaded();
  }
  // Once, at the first unlock: settings, bars, and the key.
  private ensureLoaded(): void {
    if (this.loaded) return;
    const markets = this.vault.markets; // a locked vault refuses here
    const settings = markets.settings();
    const bars = [...this.held.keys()].map((symbol) => [symbol, markets.bars(symbol)] as const);
    const key = loadAlpacaKey(this.vault);
    for (const [symbol, list] of bars) this.setBars(this.held.get(symbol)!, list);
    this.key = key;
    this.useKey(key);
    for (const run of this.list()) if (settings[run.name]) this.toggle(run, true);
    // On, with no key that could be read: nothing is sent until a key is entered or it's toggled.
    if (settings.alpaca && key === null) this.runs.alpaca.failure = 'key-missing';
    this.loaded = true;
  }
  private sync(): void {
    if (!this.vault.unlocked) return;
    try {
      this.ensureLoaded();
    } catch (error) {
      return this.problem(`AllIn: feed load failed: ${errorType(error)}`);
    }
    this.flush();
  }
  private flush(): void {
    const batch = this.pending;
    if (!batch.bars.length && !batch.alerts.length && !batch.corrections.length) return;
    try {
      this.vault.markets.saveBatch(batch);
      this.pending = emptyBatch();
      this.lastProblem = null;
    } catch (error) {
      this.problem(`AllIn: feed save failed: ${errorType(error)}`); // the batch stays for next time
    }
  }

  private toggle(run: FeedRun, enabled: boolean): void {
    Object.assign(run, newRun(run.name, enabled, run.generation + 1));
    for (const held of this.heldOf(run)) {
      held.price = null;
      held.priceAt = null;
      held.paused = false;
    }
    this.stopIfIdle();
  }
  // The worker stops once no feed will send it anything: each is off or failing for good. Never
  // while a key test is using it; the test checks again when it ends.
  private stopIfIdle(): void {
    if (this.keyTest) return;
    if (this.list().every((run) => !run.enabled || isTerminal(run.failure))) this.transport.stop();
  }
  private supersedeKeyTest(): void {
    if (this.keyTest) this.keyTest.superseded = true;
  }
  private useKey(key: AlpacaKey | null): void {
    if (sameKey(key, this.sentKey)) return;
    this.sentKey = key;
    this.transport.setCredentials(key);
  }
  // Catching up starts at the next wake the retry wait allows.
  private unreconcile(run: FeedRun): void {
    run.reconciled = false;
    run.epoch++;
    run.awaiting = null;
    run.barsTarget = null;
    run.quietAfter = null;
  }

  private dueKinds(run: FeedRun, now: number): Kind[] {
    if (!run.enabled || now < run.retryAt || isTerminal(run.failure)) return [];
    // While a key is being tried, Alpaca sends nothing else.
    if (run.name === 'alpaca' && this.keyTest) return [];
    // Past calendar coverage the market never reads open and no bar is due, so nothing goes out.
    const view = calendarView(run, now);
    const kinds: Kind[] = [];
    if (run.inflight.prices === null && view.open && now - run.lastStart.prices >= PRICE_EVERY_MS)
      kinds.push('prices');
    // A bar missing from a successful answer is asked for again at most once a minute. Once a
    // session is over and an answer left nothing to wait for, none goes out until the next is due.
    if (
      run.inflight.bars === null &&
      view.due !== null &&
      view.due !== run.quietAfter &&
      (!run.reconciled || this.unchecked(run, view.due)) &&
      (view.due !== run.barsTarget || now - run.lastStart.bars >= BAR_RETRY_MS)
    )
      kinds.push('bars');
    return kinds;
  }
  private unchecked(run: FeedRun, due: number): boolean {
    return FEEDS[run.name].symbols.some((symbol) => (run.checked.get(symbol) ?? -Infinity) < due);
  }
  // The oldest of each symbol's newest known bar, so one request catches every symbol up.
  private lastKnown(run: FeedRun): string | null {
    let oldest = Infinity;
    for (const held of this.heldOf(run)) {
      const newest = held.bars.at(-1);
      const known = Math.max(
        newest ? Date.parse(newest.time) : -Infinity,
        run.checked.get(held.symbol) ?? -Infinity,
      );
      oldest = Math.min(oldest, known);
    }
    return Number.isFinite(oldest) ? iso(oldest) : null;
  }

  private async request(entry: {
    run: FeedRun;
    kind: Kind;
    token: number;
    generation: number;
  }): Promise<void> {
    const { run, kind, token, generation } = entry;
    if (run.generation !== generation) return;
    const startedAt = this.now();
    const epoch = run.epoch;
    if (run.inflight[kind]?.token === token) run.inflight[kind] = { token, startedAt };
    const symbols = [...FEEDS[run.name].symbols];
    let request: FetchRequest;
    if (kind === 'prices') request = { feed: run.name, kind, symbols };
    else {
      run.barsTarget = latestClosedBar(startedAt - SETTLE_MS, FEEDS[run.name].calendar);
      request = {
        feed: run.name,
        kind,
        symbols,
        ...barRequest(run.name, this.lastKnown(run), startedAt),
      };
    }
    run.lastStart[kind] = startedAt;
    const result = await this.transport
      .fetch(request)
      .catch((): FetchResult => ({ ok: false, error: 'network' }));
    if (run.generation !== generation) return; // turned off or purged meanwhile: dropped
    if (run.inflight[kind]?.token === token) run.inflight[kind] = null;
    // Settling and freshness go by when the provider was asked. Only isLiveBar and receipt
    // times use the arrival time.
    const arrived = this.now();
    if (!result.ok)
      return this.fail(run, result.error, startedAt, arrived, result.retryAfterSeconds);
    if (kind === 'bars' && 'bars' in result)
      return this.onBars(run, symbols, result.bars, { startedAt, epoch }, arrived);
    if (kind === 'prices' && 'prices' in result) {
      this.onPrices(symbols, result.prices, startedAt);
      if (run.awaiting === token) this.markReconciled(run, arrived);
      return;
    }
    this.fail(run, 'malformed', startedAt, arrived); // an answer of the wrong kind
  }

  private fail(
    run: FeedRun,
    error: FetchError,
    startedAt: number,
    now: number,
    retryAfterSeconds?: number,
  ): void {
    if (isTerminal(run.failure)) return; // already stopped: a late answer changes nothing
    this.log(`AllIn: feed ${run.name} failed: ${error}`);
    this.unreconcile(run);
    const latch = (failure: FeedFailure) => {
      run.failure = failure;
      this.stopIfIdle();
    };
    const failure = failureFor(run.name, error);
    if (failure && isTerminal(failure)) return latch(failure);
    if (error === 'worker-crashed') {
      // One worker serves both feeds, so a crash puts both back to catching up.
      for (const other of this.list()) if (other.enabled) this.unreconcile(other);
      // Requests already in flight when a crash was counted died with it, so they don't add.
      if (startedAt > run.lastCrashAt) {
        run.lastCrashAt = now;
        const counted = recordCrash(run.crashes, now);
        run.crashes = counted.crashes;
        if (counted.stop) return latch('worker-crashes');
      }
    }
    if (failure) run.failure = failure;
    // Price and bar requests failing in one outage count as one step.
    if (startedAt > run.lastFailureAt) {
      run.failures++;
      run.lastFailureAt = now;
    }
    run.retryAt = Math.max(run.retryAt, now + retryWait(run.failures, retryAfterSeconds));
  }

  // A quote is as fresh as the request that asked for it.
  private onPrices(symbols: string[], prices: FeedPrice[], askedAt: number): void {
    for (const price of prices) {
      if (!symbols.includes(price.symbol)) continue; // not asked for
      const held = this.held.get(price.symbol)!;
      if (held.priceAt !== null && held.priceAt > askedAt) continue; // a newer quote is held
      held.price = price.priceMinor;
      held.priceAt = askedAt;
      held.paused = price.paused;
    }
  }

  private onBars(
    run: FeedRun,
    symbols: string[],
    rows: FeedBar[],
    asked: { startedAt: number; epoch: number },
    now: number,
  ): void {
    // Live when this poll went out, and nothing has disrupted the feed since.
    const reconciledBeforePoll = run.reconciled && asked.epoch === run.epoch;
    const receivedAt = iso(now);
    // A row is settled only if it had settled when the provider was asked.
    const settled = settledBars(rows, FEEDS[run.name].calendar, asked.startedAt);
    // Only the symbols asked for are merged, so a row for any other is dropped.
    for (const symbol of symbols) {
      const held = this.held.get(symbol)!;
      const before = held.bars;
      const own = settled.filter((row) => row.symbol === symbol);
      const { bars, added, corrected } = mergeBars(before, own, run.name, receivedAt);
      if (!added.length && !corrected.length) continue;
      this.setBars(held, bars);
      this.pending.bars.push(...added, ...corrected);
      for (const bar of corrected)
        this.pending.corrections.push({ symbol, time: bar.time, at: receivedAt });
      for (const bar of added) {
        const previousHeldBeforePoll = followsHeld(before, bar);
        if (
          isLiveBar({ reconciledBeforePoll, bar, previousHeldBeforePoll, now }) &&
          this.liveAtClose(run, held, bar)
        )
          this.raise(held, bar, receivedAt);
      }
    }
    this.reconcile(run, symbols, asked, now);
    run.lastBarsOkAt = Math.max(run.lastBarsOkAt ?? -Infinity, asked.startedAt);
  }

  // "Live when the poll began", judged as of the bar's close: the market counts as open and the
  // price age is measured at the close, so a setup on a session's last bar can still alert.
  private liveAtClose(run: FeedRun, held: Held, bar: Bar): boolean {
    const close = Date.parse(bar.time) + BAR_MS;
    const priceAt = held.priceAt ?? run.firstReconciledAt;
    return (
      deriveFeedState({
        enabled: run.enabled,
        failure: calendarView(run, close).failure,
        reconciled: run.reconciled,
        failures: run.failures,
        marketOpen: true,
        priceAgeMs: priceAt === null ? null : Math.max(0, close - priceAt),
        barLateMs: 0,
        paused: held.paused,
        barsStopped: false,
      }) === 'live'
    );
  }

  private raise(held: Held, bar: Bar, alertedAt: string): void {
    const decision = decisionsOf(held).findLast(
      (d) => d.time === bar.time && d.revision === bar.revision,
    );
    if (!decision || (decision.state !== 'Buy setup' && decision.state !== 'Sell setup')) return;
    if (decision.fast === null || decision.slow === null) return;
    const id = alertId(decision);
    if (this.pending.alerts.some((a) => a.id === id)) return;
    this.pending.alerts.push({
      id,
      symbol: decision.symbol,
      time: decision.time,
      state: decision.state,
      provider: decision.provider,
      venue: decision.venue,
      closeMinor: decision.closeMinor,
      fast: decision.fast,
      slow: decision.slow,
      reason: decision.reason,
      ruleVersion: decision.version,
      alertedAt,
      dismissedAt: null,
      correctedAt: null,
    });
  }

  // Reconciled once every symbol holds the newest bar due when the request went out, or that bar
  // was over 5 minutes late by then, and no unpaused symbol's bars stopped. Not from an answer of
  // an older epoch, and not while a price request that went out at or before it is still out:
  // that one has to succeed first.
  private reconcile(
    run: FeedRun,
    symbols: string[],
    asked: { startedAt: number; epoch: number },
    now: number,
  ): void {
    const calendar = FEEDS[run.name].calendar;
    const due = latestClosedBar(asked.startedAt - SETTLE_MS, calendar);
    if (due === null) return;
    const late = asked.startedAt - (due + BAR_MS) > LATE_MS;
    let stopped = false,
      waiting = false;
    for (const symbol of symbols) {
      const { bars, paused } = this.held.get(symbol)!;
      // A paused symbol is left out: its row reads paused, and the feed's other symbol carries on.
      if (!paused && barsStopped(bars.at(-1)?.time, calendar, asked.startedAt)) stopped = true;
      else if (late || holds(bars, due))
        run.checked.set(symbol, Math.max(run.checked.get(symbol) ?? -Infinity, due));
      else if ((run.checked.get(symbol) ?? -Infinity) < due) waiting = true; // asked for again
    }
    // The answer succeeded, but a symbol's bars stopped. Its row reads stale while the market is
    // open, and the feed stays unreconciled, so nothing alerts until its bars come back. Until the
    // session's last bar settles, bars are still asked for each minute. After it, the first answer
    // that leaves no other bar to wait for is the last until the next session's first bar is due.
    if (stopped) {
      run.reconciled = false;
      run.awaiting = null;
      const sessionOver = nextBarTime(due, calendar) !== due + BAR_MS;
      if (sessionOver && !waiting && asked.epoch === run.epoch) run.quietAfter = due;
      return;
    }
    if (this.unchecked(run, due) || asked.epoch !== run.epoch) return;
    const prices = run.inflight.prices;
    if (prices && prices.startedAt <= asked.startedAt) {
      run.awaiting = prices.token;
      return;
    }
    this.markReconciled(run, now);
  }
  private markReconciled(run: FeedRun, now: number): void {
    run.awaiting = null;
    run.reconciled = true;
    run.firstReconciledAt ??= now;
    run.failures = 0;
    if (run.failure === 'unexpected-response') run.failure = null;
  }
}
