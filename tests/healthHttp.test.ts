import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addDays } from '../shared/time.ts';
import { domainDb, importRequest } from './helpers.ts';
import { setup } from './httpHelpers.ts';

const LATER = '2026-11-07T18:00:00.000Z';
const REFUSED = 'Check the fields and supported file format.';

async function withApp(run: (app: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const app = await setup();
  try {
    await app.login();
    await run(app);
  } finally {
    await app.close();
  }
}
const summary = async (app: Awaited<ReturnType<typeof setup>>) =>
  (await app.call('/health/summary')).json();
const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
  );

test('health routes refuse locked and tokenless requests', async () => {
  const app = await setup();
  try {
    assert.equal((await app.call('/health/summary')).status, 401);
    await app.login();
    assert.equal((await app.call('/health/summary')).status, 200);
    for (const path of ['/health/import', '/health/purge', '/health/goal'])
      assert.equal(
        (await app.call(path, 'POST', importRequest(), { 'X-AllIn-CSRF': 'wrong' })).status,
        403,
      );
    assert.equal((await app.call('/health/summary', 'GET', undefined, { Cookie: '' })).status, 401);
    await app.call('/vault/lock', 'POST', {});
    assert.equal((await app.call('/health/summary')).status, 401);
    assert.equal((await app.call('/health/import', 'POST', importRequest())).status, 401);
  } finally {
    await app.close();
  }
});

test('M1: importing a supported file twice creates no duplicates', () =>
  withApp(async (app) => {
    const dry = await app.call('/health/import', 'POST', importRequest({ dryRun: true }));
    assert.equal(dry.status, 200);
    assert.equal((await dry.json()).workouts.added, 4);
    assert.equal((await summary(app)).state, 'empty');
    const saved = await app.call('/health/import', 'POST', importRequest());
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).workouts.added, 4);
    const again = await app.call('/health/import', 'POST', importRequest());
    assert.equal(again.status, 200);
    const result = await again.json();
    assert.equal(result.workouts.added, 0);
    assert.equal(result.workouts.unchanged, 4);
    assert.equal((await summary(app)).state, 'imported');
    assert.equal(
      domainDb(app.p.vault, 'health').prepare('SELECT count(*) n FROM workout_days').get()![
        'n' as never
      ],
      4,
    );
  }));

test('M1: a corrected snapshot replaces rows and deleted entries disappear', () =>
  withApp(async (app) => {
    await app.call('/health/import', 'POST', importRequest());
    const response = await app.call(
      '/health/import',
      'POST',
      importRequest({
        exportedAt: LATER,
        edit: (d) => {
          d.bodyWeights.find((w: any) => w.day === '2026-11-05').weightKg = 76.0;
          d.workouts = d.workouts.filter((w: any) => w.day !== '2026-11-04');
        },
      }),
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.weight, { added: 0, changed: 1, removed: 0, unchanged: 2 });
    assert.deepEqual(result.workouts, { added: 0, changed: 0, removed: 1, unchanged: 3 });
    const after = await summary(app);
    assert.equal(after.weights.find((w: any) => w.day === '2026-11-05').weightKg, 76);
    assert.equal(
      after.recentWorkoutDays.some((d: any) => d.day === '2026-11-04'),
      false,
    );
  }));

test('M1: an unsupported or malformed request leaves prior data intact', () =>
  withApp(async (app) => {
    await app.call('/health/import', 'POST', importRequest());
    const before = await summary(app);
    const bad = [
      { ...importRequest(), unknownField: true },
      (() => {
        const r = importRequest();
        r.workouts!.rows[0].day = '2030-01-01';
        return r;
      })(),
      { ...importRequest(), workouts: undefined, weight: undefined },
    ];
    for (const request of bad) {
      const response = await app.call('/health/import', 'POST', request);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, REFUSED);
      assert.deepEqual(await summary(app), before);
    }
    assert.deepEqual(app.logs, []);
  }));

// Every row of every table in all three databases must be free of the marker.
function assertNoMarker(app: Awaited<ReturnType<typeof setup>>) {
  const db = (domain: 'tasks' | 'health' | 'markets') => domainDb(app.p.vault, domain);
  for (const domain of ['tasks', 'health', 'markets'] as const) {
    const tables = db(domain)
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const { name } of tables)
      assert.doesNotMatch(
        JSON.stringify(db(domain).prepare(`SELECT * FROM "${name}"`).all()),
        /PRIVATE-MARKER/,
        `${domain}.${name}`,
      );
  }
  assert.doesNotMatch(app.logs.join('\n'), /PRIVATE-MARKER/);
}

test('M1: unselected fields are absent from the vault and logs', () =>
  withApp(async (app) => {
    const request = importRequest();
    assert.doesNotMatch(JSON.stringify(request), /PRIVATE-MARKER|weekStart/);
    assert.equal((await app.call('/health/import', 'POST', request)).status, 200);
    assertNoMarker(app);
    // The SQL dump above proves the tables hold no marker; this scan guards against plaintext files.
    app.p.vault.lock();
    const files = filesUnder(app.p.directory);
    assert.ok(files.length > 0);
    for (const file of files)
      assert.equal(readFileSync(file).includes('PRIVATE-MARKER'), false, file);
    assert.doesNotMatch(app.logs.join('\n'), /PRIVATE-MARKER/);
  }));

