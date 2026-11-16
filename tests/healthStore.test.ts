import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { AppError } from '../server/vault.ts';
import type { HealthStore } from '../server/health.ts';
import type { Vault } from '../server/vault.ts';
import { MAX_COVERAGE_RANGES, MAX_HEALTH_ROWS } from '../shared/healthSchema.ts';
import { domainDb, dumpHealth, importRequest, password, profile } from './helpers.ts';

const T0 = '2026-11-06T18:00:00.000Z';
const LATER = '2026-11-07T18:00:00.000Z';
const EARLIER = '2026-11-05T18:00:00.000Z';

function withStore(run: (store: HealthStore, vault: Vault) => void) {
  const p = profile();
  try {
    p.vault.setup(password);
    run(p.vault.health, p.vault);
  } finally {
    p.cleanup();
  }
}
const coverage = (vault: Vault, category: string) =>
  (dumpHealth(vault).health_coverage as Record<string, unknown>[])
    .filter((row) => row.category === category)
    .map((row) => `${row.from_day}..${row.to_day} ${row.exported_at}`);
const importEvents = (vault: Vault) =>
  (vault.events() as { action: string }[]).filter((e) => e.action === 'health.import');

test('saving stores day rows, coverage, and source', () =>
  withStore((store, vault) => {
    const now = new Date('2026-11-06T20:00:00.000Z');
    const result = store.importRows(importRequest(), now);
    assert.equal(result.older, false);
    assert.deepEqual(result.workouts, { added: 4, changed: 0, removed: 0, unchanged: 0 });
    assert.deepEqual(result.weight, { added: 3, changed: 0, removed: 0, unchanged: 0 });
    const dump = dumpHealth(vault);
    assert.deepEqual(dump.workout_days, [
      { day: '2026-10-26', workouts: 1 },
      { day: '2026-11-02', workouts: 2 },
      { day: '2026-11-04', workouts: 1 },
      { day: '2026-11-06', workouts: 1 },
    ]);
    assert.deepEqual(dump.weight_days, [
      { day: '2026-10-25', weight_kg: 77.1 },
      { day: '2026-11-01', weight_kg: 76.8 },
      { day: '2026-11-05', weight_kg: 76.2 },
    ]);
    assert.deepEqual(dump.health_coverage, [
      {
        category: 'weight',
        from_day: '2026-10-25',
        to_day: '2026-11-06',
        source_version: 1,
        exported_at: T0,
        imported_at: now.toISOString(),
      },
      {
        category: 'workouts',
        from_day: '2026-10-26',
        to_day: '2026-11-06',
        source_version: 1,
        exported_at: T0,
        imported_at: now.toISOString(),
      },
    ]);
    assert.deepEqual(dump.health_settings, []);
  }));

test('a dry run reports the same counts and writes nothing', () =>
  withStore((store, vault) => {
    const before = dumpHealth(vault);
    const dry = store.importRows(importRequest({ dryRun: true }));
    assert.deepEqual(dumpHealth(vault), before);
    assert.equal(importEvents(vault).length, 0);
    const real = store.importRows(importRequest());
    assert.deepEqual(dry, real);
  }));

test('importing the same file twice changes nothing', () =>
  withStore((store, vault) => {
    store.importRows(importRequest());
    const first = dumpHealth(vault);
    const second = store.importRows(importRequest());
    assert.deepEqual(second.workouts, { added: 0, changed: 0, removed: 0, unchanged: 4 });
    assert.deepEqual(second.weight, { added: 0, changed: 0, removed: 0, unchanged: 3 });
    assert.equal(second.older, false);
    const after = dumpHealth(vault);
    assert.deepEqual(after.workout_days, first.workout_days);
    assert.deepEqual(after.weight_days, first.weight_days);
    assert.equal(after.health_coverage.length, 2);
  }));

