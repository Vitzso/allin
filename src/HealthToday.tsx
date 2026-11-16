import type { ReactNode } from 'react';
import { ArrowUpRight, HeartPulse } from 'lucide-react';
import type { HealthSummary } from '../shared/healthSchema';
import {
  NO_WORKOUT_DATA,
  coveredDays,
  exportAgeLabel,
  formatDay,
  formatInstant,
  weekDayCells,
  workoutCountSuffix,
} from '../shared/healthViews';
import { Badge, Empty, Provenance, SectionHeader, TextLink } from './components';
import { WorkoutDays, WorkoutLegend, previewDays, type HealthData } from './HealthPreview';

type TodayProps = {
  demo: boolean;
  preview: HealthData | null;
  previewError: string;
  summary: HealthSummary | null;
  summaryError: string;
  timezone: string;
  /** Opens the Health page. */
  onOpen: () => void;
};

const weekRange = (week: HealthSummary['week']) =>
  `${formatDay(week.from, false)} – ${formatDay(week.to, false)}`;

const exportedOn = (summary: HealthSummary, timezone: string) =>
  summary.exportedAt ? formatInstant(summary.exportedAt, timezone) : 'unknown';

/** The top summary card on Today. */
export function HealthGlanceCard({
  demo,
  preview,
  summary,
  summaryError,
  timezone,
  onOpen,
}: TodayProps) {
  const body = (main: ReactNode, bottom: ReactNode) => (
    <>
      <div className="summary-top">
        <span className="icon-tile peach">
          <HeartPulse size={20} />
        </span>
        <span className="summary-label">Health at a glance</span>
        <ArrowUpRight className="summary-arrow" size={17} />
      </div>
      <div className="summary-main">{main}</div>
      <div className="summary-bottom">{bottom}</div>
    </>
  );
  let content;
  if (demo) {
    content = body(
      <>
        <strong>
          {preview ? '2' : '—'}
          <small> / 3</small>
        </strong>
        <span>weekly workouts</span>
        <div className="mini-progress" aria-hidden="true">
          <i />
          <i />
          <i className="empty-progress" />
        </div>
      </>,
      <>
        <Badge tone="peach">Example week</Badge>
        <span>Nov 1 · 5/7 days covered</span>
      </>,
    );
  } else if (summaryError) {
    content = body(
      <span>Health summary unavailable. {summaryError}</span>,
      <Badge tone="amber">Not loaded</Badge>,
    );
  } else if (!summary) {
    content = body(<span>Loading…</span>, <Badge tone="peach">OpenFit export</Badge>);
  } else if (summary.state === 'empty') {
    content = body(
      <span>Import your OpenFit export</span>,
      <Badge tone="peach">Nothing imported</Badge>,
    );
  } else {
    const { completed } = summary.week;
    const goal = summary.workoutGoal;
    const age = exportAgeLabel(summary.exportAgeDays);
    const covered = coveredDays(summary.week.days);
    content = body(
      covered === 0 ? (
        <span>{NO_WORKOUT_DATA}</span>
      ) : (
        <>
          <strong>{completed}</strong> <span>{workoutCountSuffix(completed, goal)} this week</span>
          {goal !== null && (
            <div className="mini-progress" aria-hidden="true">
              {Array.from({ length: goal }, (_, i) => (
                <i key={i} className={i < completed ? '' : 'empty-progress'} />
              ))}
            </div>
          )}
        </>
      ),
      <>
        <Badge tone="peach">OpenFit export</Badge>
        <span>
          {[
            weekRange(summary.week),
            `exported ${exportedOn(summary, timezone)}`,
            `${covered} of 7 days covered`,
            age,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </>,
    );
  }
  return (
    <button className="card summary-card" onClick={onOpen}>
      {content}
    </button>
  );
}

/** The lower Health card on Today. */
export function HealthMovementCard({
  demo,
  preview,
  previewError,
  summary,
  summaryError,
  timezone,
  onOpen,
}: TodayProps) {
  const header = (
    <SectionHeader
      title="Workouts this week"
      eyebrow="YOUR HEALTH, AT A GLANCE"
      action={<TextLink onClick={onOpen}>View health</TextLink>}
    />
  );
  let body;
  if (demo) {
    body = preview ? (
      <>
        <div className="movement-body">
          <div>
            <div className="movement-number">
              2<span>of 3 workouts</span>
            </div>
            <p>A little progress, one session at a time.</p>
            <Badge tone="peach">Example · Oct 26 – Nov 1</Badge>
          </div>
          <div className="movement-calendar">
            <WorkoutDays days={previewDays(preview)} />
            <WorkoutLegend />
          </div>
        </div>
        <Provenance>Synthetic example · 5 of 7 days covered · No health data shared</Provenance>
      </>
    ) : (
      <Empty title="Health summary unavailable">
        {previewError || 'Loading the synthetic example…'}
      </Empty>
    );
  } else if (summaryError) {
    body = <Empty title="Health summary unavailable">{summaryError}</Empty>;
  } else if (!summary) {
    body = <Empty title="Loading your Health summary">Loading…</Empty>;
  } else if (summary.state === 'empty') {
    body = (
      <Empty title="Import your OpenFit export">
        Choose an export file from OpenFit on the Health page.
      </Empty>
    );
  } else {
    const { week } = summary;
    const goal = summary.workoutGoal;
    const age = exportAgeLabel(summary.exportAgeDays);
    body = (
      <>
        <div className="movement-body">
          <div>
            <div className="movement-number">
              {coveredDays(week.days) === 0 ? (
                <span>{NO_WORKOUT_DATA}</span>
              ) : (
                <>
                  {week.completed} <span>{workoutCountSuffix(week.completed, goal)}</span>
                </>
              )}
            </div>
            <p>{weekRange(week)}</p>
            <Badge tone={age ? 'amber' : 'peach'}>{age ?? 'OpenFit export'}</Badge>
          </div>
          <div className="movement-calendar">
            <WorkoutDays days={weekDayCells(week.days)} />
            <WorkoutLegend />
          </div>
        </div>
        <Provenance>
          OpenFit export · exported {exportedOn(summary, timezone)} · {coveredDays(week.days)} of 7
          days covered · No health data shared
        </Provenance>
      </>
    );
  }
  return (
    <section className="card movement-card">
      {header}
      {body}
    </section>
  );
}
