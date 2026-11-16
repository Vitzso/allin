import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { AppError } from '../server/vault.ts';
import type { Vault } from '../server/vault.ts';
import { decryptBackup } from '../server/crypto.ts';
import { loadAlpacaKey, removeAlpacaKey, saveAlpacaKey } from '../server/feedKeys.ts';
import { FEEDS, alpacaKeySchema, type MarketAlert } from '../shared/feedSchema.ts';
import type { Bar } from '../shared/fixtures.ts';
import { domainDb, dumpMarkets, password, preM1Profile, profile, userVersion } from './helpers.ts';

const T0 = Date.parse('2026-11-02T14:30:00.000Z');
const NOW = new Date('2026-11-07T12:00:00.000Z');
const iso = (n: number) => new Date(T0 + n * 900000).toISOString();

function bar(symbol: string, n: number, revision = 1, closeMinor = 10000 + n): Bar {
  const feed = Object.values(FEEDS).find((f) => f.symbols.includes(symbol))!;
  return {
    symbol,
    assetClass: feed.assetClass,
    provider: feed.provider,
    venue: feed.venue,
    currency: 'USD',
    calendar: feed.calendar,
    time: iso(n),
    receivedAt: iso(n + 1),
    interval: '15m',
    revision,
    closeMinor,
    volume: 12.5,
  };
}
function alert(id: string, n: number, alertedAt = iso(n)): MarketAlert {
  return {
    id,
    symbol: 'BTC-USD',
    time: iso(n),
    state: 'Buy setup',
    provider: 'Coinbase',
    venue: 'Coinbase',
    closeMinor: 10000 + n,
    fast: 1.5,
    slow: 1.25,
    reason: 'Fast average crossed above slow',
    ruleVersion: 'ema-20-50/v3',
    alertedAt,
    dismissedAt: null,
    correctedAt: null,
  };
}
const batch = (
  bars: Bar[] = [],
  alerts: MarketAlert[] = [],
  corrections: { symbol: string; time: string; at: string }[] = [],
) => ({ bars, alerts, corrections });

function withVault(run: (vault: Vault, p: ReturnType<typeof profile>) => void) {
  const p = profile();
  try {
    p.vault.setup(password);
    run(p.vault, p);
  } finally {
    p.cleanup();
  }
}
const events = (vault: Vault) => (vault.events() as { action: string }[]).map((e) => e.action);

test('a vault made before this migration upgrades, and keeps its data', () => {
  const p = preM1Profile();
  try {
    p.vault.unlock(password);
    assert.equal(userVersion(p.vault, 'markets'), 2);
    assert.equal(p.vault.tasks()[0].title, 'Pre-M1 synthetic task');
    assert.deepEqual(p.vault.markets.bars('BTC-USD'), []);
  } finally {
    p.cleanup();
  }
});

test('a new vault has the three tables and no rows', () =>
  withVault((vault) => {
    assert.deepEqual(dumpMarkets(vault), {
      market_bars: [],
      market_alerts: [],
      feed_settings: [],
    });
    assert.deepEqual(vault.markets.settings(), { coinbase: false, alpaca: false });
    assert.deepEqual(vault.markets.alerts(), []);
  }));

test('bars come back in time and revision order, as the Bar type', () =>
  withVault((vault) => {
    vault.markets.saveBatch(
      batch([
        bar('BTC-USD', 2),
        bar('BTC-USD', 0),
        bar('BTC-USD', 1, 2, 777),
        bar('BTC-USD', 1),
        bar('AAPL', 0),
        bar('ETH-USD', 0),
      ]),
    );
    const bars = vault.markets.bars('BTC-USD');
    assert.deepEqual(
      bars.map((b) => [b.time, b.revision]),
      [
        [iso(0), 1],
        [iso(1), 1],
        [iso(1), 2],
        [iso(2), 1],
      ],
    );
    assert.deepEqual(bars[2], bar('BTC-USD', 1, 2, 777));
    // Provider, venue, and calendar come from FEEDS, not from the stored text.
    assert.deepEqual(vault.markets.bars('AAPL'), [bar('AAPL', 0)]);
    assert.equal(vault.markets.bars('AAPL')[0].calendar, 'us-equity-regular');
    assert.equal(vault.markets.bars('AAPL')[0].venue, 'IEX');
    assert.deepEqual(vault.markets.bars('NVDA'), []);
  }));

