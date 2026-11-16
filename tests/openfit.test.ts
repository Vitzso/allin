import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildImportRequest,
  keptSummary,
  parseOpenFitExport,
  type ImportSelection,
} from '../shared/openfit.ts';
import { healthImportSchema } from '../shared/healthSchema.ts';
import { importRequest } from './helpers.ts';
import { addDays } from '../shared/time.ts';

const fixture = readFileSync(new URL('./fixtures/openfit-0.1.11.json', import.meta.url), 'utf8');
const parse = (text = fixture, timezone = 'UTC', now?: Date) =>
  parseOpenFitExport(text, { timezone, now });
const ok = (text = fixture, timezone = 'UTC') => {
  const result = parse(text, timezone);
  assert.ok(result.ok); // narrows the union for the tests below
  return result;
};
const edit = (change: (d: any) => void) => {
  const data = JSON.parse(fixture);
  change(data);
  return JSON.stringify(data);
};
const many = (count: number, day: string) =>
  Array.from({ length: count }, () => ({ day, sets: [{}] }));
const manyDays = (count: number) =>
  Array.from({ length: count }, (_, i) => addDays('1950-01-01', i));

test('keeps one row per day with the number of counted workouts', () =>
  assert.deepEqual(ok().workouts, [
    { day: '2026-10-26', workouts: 1 },
    { day: '2026-11-02', workouts: 2 },
    { day: '2026-11-04', workouts: 1 },
    { day: '2026-11-06', workouts: 1 },
  ]));

test('skips empty and warm-up-only workouts and says how many', () =>
  assert.equal(ok().skippedWorkouts, 2));

test('keeps weights in day order', () => {
  const p = ok(edit((d) => d.bodyWeights.reverse()));
  assert.deepEqual(p.weights, [
    { day: '2026-10-25', weightKg: 77.1 },
    { day: '2026-11-01', weightKg: 76.8 },
    { day: '2026-11-05', weightKg: 76.2 },
  ]);
  assert.deepEqual(p.weightSpan, { first: '2026-10-25', last: '2026-11-05' });
});

test('records the source and the entry spans', () => {
  const p = ok();
  assert.deepEqual(p.source, {
    app: 'openfit',
    version: 1,
    exportedAt: '2026-11-06T18:00:00.000Z',
  });
  assert.deepEqual(p.workoutSpan, { first: '2026-10-26', last: '2026-11-06' });
});

test('a skipped workout still counts as the earliest entry', () => {
  const p = ok(edit((d) => d.workouts.unshift({ day: '2026-10-20', sets: [{ kind: 'warmup' }] })));
  assert.equal(p.workoutSpan?.first, '2026-10-20');
  assert.equal(p.workouts[0].day, '2026-10-26');
});

test('spans are null when there are no entries', () => {
  const p = ok(
    edit((d) => {
      d.workouts = [];
      d.bodyWeights = [];
    }),
  );
  assert.equal(p.workoutSpan, null);
  assert.equal(p.weightSpan, null);
  assert.deepEqual(p.workouts, []);
  assert.deepEqual(p.weights, []);
});

test('reports what is discarded, with counts', () =>
  assert.deepEqual(ok().discarded, {
    coachMessages: 3,
    foodEntries: 2,
    foodProducts: 1,
    exercises: 2,
    workoutNotes: 2,
    workoutSets: 7,
    profileSettings: 1,
  }));

test('discarded counts treat anything but an array as 0', () => {
  const p = ok(
    edit((d) => {
      d.coachMessages = 'PRIVATE-MARKER';
      d.foodEntries = { length: 5 };
      delete d.foodProducts;
      d.exercises = null;
      d.settings = 4;
    }),
  );
  assert.deepEqual(p.discarded, {
    coachMessages: 0,
    foodEntries: 0,
    foodProducts: 0,
    exercises: 0,
    workoutNotes: 2,
    workoutSets: 7,
    profileSettings: 0,
  });
});

