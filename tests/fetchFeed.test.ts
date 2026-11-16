import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchFeed, type Http } from '../server/feeds/fetchFeed.ts';
import type { AlpacaKey, FetchRequest } from '../shared/feedSchema.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/feeds/${name}`, import.meta.url), 'utf8');
const MARKER = 'SECRETMARKER123';
const key: AlpacaKey = { keyId: 'KEYIDMARKER123', secret: MARKER };

type Call = { url: string; init: RequestInit };
function fakeHttp(respond: (url: string, call: number) => Response | Promise<Response>): {
  http: Http;
  calls: Call[];
} {
  const calls: Call[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, calls.length - 1);
  }) as Http;
  return { http, calls };
}
const json = (text: string, init: ResponseInit = {}): Response =>
  new Response(text, { status: 200, ...init });
const headerNames = (call: Call): string[] =>
  Object.keys((call.init.headers ?? {}) as Record<string, string>).map((n) => n.toLowerCase());
const headerText = (call: Call): string => JSON.stringify(call.init.headers ?? {});

const coinbaseBars: FetchRequest = {
  feed: 'coinbase',
  kind: 'bars',
  symbols: ['BTC-USD', 'ETH-USD'],
  limit: 4,
};
const alpacaBars: FetchRequest = {
  feed: 'alpaca',
  kind: 'bars',
  symbols: ['AAPL', 'NVDA'],
  start: '2026-11-06T14:00:00Z',
};

test('every request refuses redirects and has a timeout signal', async () => {
  const { http, calls } = fakeHttp((url) =>
    json(
      url.includes('candles') ? fixture('coinbase-candles.json') : fixture('coinbase-product.json'),
    ),
  );
  await fetchFeed(coinbaseBars, null, http);
  await fetchFeed({ feed: 'coinbase', kind: 'prices', symbols: ['BTC-USD'] }, null, http);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
});

test('one 10-second deadline is shared across a whole fetchFeed call', async () => {
  const { http, calls } = fakeHttp(() => json(fixture('coinbase-candles.json')));
  await fetchFeed(coinbaseBars, null, http);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.signal, calls[1].init.signal);
  const pages = fakeHttp((_u, n) =>
    json(JSON.stringify({ bars: {}, next_page_token: n < 2 ? `t${n}` : null })),
  );
  await fetchFeed(alpacaBars, key, pages.http);
  assert.equal(pages.calls.length, 3);
  assert.ok(pages.calls.every((c) => c.init.signal === pages.calls[0].init.signal));
});

test('Coinbase bars fetch one URL per symbol and merge them', async () => {
  const { http, calls } = fakeHttp(() => json(fixture('coinbase-candles.json')));
  const result = await fetchFeed(coinbaseBars, null, http);
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      'https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles?granularity=FIFTEEN_MINUTE&limit=4',
      'https://api.coinbase.com/api/v3/brokerage/market/products/ETH-USD/candles?granularity=FIFTEEN_MINUTE&limit=4',
    ],
  );
  assert.ok(result.ok && 'bars' in result);
  assert.equal(result.bars.length, 8);
  assert.deepEqual([...new Set(result.bars.map((b) => b.symbol))], ['BTC-USD', 'ETH-USD']);
});

test('Coinbase prices fetch one product URL per symbol', async () => {
  const { http, calls } = fakeHttp(() => json(fixture('coinbase-product.json')));
  const result = await fetchFeed(
    { feed: 'coinbase', kind: 'prices', symbols: ['BTC-USD'] },
    null,
    http,
  );
  assert.equal(calls[0].url, 'https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD');
  assert.ok(result.ok && 'prices' in result);
  assert.equal(result.prices[0].symbol, 'BTC-USD');
});

test('Alpaca sends its key headers', async () => {
  const { http, calls } = fakeHttp(() => json(JSON.stringify({ bars: {}, next_page_token: null })));
  await fetchFeed(alpacaBars, key, http);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['APCA-API-KEY-ID'], key.keyId);
  assert.equal(headers['APCA-API-SECRET-KEY'], key.secret);
  assert.ok(calls[0].url.startsWith('https://data.alpaca.markets/v2/stocks/bars?'));
});

test('Alpaca prices use the snapshots URL', async () => {
  const { http, calls } = fakeHttp(() => json(fixture('alpaca-snapshots.json')));
  const result = await fetchFeed(
    { feed: 'alpaca', kind: 'prices', symbols: ['AAPL', 'NVDA'] },
    key,
    http,
  );
  assert.ok(calls[0].url.startsWith('https://data.alpaca.markets/v2/stocks/snapshots?'));
  assert.ok(result.ok && 'prices' in result);
  assert.equal(result.prices.length, 2);
});

test('Alpaca without a key gives unauthorized and calls nothing', async () => {
  const { http, calls } = fakeHttp(() => json('{}'));
  assert.deepEqual(await fetchFeed(alpacaBars, null, http), { ok: false, error: 'unauthorized' });
  assert.equal(calls.length, 0);
});

