import { addDays, zonedInputToISO, zonedInputValue } from './time.ts';

export type MarketCalendar = 'continuous' | 'us-equity-regular';

const BAR_MS = 900000,
  BAR_MINUTES = 15,
  OPEN = 9 * 60 + 30,
  CLOSE = 16 * 60,
  EARLY_CLOSE = 13 * 60,
  ZONE = 'America/New_York';

// NYSE's published calendar, checked on 2026-11-06: https://www.nyse.com/trade/hours-calendars
// Dates outside this range have no known schedule, so they can never produce a signal.
// Extend both sets and LAST_DAY when NYSE publishes later years.
const FIRST_DAY = '2026-01-01',
  LAST_DAY = '2028-12-31';
const HOLIDAYS = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26',
  '2027-05-31',
  '2027-06-18',
  '2027-07-05',
  '2027-09-06',
  '2027-11-25',
  '2027-12-24',
  '2028-01-17',
  '2028-02-21',
  '2028-04-14',
  '2028-05-29',
  '2028-06-19',
  '2028-07-04',
  '2028-09-04',
  '2028-11-23',
  '2028-12-25',
]);
const EARLY_CLOSES = new Set([
  '2026-11-27',
  '2026-12-24',
  '2027-11-26',
  '2028-07-03',
  '2028-11-24',
]);

const covered = (day: string) => day >= FIRST_DAY && day <= LAST_DAY;
function isTradingDay(day: string) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !HOLIDAYS.has(day);
}
const closeOf = (day: string) => (EARLY_CLOSES.has(day) ? EARLY_CLOSE : CLOSE);
function newYorkClock(time: number) {
  const local = zonedInputValue(new Date(time).toISOString(), ZONE);
  return {
    day: local.slice(0, 10),
    minutes: Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16)),
  };
}

/** Whether a bar opening at `time` belongs to a known session of this calendar. */
export function isSessionBar(time: number, calendar: MarketCalendar) {
  if (!Number.isFinite(time) || time % BAR_MS !== 0) return false;
  if (calendar === 'continuous') return true;
  const { day, minutes } = newYorkClock(time);
  return (
    covered(day) && isTradingDay(day) && minutes >= OPEN && minutes + BAR_MINUTES <= closeOf(day)
  );
}

/** The opening time of the bar that should follow `time`, or null if the calendar can't tell. */
export function nextBarTime(time: number, calendar: MarketCalendar): number | null {
  if (!Number.isFinite(time)) return null;
  if (calendar === 'continuous') return time + BAR_MS;
  if (!isSessionBar(time, calendar)) return null;
  const { day, minutes } = newYorkClock(time);
  if (minutes + 2 * BAR_MINUTES <= closeOf(day)) return time + BAR_MS;
  for (let next = addDays(day, 1); covered(next); next = addDays(next, 1))
    if (isTradingDay(next)) return Date.parse(zonedInputToISO(`${next}T09:30`, ZONE));
  return null;
}

/** Whether the 15-minute slot containing `now` is a session bar. */
export function isMarketOpen(now: number, calendar: MarketCalendar) {
  return isSessionBar(Math.floor(now / BAR_MS) * BAR_MS, calendar);
}

/**
 * The opening time of the newest session bar whose close is at or before `now`, walking back at
 * most 14 days. Null when the calendar can't tell: `now` is outside coverage, or no session bar
 * falls in that window.
 */
export function latestClosedBar(now: number, calendar: MarketCalendar): number | null {
  if (!Number.isFinite(now)) return null;
  const newest = Math.floor(now / BAR_MS) * BAR_MS - BAR_MS;
  if (calendar === 'continuous') return newest;
  if (!covered(newYorkClock(now).day)) return null;
  const oldest = newest - 14 * 86_400_000;
  for (let time = newest; time >= oldest; time -= BAR_MS)
    if (isSessionBar(time, calendar)) return time;
  return null;
}