test('reads the file week start for comparison only', () => {
  assert.equal(ok().fileWeekStart, 0);
  assert.equal(ok(edit((d) => delete d.settings)).fileWeekStart, null);
  assert.equal(ok(edit((d) => (d.settings = []))).fileWeekStart, null);
  assert.equal(ok(edit((d) => (d.settings[0].weekStart = 9))).fileWeekStart, null);
  assert.equal(ok(edit((d) => (d.settings[0].weekStart = 'x'))).fileWeekStart, null);
});

test('no private text reaches the result', () =>
  assert.doesNotMatch(JSON.stringify(ok()), /PRIVATE-MARKER/));

test('unknown fields are ignored', () => {
  const p = ok(
    edit((d) => {
      d.extra = { a: 1 };
      d.workouts[0].mood = 'great';
      d.workouts[0].sets[0].tempo = '3-1-1';
      d.bodyWeights[0].bodyFat = 20;
    }),
  );
  assert.deepEqual(p.workouts, ok().workouts);
  assert.doesNotMatch(JSON.stringify(p), /mood|tempo|bodyFat|extra/);
});

test('the export day uses the display timezone', () => {
  assert.equal(ok(fixture, 'Asia/Tokyo').exportDay, '2026-11-07');
  assert.equal(ok(fixture, 'America/Los_Angeles').exportDay, '2026-11-06');
});

test('an entry may be one day past the export day, in that timezone', () => {
  const later = edit((d) => d.bodyWeights.push({ day: '2026-11-08', weightKg: 76 }));
  assert.equal(parse(later, 'Asia/Tokyo').ok, true);
  assert.equal(parse(later, 'America/Los_Angeles').ok, false);
});

for (const [name, text] of [
  ['weight of exactly 1000', edit((d) => (d.bodyWeights[0].weightKg = 1000))],
  ['100 workouts on one day', edit((d) => (d.workouts = many(100, '2026-11-01')))],
  ['the earliest allowed day', edit((d) => (d.bodyWeights[0].day = '0001-01-01'))],
  [
    '20,000 workout days',
    edit((d) => (d.workouts = manyDays(20_000).map((day) => ({ day, sets: [{}] })))),
  ],
  [
    '20,000 weight days',
    edit((d) => (d.bodyWeights = manyDays(20_000).map((day) => ({ day, weightKg: 70 })))),
  ],
])
  test(`accepts ${name}`, () => assert.equal(parse(text).ok, true));

