import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coveredDays,
  exportAgeLabel,
  formatDay,
  formatInstant,
  mergedCoverage,
  weekDayCells,
  weightRange,
  workoutCountSuffix,
  WEIGHT_RANGES,
} from '../shared/healthViews.ts';
import type { HealthSummary } from '../shared/healthSchema.ts';

const rows = [
  { day: '2026-10-09', weightKg: 80 },
  { day: '2026-10-10', weightKg: 78 },
  { day: '2026-11-06', weightKg: 76.2 },
];
test('the ranges are 28 days, 90 days, and 1 year', () =>
  assert.deepEqual(
    WEIGHT_RANGES.map((r) => [r.label, r.days]),
    [
      ['28 days', 28],
      ['90 days', 90],
      ['1 year', 365],
    ],
  ));
test('a range keeps its inclusive window and reports the change', () => {
  const view = weightRange(rows, '2026-11-06', 28); // window starts Oct 10
  assert.deepEqual(
    view.rows.map((r) => r.day),
    ['2026-10-10', '2026-11-06'],
  );
  assert.ok(Math.abs(view.change! - -1.8) < 1e-9);
  assert.deepEqual(view.positions, [0, 1]);
});
test('one measurement has a latest value and no change', () => {
  const view = weightRange(rows.slice(2), '2026-11-06', 28);
  assert.equal(view.latest?.weightKg, 76.2);
  assert.equal(view.change, null);
});
test('no measurements in the range', () =>
  assert.deepEqual(weightRange(rows, '2027-06-01', 28), {
    rows: [],
    latest: null,
    change: null,
    positions: [],
  }));
test('a measurement dated tomorrow stays on the chart', () => {
  const view = weightRange([...rows, { day: '2026-11-07', weightKg: 75 }], '2026-11-06', 28);
  assert.equal(view.rows.at(-1)?.day, '2026-11-07');
  assert.equal(view.positions.at(-1), 1);
  assert.ok(view.positions.every((p) => p >= 0 && p <= 1));
});
test('positions follow the dates, not even spacing', () => {
  const view = weightRange(
    [
      { day: '2026-10-10', weightKg: 78 },
      { day: '2026-10-11', weightKg: 77 },
      { day: '2026-11-06', weightKg: 76 },
    ],
    '2026-11-06',
    28,
  );
  assert.deepEqual(view.positions, [0, 1 / 27, 1]);
});
for (const [age, want] of [
  [null, null],
  [0, null],
  [7, null],
  [8, 'Exported 8 days ago'],
] as const)
  test(`age label for ${age}`, () => assert.equal(exportAgeLabel(age), want));
for (const [completed, goal, want] of [
  [2, 3, 'of 3 workouts'],
  [1, 3, 'of 3 workouts'],
  [0, 3, 'of 3 workouts'],
  [0, null, 'workouts'],
  [2, null, 'workouts'],
  [1, null, 'workout'],
] as const)
  test(`count suffix ${want} for ${completed}/${goal}`, () =>
    assert.equal(workoutCountSuffix(completed, goal), want));
test('covered days count workouts and recorded rest only', () => {
  const days = (['workout', 'none', 'missing', 'upcoming'] as const).map((status, i) => ({
    day: `2026-11-0${i + 2}`,
    status,
    count: status === 'workout' ? 1 : 0,
  }));
  assert.equal(coveredDays(days), 2);
});
test('a stored day formats the same in any timezone', () => {
  assert.equal(formatDay('2026-11-06'), 'Nov 6, 2026');
  assert.equal(formatDay('2026-11-06', false), 'Nov 6');
});
test('an instant formats on the display timezone clock', () => {
  assert.equal(formatInstant('2026-11-06T23:30:00.000Z', 'Asia/Jerusalem'), 'Nov 7, 2026');
  assert.equal(formatInstant('2026-11-06T23:30:00.000Z', 'America/New_York'), 'Nov 6, 2026');
});
test('week cells carry a letter, a status, and a title with the weekday', () => {
  const cells = weekDayCells([
    { day: '2026-11-01', status: 'workout', count: 2 },
    { day: '2026-11-02', status: 'none', count: 0 },
    { day: '2026-11-03', status: 'missing', count: 0 },
    { day: '2026-11-04', status: 'upcoming', count: 0 },
  ]);
  assert.deepEqual(
    cells.map((c) => [c.label, c.status]),
    [
      ['S', 'workout'],
      ['M', 'none'],
      ['T', 'missing'],
      ['W', 'upcoming'],
    ],
  );
  assert.deepEqual(
    cells.map((c) => c.title),
    [
      'Sun, Nov 1, 2026 · 2 workouts',
      'Mon, Nov 2, 2026 · No workout recorded',
      'Tue, Nov 3, 2026 · No data',
      'Wed, Nov 4, 2026 · Upcoming',
    ],
  );
});

test('adjoining ranges of one category merge', () =>
  assert.deepEqual(
    mergedCoverage([
      { category: 'workouts', from: '2026-10-01', to: '2026-10-10' },
      { category: 'workouts', from: '2026-10-11', to: '2026-10-20' },
      { category: 'workouts', from: '2026-10-21', to: '2026-10-25' },
    ]),
    [{ category: 'workouts', from: '2026-10-01', to: '2026-10-25' }],
  ));
test('adjoining ranges merge across a month and a year end', () =>
  assert.deepEqual(
    mergedCoverage([
      { category: 'weight', from: '2025-12-20', to: '2025-12-31' },
      { category: 'weight', from: '2026-01-01', to: '2026-01-05' },
    ]),
    [{ category: 'weight', from: '2025-12-20', to: '2026-01-05' }],
  ));
test('ranges with a gap of a day or more stay apart', () =>
  assert.deepEqual(
    mergedCoverage([
      { category: 'workouts', from: '2026-10-01', to: '2026-10-10' },
      { category: 'workouts', from: '2026-10-12', to: '2026-10-20' },
    ]),
    [
      { category: 'workouts', from: '2026-10-01', to: '2026-10-10' },
      { category: 'workouts', from: '2026-10-12', to: '2026-10-20' },
    ],
  ));
test('categories do not mix', () =>
  assert.deepEqual(
    mergedCoverage([
      { category: 'workouts', from: '2026-10-01', to: '2026-10-10' },
      { category: 'weight', from: '2026-10-11', to: '2026-10-20' },
    ]),
    [
      { category: 'workouts', from: '2026-10-01', to: '2026-10-10' },
      { category: 'weight', from: '2026-10-11', to: '2026-10-20' },
    ],
  ));
test('merging does not change its input and handles no ranges', () => {
  const input: HealthSummary['coverage'] = [
    { category: 'workouts', from: '2026-10-11', to: '2026-10-20' },
    { category: 'workouts', from: '2026-10-01', to: '2026-10-10' },
  ];
  const before = structuredClone(input);
  assert.deepEqual(mergedCoverage(input), [
    { category: 'workouts', from: '2026-10-01', to: '2026-10-20' },
  ]);
  assert.deepEqual(input, before);
  assert.deepEqual(mergedCoverage([]), []);
});
