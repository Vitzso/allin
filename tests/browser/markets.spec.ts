import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type {
  FeedFailure,
  FeedName,
  FeedState,
  FeedStatus,
  MarketAlert,
  MarketSource,
} from '../../shared/feedSchema';
import type { Decision, MarketInstrument } from '../../shared/fixtures';
import { openVault } from './support';

const MIN = 60_000,
  BAR = 900_000;
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const goTo = (page: Page, name: string) =>
  nav(page).getByRole('button', { name, exact: true }).click();
const goPrivacy = (page: Page) =>
  page.getByRole('button', { name: 'Connections & privacy', exact: true }).first().click();
const feedOf = (symbol: string): FeedName => (symbol.endsWith('-USD') ? 'coinbase' : 'alpaca');

type Live = Extract<MarketSource, { kind: 'live' }>;
type Row = {
  state?: FeedState | 'replay';
  reason?: FeedFailure | null;
  lastUpdate?: string | null;
  lastBarAt?: string | null;
  bars?: boolean;
  volumes?: (i: number) => number;
};

/** The replay rows the server serves for preview, which the crafted bodies are built from. */
async function replayRows(page: Page): Promise<MarketInstrument[]> {
  return (await page.request.get('/api/demo/markets')).json();
}
const decisionKey = (d: Decision) =>
  `${d.provider}:${d.venue}:${d.symbol}:${d.interval}:${d.time}:${d.state}:${d.version}`;

/** One row as the server would return it for a feed that is on, with bars ending just now. */
function liveRow(base: MarketInstrument, row: Row = {}): MarketInstrument {
  if (row.state === 'replay') return base;
  const feed = feedOf(base.symbol);
  const provider = feed === 'coinbase' ? 'Coinbase' : 'Alpaca';
  const venue = feed === 'coinbase' ? 'Coinbase' : 'IEX';
  const delta = Math.floor(Date.now() / BAR) * BAR - BAR - Date.parse(base.bars.at(-1)!.time);
  const move = (time: string) => new Date(Date.parse(time) + delta).toISOString();
  const state = row.state ?? 'live';
  const source: Live = {
    kind: 'live',
    feed,
    provider,
    venue,
    state,
    reason: row.reason ?? null,
    lastUpdate:
      row.lastUpdate === undefined ? new Date(Date.now() - 40_000).toISOString() : row.lastUpdate,
    lastBarAt: row.lastBarAt ?? null,
  };
  if (row.bars === false)
    return {
      ...base,
      bars: [],
      decisions: [],
      outcomes: {},
      price: null,
      change: null,
      overview: { position: 'unavailable', setups: 0, lastSetup: null },
      source,
    };
  const volumes =
    row.volumes ?? ((i: number) => (feed === 'coinbase' ? 18 + (i % 7) * 4.5 : 90000 + i));
  return {
    ...base,
    bars: base.bars.map((b, i) => ({
      ...b,
      provider,
      venue,
      time: move(b.time),
      receivedAt: move(b.receivedAt),
      volume: volumes(i),
    })),
    decisions: base.decisions.map((d) => ({ ...d, provider, venue, time: move(d.time) })),
    outcomes: Object.fromEntries(base.decisions.map((d) => [d.id, base.outcomes[d.id] ?? []])),
    source,
  };
}
const alertFor = (
  decision: Decision,
  alertedAgoMin: number,
  extra: Partial<MarketAlert> = {},
): MarketAlert => ({
  id: decisionKey(decision),
  symbol: decision.symbol,
  time: decision.time,
  state: decision.state as 'Buy setup' | 'Sell setup',
  provider: decision.provider,
  venue: decision.venue,
  closeMinor: decision.closeMinor,
  fast: decision.fast ?? 0,
  slow: decision.slow ?? 0,
  reason: decision.reason,
  ruleVersion: decision.version,
  alertedAt: new Date(Date.now() - alertedAgoMin * MIN).toISOString(),
  dismissedAt: null,
  correctedAt: null,
  ...extra,
});
const statusOf = (feed: FeedName, state: FeedState = 'live'): FeedStatus => ({
  feed,
  enabled: state !== 'off',
  state,
  failure: null,
  hasKey: feed === 'alpaca',
  lastUpdate: null,
  lastBarAt: null,
});
const body = (
  instruments: MarketInstrument[],
  alerts: MarketAlert[] = [],
  feeds = [statusOf('coinbase'), statusOf('alpaca')],
) => ({ instruments, feeds, alerts });
const setups = (market: MarketInstrument) =>
  market.decisions.filter((d) => d.state === 'Buy setup' || d.state === 'Sell setup');