const rejections: [string, string, string, RegExp?][] = [
  ['not JSON', '{ nope PRIVATE-MARKER', 'not-openfit'],
  ['an array', '[]', 'not-openfit'],
  ['null', 'null', 'not-openfit'],
  ['another app', edit((d) => (d.app = 'other-PRIVATE-MARKER')), 'not-openfit'],
  ['version 2', edit((d) => (d.version = 2)), 'unsupported-format'],
  ['pounds', edit((d) => (d.units = 'weights in lb')), 'unsupported-format'],
  ['a bad exportedAt', edit((d) => (d.exportedAt = 'PRIVATE-MARKER')), 'unsupported-format'],
  [
    'an exportedAt of more than 64 characters',
    edit((d) => (d.exportedAt = `2026-11-06T18:00:00.${'1'.repeat(64)}Z`)),
    'unsupported-format',
  ],
  ['no workouts', edit((d) => delete d.workouts), 'invalid-entries'],
  ['workouts not an array', edit((d) => (d.workouts = 'PRIVATE-MARKER')), 'invalid-entries'],
  ['an impossible workout day', edit((d) => (d.workouts[0].day = '2026-13-40')), 'invalid-entries'],
  ['a text workout day', edit((d) => (d.workouts[0].day = 'PRIVATE-MARKER')), 'invalid-entries'],
  ['a workout without sets', edit((d) => delete d.workouts[0].sets), 'invalid-entries'],
  [
    'a set that is not an object',
    edit((d) => (d.workouts[0].sets = ['PRIVATE-MARKER'])),
    'invalid-entries',
  ],
  ['a numeric kind', edit((d) => (d.workouts[0].sets[0].kind = 3)), 'invalid-entries'],
  [
    'a workout that is not an object',
    edit((d) => (d.workouts[0] = 'PRIVATE-MARKER')),
    'invalid-entries',
  ],
  ['no bodyWeights', edit((d) => delete d.bodyWeights), 'invalid-entries'],
  ['a bad weight day', edit((d) => (d.bodyWeights[0].day = 'PRIVATE-MARKER')), 'invalid-entries'],
  [
    'a duplicate weight day',
    edit((d) => (d.bodyWeights[1].day = d.bodyWeights[0].day)),
    'invalid-entries',
  ],
  ['a weight of 0', edit((d) => (d.bodyWeights[0].weightKg = 0)), 'invalid-entries'],
  ['a weight of -1', edit((d) => (d.bodyWeights[0].weightKg = -1)), 'invalid-entries'],
  ['a weight of 1000.1', edit((d) => (d.bodyWeights[0].weightKg = 1000.1)), 'invalid-entries'],
  ['a text weight', edit((d) => (d.bodyWeights[0].weightKg = '76')), 'invalid-entries'],
  [
    'a workout two days past the export',
    edit((d) => (d.workouts[0].day = '2026-11-08')),
    'invalid-entries',
  ],
  [
    'a weight two days past the export',
    edit((d) => (d.bodyWeights[0].day = '2026-11-08')),
    'invalid-entries',
  ],
  [
    'a workout day of 0000-12-31',
    edit((d) => (d.workouts[0].day = '0000-12-31')),
    'invalid-entries',
  ],
  [
    'a weight day of 0000-12-31',
    edit((d) => (d.bodyWeights[0].day = '0000-12-31')),
    'invalid-entries',
  ],
  [
    '101 workouts on one day',
    edit((d) => (d.workouts = many(101, '2026-11-01'))),
    'invalid-entries',
    /100/,
  ],
  [
    '20,001 workout days',
    edit((d) => (d.workouts = manyDays(20_001).map((day) => ({ day, sets: [{}] })))),
    'invalid-entries',
    /20,000/,
  ],
  [
    '20,001 weight days',
    edit((d) => (d.bodyWeights = manyDays(20_001).map((day) => ({ day, weightKg: 70 })))),
    'invalid-entries',
    /20,000/,
  ],
];
for (const [name, text, reason, message] of rejections)
  test(`rejects ${name}`, () => {
    const result = parse(text);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.reason, reason);
    assert.doesNotMatch(result.message, /PRIVATE-MARKER/);
    if (message) assert.match(result.message, message);
  });

test('every not-openfit rejection uses the same message', () => {
  const messages = ['{ nope', '[]', edit((d) => (d.app = 'x'))].map((t) => {
    const r = parse(t);
    assert.ok(!r.ok);
    return r.message;
  });
  assert.deepEqual(new Set(messages), new Set(['This file isn’t an OpenFit export.']));
});

for (const [name, exportedAt, timezone] of [
  ['before year 1 in a western timezone', '0000-01-01T00:00:00Z', 'America/Los_Angeles'],
  ['after year 9999 in an eastern timezone', '9999-12-31T23:59:59Z', 'Asia/Tokyo'],
])
  test(`rejects an export time ${name}`, () => {
    const result = parse(
      edit((d) => (d.exportedAt = exportedAt)),
      timezone,
    );
    assert.ok(!result.ok);
    assert.equal(result.reason, 'unsupported-format');
    assert.equal(result.message, 'This OpenFit export has no valid export time.');
  });

