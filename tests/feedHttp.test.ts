import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decryptBackup } from '../server/crypto.ts';
import { FeedSupervisor } from '../server/feedSupervisor.ts';
import type { FeedStatus, MarketAlert, FetchResult } from '../shared/feedSchema.ts';
import type { MarketInstrument } from '../shared/fixtures.ts';
import {
  DEFAULT_START,
  fakeClock,
  providerWorld,
  scriptedTransport,
  seriesEndingInSetup,
} from './feedHelpers.ts';
import { dumpMarkets, recovery } from './helpers.ts';
import { setup } from './httpHelpers.ts';

type Markets = { instruments: MarketInstrument[]; feeds: FeedStatus[]; alerts: MarketAlert[] };
const GOOD = { keyId: 'KEYMARKER9X7Q', secret: 'SECRETMARKER9X7Q' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// An app whose feeds run on a scripted provider and a clock the test moves.
async function world(idleMs?: number, handler?: (request: never) => FetchResult) {
  const clock = fakeClock(DEFAULT_START);
  const provider = providerWorld(clock);
  const transport = scriptedTransport(handler ? (handler as never) : provider.handler);
  const feedLogs: string[] = [];
  let feeds!: FeedSupervisor;
  const app = await setup(idleMs, undefined, (vault) => {
    feeds = new FeedSupervisor({
      vault,
      transport,
      now: clock.now,
      tickMs: 0,
      log: (line) => feedLogs.push(line),
    });
    return feeds;
  });
  return {
    app,
    clock,
    provider,
    transport,
    feedLogs,
    async wake(ms = 5000) {
      clock.advance(ms);
      await feeds.tick();
    },
    async markets(): Promise<Markets> {
      const response = await app.call('/markets');
      assert.equal(response.status, 200);
      return response.json();
    },
    async close() {
      feeds.stop();
      await app.close();
    },
  };
}
const feedOf = (m: Markets, name: string) => m.feeds.find((f) => f.feed === name)!;
const actions = (w: Awaited<ReturnType<typeof world>>) =>
  (w.app.p.vault.events() as { action: string }[]).map((e) => e.action);

test('market routes refuse locked and tokenless requests', async () => {
  const w = await world();
  try {
    assert.equal((await w.app.call('/markets')).status, 401);
    for (const [path, body] of [
      ['/feeds/coinbase', { enabled: true }],
      ['/feeds/alpaca', { enabled: false }],
      ['/feeds/alpaca/remove-key', {}],
      ['/feeds/purge', {}],
      ['/alerts/dismiss', { ids: ['a'] }],
    ] as const)
      assert.equal((await w.app.call(path, 'POST', body)).status, 401, path);
    await w.app.login();
    assert.equal((await w.app.call('/markets')).status, 200);
    for (const [path, body] of [
      ['/feeds/coinbase', { enabled: true }],
      ['/feeds/purge', {}],
    ] as const) {
      assert.equal(
        (await w.app.call(path, 'POST', body, { 'X-AllIn-CSRF': 'wrong' })).status,
        403,
        path,
      );
      assert.equal((await w.app.call(path, 'POST', body, { Cookie: '' })).status, 401, path);
    }
    assert.equal(
      (await w.app.call('/markets', 'GET', undefined, { 'X-AllIn-CSRF': 'x' })).status,
      401,
    );
    assert.equal(feedOf(await w.markets(), 'coinbase').enabled, false);
    await w.app.call('/vault/lock', 'POST', {});
    assert.equal((await w.app.call('/markets')).status, 401);
  } finally {
    await w.close();
  }
});

test('the public demo route is unchanged, and has no feeds or alerts', async () => {
  const w = await world();
  try {
    const demo = await (await w.app.call('/demo/markets')).json();
    assert.ok(Array.isArray(demo.instruments) || Array.isArray(demo));
    const text = JSON.stringify(demo);
    assert.equal(text.includes('"feeds"'), false);
    assert.equal(text.includes('"alerts"'), false);
    assert.equal(text.includes('"live"'), false);
    assert.equal(text.includes('"replay"'), true);
  } finally {
    await w.close();
  }
});

test('GET /api/markets does not extend the session', async () => {
  const w = await world(300);
  try {
    await w.app.login();
    for (let i = 0; i < 5; i++) {
      await sleep(100);
      // Until the idle time passes, the polls are answered.
      const status = (await w.app.call('/markets')).status;
      assert.ok(status === 200 || status === 401);
    }
    assert.equal((await w.app.call('/tasks')).status, 401);
    assert.equal((await w.app.call('/markets')).status, 401);
  } finally {
    await w.close();
  }
});

test('every other private route still extends it', async () => {
  const w = await world(300);
  try {
    await w.app.login();
    for (let i = 0; i < 5; i++) {
      await sleep(100);
      assert.equal((await w.app.call('/tasks')).status, 200);
    }
    assert.equal((await w.app.call('/tasks')).status, 200);
    assert.equal((await w.app.call('/markets')).status, 200);
  } finally {
    await w.close();
  }
});

test('turning Coinbase on and off over HTTP', async () => {
  const w = await world();
  try {
    await w.app.login();
    const on = await w.app.call('/feeds/coinbase', 'POST', { enabled: true });
    assert.equal(on.status, 200);
    const status = feedOf(await w.markets(), 'coinbase');
    assert.equal(status.enabled, true);
    assert.equal(status.state, 'catching-up');
    await w.wake();
    assert.equal(feedOf(await w.markets(), 'coinbase').state, 'live');
    const off = await w.app.call('/feeds/coinbase', 'POST', { enabled: false });
    assert.equal(off.status, 200);
    const after = await w.markets();
    assert.equal(feedOf(after, 'coinbase').enabled, false);
    assert.equal(feedOf(after, 'coinbase').state, 'off');
    assert.ok(after.instruments.every((i) => i.source.kind === 'replay'));
    const log = actions(w);
    assert.ok(log.includes('feed.on'));
    assert.ok(log.includes('feed.off'));
    assert.ok(log.indexOf('feed.off') < log.indexOf('feed.on'), 'newest first');
  } finally {
    await w.close();
  }
});

test('a toggle with an unknown field is 400, and changes nothing', async () => {
  const w = await world();
  try {
    await w.app.login();
    const before = dumpMarkets(w.app.p.vault);
    for (const [path, body] of [
      ['/feeds/coinbase', { enabled: true, extra: 1 }],
      ['/feeds/coinbase', {}],
      ['/feeds/coinbase', { enabled: 'yes' }],
      ['/feeds/alpaca', { enabled: false, venue: 'x' }],
      ['/feeds/alpaca', { enabled: true, keyId: GOOD.keyId }],
      ['/alerts/dismiss', { id: 'a', all: true }],
      ['/alerts/dismiss', { all: true }],
      ['/alerts/dismiss', { ids: [] }],
    ] as const)
      assert.equal((await w.app.call(path, 'POST', body)).status, 400, path);
    assert.deepEqual(dumpMarkets(w.app.p.vault), before);
    assert.equal(feedOf(await w.markets(), 'coinbase').enabled, false);
    assert.equal(w.transport.started, false);
  } finally {
    await w.close();
  }
});

test('Alpaca with a good key: hasKey true, state catching-up, key absent from every response', async () => {
  const w = await world();
  try {
    await w.app.login();
    const response = await w.app.call('/feeds/alpaca', 'POST', { enabled: true, ...GOOD });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(text.includes(GOOD.keyId) || text.includes(GOOD.secret), false);
    const m = await w.markets();
    assert.equal(feedOf(m, 'alpaca').hasKey, true);
    assert.equal(feedOf(m, 'alpaca').enabled, true);
    assert.equal(feedOf(m, 'alpaca').state, 'catching-up');
    assert.equal(feedOf(m, 'coinbase').hasKey, false);
    assert.deepEqual(w.transport.credentials, GOOD);
    // Turning it off keeps the key, so it can be turned on again with no body key.
    assert.equal((await w.app.call('/feeds/alpaca', 'POST', { enabled: false })).status, 200);
    assert.equal(feedOf(await w.markets(), 'alpaca').hasKey, true);
    assert.equal((await w.app.call('/feeds/alpaca', 'POST', { enabled: true })).status, 200);
  } finally {
    await w.close();
  }
});

test('Alpaca with a rejected key: 400 with the reason, and nothing stored', async () => {
  const w = await world(undefined, () => ({ ok: false, error: 'unauthorized' }));
  try {
    await w.app.login();
    const before = dumpMarkets(w.app.p.vault);
    const response = await w.app.call('/feeds/alpaca', 'POST', { enabled: true, ...GOOD });
    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.match(error, /Alpaca/);
    assert.equal(error.includes(GOOD.secret), false);
    const m = await w.markets();
    assert.equal(feedOf(m, 'alpaca').hasKey, false);
    assert.equal(feedOf(m, 'alpaca').enabled, false);
    assert.deepEqual(dumpMarkets(w.app.p.vault), before);
    assert.equal(w.app.p.keys.get(`alpaca:${w.app.p.vault.id}`), null);
    assert.equal(actions(w).includes('feed.key-saved'), false);
  } finally {
    await w.close();
  }
});

test('a key marker appears in no response, log, backup, or vault file', async () => {
  const w = await world();
  try {
    await w.app.login();
    const seen: string[] = [];
    const record = async (response: Response) => {
      assert.ok([200, 400].includes(response.status), `status ${response.status}`);
      const text = await response.text();
      seen.push(text);
      return text;
    };
    await record(await w.app.call('/feeds/alpaca', 'POST', { enabled: true, ...GOOD }));
    await w.wake();
    await w.wake(60_000);
    assert.match(await record(await w.app.call('/markets')), /"hasKey":true/);
    await record(await w.app.call('/events'));
    await record(await w.app.call('/settings'));
    await record(await w.app.call('/feeds/coinbase', 'POST', { enabled: true }));
    const backup = await (await w.app.call('/vault/backup', 'POST', { secret: recovery })).json();
    assert.ok(backup.version !== undefined || Object.keys(backup).length > 0);
    seen.push(JSON.stringify(backup));
    seen.push(JSON.stringify(decryptBackup(backup, recovery)));
    seen.push(...w.app.logs, ...w.feedLogs);
    seen.push(JSON.stringify(dumpMarkets(w.app.p.vault)));
    // A bad body that quotes the key must not echo it either.
    seen.push(
      await record(await w.app.call('/feeds/alpaca', 'POST', { enabled: true, ...GOOD, x: 1 })),
    );
    for (const name of readdirSync(w.app.p.directory))
      seen.push(readFileSync(join(w.app.p.directory, name)).toString('latin1'));
    for (const text of seen)
      for (const marker of ['KEYMARKER9X7Q', 'SECRETMARKER9X7Q'])
        assert.equal(text.includes(marker), false, marker);
    assert.ok(seen.length > 8);
  } finally {
    await w.close();
  }
});

test('remove-key turns the feed off and deletes the key', async () => {
  const w = await world();
  try {
    await w.app.login();
    assert.equal(
      (await w.app.call('/feeds/alpaca', 'POST', { enabled: true, ...GOOD })).status,
      200,
    );
    // The same JSON content-type check as every other write.
    assert.equal(
      (
        await w.app.call('/feeds/alpaca/remove-key', 'POST', undefined, {
          'Content-Type': 'text/plain',
        })
      ).status,
      415,
    );
    assert.equal(feedOf(await w.markets(), 'alpaca').hasKey, true);
    assert.equal((await w.app.call('/feeds/alpaca/remove-key', 'POST', {})).status, 200);
    const m = await w.markets();
    assert.equal(feedOf(m, 'alpaca').hasKey, false);
    assert.equal(feedOf(m, 'alpaca').enabled, false);
    assert.equal(w.app.p.keys.get(`alpaca:${w.app.p.vault.id}`), null);
    assert.equal(w.transport.credentials, null);
    assert.ok(actions(w).includes('feed.key-removed'));
  } finally {
    await w.close();
  }
});

// Both Coinbase symbols end in a buy setup at the 15:00 bar, which settles at 15:15:30.
async function withAlerts(w: Awaited<ReturnType<typeof world>>) {
  const setup = Date.parse('2026-11-04T15:00:00.000Z');
  for (const symbol of ['BTC-USD', 'ETH-USD'])
    w.provider.setBars(symbol, seriesEndingInSetup(symbol, setup, 'continuous'));
  await w.app.login();
  assert.equal((await w.app.call('/feeds/coinbase', 'POST', { enabled: true })).status, 200);
  await w.wake();
  while (w.clock.now() < Date.parse('2026-11-04T15:15:30.000Z')) await w.wake();
  const alerts = (await w.markets()).alerts;
  assert.equal(alerts.length, 2);
  return alerts;
}

test('dismiss one, then the ones the page showed', async () => {
  const w = await world();
  try {
    const alerts = await withAlerts(w);
    assert.ok(alerts.every((a) => a.dismissedAt === null));
    assert.equal((await w.app.call('/alerts/dismiss', 'POST', { id: alerts[0].id })).status, 200);
    const one = (await w.markets()).alerts;
    assert.deepEqual(
      one.map((a) => a.dismissedAt !== null),
      alerts.map((a) => a.id === alerts[0].id),
    );
    const ids = alerts.map((a) => a.id);
    assert.equal((await w.app.call('/alerts/dismiss', 'POST', { ids })).status, 200);
    assert.ok((await w.markets()).alerts.every((a) => a.dismissedAt !== null));
  } finally {
    await w.close();
  }
});

test('purge removes bars and alerts', async () => {
  const w = await world();
  try {
    await withAlerts(w);
    const before = dumpMarkets(w.app.p.vault);
    assert.ok(before.market_bars.length > 0);
    assert.equal(
      (await w.app.call('/feeds/purge', 'POST', undefined, { 'Content-Type': 'text/plain' }))
        .status,
      415,
    );
    assert.equal((await w.app.call('/feeds/purge', 'POST', {})).status, 200);
    const after = dumpMarkets(w.app.p.vault);
    assert.deepEqual([after.market_bars, after.market_alerts], [[], []]);
    assert.deepEqual((await w.markets()).alerts, []);
    assert.ok(actions(w).includes('feed.purge'));
  } finally {
    await w.close();
  }
});

test('M4: a live row shows venue, coverage state, and freshness', async () => {
  const w = await world();
  try {
    await w.app.login();
    await w.app.call('/feeds/coinbase', 'POST', { enabled: true });
    await w.wake();
    await w.wake(60_000);
    const m = await w.markets();
    const btc = m.instruments.find((i) => i.symbol === 'BTC-USD')!;
    assert.equal(btc.source.kind, 'live');
    assert.ok(btc.source.kind === 'live');
    assert.deepEqual(
      [btc.source.feed, btc.source.provider, btc.source.venue, btc.source.state],
      ['coinbase', 'Coinbase', 'Coinbase', 'live'],
    );
    assert.equal(btc.source.lastUpdate, new Date(w.clock.now()).toISOString());
    assert.ok(btc.source.lastBarAt);
    assert.ok(btc.price !== null && btc.bars.length > 0);
    const aapl = m.instruments.find((i) => i.symbol === 'AAPL')!;
    assert.equal(aapl.source.kind, 'replay');
  } finally {
    await w.close();
  }
});

test('a failing market feed leaves tasks and Health working', async () => {
  const w = await world(undefined, () => ({ ok: false, error: 'network' }));
  try {
    await w.app.login();
    await w.app.call('/feeds/coinbase', 'POST', { enabled: true });
    await w.wake();
    assert.equal(feedOf(await w.markets(), 'coinbase').state, 'stale');
    assert.equal(
      (await w.app.call('/tasks', 'POST', { task: { title: 'still works' } })).status,
      201,
    );
    assert.equal((await w.app.call('/tasks')).status, 200);
    assert.equal((await w.app.call('/health/summary')).status, 200);
    assert.equal((await w.app.call('/demo/health')).status, 200);
  } finally {
    await w.close();
  }
});

test('the status route reports M4, and a locked vault reveals no feed state', async () => {
  const w = await world();
  try {
    const locked = await (await w.app.call('/status')).json();
    assert.equal(locked.milestone, 'M4 · Live market feeds');
    assert.equal('feeds' in locked, false);
    await w.app.login();
    await w.app.call('/feeds/coinbase', 'POST', { enabled: true });
    const open = await (await w.app.call('/status')).json();
    assert.equal(open.milestone, 'M4 · Live market feeds');
    assert.equal('feeds' in open, false);
    await w.app.call('/vault/lock', 'POST', {});
    const after = await (await w.app.call('/status')).json();
    assert.equal(after.unlocked, false);
    assert.equal(JSON.stringify(after).includes('coinbase'), false);
  } finally {
    await w.close();
  }
});

test('with no transport given, turning a feed on reads failing, and no process starts', async () => {
  const processes = () =>
    process.getActiveResourcesInfo().filter((name) => name === 'ProcessWrap').length;
  const before = processes();
  const app = await setup();
  try {
    await app.login();
    assert.equal((await app.call('/feeds/coinbase', 'POST', { enabled: true })).status, 200);
    const alpaca = await app.call('/feeds/alpaca', 'POST', { enabled: true, ...GOOD });
    assert.equal(alpaca.status, 503);
    // The default supervisor wakes on its own timer. Give it a chance, then read the row.
    for (let i = 0; i < 40; i++) {
      const m = (await (await app.call('/markets')).json()) as Markets;
      if (feedOf(m, 'coinbase').state === 'failing') break;
      await sleep(250);
    }
    const m = (await (await app.call('/markets')).json()) as Markets;
    assert.equal(feedOf(m, 'coinbase').state, 'failing');
    assert.equal(feedOf(m, 'coinbase').failure, 'isolation');
    assert.equal(processes(), before);
  } finally {
    await app.close();
  }
});