/** Serves whatever `serve.body` holds, so a test can change what the next read returns. */
async function serveMarkets(page: Page, serve: { body: unknown }) {
  await page.route('**/api/markets', (route) => route.fulfill({ json: serve.body }));
}
async function feedCall(page: Page, path: string, payload: unknown) {
  return page.evaluate(
    async ([path, payload]) => {
      const response = await fetch(`/api${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AllIn-CSRF': sessionStorage.getItem('allin.session-token') ?? '',
        },
        body: JSON.stringify(payload),
      });
      return response.status;
    },
    [path, payload] as const,
  );
}
const asset = (page: Page, symbol: string) =>
  page.locator('.asset-select', { hasText: symbol.replace('-USD', '') });
const pageText = (page: Page) => page.locator('body').innerText();
const SYNTHETIC = /synthetic|simulat/i;
const privacyRow = (page: Page, name: string) =>
  page.locator('.integration-row').filter({ hasText: name });

test.describe.serial('Live market feeds on Markets and Today', () => {
  test('with feeds off, Markets and Today read as replay, as today', async ({ page }) => {
    await openVault(page);
    await expect(
      page.locator('.watchlist-row .asset-name', { hasText: 'Synthetic replay' }),
    ).toHaveCount(5);
    await expect(page.getByText('Simulation only · Live monitoring is paused')).toBeVisible();
    await goTo(page, 'Markets');
    await expect(page.getByText('Replay mode', { exact: true })).toBeVisible();
    await expect(page.getByText(/Synthetic prices · Oct 30, 2026/)).toBeVisible();
    await expect(page.locator('.asset-select', { hasText: 'Synthetic replay' })).toHaveCount(5);
    await expect(page.getByText('over fixture')).toBeVisible();
    await expect(page.getByText('· Simulated venue')).toBeVisible();
    await expect(page.getByText('AllIn fixture v1 ·', { exact: false })).toBeVisible();
    await expect(
      page.getByText('Fixture instruments are fixed for this foundation release.'),
    ).toBeVisible();
    await expect(page.getByText('Prices here are synthetic.').first()).toBeVisible();
    await expect(page.getByText('Oct 30, 2026').first()).toBeVisible();
    await expect(page.locator('.market-alerts')).toHaveCount(0);
  });

  test('every row state shows its label on Markets and Today', async ({ page }) => {
    const rows = await replayRows(page);
    const serve = { body: {} as unknown };
    const set = (cases: Row[]) => (serve.body = body(rows.map((r, i) => liveRow(r, cases[i]))));
    // AAPL, NVDA, MSFT, BTC-USD, ETH-USD
    const rounds: [Row[], string[]][] = [
      [
        [
          { state: 'closed', lastBarAt: '2026-10-30T19:45:00.000Z' },
          { state: 'failing', reason: 'key-rejected' },
          { state: 'stale', lastUpdate: new Date(Date.now() - 6.5 * MIN).toISOString() },
          { state: 'live' },
          { state: 'paused' },
        ],
        [
          'Market closed · last close Fri 4:00 PM ET',
          'Feed failing · key rejected',
          'Stale · last update 6 min ago · signals paused',
          'Live · Coinbase · updated',
          'Trading paused on Coinbase',
        ],
      ],
      [
        [
          { state: 'live' },
          { state: 'stale', lastUpdate: null },
          { state: 'failing', reason: 'calendar' },
          { state: 'failing', reason: 'worker-crashes' },
          { state: 'replay' },
        ],
        [
          'Live · Alpaca · IEX only · updated',
          'Stale · no update yet · signals paused',
          'Market calendar needs updating',
          'Feed failing · restart AllIn or toggle the feed',
          'Synthetic replay',
        ],
      ],
      [
        [
          { state: 'catching-up' },
          { state: 'failing', reason: 'unexpected-response' },
          { state: 'failing', reason: 'isolation' },
          { state: 'catching-up' },
          { state: 'live' },
        ],
        [
          'Catching up · signals paused',
          'Feed failing · unexpected response',
          'Feed failing · isolation unavailable',
          'Catching up · signals paused',
          'Live · Coinbase',
        ],
      ],
    ];
    set(rounds[0][0]);
    await serveMarkets(page, serve);
    await openVault(page);
    for (const [cases, labels] of rounds) {
      set(cases);
      await goTo(page, 'Markets');
      const symbols = ['AAPL', 'NVDA', 'MSFT', 'BTC', 'ETH'];
      for (const [i, label] of labels.entries())
        await expect(asset(page, symbols[i])).toContainText(label);
      await goTo(page, 'Today');
      for (const [i, label] of labels.entries())
        await expect(page.locator('.watchlist-row', { hasText: symbols[i] })).toContainText(label);
    }
  });

  test('mixed rows: the banner counts them, and "synthetic" stays with replay rows', async ({
    page,
  }) => {
    const rows = await replayRows(page);
    const serve = {
      body: body(
        rows.map((r) => liveRow(r, { state: feedOf(r.symbol) === 'coinbase' ? 'live' : 'replay' })),
      ),
    };
    await serveMarkets(page, serve);
    await openVault(page);
    await goTo(page, 'Markets');
    await expect(page.locator('.info-banner')).toContainText('2 live · 3 replay');
    await expect(page.locator('.info-banner')).not.toContainText('Replay mode');
    await expect(page.locator('.watchlist-labels, .market-watch')).toContainText(
      'Synthetic replay',
    );
    await expect(asset(page, 'AAPL')).toContainText('Synthetic replay');
    await expect(asset(page, 'BTC')).not.toContainText(SYNTHETIC);
    // Selecting a live row, the chart is not called synthetic, and a replay row's still is.
    await asset(page, 'BTC').click();
    await expect(page.locator('.price-chart [role="img"]')).toHaveAccessibleName(
      /^BTC-USD closing prices over 20 hours$/,
    );
    // The rule overview's disclaimer follows the selected row, not the page.
    const overview = page.locator('.rule-overview');
    await expect(overview).toContainText('not financial advice');
    expect(await overview.innerText()).not.toMatch(SYNTHETIC);
    await asset(page, 'AAPL').click();
    await expect(page.locator('.price-chart [role="img"]')).toHaveAccessibleName(
      /synthetic closing prices/,
    );
    await expect(overview).toContainText('Prices here are synthetic.');
    // The watchlist note no longer speaks of fixtures once any row is live.
    await expect(page.getByText('This watchlist is fixed for now.')).toBeVisible();
    await expect(page.getByText('Fixture instruments')).toHaveCount(0);
    // Today's watchlist header says what the change and the trend cover, over stock and crypto
    // rows alike: the trend plots the newest 40 bars.
    await goTo(page, 'Today');
    await expect(page.locator('.watchlist-labels')).toContainText('CHANGE (80 BARS)');
    await expect(page.locator('.watchlist-labels')).not.toContainText(/20H CHANGE|REPLAY CHANGE/);
    await expect(page.locator('.watchlist-labels')).toContainText('TREND (40 BARS)');
    await expect(page.locator('.watchlist-labels')).not.toContainText(/20H TREND|10H TREND/);
    await goTo(page, 'Markets');
    // Every row live: neither word is anywhere on the page.
    serve.body = body(rows.map((r) => liveRow(r)));
    await goTo(page, 'Today');
    await goTo(page, 'Markets');
    await expect(page.locator('.info-banner')).toContainText('5 live');
    await expect(asset(page, 'BTC')).toContainText('Live · Coinbase');
    expect(await pageText(page)).not.toMatch(SYNTHETIC);
    await page.getByRole('button', { name: 'Strategy rules' }).click();
    expect(await page.getByRole('dialog').innerText()).not.toMatch(SYNTHETIC);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await expect(page.getByText('Fixture instruments')).toHaveCount(0);
    await expect(page.getByText('This watchlist is fixed for now.')).toBeVisible();
    // The watchlist columns, on Today, follow the rows too.
    await goTo(page, 'Today');
    await expect(page.getByText('CHANGE (80 BARS)')).toBeVisible();
    await expect(page.getByText('20H CHANGE')).toHaveCount(0);
    await expect(page.getByText('REPLAY CHANGE')).toHaveCount(0);
    await expect(page.getByText('TREND (40 BARS)')).toBeVisible();
    await expect(page.getByText(/[12]0H TREND/)).toHaveCount(0);
    serve.body = body(rows.map((r) => liveRow(r, { state: 'replay' })));
    await goTo(page, 'Markets');
    await goTo(page, 'Today');
    await expect(page.getByText('REPLAY CHANGE')).toBeVisible();
    await expect(page.getByText('CHANGE (80 BARS)')).toHaveCount(0);
    // Every row replay: the trend's 40 bars of 15 minutes are 10 hours.
    await expect(page.getByText('10H TREND')).toBeVisible();
    await expect(page.getByText(/20H TREND|TREND \(40 BARS\)/)).toHaveCount(0);
  });

  test('a feed on with no data yet shows a waiting message, and no price', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const rows = await replayRows(page);
    const serve = {
      body: body(
        rows.map((r) =>
          liveRow(r, r.symbol === 'BTC-USD' ? { state: 'catching-up', bars: false } : {}),
        ),
      ),
    };
    await serveMarkets(page, serve);
    await openVault(page);
    await expect(page.locator('.watchlist-row', { hasText: 'BTC' })).toContainText('Catching up');
    await expect(page.locator('.watchlist-row', { hasText: 'BTC' })).toContainText('—');
    await goTo(page, 'Markets');
    await asset(page, 'BTC').click();
    await expect(page.getByText('Waiting for the first data from this feed')).toBeVisible();
    const text = await pageText(page);
    expect(text).not.toContain('$0.00');
    expect(text).not.toContain('NaN');
    await expect(page.locator('.chart-stats')).toContainText('—');
    await expect(asset(page, 'BTC')).toContainText('—');
    // The other rows still work, and so does the waiting row after them.
    await asset(page, 'ETH').click();
    await expect(page.getByText('Waiting for the first data from this feed')).toHaveCount(0);
    await expect(page.locator('.price-chart [role="img"]')).toBeVisible();
    await asset(page, 'BTC').click();
    await expect(page.getByText('Waiting for the first data from this feed')).toBeVisible();
    // The page keeps reading, and the first data replaces the message.
    serve.body = body(rows.map((r) => liveRow(r)));
    await goTo(page, 'Today');
    await goTo(page, 'Markets');
    await expect(page.getByText('Waiting for the first data from this feed')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('real volumes draw visible bars, and dates are real', async ({ page }) => {
    const rows = await replayRows(page);
    await serveMarkets(page, { body: body(rows.map((r) => liveRow(r))) });
    await openVault(page);
    await goTo(page, 'Markets');
    await asset(page, 'BTC').click();
    const heights = await page.locator('.volume-chart > span').evaluateAll((spans) =>
      spans.map((s) => ({
        style: (s as HTMLElement).style.height,
        px: s.getBoundingClientRect().height,
      })),
    );
    expect(heights).toHaveLength(80);
    const tallest = heights.find((h) => h.style === '100%')!;
    expect(tallest).toBeTruthy();
    expect(tallest.px).toBeGreaterThan(20);
    // Volumes run from 18 to 45, so the smallest bar is 40% of the tallest.
    expect(Math.min(...heights.map((h) => h.px))).toBeGreaterThan(8);
    // Dates come from the bars, in the display timezone, never the fixture's.
    const btc = liveRow(rows.find((r) => r.symbol === 'BTC-USD')!);
    const newest = setups(btc).at(-1)!;
    const date = new Date(newest.time).toLocaleDateString('en-US', {
      timeZone: 'Asia/Jerusalem',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    await expect(page.locator('.journal-row').first()).toContainText(date);
    expect(await pageText(page)).not.toContain('Oct 30, 2026');
  });

  test('stock rows say 20 market hours; crypto says 20 hours', async ({ page }) => {
    const rows = await replayRows(page);
    await serveMarkets(page, { body: body(rows.map((r) => liveRow(r))) });
    await openVault(page);
    await goTo(page, 'Markets');
    await asset(page, 'AAPL').click();
    await expect(page.locator('.chart-stats')).toContainText('over 20 market hours');
    await expect(page.locator('.chart-title')).toContainText('AAPL · IEX');
    await expect(page.locator('.price-chart [role="img"]')).toHaveAccessibleName(
      /closing prices over 20 market hours/,
    );
    await asset(page, 'BTC').click();
    await expect(page.locator('.chart-stats')).toContainText('over 20 hours');
    await expect(page.locator('.chart-stats')).not.toContainText('market hours');
    await expect(page.locator('.chart-title')).toContainText('BTC-USD · Coinbase');
  });

  test('a live decision names its real provider and coverage, with no "synthetic"', async ({
    page,
  }) => {
    const rows = await replayRows(page);
    await serveMarkets(page, { body: body(rows.map((r) => liveRow(r))) });
    await openVault(page);
    await goTo(page, 'Markets');
    for (const [symbol, provider, coverage] of [
      ['BTC', 'Coinbase', 'Coinbase trades only'],
      ['AAPL', 'Alpaca', 'IEX only, about 2.5% of US stock volume'],
    ]) {
      await asset(page, symbol).click();
      await page
        .getByRole('button', { name: /Buy setup.*EMA/ })
        .first()
        .click();
      const dialog = page.getByRole('dialog', { name: 'Behind the decision' });
      await expect(dialog).toContainText(`closed bars from ${provider}`);
      await expect(dialog).toContainText('contiguous closed bars');
      await expect(dialog.locator('div', { hasText: /^Coverage/ }).first()).toContainText(coverage);
      await expect(dialog).toContainText('Original result');
      await expect(dialog).toContainText('Later result, kept apart from this decision.');
      await expect(dialog).toContainText(/Historical/);
      await expect(dialog).toContainText(/not financial advice/);
      expect(await dialog.innerText()).not.toMatch(SYNTHETIC);
      expect(await dialog.innerText()).not.toMatch(/replay/i);
      await page.getByRole('button', { name: 'Close dialog' }).click();
    }
  });

  test('historical and alerted setups are told apart in the journal', async ({ page }) => {
    const rows = await replayRows(page);
    const live = rows.map((r) => liveRow(r));
    const btc = live.find((r) => r.symbol === 'BTC-USD')!;
    await serveMarkets(page, { body: body(live, [alertFor(setups(btc)[0], 5)]) });
    await openVault(page);
    await goTo(page, 'Markets');
    await asset(page, 'BTC').click();
    const alerted = page.locator('.journal-row').filter({ hasText: 'Live alert' });
    await expect(alerted).toHaveCount(1);
    await expect(alerted).toContainText('Buy setup');
    await alerted.click();
    await expect(page.getByRole('dialog')).toContainText('Live alert');
    await page.getByRole('button', { name: 'Close dialog' }).click();
    // The same rule on bars with no alert is historical, and so is every other decision.
    await asset(page, 'ETH').click();
    const historical = page.locator('.journal-row').filter({ hasText: 'Historical' });
    await expect(historical).toHaveCount(1);
    await expect(page.locator('.journal-row').filter({ hasText: 'Live alert' })).toHaveCount(0);
    await page.getByRole('button', { name: 'All decisions', exact: true }).click();
    expect(await page.locator('.journal-row').count()).toBeGreaterThan(1);
    await expect(page.locator('.journal-row').filter({ hasText: 'Live alert' })).toHaveCount(0);
    expect(await page.locator('.journal').innerText()).not.toMatch(SYNTHETIC);
  });

  test('alerts show on Today and Markets, and dismissal sticks', async ({ page }) => {
    const rows = await replayRows(page);
    const live = rows.map((r) => liveRow(r));
    const btc = live.find((r) => r.symbol === 'BTC-USD')!;
    const target = setups(btc).at(-1)!;
    const alert = alertFor(target, 3);
    const serve = { body: body(live, [alert]) };
    const dismissals: unknown[] = [];
    await serveMarkets(page, serve);
    await page.route('**/api/alerts/dismiss', (route) => {
      dismissals.push(route.request().postDataJSON());
      serve.body = body(live, [{ ...alert, dismissedAt: new Date().toISOString() }]);
      return route.fulfill({ json: { ok: true } });
    });
    await openVault(page);
    const line = `${alert.state} · EMA20 crossed ${alert.state === 'Buy setup' ? 'above' : 'below'} EMA50 · BTC-USD · Coinbase`;
    await expect(page.locator('.market-alerts')).toContainText(line);
    await goTo(page, 'Markets');
    await expect(page.locator('.market-alerts')).toContainText(line);
    await page.getByRole('button', { name: /^Dismiss BTC-USD/ }).click();
    await expect(page.locator('.market-alerts')).toHaveCount(0);
    expect(dismissals).toEqual([{ id: alert.id }]);
    // A later read still has it dismissed, here and on Today.
    await goTo(page, 'Today');
    await expect(page.locator('.market-alerts')).toHaveCount(0);
    await goTo(page, 'Markets');
    await expect(page.locator('.market-alerts')).toHaveCount(0);
    // The journal still knows the setup was alerted.
    await asset(page, 'BTC').click();
    await expect(page.locator('.journal-row').filter({ hasText: 'Live alert' })).toHaveCount(1);
  });

  test('Today shows the newest three and a count; Markets shows them all; Dismiss all sends the ones the page has', async ({
    page,
  }) => {
    const rows = await replayRows(page);
    const live = rows.map((r) => liveRow(r));
    const picked = live.flatMap((r) =>
      setups(r)
        .slice(-1)
        .map((d) => ({ d, symbol: r.symbol })),
    );
    expect(picked).toHaveLength(5);
    const alerts = picked.map(({ d }, i) => alertFor(d, 10 + i * 10));
    const ids = alerts.map((a) => a.id); // newest first
    const serve = { body: body(live, alerts) };
    const dismissals: unknown[] = [];
    await serveMarkets(page, serve);
    // Dismisses exactly the ids sent, as the server does.
    await page.route('**/api/alerts/dismiss', (route) => {
      const sent = route.request().postDataJSON() as { ids: string[] };
      dismissals.push(sent);
      serve.body = {
        ...serve.body,
        alerts: serve.body.alerts.map((a) =>
          sent.ids.includes(a.id) ? { ...a, dismissedAt: new Date().toISOString() } : a,
        ),
      };
      return route.fulfill({ json: { ok: true } });
    });
    await openVault(page);
    const items = page.locator('.market-alerts li');
    await expect(items).toHaveCount(3);
    await expect(page.locator('.market-alerts')).toContainText('3 of 5');
    // Newest first: the first alert was made 10 minutes ago.
    await expect(items.first()).toContainText(alerts[0].symbol);
    await expect(items.last()).toContainText(alerts[2].symbol);
    // Today's Dismiss all covers the five the card counts, not only the three it lists.
    await page.getByRole('button', { name: 'Dismiss all' }).click();
    await expect(page.locator('.market-alerts')).toHaveCount(0);
    expect(dismissals).toEqual([{ ids }]);
    serve.body = body(live, alerts);
    await goTo(page, 'Markets');
    await expect(items).toHaveCount(5);
    await expect(page.locator('.market-alerts')).not.toContainText(' of 5');
    // An alert found after the page's last read: the page never showed it, so it isn't sent.
    const late = alertFor(picked[0].d, 1, { id: 'an-alert-found-after-the-last-read' });
    serve.body = { ...serve.body, alerts: [...alerts, late] };
    await page.getByRole('button', { name: 'Dismiss all' }).click();
    await expect.poll(() => dismissals).toEqual([{ ids }, { ids }]);
    await expect(items).toHaveCount(1);
  });

  test('a corrected alert says Corrected', async ({ page }) => {
    const rows = await replayRows(page);
    const live = rows.map((r) => liveRow(r));
    const [a] = setups(live.find((r) => r.symbol === 'BTC-USD')!),
      [b] = setups(live.find((r) => r.symbol === 'ETH-USD')!);

    await serveMarkets(page, {
      body: body(live, [
        alertFor(a, 5, { correctedAt: new Date().toISOString() }),
        alertFor(b, 20),
      ]),
    });
    await openVault(page);
    await goTo(page, 'Markets');
    await expect(page.locator('.market-alerts li')).toHaveCount(2);
    await expect(page.locator('.market-alerts li').first()).toContainText('Corrected');
    await expect(page.locator('.market-alerts li').last()).not.toContainText('Corrected');
  });

  test('alerts keep the not-financial-advice line', async ({ page }) => {
    const rows = await replayRows(page);
    const live = rows.map((r) => liveRow(r));
    const alert = alertFor(setups(live[3]).at(-1)!, 5);
    await serveMarkets(page, { body: body(live, [alert]) });
    await openVault(page);
    for (const where of ['Today', 'Markets']) {
      if (where === 'Markets') await goTo(page, 'Markets');
      await expect(page.locator('.market-alerts')).toContainText(/not financial advice/);
      await expect(page.locator('.market-alerts')).toContainText(
        /also fire on random prices|no pattern/,
      );
      expect(await page.locator('.market-alerts').innerText()).not.toMatch(SYNTHETIC);
    }
  });

  test('a failed market read shows its own error, and other pages keep working', async ({
    page,
  }) => {
    await page.route('**/api/markets', (route) =>
      route.fulfill({ status: 500, json: { error: 'The market read failed here.' } }),
    );
    await openVault(page);
    await goTo(page, 'Markets');
    await expect(page.getByText('The market read failed here.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Markets are unavailable' })).toBeVisible();
    await nav(page).getByRole('button', { name: /Tasks/ }).click();
    await expect(page.getByRole('heading', { name: 'Make room for what matters.' })).toBeVisible();
    await goTo(page, 'Health');
    await expect(
      page.getByRole('button', { name: 'Import OpenFit export', exact: true }),
    ).toBeVisible();
    await goTo(page, 'Today');
    await expect(page.getByRole('heading', { name: 'Your day, in perspective.' })).toBeVisible();
  });

  test('leaving Markets open keeps refreshing, and the page sends no request to a provider', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.clock.install();
    const outside: string[] = [],
      reads: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://127.0.0.1:4311/')) outside.push(url);
      if (url.endsWith('/api/markets')) reads.push(url);
    });
    await openVault(page);
    expect(await feedCall(page, '/feeds/coinbase', { enabled: true })).toBe(200);
    await goTo(page, 'Markets');
    // Each 31 seconds on the page's clock is one refresh, while the server wakes in real time.
    // The page's clock runs ahead of the server's, so only the label's shape is checked here.
    const label = async () => {
      await page.clock.fastForward(31_000);
      return (await asset(page, 'BTC').innerText()).replace(/\s+/g, ' ');
    };
    await expect
      .poll(label, { timeout: 30_000, intervals: [1000] })
      .toMatch(/Live · Coinbase · updated \d+ (sec|min) ago/);
    await expect(asset(page, 'AAPL')).toContainText('Synthetic replay');
    await expect(page.locator('.info-banner')).toContainText('2 live · 3 replay');
    const before = reads.length;
    await page.clock.fastForward(31_000);
    await expect.poll(() => reads.length).toBeGreaterThan(before);
    await page.clock.fastForward(31_000);
    await expect.poll(() => reads.length).toBeGreaterThan(before + 1);
    expect(outside).toEqual([]);
    // The feed is left off for the tests after this one.
    expect(await feedCall(page, '/feeds/coinbase', { enabled: false })).toBe(200);
  });

  test('accessibility: no wcag2a or wcag2aa violations with alerts and mixed rows', async ({
    page,
  }) => {
    const rows = await replayRows(page);
    const mixed = rows.map((r, i) =>
      liveRow(
        r,
        i === 0
          ? { state: 'closed', lastBarAt: '2026-10-30T19:45:00.000Z' }
          : i === 2
            ? { state: 'replay' }
            : {},
      ),
    );
    const alerts = mixed
      .flatMap((r) => (r.source.kind === 'live' ? setups(r).slice(-1) : []))
      .map((d, i) => alertFor(d, 5 + i, i === 1 ? { correctedAt: new Date().toISOString() } : {}));
    await serveMarkets(page, { body: body(mixed, alerts) });
    await openVault(page);
    await expect(page.locator('.market-alerts')).toBeVisible();
    for (const where of ['Today', 'Markets']) {
      if (where === 'Markets') await goTo(page, 'Markets');
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(
        audit.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
      ).toEqual([]);
    }
    await page
      .getByRole('button', { name: /Buy setup.*EMA|Sell setup.*EMA/ })
      .first()
      .click();
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      audit.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
  });

  test('390px wide: no horizontal overflow with alerts and long labels', async ({ page }) => {
    const rows = await replayRows(page);
    const cases: Row[] = [
      { state: 'stale', lastUpdate: new Date(Date.now() - 6.5 * MIN).toISOString() },
      { state: 'failing', reason: 'worker-crashes' },
      { state: 'closed', lastBarAt: '2026-10-30T19:45:00.000Z' },
      { state: 'live' },
      { state: 'failing', reason: 'unexpected-response' },
    ];
    const mixed = rows.map((r, i) => liveRow(r, cases[i]));
    const alerts = mixed
      .flatMap((r) => setups(r).slice(-1))
      .map((d, i) => alertFor(d, 5 + i, i === 0 ? { correctedAt: new Date().toISOString() } : {}));
    await serveMarkets(page, { body: body(mixed, alerts) });
    await page.setViewportSize({ width: 390, height: 844 });
    await openVault(page);
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    await expect.poll(fits, { timeout: 5000 }).toBe(true);
    await expect(page.locator('.market-alerts li')).toHaveCount(3);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await goTo(page, 'Markets');
    await expect(page.locator('.market-alerts li')).toHaveCount(5);
    await expect.poll(fits, { timeout: 5000 }).toBe(true);
    // The watchlist card is hidden on a phone, so a row is chosen from Today's watchlist.
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await goTo(page, 'Today');
    await expect.poll(fits, { timeout: 5000 }).toBe(true);
    await page.locator('.watchlist-row', { hasText: 'MSFT' }).click();
    await expect(page.locator('.chart-title')).toContainText('MSFT');
    await expect.poll(fits, { timeout: 5000 }).toBe(true);
    await page
      .getByRole('button', { name: /Buy setup.*EMA|Sell setup.*EMA/ })
      .first()
      .click();
    await expect.poll(fits, { timeout: 5000 }).toBe(true);
  });

  test('Connections & privacy lists each provider, off by default', async ({ page }) => {
    await openVault(page);
    await goPrivacy(page);
    await expect(
      page.locator('.integration-row').filter({ hasText: 'Market data feeds' }),
    ).toHaveCount(0);
    for (const [name, host] of [
      ['Coinbase market data', 'api.coinbase.com'],
      ['Alpaca market data', 'data.alpaca.markets'],
    ]) {
      const row = privacyRow(page, name);
      await expect(row).toHaveCount(1);
      await expect(row.locator('.badge')).toHaveText('Off');
      await expect(row).toContainText('Shared: None');
      await expect(row).toContainText('Destination: None');
      await expect(row).toContainText(host);
      await expect(row.getByRole('button', { name: 'Turn on', exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: 'Remove key' })).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: 'Delete saved market data' })).toBeVisible();
    await expect(page.getByText('No outbound app traffic')).toBeVisible();
  });

  test('the Coinbase dialog states what is sent, and nothing goes out until confirmed', async ({
    page,
  }) => {
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/feeds/')) posts.push(r.url());
    });
    await openVault(page);
    await goPrivacy(page);
    const row = privacyRow(page, 'Coinbase market data');
    await row.getByRole('button', { name: 'Turn on', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Turn on Coinbase market data' });
    for (const text of [
      'api.coinbase.com',
      'BTC-USD',
      'ETH-USD',
      'your IP address',
      'About once a minute',
      'AllIn places no orders',
    ])
      await expect(dialog).toContainText(text);
    const terms = dialog.getByRole('link', { name: /terms/i });
    await expect(terms).toHaveAttribute(
      'href',
      'https://www.coinbase.com/legal/developer-platform/terms-of-service',
    );
    await expect(terms).toHaveAttribute('rel', /noreferrer/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.locator('.badge')).toHaveText('Off');
    expect(posts).toEqual([]);
    await row.getByRole('button', { name: 'Turn on', exact: true }).click();
    await dialog.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(posts).toHaveLength(1);
    await expect(row.locator('.badge')).toHaveText(/^(Catching up|Live)$/);
    await expect(row.locator('.badge')).toHaveText('Live', { timeout: 20000 });
    await expect(row.getByRole('button', { name: 'Turn off', exact: true })).toBeVisible();
    // Without a reload, the BTC row is live on Markets.
    await goTo(page, 'Markets');
    await expect(asset(page, 'BTC')).toContainText('Live · Coinbase');
    await expect(asset(page, 'AAPL')).toContainText('Synthetic replay');
  });

  test('the Alpaca dialog states what is sent, and suggests paper keys', async ({ page }) => {
    await openVault(page);
    await goPrivacy(page);
    await privacyRow(page, 'Alpaca market data')
      .getByRole('button', { name: 'Turn on', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Turn on Alpaca market data' });
    for (const text of [
      'data.alpaca.markets',
      'AAPL',
      'NVDA',
      'MSFT',
      'your IP address',
      'your account key',
      'in market hours',
      'paper trading',
      'AllIn places no orders',
    ])
      await expect(dialog).toContainText(text);
    await expect(dialog.getByRole('link', { name: /terms/i })).toHaveAttribute(
      'href',
      'https://alpaca.markets/disclosures',
    );
    await expect(dialog.getByRole('link', { name: /terms/i })).toHaveAttribute('rel', /noreferrer/);
    for (const label of ['Key ID', 'Secret']) {
      const field = dialog.getByLabel(label, { exact: true });
      await expect(field).toHaveAttribute('type', 'password');
      await expect(field).toHaveAttribute('autocomplete', 'off');
      await expect(field).toHaveValue('');
    }
    await expect(dialog).not.toContainText('A key is saved');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(privacyRow(page, 'Alpaca market data').locator('.badge')).toHaveText('Off');
  });

  test('a rejected key shows the reason, stays Off, and saves nothing', async ({ page }) => {
    await openVault(page);
    await goPrivacy(page);
    const row = privacyRow(page, 'Alpaca market data');
    await row.getByRole('button', { name: 'Turn on', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Turn on Alpaca market data' });
    await dialog.getByLabel('Key ID', { exact: true }).fill('PKREJECTKEY123456');
    await dialog.getByLabel('Secret', { exact: true }).fill('rejectsecret0987654321');
    await dialog.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'Alpaca rejected this key. Check the key ID and secret.',
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(row.locator('.badge')).toHaveText('Off');
    await expect(row.getByRole('button', { name: 'Remove key' })).toHaveCount(0);
    // Nothing was saved: reopening says no key, and the fields are empty.
    await row.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(dialog).not.toContainText('A key is saved');
    await expect(dialog.getByLabel('Key ID', { exact: true })).toHaveValue('');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('a good key turns Alpaca on, and clears the fields', async ({ page }) => {
    const keyId = 'PKGOODKEY1234567890',
      secret = 'goodsecret0123456789abc';
    const bodies: string[] = [],
      responses: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') bodies.push(r.postData() ?? '');
    });
    page.on('response', async (r) => {
      try {
        responses.push(await r.text());
      } catch {
        // A response that is gone has nothing to check.
      }
    });
    await openVault(page);
    await goPrivacy(page);
    const row = privacyRow(page, 'Alpaca market data');
    await row.getByRole('button', { name: 'Turn on', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Turn on Alpaca market data' });
    await dialog.getByLabel('Key ID', { exact: true }).fill(keyId);
    await dialog.getByLabel('Secret', { exact: true }).fill(secret);
    await dialog.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.locator('.badge')).toHaveText(/^(Catching up|Live|Market closed|Stale)$/);
    await expect(row.getByRole('button', { name: 'Remove key' })).toBeVisible();
    // The key went out once, and no response or later request carries it.
    await page.waitForTimeout(500);
    expect(bodies.filter((b) => b.includes(keyId) || b.includes(secret))).toHaveLength(1);
    expect(responses.filter((r) => r.includes(keyId) || r.includes(secret))).toEqual([]);
    expect(await pageText(page)).not.toContain(keyId);
    expect(
      await page.evaluate(() => JSON.stringify(sessionStorage) + JSON.stringify(localStorage)),
    ).not.toContain(keyId);
    // Turned off, the dialog opens with the fields empty and says a key is saved.
    await row.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(row.locator('.badge')).toHaveText('Off');
    await row.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(dialog).toContainText('A key is saved');
    for (const label of ['Key ID', 'Secret'])
      await expect(dialog.getByLabel(label, { exact: true })).toHaveValue('');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(responses.filter((r) => r.includes(keyId) || r.includes(secret))).toEqual([]);
  });

  test('turning a feed off returns its rows to replay', async ({ page }) => {
    await openVault(page);
    await goPrivacy(page);
    const coinbase = privacyRow(page, 'Coinbase market data');
    await coinbase.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(coinbase.locator('.badge')).toHaveText('Off');
    // Alpaca turns on with the saved key and no fields, then off again.
    const alpaca = privacyRow(page, 'Alpaca market data');
    await alpaca.getByRole('button', { name: 'Turn on', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Turn on Alpaca market data' });
    await dialog.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(alpaca.getByRole('button', { name: 'Turn off', exact: true })).toBeVisible();
    await goTo(page, 'Markets');
    await expect(asset(page, 'AAPL')).not.toContainText('Synthetic replay');
    await expect(asset(page, 'BTC')).toContainText('Synthetic replay');
    await goPrivacy(page);
    await alpaca.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(alpaca.locator('.badge')).toHaveText('Off');
    await goTo(page, 'Markets');
    await expect(page.locator('.asset-select', { hasText: 'Synthetic replay' })).toHaveCount(5);
  });

  test('Remove key turns Alpaca off', async ({ page }) => {
    await openVault(page);
    await goPrivacy(page);
    const alpaca = privacyRow(page, 'Alpaca market data');
    await alpaca.getByRole('button', { name: 'Turn on', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Turn on Alpaca market data' });
    await dialog.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(alpaca.getByRole('button', { name: 'Turn off', exact: true })).toBeVisible();
    await alpaca.getByRole('button', { name: 'Remove key' }).click();
    await expect(alpaca.locator('.badge')).toHaveText('Off');
    await expect(alpaca.getByRole('button', { name: 'Remove key' })).toHaveCount(0);
    await alpaca.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(dialog).not.toContainText('A key is saved');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('Delete saved market data asks first, then removes alerts and bars', async ({ page }) => {
    const purges: number[] = [];
    page.on('response', (r) => {
      if (r.url().endsWith('/api/feeds/purge')) purges.push(r.status());
    });
    await openVault(page);
    await goPrivacy(page);
    await page.getByRole('button', { name: 'Delete saved market data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete saved market data?' });
    await expect(dialog).toContainText('This removes the market bars and alerts AllIn saved.');
    await expect(dialog).toContainText('Your Alpaca key stays in Keychain until you remove it.');
    await expect(dialog).not.toContainText(/backups/i);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(purges).toEqual([]);
    await page.getByRole('button', { name: 'Delete saved market data' }).click();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => purges).toEqual([200]);
    const read = await page.evaluate(async () => {
      const response = await fetch('/api/markets', {
        headers: { 'X-AllIn-CSRF': sessionStorage.getItem('allin.session-token') ?? '' },
      });
      return response.json();
    });
    expect(read.alerts).toEqual([]);
  });

  test("Today's market card and watchlist follow the rows", async ({ page }) => {
    const rows = await replayRows(page);
    const serve = { body: body(rows.map((r) => liveRow(r))) as unknown };
    await serveMarkets(page, serve);
    await openVault(page);
    const card = page.locator('.summary-card', { hasText: 'Markets at a glance' });
    await expect(card).toContainText('5 live');
    await expect(card).toContainText('rule setups, latest 80 bars');
    await expect(card).not.toContainText('on live rows');
    await expect(card.locator('.summary-main strong')).toHaveText(
      String(rows.reduce((sum, r) => sum + setups(r).length, 0)),
    );
    await expect(card).not.toContainText('rule setups in replay');
    await expect(card).not.toContainText('Synthetic replay');
    await expect(card).not.toContainText('Oct 30 · 20h fixture');
    await expect(page.locator('.watchlist-bottom')).toContainText(
      '5 live · refreshes about once a minute',
    );
    const footerIcon = page.locator('.watchlist-bottom svg').first();
    await expect(footerIcon).toHaveClass(/lucide-activity/);
    expect(await pageText(page)).not.toMatch(SYNTHETIC);
    // Mixed rows count each kind, and the replay wording stays out of the live rows.
    serve.body = body(
      rows.map((r) => liveRow(r, { state: feedOf(r.symbol) === 'coinbase' ? 'live' : 'replay' })),
    );
    await goTo(page, 'Markets');
    await goTo(page, 'Today');
    await expect(card).toContainText('2 live · 3 replay');
    // Only the live rows' setups are counted, and the card says so.
    const liveSetups = rows
      .filter((r) => feedOf(r.symbol) === 'coinbase')
      .reduce((sum, r) => sum + setups(r).length, 0);
    const allSetups = rows.reduce((sum, r) => sum + setups(r).length, 0);
    expect(liveSetups).toBeLessThan(allSetups);
    await expect(card.locator('.summary-main strong')).toHaveText(String(liveSetups));
    await expect(card).toContainText('rule setups on live rows, latest 80 bars');
    await expect(page.locator('.watchlist-bottom')).toContainText(
      '2 live · 3 replay · refreshes about once a minute',
    );
    await expect(footerIcon).toHaveClass(/lucide-activity/);
    // All replay: the card and the footer read as before.
    serve.body = body(rows.map((r) => liveRow(r, { state: 'replay' })));
    await goTo(page, 'Markets');
    await goTo(page, 'Today');
    await expect(card).toContainText('Synthetic replay');
    await expect(card).toContainText('rule setups in replay');
    await expect(card.locator('.summary-main strong')).toHaveText(
      String(rows.reduce((sum, r) => sum + setups(r).length, 0)),
    );
    await expect(card).toContainText('Oct 30 · 20h fixture');
    await expect(page.locator('.watchlist-bottom')).toContainText(
      'Simulation only · Live monitoring is paused',
    );
    await expect(footerIcon).toHaveClass(/lucide-circle-pause/);
  });

  test('the market currency line drops "fixture" once any row is live', async ({ page }) => {
    const rows = await replayRows(page);
    const serve = {
      body: body(
        rows.map((r) => liveRow(r, { state: 'replay' })),
        [],
        [statusOf('coinbase', 'off'), statusOf('alpaca', 'off')],
      ) as unknown,
    };
    await serveMarkets(page, serve);
    await openVault(page);
    await goPrivacy(page);
    const line = page.locator('.setting-line', { hasText: 'Market currency' });
    await expect(line).toContainText('USD · fixture');
    serve.body = body(
      rows.map((r) => liveRow(r, { state: feedOf(r.symbol) === 'coinbase' ? 'live' : 'replay' })),
      [],
      [statusOf('coinbase'), statusOf('alpaca', 'off')],
    );
    await goTo(page, 'Today');
    await goPrivacy(page);
    await expect(line).toContainText('USD');
    await expect(line).not.toContainText('fixture');
  });

  test('half a key is refused in the dialog and nothing is sent', async ({ page }) => {
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/feeds/')) posts.push(r.url());
    });
    await openVault(page);
    await goPrivacy(page);
    const row = privacyRow(page, 'Alpaca market data');
    await row.getByRole('button', { name: 'Turn on', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Turn on Alpaca market data' });
    const turnOn = dialog.getByRole('button', { name: 'Turn on', exact: true });
    for (const [label, other] of [
      ['Key ID', 'Secret'],
      ['Secret', 'Key ID'],
    ]) {
      await dialog.getByLabel(label, { exact: true }).fill('PKHALFKEY123456');
      await turnOn.click();
      await expect(dialog.getByRole('alert')).toHaveText('Enter both the key ID and the secret.');
      await dialog.getByLabel(label, { exact: true }).fill('');
      await expect(dialog.getByLabel(other, { exact: true })).toHaveValue('');
    }
    expect(posts).toEqual([]);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(row.locator('.badge')).toHaveText('Off');
  });

  test('a failed market read says the data is unavailable, not the replay', async ({ page }) => {
    await page.route('**/api/markets', (route) =>
      route.fulfill({ status: 500, json: { error: 'The read failed.' } }),
    );
    await openVault(page);
    await expect(page.getByRole('heading', { name: 'Market data is unavailable' })).toBeVisible();
    await expect(page.getByText('Market replay is unavailable')).toHaveCount(0);
  });

  test('the help dialog and Privacy wording no longer say feeds are disabled', async ({ page }) => {
    await openVault(page);
    await page.getByRole('button', { name: 'Around AllIn' }).click();
    const help = page.getByRole('dialog', { name: 'A little more intention, every day' });
    await expect(help).toContainText('Markets stay offline until you turn on a feed');
    await expect(help).not.toContainText(/No live feeds|deterministic synthetic replay/);
    const footer = help.locator('.field-hint');
    await expect(footer).toContainText('M4 · Live market feeds');
    await expect(footer).toContainText('Markets stay offline until you turn on a feed.');
    await expect(footer).not.toContainText(/M1|OpenFit file import/);
    await help.getByRole('button', { name: 'Close dialog' }).first().click();
    await goPrivacy(page);
    const text = await pageText(page);
    expect(text).not.toContain('future opt-in connections');
    for (const name of ['Coinbase market data', 'Alpaca market data'])
      await expect(privacyRow(page, name)).not.toContainText('Disabled');
  });

  test('the dialogs pass accessibility checks', async ({ page }) => {
    await openVault(page);
    await goPrivacy(page);
    const check = async () => {
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(
        audit.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
      ).toEqual([]);
    };
    for (const name of ['Coinbase market data', 'Alpaca market data']) {
      await privacyRow(page, name).getByRole('button', { name: 'Turn on', exact: true }).click();
      await check();
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    }
    await page.getByRole('button', { name: 'Delete saved market data' }).click();
    await check();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await check();
  });

  test('the offline provider refuses a key with REJECT in its ID, and the last test leaves both feeds off', async ({
    page,
  }) => {
    await openVault(page);
    expect(
      await feedCall(page, '/feeds/alpaca', {
        enabled: true,
        keyId: 'PKREJECTKEY123456',
        secret: 'rejectsecret0987654321',
      }),
    ).toBeGreaterThanOrEqual(400);
    expect(await feedCall(page, '/feeds/coinbase', { enabled: false })).toBe(200);
    expect(await feedCall(page, '/feeds/purge', {})).toBe(200);
    const read = await page.evaluate(async () => {
      const response = await fetch('/api/markets', {
        headers: { 'X-AllIn-CSRF': sessionStorage.getItem('allin.session-token') ?? '' },
      });
      return response.json();
    });
    expect(read.feeds.map((f: FeedStatus) => [f.feed, f.enabled])).toEqual([
      ['coinbase', false],
      ['alpaca', false],
    ]);
    expect(read.alerts).toEqual([]);
    await goTo(page, 'Markets');
    await expect(page.locator('.asset-select', { hasText: 'Synthetic replay' })).toHaveCount(5);
  });
});