test('a corrected entry updates and a deleted entry disappears', () =>
  withStore((store, vault) => {
    store.importRows(importRequest());
    const result = store.importRows(
      importRequest({
        exportedAt: LATER,
        edit: (d) => {
          d.bodyWeights.find((w: any) => w.day === '2026-11-05').weightKg = 76.0;
          d.workouts = d.workouts.filter((w: any) => w.day !== '2026-11-04');
        },
      }),
    );
    assert.deepEqual(result.weight, { added: 0, changed: 1, removed: 0, unchanged: 2 });
    assert.deepEqual(result.workouts, { added: 0, changed: 0, removed: 1, unchanged: 3 });
    const dump = dumpHealth(vault);
    assert.deepEqual(
      (dump.weight_days as { day: string; weight_kg: number }[]).find((r) => r.day === '2026-11-05')
        ?.weight_kg,
      76.0,
    );
    assert.deepEqual(
      (dump.workout_days as { day: string }[]).map((r) => r.day),
      ['2026-10-26', '2026-11-02', '2026-11-06'],
    );
  }));

test('All dates removes an earliest entry deleted in OpenFit', () =>
  withStore((store, vault) => {
    store.importRows(importRequest());
    const result = store.importRows(
      importRequest({
        exportedAt: LATER,
        edit: (d) => {
          d.workouts = d.workouts.filter((w: any) => w.day !== '2026-10-26');
        },
      }),
    );
    assert.deepEqual(result.workouts, { added: 0, changed: 0, removed: 1, unchanged: 3 });
    const dump = dumpHealth(vault);
    assert.deepEqual(
      (dump.workout_days as { day: string }[]).map((r) => r.day),
      ['2026-11-02', '2026-11-04', '2026-11-06'],
    );
    assert.deepEqual(coverage(vault, 'workouts'), [`2026-11-02..2026-11-07 ${LATER}`]);
  }));

test('a date range replaces only that range and splits coverage', () =>
  withStore((store, vault) => {
    store.importRows(importRequest());
    const result = store.importRows(
      importRequest({
        exportedAt: LATER,
        range: { from: '2026-11-01', to: '2026-11-03' },
        edit: (d) => {
          d.workouts = d.workouts.filter((w: any) => w.day !== '2026-11-04');
          d.bodyWeights.find((w: any) => w.day === '2026-11-01').weightKg = 70;
          d.bodyWeights.find((w: any) => w.day === '2026-11-05').weightKg = 99;
        },
      }),
    );
    assert.deepEqual(result.workouts, { added: 0, changed: 0, removed: 0, unchanged: 1 });
    assert.deepEqual(result.weight, { added: 0, changed: 1, removed: 0, unchanged: 0 });
    assert.deepEqual(coverage(vault, 'workouts'), [
      `2026-10-26..2026-10-31 ${T0}`,
      `2026-11-01..2026-11-03 ${LATER}`,
      `2026-11-04..2026-11-06 ${T0}`,
    ]);
    assert.deepEqual(coverage(vault, 'weight'), [
      `2026-10-25..2026-10-31 ${T0}`,
      `2026-11-01..2026-11-03 ${LATER}`,
      `2026-11-04..2026-11-06 ${T0}`,
    ]);
    const dump = dumpHealth(vault);
    // Rows outside the range keep what they had, whatever the file says about them.
    assert.deepEqual(
      (dump.workout_days as { day: string }[]).map((r) => r.day),
      ['2026-10-26', '2026-11-02', '2026-11-04', '2026-11-06'],
    );
    assert.deepEqual(dump.weight_days, [
      { day: '2026-10-25', weight_kg: 77.1 },
      { day: '2026-11-01', weight_kg: 70 },
      { day: '2026-11-05', weight_kg: 76.2 },
    ]);
  }));

test('an empty export reports what it removes, then removes it and adds no coverage', () =>
  withStore((store, vault) => {
    store.importRows(importRequest());
    const empty = {
      edit: (d: any) => {
        d.workouts = [];
        d.bodyWeights = [];
      },
      exportedAt: LATER,
    };
    const before = dumpHealth(vault);
    const dry = store.importRows(importRequest({ ...empty, dryRun: true }));
    assert.equal(dry.workouts?.removed, 4);
    assert.equal(dry.weight?.removed, 3);
    assert.deepEqual(dumpHealth(vault), before);
    store.importRows(importRequest(empty));
    const dump = dumpHealth(vault);
    assert.deepEqual(dump.workout_days, []);
    assert.deepEqual(dump.weight_days, []);
    assert.deepEqual(dump.health_coverage, []);
  }));

