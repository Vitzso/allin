import { useState } from 'react';
import {
  Activity,
  Check,
  Dumbbell,
  Footprints,
  HeartPulse,
  ShieldCheck,
  Upload,
  Scale,
} from 'lucide-react';
import { healthFixture } from '../shared/fixtures';
import type { DayStatus } from '../shared/healthSchema';
import { Badge, Sparkline, SectionHeader, Provenance, Modal } from './components';
export type HealthData = typeof healthFixture;
export type DayCell = { label: string; status: DayStatus; title: string };
export function WorkoutDays({ days }: { days: DayCell[] }) {
  return (
    <div className="workout-days">
      {days.map((day, i) => (
        <div key={i}>
          <span>{day.label}</span>
          <div
            className={`day-marker ${day.status === 'workout' ? 'complete' : day.status === 'missing' ? 'missing' : day.status === 'upcoming' ? 'upcoming' : ''}`}
            role="img"
            aria-label={day.title}
            title={day.title}
          >
            {day.status === 'workout' ? (
              <Check size={13} />
            ) : day.status === 'missing' ? (
              <span>·</span>
            ) : (
              <span />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
export function WorkoutLegend() {
  return (
    <p className="workout-legend">
      <span className="legend-dot" /> Workout <span className="legend-dot empty-dot" /> Recorded, no
      workout <span className="legend-dot missing-dot" /> Missing data{' '}
      <span className="legend-dot upcoming-dot" /> Upcoming
    </p>
  );
}
/** The sample week in the shape the day grid draws. */
export function previewDays(health: HealthData): DayCell[] {
  return health.days.map((day) => {
    const status: DayStatus = day.value === 1 ? 'workout' : day.value === null ? 'missing' : 'none';
    return {
      label: day.day,
      status,
      title:
        status === 'missing'
          ? 'No data'
          : status === 'workout'
            ? 'Workout recorded'
            : 'No workout recorded',
    };
  });
}
export function HealthPreview({ health, onImport }: { health: HealthData; onImport: () => void }) {
  const [info, setInfo] = useState(false),
    [trend, setTrend] = useState('Weight');
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PROGRESS, AT YOUR PACE</div>
          <h1>The small things add up.</h1>
          <p>A little perspective on your movement, consistency, and wellbeing.</p>
        </div>
        <div className="heading-actions">
          <button className="button secondary" onClick={() => setInfo(true)}>
            <Upload size={16} />
            About OpenFit import
          </button>
          <button className="button primary" onClick={onImport}>
            <Upload size={16} />
            Import OpenFit export
          </button>
        </div>
      </div>
      <div className="info-banner">
        <ShieldCheck size={17} />
        <div>
          <strong>A look at what’s possible</strong>
          <span>This is a synthetic example. AllIn has not accessed your OpenFit records.</span>
        </div>
        <Badge tone="amber">Sample data</Badge>
      </div>
      <div className="health-overview">
        <div className="card padded">
          <div className="card-kicker">
            <span className="icon-tile mint">
              <Dumbbell size={20} />
            </span>
            <Badge tone="green">Weekly consistency</Badge>
          </div>
          <div className="health-value">
            2 <span>/ 3 workouts</span>
          </div>
          <p className="muted">One more session toward the example goal.</p>
          <WorkoutDays days={previewDays(health)} />
          <Provenance>Oct 26 – Nov 1 · 5 of 7 days covered</Provenance>
        </div>
        <div className="card padded">
          <div className="card-kicker">
            <span className="icon-tile lavender">
              <Scale size={20} />
            </span>
            <Badge>28-day trend</Badge>
          </div>
          <div className="health-value">
            76.0 <span>kg</span>
          </div>
          <p className="muted">−0.8 kg between the first and latest entry.</p>
          <div className="health-mini-chart">
            <Sparkline
              values={health.weights}
              color="#9690bc"
              area
              height={75}
              label="Synthetic weight observations from 76.8 to 76 kilograms"
            />
          </div>
          <Provenance>8 recorded observations · Missing days excluded</Provenance>
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
          <SectionHeader
            title="A longer view"
            action={
              <div className="segmented">
                {['Weight', 'Workouts'].map((t) => (
                  <button
                    key={t}
                    className={trend === t ? 'active' : ''}
                    onClick={() => setTrend(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            }
          />
          <p className="muted">
            {trend === 'Weight'
              ? 'Eight observations. One gentle trend. Gaps are not filled in.'
              : 'Recorded workout days in the selected sample week.'}
          </p>
          {trend === 'Weight' ? (
            <>
              <div className="weight-chart">
                <div className="weight-grid">
                  <span>77.0 kg</span>
                  <span>76.5 kg</span>
                  <span>76.0 kg</span>
                </div>
                <Sparkline
                  values={health.weights}
                  color="#9690bc"
                  height={200}
                  area
                  label="Sample weight observations"
                />
              </div>
              <div className="chart-axis">
                <span>Oct 5</span>
                <span>Oct 19</span>
                <span>Nov 1</span>
              </div>
            </>
          ) : (
            <div className="workout-expanded">
              <WorkoutDays days={previewDays(health)} />
              <WorkoutLegend />
            </div>
          )}
          <Provenance>{health.source} · Updated Nov 1, 2026 · Partial coverage</Provenance>
        </div>
        <div className="card padded">
          <SectionHeader title="Recent movement" action={<Badge>Example</Badge>} />
          {health.workouts.map((workout, i) => (
            <div className="workout-entry" key={workout.title}>
              <span className={`icon-tile ${i ? 'peach' : 'mint'}`}>
                {i ? <Footprints size={20} /> : <Dumbbell size={20} />}
              </span>
              <div>
                <strong>{workout.title}</strong>
                <span>
                  {workout.day} · {workout.duration} min
                </span>
              </div>
              <Check size={16} className="positive" />
            </div>
          ))}
          <div className="coverage-note">
            <Activity size={17} />
            <div>
              <strong>A partial picture is still a picture.</strong>
              <p>
                Saturday and Sunday have no imported coverage in this example. Missing data is not
                the same as no activity.
              </p>
            </div>
          </div>
        </div>
      </div>
      {info && (
        <Modal title="OpenFit stays the source of truth" onClose={() => setInfo(false)}>
          <div className="icon-tile mint">
            <HeartPulse size={23} />
          </div>
          <p className="muted">
            AllIn reads the export file you choose, in your browser, and checks it against the
            OpenFit 0.1.11 format. It keeps the number of workouts on each day and your weight in
            kilograms for each day. Workout names, notes, exercises, sets, and the file itself are
            not kept.
          </p>
          <div className="step-list">
            <div>
              <span>1</span>
              <p>
                <strong>Choose what to share</strong>Select workouts, weight, and a date range.
              </p>
            </div>
            <div>
              <span>2</span>
              <p>
                <strong>Review the retained fields</strong>Preview only the summaries AllIn needs.
              </p>
            </div>
            <div>
              <span>3</span>
              <p>
                <strong>Keep control</strong>Import locally, avoid duplicates, and purge anytime.
              </p>
            </div>
          </div>
          <p className="field-hint">
            No OpenFit database, login cookies, or backup folder is accessed. Your original export
            will stay wherever you saved it.
          </p>
          <button className="button primary" onClick={() => setInfo(false)}>
            Got it
          </button>
        </Modal>
      )}
    </>
  );
}