// An export time ahead of the clock would keep coverage through that date, which only Purge clears.
const NOW = new Date('2026-11-06T18:00:00.000Z');
const exportedAtText = (exportedAt: string) => edit((d) => (d.exportedAt = exportedAt));
test('accepts an export time exactly 24 hours ahead of now', () => {
  const result = parse(exportedAtText('2026-11-07T18:00:00.000Z'), 'UTC', NOW);
  assert.ok(result.ok);
  assert.equal(result.exportDay, '2026-11-07');
});
test('rejects an export time 24 hours and one millisecond ahead of now', () => {
  const result = parse(exportedAtText('2026-11-07T18:00:00.001Z'), 'UTC', NOW);
  assert.ok(!result.ok);
  assert.equal(result.reason, 'unsupported-format');
  assert.equal(result.message, 'This OpenFit export has no valid export time.');
});
test('rejects a far-future export time without repeating it', () => {
  const result = parse(exportedAtText('2999-01-01T00:00:00Z'), 'UTC', NOW);
  assert.ok(!result.ok);
  assert.doesNotMatch(result.message, /2999/);
});
test('the clock defaults to the real one', () => {
  assert.ok(parse().ok);
  assert.ok(!parse(exportedAtText(new Date(Date.now() + 25 * 3600_000).toISOString())).ok);
  assert.ok(parse(exportedAtText(new Date(Date.now() + 23 * 3600_000).toISOString())).ok);
});

// Choosing what to import
const build = ({
  range,
  edit: change,
  workouts = true,
  weight = true,
}: {
  range: ImportSelection['range'];
  edit?: (data: any) => void;
  workouts?: boolean;
  weight?: boolean;
}) => {
  const request = buildImportRequest(ok(change ? edit(change) : fixture), {
    workouts,
    weight,
    range,
  });
  // Every request built here must pass the schema the server checks it with.
  assert.equal(
    healthImportSchema.safeParse({ ...request, dryRun: false, confirmOlder: false }).success,
    true,
  );
  return request as typeof request & {
    workouts: NonNullable<typeof request.workouts>;
    weight: NonNullable<typeof request.weight>;
  };
};
const pick = (part: {
  replaceFrom: string;
  replaceTo: string;
  coverageFrom: string | null;
  coverageTo: string | null;
}) => [part.replaceFrom, part.replaceTo, part.coverageFrom, part.coverageTo];

test('All dates replaces from the first possible day through the last covered day', () => {
  const r = build({ range: 'all' });
  assert.deepEqual(pick(r.workouts), ['0001-01-01', '2026-11-06', '2026-10-26', '2026-11-06']);
  assert.deepEqual(pick(r.weight), ['0001-01-01', '2026-11-06', '2026-10-25', '2026-11-06']);
  assert.equal(r.workouts.rows.length, 4);
  assert.equal(r.weight.rows.length, 3);
  assert.deepEqual(r.source, ok().source);
});

test('a date range keeps only rows inside it', () => {
  const r = build({ range: { from: '2026-11-01', to: '2026-11-04' } });
  assert.deepEqual(pick(r.workouts), ['2026-11-01', '2026-11-04', '2026-11-01', '2026-11-04']);
  assert.deepEqual(
    r.workouts.rows.map((x) => x.day),
    ['2026-11-02', '2026-11-04'],
  );
  assert.deepEqual(
    r.weight.rows.map((x) => x.day),
    ['2026-11-01'],
  );
});

test('coverage starts no earlier than the first entry', () =>
  assert.equal(
    build({ range: { from: '2026-01-01', to: '2026-11-01' } }).workouts.coverageFrom,
    '2026-10-26',
  ));

test('a selection wholly before the first entry adds no coverage', () => {
  const r = build({ range: { from: '2026-01-01', to: '2026-01-31' } });
  assert.deepEqual(pick(r.workouts), ['2026-01-01', '2026-01-31', null, null]);
  assert.deepEqual(r.workouts.rows, []);
  assert.deepEqual(pick(r.weight), ['2026-01-01', '2026-01-31', null, null]);
  assert.deepEqual(r.weight.rows, []);
});

test('a selection wholly after the last covered day adds no coverage', () => {
  const r = build({ range: { from: '2026-12-01', to: '2026-12-31' } });
  assert.deepEqual(pick(r.workouts), ['2026-12-01', '2026-12-31', null, null]);
  assert.deepEqual(r.workouts.rows, []);
  assert.deepEqual(pick(r.weight), ['2026-12-01', '2026-12-31', null, null]);
  assert.deepEqual(r.weight.rows, []);
});

