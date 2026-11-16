import { z } from 'zod';
import { calendarDay, daySchema } from './schema.ts';
import { addDays } from './time.ts';
import {
  EARLIEST_DAY,
  MAX_HEALTH_ROWS,
  exportedAtSchema,
  MAX_WORKOUTS_PER_DAY,
  weightRowSchema,
  workoutRowSchema,
  type HealthImportRequest,
  type WeightRow,
  type WorkoutRow,
} from './healthSchema.ts';

export const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
export const TOO_LARGE_MESSAGE = 'This file is over 100 MB, which is more than AllIn can read.';

export type OpenFitRejection = {
  ok: false;
  reason: 'not-openfit' | 'unsupported-format' | 'invalid-entries';
  message: string;
};
/** First and last entry day. Includes workouts that were skipped. */
export type EntrySpan = { first: string; last: string } | null;
export type OpenFitExport = {
  ok: true;
  source: { app: 'openfit'; version: 1; exportedAt: string };
  exportDay: string;
  fileWeekStart: number | null;
  workouts: WorkoutRow[];
  skippedWorkouts: number;
  workoutSpan: EntrySpan;
  weights: WeightRow[];
  weightSpan: EntrySpan;
  discarded: {
    coachMessages: number;
    foodEntries: number;
    foodProducts: number;
    exercises: number;
    workoutNotes: number;
    workoutSets: number;
    profileSettings: number;
  };
};

/** An export time further ahead of the clock than this is refused. */
const MAX_EXPORT_AHEAD_MS = 24 * 60 * 60 * 1000;
const NO_EXPORT_TIME = 'This OpenFit export has no valid export time.';
const NOT_OPENFIT = 'This file isn’t an OpenFit export.';
const reject = (reason: OpenFitRejection['reason'], message: string): OpenFitRejection => ({
  ok: false,
  reason,
  message,
});
const invalid = (message: string) => reject('invalid-entries', message);

// Zod objects here are not strict, so unknown fields are dropped.
const setSchema = z.object({ kind: z.string().optional() });
const workoutSchema = z.object({
  day: workoutRowSchema.shape.day,
  sets: z.array(setSchema),
  notes: z.unknown().optional(),
});
const bodyWeightSchema = z.object({
  day: weightRowSchema.shape.day,
  weightKg: weightRowSchema.shape.weightKg,
});

const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
const span = (days: string[]): EntrySpan =>
  days.length === 0
    ? null
    : {
        first: days.reduce((a, b) => (b < a ? b : a)),
        last: days.reduce((a, b) => (b > a ? b : a)),
      };

/**
 * Reads an OpenFit export. The text is hostile input: messages are fixed strings and never repeat
 * file contents, and only derived day rows leave this function.
 */
