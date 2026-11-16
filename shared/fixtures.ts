import type { MarketSource } from './feedSchema.ts';
import type { MarketCalendar } from './marketCalendar.ts';
import type { Task } from './schema.ts';
export const FIXTURE_AT = '2026-10-30T20:00:00.000Z';
export const healthFixture = {
  source: 'Synthetic OpenFit-style example',
  asOf: '2026-11-01T18:00:00.000Z',
  from: '2026-10-26',
  to: '2026-11-01',
  completed: 2,
  goal: 3,
  coverage: '5 of 7 days',
  weightCoverage: '8 measurements over 28 days',
  weights: [76.8, 76.6, 76.7, 76.3, 76.4, 76.1, 76.2, 76.0],
  days: [
    { day: 'M', value: 1 },
    { day: 'T', value: 0 },
    { day: 'W', value: 0 },
    { day: 'T', value: 1 },
    { day: 'F', value: 0 },
    { day: 'S', value: null },
    { day: 'S', value: null },
  ],
  workouts: [
    { title: 'Upper body strength', day: 'Oct 29', duration: 45 },
    { title: 'Morning run', day: 'Oct 26', duration: 32 },
  ],
};
export const demoTasks: Task[] = [
  {
    title: 'Make space for a focused work session',
    project: 'Work',
    priority: 'high',
    estimate: 60,
  },
  {
    title: 'Get outside for a 30-minute walk',
    project: 'Wellbeing',
    priority: 'medium',
    estimate: 30,
  },
  { title: 'Review the week’s spending', project: 'Personal', priority: 'medium', estimate: 20 },
  { title: 'Read a chapter of my book', project: 'Learning', priority: 'low', estimate: 25 },
  {
    title: 'Write down three things that went well',
    project: 'Personal',
    priority: 'low',
    estimate: 10,
  },
].map(
  (t, i) =>
    ({
      ...t,
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      version: 1,
      status: i === 4 ? 'done' : 'open',
      dueDay: null,
      scheduledAt: null,
      recurring: 'none',
      actual: i === 4 ? 10 : null,
      createdAt: '2026-10-30T07:00:00.000Z',
      completedAt: i === 4 ? '2026-10-30T09:00:00.000Z' : null,
    }) as Task,
);
export const instruments = [
  { symbol: 'AAPL', name: 'Apple Inc.', assetClass: 'equity', base: 22650, color: '#6c7382' },
  { symbol: 'NVDA', name: 'NVIDIA', assetClass: 'equity', base: 13840, color: '#77a445' },
  { symbol: 'MSFT', name: 'Microsoft', assetClass: 'equity', base: 42560, color: '#5679b9' },
  { symbol: 'BTC-USD', name: 'Bitcoin', assetClass: 'crypto', base: 6842000, color: '#dd963b' },
  { symbol: 'ETH-USD', name: 'Ethereum', assetClass: 'crypto', base: 251800, color: '#8990bb' },
] as const;
export type Bar = {
  symbol: string;
  assetClass: string;
  provider: string;
  venue: string;
  currency: string;
  calendar: MarketCalendar;
  time: string;
  receivedAt: string;
  interval: '15m';
  revision: number;
  closeMinor: number;
  volume: number;
};
export type Decision = {
  id: string;
  symbol: string;
  time: string;
  state: 'Buy setup' | 'Sell setup' | 'No trigger' | 'Signal unavailable';
  provider: string;
  venue: string;
  currency: string;
  interval: string;
  revision: number;
  receivedAt: string;
  closeMinor: number;
  fast: number | null;
  slow: number | null;
  previousFast: number | null;
  previousSlow: number | null;
  reason: string;
  version: string;
  inputCount: number;
  inputDigest: string;
  corrected: boolean;
};
export type RuleOverview = {
  position: 'above' | 'below' | 'level' | 'unavailable';
  setups: number;
  lastSetup: { state: 'Buy setup' | 'Sell setup'; time: string; barsAgo: number } | null;
};
export type SetupOutcome = { bars: number; changePercent: number | null };
export type MarketInstrument = {
  symbol: string;
  name: string;
  assetClass: string;
  color: string;
  bars: Bar[];
  decisions: Decision[];
  overview: RuleOverview;
  outcomes: Record<string, SetupOutcome[]>;
  change: number | null;
  price: number | null;
  source: MarketSource;
};
export const RULE = {
  version: 'ema-20-50/v3',
  interval: '15 minutes',
  warmup: 50,
  initialization:
    'First close seeds both EMAs. Publish after 50 contiguous closed bars; the first possible crossover is bar 51.',
  gapPolicy:
    "A normal market close is not a gap: on the US equity calendar, the EMAs and warm-up carry from one session's last bar to the next session's first. A missing, conflicting, out-of-order, or out-of-session bar, a date outside calendar coverage, or a revised value resets warm-up, with no signal until 50 contiguous closed bars are available again. A bar redelivered with the same values is ignored, and a bar that has not closed yet is not evaluated.",
  noise:
    'A setup is not evidence of an edge. On random prices with no pattern, this rule still fires about 56 setups every 30 days, and later moves are a coin flip.',
  threshold: 'Buy: previous EMA20 ≤ EMA50 and current EMA20 > EMA50. Sell: the inverse.',
  provenance: 'Synthetic continuous-session fixture. Not exchange data or an exchange calendar.',
};

export const MARKET_DISCLAIMER =
  'Rule output for information only, not financial advice or a recommendation to buy or sell. Prices here are synthetic. Past results do not predict future ones, and any decision is yours.';

export const LIVE_DISCLAIMER = MARKET_DISCLAIMER.replace('Prices here are synthetic. ', '');

export function fixtureBars(index: number): Bar[] {
  const instrument = instruments[index];
  const start = Date.parse('2026-10-30T00:00:00Z');
  return Array.from({ length: 80 }, (_, i) => {
    const trend = i < 42 ? -i * 0.00038 : -42 * 0.00038 + (i - 42) * 0.0011;
    const wave = Math.sin(i * 0.73 + index * 1.6) * 0.0015 + Math.cos(i * 0.29 + index) * 0.002;
    const direction = index === 2 || index === 4 ? -1 : 1;
    return {
      symbol: instrument.symbol,
      assetClass: instrument.assetClass,
      provider: 'AllIn fixture v1',
      venue: 'SIMULATED',
      currency: 'USD',
      calendar: 'continuous',
      time: new Date(start + i * 900000).toISOString(),
      receivedAt: new Date(start + (i + 1) * 900000).toISOString(),
      interval: '15m',
      revision: 1,
      closeMinor: Math.round(instrument.base * (1 + (trend + wave) * direction)),
      volume: Math.round(18000 + Math.abs(Math.sin(i * 1.37 + index)) * 75000),
    };
  });
}
