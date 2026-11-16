import { z } from 'zod';
import type { MarketCalendar } from './marketCalendar.ts';

// Browser-safe, and imported by the sandboxed worker on Node's built-in TypeScript support:
// erasable syntax only (no enums, parameter properties, or namespaces).

export type FeedName = 'coinbase' | 'alpaca';
export const FEEDS: Record<
  FeedName,
  {
    host: string;
    provider: string;
    venue: string;
    calendar: MarketCalendar;
    symbols: readonly string[];
    assetClass: string;
    coverage: string;
    terms: string;
  }
> = {
  coinbase: {
    host: 'api.coinbase.com',
    provider: 'Coinbase',
    venue: 'Coinbase',
    calendar: 'continuous',
    symbols: ['BTC-USD', 'ETH-USD'],
    assetClass: 'crypto',
    coverage: 'Coinbase trades only',
    terms: 'https://www.coinbase.com/legal/developer-platform/terms-of-service',
  },
  alpaca: {
    host: 'data.alpaca.markets',
    provider: 'Alpaca',
    venue: 'IEX',
    calendar: 'us-equity-regular',
    symbols: ['AAPL', 'NVDA', 'MSFT'],
    assetClass: 'equity',
    coverage: 'IEX only, about 2.5% of US stock volume',
    terms: 'https://alpaca.markets/disclosures',
  },
};

export type FeedBar = { symbol: string; time: string; closeMinor: number; volume: number };
export type FeedPrice = { symbol: string; priceMinor: number; paused: boolean };
export type FetchRequest =
  | { feed: FeedName; kind: 'bars'; symbols: string[]; limit?: number; start?: string }
  | { feed: FeedName; kind: 'prices'; symbols: string[] };
export type FetchError =
  | 'network'
  | 'timeout'
  | 'rate-limited'
  | 'unauthorized'
  | 'malformed'
  | 'too-large'
  | 'worker-crashed'
  | 'isolation';
export type FetchResult =
  | { ok: true; bars: FeedBar[] }
  | { ok: true; prices: FeedPrice[] }
  | { ok: false; error: FetchError; retryAfterSeconds?: number };
export type FeedFailure =
  | 'key-rejected'
  | 'key-missing'
  | 'unexpected-response'
  | 'isolation'
  | 'worker-crashes'
  | 'calendar';
export type FeedState = 'off' | 'catching-up' | 'live' | 'stale' | 'closed' | 'paused' | 'failing';
export type MarketSource =
  | { kind: 'replay' }
  | {
      kind: 'live';
      feed: FeedName;
      provider: string;
      venue: string;
      state: FeedState;
      reason: FeedFailure | null;
      lastUpdate: string | null;
      lastBarAt: string | null;
    };
export type FeedStatus = {
  feed: FeedName;
  enabled: boolean;
  state: FeedState;
  failure: FeedFailure | null;
  hasKey: boolean;
  lastUpdate: string | null;
  lastBarAt: string | null;
};
export type MarketAlert = {
  id: string;
  symbol: string;
  time: string;
  state: 'Buy setup' | 'Sell setup';
  provider: string;
  venue: string;
  closeMinor: number;
  fast: number;
  slow: number;
  reason: string;
  ruleVersion: string;
  alertedAt: string;
  dismissedAt: string | null;
  correctedAt: string | null;
};
export type AlpacaKey = { keyId: string; secret: string };

export const MAX_BARS_PER_MESSAGE = 10000;
const MAX_VOLUME = 1e15;
const symbolSchema = z.string().regex(/^[A-Z0-9]{1,12}(-[A-Z0-9]{1,12})?$/);
const timeSchema = z.string().max(40).datetime();
const minorSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const feedSchema = z.enum(['coinbase', 'alpaca']);

export const feedBarSchema = z
  .object({
    symbol: symbolSchema,
    time: timeSchema,
    closeMinor: minorSchema,
    volume: z.number().min(0).max(MAX_VOLUME),
  })
  .strict();
export const feedPriceSchema = z
  .object({ symbol: symbolSchema, priceMinor: minorSchema, paused: z.boolean() })
  .strict();

const credentialText = z
  .string()
  .max(512)
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/);
export const alpacaKeySchema = z.object({ keyId: credentialText, secret: credentialText }).strict();

const symbolsSchema = z.array(symbolSchema).min(1).max(20);
const requestId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const workerError = z.enum([
  'network',
  'timeout',
  'rate-limited',
  'unauthorized',
  'malformed',
  'too-large',
]);

// Worker to server. The server treats every line as hostile.
export const workerMessageSchema = z.union([
  z.object({ type: z.literal('ready') }).strict(),
  z.object({ type: z.literal('refused') }).strict(),
  z
    .object({
      type: z.literal('result'),
      id: requestId,
      ok: z.literal(true),
      bars: z.array(feedBarSchema).max(MAX_BARS_PER_MESSAGE),
    })
    .strict(),
  z
    .object({
      type: z.literal('result'),
      id: requestId,
      ok: z.literal(true),
      prices: z.array(feedPriceSchema).max(20),
    })
    .strict(),
  z
    .object({
      type: z.literal('result'),
      id: requestId,
      ok: z.literal(false),
      error: workerError,
      retryAfterSeconds: z.number().int().min(0).max(86400).optional(),
    })
    .strict(),
]);

// Server to worker.
export const serverMessageSchema = z.union([
  z
    .object({ type: z.literal('credentials'), keyId: credentialText, secret: credentialText })
    .strict(),
  z
    .object({
      type: z.literal('fetch'),
      id: requestId,
      feed: feedSchema,
      kind: z.literal('bars'),
      symbols: symbolsSchema,
      limit: z.number().int().min(1).max(MAX_BARS_PER_MESSAGE).optional(),
      start: timeSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('fetch'),
      id: requestId,
      feed: feedSchema,
      kind: z.literal('prices'),
      symbols: symbolsSchema,
    })
    .strict(),
]);

export const feedToggleSchema = z.object({ enabled: z.boolean() }).strict();
export const alpacaToggleSchema = z
  .object({
    enabled: z.boolean(),
    keyId: credentialText.optional(),
    secret: credentialText.optional(),
  })
  .strict()
  .refine((body) => (body.keyId === undefined) === (body.secret === undefined), {
    message: 'Send both the key ID and the secret, or neither',
  });
const alertIdSchema = z.string().min(1).max(128);
// One alert, or the ones the page showed. Never "every alert": the page may be 30 seconds old,
// so an alert that arrived since would be dismissed unseen.
export const dismissSchema = z.union([
  z.object({ id: alertIdSchema }).strict(),
  z.object({ ids: z.array(alertIdSchema).min(1).max(1000) }).strict(),
]);
