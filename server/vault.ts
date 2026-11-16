import Database from 'better-sqlite3-multiple-ciphers';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  renameSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  taskInputSchema,
  taskPatchSchema,
  taskSchema,
  settingsSchema,
  calendarDay,
  MAX_TASKS,
  type Task,
  type TaskInput,
  type Settings,
} from '../shared/schema.ts';
import { backupDataSchema, type BackupData } from '../shared/backupSchema.ts';
import { addDays, daysBetween } from '../shared/time.ts';
import {
  derivePassword,
  domainKey,
  seal,
  unseal,
  encryptBackup,
  decryptBackup,
  envelopeSchema,
  kdfSchema,
  KDF_V1,
  KDF_V2,
  type Envelope,
  type Kdf,
} from './crypto.ts';
import type { KeyStore } from './keychain.ts';
import { AppError, readStored } from './errors.ts';
import { HealthStore } from './health.ts';
import { MarketStore } from './markets.ts';
import {
  MIGRATIONS,
  MigrationError,
  NewerDatabaseError,
  migrate,
  type Domain,
  type MigrationSet,
} from './migrations.ts';

const metadataFields = {
  id: z.string().uuid(),
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  master: envelopeSchema,
};
// Version 1 predates recorded scrypt parameters and always means KDF_V1.
const metadataSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...metadataFields }).strict(),
  z.object({ version: z.literal(2), ...metadataFields, kdf: kdfSchema }).strict(),
]);
type Metadata = z.infer<typeof metadataSchema>;
const readMetadata = (path: string) => metadataSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
// Only the three parameters reach vault.json, whatever object the caller passed in.
const copyKdf = ({ N, r, p }: Kdf): Kdf => ({ N, r, p });
const storedKdf = (metadata: Metadata) => (metadata.version === 1 ? KDF_V1 : metadata.kdf);
type CipherDB = Database.Database & { key(key: Buffer): void };
const SETUP_FILES = ['tasks.sqlite', 'health.sqlite', 'markets.sqlite', 'vault.json.tmp'];
export { AppError } from './errors.ts';