test('a category with no entries replaces its range and adds no coverage', () => {
  const r = build({ range: 'all', edit: (d) => (d.bodyWeights = []) });
  assert.deepEqual(pick(r.weight), ['0001-01-01', '2026-11-06', null, null]);
  assert.deepEqual(r.weight.rows, []);
});

test('an entry past the export day stays inside the range and coverage', () => {
  const r = build({
    range: 'all',
    edit: (d) => d.workouts.push({ day: '2026-11-07', sets: [{}] }),
  });
  assert.deepEqual(pick(r.workouts), ['0001-01-01', '2026-11-07', '2026-10-26', '2026-11-07']);
  assert.deepEqual(pick(r.weight), ['0001-01-01', '2026-11-06', '2026-10-25', '2026-11-06']);
});

test('a skipped earliest workout starts coverage', () => {
  const r = build({
    range: 'all',
    edit: (d) => d.workouts.unshift({ day: '2026-10-20', sets: [{ kind: 'warmup' }] }),
  });
  assert.equal(r.workouts.coverageFrom, '2026-10-20');
  assert.equal(r.workouts.rows[0].day, '2026-10-26');
});

test('only selected categories are sent', () => {
  const workoutsOnly = build({ range: 'all', weight: false });
  assert.equal('weight' in workoutsOnly, false);
  assert.ok(workoutsOnly.workouts);
  const weightOnly = build({ range: 'all', workouts: false });
  assert.equal('workouts' in weightOnly, false);
  assert.ok(weightOnly.weight);
});

test('the request holds only derived data', () => {
  const text = JSON.stringify(
    build({ range: 'all', edit: (d) => (d.workouts[0].notes = 'PRIVATE-MARKER') }),
  );
  assert.doesNotMatch(text, /PRIVATE-MARKER|weekStart/);
});

test('importRequest defaults to both categories, all dates, and a real save', () => {
  const r = importRequest();
  assert.equal(r.dryRun, false);
  assert.equal(r.confirmOlder, false);
  assert.equal(r.workouts?.replaceFrom, '0001-01-01');
  assert.ok(r.weight);
  assert.equal(importRequest({ dryRun: true, confirmOlder: true }).dryRun, true);
  assert.equal(
    importRequest({ exportedAt: '2026-11-07T00:00:00Z' }).source.exportedAt,
    '2026-11-07T00:00:00Z',
  );
  assert.equal(importRequest({ workouts: false }).workouts, undefined);
});

// Server schema rejections
const valid = () =>
  structuredClone(importRequest({ range: { from: '2026-11-01', to: '2026-11-06' } }));