test('a batch saves bars, alerts, and corrections in one transaction', () =>
  withVault((vault) => {
    vault.markets.saveBatch(batch([bar('BTC-USD', 0)], [alert('a0', 0)]));
    const before = dumpMarkets(vault);
    const db = domainDb(vault, 'markets');
    db.exec(
      "CREATE TRIGGER fail_alert BEFORE INSERT ON market_alerts WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'no'); END",
    );
    assert.throws(() =>
      vault.markets.saveBatch(
        batch([bar('BTC-USD', 1)], [alert('a1', 1), alert('bad', 2)], [
          { symbol: 'BTC-USD', time: iso(0), at: iso(5) },
        ] as never),
      ),
    );
    assert.deepEqual(dumpMarkets(vault), before);
    db.exec('DROP TRIGGER fail_alert');
    vault.markets.saveBatch(batch([bar('BTC-USD', 1)], [alert('a1', 1)]));
    assert.equal(vault.markets.bars('BTC-USD').length, 2);
    assert.equal(vault.markets.alerts().length, 2);
  }));

test('the same alert saved twice is one row, and keeps its first alerted_at', () =>
  withVault((vault) => {
    vault.markets.saveBatch(batch([], [alert('a', 0, iso(10))]));
    vault.markets.saveBatch(batch([], [alert('a', 0, iso(99))]));
    const rows = vault.markets.alerts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].alertedAt, iso(10));
  }));

test('a correction marks the alert, and later reads keep its snapshot', () =>
  withVault((vault) => {
    vault.markets.saveBatch(batch([bar('BTC-USD', 0)], [alert('a', 0), alert('b', 1)]));
    vault.markets.saveBatch(
      batch([bar('BTC-USD', 0, 2, 5)], [], [{ symbol: 'BTC-USD', time: iso(0), at: iso(7) }]),
    );
    const byId = Object.fromEntries(vault.markets.alerts().map((a) => [a.id, a]));
    assert.equal(byId.a.correctedAt, iso(7));
    assert.equal(byId.a.closeMinor, 10000);
    assert.equal(byId.a.fast, 1.5);
    assert.equal(byId.b.correctedAt, null);
  }));

test('retention keeps the newest 4000 bar times, counting revisions together', () =>
  withVault((vault) => {
    const bars: Bar[] = [];
    for (let n = 0; n < 4003; n++) bars.push(bar('BTC-USD', n));
    bars.push(bar('BTC-USD', 4002, 2, 9), bar('BTC-USD', 0, 2, 9), bar('AAPL', 0));
    vault.markets.saveBatch(batch(bars));
    const kept = vault.markets.bars('BTC-USD');
    // 4000 times: 3..4002. The revision of time 0 went with it, the revision of 4002 stayed.
    assert.equal(new Set(kept.map((b) => b.time)).size, 4000);
    assert.equal(kept[0].time, iso(3));
    assert.equal(kept.length, 4001);
    assert.equal(vault.markets.bars('AAPL').length, 1);
  }));

test('retention keeps the newest 1000 alerts', () =>
  withVault((vault) => {
    vault.markets.saveBatch(
      batch(
        [],
        Array.from({ length: 1003 }, (_, n) => alert(`a${n}`, n)),
      ),
    );
    const rows = vault.markets.alerts();
    assert.equal(rows.length, 1000);
    assert.equal(rows[0].id, 'a1002');
    assert.equal(rows.at(-1)!.id, 'a3');
  }));

