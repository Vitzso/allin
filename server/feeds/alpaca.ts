import type { FeedBar, FeedPrice } from '../../shared/feedSchema.ts';
import {
  checkedBarTime,
  checkedSymbol,
  checkedVolume,
  fail,
  isRecord,
  positiveMinor,
} from './coinbase.ts';

// Runs inside the sandboxed worker on Node's built-in TypeScript support: erasable syntax only.
const HOST = 'https://data.alpaca.markets';

function symbolList(symbols: string[]): string {
  if (symbols.length < 1 || symbols.length > 20) fail('symbol list is out of range');
  return symbols.map(checkedSymbol).join(',');
}

export function alpacaBarsUrl(
  symbols: string[],
  start: string,
  limit: number = 10000,
  pageToken?: string,
): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) fail('limit is out of range');
  const params = new URLSearchParams({
    symbols: symbolList(symbols),
    timeframe: '15Min',
    feed: 'iex',
    adjustment: 'raw',
    sort: 'asc',
    start,
    limit: String(limit),
  });
  if (pageToken !== undefined) params.set('page_token', pageToken);
  return `${HOST}/v2/stocks/bars?${params}`;
}

export function alpacaPricesUrl(symbols: string[]): string {
  const params = new URLSearchParams({ symbols: symbolList(symbols), feed: 'iex' });
  return `${HOST}/v2/stocks/snapshots?${params}`;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export function parseAlpacaBars(
  symbols: string[],
  body: unknown,
): { bars: FeedBar[]; nextPageToken: string | null } {
  if (!isRecord(body)) return fail('response is not an object');
  const token = body.next_page_token ?? null;
  if (token !== null && (typeof token !== 'string' || token.length < 1 || token.length > 512))
    return fail('page token is not valid');
  const grouped = body.bars === null ? {} : body.bars;
  if (!isRecord(grouped)) return fail('no bars in the response');
  const bars: FeedBar[] = [];
  for (const [symbol, rows] of Object.entries(grouped)) {
    if (!symbols.includes(symbol)) return fail('response holds a symbol not asked for');
    if (!Array.isArray(rows)) return fail('bars are not a list');
    const own: FeedBar[] = [];
    for (const row of rows as unknown[]) {
      if (!isRecord(row) || typeof row.t !== 'string' || !ISO_UTC.test(row.t))
        return fail('bar time is not valid');
      if (typeof row.c !== 'number') return fail('bar price is not a number');
      own.push({
        symbol,
        time: checkedBarTime(Date.parse(row.t)),
        closeMinor: positiveMinor(row.c),
        volume: checkedVolume(row.v),
      });
    }
    own.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    for (let i = 1; i < own.length; i++)
      if (own[i].time === own[i - 1].time) return fail('two bars share a time');
    bars.push(...own);
  }
  return { bars, nextPageToken: token };
}

// A symbol with no latest trade (IEX may have none yet) is left out rather than failing the rest.
export function parseAlpacaPrices(symbols: string[], body: unknown): FeedPrice[] {
  if (!isRecord(body)) return fail('response is not an object');
  const prices: FeedPrice[] = [];
  for (const [symbol, snapshot] of Object.entries(body)) {
    if (!symbols.includes(symbol)) return fail('response holds a symbol not asked for');
    if (!isRecord(snapshot)) return fail('snapshot is not an object');
    const trade = snapshot.latestTrade;
    if (trade === undefined || trade === null) continue;
    if (!isRecord(trade) || typeof trade.p !== 'number') return fail('trade price is not a number');
    prices.push({ symbol, priceMinor: positiveMinor(trade.p), paused: false });
  }
  return prices;
}