export class Vault {
  private databases: Partial<Record<Domain, CipherDB>> = {};
  private master?: Buffer;
  constructor(
    readonly directory: string,
    readonly keyStore: KeyStore,
    private readonly migrations: MigrationSet = MIGRATIONS,
    private readonly kdf: Kdf = KDF_V2,
  ) {}
  get initialized() {
    return existsSync(join(this.directory, 'vault.json'));
  }
  get unlocked() {
    return !!this.master;
  }
  // Only setup may create databases. An unlock must find them intact, so that a lost or emptied
  // file is reported as damage rather than quietly becoming an empty vault.
  private open(master: Buffer, create: boolean) {
    try {
      for (const domain of ['tasks', 'health', 'markets'] as const) {
        const path = join(this.directory, `${domain}.sqlite`);
        const db = new Database(path, { fileMustExist: !create }) as CipherDB;
        this.databases[domain] = db;
        db.pragma("cipher='sqlcipher'");
        db.pragma('legacy=4');
        const key = domainKey(master, domain);
        try {
          db.key(key);
        } finally {
          key.fill(0);
        }
        db.pragma('temp_store=MEMORY');
        db.pragma('journal_mode=DELETE');
        db.pragma('secure_delete=ON');
        if (!create) {
          const { tables } = db
            .prepare(
              "SELECT count(*) AS tables FROM sqlite_master WHERE type='table' AND name IN ('records','events')",
            )
            .get() as { tables: number };
          if (tables !== 2 || db.pragma('quick_check', { simple: true }) !== 'ok')
            throw new Error('A vault database failed its integrity check.');
        }
        migrate(db, this.migrations[domain]);
        chmodSync(path, 0o600);
      }
      this.master = master;
    } catch (error) {
      this.lock();
      master.fill(0);
      throw error;
    }
  }
  private wrappingKey(password: string, salt: Buffer, deviceSecret: string, kdf: Kdf) {
    const passwordKey = derivePassword(password, salt, kdf);
    const device = Buffer.from(deviceSecret, 'hex');
    const combined = Buffer.concat([passwordKey, device]);
    try {
      return domainKey(combined, 'device-and-password');
    } finally {
      passwordKey.fill(0);
      device.fill(0);
      combined.fill(0);
    }
  }
  setup(password: string, restore?: { backup: unknown; secret: string }) {
    if (this.initialized) throw new AppError(409, 'A vault already exists on this profile.');
    if (password.length < 12 || password.length > 256)
      throw new AppError(400, 'Use a passphrase of 12–256 characters.');
    // Existing files may be the only copy of someone's data, so setup never overwrites or deletes
    // them. This also means the failure cleanup below only removes files this call created.
    if (SETUP_FILES.some((file) => existsSync(join(this.directory, file))))
      throw new AppError(
        500,
        'Encrypted vault files already exist in this profile, but vault.json is missing. They have been left untouched. Put vault.json back if you have a copy, or move these files elsewhere before creating a vault.',
      );
    // Authenticate and validate the entire recovery payload before creating any state.
    let recovered: BackupData | undefined;
    if (restore) {
      try {
        recovered = backupDataSchema.parse(decryptBackup(restore.backup, restore.secret));
      } catch (error) {
        throw new AppError(
          400,
          'This backup could not be opened. Check the file and its recovery phrase.',
          error,
        );
      }
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const id = randomUUID(),
      salt = randomBytes(16),
      deviceSecret = randomBytes(32).toString('hex'),
      master = randomBytes(32);
    try {
      this.keyStore.set(id, deviceSecret);
      const key = this.wrappingKey(password, salt, deviceSecret, this.kdf);
      let wrapped;
      try {
        wrapped = seal(master, key, `allin-vault:${id}:v1`);
      } finally {
        key.fill(0);
      }
      this.open(master, true);
      const db = this.db('tasks');
      db.transaction(() => {
        for (const task of recovered?.tasks ?? []) this.write(task);
        this.setSettings(recovered?.settings ?? { timezone: 'Asia/Jerusalem', weekAdjustment: '' });
        this.event(restore ? 'vault.restore' : 'vault.create');
      })();
      if (recovered?.version === 2) this.health.restore(recovered.health);
      writeFileSync(
        join(this.directory, 'vault.json.tmp'),
        JSON.stringify({
          version: 2,
          id,
          salt: salt.toString('hex'),
          kdf: copyKdf(this.kdf),
          master: wrapped,
        }),
        { mode: 0o600, flag: 'wx' },
      );
      renameSync(join(this.directory, 'vault.json.tmp'), join(this.directory, 'vault.json'));
    } catch (error) {
      this.lock();
      master.fill(0);
      try {
        this.keyStore.delete(id);
      } catch {
        /* no secret logged */
      }
      for (const file of SETUP_FILES) rmSync(join(this.directory, file), { force: true });
      throw error;
    }
  }
  unlock(password: string) {
    if (!this.initialized) throw new AppError(409, 'Create a vault first.');
    let metadata: Metadata;
    try {
      metadata = readMetadata(join(this.directory, 'vault.json'));
    } catch (error) {
      throw new AppError(
        500,
        'The vault file is damaged or unreadable. Leave your files in place and restore a backup into a clean profile.',
        error,
      );
    }
    let secret: string | null;
    try {
      secret = this.keyStore.get(metadata.id);
    } catch (error) {
      throw new AppError(
        503,
        // Only the Keychain asks the owner to allow access; a server has no prompt to answer.
        this.keyStore.label === 'macOS Keychain'
          ? 'macOS Keychain did not provide the device key. Allow access to it and try again.'
          : `The key store (${this.keyStore.label}) did not provide the device key. Try again, and if it keeps happening check AllIn's log.`,
        error,
      );
    }
    if (!secret)
      throw new AppError(
        503,
        'The device key is unavailable. Restore a backup into a clean profile.',
      );
    const key = this.wrappingKey(
      password,
      Buffer.from(metadata.salt, 'hex'),
      secret,
      storedKdf(metadata),
    );
    let master: Buffer;
    try {
      master = unseal(metadata.master, key, `allin-vault:${metadata.id}:v1`);
    } catch {
      throw new AppError(401, 'Could not unlock. Check your passphrase and device key.');
    } finally {
      key.fill(0);
    }
    // From here the passphrase is known to be correct, so a failure is a problem with the files.
    this.lock();
    try {
      this.open(master, false);
      this.settings();
      this.event('vault.unlock');
    } catch (error) {
      this.lock();
      if (error instanceof NewerDatabaseError)
        throw new AppError(
          500,
          'A newer version of AllIn created this vault. Update AllIn to open it. Your data has not been changed.',
          error,
        );
      if (error instanceof MigrationError)
        throw new AppError(
          500,
          "AllIn could not upgrade your vault. Your data stays at its previous version. Try again, and if it keeps happening check AllIn's log.",
          error,
        );
      throw new AppError(
        500,
        'Your passphrase is correct, but the vault files could not be opened and may be damaged. Leave them in place and restore a backup into a clean profile.',
        error,
      );
    }
    this.upgradeKdf(password, metadata, secret, master);
  }
  // Re-wraps the master key at this build's scrypt cost. vault.json holds the only wrapped copy of
  // that key, so the new file is read back and proven to unseal the same key before it replaces the
  // old one. Any failure keeps the old vault.json; the unlock has already succeeded either way.
  private upgradeKdf(password: string, metadata: Metadata, secret: string, master: Buffer) {
    if (storedKdf(metadata).N >= this.kdf.N) return;
    const path = join(this.directory, 'vault.json'),
      temp = `${path}.tmp`;
    try {
      const salt = randomBytes(16);
      const key = this.wrappingKey(password, salt, secret, this.kdf);
      let wrapped: Envelope;
      try {
        wrapped = seal(master, key, `allin-vault:${metadata.id}:v1`);
      } finally {
        key.fill(0);
      }
      // Left by an interrupted upgrade. Not recursive: anything but a plain file stops the upgrade.
      rmSync(temp, { force: true });
      this.writeUpgradeFile(
        temp,
        JSON.stringify({
          version: 2,
          id: metadata.id,
          salt: salt.toString('hex'),
          kdf: copyKdf(this.kdf),
          master: wrapped,
        }),
      );
      this.verifyUpgradeFile(temp, metadata.id, password, secret, master);
      renameSync(temp, path);
    } catch {
      try {
        rmSync(temp, { force: true });
      } catch {
        /* the next unlock tries again */
      }
      return;
    }
    // The new vault.json is in place, so neither of these may fail the unlock.
    try {
      syncDirectory(this.directory);
    } catch {
      /* the rename itself succeeded */
    }
    try {
      this.event('vault.kdf-upgrade');
    } catch {
      /* the upgrade is recorded in vault.json itself */
    }
  }
  // Separate so a test can make the bytes on disk differ from what was meant.
  protected writeUpgradeFile(path: string, text: string) {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  // Uses only what was read back from disk, plus the passphrase and device key.
  private verifyUpgradeFile(
    path: string,
    id: string,
    password: string,
    secret: string,
    master: Buffer,
  ) {
    const written = readMetadata(path);
    if (written.id !== id) throw new Error('The rewritten vault file names another vault.');
    if (
      written.version !== 2 ||
      written.kdf.N !== this.kdf.N ||
      written.kdf.r !== this.kdf.r ||
      written.kdf.p !== this.kdf.p
    )
      throw new Error('The rewritten vault file records other scrypt parameters.');
    const key = this.wrappingKey(
      password,
      Buffer.from(written.salt, 'hex'),
      secret,
      storedKdf(written),
    );
    let copy: Buffer | undefined;
    try {
      copy = unseal(written.master, key, `allin-vault:${written.id}:v1`);
      if (copy.length !== master.length || !timingSafeEqual(copy, master))
        throw new Error('The rewritten vault file holds another key.');
    } finally {
      key.fill(0);
      copy?.fill(0);
    }
  }
  lock() {
    for (const db of Object.values(this.databases)) if (db.open) db.close();
    this.databases = {};
    this.master?.fill(0);
    this.master = undefined;
  }
  private db(domain: Domain) {
    const db = this.databases[domain];
    if (!db || !this.unlocked) throw new AppError(401, 'Unlock your vault to continue.');
    return db;
  }
  get health() {
    return new HealthStore(this.db('health'), {
      settings: () => this.settings(),
      event: (action) => this.event(action),
    });
  }
  get markets() {
    return new MarketStore(this.db('markets'), { event: (action) => this.event(action) });
  }
  // From vault.json, so it is readable while locked.
  get id(): string {
    try {
      return readMetadata(join(this.directory, 'vault.json')).id;
    } catch (error) {
      throw new AppError(
        500,
        'The vault file is damaged or unreadable. Leave your files in place and restore a backup into a clean profile.',
        error,
      );
    }
  }
  private write(task: Task) {
    this.db('tasks')
      .prepare('INSERT OR REPLACE INTO records(id,data) VALUES (?,?)')
      .run(task.id, JSON.stringify(task));
  }
  tasks(): Task[] {
    return readStored(() =>
      (
        this.db('tasks')
          .prepare("SELECT data FROM records WHERE id != 'settings' ORDER BY rowid DESC")
          .all() as { data: string }[]
      ).map((r) => taskSchema.parse(JSON.parse(r.data))),
    );
  }
  createTask(input: unknown, id: string = randomUUID()) {
    const data = taskInputSchema.parse(input);
    const task: Task = {
      ...data,
      id: z.string().uuid().parse(id),
      version: 1,
      createdAt: new Date().toISOString(),
      completedAt: data.status === 'done' ? new Date().toISOString() : null,
    };
    const existing = this.tasks().find((t) => t.id === id);
    if (existing) {
      if (JSON.stringify(taskInputSchema.parse(existingInput(existing))) !== JSON.stringify(data))
        throw new AppError(409, 'This capture was already used for another task.');
      return existing;
    }
    if (this.tasks().length >= MAX_TASKS)
      throw new AppError(
        409,
        'This foundation vault supports up to 10,000 tasks. Export a backup before removing older tasks.',
      );
    this.db('tasks').transaction(() => {
      this.write(task);
      this.event('task.create');
    })();
    return task;
  }
  updateTask(id: string, version: number, changes: unknown) {
    const parsed = taskPatchSchema.parse(changes);
    return this.db('tasks').transaction(() => {
      const current = this.tasks().find((t) => t.id === id);
      if (!current) throw new AppError(404, 'Task not found.');
      if (current.version !== version)
        throw new AppError(409, 'This task changed. Refresh and review its latest version.');
      const now = new Date().toISOString();
      const updated: Task = {
        ...current,
        ...parsed,
        version: current.version + 1,
        completedAt:
          parsed.status === 'done'
            ? (current.completedAt ?? now)
            : parsed.status === 'open'
              ? null
              : current.completedAt,
      };
      this.write(updated);
      if (parsed.status === 'done' && current.status !== 'done' && current.recurring !== 'none') {
        // Each occurrence has one successor, whichever day it is completed on.
        const hash = createHash('sha256').update(`${current.id}:next`).digest('hex');
        const nextId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        const dueDay = this.nextDueDay(current, now);
        if (dueDay && !this.tasks().some((task) => task.id === nextId))
          this.createTask(
            {
              ...existingInput(current),
              status: 'open',
              dueDay,
              scheduledAt: null,
              actual: null,
            },
            nextId,
          );
      }
      this.event('task.update');
      return updated;
    })();
  }
  // The first day on the task's cadence that is after both its due day and today, so finishing an
  // overdue task doesn't leave another one already overdue. Null past the last date a task can hold.
  private nextDueDay(task: Task, completedAt: string) {
    const today = calendarDay(completedAt, this.settings().timezone);
    const from = task.dueDay ?? today;
    const step = task.recurring === 'daily' ? 1 : 7;
    const stepsBehind = Math.floor(Math.max(0, daysBetween(from, today)) / step);
    const days = (stepsBehind + 1) * step;
    return days > daysBetween(from, '9999-12-31') ? null : addDays(from, days);
  }
  deleteTask(id: string, version: number) {
    const current = this.tasks().find((t) => t.id === id);
    if (!current) throw new AppError(404, 'Task not found.');
    if (current.version !== version)
      throw new AppError(409, 'This task changed. Refresh and review it.');
    this.db('tasks').transaction(() => {
      this.db('tasks').prepare('DELETE FROM records WHERE id=?').run(id);
      this.event('task.delete');
    })();
  }
  settings(): Settings {
    return readStored(() => {
      const row = this.db('tasks')
        .prepare("SELECT data FROM records WHERE id='settings'")
        .get() as { data: string };
      return settingsSchema.parse(JSON.parse(row.data));
    });
  }
  setSettings(value: unknown) {
    const settings = settingsSchema.parse(value);
    this.db('tasks')
      .prepare("INSERT OR REPLACE INTO records(id,data) VALUES ('settings',?)")
      .run(JSON.stringify(settings));
    return settings;
  }
  event(action: string) {
    this.db('tasks')
      .prepare('INSERT INTO events(at,action,outcome) VALUES (?,?,?)')
      .run(new Date().toISOString(), action, 'success');
    this.db('tasks').exec(
      'DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 100)',
    );
  }
  events() {
    return this.db('tasks')
      .prepare('SELECT at,action,outcome FROM events ORDER BY id DESC LIMIT 25')
      .all();
  }
  export(secret: string) {
    const data = backupDataSchema.parse({
      format: 'allin-data',
      version: 2,
      tasks: this.tasks(),
      settings: this.settings(),
      health: this.health.backupData(),
    });
    const encrypted = encryptBackup(data, secret, this.kdf);
    this.event('vault.export');
    return encrypted;
  }
}
// Makes a rename durable, as the file's own fsync does not cover the directory entry.
function syncDirectory(directory: string) {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function existingInput(task: Task): TaskInput {
  const {
    id: _id,
    version: _version,
    createdAt: _created,
    completedAt: _completed,
    ...input
  } = task;
  return input;
}
