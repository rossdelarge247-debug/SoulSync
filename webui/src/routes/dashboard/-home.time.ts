/**
 * Home's words for times: when the next search runs ("in about 2 hours",
 * "tonight at 02:00") and when an activity item happened ("14:02",
 * "Yesterday"). Pure, with `nowMs` passed in so tests pin the clock. Times
 * are 24-hour, as on the boards, in the browser's own time zone.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Under this, the next search is said relatively ("in about 4 hours"). */
const RELATIVE_UNTIL = 6 * HOUR;

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long' });
const shortWeekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' });
const shortDayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const full = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short' });

const numbers = new Intl.NumberFormat('en-GB');

export function formatCount(n: number): string {
  return numbers.format(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days from `nowMs`'s day to `atMs`'s day (local time). */
function dayOffset(atMs: number, nowMs: number): number {
  return Math.round((startOfDay(atMs) - startOfDay(nowMs)) / DAY);
}

export function clockTime(atMs: number): string {
  return clock.format(new Date(atMs));
}

export function fullDateTime(atMs: number): string {
  return full.format(new Date(atMs));
}

/**
 * When the next search runs, to follow "Next search ": "due now", "in 40
 * minutes", "in about 2 hours", "today at 21:00", "tonight at 02:00",
 * "tomorrow at 06:00", "on Friday at 06:00", "on 3 November at 06:00".
 */
export function nextSearchPhrase(atSeconds: number, nowMs: number): string {
  const atMs = atSeconds * 1000;
  const diff = atMs - nowMs;
  if (diff <= MINUTE) return 'due now';
  if (diff < HOUR) {
    const minutes = Math.round(diff / MINUTE);
    return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (diff < RELATIVE_UNTIL) {
    const hours = Math.round(diff / HOUR);
    return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
  }
  const at = clockTime(atMs);
  const days = dayOffset(atMs, nowMs);
  if (days === 0) return `today at ${at}`;
  // the small hours straight after this evening are still "tonight"
  if (days === 1 && new Date(atMs).getHours() < 6 && new Date(nowMs).getHours() >= 18) {
    return `tonight at ${at}`;
  }
  if (days === 1) return `tomorrow at ${at}`;
  if (days < 7) return `on ${weekday.format(new Date(atMs))} at ${at}`;
  return `on ${dayMonth.format(new Date(atMs))} at ${at}`;
}

/** The phone's short form beside the Targets heading: "in 40 min", "in 2 h". */
export function nextSearchShort(atSeconds: number, nowMs: number): string {
  const diff = atSeconds * 1000 - nowMs;
  if (diff <= MINUTE) return 'due now';
  if (diff < HOUR) return `in ${Math.round(diff / MINUTE)} min`;
  if (diff < DAY) return `in ${Math.round(diff / HOUR)} h`;
  const days = dayOffset(atSeconds * 1000, nowMs);
  if (days === 1) return 'tomorrow';
  return `on ${shortWeekday.format(new Date(atSeconds * 1000))}`;
}

/**
 * The 72px time column of a Latest row: "14:02" today, then "Yesterday", a
 * weekday within the week, a date after that.
 */
export function latestTimeLabel(atSeconds: number, nowMs: number): string {
  const atMs = atSeconds * 1000;
  const days = dayOffset(atMs, nowMs);
  if (days >= 0) return clockTime(atMs);
  if (days === -1) return 'Yesterday';
  if (days > -7) return shortWeekday.format(new Date(atMs));
  return shortDayMonth.format(new Date(atMs));
}