test('dismissing one, then the ones the page showed, leaves an alert it never showed', () =>
  withVault((vault) => {
    vault.markets.saveBatch(batch([], [alert('a', 0), alert('b', 1), alert('c', 2)]));
    vault.markets.dismiss({ id: 'b' }, NOW);
    const dismissed = () =>
      Object.fromEntries(vault.markets.alerts().map((a) => [a.id, a.dismissedAt]));
    assert.deepEqual(dismissed(), { a: null, b: NOW.toISOString(), c: null });
    // The page showed a and c, then d arrived before the request.
    vault.markets.saveBatch(batch([], [alert('d', 3)]));
    const later = new Date(NOW.getTime() + 1000);
    vault.markets.dismiss({ ids: ['a', 'b', 'c', 'gone'] }, later);
    assert.deepEqual(dismissed(), {
      a: later.toISOString(),
      b: NOW.toISOString(), // already dismissed keeps its time
      c: later.toISOString(),
      d: null,
    });
    assert.deepEqual(
      vault.markets.alerts().map((a) => a.id),
      ['d', 'c', 'b', 'a'],
    );
  }));

test('dismissing takes up to 1,000 ids at once', () =>
  withVault((vault) => {
    vault.markets.saveBatch(batch([], [alert('x', 0)]));
    const ids = Array.from({ length: 999 }, (_, i) => `n${i}`);
    vault.markets.dismiss({ ids: [...ids, 'x'] }, NOW);
    assert.equal(vault.markets.alerts()[0].dismissedAt, NOW.toISOString());
  }));

for (const bad of [
  {},
  { id: 1 },
  { all: true },
  { ids: [] },
  { ids: [1] },
  { ids: [''] },
  { ids: Array.from({ length: 1001 }, (_, i) => `n${i}`).concat('x') },
  { id: 'x', ids: ['x'] },
])
  test(`dismiss ${JSON.stringify(bad)} is rejected`, () =>
    withVault((vault) => {
      vault.markets.saveBatch(batch([], [alert('x', 0)]));
      assert.throws(() => vault.markets.dismiss(bad, NOW), ZodError);
      assert.equal(vault.markets.alerts()[0].dismissedAt, null);
    }));

test('feed settings turn on and off, and log only the action', () =>
  withVault((vault) => {
    vault.markets.setEnabled('alpaca', true, NOW);
    assert.deepEqual(vault.markets.settings(), { coinbase: false, alpaca: true });
    assert.equal(
      (dumpMarkets(vault).feed_settings[0] as { consented_at: string }).consented_at,
      NOW.toISOString(),
    );
    vault.markets.setEnabled('alpaca', false, NOW);
    assert.deepEqual(vault.markets.settings(), { coinbase: false, alpaca: false });
    assert.deepEqual(
      events(vault).filter((a) => a.startsWith('feed.')),
      ['feed.off', 'feed.on'],
    );
  }));

test('purge removes bars and alerts, keeps settings, and logs only the action', () =>
  withVault((vault) => {
    vault.markets.setEnabled('coinbase', true, NOW);
    vault.markets.saveBatch(batch([bar('BTC-USD', 0)], [alert('a', 0)]));
    vault.markets.purge();
    assert.deepEqual(vault.markets.bars('BTC-USD'), []);
    assert.deepEqual(vault.markets.alerts(), []);
    assert.deepEqual(vault.markets.settings(), { coinbase: true, alpaca: false });
    assert.equal(events(vault)[0], 'feed.purge');
    assert.doesNotMatch(JSON.stringify(vault.events()), /BTC|10000/);
  }));

test('an unreadable saved bar or alert is reported as damage', () =>
  withVault((vault) => {
    const db = domainDb(vault, 'markets');
    const damaged = (read: () => unknown) =>
      assert.throws(
        read,
        (e: AppError) => e instanceof AppError && e.status >= 500 && /damaged/.test(e.message),
      );
    db.prepare(
      "INSERT INTO market_bars VALUES ('BTC-USD','not a time',1,'x','x',5,1,'2026-11-02T00:00:00.000Z')",
    ).run();
    damaged(() => vault.markets.bars('BTC-USD'));
    db.exec('DELETE FROM market_bars');
    db.prepare(
      "INSERT INTO market_bars VALUES ('ZZZ','2026-11-02T14:30:00.000Z',1,'x','x',5,1,'2026-11-02T00:00:00.000Z')",
    ).run();
    damaged(() => vault.markets.bars('ZZZ'));
    db.exec('DELETE FROM market_bars');
    db.prepare(
      "INSERT INTO market_bars VALUES ('BTC-USD','2026-11-02T14:30:00.000Z',1,'x','x',-5,1,'2026-11-02T00:00:00.000Z')",
    ).run();
    damaged(() => vault.markets.bars('BTC-USD'));
    db.prepare(
      "INSERT INTO market_alerts VALUES ('a','BTC-USD','2026-11-02T14:30:00.000Z','Hold','x','x',5,1,1,'r','v','2026-11-02T14:30:00.000Z',NULL,NULL)",
    ).run();
    damaged(() => vault.markets.alerts());
    db.exec('DELETE FROM market_alerts');
    db.prepare("INSERT INTO feed_settings VALUES ('kraken',1,'2026-11-02T14:30:00.000Z')").run();
    damaged(() => vault.markets.settings());
  }));

