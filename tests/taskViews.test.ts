import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsSchema, type Task } from '../shared/schema.ts';
import {
  adjustmentFor,
  isOnToday,
  nextPriorities,
  nextWeekStart,
  visibleTasks,
  weeklyReview,
} from '../shared/taskViews.ts';
import { startOfWeek, weekdayName } from '../shared/time.ts';

const task = (overrides: Partial<Task> & { title: string }): Task => ({
  id: crypto.randomUUID(),
  version: 1,
  project: 'Personal',
  priority: 'medium',
  estimate: null,
  dueDay: null,
  scheduledAt: null,
  recurring: 'none',
  actual: null,
  status: 'open',
  createdAt: '2026-10-01T00:00:00.000Z',
  completedAt: null,
  ...overrides,
});
const titles = (tasks: Task[]) => tasks.map((t) => t.title);
const today = '2026-11-06',
  timezone = 'Asia/Jerusalem';

for (const [name, overrides, want] of [
  ['due today', { dueDay: '2026-11-06' }, true],
  ['overdue', { dueDay: '2026-11-01' }, true],
  ['due in the future', { dueDay: '2026-11-07' }, false],
  ['no dates', {}, false],
  ['scheduled today, by local day', { scheduledAt: '2026-11-05T22:30:00.000Z' }, true],
  ['scheduled earlier and still open', { scheduledAt: '2026-11-02T08:00:00.000Z' }, true],
  ['scheduled tomorrow, by local day', { scheduledAt: '2026-11-06T22:30:00.000Z' }, false],
  ['overdue but already done', { dueDay: '2026-11-01', status: 'done' }, false],
] as const)
  test(`Today view: a task that is ${name}`, () => {
    assert.equal(isOnToday(task({ title: 'x', ...overrides }), today, timezone), want);
  });

test('next priorities put tasks due now ahead of undated ones, then rank by priority', () => {
  const ranked = nextPriorities(
    [
      task({ title: 'high, undated', priority: 'high' }),
      task({ title: 'low, overdue', priority: 'low', dueDay: '2026-11-01' }),
      task({ title: 'medium, due today', priority: 'medium', dueDay: '2026-11-06' }),
      task({ title: 'high, due later', priority: 'high', dueDay: '2026-12-01' }),
      task({ title: 'done, overdue', priority: 'high', dueDay: '2026-11-01', status: 'done' }),
    ],
    today,
    timezone,
  );
  assert.deepEqual(titles(ranked), ['medium, due today', 'low, overdue', 'high, due later']);
});
test('next priorities break ties by the earliest due day', () => {
  const ranked = nextPriorities(
    [
      task({ title: 'later', dueDay: '2026-11-30' }),
      task({ title: 'sooner', dueDay: '2026-11-10' }),
      task({ title: 'undated' }),
    ],
    today,
    timezone,
  );
  assert.deepEqual(titles(ranked), ['sooner', 'later', 'undated']);
});

test('the project filter matches the project, not words in a title', () => {
  const shown = visibleTasks(
    [
      task({ title: 'Plan the launch', project: 'Work' }),
      task({ title: 'Workout at the gym', project: 'Personal' }),
    ],
    { view: 'All tasks', search: '', project: 'Work', today, timezone },
  );
  assert.deepEqual(titles(shown), ['Plan the launch']);
});
test('text search still looks at titles and project names', () => {
  const shown = visibleTasks(
    [
      task({ title: 'Plan the launch', project: 'Work' }),
      task({ title: 'Workout at the gym', project: 'Personal' }),
      task({ title: 'Buy milk', project: 'Personal' }),
    ],
    { view: 'All tasks', search: 'work', project: null, today, timezone },
  );
  assert.deepEqual(titles(shown), ['Plan the launch', 'Workout at the gym']);
});
test('task views separate open, today and completed work', () => {
  const tasks = [
    task({ title: 'open, undated' }),
    task({ title: 'overdue', dueDay: '2026-11-01' }),
    task({ title: 'done', status: 'done' }),
  ];
  const view = (name: string) =>
    titles(visibleTasks(tasks, { view: name, search: '', project: null, today, timezone }));
  assert.deepEqual(view('Inbox'), ['open, undated', 'overdue']);
  assert.deepEqual(view('Today'), ['overdue']);
  assert.deepEqual(view('Completed'), ['done']);
  assert.deepEqual(view('All tasks'), ['open, undated', 'overdue', 'done']);
});

