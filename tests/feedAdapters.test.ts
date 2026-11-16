import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FeedFormatError,
  coinbaseBarsUrl,
  coinbasePriceUrl,
  parseCoinbaseBars,
  parseCoinbasePrice,
  toMinor,
} from '../server/feeds/coinbase.ts';
import {
  alpacaBarsUrl,
  alpacaPricesUrl,
  parseAlpacaBars,
  parseAlpacaPrices,
} from '../server/feeds/alpaca.ts';
import {
  FEEDS,
  alpacaKeySchema,
  alpacaToggleSchema,
  dismissSchema,
  feedBarSchema,
  feedPriceSchema,
  feedToggleSchema,
  serverMessageSchema,
  workerMessageSchema,
} from '../shared/feedSchema.ts';

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/feeds/${name}`, import.meta.url), 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const candles = () => load('coinbase-candles.json');
const product = () => load('coinbase-product.json');
const alpacaBars = () => load('alpaca-bars.json');
const snapshots = () => load('alpaca-snapshots.json');

for (const [input, want] of [
  ['75672.72', 7567272],
  [232.13, 23213],
  ['1.005', 101],
  ['1.004', 100],
  ['100', 10000],
] as const)
  test(`toMinor(${input})`, () => assert.equal(toMinor(input), want));

for (const bad of [
  '-1',
  '1e5',
  '',
  'abc',
  1e21,
  Number.POSITIVE_INFINITY,
  Number.NaN,
  '9007199254740993',
])
  test(`toMinor rejects ${bad}`, () => assert.throws(() => toMinor(bad), FeedFormatError));

test('Coinbase URLs', () => {
  assert.equal(
    coinbaseBarsUrl('BTC-USD', 4),
    'https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles?granularity=FIFTEEN_MINUTE&limit=4',
  );
  assert.equal(
    coinbasePriceUrl('ETH-USD'),
    'https://api.coinbase.com/api/v3/brokerage/market/products/ETH-USD',
  );
});

test('URL builders refuse a symbol that could change the path', () => {
  assert.throws(() => coinbasePriceUrl('../accounts'), FeedFormatError);
  assert.throws(() => coinbaseBarsUrl('BTC-USD?x=1', 4), FeedFormatError);
  assert.throws(() => alpacaPricesUrl(['AAPL,TSLA&feed=sip']), FeedFormatError);
});

test('Alpaca URLs send the IEX feed and raw prices', () => {
  const url = alpacaBarsUrl(['AAPL', 'NVDA'], '2026-11-06T00:00:00.000Z');
  assert.equal(new URL(url).host, 'data.alpaca.markets');
  assert.equal(new URL(url).pathname, '/v2/stocks/bars');
  const q = new URL(url).searchParams;
  assert.deepEqual(
    [
      q.get('symbols'),
      q.get('timeframe'),
      q.get('feed'),
      q.get('adjustment'),
      q.get('sort'),
      q.get('limit'),
    ],
    ['AAPL,NVDA', '15Min', 'iex', 'raw', 'asc', '10000'],
  );
  assert.equal(
    new URL(alpacaBarsUrl(['AAPL'], 'x', 1, 'tok')).searchParams.get('page_token'),
    'tok',
  );
  assert.equal(new URL(alpacaPricesUrl(['AAPL'])).searchParams.get('feed'), 'iex');
  assert.equal(new URL(alpacaPricesUrl(['AAPL'])).pathname, '/v2/stocks/snapshots');
});

test('the recorded Coinbase bars parse, oldest first', () => {
  const bars = parseCoinbaseBars('BTC-USD', candles());
  assert.equal(bars.length, 4);
  const times = bars.map((bar) => Date.parse(bar.time));
  for (let i = 0; i < times.length; i++) {
    assert.equal(times[i] % 900000, 0);
    if (i > 0) assert.ok(times[i] > times[i - 1]);
  }
  for (const bar of bars) assert.equal(bar.time, new Date(bar.time).toISOString());
  assert.deepEqual(bars.at(-1), {
    symbol: 'BTC-USD',
    time: new Date(1794083400 * 1000).toISOString(),
    closeMinor: 7564036,
    volume: 18.32270875,
  });
  assert.equal(bars[0].closeMinor, 7569223);
  for (const bar of bars) assert.deepEqual(feedBarSchema.parse(bar), bar);
});

test('the recorded Coinbase price parses as not paused', () => {
  const price = parseCoinbasePrice('BTC-USD', product());
  assert.deepEqual(price, { symbol: 'BTC-USD', priceMinor: 7564036, paused: false });
  assert.deepEqual(feedPriceSchema.parse(price), price);
});

for (const flag of [
  { status: 'offline' },
  { trading_disabled: true },
  { is_disabled: true },
  { cancel_only: true },
  { view_only: true },
])
  test(`Coinbase ${JSON.stringify(flag)} reads as paused`, () => {
    const body = { ...product(), ...flag };
    assert.equal(parseCoinbasePrice('BTC-USD', body).paused, true);
  });

test('Alpaca bars parse across symbols, and report the page token', () => {
  const { bars, nextPageToken } = parseAlpacaBars(['AAPL', 'NVDA'], alpacaBars());
  assert.equal(nextPageToken, 'QUFQTHwxNUZpbnx8MjAyNi0xMS0wNlQxNDo0NTowMFo');
  assert.deepEqual(bars, [
    { symbol: 'AAPL', time: '2026-11-06T14:30:00.000Z', closeMinor: 23213, volume: 1200 },
    { symbol: 'AAPL', time: '2026-11-06T14:45:00.000Z', closeMinor: 23350, volume: 900 },
    { symbol: 'NVDA', time: '2026-11-06T14:30:00.000Z', closeMinor: 19075, volume: 3400 },
  ]);
  const last = parseAlpacaBars(['AAPL'], { bars: {}, next_page_token: null });
  assert.deepEqual(last, { bars: [], nextPageToken: null });
});

test('Alpaca prices parse', () => {
  assert.deepEqual(parseAlpacaPrices(['AAPL', 'NVDA'], snapshots()), [
    { symbol: 'AAPL', priceMinor: 23213, paused: false },
    { symbol: 'NVDA', priceMinor: 19075, paused: false },
  ]);
});

// One bad row discards the whole response, so a caller never sees part of a history.
const withCandle = (change: (row: Record<string, unknown>) => void) => () => {
  const body = candles();
  change(body.candles[1]);
  return body;
};
const coinbaseBars: [string, () => unknown][] = [
  ['price 0', withCandle((r) => (r.close = '0'))],
  ['a negative price', withCandle((r) => (r.close = '-5'))],
  ['text for a price', withCandle((r) => (r.close = 'abc'))],
  ['a numeric price', withCandle((r) => (r.close = 75000))],
  ['a missing price', withCandle((r) => delete r.close)],
  ['a time off the grid', withCandle((r) => (r.start = '1794082501'))],
  ['an unparseable time', withCandle((r) => (r.start = 'soon'))],
  ['a missing time', withCandle((r) => delete r.start)],
  ['a negative volume', withCandle((r) => (r.volume = '-1'))],
  ['a volume of NaN', withCandle((r) => (r.volume = 'NaN'))],
  ['a missing volume', withCandle((r) => delete r.volume)],
  ['a repeated time', withCandle((r) => (r.start = '1794083400'))],
  ['a row that is not an object', () => ({ candles: [1] })],
  ['candles not an array', () => ({ candles: {} })],
  ['no candles field', () => ({})],
  ['a null body', () => null],
  ['a string body', () => 'candles'],
];
for (const [name, build] of coinbaseBars)
  test(`a Coinbase bars response with ${name} is rejected whole`, () =>
    assert.throws(() => parseCoinbaseBars('BTC-USD', build()), FeedFormatError));

const withProduct = (change: (body: Record<string, unknown>) => void) => () => {
  const body = product();
  change(body);
  return body;
};
const coinbasePrices: [string, () => unknown][] = [
  ['price 0', withProduct((b) => (b.price = '0'))],
  ['a negative price', withProduct((b) => (b.price = '-1'))],
  ['text for a price', withProduct((b) => (b.price = 'abc'))],
  ['a missing price', withProduct((b) => delete b.price)],
  ['a symbol not asked for', withProduct((b) => (b.product_id = 'ETH-USD'))],
  ['a missing status', withProduct((b) => delete b.status)],
  ['a flag that is not a boolean', withProduct((b) => (b.view_only = 'no'))],
  ['a missing flag', withProduct((b) => delete b.cancel_only)],
  ['a null body', () => null],
];
for (const [name, build] of coinbasePrices)
  test(`a Coinbase price response with ${name} is rejected whole`, () =>
    assert.throws(() => parseCoinbasePrice('BTC-USD', build()), FeedFormatError));

const withAlpacaRow = (change: (row: Record<string, unknown>) => void) => () => {
  const body = alpacaBars();
  change(body.bars.NVDA[0]);
  return body;
};
const alpacaBad: [string, () => unknown][] = [
  ['price 0', withAlpacaRow((r) => (r.c = 0))],
  ['a negative price', withAlpacaRow((r) => (r.c = -1))],
  ['text for a price', withAlpacaRow((r) => (r.c = '190.75'))],
  ['a missing price', withAlpacaRow((r) => delete r.c)],
  ['a time off the grid', withAlpacaRow((r) => (r.t = '2026-11-06T14:31:00Z'))],
  ['an unparseable time', withAlpacaRow((r) => (r.t = 'later'))],
  ['a missing time', withAlpacaRow((r) => delete r.t)],
  ['a negative volume', withAlpacaRow((r) => (r.v = -1))],
  ['a volume of NaN', withAlpacaRow((r) => (r.v = Number.NaN))],
  ['a missing volume', withAlpacaRow((r) => delete r.v)],
  [
    'a symbol not asked for',
    () => {
      const body = alpacaBars();
      body.bars.TSLA = body.bars.NVDA;
      return body;
    },
  ],
  [
    'a symbol whose bars are not an array',
    () => {
      const body = alpacaBars();
      body.bars.NVDA = {};
      return body;
    },
  ],
  [
    'a page token that is not text',
    () => {
      const body = alpacaBars();
      body.next_page_token = 7;
      return body;
    },
  ],
  ['no bars field', () => ({ next_page_token: null })],
  ['a null body', () => null],
];
for (const [name, build] of alpacaBad)
  test(`an Alpaca bars response with ${name} is rejected whole`, () =>
    assert.throws(() => parseAlpacaBars(['AAPL', 'NVDA'], build()), FeedFormatError));

const withTrade = (change: (trade: Record<string, unknown>) => void) => () => {
  const body = snapshots();
  change(body.NVDA.latestTrade);
  return body;
};
const alpacaPriceBad: [string, () => unknown][] = [
  ['price 0', withTrade((t) => (t.p = 0))],
  ['a negative price', withTrade((t) => (t.p = -190))],
  ['text for a price', withTrade((t) => (t.p = '190.75'))],
  ['a missing price', withTrade((t) => delete t.p)],
  [
    'a symbol not asked for',
    () => ({ ...snapshots(), TSLA: { latestTrade: { p: 1, t: '2026-11-06T14:31:00Z' } } }),
  ],
  ['a null body', () => null],
];
for (const [name, build] of alpacaPriceBad)
  test(`an Alpaca price response with ${name} is rejected whole`, () =>
    assert.throws(() => parseAlpacaPrices(['AAPL', 'NVDA'], build()), FeedFormatError));

test('an Alpaca symbol with no latest trade is skipped, not an error', () => {
  const body = { AAPL: snapshots().AAPL, NVDA: {} };
  assert.deepEqual(parseAlpacaPrices(['AAPL', 'NVDA'], body), [
    { symbol: 'AAPL', priceMinor: 23213, paused: false },
  ]);
});

test('no message quotes the response', () => {
  const marker = 'PRIVATE-MARKER';
  const attempts: (() => unknown)[] = [
    () => parseCoinbaseBars('BTC-USD', { candles: [{ start: marker, close: '1', volume: '1' }] }),
    () =>
      parseCoinbaseBars('BTC-USD', {
        candles: [{ start: '1794083400', close: marker, volume: '1' }],
      }),
    () =>
      parseCoinbaseBars('BTC-USD', {
        candles: [{ start: '1794083400', close: '1', volume: marker }],
      }),
    () => parseCoinbasePrice('BTC-USD', { ...product(), price: marker }),
    () => parseCoinbasePrice('BTC-USD', { ...product(), product_id: marker }),
    () => parseCoinbasePrice('BTC-USD', { ...product(), status: { marker } }),
    () => parseAlpacaBars(['AAPL'], { bars: { [marker]: [] }, next_page_token: null }),
    () =>
      parseAlpacaBars(['AAPL'], {
        bars: { AAPL: [{ t: marker, c: 1, v: 1 }] },
        next_page_token: null,
      }),
    () =>
      parseAlpacaBars(['AAPL'], {
        bars: { AAPL: [{ t: '2026-11-06T14:30:00Z', c: marker, v: 1 }] },
        next_page_token: null,
      }),
    () => parseAlpacaBars(['AAPL'], { bars: { AAPL: [] }, next_page_token: { marker } }),
    () => parseAlpacaPrices(['AAPL'], { [marker]: { latestTrade: { p: 1 } } }),
    () => parseAlpacaPrices(['AAPL'], { AAPL: { latestTrade: { p: marker } } }),
    () => toMinor(marker),
  ];
  for (const attempt of attempts)
    assert.throws(attempt, (error: unknown) => {
      assert.ok(error instanceof FeedFormatError);
      assert.ok(!error.message.includes(marker));
      assert.ok(!String(error.stack).includes(marker));
      return true;
    });
});

test('schemas refuse unknown fields and over-large values', () => {
  const bar = { symbol: 'BTC-USD', time: '2026-11-06T14:30:00.000Z', closeMinor: 100, volume: 1 };
  assert.ok(feedBarSchema.safeParse(bar).success);
  assert.ok(!feedBarSchema.safeParse({ ...bar, extra: 1 }).success);
  for (const closeMinor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])
    assert.ok(!feedBarSchema.safeParse({ ...bar, closeMinor }).success, `closeMinor ${closeMinor}`);
  for (const volume of [-1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.ok(!feedBarSchema.safeParse({ ...bar, volume }).success, `volume ${volume}`);
  assert.ok(!feedBarSchema.safeParse({ ...bar, symbol: 'X'.repeat(500) }).success);
  assert.ok(!feedBarSchema.safeParse({ ...bar, time: 'x'.repeat(5000) }).success);

  const price = { symbol: 'BTC-USD', priceMinor: 100, paused: false };
  assert.ok(feedPriceSchema.safeParse(price).success);
  assert.ok(!feedPriceSchema.safeParse({ ...price, extra: 1 }).success);
  assert.ok(!feedPriceSchema.safeParse({ ...price, priceMinor: 0 }).success);
  assert.ok(!feedPriceSchema.safeParse({ ...price, priceMinor: 2 ** 53 }).success);

  const good = { keyId: 'PKABCDEF12', secret: 'abcdefgh_12-34.56' };
  assert.ok(alpacaKeySchema.safeParse(good).success);
  assert.deepEqual(
    alpacaKeySchema.parse({ keyId: ' PKABCDEF12 ', secret: good.secret }).keyId,
    'PKABCDEF12',
  );
  assert.ok(!alpacaKeySchema.safeParse({ ...good, extra: 1 }).success);
  assert.ok(!alpacaKeySchema.safeParse({ ...good, keyId: 'short' }).success);
  assert.ok(!alpacaKeySchema.safeParse({ ...good, secret: 'a'.repeat(129) }).success);
  assert.ok(!alpacaKeySchema.safeParse({ ...good, secret: 'has space 123' }).success);
  assert.ok(!alpacaKeySchema.safeParse({ ...good, secret: 'quote"quote12' }).success);

  assert.ok(feedToggleSchema.safeParse({ enabled: true }).success);
  assert.ok(!feedToggleSchema.safeParse({ enabled: true, keyId: 'PKABCDEF12' }).success);
  assert.ok(!feedToggleSchema.safeParse({ enabled: 'yes' }).success);

  assert.ok(alpacaToggleSchema.safeParse({ enabled: false }).success);
  assert.ok(alpacaToggleSchema.safeParse({ enabled: true, ...good }).success);
  assert.ok(!alpacaToggleSchema.safeParse({ enabled: true, keyId: good.keyId }).success);
  assert.ok(!alpacaToggleSchema.safeParse({ enabled: true, secret: good.secret }).success);
  assert.ok(!alpacaToggleSchema.safeParse({ enabled: true, ...good, extra: 1 }).success);

  assert.ok(dismissSchema.safeParse({ id: 'abc' }).success);
  assert.ok(dismissSchema.safeParse({ ids: ['abc', 'def'] }).success);
  assert.ok(
    dismissSchema.safeParse({ ids: Array.from({ length: 1000 }, (_, i) => `a${i}`) }).success,
  );
  assert.ok(
    !dismissSchema.safeParse({ ids: Array.from({ length: 1001 }, (_, i) => `a${i}`) }).success,
  );
  assert.ok(!dismissSchema.safeParse({ ids: [] }).success);
  assert.ok(!dismissSchema.safeParse({ ids: ['x'.repeat(129)] }).success);
  assert.ok(!dismissSchema.safeParse({ all: true }).success);
  assert.ok(!dismissSchema.safeParse({ all: false }).success);
  assert.ok(!dismissSchema.safeParse({ id: 'abc', all: true }).success);
  assert.ok(!dismissSchema.safeParse({ id: 'abc', ids: ['abc'] }).success);
  assert.ok(!dismissSchema.safeParse({}).success);
  assert.ok(!dismissSchema.safeParse({ id: 'x'.repeat(1000) }).success);
});

test('worker messages follow the spec table, strictly', () => {
  const bar = { symbol: 'BTC-USD', time: '2026-11-06T14:30:00.000Z', closeMinor: 100, volume: 1 };
  const price = { symbol: 'BTC-USD', priceMinor: 100, paused: false };
  for (const message of [
    { type: 'ready' },
    { type: 'refused' },
    { type: 'result', id: 1, ok: true, bars: [bar] },
    { type: 'result', id: 2, ok: true, prices: [price] },
    { type: 'result', id: 3, ok: false, error: 'rate-limited', retryAfterSeconds: 30 },
    { type: 'result', id: 4, ok: false, error: 'too-large' },
  ])
    assert.ok(workerMessageSchema.safeParse(message).success, JSON.stringify(message));
  for (const message of [
    { type: 'ready', extra: 1 },
    { type: 'result', id: 1, ok: true, bars: [{ ...bar, closeMinor: 0 }] },
    { type: 'result', id: 1, ok: true, bars: [bar], prices: [price] },
    { type: 'result', id: 1, ok: true },
    { type: 'result', id: 1, ok: false, error: 'worker-crashed' },
    { type: 'result', id: 1, ok: false, error: 'network', detail: 'quoted body' },
    { type: 'result', id: -1, ok: true, bars: [] },
    { type: 'result', id: 1, ok: true, bars: Array.from({ length: 10001 }, () => bar) },
    { type: 'credentials', keyId: 'PKABCDEF12', secret: 'abcdefgh12' },
    { type: 'nope' },
  ])
    assert.ok(!workerMessageSchema.safeParse(message).success, JSON.stringify(message));

  for (const message of [
    { type: 'credentials', keyId: 'PKABCDEF12', secret: 'abcdefgh12' },
    { type: 'fetch', id: 1, feed: 'coinbase', kind: 'prices', symbols: ['BTC-USD'] },
    {
      type: 'fetch',
      id: 2,
      feed: 'alpaca',
      kind: 'bars',
      symbols: ['AAPL'],
      limit: 10,
      start: '2026-11-06T00:00:00.000Z',
    },
  ])
    assert.ok(serverMessageSchema.safeParse(message).success, JSON.stringify(message));
  for (const message of [
    { type: 'credentials', keyId: 'short', secret: 'abcdefgh12' },
    { type: 'fetch', id: 1, feed: 'kraken', kind: 'prices', symbols: ['BTC-USD'] },
    { type: 'fetch', id: 1, feed: 'coinbase', kind: 'prices', symbols: ['BTC-USD'], limit: 5 },
    { type: 'fetch', id: 1, feed: 'coinbase', kind: 'bars', symbols: ['BTC-USD'], limit: 0 },
    { type: 'fetch', id: 1, feed: 'coinbase', kind: 'bars', symbols: ['BTC-USD/../x'] },
    { type: 'fetch', id: 1, feed: 'coinbase', kind: 'bars', symbols: [] },
    { type: 'fetch', id: 1, feed: 'coinbase', kind: 'bars', symbols: ['BTC-USD'], extra: 1 },
    { type: 'ready' },
  ])
    assert.ok(!serverMessageSchema.safeParse(message).success, JSON.stringify(message));
});

test('FEEDS holds the verified provider facts', () => {
  assert.deepEqual(FEEDS.coinbase, {
    host: 'api.coinbase.com',
    provider: 'Coinbase',
    venue: 'Coinbase',
    calendar: 'continuous',
    symbols: ['BTC-USD', 'ETH-USD'],
    assetClass: 'crypto',
    coverage: 'Coinbase trades only',
    terms: 'https://www.coinbase.com/legal/developer-platform/terms-of-service',
  });
  assert.deepEqual(FEEDS.alpaca, {
    host: 'data.alpaca.markets',
    provider: 'Alpaca',
    venue: 'IEX',
    calendar: 'us-equity-regular',
    symbols: ['AAPL', 'NVDA', 'MSFT'],
    assetClass: 'equity',
    coverage: 'IEX only, about 2.5% of US stock volume',
    terms: 'https://alpaca.markets/disclosures',
  });
});

const alpacaRows = (rows: unknown[]) => ({ bars: { AAPL: rows }, next_page_token: null });
const row = (t: string, c: number) => ({ t, c, v: 1 });

test('Alpaca bars are sorted oldest first within a symbol', () => {
  const { bars } = parseAlpacaBars(
    ['AAPL'],
    alpacaRows([row('2026-11-06T14:45:00Z', 2), row('2026-11-06T14:30:00Z', 1)]),
  );
  assert.deepEqual(
    bars.map((bar) => bar.closeMinor),
    [100, 200],
  );
});

for (const [name, rows] of [
  ['conflicting duplicates', [row('2026-11-06T14:30:00Z', 1), row('2026-11-06T14:30:00Z', 2)]],
  ['identical duplicates', [row('2026-11-06T14:30:00Z', 1), row('2026-11-06T14:30:00Z', 1)]],
  [
    'duplicates written differently',
    [row('2026-11-06T14:30:00Z', 1), row('2026-11-06T14:30:00.000Z', 1)],
  ],
] as const)
  test(`an Alpaca bars response with ${name} is rejected whole`, () =>
    assert.throws(() => parseAlpacaBars(['AAPL'], alpacaRows([...rows])), FeedFormatError));

test('the same time under two Alpaca symbols is fine', () => {
  const body = alpacaBars();
  assert.equal(parseAlpacaBars(['AAPL', 'NVDA'], body).bars.length, 3);
});

test('an Alpaca page token that is empty text is rejected', () =>
  assert.throws(
    () => parseAlpacaBars(['AAPL'], { bars: {}, next_page_token: '' }),
    FeedFormatError,
  ));

test('the parsers refuse what the shared schema would refuse', () => {
  // Year 33658: valid for Date, but not for z.string().datetime().
  assert.throws(
    () =>
      parseCoinbaseBars('BTC-USD', {
        candles: [{ start: '1000000000000', close: '1', volume: '1' }],
      }),
    FeedFormatError,
  );
  assert.throws(
    () => parseAlpacaBars(['AAPL'], alpacaRows([row('+033658-01-01T00:00:00Z', 1)])),
    FeedFormatError,
  );
  const big = (v: unknown) => () =>
    parseAlpacaBars(['AAPL'], alpacaRows([{ t: '2026-11-06T14:30:00Z', c: 1, v }]));
  assert.throws(big(1e15 + 1), FeedFormatError);
  assert.equal(big(1e15)().bars[0].volume, 1e15);
  assert.throws(
    () =>
      parseCoinbaseBars('BTC-USD', {
        candles: [{ start: '1794083400', close: '1', volume: '1' + '0'.repeat(16) }],
      }),
    FeedFormatError,
  );
  // Whatever the parsers return must pass the schema.
  for (const bar of parseAlpacaBars(['AAPL', 'NVDA'], alpacaBars()).bars)
    assert.ok(feedBarSchema.safeParse(bar).success);
});
