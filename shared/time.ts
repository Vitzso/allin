const formatters = new Map<string, Intl.DateTimeFormat>();
function wallClock(instant: number, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timezone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const { type, value } of formatter.formatToParts(instant)) parts[type] = value;
  return parts;
}
function offsetAt(instant: number, timezone: string) {
  const p = wallClock(instant, timezone);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - Math.floor(instant / 1000) * 1000;
}
/** An instant as a `datetime-local` value (YYYY-MM-DDTHH:mm) on the clock of `timezone`. */
export function zonedInputValue(iso: string, timezone: string) {
  const p = wallClock(Date.parse(iso), timezone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/**
 * A `datetime-local` value read on the clock of `timezone`, as a UTC instant. A time skipped by
 * daylight saving moves forward to a real time; a repeated time resolves to its first occurrence.
 */
export function zonedInputToISO(local: string, timezone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new RangeError('Expected a date and time.');
  const [, year, month, day, hour, minute] = match.map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // A day either side of the wall time gives the offsets in force before and after any change.
  const before = offsetAt(wall - 86400000, timezone),
    after = offsetAt(wall + 86400000, timezone);
  const matches = [before, after]
    .map((offset) => ({ offset, instant: wall - offset }))
    .filter(({ offset, instant }) => offsetAt(instant, timezone) === offset)
    .map(({ instant }) => instant);
  // No match means the time was skipped. The earlier offset lands after the change, moving forward.
  const instant = matches.length ? Math.min(...matches) : wall - before;
  return new Date(instant).toISOString();
}
/** A YYYY-MM-DD calendar day moved by a number of days. Independent of any timezone. */
export function addDays(day: string, count: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  const year = date.getUTCFullYear();
  if (year < 0 || year > 9999) throw new RangeError('That date is out of range.');
  return date.toISOString().slice(0, 10);
}
/** Whole days from one YYYY-MM-DD calendar day to another. */
export function daysBetween(from: string, to: string) {
  return (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000;
}
/** The first day of the week holding `day`. `weekStart` is 0 (Sunday) to 6 (Saturday). */
export function startOfWeek(day: string, weekStart: number) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -((weekday - weekStart + 7) % 7));
}
const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** The short English name of a YYYY-MM-DD calendar day's weekday. */
export function weekdayName(day: string) {
  return weekdayNames[new Date(`${day}T12:00:00Z`).getUTCDay()];
}
