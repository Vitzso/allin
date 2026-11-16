import { useState } from 'react';
import { Activity, Dumbbell, Scale, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { calendarDay } from '../shared/schema';
import { addDays } from '../shared/time';
import type { HealthSummary } from '../shared/healthSchema';
import {
  NO_WORKOUT_DATA,
  WEIGHT_RANGES,
  coveredDays,
  exportAgeLabel,
  formatDay,
  formatInstant,
  mergedCoverage,
  weekDayCells,
  weightRange,
  workoutCountSuffix,
} from '../shared/healthViews';
import { api } from './api';
import { Badge, Empty, Modal, Provenance, SectionHeader, Sparkline } from './components';
import { HealthPreview, WorkoutDays, WorkoutLegend, type HealthData } from './HealthPreview';

const GOALS = Array.from({ length: 14 }, (_, i) => i + 1);

export function Health({
  demo,
  preview,
  previewError,
  summary,
  summaryError,
  timezone,
  onImport,
  onChanged,
  notify,
}: {
  demo: boolean;
  preview: HealthData | null;
  previewError: string;
  summary: HealthSummary | null;
  summaryError: string;
  timezone: string;
  /** In preview this opens vault creation. */
  onImport: () => void;
  /** Re-reads the summary. */
  onChanged: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [rangeDays, setRangeDays] = useState(WEIGHT_RANGES[0].days),
    [purging, setPurging] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function saveGoal(value: string) {
    setBusy(true);
    try {
      await api('/health/goal', 'POST', { workoutGoal: value === '' ? null : Number(value) });
      await onChanged();
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function closePurge() {
    setPurging(false);
    setError('');
  }
  async function purge() {
    setBusy(true);
    try {
      await api('/health/purge', 'POST', {});
      await onChanged();
      setPurging(false);
      notify('Health data purged');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const purgeDialog = purging && (
    <Modal title="Purge imported Health data?" onClose={closePurge}>
      <p className="muted">
        This removes every imported workout day, weight, coverage range, and the weekly goal from
        AllIn. Older backups of your vault and OpenFit keep their own copies, and AllIn does not
        change them.
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="button secondary" onClick={closePurge}>
          Cancel
        </button>
        <button className="button danger" disabled={busy} onClick={() => void purge()}>
          Purge from AllIn
        </button>
      </div>
    </Modal>
  );
  const purgeButton = (
    <button
      className="button secondary"
      onClick={() => {
        setError('');
        setPurging(true);
      }}
    >
      <Trash2 size={16} />
      Purge Health data
    </button>
  );
  const importButton = (
    <button className="button primary" onClick={onImport}>
      <Upload size={16} />
      Import OpenFit export
    </button>
  );
  if (demo)
    return preview ? (
      <HealthPreview health={preview} onImport={onImport} />
    ) : (
      <Empty title="Health summary unavailable">{previewError || 'Loading…'}</Empty>
    );
  if (summaryError) return <Empty title="Health summary unavailable">{summaryError}</Empty>;
  if (!summary) return <Empty title="Loading your Health summary">Loading…</Empty>;
  if (summary.state === 'empty')
    // An empty import keeps the weekly goal, which only Purge removes.
    return (
      <>
        {error && !purging && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <Empty
          title="Import your OpenFit export"
          action={
            <div className="heading-actions">
              {summary.workoutGoal !== null && purgeButton}
              {importButton}
            </div>
          }
        >
          Choose an export file from OpenFit. You will see exactly what AllIn keeps before anything
          is saved.
        </Empty>
        {purgeDialog}
      </>
    );

  const { week } = summary;
  const goal = summary.workoutGoal;
  const today = calendarDay(new Date().toISOString(), timezone);
  const range = WEIGHT_RANGES.find((r) => r.days === rangeDays) ?? WEIGHT_RANGES[0];
  const view = weightRange(summary.weights, today, range.days);
  const kg = view.rows.map((row) => row.weightKg);
  const age = exportAgeLabel(summary.exportAgeDays);
  const ranges = mergedCoverage(summary.coverage);
  const coverage = (category: 'workouts' | 'weight') =>
    ranges
      .filter((c) => c.category === category)
      .map((c) => `${formatDay(c.from)} – ${formatDay(c.to)}`)
      .join(', ') || 'None';

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">HEALTH</div>
          <h1>Health</h1>
          <p className="health-source">
            OpenFit export · exported{' '}
            {summary.exportedAt ? formatInstant(summary.exportedAt, timezone) : 'unknown'} ·
            imported {summary.importedAt ? formatInstant(summary.importedAt, timezone) : 'unknown'}
          </p>
          {age && <Badge tone="amber">{age}</Badge>}
        </div>
        <div className="heading-actions">
          {purgeButton}
          {importButton}
        </div>
      </div>
      {error && !purging && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="health-overview">
        <div className="card padded">
          <div className="card-kicker">
            <span className="icon-tile mint">
              <Dumbbell size={20} />
            </span>
            <Badge tone="green">This week</Badge>
          </div>
          <div className="health-value">
            {coveredDays(week.days) === 0 ? (
              <span>{NO_WORKOUT_DATA}</span>
            ) : (
              <>
                {week.completed} <span>{workoutCountSuffix(week.completed, goal)}</span>
              </>
            )}
          </div>
          <label className="form-stack goal-field">
            <span>Weekly workout goal</span>
            <select
              value={goal ?? ''}
              disabled={busy}
              onChange={(e) => void saveGoal(e.target.value)}
            >
              <option value="">No goal</option>
              {GOALS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <WorkoutDays days={weekDayCells(week.days)} />
          <WorkoutLegend />
          <Provenance>
            {formatDay(week.from, false)} – {formatDay(week.to, false)} · {coveredDays(week.days)}{' '}
            of 7 days covered
          </Provenance>
        </div>
        <div className="card padded">
          <div className="card-kicker">
            <span className="icon-tile lavender">
              <Scale size={20} />
            </span>
            <div className="segmented" role="group" aria-label="Weight range">
              {WEIGHT_RANGES.map((r) => (
                <button
                  key={r.label}
                  className={r.days === range.days ? 'active' : ''}
                  aria-pressed={r.days === range.days}
                  onClick={() => setRangeDays(r.days)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          {view.latest ? (
            <>
              <div className="health-value weight-latest">
                {view.latest.weightKg.toFixed(1)} <span>kg</span>
              </div>
              <p className="muted">
                {view.change === null
                  ? `Recorded ${formatDay(view.latest.day)}.`
                  : `${view.change < 0 ? '−' : '+'}${Math.abs(view.change).toFixed(1)} kg between the first and latest entry.`}
              </p>
            </>
          ) : (
            <p className="muted weight-empty">No measurements in this range</p>
          )}
          {view.rows.length === 1 && (
            <p className="muted weight-empty">One measurement in this range</p>
          )}
          {view.rows.length > 1 && (
            <>
              <div className="weight-chart weight-chart-small">
                <div className="weight-grid">
                  <span>{Math.max(...kg).toFixed(1)} kg</span>
                  <span>{Math.min(...kg).toFixed(1)} kg</span>
                </div>
                <Sparkline
                  values={kg}
                  positions={view.positions}
                  markers
                  color="#7d77a8"
                  area
                  height={150}
                  label={`Weight measurements, ${view.rows.length} in the last ${range.label}, from ${Math.min(...kg).toFixed(1)} to ${Math.max(...kg).toFixed(1)} kilograms`}
                />
              </div>
              <div className="chart-axis">
                <span>{formatDay(addDays(today, -(range.days - 1)), false)}</span>
                <span>{formatDay(today, false)}</span>
              </div>
            </>
          )}
          <Provenance>
            {view.rows.length} recorded {view.rows.length === 1 ? 'measurement' : 'measurements'} ·
            Missing days excluded · Coverage {coverage('weight')}
          </Provenance>
        </div>
        <div className="card health-boundary">
          <ShieldCheck size={25} />
          <h3>Your health has its own space.</h3>
          <p>
            Only the summaries you choose will be retained. Your task planner has no health access.
          </p>
          <div>
            <Badge tone="green">Health sharing off</Badge>
          </div>
        </div>
      </div>
      <div className="health-detail-grid">
        <div className="card padded">
          <SectionHeader title="Recent workout days" />
          {summary.recentWorkoutDays.length ? (
            summary.recentWorkoutDays.map((entry) => (
              <div className="workout-entry" key={entry.day}>
                <span className="icon-tile mint">
                  <Dumbbell size={20} />
                </span>
                <div>
                  <strong>{formatDay(entry.day)}</strong>
                  <span>
                    {entry.count} {entry.count === 1 ? 'workout' : 'workouts'}
                  </span>
                </div>
              </div>
            ))
          ) : (
            <p className="muted">No workout days in the imported data.</p>
          )}
        </div>
        <div className="card padded">
          <SectionHeader title="Coverage" />
          <div className="coverage-note">
            <Activity size={17} />
            <div>
              <strong>Workouts</strong>
              <p>{coverage('workouts')}</p>
              <strong>Weight</strong>
              <p>{coverage('weight')}</p>
              <p>Missing data is not the same as no activity.</p>
            </div>
          </div>
        </div>
      </div>
      {purgeDialog}
    </>
  );
}