test('an older file is reported by a dry run and refused without confirmation', () =>
  withStore((store, vault) => {
    store.importRows(importRequest());
    const before = dumpHealth(vault);
    const older = { exportedAt: EARLIER };
    assert.equal(store.importRows(importRequest({ ...older, dryRun: true })).older, true);
    assert.throws(
      () => store.importRows(importRequest(older)),
      (e: AppError) => e.status === 409 && /older/.test(e.message),
    );
    assert.deepEqual(dumpHealth(vault), before);
    assert.equal(importEvents(vault).length, 1);
    const saved = store.importRows(importRequest({ ...older, confirmOlder: true }));
    assert.equal(saved.older, true);
    assert.deepEqual(coverage(vault, 'workouts'), [`2026-10-26..2026-11-06 ${EARLIER}`]);
  }));

test('older compares instants, not text', () =>
  withStore((store) => {
    store.importRows(importRequest());
    const dry = (exportedAt: string) =>
      store.importRows(importRequest({ exportedAt, dryRun: true })).older;
    assert.equal(dry('2026-11-06T18:00:00Z'), false);
    assert.equal(dry('2026-11-06T17:59:59Z'), true);
    // The saved text now has no milliseconds, which as text sorts after the same instant with them.
    store.importRows(importRequest({ exportedAt: '2026-11-06T18:00:00Z' }));
    assert.equal(dry(T0), false);
  }));

test('older looks only at overlapping coverage in that category', () =>
  withStore((store) => {
    store.importRows(importRequest());
    // Only workouts get a newer file, and only on 11-01..11-03.
    store.importRows(
      importRequest({
        exportedAt: LATER,
        weight: false,
        range: { from: '2026-11-01', to: '2026-11-03' },
      }),
    );
    const olderFor = (category: 'workouts' | 'weight', from: string, to: string) =>
      store.importRows(
        importRequest({
          exportedAt: T0,
          dryRun: true,
          workouts: category === 'workouts',
          weight: category === 'weight',
          range: { from, to },
        }),
      ).older;
    assert.equal(olderFor('workouts', '2026-10-26', '2026-10-31'), false);
    assert.equal(olderFor('workouts', '2026-11-01', '2026-11-03'), true);
    // A range that only touches the newer one at an edge still overlaps it.
    assert.equal(olderFor('workouts', '2026-10-30', '2026-11-01'), true);
    assert.equal(olderFor('workouts', '2026-11-04', '2026-11-06'), false);
    // Weight was never replaced by a newer file.
    assert.equal(olderFor('weight', '2026-11-01', '2026-11-03'), false);
  }));

test('a failure part-way leaves existing data and the log intact', () =>
  withStore((store, vault) => {
    store.importRows(importRequest());
    const before = dumpHealth(vault);
    domainDb(vault, 'health').exec(
      "CREATE TRIGGER fail BEFORE INSERT ON weight_days BEGIN SELECT RAISE(ABORT,'boom'); END",
    );
    assert.throws(() => store.importRows(importRequest({ exportedAt: LATER })));
    assert.deepEqual(dumpHealth(vault), before);
    assert.equal(importEvents(vault).length, 1);
  }));

test('invalid input changes nothing', () =>
  withStore((store, vault) => {
    store.importRows(importRequest());
    const before = dumpHealth(vault);
    const bad = { ...importRequest(), dryRun: undefined };
    assert.throws(() => store.importRows(bad), ZodError);
    assert.throws(() => store.importRows({ nonsense: true }), ZodError);
    assert.deepEqual(dumpHealth(vault), before);
    assert.equal(importEvents(vault).length, 1);
  }));

test('the log records only the action', () =>
  withStore((store, vault) => {
    store.importRows(importRequest());
    const event = vault.events()[0] as Record<string, unknown>;
    assert.equal(event.action, 'health.import');
    assert.equal(event.outcome, 'success');
    assert.deepEqual(Object.keys(event).sort(), ['action', 'at', 'outcome']);
  }));

