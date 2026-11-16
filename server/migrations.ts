import type Database from 'better-sqlite3-multiple-ciphers';

export type Domain = 'tasks' | 'health' | 'markets';
export type Migration = (db: Database.Database) => void;
export type MigrationSet = Record<Domain, Migration[]>;

const initial: Migration = (db) => {
  db.exec(
    'CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL);',
  );
};

// Day rows an import saves, where each imported range was covered, and Health's own settings.
const healthTables: Migration = (db) => {
  db.exec(`
    CREATE TABLE workout_days (day TEXT PRIMARY KEY, workouts INTEGER NOT NULL) STRICT;
    CREATE TABLE weight_days (day TEXT PRIMARY KEY, weight_kg REAL NOT NULL) STRICT;
    CREATE TABLE health_coverage (category TEXT NOT NULL, from_day TEXT NOT NULL, to_day TEXT NOT NULL,
      source_version INTEGER NOT NULL, exported_at TEXT NOT NULL, imported_at TEXT NOT NULL) STRICT;
    CREATE TABLE health_settings (workout_goal INTEGER) STRICT;
  `);
};

// Closed bars with their revisions, the alerts the rule raised, and which feeds are on.
const marketTables: Migration = (db) => {
  db.exec(`
    CREATE TABLE market_bars (symbol TEXT NOT NULL, time TEXT NOT NULL, revision INTEGER NOT NULL,
      provider TEXT NOT NULL, venue TEXT NOT NULL, close_minor INTEGER NOT NULL, volume REAL NOT NULL,
      received_at TEXT NOT NULL, PRIMARY KEY (symbol, time, revision)) STRICT;
    CREATE TABLE market_alerts (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, time TEXT NOT NULL,
      state TEXT NOT NULL, provider TEXT NOT NULL, venue TEXT NOT NULL, close_minor INTEGER NOT NULL,
      fast REAL NOT NULL, slow REAL NOT NULL, reason TEXT NOT NULL, rule_version TEXT NOT NULL,
      alerted_at TEXT NOT NULL, dismissed_at TEXT, corrected_at TEXT) STRICT;
    CREATE TABLE feed_settings (feed TEXT PRIMARY KEY, enabled INTEGER NOT NULL,
      consented_at TEXT NOT NULL) STRICT;
  `);
};

export const MIGRATIONS: MigrationSet = {
  tasks: [initial],
  health: [initial, healthTables],
  markets: [initial, marketTables],
};

export class NewerDatabaseError extends Error {
  override name = 'NewerDatabaseError';
}
export class MigrationError extends Error {
  override name = 'MigrationError';
}

export function migrate(db: Database.Database, migrations: Migration[]) {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > migrations.length)
    throw new NewerDatabaseError(
      `Database version ${current} is newer than the ${migrations.length} this app knows.`,
    );
  for (let index = current; index < migrations.length; index++) {
    try {
      db.transaction(() => {
        migrations[index](db);
        db.pragma(`user_version = ${index + 1}`);
      })();
    } catch (error) {
      throw new MigrationError(`Migration ${index + 1} failed.`, { cause: error });
    }
  }
}
