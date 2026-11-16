import type Database from 'better-sqlite3-multiple-ciphers';
import {
  MAX_COVERAGE_RANGES,
  MAX_HEALTH_ROWS,
  exportedAtSchema,
  healthBackupSchema,
  healthGoalSchema,
  healthImportSchema,
  weightRowSchema,
  workoutRowSchema,
  type ChangeCounts,
  type HealthBackup,
  type DayStatus,
  type HealthImportResult,
  type HealthSummary,
} from '../shared/healthSchema.ts';
import { calendarDay, type Settings } from '../shared/schema.ts';
import { addDays, daysBetween, startOfWeek } from '../shared/time.ts';
import { AppError, readStored } from './errors.ts';

export type HealthContext = { settings: () => Settings; event: (action: string) => void };

// The only place table and column names come from. Nothing in a request reaches an SQL string.
const CATEGORIES = {
  workouts: { table: 'workout_days', column: 'workouts', field: 'workouts' },
  weight: { table: 'weight_days', column: 'weight_kg', field: 'weightKg' },
} as const;
type Category = keyof typeof CATEGORIES;
const ORDER: Category[] = ['workouts', 'weight'];

type Coverage = {
  from_day: string;
  to_day: string;
  source_version: number;
  exported_at: string;
  imported_at: string;
};

export class HealthStore {
  constructor(
    private readonly db: Database.Database,
    private readonly context: HealthContext,
  ) {}

  importRows(input: unknown, now: Date = new Date()): HealthImportResult {
    const request = healthImportSchema.parse(input);
    const exportedAt = Date.parse(request.source.exportedAt);
    const result = this.db.transaction((): HealthImportResult => {
      const sent = ORDER.filter((category) => request[category] !== undefined);
      // A file is older than saved data when any overlapping range in the same category came
      // from a later export. These are instants, so they are compared as numbers.
      const overlapping = this.db.prepare(
        'SELECT exported_at FROM health_coverage WHERE category = ? AND from_day <= ? AND to_day >= ?',
      );
      // A saved time that can't be read must stop the import, not read as "not older".
      // Every overlapping row is validated, so a damaged one can't hide behind an earlier match.
      const older = readStored(() =>
        sent
          .flatMap((category) => {
            const part = request[category]!;
            return overlapping.all(category, part.replaceTo, part.replaceFrom) as {
              exported_at: string;
            }[];
          })
          .map((row) => Date.parse(exportedAtSchema.parse(row.exported_at)))
          .some((saved) => saved > exportedAt),
      );
      if (older && !request.confirmOlder && !request.dryRun)
        throw new AppError(
          409,
          'This file is older than the data already saved for those dates. Confirm to use it anyway.',
        );
      const outcome: HealthImportResult = { older };
      for (const category of sent) {
        const part = request[category]!;
        const { table, column, field } = CATEGORIES[category];
        const existing = new Map(
          (
            this.db
              .prepare(`SELECT day, ${column} AS value FROM ${table} WHERE day BETWEEN ? AND ?`)
              .all(part.replaceFrom, part.replaceTo) as { day: string; value: number }[]
          ).map((row) => [row.day, row.value]),
        );
        const counts: ChangeCounts = { added: 0, changed: 0, removed: 0, unchanged: 0 };
        for (const row of part.rows) {
          const value = (row as Record<string, number | string>)[field] as number;
          const before = existing.get(row.day);
          if (before === undefined) counts.added++;
          else if (before === value) counts.unchanged++;
          else counts.changed++;
          existing.delete(row.day);
        }
        counts.removed = existing.size;
        outcome[category] = counts;
        if (request.dryRun) continue;
        this.db
          .prepare(`DELETE FROM ${table} WHERE day BETWEEN ? AND ?`)
          .run(part.replaceFrom, part.replaceTo);
        const insert = this.db.prepare(`INSERT INTO ${table}(day, ${column}) VALUES (?, ?)`);
        for (const row of part.rows)
          insert.run(row.day, (row as Record<string, number | string>)[field]);
        this.replaceCoverage(category, part, request.source, now);
      }
      if (!request.dryRun) {
        this.checkCoverageCount();
        this.checkRowCount(sent);
      }
      return outcome;
    })();
    // The log lives in another database, so it is written once the rows are safely committed.
    if (!request.dryRun) this.context.event('health.import');
    return result;
  }