test('too many coverage ranges are refused, and All dates consolidates them', () =>
  withStore((store, vault) => {
    const db = domainDb(vault, 'health');
    const insert = db.prepare(
      "INSERT INTO health_coverage VALUES ('workouts', ?, ?, 1, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')",
    );
    for (let i = 0; i < MAX_COVERAGE_RANGES; i++) {
      const day = new Date(Date.UTC(1900, 0, 1 + i * 2)).toISOString().slice(0, 10);
      insert.run(day, day);
    }
    const before = dumpHealth(vault);
    assert.throws(
      () => store.importRows(importRequest({ range: { from: '2026-11-01', to: '2026-11-06' } })),
      (e: AppError) => e.status === 409 && /All dates/.test(e.message),
    );
    assert.deepEqual(dumpHealth(vault), before);
    assert.equal(importEvents(vault).length, 0);
    store.importRows(importRequest());
    const after = dumpHealth(vault);
    assert.equal(after.health_coverage.length, 2);
  }));

// Saved workout days from 1900 on, with one coverage range over them, written straight to the table.
function seedWorkoutDays(vault: Vault, count: number) {
  const db = domainDb(vault, 'health');
  const day = (i: number) => new Date(Date.UTC(1900, 0, 1 + i)).toISOString().slice(0, 10);
  const insert = db.prepare('INSERT INTO workout_days VALUES (?, 1)');
  db.transaction(() => {
    for (let i = 0; i < count; i++) insert.run(day(i));
  })();
  db.prepare(
    "INSERT INTO health_coverage VALUES ('workouts', ?, ?, 1, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')",
  ).run(day(0), day(count - 1));
}
const octoberToNovember = { from: '2026-10-01', to: '2026-11-30' };
const workoutsOnly = { workouts: true, weight: false } as const;

test('exactly the most stored days in a category is accepted and still backs up', () =>
  withStore((store, vault) => {
    seedWorkoutDays(vault, MAX_HEALTH_ROWS - 4);
    store.importRows(importRequest({ ...workoutsOnly, range: octoberToNovember }));
    assert.equal(store.backupData().workouts.length, MAX_HEALTH_ROWS);
  }));

test('a range import past the most stored days is refused, and All dates replaces them', () =>
  withStore((store, vault) => {
    seedWorkoutDays(vault, MAX_HEALTH_ROWS - 3);
    const before = dumpHealth(vault);
    assert.throws(
      () => store.importRows(importRequest({ ...workoutsOnly, range: octoberToNovember })),
      (e: AppError) => e.status === 409 && /All dates/.test(e.message),
    );
    assert.deepEqual(dumpHealth(vault), before);
    assert.equal(importEvents(vault).length, 0);
    store.importRows(importRequest(workoutsOnly));
    assert.equal(store.backupData().workouts.length, 4);
  }));

const splitFrom = (range: { from: string; to: string }) => (store: HealthStore, vault: Vault) => {
  store.importRows(importRequest());
  store.importRows(importRequest({ exportedAt: LATER, workouts: true, weight: false, range }));
  return coverage(vault, 'workouts');
};

test('a range at the left edge of coverage leaves only the right side', () =>
  withStore((store, vault) => {
    assert.deepEqual(splitFrom({ from: '2026-10-26', to: '2026-10-31' })(store, vault), [
      `2026-10-26..2026-10-31 ${LATER}`,
      `2026-11-01..2026-11-06 ${T0}`,
    ]);
  }));

test('a range at the right edge of coverage leaves only the left side', () =>
  withStore((store, vault) => {
    assert.deepEqual(splitFrom({ from: '2026-11-04', to: '2026-11-06' })(store, vault), [
      `2026-10-26..2026-11-03 ${T0}`,
      `2026-11-04..2026-11-06 ${LATER}`,
    ]);
  }));

test('a range ending on the last supported day does not throw or invert coverage', () =>
  withStore((store, vault) => {
    assert.deepEqual(splitFrom({ from: '2026-11-01', to: '9999-12-31' })(store, vault), [
      `2026-10-26..2026-10-31 ${T0}`,
      // The file's export day (11-07) lies inside the range, so coverage reaches it.
      `2026-11-01..2026-11-07 ${LATER}`,
    ]);
  }));

