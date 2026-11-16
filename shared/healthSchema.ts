import { z } from 'zod';
import { daySchema } from './schema.ts';

export const MAX_HEALTH_ROWS = 20_000;
export const MAX_WORKOUTS_PER_DAY = 100;
export const MAX_WEIGHT_KG = 1000;
export const MAX_COVERAGE_RANGES = 1000;
export const EARLIEST_DAY = '0001-01-01';

const healthDaySchema = daySchema.refine((day) => day >= EARLIEST_DAY, 'Day is too early');

export const workoutRowSchema = z
  .object({
    day: healthDaySchema,
    workouts: z.number().int().min(1).max(MAX_WORKOUTS_PER_DAY),
  })
  .strict();
export const weightRowSchema = z
  .object({
    day: healthDaySchema,
    weightKg: z.number().gt(0).max(MAX_WEIGHT_KG),
  })
  .strict();
export type WorkoutRow = z.infer<typeof workoutRowSchema>;
export type WeightRow = z.infer<typeof weightRowSchema>;

// A hostile file could carry megabytes of fractional-second digits, so the length is capped.
export const exportedAtSchema = z.string().datetime().max(64);

const categoryPart = <Row extends z.ZodType<{ day: string }>>(row: Row) =>
  z
    .object({
      replaceFrom: healthDaySchema,
      replaceTo: healthDaySchema,
      coverageFrom: healthDaySchema.nullable(),
      coverageTo: healthDaySchema.nullable(),
      rows: z.array(row).max(MAX_HEALTH_ROWS),
    })
    .strict()
    .superRefine((part, ctx) => {
      const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
      if (part.replaceFrom > part.replaceTo) return fail('The replace range is backwards');
      const { coverageFrom: from, coverageTo: to } = part;
      if ((from === null) !== (to === null)) return fail('Coverage needs both ends or neither');
      if (from !== null && to !== null) {
        if (from > to) return fail('The coverage range is backwards');
        if (from < part.replaceFrom || to > part.replaceTo)
          return fail('Coverage is outside the replace range');
      }
      const days = new Set<string>();
      for (const { day } of part.rows) {
        if (day < part.replaceFrom || day > part.replaceTo)
          return fail('A row is outside the replace range');
        if (from === null || to === null || day < from || day > to)
          return fail('A row is outside the coverage range');
        if (days.has(day)) return fail('Two rows share a day');
        days.add(day);
      }
    });

export const healthImportSchema = z
  .object({
    // Never defaulted: a request missing either flag must not write.
    dryRun: z.boolean(),
    confirmOlder: z.boolean(),
    source: z
      .object({ app: z.literal('openfit'), version: z.literal(1), exportedAt: exportedAtSchema })
      .strict(),
    workouts: categoryPart(workoutRowSchema).optional(),
    weight: categoryPart(weightRowSchema).optional(),
  })
  .strict()
  .refine((request) => request.workouts !== undefined || request.weight !== undefined, {
    message: 'Choose at least one category',
  });
const uniqueDays = (rows: { day: string }[]) =>
  new Set(rows.map((row) => row.day)).size === rows.length;

// A backup's whole Health state. Times use exportedAtSchema so a restored backup can't carry a
// value the older-file check and the summary would treat as damage.
export const healthBackupSchema = z
  .object({
    workouts: z
      .array(workoutRowSchema)
      .max(MAX_HEALTH_ROWS)
      .refine(uniqueDays, 'Two rows share a day'),
    weights: z
      .array(weightRowSchema)
      .max(MAX_HEALTH_ROWS)
      .refine(uniqueDays, 'Two rows share a day'),
    coverage: z
      .array(
        z
          .object({
            category: z.enum(['workouts', 'weight']),
            from: healthDaySchema,
            to: healthDaySchema,
            sourceVersion: z.literal(1),
            exportedAt: exportedAtSchema,
            importedAt: exportedAtSchema,
          })
          .strict()
          .refine((range) => range.from <= range.to, 'The coverage range is backwards'),
      )
      .max(MAX_COVERAGE_RANGES),
    workoutGoal: z.number().int().min(1).max(14).nullable(),
  })
  .strict();
export type HealthBackup = z.infer<typeof healthBackupSchema>;

export type HealthImportRequest = z.infer<typeof healthImportSchema>;

export type ChangeCounts = { added: number; changed: number; removed: number; unchanged: number };
export type HealthImportResult = { older: boolean; workouts?: ChangeCounts; weight?: ChangeCounts };

export const healthGoalSchema = z
  .object({ workoutGoal: z.number().int().min(1).max(14).nullable() })
  .strict();

export type DayStatus = 'workout' | 'none' | 'missing' | 'upcoming';
export type HealthSummary = {
  state: 'empty' | 'imported';
  workoutGoal: number | null;
  week: {
    from: string;
    to: string;
    completed: number;
    days: { day: string; status: DayStatus; count: number }[];
  };
  recentWorkoutDays: { day: string; count: number }[];
  weights: WeightRow[];
  coverage: { category: 'workouts' | 'weight'; from: string; to: string }[];
  exportedAt: string | null;
  importedAt: string | null;
  exportAgeDays: number | null;
};