  // Removes the replaced range from coverage that overlaps it, keeping what lies on either side
  // with its original metadata, then adds the range the new file covers.
  private replaceCoverage(
    category: Category,
    part: {
      replaceFrom: string;
      replaceTo: string;
      coverageFrom: string | null;
      coverageTo: string | null;
    },
    source: { version: number; exportedAt: string },
    now: Date,
  ) {
    const overlapping = this.db
      .prepare(
        'SELECT from_day, to_day, source_version, exported_at, imported_at FROM health_coverage WHERE category = ? AND from_day <= ? AND to_day >= ?',
      )
      .all(category, part.replaceTo, part.replaceFrom) as Coverage[];
    this.db
      .prepare('DELETE FROM health_coverage WHERE category = ? AND from_day <= ? AND to_day >= ?')
      .run(category, part.replaceTo, part.replaceFrom);
    const insert = this.db.prepare(
      'INSERT INTO health_coverage(category, from_day, to_day, source_version, exported_at, imported_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const range of overlapping) {
      const keep = (from: string, to: string) =>
        insert.run(category, from, to, range.source_version, range.exported_at, range.imported_at);
      if (range.from_day < part.replaceFrom) keep(range.from_day, addDays(part.replaceFrom, -1));
      if (range.to_day > part.replaceTo) keep(addDays(part.replaceTo, 1), range.to_day);
    }
    if (part.coverageFrom !== null && part.coverageTo !== null)
      insert.run(
        category,
        part.coverageFrom,
        part.coverageTo,
        source.version,
        source.exportedAt,
        now.toISOString(),
      );
  }

  // A backup holds at most this many days per category, and one request can't exceed it,
  // but separate date ranges could add up past it.
  private checkRowCount(categories: Category[]) {
    for (const category of categories) {
      const { table } = CATEGORIES[category];
      const { total } = this.db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as {
        total: number;
      };
      if (total > MAX_HEALTH_ROWS)
        throw new AppError(
          409,
          'AllIn can keep at most 20,000 days in each category. Import All dates to replace what is saved.',
        );
    }
  }

  // The count covers every category together, because a backup holds this many in total.
  private checkCoverageCount() {
    const { total } = this.db.prepare('SELECT count(*) AS total FROM health_coverage').get() as {
      total: number;
    };
    if (total > MAX_COVERAGE_RANGES)
      throw new AppError(
        409,
        'AllIn is tracking too many separate date ranges. Import All dates to combine them.',
      );
  }

  summary(now: Date = new Date()): HealthSummary {
    const { timezone, weekStart } = this.context.settings();
    const today = calendarDay(now.toISOString(), timezone);
    return readStored(() => {
      const from = startOfWeek(today, weekStart);
      const to = addDays(from, 6);
      const workouts = workoutRowSchema
        .array()
        .parse(
          this.db
            .prepare('SELECT day, workouts FROM workout_days WHERE day BETWEEN ? AND ?')
            .all(from, to) as { day: string; workouts: number }[],
        );
      const recent = workoutRowSchema
        .array()
        .parse(
          this.db
            .prepare('SELECT day, workouts FROM workout_days ORDER BY day DESC LIMIT 10')
            .all(),
        );
      const weights = weightRowSchema
        .array()
        .parse(
          (
            this.db
              .prepare('SELECT day, weight_kg FROM weight_days WHERE day >= ? ORDER BY day')
              .all(addDays(today, -364)) as { day: string; weight_kg: number }[]
          ).map((row) => ({ day: row.day, weightKg: row.weight_kg })),
        );
      const coverage = (
        this.db
          .prepare(
            'SELECT category, from_day, to_day, exported_at, imported_at FROM health_coverage ORDER BY category, from_day',
          )
          .all() as (Coverage & { category: Category })[]
      ).map((row) => ({
        category: row.category,
        from: row.from_day,
        to: row.to_day,
        exportedAt: exportedAtSchema.parse(row.exported_at),
        importedAt: exportedAtSchema.parse(row.imported_at),
      }));
      const goalRow = this.db.prepare('SELECT workout_goal FROM health_settings LIMIT 1').get() as
        { workout_goal: number | null } | undefined;
      const { workoutGoal } = healthGoalSchema.parse({
        workoutGoal: goalRow?.workout_goal ?? null,
      });

      const counts = new Map(workouts.map((row) => [row.day, row.workouts]));
      const covered = coverage.filter((range) => range.category === 'workouts');
      // A row wins, then a day after today, then recorded rest inside coverage, then no data.
      // A row dated after today still shows and counts: it exists when OpenFit's host runs ahead.
      const statusOf = (day: string): DayStatus =>
        counts.has(day)
          ? 'workout'
          : day > today
            ? 'upcoming'
            : covered.some((range) => range.from <= day && day <= range.to)
              ? 'none'
              : 'missing';
      const days = Array.from({ length: 7 }, (_, i) => {
        const day = addDays(from, i);
        return { day, status: statusOf(day), count: counts.get(day) ?? 0 };
      });
      const newest = (pick: (range: (typeof coverage)[number]) => string) =>
        coverage
          .map(pick)
          .reduce<string | null>(
            (best, value) => (best === null || Date.parse(value) > Date.parse(best) ? value : best),
            null,
          );
      const exportedAt = newest((range) => range.exportedAt);
      return {
        state: coverage.length > 0 ? 'imported' : 'empty',
        workoutGoal,
        week: { from, to, completed: days.reduce((sum, d) => sum + d.count, 0), days },
        recentWorkoutDays: recent.map(({ day, workouts }) => ({ day, count: workouts })),
        weights,
        coverage: coverage.map(({ category, from, to }) => ({ category, from, to })),
        exportedAt,
        importedAt: newest((range) => range.importedAt),
        exportAgeDays:
          exportedAt === null
            ? null
            : Math.max(0, daysBetween(calendarDay(exportedAt, timezone), today)),
      };
    });
  }