test('a range equal to the coverage replaces it with nothing left over', () =>
  withStore((store, vault) => {
    assert.deepEqual(splitFrom({ from: '2026-10-26', to: '2026-11-06' })(store, vault), [
      `2026-10-26..2026-11-06 ${LATER}`,
    ]);
  }));

test('a damaged saved export time stops the import, dry run or not', () =>
  withStore((store, vault) => {
    store.importRows(importRequest());
    domainDb(vault, 'health').exec(
      "INSERT INTO health_coverage VALUES ('workouts', '2026-10-01', '2026-10-02', 1, 'garbage', 'garbage')",
    );
    const before = dumpHealth(vault);
    const events = importEvents(vault).length;
    for (const dryRun of [true, false])
      assert.throws(
        () => store.importRows(importRequest({ exportedAt: EARLIER, dryRun })),
        (e: AppError) => e.status >= 500 && /damaged/.test(e.message),
      );
    assert.deepEqual(dumpHealth(vault), before);
    assert.equal(importEvents(vault).length, events);
  }));

// --- summary, goal, purge ---

const now = new Date('2026-11-06T20:00:00.000Z');
function withSummary(
  run: (store: HealthStore, vault: Vault) => void,
  settings: { timezone?: string; weekStart?: number } = {},
) {
  withStore((store, vault) => {
    vault.setSettings({ timezone: 'UTC', weekAdjustment: '', ...settings });
    run(store, vault);
  });
}
const statuses = (s: { week: { days: { status: string }[] } }) => s.week.days.map((d) => d.status);

test('nothing imported is empty and holds no numbers', () =>
  withSummary((store) => {
    const s = store.summary(now);
    assert.equal(s.state, 'empty');
    assert.deepEqual(
      [s.workoutGoal, s.exportedAt, s.importedAt, s.exportAgeDays],
      [null, null, null, null],
    );
    assert.deepEqual(statuses(s), [
      'missing',
      'missing',
      'missing',
      'missing',
      'missing',
      'upcoming',
      'upcoming',
    ]);
    assert.deepEqual([s.weights, s.recentWorkoutDays, s.coverage], [[], [], []]);
  }));

test('this week separates workouts, recorded rest, and upcoming days', () =>
  withSummary((store) => {
    store.importRows(importRequest());
    const s = store.summary(now);
    assert.equal(s.state, 'imported');
    assert.deepEqual([s.week.from, s.week.to, s.week.completed], ['2026-11-02', '2026-11-08', 4]);
    assert.deepEqual(
      s.week.days.map((d) => [d.day, d.status, d.count]),
      [
        ['2026-11-02', 'workout', 2],
        ['2026-11-03', 'none', 0],
        ['2026-11-04', 'workout', 1],
        ['2026-11-05', 'none', 0],
        ['2026-11-06', 'workout', 1],
        ['2026-11-07', 'upcoming', 0],
        ['2026-11-08', 'upcoming', 0],
      ],
    );
  }));

test('a day before coverage starts has no data', () =>
  withSummary((store) => {
    store.importRows(importRequest({ range: { from: '2026-11-04', to: '2026-11-06' } }));
    const s = store.summary(now);
    assert.deepEqual(statuses(s).slice(0, 5), ['missing', 'missing', 'workout', 'none', 'workout']);
    assert.equal(s.week.completed, 2);
  }));

test('a day after coverage ends has no data', () =>
  withSummary((store) => {
    store.importRows(importRequest());
    const s = store.summary(new Date('2026-11-08T12:00:00.000Z'));
    assert.deepEqual(statuses(s).slice(4), ['workout', 'missing', 'missing']);
    assert.equal(s.exportAgeDays, 2);
  }));