test('no key is ever sent to Coinbase', async () => {
  const { http, calls } = fakeHttp((url) =>
    json(
      url.includes('candles') ? fixture('coinbase-candles.json') : fixture('coinbase-product.json'),
    ),
  );
  await fetchFeed(coinbaseBars, key, http);
  await fetchFeed({ feed: 'coinbase', kind: 'prices', symbols: ['BTC-USD'] }, key, http);
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.ok(!headerText(call).includes(MARKER));
    assert.ok(!headerText(call).includes(key.keyId));
    assert.ok(!call.url.includes(MARKER));
    assert.ok(!headerNames(call).some((n) => n.startsWith('apca')));
  }
});

test('Alpaca bars follow page tokens, at most 5 pages, and a token left after page 5 gives too-large', async () => {
  const { http, calls } = fakeHttp((_url, n) =>
    json(JSON.stringify({ bars: {}, next_page_token: `token${n}` })),
  );
  const result = await fetchFeed(alpacaBars, key, http);
  assert.equal(calls.length, 5);
  assert.ok(!calls[0].url.includes('page_token'));
  assert.ok(calls[1].url.includes('page_token=token0'));
  assert.ok(calls[4].url.includes('page_token=token3'));
  assert.deepEqual(result, { ok: false, error: 'too-large' });

  // Exactly five pages whose last token is null is complete.
  const five = fakeHttp((_u, n) =>
    json(JSON.stringify({ bars: {}, next_page_token: n < 4 ? `t${n}` : null })),
  );
  assert.deepEqual(await fetchFeed(alpacaBars, key, five.http), { ok: true, bars: [] });
  assert.equal(five.calls.length, 5);

  // Two pages: the second page's token is null, so it stops there and merges both.
  const pages = [fixture('alpaca-bars.json'), JSON.stringify({ bars: {}, next_page_token: null })];
  const two = fakeHttp((_u, n) => json(pages[n]));
  const merged = await fetchFeed(alpacaBars, key, two.http);
  assert.equal(two.calls.length, 2);
  assert.ok(merged.ok && 'bars' in merged);
  assert.equal(merged.bars.length, 3);
});

test('the same symbol and time on two pages gives malformed', async () => {
  const page = (token: string | null): Response =>
    json(
      JSON.stringify({
        bars: { AAPL: [{ t: '2026-11-06T14:30:00Z', c: 232.13, v: 10 }] },
        next_page_token: token,
      }),
    );
  const { http } = fakeHttp((_u, n) => page(n === 0 ? 'next' : null));
  assert.deepEqual(await fetchFeed(alpacaBars, key, http), { ok: false, error: 'malformed' });
});

const alpacaRows = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    t: new Date(Date.UTC(2026, 0, 1) + (from + i) * 900_000).toISOString().replace('.000Z', 'Z'),
    c: 100,
    v: 1,
  }));

test('more than 10,000 merged bars gives too-large, so the worker line stays inside the schema', async () => {
  const pages = [
    JSON.stringify({ bars: { AAPL: alpacaRows(0, 6000) }, next_page_token: 'more' }),
    JSON.stringify({ bars: { AAPL: alpacaRows(6000, 6000) }, next_page_token: null }),
  ];
  const { http } = fakeHttp((_u, n) => json(pages[n]));
  assert.deepEqual(await fetchFeed(alpacaBars, key, http), { ok: false, error: 'too-large' });

  const candles = Array.from({ length: 10_001 }, (_, i) => ({
    start: String(1794083400 - 900 * i),
    close: '100.00',
    volume: '1',
  }));
  const coinbase = fakeHttp(() => json(JSON.stringify({ candles })));
  assert.deepEqual(
    await fetchFeed(
      { feed: 'coinbase', kind: 'bars', symbols: ['BTC-USD'], limit: 4 },
      null,
      coinbase.http,
    ),
    { ok: false, error: 'too-large' },
  );
});

test('only the two known hosts are ever called', async () => {
  const { http, calls } = fakeHttp((url) => {
    if (url.includes('candles')) return json(fixture('coinbase-candles.json'));
    if (url.includes('snapshots')) return json(fixture('alpaca-snapshots.json'));
    if (url.includes('api.coinbase.com')) return json(fixture('coinbase-product.json'));
    return json(JSON.stringify({ bars: {}, next_page_token: null }));
  });
  await fetchFeed(coinbaseBars, key, http);
  await fetchFeed({ feed: 'coinbase', kind: 'prices', symbols: ['BTC-USD', 'ETH-USD'] }, key, http);
  await fetchFeed(alpacaBars, key, http);
  await fetchFeed({ feed: 'alpaca', kind: 'prices', symbols: ['AAPL'] }, key, http);
  assert.ok(calls.length >= 6);
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(['api.coinbase.com', 'data.alpaca.markets'].includes(url.host), url.host);
  }
});

