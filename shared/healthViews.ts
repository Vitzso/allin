import type { HealthSummary, WeightRow } from './healthSchema.ts';
import { addDays, daysBetween, weekdayName } from './time.ts';

export const WEIGHT_RANGES: readonly { label: string; days: number }[] = [
  { label: '28 days', days: 28 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
];

/**
 * The measurements in the `days` ending on `today` (inclusive), with each one's place along that
 * window. A measurement dated after today stays in view, pinned to the right edge.
 */
export function weightRange(weights: WeightRow[], today: string, days: number) {
  const start = addDays(today, -(days - 1));
  const rows = weights.filter((row) => row.day >= start).sort((a, b) => a.day.localeCompare(b.day));
  const span = daysBetween(start, today) || 1;
  const latest = rows.at(-1) ?? null;
  return {
    rows,
    latest,
    change: latest && rows.length > 1 ? latest.weightKg - rows[0].weightKg : null,
    positions: rows.map((row) => Math.min(1, Math.max(0, daysBetween(start, row.day) / span))),
  };
}

export function exportAgeLabel(age: number | null) {
  return age !== null && age > 7 ? `Exported ${age} days ago` : null;
}

/** What follows the count: 'workouts', 'workout', or 'of 3 workouts' when there is a goal. */
export function workoutCountSuffix(completed: number, goal: number | null) {
  if (goal !== null) return `of ${goal} workouts`;
  return completed === 1 ? 'workout' : 'workouts';
}

/** Shown in place of a count when no day of the week is known. A missing week is not zero. */
export const NO_WORKOUT_DATA = 'No workout data this week';

/** Days with a workout or a recorded rest. Missing and upcoming days are not covered. */
export function coveredDays(days: HealthSummary['week']['days']) {
  return days.filter((day) => day.status === 'workout' || day.status === 'none').length;
}

/**
 * The coverage as the Health page shows it: ranges of one category that adjoin (one starts the day
 * after the previous ends) are joined. The stored ranges are not changed.
 */
export function mergedCoverage(coverage: HealthSummary['coverage']): HealthSummary['coverage'] {
  const merged: HealthSummary['coverage'] = [];
  const order = (category: string) => (category === 'workouts' ? 0 : 1);
  const sorted = [...coverage].sort(
    (a, b) => order(a.category) - order(b.category) || a.from.localeCompare(b.from),
  );
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && last.category === range.category && daysBetween(last.to, range.from) <= 1)
      last.to = range.to > last.to ? range.to : last.to;
    else merged.push({ ...range });
  }
  return merged;
}

/** A stored YYYY-MM-DD day. It is read at noon UTC, so no timezone can move it. */
export function formatDay(day: string, year = true) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(year ? { year: 'numeric' } : {}),
  }).format(new Date(`${day}T12:00:00Z`));
}

/** The date of an instant on the display timezone's calendar. */
export function formatInstant(iso: string, timezone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}

const statusText = {
  none: 'No workout recorded',
  missing: 'No data',
  upcoming: 'Upcoming',
} as const;
/** The week's days as the day grid draws them. */
export function weekDayCells(days: HealthSummary['week']['days']) {
  return days.map(({ day, status, count }) => ({
    label: weekdayName(day)[0],
    status,
    title: `${weekdayName(day)}, ${formatDay(day)} · ${
      status === 'workout' ? `${count} ${count === 1 ? 'workout' : 'workouts'}` : statusText[status]
    }`,
  }));
}
