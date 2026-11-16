import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { Domain } from '../server/migrations.ts';
import type { KeyStore } from '../server/keychain.ts';
import { Vault } from '../server/vault.ts';
import { MIGRATIONS } from '../server/migrations.ts';
import { KDF_V1 } from '../server/crypto.ts';
import { buildImportRequest, parseOpenFitExport, type ImportSelection } from '../shared/openfit.ts';
import type { HealthImportRequest } from '../shared/healthSchema.ts';
export class MemoryKeyStore implements KeyStore {
  label = 'Test-only ephemeral key store';
  private entries = new Map<string, string>();
  get(id: string) {
    return this.entries.get(id) ?? null;
  }
  set(id: string, secret: string) {
    this.entries.set(id, secret);
  }
  delete(id: string) {
    this.entries.delete(id);
  }
}
export function profile() {
  const directory = mkdtempSync(join(tmpdir(), 'allin-test-'));
  const keys = new MemoryKeyStore();
  // KDF_V1 keeps the suite fast; tests/kdf.test.ts covers the stronger default.
  const vault = new Vault(directory, keys, MIGRATIONS, KDF_V1);
  return {
    directory,
    keys,
    vault,
    cleanup() {
      vault.lock();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export const password = 'synthetic test passphrase 123';
export const recovery = 'separate synthetic recovery secret 456';

const preM1Fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault-pre-m1');
// A copy of the committed vault made before migrations existed, with its device key loaded.
export function preM1Profile(): ReturnType<typeof profile> {
  const p = profile();
  for (const file of ['vault.json', 'tasks.sqlite', 'health.sqlite', 'markets.sqlite'])
    cpSync(join(preM1Fixture, file), join(p.directory, file));
  const { id, secret } = JSON.parse(readFileSync(join(preM1Fixture, 'device-secret.json'), 'utf8'));
  p.keys.set(id, secret);
  return p;
}
// The unlocked database, reached past the Vault's private API.
export const domainDb = (vault: Vault, domain: Domain) =>
  (vault as unknown as { db(domain: Domain): Database.Database }).db(domain);
export const userVersion = (vault: Vault, domain: Domain) =>
  domainDb(vault, domain).pragma('user_version', { simple: true }) as number;

const openFitFixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openfit-0.1.11.json'),
  'utf8',
);
const TEST_NOW = new Date('2040-01-01T00:00:00Z');
// A request built from the OpenFit fixture, parsed in UTC. Defaults: both categories, all dates, no dry run.
export function importRequest(
  options: {
    edit?: (data: any) => void;
    exportedAt?: string;
    range?: ImportSelection['range'];
    workouts?: boolean;
    weight?: boolean;
    dryRun?: boolean;
    confirmOlder?: boolean;
  } = {},
): HealthImportRequest {
  const data = JSON.parse(openFitFixture);
  if (options.exportedAt !== undefined) data.exportedAt = options.exportedAt;
  options.edit?.(data);
  // A fixed clock, years past every date the tests use, so these requests never depend on today.
  const parsed = parseOpenFitExport(JSON.stringify(data), { timezone: 'UTC', now: TEST_NOW });
  if (!parsed.ok) throw new Error(`importRequest: the fixture was rejected (${parsed.reason})`);
  return {
    ...buildImportRequest(parsed, {
      workouts: options.workouts ?? true,
      weight: options.weight ?? true,
      range: options.range ?? 'all',
    }),
    dryRun: options.dryRun ?? false,
    confirmOlder: options.confirmOlder ?? false,
  };
}

// Every row of the four Health tables, in a stable order, for comparing before and after.
export const dumpHealth = (vault: Vault): Record<string, unknown[]> => {
  const db = domainDb(vault, 'health');
  return {
    workout_days: db.prepare('SELECT * FROM workout_days ORDER BY day').all(),
    weight_days: db.prepare('SELECT * FROM weight_days ORDER BY day').all(),
    health_coverage: db
      .prepare('SELECT * FROM health_coverage ORDER BY category, from_day, to_day')
      .all(),
    health_settings: db.prepare('SELECT * FROM health_settings ORDER BY rowid').all(),
  };
};

// Every row of the three market tables, in a stable order, for comparing before and after.
export const dumpMarkets = (vault: Vault): Record<string, unknown[]> => {
  const db = domainDb(vault, 'markets');
  return {
    market_bars: db.prepare('SELECT * FROM market_bars ORDER BY symbol, time, revision').all(),
    market_alerts: db.prepare('SELECT * FROM market_alerts ORDER BY rowid').all(),
    feed_settings: db.prepare('SELECT * FROM feed_settings ORDER BY feed').all(),
  };
};