const rejected: [string, (r: any) => void][] = [
  ['an unknown top field', (r) => (r.extra = 1)],
  ['an unknown category field', (r) => (r.workouts.extra = 1)],
  ['an unknown row field', (r) => (r.workouts.rows[0].extra = 1)],
  ['an unknown source field', (r) => (r.source.extra = 1)],
  [
    'neither category',
    (r) => {
      delete r.workouts;
      delete r.weight;
    },
  ],
  ['no dryRun', (r) => delete r.dryRun],
  ['no confirmOlder', (r) => delete r.confirmOlder],
  ['another source app', (r) => (r.source.app = 'other')],
  ['source version 2', (r) => (r.source.version = 2)],
  ['a long exportedAt', (r) => (r.source.exportedAt = `2026-11-06T18:00:00.${'1'.repeat(64)}Z`)],
  ['a row before the replace range', (r) => (r.workouts.replaceFrom = '2026-11-03')],
  ['a row after the replace range', (r) => (r.workouts.replaceTo = '2026-11-03')],
  ['a duplicate day', (r) => r.workouts.rows.push({ ...r.workouts.rows[0] })],
  ['a workout count of 0', (r) => (r.workouts.rows[0].workouts = 0)],
  ['a workout count of 101', (r) => (r.workouts.rows[0].workouts = 101)],
  ['a workout count of 1.5', (r) => (r.workouts.rows[0].workouts = 1.5)],
  ['a weight of 0', (r) => (r.weight.rows[0].weightKg = 0)],
  ['a weight of 1000.1', (r) => (r.weight.rows[0].weightKg = 1000.1)],
  [
    '20,001 rows',
    (r) => {
      r.workouts.replaceFrom = '0001-01-01';
      r.workouts.coverageFrom = '0001-01-01';
      r.workouts.rows = Array.from({ length: 20_001 }, (_, i) => ({
        day: addDays('1950-01-01', i),
        workouts: 1,
      }));
      r.workouts.coverageFrom = '0001-01-01';
    },
  ],
  [
    'replaceFrom after replaceTo',
    (r) => {
      r.workouts.replaceFrom = '2026-11-07';
      r.workouts.replaceTo = '2026-11-06';
      r.workouts.rows = [];
      r.workouts.coverageFrom = r.workouts.coverageTo = null;
    },
  ],
  [
    'replaceFrom before 0001-01-01',
    (r) => {
      r.workouts.replaceFrom = '0000-12-31';
    },
  ],
  ['coverage starting before the replace range', (r) => (r.workouts.coverageFrom = '2026-10-31')],
  ['coverage ending after the replace range', (r) => (r.workouts.coverageTo = '2026-11-07')],
  [
    'coverageFrom after coverageTo',
    (r) => {
      r.workouts.coverageFrom = '2026-11-05';
      r.workouts.coverageTo = '2026-11-04';
    },
  ],
  ['only coverageFrom null', (r) => (r.workouts.coverageFrom = null)],
  ['only coverageTo null', (r) => (r.workouts.coverageTo = null)],
  ['a row with no coverage', (r) => (r.workouts.coverageFrom = r.workouts.coverageTo = null)],
  ['a row before the coverage range', (r) => (r.workouts.coverageFrom = '2026-11-03')],
  ['a row after the coverage range', (r) => (r.workouts.coverageTo = '2026-11-03')],
];
test('the server schema accepts a valid request', () =>
  assert.equal(healthImportSchema.safeParse(valid()).success, true));
for (const [name, change] of rejected)
  test(`the server schema rejects ${name}`, () => {
    const request = valid();
    change(request);
    assert.equal(healthImportSchema.safeParse(request).success, false);
  });

// keptSummary
test('keptSummary lists both categories for all dates', () =>
  assert.deepEqual(keptSummary(ok(), { workouts: true, weight: true, range: 'all' }), [
    { category: 'workouts', days: 4, first: '2026-10-26', last: '2026-11-06' },
    { category: 'weight', days: 3, first: '2026-10-25', last: '2026-11-05' },
  ]));

test('keptSummary counts only the days inside a date range', () =>
  assert.deepEqual(
    keptSummary(ok(), {
      workouts: true,
      weight: true,
      range: { from: '2026-11-01', to: '2026-11-04' },
    }),
    [
      { category: 'workouts', days: 2, first: '2026-11-02', last: '2026-11-04' },
      { category: 'weight', days: 1, first: '2026-11-01', last: '2026-11-01' },
    ],
  ));

test('keptSummary leaves out a category that is not selected', () => {
  assert.deepEqual(
    keptSummary(ok(), { workouts: false, weight: true, range: 'all' }).map((k) => k.category),
    ['weight'],
  );
  assert.deepEqual(keptSummary(ok(), { workouts: false, weight: false, range: 'all' }), []);
});

test('keptSummary reports no days and no span for a range with no rows', () =>
  assert.deepEqual(
    keptSummary(ok(), {
      workouts: true,
      weight: true,
      range: { from: '2025-01-01', to: '2025-01-31' },
    }),
    [
      { category: 'workouts', days: 0, first: null, last: null },
      { category: 'weight', days: 0, first: null, last: null },
    ],
  ));

test('keptSummary agrees with the request it describes', () => {
  const selection: ImportSelection = {
    workouts: true,
    weight: true,
    range: { from: '2026-11-02', to: '2026-11-05' },
  };
  const request = buildImportRequest(ok(), selection);
  const [workouts, weight] = keptSummary(ok(), selection);
  assert.equal(workouts.days, request.workouts?.rows.length);
  assert.equal(weight.days, request.weight?.rows.length);
});
