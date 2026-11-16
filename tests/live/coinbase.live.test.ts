// Opt-in: these reach api.coinbase.com for real. Run outside any sandbox, with
//   ALLIN_LIVE_TESTS=1 node --import tsx --test tests/live/coinbase.live.test.ts
// `tests/*.test.ts` does not match this folder, so the normal suite never goes online.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FeedSupervisor } from '../../server/feedSupervisor.ts';
import { sandboxedTransport } from '../../server/feedSandbox.ts';
import type { FeedBar } from '../../shared/feedSchema.ts';
import { instruments } from '../../shared/fixtures.ts';
import { password, profile } from '../helpers.ts';

const live = process.env.ALLIN_LIVE_TESTS === '1';
const appDir = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const BAR_MS = 900_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  'the real worker, in the real sandbox, reads Coinbase bars and prices',
  { skip: !live },
  async () => {
    const p = profile();
    p.vault.setup(password); // writes vault.json, which the worker's containment proof tries to read
    const transport = sandboxedTransport({
      dataDir: p.directory,
      appDir,
      worker: join(appDir, 'server', 'feedWorker.ts'),
    });
    try {
      assert.equal(await transport.ready(), true, 'the worker proved its containment');
      const symbols = ['BTC-USD', 'ETH-USD'];
      const bars = await transport.fetch({ feed: 'coinbase', kind: 'bars', symbols, limit: 8 });
      assert.ok(bars.ok && 'bars' in bars, `bars: ${JSON.stringify(bars)}`);
      for (const symbol of symbols) {
        const all: FeedBar[] = bars.bars;
        const mine = all.filter((b) => b.symbol === symbol);
        assert.ok(mine.length > 0, `${symbol} has bars`);
        for (const bar of mine) {
          assert.equal(Date.parse(bar.time) % BAR_MS, 0, `${symbol} ${bar.time} is on the grid`);
          assert.ok(Number.isInteger(bar.closeMinor) && bar.closeMinor > 0);
        }
        const newest = Math.max(...mine.map((b) => Date.parse(b.time)));
        assert.ok(Date.now() - newest < 30 * 60_000, `${symbol}'s newest bar is within 30 minutes`);
      }
      const prices = await transport.fetch({ feed: 'coinbase', kind: 'prices', symbols });
      assert.ok(prices.ok && 'prices' in prices, `prices: ${JSON.stringify(prices)}`);
      assert.deepEqual(prices.prices.map((x) => x.symbol).sort(), symbols);
      for (const price of prices.prices) {
        assert.ok(price.priceMinor > 0, `${price.symbol} price is positive`);
        assert.equal(price.paused, false, `${price.symbol} is not paused`);
      }
    } finally {
      transport.stop();
      p.cleanup();
    }
  },
);

test(
  'a supervisor over the real worker reaches live in a temporary profile',
  { skip: !live },
  async () => {
    const p = profile();
    p.vault.setup(password);
    const transport = sandboxedTransport({
      dataDir: p.directory,
      appDir,
      worker: join(appDir, 'server', 'feedWorker.ts'),
    });
    const logs: string[] = [];
    const feeds = new FeedSupervisor({
      vault: p.vault,
      transport,
      tickMs: 1000,
      log: (line) => logs.push(line),
    });
    const btc = (): Extract<
      ReturnType<FeedSupervisor['snapshot']>['instruments'][number]['source'],
      { kind: 'live' }
    > | null => {
      const row = feeds.snapshot().instruments.find((i) => i.symbol === 'BTC-USD')!;
      return row.source.kind === 'live' ? row.source : null;
    };
    try {
      feeds.setCoinbase(true);
      feeds.start();
      const deadline = Date.now() + 30_000;
      while (btc()?.state !== 'live' && Date.now() < deadline) await sleep(500);
      assert.equal(btc()?.state, 'live', `BTC-USD reached live; logs ${JSON.stringify(logs)}`);
      const row = feeds.snapshot().instruments.find((i) => i.symbol === 'BTC-USD')!;
      const fixture = instruments.find((i) => i.symbol === 'BTC-USD')!;
      assert.ok(row.price !== null && row.price > 0);
      assert.notEqual(row.price, fixture.base, "the price isn't the fixture's");
      assert.ok(row.bars.length > 0);

      // Bars held while the vault is open are saved, and the same bars come back after a lock.
      const before = p.vault.markets.bars('BTC-USD').length;
      assert.ok(before > 0, 'bars were saved');
      p.vault.lock();
      await sleep(2500);
      p.vault.unlock(password);
      await sleep(2500);
      const after = p.vault.markets.bars('BTC-USD').length;
      assert.ok(after >= before, `saved bars survive lock and unlock (${before} -> ${after})`);
      assert.deepEqual(logs, []);
    } finally {
      feeds.stop();
      p.cleanup();
    }
  },
);
