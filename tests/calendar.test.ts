import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarDay } from '../shared/schema.ts';
import { addDays, zonedInputToISO, zonedInputValue } from '../shared/time.ts';

for (const [name, local, timezone, iso] of [
  [
    'ahead of UTC, across midnight',
    '2026-11-07T01:30',
    'Asia/Jerusalem',
    '2026-11-06T23:30:00.000Z',
  ],
  ['US daylight time', '2026-07-01T09:30', 'America/New_York', '2026-07-01T13:30:00.000Z'],
  ['US standard time', '2026-12-01T09:30', 'America/New_York', '2026-12-01T14:30:00.000Z'],
  ['UTC', '2026-12-01T09:30', 'UTC', '2026-12-01T09:30:00.000Z'],
] as const) {
  test(`a time entered in the chosen timezone converts both ways: ${name}`, () => {
    assert.equal(zonedInputToISO(local, timezone), iso);
    assert.equal(zonedInputValue(iso, timezone), local);
  });
}
test('a clock time skipped by daylight saving moves forward to a real time', () => {
  assert.equal(zonedInputToISO('2026-03-08T02:30', 'America/New_York'), '2026-03-08T07:30:00.000Z');
});
test('a clock time repeated by daylight saving resolves to its first occurrence', () => {
  assert.equal(zonedInputToISO('2026-11-01T01:30', 'America/New_York'), '2026-11-01T05:30:00.000Z');
});
// Hand-derived from each zone's 2026 rules. Skipped times use the offset from before the change,
// which lands one hour later on the clock. Repeated times use the earlier instant.
for (const [name, local, timezone, iso] of [
  ['Jerusalem, skipped', '2026-03-27T02:30', 'Asia/Jerusalem', '2026-03-27T00:30:00.000Z'],
  ['Jerusalem, repeated', '2026-10-25T01:30', 'Asia/Jerusalem', '2026-10-24T22:30:00.000Z'],
  ['Paris, skipped', '2026-03-29T02:30', 'Europe/Paris', '2026-03-29T01:30:00.000Z'],
  ['Paris, repeated', '2026-10-25T02:30', 'Europe/Paris', '2026-10-25T00:30:00.000Z'],
  ['Sydney, skipped', '2026-10-04T02:30', 'Australia/Sydney', '2026-10-03T16:30:00.000Z'],
  ['Sydney, repeated', '2026-04-05T02:30', 'Australia/Sydney', '2026-04-04T15:30:00.000Z'],
] as const)
  test(`daylight saving east of UTC: ${name}`, () => {
    assert.equal(zonedInputToISO(local, timezone), iso);
  });
test('adding days crosses month and year ends', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-11-02', 7), '2026-11-09');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});
test('scheduled instants resolve into the selected calendar day around midnight and DST', () => {
  assert.equal(calendarDay('2026-11-06T23:30:00.000Z', 'Asia/Jerusalem'), '2026-11-07');
  assert.equal(calendarDay('2026-11-06T02:30:00.000Z', 'America/New_York'), '2026-11-05');
  assert.equal(calendarDay('2026-11-01T05:30:00.000Z', 'America/New_York'), '2026-11-01');
  assert.equal(calendarDay('2026-11-01T06:30:00.000Z', 'America/New_York'), '2026-11-01');
});