for (const weekStart of [0, 1, 2, 3, 4, 5, 6])
  test(`the week follows week start ${weekStart}`, () =>
    withSummary(
      (store) => {
        const { week } = store.summary(now); // 2026-11-06 is a Friday (5)
        const from = new Date(Date.UTC(2026, 10, 6 - ((5 - weekStart + 7) % 7)))
          .toISOString()
          .slice(0, 10);
        const to = new Date(Date.parse(`${from}T00:00:00Z`) + 6 * 86400000)
          .toISOString()
          .slice(0, 10);
        assert.equal(week.days.length, 7);
        assert.deepEqual([week.from, week.to], [from, to]);
        assert.deepEqual([week.days[0].day, week.days[6].day], [from, to]);
        assert.ok(week.from <= '2026-11-06' && '2026-11-06' <= week.to);
      },
      { weekStart },
    ));

test('a workout dated after today shows and counts', () =>
  withSummary((store) => {
    store.importRows(
      importRequest({
        edit: (d) => {
          d.workouts.push({
            id: 99,
            day: '2026-11-07',
            name: 'x',
            notes: '',
            sets: [{ id: 99, exerciseId: 2, kind: 'work', reps: 1, weightKg: 1 }],
          });
        },
      }),
    );
    const s = store.summary(now);
    assert.deepEqual(statuses(s).slice(5), ['workout', 'upcoming']);
    assert.deepEqual(s.week.days[5], { day: '2026-11-07', status: 'workout', count: 1 });
    assert.equal(s.week.completed, 5);
  }));

test('a weight day with no row is simply absent', () =>
  withSummary((store) => {
    store.importRows(importRequest());
    assert.deepEqual(
      store.summary(now).weights.map((w) => w.day),
      ['2026-10-25', '2026-11-01', '2026-11-05'],
    );
  }));

test('weights cover the last 365 days', () =>
  withSummary((store, vault) => {
    const db = domainDb(vault, 'health');
    db.exec(
      "INSERT INTO weight_days VALUES ('2025-11-06', 80), ('2025-11-07', 79), ('2026-11-06', 78)",
    );
    assert.deepEqual(
      store.summary(now).weights.map((w) => w.day),
      ['2025-11-07', '2026-11-06'],
    );
  }));

test('recent workout days hold the latest 10, newest first', () =>
  withSummary((store, vault) => {
    const insert = domainDb(vault, 'health').prepare('INSERT INTO workout_days VALUES (?, ?)');
    // 12 days ending 2026-11-06, so 10-26 and 10-27 are dropped.
    for (let i = 0; i < 12; i++)
      insert.run(new Date(Date.UTC(2026, 9, 26 + i)).toISOString().slice(0, 10), i + 1);
    const days = store.summary(now).recentWorkoutDays;
    assert.equal(days.length, 10);
    assert.deepEqual(days[0], { day: '2026-11-06', count: 12 });
    assert.deepEqual(days[9], { day: '2026-10-28', count: 3 });
  }));

test('source dates are the newest across coverage', () =>
  withSummary((store) => {
    store.importRows(importRequest(), new Date('2026-11-06T20:00:00.000Z'));
    store.importRows(
      importRequest({ exportedAt: LATER, range: { from: '2026-11-04', to: '2026-11-06' } }),
      new Date('2026-11-07T20:00:00.000Z'),
    );
    const s = store.summary(new Date('2026-11-07T21:00:00.000Z'));
    assert.equal(s.exportedAt, LATER);
    assert.equal(s.importedAt, '2026-11-07T20:00:00.000Z');
    assert.equal(s.exportAgeDays, 0);
  }));

test('coverage is listed by category, then date', () =>
  withSummary((store) => {
    store.importRows(importRequest());
    assert.deepEqual(store.summary(now).coverage, [
      { category: 'weight', from: '2026-10-25', to: '2026-11-06' },
      { category: 'workouts', from: '2026-10-26', to: '2026-11-06' },
    ]);
  }));

test('changing the timezone moves today but no stored day', () =>
  withSummary((store, vault) => {
    store.importRows(importRequest());
    vault.setSettings({ timezone: 'Asia/Tokyo', weekAdjustment: '' });
    const s = store.summary(now); // Nov 7 in Tokyo
    assert.deepEqual(s.week.days[0], { day: '2026-11-02', status: 'workout', count: 2 });
    assert.equal(s.week.days[5].status, 'missing');
    assert.equal(s.week.days[6].status, 'upcoming');
    assert.equal(s.exportAgeDays, 0);
  }));

