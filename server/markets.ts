import type Database from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';
import { FEEDS, dismissSchema, type FeedName, type MarketAlert } from '../shared/feedSchema.ts';
import type { Bar } from '../shared/fixtures.ts';
import { readStored } from './errors.ts';

export const MAX_BARS_PER_SYMBOL = 4000;
export const MAX_ALERTS = 1000;

const time = z.string().max(40).datetime();
const minor = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const barRowSchema = z
  .object({
    symbol: z.string(),
    time,
    revision: z.number().int().min(1),
    close_minor: minor,
    volume: z.number().min(0).max(1e15),
    received_at: time,
  })
  .strict();
const alertRowSchema = z
  .object({
    id: z.string().min(1).max(128),
    symbol: z.string().min(1).max(32),
    time,
    state: z.enum(['Buy setup', 'Sell setup']),
    provider: z.string().max(100),
    venue: z.string().max(100),
    close_minor: minor,
    fast: z.number().finite(),
    slow: z.number().finite(),
    reason: z.string().max(500),
    rule_version: z.string().max(64),
    alerted_at: time,
    dismissed_at: time.nullable(),
    corrected_at: time.nullable(),
  })
  .strict();
const settingRowSchema = z
  .object({
    feed: z.enum(['coinbase', 'alpaca']),
    enabled: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();

export type MarketContext = { event: (action: string) => void };
export type MarketBatch = {
  bars: Bar[];
  alerts: MarketAlert[];
  corrections: { symbol: string; time: string; at: string }[];
};

export class MarketStore {
  constructor(
    private readonly db: Database.Database,
    private readonly context: MarketContext,
  ) {}

  // Oldest first, with revisions of one time together. Everything but the market values is
  // rebuilt from FEEDS, so a symbol no feed carries can't be read back.
  bars(symbol: string): Bar[] {
    return readStored(() => {
      const rows = this.db
        .prepare(
          'SELECT symbol, time, revision, close_minor, volume, received_at FROM market_bars WHERE symbol = ? ORDER BY time, revision',
        )
        .all(symbol);
      if (rows.length === 0) return [];
      const feed = Object.values(FEEDS).find((f) => f.symbols.includes(symbol));
      if (!feed) throw new Error('No feed carries this symbol.');
      return rows.map((raw) => {
        const row = barRowSchema.parse(raw);
        return {
          symbol: row.symbol,
          assetClass: feed.assetClass,
          provider: feed.provider,
          venue: feed.venue,
          currency: 'USD',
          calendar: feed.calendar,
          time: row.time,
          receivedAt: row.received_at,
          interval: '15m',
          revision: row.revision,
          closeMinor: row.close_minor,
          volume: row.volume,
        };
      });
    });
  }

  settings(): Record<FeedName, boolean> {
    return readStored(() => {
      const result: Record<FeedName, boolean> = { coinbase: false, alpaca: false };
      for (const raw of this.db.prepare('SELECT feed, enabled FROM feed_settings').all()) {
        const row = settingRowSchema.parse(raw);
        result[row.feed] = row.enabled === 1;
      }
      return result;
    });
  }

  setEnabled(feed: FeedName, enabled: boolean, now: Date): void {
    this.db
      .prepare(
        'INSERT INTO feed_settings(feed, enabled, consented_at) VALUES (?, ?, ?) ON CONFLICT(feed) DO UPDATE SET enabled = excluded.enabled, consented_at = CASE WHEN excluded.enabled = 1 THEN excluded.consented_at ELSE consented_at END',
      )
      .run(feed, enabled ? 1 : 0, now.toISOString());
    this.context.event(enabled ? 'feed.on' : 'feed.off');
  }

  saveBatch(batch: MarketBatch): void {
    this.db.transaction(() => {
      const insertBar = this.db.prepare(
        'INSERT OR IGNORE INTO market_bars(symbol, time, revision, provider, venue, close_minor, volume, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const b of batch.bars)
        insertBar.run(
          b.symbol,
          b.time,
          b.revision,
          b.provider,
          b.venue,
          b.closeMinor,
          b.volume,
          b.receivedAt,
        );
      const insertAlert = this.db.prepare(
        'INSERT OR IGNORE INTO market_alerts(id, symbol, time, state, provider, venue, close_minor, fast, slow, reason, rule_version, alerted_at, dismissed_at, corrected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const a of batch.alerts)
        insertAlert.run(
          a.id,
          a.symbol,
          a.time,
          a.state,
          a.provider,
          a.venue,
          a.closeMinor,
          a.fast,
          a.slow,
          a.reason,
          a.ruleVersion,
          a.alertedAt,
          a.dismissedAt,
          a.correctedAt,
        );
      const correct = this.db.prepare(
        'UPDATE market_alerts SET corrected_at = ? WHERE symbol = ? AND time = ? AND corrected_at IS NULL',
      );
      for (const c of batch.corrections) correct.run(c.at, c.symbol, c.time);
      // Per symbol, only the newest times stay, with every revision of each.
      const symbols = new Set(batch.bars.map((b) => b.symbol));
      const prune = this.db.prepare(
        'DELETE FROM market_bars WHERE symbol = ? AND time NOT IN (SELECT DISTINCT time FROM market_bars WHERE symbol = ? ORDER BY time DESC LIMIT ?)',
      );
      for (const symbol of symbols) prune.run(symbol, symbol, MAX_BARS_PER_SYMBOL);
      this.db
        .prepare(
          'DELETE FROM market_alerts WHERE rowid NOT IN (SELECT rowid FROM market_alerts ORDER BY alerted_at DESC, rowid DESC LIMIT ?)',
        )
        .run(MAX_ALERTS);
    })();
  }

  alerts(): MarketAlert[] {
    return readStored(() =>
      this.db
        .prepare('SELECT * FROM market_alerts ORDER BY alerted_at DESC, rowid DESC')
        .all()
        .map((raw) => {
          const row = alertRowSchema.parse(raw);
          return {
            id: row.id,
            symbol: row.symbol,
            time: row.time,
            state: row.state,
            provider: row.provider,
            venue: row.venue,
            closeMinor: row.close_minor,
            fast: row.fast,
            slow: row.slow,
            reason: row.reason,
            ruleVersion: row.rule_version,
            alertedAt: row.alerted_at,
            dismissedAt: row.dismissed_at,
            correctedAt: row.corrected_at,
          };
        }),
    );
  }

  dismiss(input: unknown, now: Date): void {
    const request = dismissSchema.parse(input);
    const at = now.toISOString();
    const ids = 'id' in request ? [request.id] : request.ids;
    const update = this.db.prepare(
      'UPDATE market_alerts SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL',
    );
    this.db.transaction(() => {
      for (const id of ids) update.run(at, id);
    })();
  }

  // Bars and alerts only. Whether a feed is on is the owner's choice, and stays.
  purge(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM market_bars').run();
      this.db.prepare('DELETE FROM market_alerts').run();
    })();
    this.context.event('feed.purge');
  }
}
