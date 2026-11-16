import type { FeedBar, FeedPrice } from '../../shared/feedSchema.ts';

// Runs inside the sandboxed worker on Node's built-in TypeScript support: erasable syntax only.
// Messages are fixed text. A response is hostile, so nothing from it is ever quoted.
export class FeedFormatError extends Error {}

const BAR_SECONDS = 900;
// Same per-bar limits as feedBarSchema. The total per message is capped by fetchFeed.
const MAX_VOLUME = 1e15;
const SYMBOL = /^[A-Z0-9]{1,12}(-[A-Z0-9]{1,12})?$/;
const BASE = 'https://api.coinbase.com/api/v3/brokerage/market/products/';
const PAUSE_FLAGS = ['trading_disabled', 'is_disabled', 'cancel_only', 'view_only'] as const;

export const fail = (message: string): never => {
  throw new FeedFormatError(message);
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Works on the decimal text so no float rounding creeps in; the third decimal rounds half up.
export function toMinor(value: string | number): number {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || text.length > 40) return fail('price is not a plain decimal');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return fail('price is not a plain decimal');
  const fraction = match[2] ?? '';
  const cents = BigInt(match[1]) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  const minor = cents + (fraction.length > 2 && fraction.charCodeAt(2) >= 53 ? 1n : 0n);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return fail('price is too large');
  return Number(minor);
}

export function positiveMinor(value: unknown): number {
  const minor = toMinor(value as string | number);
  return minor > 0 ? minor : fail('price is not positive');
}

export function checkedVolume(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_VOLUME
    ? value
    : fail('volume is not a non-negative number');
}

export function checkedSymbol(symbol: string): string {
  return SYMBOL.test(symbol) ? symbol : fail('symbol is not valid');
}

export function checkedBarTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0 || ms % (BAR_SECONDS * 1000) !== 0)
    return fail('bar time is off the 15-minute grid');
  const iso = new Date(ms).toISOString();
  return /^\d{4}-/.test(iso) ? iso : fail('bar time is out of range');
}

export function coinbaseBarsUrl(symbol: string, limit: number): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > 350) fail('limit is out of range');
  return `${BASE}${checkedSymbol(symbol)}/candles?granularity=FIFTEEN_MINUTE&limit=${limit}`;
}

export function coinbasePriceUrl(symbol: string): string {
  return `${BASE}${checkedSymbol(symbol)}`;
}

const textValue = (value: unknown): string =>
  typeof value === 'string' ? value : fail('value is not text');

// Candles arrive newest first; the result is oldest first. One bad row rejects the response.
export function parseCoinbaseBars(symbol: string, body: unknown): FeedBar[] {
  checkedSymbol(symbol);
  if (!isRecord(body) || !Array.isArray(body.candles)) return fail('no candles in the response');
  const bars = body.candles.map((row: unknown): FeedBar => {
    if (!isRecord(row)) return fail('candle is not an object');
    const start = textValue(row.start);
    if (!/^\d{1,12}$/.test(start)) return fail('candle start is not unix seconds');
    const volume = textValue(row.volume);
    if (!/^\d+(\.\d+)?$/.test(volume) || volume.length > 40) return fail('volume is not valid');
    return {
      symbol,
      time: checkedBarTime(Number(start) * 1000),
      closeMinor: positiveMinor(textValue(row.close)),
      volume: checkedVolume(Number(volume)),
    };
  });
  bars.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  for (let i = 1; i < bars.length; i++)
    if (bars[i].time === bars[i - 1].time) fail('two candles share a time');
  return bars;
}

export function parseCoinbasePrice(symbol: string, body: unknown): FeedPrice {
  checkedSymbol(symbol);
  if (!isRecord(body) || body.product_id !== symbol)
    return fail('product is not the one asked for');
  if (typeof body.status !== 'string') return fail('product status is missing');
  let paused = body.status !== 'online';
  for (const flag of PAUSE_FLAGS) {
    if (typeof body[flag] !== 'boolean') return fail('product flag is missing');
    if (body[flag]) paused = true;
  }
  return { symbol, priceMinor: positiveMinor(textValue(body.price)), paused };
}
