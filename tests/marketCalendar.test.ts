import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMarketOpen,
  isSessionBar,
  latestClosedBar,
  nextBarTime,
} from '../shared/marketCalendar.ts';

const next = (iso: string, calendar: 'continuous' | 'us-equity-regular') => {
  const value = nextBarTime(Date.parse(iso), calendar);
  return value === null ? null : new Date(value).toISOString();
};

// Expected values were worked out by hand from NYSE's published 2026–2028 calendar.
for (const [name, from, want] of [
  ['within a session', '2026-09-14T13:30:00.000Z', '2026-09-14T13:45:00.000Z'],
  ['overnight', '2026-09-14T19:45:00.000Z', '2026-09-15T13:30:00.000Z'],
  ['over a weekend', '2026-09-18T19:45:00.000Z', '2026-09-21T13:30:00.000Z'],
  ['over Labor Day', '2026-09-04T19:45:00.000Z', '2026-09-08T13:30:00.000Z'],
  ['when clocks go back', '2026-10-30T19:45:00.000Z', '2026-11-02T14:30:00.000Z'],
  ['when clocks go forward', '2026-03-06T20:45:00.000Z', '2026-03-09T13:30:00.000Z'],
  ['over Thanksgiving', '2026-11-25T20:45:00.000Z', '2026-11-27T14:30:00.000Z'],
  ['after a 1 p.m. early close', '2026-11-27T17:45:00.000Z', '2026-11-30T14:30:00.000Z'],
  ['over a New Year holiday', '2026-12-31T20:45:00.000Z', '2027-01-04T14:30:00.000Z'],
  ['when New Year falls on a Saturday', '2027-12-31T20:45:00.000Z', '2028-01-03T14:30:00.000Z'],
  ['at the end of calendar coverage', '2028-12-29T20:45:00.000Z', null],
  ['before calendar coverage', '2025-12-31T20:45:00.000Z', null],
] as const)
  test(`next regular-session bar ${name}`, () => {
    assert.equal(next(from, 'us-equity-regular'), want);
  });

test('a continuous market always expects the next 15-minute bar', () => {
  assert.equal(next('2026-10-30T23:45:00.000Z', 'continuous'), '2026-10-31T00:00:00.000Z');
});

for (const [name, iso, want] of [
  ['the opening bar', '2026-09-14T13:30:00.000Z', true],
  ['the last bar of the day', '2026-09-14T19:45:00.000Z', true],
  ['the last bar of an early close', '2026-11-27T17:45:00.000Z', true],
  ['a pre-market bar', '2026-09-14T13:15:00.000Z', false],
  ['a bar opening at the close', '2026-09-14T20:00:00.000Z', false],
  ['a bar off the 15-minute grid', '2026-09-14T13:37:00.000Z', false],
  ['a Saturday', '2026-09-12T14:00:00.000Z', false],
  ['a holiday', '2026-09-07T14:00:00.000Z', false],
  ['a bar after an early close', '2026-11-27T18:00:00.000Z', false],
  ['a date past calendar coverage', '2029-01-02T14:30:00.000Z', false],
] as const)
  test(`regular-session check: ${name}`, () => {
    assert.equal(isSessionBar(Date.parse(iso), 'us-equity-regular'), want);
  });

const latest = (iso: string, calendar: 'continuous' | 'us-equity-regular') => {
  const value = latestClosedBar(Date.parse(iso), calendar);
  return value === null ? null : new Date(value).toISOString();
};
test('continuous: the latest closed bar', () =>
  assert.equal(latest('2026-11-07T20:16:00Z', 'continuous'), '2026-11-07T20:00:00.000Z'));
test('continuous: a bar is closed exactly at its close time', () => {
  assert.equal(latest('2026-11-07T20:15:00Z', 'continuous'), '2026-11-07T20:00:00.000Z');
  assert.equal(latest('2026-11-07T20:14:59.999Z', 'continuous'), '2026-11-07T19:45:00.000Z');
});
test('stocks on a Saturday: the latest closed bar is Friday 15:45 ET', () =>
  assert.equal(latest('2026-11-07T15:00:00Z', 'us-equity-regular'), '2026-11-06T20:45:00.000Z'));
test("stocks before Monday's first close: still Friday", () =>
  assert.equal(latest('2026-11-09T14:40:00Z', 'us-equity-regular'), '2026-11-06T20:45:00.000Z'));
test('stocks after the first close: Monday 09:30 ET', () =>
  assert.equal(latest('2026-11-09T14:45:00Z', 'us-equity-regular'), '2026-11-09T14:30:00.000Z'));
test('a holiday and an early close', () => {
  // Thanksgiving: the newest closed bar is Wednesday's last.
  assert.equal(latest('2026-11-26T15:00:00Z', 'us-equity-regular'), '2026-11-25T20:45:00.000Z');
  // The day after closes at 1 p.m. ET, so its last bar opens at 12:45 ET (17:45Z).
  assert.equal(latest('2026-11-27T19:00:00Z', 'us-equity-regular'), '2026-11-27T17:45:00.000Z');
  assert.equal(latest('2026-11-28T15:00:00Z', 'us-equity-regular'), '2026-11-27T17:45:00.000Z');
});
test('isMarketOpen: inside, outside, weekend, holiday, and crypto always', () => {
  const open = (iso: string, calendar: 'continuous' | 'us-equity-regular') =>
    isMarketOpen(Date.parse(iso), calendar);
  assert.equal(open('2026-11-09T14:30:00Z', 'us-equity-regular'), true);
  assert.equal(open('2026-11-09T14:29:59.999Z', 'us-equity-regular'), false);
  assert.equal(open('2026-11-09T20:59:59Z', 'us-equity-regular'), true);
  assert.equal(open('2026-11-09T21:00:00Z', 'us-equity-regular'), false);
  assert.equal(open('2026-11-07T16:00:00Z', 'us-equity-regular'), false);
  assert.equal(open('2026-11-26T16:00:00Z', 'us-equity-regular'), false);
  assert.equal(open('2026-11-27T18:00:00Z', 'us-equity-regular'), false);
  assert.equal(open('2026-11-07T16:00:00Z', 'continuous'), true);
  assert.equal(open('2026-11-26T03:00:00Z', 'continuous'), true);
});
test('past calendar coverage: null and closed', () => {
  assert.equal(latest('2029-06-01T15:00:00Z', 'us-equity-regular'), null);
  assert.equal(isMarketOpen(Date.parse('2029-06-01T15:00:00Z'), 'us-equity-regular'), false);
  assert.equal(latest('2025-06-02T15:00:00Z', 'us-equity-regular'), null);
});