test('a goal is saved and cleared, and survives an import', () =>
  withSummary((store, vault) => {
    assert.deepEqual(store.setGoal({ workoutGoal: 3 }), { workoutGoal: 3 });
    assert.equal(store.summary(now).workoutGoal, 3);
    assert.equal((vault.events()[0] as { action: string }).action, 'health.goal');
    store.importRows(importRequest());
    assert.equal(store.summary(now).workoutGoal, 3);
    store.setGoal({ workoutGoal: 5 });
    assert.equal(
      domainDb(vault, 'health').prepare('SELECT count(*) AS n FROM health_settings').get()?.[
        'n' as never
      ],
      1,
    );
    assert.deepEqual(store.setGoal({ workoutGoal: null }), { workoutGoal: null });
    assert.equal(store.summary(now).workoutGoal, null);
  }));

for (const bad of [
  { workoutGoal: 0 },
  { workoutGoal: 15 },
  { workoutGoal: 1.5 },
  { workoutGoal: '3' },
  {},
  { workoutGoal: 3, extra: 1 },
])
  test(`goal ${JSON.stringify(bad)} is rejected`, () =>
    withSummary((store, vault) => {
      const before = dumpHealth(vault);
      assert.throws(() => store.setGoal(bad), ZodError);
      assert.deepEqual(dumpHealth(vault), before);
    }));

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
  );

test('purge deletes everything, including the goal', () => {
  const p = profile();
  try {
    p.vault.setup(password);
    p.vault.setSettings({ timezone: 'UTC', weekAdjustment: '' });
    const store = p.vault.health;
    const vault = p.vault;
    store.importRows(importRequest());
    store.setGoal({ workoutGoal: 3 });
    store.purge();
    assert.deepEqual(dumpHealth(vault), {
      workout_days: [],
      weight_days: [],
      health_coverage: [],
      health_settings: [],
    });
    assert.equal(store.summary(now).state, 'empty');
    assert.equal(domainDb(vault, 'health').pragma('secure_delete', { simple: true }), 1);
    assert.equal((vault.events()[0] as { action: string }).action, 'health.purge');
    // The files are encrypted, so this guards against a plaintext copy of the data left in the
    // profile. The row checks above are what prove the deletion.
    vault.lock();
    const files = filesUnder(p.directory);
    assert.ok(files.length > 0);
    for (const file of files) {
      const bytes = readFileSync(file);
      assert.equal(bytes.includes('PRIVATE-MARKER'), false, `${file} holds PRIVATE-MARKER`);
      assert.equal(bytes.includes('2026-11-02'), false, `${file} holds a plaintext day`);
    }
  } finally {
    p.cleanup();
  }
});

for (const [name, sql] of [
  ['workout day', "INSERT INTO workout_days VALUES ('not-a-day', 1)"],
  ['weight', "INSERT INTO weight_days VALUES ('2026-11-01', -1)"],
  [
    'export time',
    "INSERT INTO health_coverage VALUES ('weight', '2026-11-01', '2026-11-02', 1, 'garbage', '2026-11-06T18:00:00.000Z')",
  ],
  [
    'import time',
    "INSERT INTO health_coverage VALUES ('weight', '2026-11-01', '2026-11-02', 1, '2026-11-06T18:00:00.000Z', 'garbage')",
  ],
])
  test(`an unreadable saved ${name} is reported as damage`, () =>
    withSummary((store, vault) => {
      domainDb(vault, 'health').exec(sql);
      assert.throws(
        () => store.summary(now),
        (e: AppError) => e.status >= 500 && /damaged/.test(e.message),
      );
    }));

test('a locked vault has no health store', () => {
  const p = profile();
  try {
    assert.throws(() => p.vault.health, /Unlock/);
    p.vault.setup(password);
    p.vault.lock();
    assert.throws(() => p.vault.health, /Unlock/);
  } finally {
    p.cleanup();
  }
});
