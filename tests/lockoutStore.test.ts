import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lockout } from '../server/lockout.ts';

const HOUR = 3_600_000;
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'allin-lockout-'));
  const clock = { now: 1_000_000 };
  return {
    file: join(dir, 'lockout.json'),
    dir,
    clock,
    make: (file?: string) => new Lockout(file, () => clock.now),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('four failures add no wait, the fifth adds one minute', () => {
  const t = setup();
  const lock = t.make();
  for (let i = 0; i < 4; i++) {
    lock.fail();
    assert.equal(lock.waitMs(), 0);
  }
  lock.fail();
  assert.equal(lock.waitMs(), 60_000);
  t.clock.now += 20_000;
  assert.equal(lock.waitMs(), 40_000);
  t.cleanup();
});
test('each further failure doubles the wait, up to one hour', () => {
  const t = setup();
  const lock = t.make();
  for (let i = 0; i < 5; i++) lock.fail();
  const waits = [];
  for (let i = 0; i < 8; i++) {
    t.clock.now += lock.waitMs();
    lock.fail();
    waits.push(lock.waitMs());
  }
  assert.deepEqual(waits, [120_000, 240_000, 480_000, 960_000, 1_920_000, HOUR, HOUR, HOUR]);
  t.cleanup();
});
test('a success clears the count and the wait', () => {
  const t = setup();
  const lock = t.make(t.file);
  for (let i = 0; i < 6; i++) lock.fail();
  lock.succeed();
  assert.equal(lock.waitMs(), 0);
  for (let i = 0; i < 4; i++) lock.fail();
  assert.equal(lock.waitMs(), 0);
  assert.equal(t.make(t.file).waitMs(), 0);
  t.cleanup();
});
test('a new Lockout on the same file keeps the count and the wait', () => {
  const t = setup();
  const first = t.make(t.file);
  for (let i = 0; i < 5; i++) first.fail();
  const again = t.make(t.file);
  assert.equal(again.waitMs(), 60_000);
  t.clock.now += 60_000;
  again.fail();
  assert.equal(t.make(t.file).waitMs(), 120_000);
  t.cleanup();
});
test('a damaged file reads as no failures', () => {
  const t = setup();
  for (const text of ['{', '[]', '{"failures":"x"}', '{"failures":3}', '']) {
    writeFileSync(t.file, text);
    const lock = t.make(t.file);
    assert.equal(lock.waitMs(), 0, text);
    for (let i = 0; i < 4; i++) lock.fail();
    assert.equal(lock.waitMs(), 0, text);
  }
  t.cleanup();
});
test('a wait end time more than an hour ahead is cut to one hour', () => {
  const t = setup();
  writeFileSync(t.file, JSON.stringify({ failures: 9, retryAt: t.clock.now + 10 * HOUR }));
  assert.equal(t.make(t.file).waitMs(), HOUR);
  t.cleanup();
});
test('a clock stepped back during a wait never asks for more than an hour, and the wait ends', () => {
  const t = setup();
  const lock = t.make();
  for (let i = 0; i < 5; i++) lock.fail();
  t.clock.now -= 30 * 24 * HOUR;
  assert.ok(lock.waitMs() <= HOUR, `told to wait ${lock.waitMs()} ms`);
  t.clock.now += HOUR;
  assert.equal(lock.waitMs(), 0);
  t.cleanup();
});
test('a file that cannot be written still locks out in memory', () => {
  const t = setup();
  const lock = t.make(join(t.dir, 'missing', 'lockout.json'));
  for (let i = 0; i < 5; i++) lock.fail();
  assert.equal(lock.waitMs(), 60_000);
  lock.succeed();
  assert.equal(lock.waitMs(), 0);
  t.cleanup();
});
test('the file is owner-only and holds only failures and retryAt', () => {
  const t = setup();
  const lock = t.make(t.file);
  for (let i = 0; i < 5; i++) lock.fail();
  assert.equal(statSync(t.file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(t.file, 'utf8'))).sort(), [
    'failures',
    'retryAt',
  ]);
  t.cleanup();
});
