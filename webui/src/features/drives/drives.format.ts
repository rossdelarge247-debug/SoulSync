/**
 * Words for the drive move: sizes as the computer's Finder says them
 * (decimal, "93.2 GB"), durations ("1 h 20 min"), counts, and "Last seen …".
 * Times read the browser's clock only when called, never at module load.
 */

export function sizeWords(bytes: number | null | undefined): string {
  const n = Number(bytes || 0);
  const units: Array<[string, number]> = [
    ['TB', 1e12],
    ['GB', 1e9],
    ['MB', 1e6],
    ['KB', 1e3],
  ];
  for (const [unit, scale] of units) {
    if (n >= scale) {
      const value = n / scale;
      return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${unit}`;
    }
  }
  return `${Math.round(n)} bytes`;
}

/** "41.2 of 93.2 GB": the unit once when both share it. */
export function sizeOf(part: number, whole: number): string {
  const a = sizeWords(part);
  const b = sizeWords(whole);
  const unitA = a.split(' ')[1];
  const unitB = b.split(' ')[1];
  return unitA === unitB ? `${a.split(' ')[0]} of ${b}` : `${a} of ${b}`;
}

export function durationWords(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds || 0)));
  if (s < 90) return s >= 30 ? 'about a minute' : 'less than a minute';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function count(n: number, word: string, plural = `${word}s`): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? word : plural}`;
}

export function speedWords(bps: number | null | undefined): string | null {
  if (!bps || bps <= 0) return null;
  return `${Math.max(1, Math.round(bps / 1e6))} MB/s`;
}

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** "today at 09:12", "yesterday at 21:40", "on 18 Oct at 09:12". */
export function seenWords(unixSeconds: number, now: Date = new Date()): string {
  const then = new Date(unixSeconds * 1000);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(then)) / 86400000);
  if (diff === 0) return `today at ${hhmm(then)}`;
  if (diff === 1) return `yesterday at ${hhmm(then)}`;
  const month = then.toLocaleString('en-GB', { month: 'short' });
  return `on ${then.getDate()} ${month} at ${hhmm(then)}`;
}

/** The Notice's meta line: "Last seen today at 09:12 · looks every 30 s". */
export function lastSeenLine(
  lastSeen: number | null,
  interval: number,
  { short = false, now }: { short?: boolean; now?: Date } = {},
): string {
  const looks = `looks every ${interval} s`;
  if (!lastSeen) return `Not seen since SYNCHRO.S started · ${looks}`;
  const seen = seenWords(lastSeen, now);
  const words = short ? seen.replace(/^today at /, '') : seen;
  return `Last seen ${words} · ${looks}`;
}

/** The step row's six steps, in order. */
export const STEPS = ['Choose', 'Check', 'Plan', 'Copy', 'Check and switch', 'Done'] as const;
export type StepName = (typeof STEPS)[number];

/** The reason beside a control that needs the library's drive (123). */
export function awayWords(drive: string): string {
  return `${drive} isn’t connected`;
}

/** The folder as a person knows it: the computer's path when SYNCHRO.S
 *  knows it (125), else the container's. */
export function shownPath(row: { path: string; host_path?: string | null }): string {
  return row.host_path || row.path;
}

/** `path` relative to `root` ("Artist/Album/01.flac"), or `path` itself when
 *  it isn't under it. Text only, compared after trimming trailing slashes. */
export function relativeTo(path: string, root: string | null | undefined): string {
  if (!root) return path;
  const base = root.replace(/\/+$/, '');
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

/** Whether a "show the computer's names" line belongs under a list: some
 *  folder has no host path, and the helper runs there (not Windows). */
export function wantsNames(
  rows: Array<{ host_path?: string | null }>,
  platform: string | null | undefined,
): boolean {
  return platform !== 'windows' && rows.some((r) => !r.host_path);
}
