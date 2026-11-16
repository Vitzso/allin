import { useState } from 'react';
import {
  ArrowUpRight,
  ArrowDownRight,
  ArrowRight,
  Activity,
  SlidersHorizontal,
  Info,
  CirclePause,
  Radio,
  Check,
  ChevronDown,
  TrendingUp,
} from 'lucide-react';
import {
  type MarketInstrument,
  type Decision,
  type SetupOutcome,
  MARKET_DISCLAIMER,
  LIVE_DISCLAIMER,
  RULE,
  FIXTURE_AT,
} from '../shared/fixtures';
import { FEEDS, type MarketAlert, type MarketSource } from '../shared/feedSchema';
import {
  changeLabel,
  decisionLabel,
  rowLabel,
  sourceSummary,
  volumeHeights,
} from '../shared/feedViews';
import { Badge, Change, Sparkline, SectionHeader, Provenance, Modal, Empty } from './components';
import { MarketAlerts } from './MarketAlerts';
const isReplay = (m: MarketInstrument) => m.source.kind === 'replay';
/** Whether no row on the page is a replay row, which is when its synthetic wording must go. */
export const allLive = (markets: MarketInstrument[]) =>
  markets.length > 0 && !markets.some(isReplay);
export function MarketDisclaimer({ live = false }: { live?: boolean }) {
  return <p className="market-disclaimer">{live ? LIVE_DISCLAIMER : MARKET_DISCLAIMER}</p>;
}
const positionText = {
  above: 'EMA20 is above EMA50',
  below: 'EMA20 is below EMA50',
  level: 'EMA20 and EMA50 are level',
  unavailable: 'Unavailable until warm-up completes',
};
function RuleOverviewCard({ market, live }: { market: MarketInstrument; live: boolean }) {
  const { position, lastSetup, setups } = market.overview;
  const scope = isReplay(market) ? 'this replay' : 'the latest 80 bars';
  return (
    <div className="card padded rule-overview">
      <SectionHeader title={`Where the rule stands on ${market.symbol}`} eyebrow="RULE OVERVIEW" />
      <div className="evidence-grid">
        {[
          ['EMA position', positionText[position]],
          [
            'Latest setup',
            lastSetup
              ? `${lastSetup.state}, ${lastSetup.barsAgo} ${lastSetup.barsAgo === 1 ? 'bar' : 'bars'} ago`
              : `None in ${scope}`,
          ],
          [`Setups in ${scope}`, String(setups)],
        ].map(([label, value]) => (
          <div key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <p className="muted">{RULE.noise}</p>
      <MarketDisclaimer live={live} />
    </div>
  );
}
function Afterward({ outcomes, replay }: { outcomes: SetupOutcome[]; replay: boolean }) {
  return (
    <div className="rule-note">
      <strong>What happened afterward</strong>
      <p>
        {replay
          ? 'Later replay result, kept apart from this decision. Simulation only.'
          : 'Later result, kept apart from this decision.'}
      </p>
      {outcomes.map(({ bars, changePercent }) => (
        <p key={bars}>
          {bars} bars later:{' '}
          {changePercent === null
            ? 'Not enough later bars'
            : `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`}
        </p>
      ))}
    </div>
  );
}
export const money = (v: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(v);
/** The price as shown, or a dash while a feed has none to show. */
export const priceText = (m: MarketInstrument) => (m.price === null ? '—' : money(m.price));
export function AssetIcon({ symbol, color }: { symbol: string; color: string }) {
  return (
    <span
      className={`asset-icon ${symbol.includes('USD') ? 'coin' : ''}`}
      style={{ '--asset-color': color } as React.CSSProperties}
    >
      {symbol === 'BTC-USD' ? (
        '₿'
      ) : symbol === 'ETH-USD' ? (
        'Ξ'
      ) : symbol === 'MSFT' ? (
        <span className="microsoft-logo">
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : symbol === 'NVDA' ? (
        'n'
      ) : symbol === 'AAPL' ? (
        <span className="apple-mark">a</span>
      ) : (
        symbol[0]
      )}
    </span>
  );
}
export function Watchlist({
  markets,
  select,
  compact = false,
}: {
  markets: MarketInstrument[];
  select: (symbol: string) => void;
  compact?: boolean;
}) {
  return (
    <div className={`watchlist ${compact ? 'compact' : ''}`}>
      <div className="watchlist-labels">
        <span>ASSET</span>
        <span>PRICE</span>
        {/* Live stock rows' bars cover market hours only, so the headers name the bars instead.
            The trend plots the newest 40 bars, 10 hours of replay. */}
        <span>{markets.every(isReplay) ? 'REPLAY CHANGE' : 'CHANGE (80 BARS)'}</span>
        <span>{markets.every(isReplay) ? '10H TREND' : 'TREND (40 BARS)'}</span>
      </div>
      {markets.map((m) => (
        <button className="watchlist-row" key={m.symbol} onClick={() => select(m.symbol)}>
          <span className="asset-name">
            <AssetIcon symbol={m.symbol} color={m.color} />
            <span>
              <strong>{m.symbol.replace('-USD', '')}</strong>
              <small>{m.name}</small>
              <small className="source-line">{rowLabel(m.source, Date.now())}</small>
            </span>
          </span>
          <span className="asset-price">{priceText(m)}</span>
          <Change value={m.change} />
          <span className="mini-chart">
            {m.bars.length > 0 && (
              <Sparkline
                values={m.bars.slice(-40).map((b) => b.closeMinor)}
                color={(m.change ?? 0) < 0 ? '#bf7371' : '#438b70'}
              />
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
export function DecisionDialog({
  decision,
  outcomes,
  source,
  alerts,
  onClose,
  timezone,
}: {
  decision: Decision;
  outcomes?: SetupOutcome[];
  source: MarketSource;
  alerts: MarketAlert[];
  onClose: () => void;
  timezone: string;
}) {
  const label = decisionLabel(decision, source, alerts);
  const replay = source.kind === 'replay';
  return (
    <Modal title="Behind the decision" onClose={onClose} wide>
      <div className="decision-summary">
        <Badge
          tone={
            decision.state === 'Buy setup'
              ? 'green'
              : decision.state === 'Sell setup'
                ? 'rose'
                : 'neutral'
          }
        >
          {decision.state}
        </Badge>
        <span>{decision.symbol}</span>
        <Badge tone={label === 'Live alert' ? 'green' : replay ? 'amber' : 'neutral'}>
          {label}
        </Badge>
      </div>
      <h3>{decision.reason}</h3>
      <p className="muted">
        This decision comes from a deterministic rule using{' '}
        {replay ? 'synthetic closed bars' : `closed bars from ${source.provider}`}. No order was
        placed.
      </p>
      <div className="evidence-grid">
        {[
          ['Rule version', decision.version],
          ['Candle interval', decision.interval],
          ['Bar time', new Date(decision.time).toLocaleString('en-US', { timeZone: timezone })],
          ['Display timezone', timezone],
          ['Venue / provider', `${decision.venue} · ${decision.provider}`],
          ['Quote currency', `${decision.currency} · stored as integer cents`],
          ['Close price', money(decision.closeMinor / 100)],
          [
            'EMA20 / EMA50',
            `${money((decision.fast ?? 0) / 100)} / ${money((decision.slow ?? 0) / 100)}`,
          ],
          [
            'Previous EMA20 / EMA50',
            decision.previousFast !== null
              ? `${money(decision.previousFast / 100)} / ${money((decision.previousSlow ?? 0) / 100)}`
              : 'Unavailable',
          ],
          [
            'Input coverage',
            `${decision.inputCount} contiguous ${replay ? 'synthetic' : 'closed'} bars`,
          ],
          ...(replay ? [] : [['Coverage', FEEDS[source.feed].coverage]]),
          ['Received at', decision.receivedAt],
          [
            'Revision',
            `${decision.revision} · ${decision.corrected ? 'Corrected decision' : replay ? 'Original replay result' : 'Original result'}`,
          ],
        ].map(([label, value]) => (
          <div key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      {outcomes && <Afterward outcomes={outcomes} replay={replay} />}
      <MarketDisclaimer live={!replay} />
      <div className="rule-note">
        <strong>Thresholds</strong>
        <p>{RULE.threshold}</p>
        <strong>Warm-up and gaps</strong>
        <p>
          {RULE.initialization} {RULE.gapPolicy}
        </p>
        <small className="digest">Evidence SHA-256 · {decision.inputDigest}</small>
      </div>
    </Modal>
  );
}
const dateText = (time: string, timezone: string) =>
  new Date(time).toLocaleDateString('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
export function Markets({
  markets,
  alerts,
  error,
  selected,
  setSelected,
  timezone,
  onDismiss,
  onDismissAll,
}: {
  markets: MarketInstrument[];
  alerts: MarketAlert[];
  error: string;
  selected: string;
  setSelected: (s: string) => void;
  timezone: string;
  onDismiss: (id: string) => void;
  onDismissAll: (ids: string[]) => void;
}) {
  const [range, setRange] = useState(80),
    [filter, setFilter] = useState('Setups'),
    [decision, setDecision] = useState<Decision | null>(null),
    [rules, setRules] = useState(false);
  const market = markets.find((m) => m.symbol === selected) ?? markets[0];
  if (!market)
    return (
      <Empty title="Markets are unavailable">
        {error ||
          'Your tasks and other modules are still available. Reload to retry the market read.'}
      </Empty>
    );
  const { source } = market,
    replay = source.kind === 'replay',
    live = allLive(markets),
    anyLive = markets.some((m) => !isReplay(m));
  const bars = market.bars.slice(-range),
    prices = bars.map((b) => b.closeMinor),
    high = Math.max(...prices),
    low = Math.min(...prices),
    hours = range / 4;
  const decisions = market.decisions
    .filter(
      (d) => filter === 'All decisions' || d.state === 'Buy setup' || d.state === 'Sell setup',
    )
    .slice()
    .reverse();
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">CONTEXT BEFORE CONVICTION</div>
          <h1>A clearer view of the markets.</h1>
          <p>Your watchlist, the rules, and the evidence behind every signal.</p>
        </div>
        <button className="button secondary" onClick={() => setRules(true)}>
          <SlidersHorizontal size={16} />
          Strategy rules
        </button>
      </div>
      <div className="info-banner">
        {anyLive ? <Radio size={17} /> : <CirclePause size={17} />}
        {anyLive ? (
          <div>
            <strong>{sourceSummary(markets.map((m) => m.source))}</strong>
            <span>
              {live
                ? 'Closed 15-minute bars from the feeds you turned on. AllIn places no orders.'
                : 'Rows from a feed you turned on sit beside replay rows. Each row says which it is.'}
            </span>
          </div>
        ) : (
          <div>
            <strong>Replay mode</strong>
            <span>
              Synthetic prices · Oct 30, 2026 · continuous simulated session. Live monitoring is
              off.
            </span>
          </div>
        )}
        {!anyLive && <Badge tone="amber">No live data</Badge>}
      </div>
      <MarketAlerts
        alerts={alerts}
        timezone={timezone}
        onDismiss={onDismiss}
        onDismissAll={onDismissAll}
      />
      <div className="market-layout">
        <div className="card chart-card">
          <div className="chart-title">
            <div className="asset-name">
              <AssetIcon symbol={market.symbol} color={market.color} />
              <div>
                <h2>{market.name}</h2>
                <span className="muted small">
                  {market.symbol} · {source.kind === 'live' ? source.venue : 'Simulated venue'}
                </span>
              </div>
            </div>
            <Badge tone="neutral" dot>
              15m candles
            </Badge>
          </div>
          <div className="chart-stats">
            <strong>{priceText(market)}</strong>
            <Change value={market.change} />
            <span>{changeLabel(source)}</span>
          </div>
          {bars.length ? (
            <>
              <div className="chart-controls">
                <div className="chart-legend">
                  <span />
                  Closing price
                </div>
                <div className="segmented">
                  {[
                    [16, '4H'],
                    [48, '12H'],
                    [80, '20H'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={range === value ? 'active' : ''}
                      onClick={() => setRange(Number(value))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="price-chart">
                <div className="chart-grid">
                  <span>{money(high / 100)}</span>
                  <span>{money((high + low) / 200)}</span>
                  <span>{money(low / 100)}</span>
                </div>
                <Sparkline
                  values={prices}
                  height={230}
                  area
                  label={`${market.symbol} ${replay ? 'synthetic ' : ''}closing prices over ${hours} ${source.kind === 'live' && source.feed === 'alpaca' ? 'market ' : ''}hours`}
                />
              </div>
              <div
                className="volume-chart"
                aria-label={replay ? 'Synthetic volume bars' : 'Volume bars'}
              >
                {volumeHeights(bars.map((b) => b.volume)).map((height, i) => (
                  <span
                    key={bars[i].time}
                    style={{
                      height: `${height}%`,
                      background:
                        bars[i].closeMinor >= (bars[i - 1]?.closeMinor ?? bars[i].closeMinor)
                          ? '#c5ddce'
                          : '#e7d4d1',
                    }}
                    title={`${bars[i].time}: ${bars[i].volume.toLocaleString()} ${replay ? 'simulated volume' : 'volume'}`}
                  />
                ))}
              </div>
              <div className="chart-axis">
                {[bars[0], bars[Math.floor(bars.length / 2)], bars.at(-1)!].map((b) => (
                  <span key={b.time}>
                    {new Date(b.time).toLocaleTimeString('en-US', {
                      timeZone: timezone,
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <Empty title="Waiting for the first data from this feed">
              Prices and the chart appear once the feed has delivered its first closed bars.
            </Empty>
          )}
          <Provenance>
            {source.kind === 'live' ? (
              <>
                {source.provider} · {FEEDS[source.feed].coverage} · {timezone}
              </>
            ) : (
              <>
                AllIn fixture v1 · {timezone} ·{' '}
                {new Date(FIXTURE_AT).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })}
              </>
            )}
          </Provenance>
        </div>
        <div className="card market-watch">
          <SectionHeader title="Your watchlist" action={<Badge>{markets.length} assets</Badge>} />
          {markets.map((m) => (
            <button
              key={m.symbol}
              className={`asset-select ${m.symbol === market.symbol ? 'selected' : ''}`}
              onClick={() => setSelected(m.symbol)}
            >
              <AssetIcon symbol={m.symbol} color={m.color} />
              <span>
                <strong>{m.symbol.replace('-USD', '')}</strong>
                <small>{m.name}</small>
                <small className="source-line">{rowLabel(m.source, Date.now())}</small>
              </span>
              <span>
                <strong>{priceText(m)}</strong>
                <Change value={m.change} />
              </span>
            </button>
          ))}
          <div className="watchlist-note">
            <Info size={14} />
            <span>
              {anyLive
                ? 'This watchlist is fixed for now.'
                : 'Fixture instruments are fixed for this foundation release.'}
            </span>
          </div>
        </div>
      </div>
      <RuleOverviewCard market={market} live={!replay} />
      <div className="card journal">
        <SectionHeader
          title="The signal journal"
          eyebrow="EVERY DECISION HAS A REASON"
          action={
            <div className="segmented">
              {['Setups', 'All decisions'].map((f) => (
                <button
                  key={f}
                  className={filter === f ? 'active' : ''}
                  onClick={() => setFilter(f)}
                >
                  {f}
                </button>
              ))}
            </div>
          }
        />
        <div className="journal-labels">
          <span>DECISION</span>
          <span>RULE</span>
          <span>BAR TIME</span>
          <span>EVIDENCE</span>
        </div>
        {decisions.length ? (
          decisions.map((d) => (
            <button key={d.id} className="journal-row" onClick={() => setDecision(d)}>
              <span>
                <span
                  className={`signal-icon ${d.state === 'Buy setup' ? 'buy' : d.state === 'Sell setup' ? 'sell' : 'none'}`}
                >
                  {d.state === 'Buy setup' ? (
                    <ArrowUpRight size={17} />
                  ) : d.state === 'Sell setup' ? (
                    <ArrowDownRight size={17} />
                  ) : (
                    <Activity size={15} />
                  )}
                </span>
                <span>
                  <strong>{d.state}</strong>
                  <small>
                    {d.symbol} · {decisionLabel(d, source, alerts)}
                  </small>
                </span>
              </span>
              <span>
                EMA 20 / 50<small>{d.version.split('/')[1]} · Closed 15m bar</small>
              </span>
              <span>
                {new Date(d.time).toLocaleTimeString('en-US', {
                  timeZone: timezone,
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                <small>{dateText(d.time, timezone)}</small>
              </span>
              <span className="text-link">
                Inspect
                <ArrowRight size={14} />
              </span>
            </button>
          ))
        ) : (
          <Empty title={replay ? 'No setup in this replay' : 'No setup in the latest 80 bars'}>
            The rule did not cross its thresholds. View all decisions for the complete record.
          </Empty>
        )}
        <Provenance>
          {replay
            ? `Deterministic replay · ${RULE.version} · No live alerts or trading`
            : `${RULE.version} · No trading`}
        </Provenance>
      </div>
      {decision && (
        <DecisionDialog
          decision={decision}
          outcomes={market.outcomes[decision.id]}
          source={source}
          alerts={alerts}
          onClose={() => setDecision(null)}
          timezone={timezone}
        />
      )}
      {rules && (
        <Modal title="Transparent by design" onClose={() => setRules(false)}>
          <div className="icon-tile mint">
            <TrendingUp size={23} />
          </div>
          <h3>20 / 50 EMA crossover</h3>
          <p className="muted">{RULE.threshold}</p>
          <div className="rule-note">
            <strong>Initialization</strong>
            <p>{RULE.initialization}</p>
            <strong>Gap policy</strong>
            <p>{RULE.gapPolicy}</p>
            {!live && (
              <>
                <strong>Provenance</strong>
                <p>{RULE.provenance}</p>
              </>
            )}
            <strong>What a setup means</strong>
            <p>{RULE.noise}</p>
            <Badge>{RULE.version}</Badge>
          </div>
          <MarketDisclaimer live={live} />
        </Modal>
      )}
    </>
  );
}