for (const [status, want] of [
  [401, 'unauthorized'],
  [403, 'unauthorized'],
  [429, 'rate-limited'],
  [500, 'network'],
  [503, 'network'],
  // Any other refusal won't change by asking again, so it reads as an unexpected response.
  [400, 'malformed'],
  [404, 'malformed'],
  [410, 'malformed'],
  [422, 'malformed'],
  [499, 'malformed'],
] as const)
  test(`status ${status} gives ${want}`, async () => {
    const { http } = fakeHttp(() => new Response('nope', { status }));
    assert.deepEqual(await fetchFeed(alpacaBars, key, http), { ok: false, error: want });
    const coinbase = fakeHttp(() => new Response('nope', { status }));
    assert.deepEqual(
      await fetchFeed(coinbaseBars, null, coinbase.http),
      // Coinbase needs no key, so its 401 and 403 read the same as Alpaca's at this layer.
      { ok: false, error: want },
    );
  });

test('a 4xx answer other than 401, 403, and 429 carries no Retry-After', async () => {
  const { http } = fakeHttp(
    () => new Response('', { status: 422, headers: { 'Retry-After': '120' } }),
  );
  assert.deepEqual(await fetchFeed(alpacaBars, key, http), { ok: false, error: 'malformed' });
});

test('Retry-After is reported, capped at 3600, and ignored when not a number', async () => {
  const withHeader = (value: string): Http =>
    fakeHttp(() => new Response('', { status: 429, headers: { 'Retry-After': value } })).http;
  assert.deepEqual(await fetchFeed(alpacaBars, key, withHeader('120')), {
    ok: false,
    error: 'rate-limited',
    retryAfterSeconds: 120,
  });
  assert.deepEqual(await fetchFeed(alpacaBars, key, withHeader('99999')), {
    ok: false,
    error: 'rate-limited',
    retryAfterSeconds: 3600,
  });
  assert.deepEqual(await fetchFeed(alpacaBars, key, withHeader('99999999999999999999')), {
    ok: false,
    error: 'rate-limited',
    retryAfterSeconds: 3600,
  });
  for (const bad of ['soon', 'Wed, 21 Oct 2026 07:28:00 GMT', '-5', '1.5', '']) {
    assert.deepEqual(await fetchFeed(alpacaBars, key, withHeader(bad)), {
      ok: false,
      error: 'rate-limited',
    });
  }
});

test('a thrown fetch gives network, and an aborted one gives timeout', async () => {
  const thrown = fakeHttp(() => {
    throw new TypeError('fetch failed');
  });
  assert.deepEqual(await fetchFeed(alpacaBars, key, thrown.http), { ok: false, error: 'network' });
  const timedOut = fakeHttp(() => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  assert.deepEqual(await fetchFeed(alpacaBars, key, timedOut.http), {
    ok: false,
    error: 'timeout',
  });
  const aborted = fakeHttp(() => {
    throw new DOMException('aborted', 'AbortError');
  });
  assert.deepEqual(await fetchFeed(alpacaBars, key, aborted.http), { ok: false, error: 'timeout' });
});

test('a redirect response gives network', async () => {
  const { http } = fakeHttp(
    () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }),
  );
  assert.deepEqual(await fetchFeed(alpacaBars, key, http), { ok: false, error: 'network' });
  const redirectThrown = fakeHttp(() => {
    throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  });
  assert.deepEqual(await fetchFeed(alpacaBars, key, redirectThrown.http), {
    ok: false,
    error: 'network',
  });
});

test('bad JSON or a bad row gives malformed, with no response text in the result', async () => {
  const leak = 'LEAKED-RESPONSE-TEXT';
  const badJson = fakeHttp(() => json(`{ not json ${leak}`));
  const first = await fetchFeed(alpacaBars, key, badJson.http);
  assert.deepEqual(first, { ok: false, error: 'malformed' });
  const badRow = fakeHttp(() =>
    json(JSON.stringify({ bars: { AAPL: [{ t: leak, c: 1, v: 1 }] }, next_page_token: null })),
  );
  const second = await fetchFeed(alpacaBars, key, badRow.http);
  assert.deepEqual(second, { ok: false, error: 'malformed' });
  assert.ok(!JSON.stringify([first, second]).includes(leak));
});

test('a body over 8 MB gives too-large, without reading it all', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunk.length;
      controller.enqueue(chunk);
      if (pulled > 100 * 1024 * 1024) controller.close();
    },
  });
  const { http } = fakeHttp(() => new Response(stream, { status: 200 }));
  assert.deepEqual(await fetchFeed(alpacaBars, key, http), { ok: false, error: 'too-large' });
  assert.ok(pulled <= 12 * 1024 * 1024, `pulled ${pulled} bytes`);
});

test('a declared length over 8 MB gives too-large', async () => {
  const { http } = fakeHttp(
    () =>
      new Response('{}', { status: 200, headers: { 'Content-Length': String(9 * 1024 * 1024) } }),
  );
  assert.deepEqual(await fetchFeed(alpacaBars, key, http), { ok: false, error: 'too-large' });
});
