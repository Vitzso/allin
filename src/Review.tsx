import { useState } from 'react';
import { CheckCheck, Clock3, ArrowUpRight, Sprout, CalendarDays } from 'lucide-react';
import { calendarDay, type Task, type Settings } from '../shared/schema';
import { weekdayName } from '../shared/time';
import { adjustmentFor, nextWeekStart, weeklyReview } from '../shared/taskViews';
import { Badge, SectionHeader, Provenance } from './components';
export function Review({
  tasks,
  settings,
  saveSettings,
  demo,
}: {
  tasks: Task[];
  settings: Settings;
  saveSettings: (s: Settings) => Promise<void>;
  demo: boolean;
}) {
  const date = demo ? new Date('2026-10-30T12:00:00Z') : new Date();
  const review = weeklyReview(tasks, settings.timezone, date, settings.weekStart);
  const today = calendarDay(date.toISOString(), settings.timezone);
  const nextWeek = nextWeekStart(today, settings.weekStart);
  const savedForNextWeek = settings.adjustmentWeek === nextWeek;
  const current = adjustmentFor(settings, today);
  const [choice, setChoice] = useState(savedForNextWeek ? settings.weekAdjustment : ''),
    [saved, setSaved] = useState(savedForNextWeek),
    [error, setError] = useState('');
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">LOOK BACK. MOVE FORWARD.</div>
          <h1>A week worth noticing.</h1>
          <p>No score to chase. Just a little insight for what comes next.</p>
        </div>
        <Badge>
          <CalendarDays size={13} />
          {review.from} – {review.to}
        </Badge>
      </div>
      <div className="review-stats">
        <div className="card padded">
          <div className="icon-tile mint">
            <CheckCheck size={21} />
          </div>
          <span className="metric-title">Planned tasks completed</span>
          <div className="stat-value">
            {review.plannedCompletedCount}
            <small> / {review.plannedCount}</small>
          </div>
          <p>{review.completedCount} total completed this week</p>
        </div>
        <div className="card padded">
          <div className="icon-tile lavender">
            <Clock3 size={21} />
          </div>
          <span className="metric-title">Planned effort</span>
          <div className="stat-value">
            {review.plannedEstimate}
            <small> min</small>
          </div>
          <p>{review.unestimatedCount} planned tasks have no estimate</p>
        </div>
        <div className="card padded">
          <div className="icon-tile peach">
            <Clock3 size={21} />
          </div>
          <span className="metric-title">Actual effort on planned tasks</span>
          <div className="stat-value">
            {review.plannedActual}
            <small> min</small>
          </div>
          <p>
            {review.plannedMissingEffort} completed planned tasks have missing effort
            {review.unplannedActual > 0 && ` · ${review.unplannedActual} min on unplanned tasks`}
          </p>
        </div>
      </div>
      <div className="review-layout">
        <div className="card padded">
          <SectionHeader title="The shape of your week" />
          <div className="weekly-chart">
            {review.days.map(({ day, completed }) => (
              <div key={day}>
                <span>{completed}</span>
                <div className="weekly-bar-track">
                  <div
                    style={{ height: completed ? `${Math.min(100, 15 + completed * 18)}%` : '3px' }}
                  />
                </div>
                <small>{weekdayName(day)}</small>
              </div>
            ))}
          </div>
          <Provenance>
            {demo ? 'Synthetic task example' : 'Your local tasks'} · Completed tasks by day ·{' '}
            {settings.timezone}
          </Provenance>
        </div>
        <div className="card padded adjustment">
          <div className="icon-tile mint">
            <Sprout size={22} />
          </div>
          <h2>One small adjustment.</h2>
          <p>Choose something you’d like to bring into next week.</p>
          {current?.label === 'This week' && (
            <p className="field-hint">This week: {current.text}</p>
          )}
          {[
            'Leave more space between tasks',
            'Protect one daily focus block',
            'Keep my daily priorities to three',
          ].map((text) => (
            <label className={`choice-row ${choice === text ? 'selected' : ''}`} key={text}>
              <input
                type="radio"
                name="adjustment"
                checked={choice === text}
                onChange={() => {
                  setChoice(text);
                  setSaved(false);
                }}
              />
              {text}
            </label>
          ))}
          <button
            className="button primary full-width"
            disabled={!choice}
            onClick={async () => {
              try {
                await saveSettings({
                  ...settings,
                  weekAdjustment: choice,
                  adjustmentWeek: nextWeek,
                });
                setSaved(true);
                setError('');
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {saved ? 'Adjustment saved' : 'Keep this intention'}
            <ArrowUpRight size={15} />
          </button>
          {saved && <p className="field-hint">Saved for the week of {nextWeek}.</p>}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="subtle-note">
        <Sprout size={17} />
        <p>
          Workout consistency is kept in Health. No health summary is shared with your task review.
        </p>
      </div>
    </>
  );
}
