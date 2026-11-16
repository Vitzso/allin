import { z } from 'zod';
export const MAX_BACKUP_BYTES = 24_000_000;
export const MAX_TASKS = 10_000;

export const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v),
    'Invalid calendar day',
  );
export const taskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    project: z.enum(['Personal', 'Work', 'Wellbeing', 'Learning']).default('Personal'),
    priority: z.enum(['high', 'medium', 'low']).default('medium'),
    estimate: z.number().int().min(5).max(480).nullable().default(null),
    dueDay: daySchema.nullable().default(null),
    scheduledAt: z.string().datetime().nullable().default(null),
    recurring: z.enum(['none', 'daily', 'weekly']).default('none'),
    actual: z.number().int().min(0).max(1440).nullable().default(null),
    status: z.enum(['open', 'done']).default('open'),
  })
  .strict();
export const taskSchema = taskInputSchema
  .extend({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();
export type Task = z.infer<typeof taskSchema>;
export type TaskInput = z.infer<typeof taskInputSchema>;
// Patch fields must not inherit creation defaults: omitted fields stay untouched.
export const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    project: z.enum(['Personal', 'Work', 'Wellbeing', 'Learning']),
    priority: z.enum(['high', 'medium', 'low']),
    estimate: z.number().int().min(5).max(480).nullable(),
    dueDay: daySchema.nullable(),
    scheduledAt: z.string().datetime().nullable(),
    recurring: z.enum(['none', 'daily', 'weekly']),
    actual: z.number().int().min(0).max(1440).nullable(),
    status: z.enum(['open', 'done']),
  })
  .partial()
  .strict();
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
export function calendarDay(iso: string, timezone: string) {
  let formatter = dayFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timezone, formatter);
  }
  return formatter.format(new Date(iso));
}
export const settingsSchema = z
  .object({
    timezone: z
      .string()
      .max(80)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    weekAdjustment: z.string().max(240).default(''),
    // First day of the week the adjustment applies to. Null for choices saved without a week.
    adjustmentWeek: daySchema.nullable().default(null),
    // 0 is Sunday, 6 is Saturday. Settings saved before this existed start on Monday.
    weekStart: z.number().int().min(0).max(6).default(1),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export type SessionState = {
  initialized: boolean;
  unlocked: boolean;
  csrf: string;
  keyStore: string;
  milestone: string;
};
