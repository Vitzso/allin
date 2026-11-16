import { X } from 'lucide-react';
import type { MarketAlert } from '../shared/feedSchema';
import { alertLine } from '../shared/feedViews';
import { LIVE_DISCLAIMER, RULE } from '../shared/fixtures';
import { Badge, SectionHeader } from './components';

/** Setups the rule found on live bars, newest first, until dismissed. */
export function MarketAlerts({
  alerts,
  limit,
  timezone,
  onDismiss,
  onDismissAll,
}: {
  alerts: MarketAlert[];
  limit?: number;
  timezone: string;
  onDismiss: (id: string) => void;
  /** Gets the alerts this card counts, so one that arrived since the last read stays. */
  onDismissAll: (ids: string[]) => void;
}) {
  const open = alerts
    .filter((a) => a.dismissedAt === null)
    .sort((a, b) => b.alertedAt.localeCompare(a.alertedAt));
  if (!open.length) return null;
  const shown = limit === undefined ? open : open.slice(0, limit);
  return (
    <section className="card market-alerts" aria-label="Setup alerts">
      <SectionHeader
        title="Setups on live bars"
        eyebrow="ALERTS"
        action={
          <button className="button secondary" onClick={() => onDismissAll(open.map((a) => a.id))}>
            Dismiss all
          </button>
        }
      />
      {shown.length < open.length && (
        <p className="muted small">
          {shown.length} of {open.length} shown, newest first. Markets lists them all.
        </p>
      )}
      <ul>
        {shown.map((alert) => (
          <li key={alert.id}>
            <div>
              <strong>{alertLine(alert, timezone)}</strong>
              <small>
                Found{' '}
                {new Date(alert.alertedAt).toLocaleString('en-US', {
                  timeZone: timezone,
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                {alert.correctedAt && <Badge tone="amber">Corrected</Badge>}
              </small>
            </div>
            <button
              className="icon-button"
              aria-label={`Dismiss ${alert.symbol} ${alert.state} alert`}
              onClick={() => onDismiss(alert.id)}
            >
              <X size={16} />
            </button>
          </li>
        ))}
      </ul>
      <p className="market-disclaimer">
        {LIVE_DISCLAIMER} {RULE.noise}
      </p>
    </section>
  );
}