  // Everything Health holds, in the shape a backup stores it.
  backupData(): HealthBackup {
    return readStored(() => {
      const goalRow = this.db.prepare('SELECT workout_goal FROM health_settings LIMIT 1').get() as
        { workout_goal: number | null } | undefined;
      return healthBackupSchema.parse({
        workouts: this.db.prepare('SELECT day, workouts FROM workout_days ORDER BY day').all(),
        weights: (
          this.db.prepare('SELECT day, weight_kg FROM weight_days ORDER BY day').all() as {
            day: string;
            weight_kg: number;
          }[]
        ).map((row) => ({ day: row.day, weightKg: row.weight_kg })),
        coverage: (
          this.db
            .prepare(
              'SELECT category, from_day, to_day, source_version, exported_at, imported_at FROM health_coverage ORDER BY category, from_day',
            )
            .all() as (Coverage & { category: Category })[]
        ).map((row) => ({
          category: row.category,
          from: row.from_day,
          to: row.to_day,
          sourceVersion: row.source_version,
          exportedAt: row.exported_at,
          importedAt: row.imported_at,
        })),
        workoutGoal: goalRow?.workout_goal ?? null,
      });
    });
  }

  // Fills an empty Health database from a validated backup. Restore is logged by Vault.setup.
  restore(data: HealthBackup) {
    this.db.transaction(() => {
      const workouts = this.db.prepare('INSERT INTO workout_days(day, workouts) VALUES (?, ?)');
      for (const row of data.workouts) workouts.run(row.day, row.workouts);
      const weights = this.db.prepare('INSERT INTO weight_days(day, weight_kg) VALUES (?, ?)');
      for (const row of data.weights) weights.run(row.day, row.weightKg);
      const coverage = this.db.prepare(
        'INSERT INTO health_coverage(category, from_day, to_day, source_version, exported_at, imported_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const range of data.coverage)
        coverage.run(
          range.category,
          range.from,
          range.to,
          range.sourceVersion,
          range.exportedAt,
          range.importedAt,
        );
      if (data.workoutGoal !== null)
        this.db
          .prepare('INSERT INTO health_settings(workout_goal) VALUES (?)')
          .run(data.workoutGoal);
    })();
  }

  setGoal(input: unknown): { workoutGoal: number | null } {
    const { workoutGoal } = healthGoalSchema.parse(input);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM health_settings').run();
      this.db.prepare('INSERT INTO health_settings(workout_goal) VALUES (?)').run(workoutGoal);
    })();
    this.context.event('health.goal');
    return { workoutGoal };
  }

  // Deletes every Health row, the goal included. secure_delete is already on for this database.
  purge() {
    this.db.transaction(() => {
      for (const table of ['workout_days', 'weight_days', 'health_coverage', 'health_settings'])
        this.db.prepare(`DELETE FROM ${table}`).run();
    })();
    this.context.event('health.purge');
  }
}
