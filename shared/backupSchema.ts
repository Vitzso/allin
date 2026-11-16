import { z } from 'zod';
import { MAX_TASKS, settingsSchema, taskSchema } from './schema.ts';
import { healthBackupSchema } from './healthSchema.ts';

const backupFields = {
  format: z.literal('allin-data'),
  tasks: z.array(taskSchema).max(MAX_TASKS),
  settings: settingsSchema,
};
// Version 1 predates Health. Version 2 carries all of it.
export const backupDataSchema = z
  .discriminatedUnion('version', [
    z.object({ ...backupFields, version: z.literal(1) }).strict(),
    z.object({ ...backupFields, version: z.literal(2), health: healthBackupSchema }).strict(),
  ])
  .refine(
    (data) => new Set(data.tasks.map((t) => t.id)).size === data.tasks.length,
    'Duplicate task identifiers',
  );
export type BackupData = z.infer<typeof backupDataSchema>;