export function parseOpenFitExport(
  text: string,
  options: { timezone: string; now?: Date },
): OpenFitExport | OpenFitRejection {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return reject('not-openfit', NOT_OPENFIT);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return reject('not-openfit', NOT_OPENFIT);
  const file = data as Record<string, unknown>;
  if (file.app !== 'openfit') return reject('not-openfit', NOT_OPENFIT);
  if (file.version !== 1)
    return reject('unsupported-format', 'This OpenFit export is a format AllIn doesn’t read yet.');
  if (file.units !== 'weights in kg')
    return reject('unsupported-format', 'This OpenFit export doesn’t store weights in kilograms.');
  const exportedAt = exportedAtSchema.safeParse(file.exportedAt);
  if (!exportedAt.success) return reject('unsupported-format', NO_EXPORT_TIME);

  // Coverage follows the export time, so one far ahead would hold a range only Purge could clear.
  const now = options.now ?? new Date();
  if (Date.parse(exportedAt.data) > now.getTime() + MAX_EXPORT_AHEAD_MS)
    return reject('unsupported-format', NO_EXPORT_TIME);

  const exportDay = calendarDay(exportedAt.data, options.timezone);
  if (!daySchema.safeParse(exportDay).success || exportDay < EARLIEST_DAY)
    return reject('unsupported-format', NO_EXPORT_TIME);
  let lastAllowedDay = exportDay;
  try {
    lastAllowedDay = addDays(exportDay, 1);
  } catch {
    // Past the supported calendar: no later day is allowed.
  }
  const afterExport = (day: string) => day > lastAllowedDay;

  const workoutsParsed = z.array(workoutSchema).safeParse(file.workouts);
  if (!workoutsParsed.success)
    return invalid('The workouts in this file are missing or have an invalid day or sets.');
  const weightsParsed = z.array(bodyWeightSchema).safeParse(file.bodyWeights);
  if (!weightsParsed.success)
    return invalid('The body weights in this file are missing or have an invalid day or weight.');

  const counted = new Map<string, number>();
  const workoutDays: string[] = [];
  let skippedWorkouts = 0;
  let workoutSets = 0;
  let workoutNotes = 0;
  for (const workout of workoutsParsed.data) {
    if (afterExport(workout.day))
      return invalid('This file has a workout dated after its export day.');
    workoutDays.push(workout.day);
    workoutSets += workout.sets.length;
    if (typeof workout.notes === 'string' && workout.notes !== '') workoutNotes += 1;
    if (workout.sets.some((set) => set.kind !== 'warmup'))
      counted.set(workout.day, (counted.get(workout.day) ?? 0) + 1);
    else skippedWorkouts += 1;
  }
  for (const n of counted.values())
    if (n > MAX_WORKOUTS_PER_DAY)
      return invalid(`This file has more than ${MAX_WORKOUTS_PER_DAY} workouts on one day.`);
  if (counted.size > MAX_HEALTH_ROWS)
    return invalid('This file has workouts on more than 20,000 days.');

  const seen = new Set<string>();
  for (const row of weightsParsed.data) {
    if (afterExport(row.day))
      return invalid('This file has a body weight dated after its export day.');
    if (seen.has(row.day)) return invalid('This file has two body weights on the same day.');
    seen.add(row.day);
  }
  if (seen.size > MAX_HEALTH_ROWS)
    return invalid('This file has body weights on more than 20,000 days.');

  const settings = Array.isArray(file.settings) ? (file.settings[0] as unknown) : undefined;
  const weekStart =
    typeof settings === 'object' && settings !== null
      ? (settings as Record<string, unknown>).weekStart
      : undefined;
  const fileWeekStart =
    typeof weekStart === 'number' && Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6
      ? weekStart
      : null;

  return {
    ok: true,
    source: { app: 'openfit', version: 1, exportedAt: exportedAt.data },
    exportDay,
    fileWeekStart,
    workouts: [...counted]
      .map(([day, workouts]) => ({ day, workouts }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
    skippedWorkouts,
    workoutSpan: span(workoutDays),
    weights: weightsParsed.data
      .map(({ day, weightKg }) => ({ day, weightKg }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
    weightSpan: span([...seen]),
    discarded: {
      coachMessages: count(file.coachMessages),
      foodEntries: count(file.foodEntries),
      foodProducts: count(file.foodProducts),
      exercises: count(file.exercises),
      workoutNotes,
      workoutSets,
      profileSettings: count(file.settings),
    },
  };
}

export type ImportSelection = {
  workouts: boolean;
  weight: boolean;
  range: 'all' | { from: string; to: string };
};

/** One category's replace range, coverage, and the rows inside the range. */
function part<Row extends { day: string }>(
  rows: Row[],
  entrySpan: EntrySpan,
  exportDay: string,
  range: ImportSelection['range'],
) {
  const lastCovered = entrySpan && entrySpan.last > exportDay ? entrySpan.last : exportDay;
  const replaceFrom = range === 'all' ? EARLIEST_DAY : range.from;
  const replaceTo = range === 'all' ? lastCovered : range.to;
  const start = entrySpan && entrySpan.first > replaceFrom ? entrySpan.first : replaceFrom;
  const end = lastCovered < replaceTo ? lastCovered : replaceTo;
  const covered = entrySpan !== null && start <= end;
  return {
    replaceFrom,
    replaceTo,
    coverageFrom: covered ? start : null,
    coverageTo: covered ? end : null,
    rows: rows.filter((row) => row.day >= replaceFrom && row.day <= replaceTo),
  };
}

/** The request body for the chosen categories and dates. It holds only derived day rows. */
export function buildImportRequest(
  parsed: OpenFitExport,
  selection: ImportSelection,
): Omit<HealthImportRequest, 'dryRun' | 'confirmOlder'> {
  return {
    source: parsed.source,
    ...(selection.workouts && {
      workouts: part(parsed.workouts, parsed.workoutSpan, parsed.exportDay, selection.range),
    }),
    ...(selection.weight && {
      weight: part(parsed.weights, parsed.weightSpan, parsed.exportDay, selection.range),
    }),
  };
}

export type KeptCategory = {
  category: 'workouts' | 'weight';
  days: number;
  first: string | null;
  last: string | null;
};

/**
 * What a save keeps for each selected category. It reads the request itself, so what the preview
 * says and what is sent cannot differ.
 */
export function keptSummary(parsed: OpenFitExport, selection: ImportSelection): KeptCategory[] {
  const request = buildImportRequest(parsed, selection);
  return (['workouts', 'weight'] as const).flatMap((category) => {
    const part = request[category];
    if (!part) return [];
    const days = part.rows.map((row) => row.day).sort();
    return [{ category, days: days.length, first: days[0] ?? null, last: days.at(-1) ?? null }];
  });
}
