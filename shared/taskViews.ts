import { calendarDay, type Settings, type Task } from './schema.ts';
import { addDays, startOfWeek } from './time.ts';

/** An open task that needs attention today: due or scheduled today, or overdue. */
export function isOnToday(task: Task, today: string, timezone: string) {
  if (task.status !== 'open') return false;
  if (task.dueDay && task.dueDay <= today) return true;
  return !!task.scheduledAt && calendarDay(task.scheduledAt, timezone) <= today;
}

const priorityRank = { high: 0, medium: 1, low: 2 };
/** The next three open tasks: what's due now first, then by priority, then earliest due day. */
export function nextPriorities(tasks: Task[], today: string, timezone: string) {
  const dueRank = (task: Task) => (isOnToday(task, today, timezone) ? 0 : 1);
  return tasks
    .filter((task) => task.status === 'open')
    .sort(
      (a, b) =>
        dueRank(a) - dueRank(b) ||
        priorityRank[a.priority] - priorityRank[b.priority] ||
        (a.dueDay ?? '9999-12-31').localeCompare(b.dueDay ?? '9999-12-31'),
    )
    .slice(0, 3);
}

export function visibleTasks(
  tasks: Task[],
  options: {
    view: string;
    search: string;
    project: string | null;
    today: string;
    timezone: string;
  },
) {
  const search = options.search.toLowerCase();
  return tasks.filter(
    (task) =>
      (options.view === 'Completed'
        ? task.status === 'done'
        : options.view === 'All tasks'
          ? true
          : options.view === 'Today'
            ? isOnToday(task, options.today, options.timezone)
            : task.status === 'open') &&
      (!options.project || task.project === options.project) &&
      `${task.title} ${task.project}`.toLowerCase().includes(search),
  );
}

export const nextWeekStart = (day: string, weekStart: number) =>
  addDays(startOfWeek(day, weekStart), 7);

export function weeklyReview(tasks: Task[], timezone: string, now: Date, weekStart: number) {
  const localDay = (iso: string) => calendarDay(iso, timezone);
  const from = startOfWeek(localDay(now.toISOString()), weekStart),
    to = addDays(from, 6);
  const inWeek = (day: string | null) => !!day && day >= from && day <= to;
  const planned = tasks.filter(
    (t) => inWeek(t.dueDay) || inWeek(t.scheduledAt ? localDay(t.scheduledAt) : null),
  );
  const plannedIds = new Set(planned.map((t) => t.id));
  const completed = tasks.filter((t) => t.completedAt && inWeek(localDay(t.completedAt)));
  const plannedCompleted = planned.filter((t) => t.status === 'done');
  const minutes = (list: Task[], field: 'estimate' | 'actual') =>
    list.reduce((sum, t) => sum + (t[field] ?? 0), 0);
  return {
    from,
    to,
    days: Array.from({ length: 7 }, (_, i) => {
      const day = addDays(from, i);
      return { day, completed: completed.filter((t) => localDay(t.completedAt!) === day).length };
    }),
    plannedCount: planned.length,
    plannedCompletedCount: plannedCompleted.length,
    completedCount: completed.length,
    plannedEstimate: minutes(planned, 'estimate'),
    unestimatedCount: planned.filter((t) => t.estimate === null).length,
    // Effort is compared on the same planned tasks as the estimate. Unplanned work is reported
    // separately so it can't make the plan look over or under budget.
    plannedActual: minutes(planned, 'actual'),
    plannedMissingEffort: plannedCompleted.filter((t) => t.actual === null).length,
    unplannedActual: minutes(
      completed.filter((t) => !plannedIds.has(t.id)),
      'actual',
    ),
  };
}

/** The saved weekly adjustment as it applies on `day`, or null once its week has passed. */
export function adjustmentFor(settings: Settings, day: string) {
  const week = settings.adjustmentWeek;
  if (!week || !settings.weekAdjustment || day > addDays(week, 6)) return null;
  return { label: day >= week ? 'This week' : 'Next week', text: settings.weekAdjustment };
}