test('M1: a request carrying private fields is refused and nothing from it is kept', () =>
  withApp(async (app) => {
    const withRow = (edit: (row: any) => void) => {
      const request = importRequest();
      edit(request.workouts!.rows[0]);
      return request;
    };
    const requests = [
      { ...importRequest(), notes: 'PRIVATE-MARKER' },
      withRow((row) => (row.name = 'PRIVATE-MARKER')),
      withRow((row) => (row.day = 'PRIVATE-MARKER')),
    ];
    for (const request of requests) {
      const response = await app.call('/health/import', 'POST', request);
      assert.equal(response.status, 400);
      const text = await response.text();
      assert.doesNotMatch(text, /PRIVATE-MARKER/);
      assert.equal(JSON.parse(text).error, REFUSED);
    }
    assertNoMarker(app);
    assert.equal((await summary(app)).state, 'empty');
  }));

test('an older file is a 409 with the reason', () =>
  withApp(async (app) => {
    await app.call('/health/import', 'POST', importRequest({ exportedAt: LATER }));
    const response = await app.call('/health/import', 'POST', importRequest());
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /older/);
  }));

test('a server fault rolls back, and logs only the route and error type', () =>
  withApp(async (app) => {
    await app.call('/health/import', 'POST', importRequest());
    const before = await summary(app);
    domainDb(app.p.vault, 'health').exec(
      "CREATE TRIGGER fail BEFORE INSERT ON weight_days BEGIN SELECT RAISE(ABORT,'boom'); END",
    );
    const response = await app.call(
      '/health/import',
      'POST',
      importRequest({
        exportedAt: LATER,
        edit: (d) => (d.bodyWeights[0].weightKg = 80),
      }),
    );
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /boom/);
    assert.match(app.logs[0], /^AllIn: POST \/api\/health\/import failed: SqliteError/);
    assert.doesNotMatch(app.logs.join('\n'), /boom/);
    assert.deepEqual(await summary(app), before);
  }));

test('if the log entry fails the change stays saved, and re-running is safe', () =>
  withApp(async (app) => {
    const tasks = domainDb(app.p.vault, 'tasks');
    tasks.exec(
      "CREATE TRIGGER nolog BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'no log'); END",
    );
    const failed = await app.call('/health/import', 'POST', importRequest());
    assert.equal(failed.status, 500);
    assert.match(app.logs[0], /^AllIn: POST \/api\/health\/import failed: /);
    assert.equal((await summary(app)).state, 'imported');
    tasks.exec('DROP TRIGGER nolog');
    const again = await app.call('/health/import', 'POST', importRequest());
    assert.equal(again.status, 200);
    assert.equal((await again.json()).workouts.unchanged, 4);
  }));

test('goal and purge work over HTTP and record only their action', () =>
  withApp(async (app) => {
    await app.call('/health/import', 'POST', importRequest());
    const goal = await app.call('/health/goal', 'POST', { workoutGoal: 3 });
    assert.equal(goal.status, 200);
    assert.deepEqual(await goal.json(), { workoutGoal: 3 });
    assert.equal((await summary(app)).workoutGoal, 3);
    const purge = await app.call('/health/purge', 'POST', {});
    assert.equal(purge.status, 200);
    assert.deepEqual(await purge.json(), { ok: true });
    const after = await summary(app);
    assert.equal(after.state, 'empty');
    assert.equal(after.workoutGoal, null);
    const events = (await (await app.call('/events')).json()) as Record<string, unknown>[];
    const actions = events.map((e) => e.action);
    assert.ok(actions.includes('health.goal'));
    assert.ok(actions.includes('health.purge'));
    for (const e of events) assert.deepEqual(Object.keys(e).sort(), ['action', 'at', 'outcome']);
  }));

test('the largest allowed import stays well inside the request limit', () =>
  withApp(async (app) => {
    const count = 20_000;
    const day = (i: number) => addDays('1900-01-01', i);
    const part = (row: (d: string) => object) => ({
      replaceFrom: day(0),
      replaceTo: day(count - 1),
      coverageFrom: day(0),
      coverageTo: day(count - 1),
      rows: Array.from({ length: count }, (_, i) => row(day(i))),
    });
    const build = (dryRun: boolean) => ({
      dryRun,
      confirmOlder: false,
      source: { app: 'openfit', version: 1, exportedAt: '2026-11-06T18:00:00.000Z' },
      workouts: part((d) => ({ day: d, workouts: 1 })),
      weight: part((d) => ({ day: d, weightKg: 70.5 })),
    });
    const timed = async (dryRun: boolean) => {
      const start = performance.now();
      const response = await app.call('/health/import', 'POST', build(dryRun));
      const ms = performance.now() - start;
      assert.equal(response.status, 200);
      return { ms, result: await response.json() };
    };
    const dry = await timed(true);
    assert.ok(dry.ms < 5000, `dry run took ${dry.ms} ms`);
    const save = await timed(false);
    assert.ok(save.ms < 5000, `save took ${save.ms} ms`);
    const repeat = await timed(true);
    assert.equal(repeat.result.workouts.unchanged, count);
    assert.equal(repeat.result.weight.unchanged, count);
    const start = performance.now();
    const response = await app.call('/health/summary');
    const ms = performance.now() - start;
    assert.equal(response.status, 200);
    assert.ok(ms < 1000, `summary took ${ms} ms`);
  }));
