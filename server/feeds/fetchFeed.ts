import { MAX_BARS_PER_MESSAGE } from '../../shared/feedSchema.ts';
import type {
  AlpacaKey,
  FeedBar,
  FeedPrice,
  FetchError,
  FetchRequest,
  FetchResult,
} from '../../shared/feedSchema.ts';
import { alpacaBarsUrl, alpacaPricesUrl, parseAlpacaBars, parseAlpacaPrices } from './alpaca.ts';
import {
  FeedFormatError,
  coinbaseBarsUrl,
  coinbasePriceUrl,
  parseCoinbaseBars,
  parseCoinbasePrice,
} from './coinbase.ts';

// Runs inside the sandboxed worker on Node's built-in TypeScript support: erasable syntax only,
// and no imports from server/errors.ts or server/vault.ts. A response is hostile, so nothing
// from it is ever quoted in a result.
export type Http = typeof fetch;

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_RETRY_AFTER = 3600;
const MAX_ALPACA_PAGES = 5;
const DEFAULT_COINBASE_LIMIT = 4;

// Thrown by the helpers below and turned into a FetchResult by fetchFeed. Never leaves this file.
class FeedFailure extends Error {
  code: FetchError;
  retryAfterSeconds?: number;
  constructor(code: FetchError, retryAfterSeconds?: number) {
    super(code);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function retryAfter(headers: Headers): number | undefined {
  const text = headers.get('retry-after');
  if (text === null || !/^\d+$/.test(text)) return undefined;
  return Math.min(Number(text), MAX_RETRY_AFTER);
}

function statusFailure(response: Response): FeedFailure {
  const status = response.status;
  if (status === 401 || status === 403) return new FeedFailure('unauthorized');
  if (status === 429) return new FeedFailure('rate-limited', retryAfter(response.headers));
  // Any other refusal, such as a 400, 404, or 422, won't change by asking again.
  if (status >= 400 && status < 500) return new FeedFailure('malformed');
  return new FeedFailure('network', status >= 500 ? retryAfter(response.headers) : undefined);
}

async function readText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES)
    throw new FeedFailure('too-large');
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new FeedFailure('too-large');
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function getJson(
  http: Http,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await http(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    throw new FeedFailure(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw statusFailure(response);
  }
  let text: string;
  try {
    text = await readText(response);
  } catch (error) {
    if (error instanceof FeedFailure) throw error;
    const name = error instanceof Error ? error.name : '';
    throw new FeedFailure(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new FeedFailure('malformed');
  }
}

async function coinbase(
  request: FetchRequest,
  http: Http,
  signal: AbortSignal,
): Promise<FeedBar[] | FeedPrice[]> {
  const headers = { Accept: 'application/json' };
  if (request.kind === 'bars') {
    const limit = request.limit ?? DEFAULT_COINBASE_LIMIT;
    const bars: FeedBar[] = [];
    for (const symbol of request.symbols)
      bars.push(
        ...parseCoinbaseBars(
          symbol,
          await getJson(http, coinbaseBarsUrl(symbol, limit), headers, signal),
        ),
      );
    if (bars.length > MAX_BARS_PER_MESSAGE) throw new FeedFailure('too-large');
    return bars;
  }
  const prices: FeedPrice[] = [];
  for (const symbol of request.symbols)
    prices.push(
      parseCoinbasePrice(symbol, await getJson(http, coinbasePriceUrl(symbol), headers, signal)),
    );
  return prices;
}

async function alpaca(
  request: FetchRequest,
  key: AlpacaKey,
  http: Http,
  signal: AbortSignal,
): Promise<FeedBar[] | FeedPrice[]> {
  const headers = {
    Accept: 'application/json',
    'APCA-API-KEY-ID': key.keyId,
    'APCA-API-SECRET-KEY': key.secret,
  };
  if (request.kind === 'prices')
    return parseAlpacaPrices(
      request.symbols,
      await getJson(http, alpacaPricesUrl(request.symbols), headers, signal),
    );
  if (request.start === undefined) throw new FeedFailure('malformed');
  const bars: FeedBar[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  for (let page = 0; ; page++) {
    // A token still left after the last allowed page means incomplete data, which would read as gaps.
    if (page === MAX_ALPACA_PAGES) throw new FeedFailure('too-large');
    const url = alpacaBarsUrl(request.symbols, request.start, request.limit, token);
    const parsed = parseAlpacaBars(request.symbols, await getJson(http, url, headers, signal));
    for (const bar of parsed.bars) {
      const id = `${bar.symbol}|${bar.time}`;
      if (seen.has(id)) throw new FeedFormatError('the same bar came on two pages');
      seen.add(id);
    }
    bars.push(...parsed.bars);
    if (bars.length > MAX_BARS_PER_MESSAGE) throw new FeedFailure('too-large');
    if (parsed.nextPageToken === null) break;
    token = parsed.nextPageToken;
  }
  return bars;
}

export async function fetchFeed(
  request: FetchRequest,
  key: AlpacaKey | null,
  http: Http = fetch,
): Promise<FetchResult> {
  // One deadline for the whole call, however many URLs it takes.
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    if (request.feed === 'coinbase') {
      const rows = await coinbase(request, http, signal);
      return request.kind === 'bars'
        ? { ok: true, bars: rows as FeedBar[] }
        : { ok: true, prices: rows as FeedPrice[] };
    }
    if (key === null) return { ok: false, error: 'unauthorized' };
    const rows = await alpaca(request, key, http, signal);
    return request.kind === 'bars'
      ? { ok: true, bars: rows as FeedBar[] }
      : { ok: true, prices: rows as FeedPrice[] };
  } catch (error) {
    if (error instanceof FeedFailure)
      return error.retryAfterSeconds === undefined
        ? { ok: false, error: error.code }
        : { ok: false, error: error.code, retryAfterSeconds: error.retryAfterSeconds };
    if (error instanceof FeedFormatError) return { ok: false, error: 'malformed' };
    return { ok: false, error: 'network' };
  }
}