test('a locked vault has no market store', () =>
  withVault((vault) => {
    vault.lock();
    assert.throws(
      () => vault.markets,
      (e: AppError) => e.status === 401,
    );
  }));

test('a backup holds no market data, and a restore leaves feeds off', () => {
  const source = profile();
  const target = profile();
  try {
    source.vault.setup(password);
    source.vault.markets.setEnabled('coinbase', true, NOW);
    source.vault.markets.saveBatch(batch([bar('BTC-USD', 0), bar('AAPL', 0)], [alert('a', 0)]));
    const backup = source.vault.export('a recovery secret for the test');
    const text = JSON.stringify(decryptBackup(backup, 'a recovery secret for the test'));
    assert.doesNotMatch(text, /market_|BTC-USD|AAPL|closeMinor|coinbase/i);
    target.vault.setup(password, { backup, secret: 'a recovery secret for the test' });
    assert.deepEqual(target.vault.markets.settings(), { coinbase: false, alpaca: false });
    assert.deepEqual(target.vault.markets.bars('BTC-USD'), []);
    assert.deepEqual(target.vault.markets.alerts(), []);
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

const KEY = { keyId: 'PKTESTKEY123456', secret: 'testsecret0987654321' };

test('the Alpaca key goes in the key store under alpaca:<vault id>, and nowhere in the vault', () =>
  withVault((vault, p) => {
    assert.equal(loadAlpacaKey(vault), null);
    saveAlpacaKey(vault, KEY);
    assert.deepEqual(loadAlpacaKey(vault), KEY);
    const stored = p.keys.get(`alpaca:${vault.id}`)!;
    assert.deepEqual(alpacaKeySchema.parse(JSON.parse(stored)), KEY);
    const everything = JSON.stringify([
      dumpMarkets(vault),
      vault.events(),
      vault.tasks(),
      vault.health.backupData(),
    ]);
    assert.ok(!everything.includes(KEY.keyId) && !everything.includes(KEY.secret));
    assert.ok(events(vault).includes('feed.key-saved'));
    removeAlpacaKey(vault);
    assert.equal(p.keys.get(`alpaca:${vault.id}`), null);
    assert.equal(loadAlpacaKey(vault), null);
    assert.ok(events(vault).includes('feed.key-removed'));
  }));

test('the vault id is readable while locked', () =>
  withVault((vault, p) => {
    const id = vault.id;
    vault.lock();
    assert.equal(vault.id, id);
    assert.ok(p.keys.get(id));
  }));

test('an unreadable stored key reads as null', () =>
  withVault((vault, p) => {
    for (const junk of ['not json', '{"keyId":"short"}', '[]', '{"keyId":"PKTESTKEY123456"}']) {
      p.keys.set(`alpaca:${vault.id}`, junk);
      assert.equal(loadAlpacaKey(vault), null);
    }
    const throwing = {
      ...p.keys,
      label: 'x',
      get() {
        throw new Error('denied');
      },
      set() {},
      delete() {},
    };
    const other = Object.create(vault, { keyStore: { value: throwing } });
    assert.equal(loadAlpacaKey(other), null);
  }));

test('removing a key that is absent does nothing', () =>
  withVault((vault) => {
    removeAlpacaKey(vault);
    assert.ok(!events(vault).includes('feed.key-removed'));
  }));