test('weekly review compares planned effort with effort on those same planned tasks', () => {
  // Friday Nov 6, 2026. The week runs Monday Nov 2 to Sunday Nov 8.
  const review = weeklyReview(
    [
      task({
        title: 'planned, done, logged',
        dueDay: '2026-11-03',
        estimate: 60,
        actual: 50,
        status: 'done',
        completedAt: '2026-11-03T10:00:00.000Z',
      }),
      task({ title: 'planned, open', dueDay: '2026-11-07', estimate: 30 }),
      task({
        title: 'planned, done, no effort logged',
        dueDay: '2026-11-04',
        estimate: 15,
        status: 'done',
        completedAt: '2026-11-04T10:00:00.000Z',
      }),
      task({ title: 'planned, no estimate', dueDay: '2026-11-05' }),
      task({
        title: 'unplanned, done',
        actual: 100,
        status: 'done',
        completedAt: '2026-11-04T11:00:00.000Z',
      }),
      task({ title: 'next week', dueDay: '2026-11-09', estimate: 500 }),
    ],
    timezone,
    new Date('2026-11-06T12:00:00.000Z'),
    1,
  );
  assert.equal(review.from, '2026-11-02');
  assert.equal(review.to, '2026-11-08');
  assert.equal(review.plannedCount, 4);
  assert.equal(review.plannedCompletedCount, 2);
  assert.equal(review.completedCount, 3);
  assert.equal(review.plannedEstimate, 105);
  assert.equal(review.unestimatedCount, 1);
  assert.equal(review.plannedActual, 50);
  assert.equal(review.plannedMissingEffort, 1);
  assert.equal(review.unplannedActual, 100);
  assert.deepEqual(
    review.days.map((d) => d.completed),
    [0, 1, 2, 0, 0, 0, 0],
  );
});
test('weekly review assigns completions to the local day, not the UTC day', () => {
  const review = weeklyReview(
    [
      task({
        title: 'late Sunday UTC is Monday in Jerusalem',
        status: 'done',
        completedAt: '2026-11-01T22:30:00.000Z',
      }),
    ],
    timezone,
    new Date('2026-11-06T12:00:00.000Z'),
    1,
  );
  assert.equal(review.completedCount, 1);
  assert.equal(review.days[0].completed, 1);
});

test('the week after a given day starts on the following Monday', () => {
  assert.equal(nextWeekStart('2026-11-06', 1), '2026-11-09'); // Friday
  assert.equal(nextWeekStart('2026-11-08', 1), '2026-11-09'); // Sunday
  assert.equal(nextWeekStart('2026-11-09', 1), '2026-11-16'); // Monday
});
for (const [day, want] of [
  ['2026-11-08', { label: 'Next week', text: 'Protect focus' }],
  ['2026-11-09', { label: 'This week', text: 'Protect focus' }],
  ['2026-11-15', { label: 'This week', text: 'Protect focus' }],
  ['2026-11-16', null],
] as const)
  test(`an adjustment saved for the week of Nov 9, viewed on ${day}`, () => {
    const settings = settingsSchema.parse({
      timezone: 'UTC',
      weekAdjustment: 'Protect focus',
      adjustmentWeek: '2026-11-09',
    });
    assert.deepEqual(adjustmentFor(settings, day), want);
  });
test('settings saved before adjustments had a week still load and show nothing', () => {
  const legacy = settingsSchema.parse({ timezone: 'UTC', weekAdjustment: 'Old choice' });
  assert.equal(legacy.adjustmentWeek, null);
  assert.equal(adjustmentFor(legacy, '2026-11-09'), null);
});

for (const [weekStart, want] of [
  [0, '2026-11-01'],
  [1, '2026-11-02'],
  [2, '2026-11-03'],
  [3, '2026-11-04'],
  [4, '2026-11-05'],
  [5, '2026-11-06'],
  [6, '2026-10-31'],
] as const)
  test(`the week holding Friday Nov 6, starting on weekday ${weekStart}`, () =>
    assert.equal(startOfWeek('2026-11-06', weekStart), want));
test('weekday names', () => assert.equal(weekdayName('2026-11-06'), 'Fri'));
test('settings saved before this setting default to Monday', () =>
  assert.equal(settingsSchema.parse({ timezone: 'UTC' }).weekStart, 1));
for (const bad of [-1, 7, 1.5, '1'])
  test(`week start ${bad} is rejected`, () =>
    assert.throws(() => settingsSchema.parse({ timezone: 'UTC', weekStart: bad })));
test('the next week follows the setting', () => {
  assert.equal(nextWeekStart('2026-11-06', 0), '2026-11-08');
  assert.equal(nextWeekStart('2026-11-08', 0), '2026-11-15');
});
test('the weekly review follows the setting', () => {
  const review = weeklyReview([], 'UTC', new Date('2026-11-06T12:00:00Z'), 0);
  assert.deepEqual([review.from, review.to], ['2026-11-01', '2026-11-07']);
});
test('a saved adjustment keeps its start date when the week start changes', () => {
  const settings = settingsSchema.parse({
    timezone: 'UTC',
    weekAdjustment: 'Protect focus',
    adjustmentWeek: '2026-11-09',
    weekStart: 0,
  });
  assert.equal(adjustmentFor(settings, '2026-11-15')?.label, 'This week');
  assert.equal(adjustmentFor(settings, '2026-11-16'), null);
});
