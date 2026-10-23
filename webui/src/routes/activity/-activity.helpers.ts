import type {
  ActivityItem,
  ActivityKind,
  ActivityLogLine,
  ActivityRange,
  ActivityResponse,
  ActivityShow,
  ActivityStatus,
} from './-activity.types';

// ── filters and range ─────────────────────────────────────────────────────────

/** The filter buttons in board order, with the API `kind` each one asks for. */
export const SHOW_OPTIONS: ReadonlyArray<{
  value: ActivityShow;
  label: string;
  kind: ActivityKind | 'needs_you' | 'all';
}> = [
  { value: 'all', label: 'All', kind: 'all' },
  { value: 'downloads', label: 'Downloads', kind: 'download' },
  { value: 'imports', label: 'Imports', kind: 'import' },
  { value: 'automations', label: 'Automations', kind: 'automation' },
  { value: 'playlists', label: 'Playlists', kind: 'sync' },
  // Internet radio's auto-add, one item per station per hour; hidden while the module is off
  { value: 'radio', label: 'Radio', kind: 'radio' },
  { value: 'needs-you', label: 'Needs you', kind: 'needs_you' },
];

export const RANGE_OPTIONS: ReadonlyArray<{ value: ActivityRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

export const DEFAULT_RANGE: ActivityRange = '7d';

/** The range picked last, per browser (Design: 7 days by default, remembered). */
export const RANGE_STORAGE_KEY = 'soulsync.activity.range';

export function parseShow(value: unknown): ActivityShow | undefined {
  return SHOW_OPTIONS.some((option) => option.value === value)
    ? (value as ActivityShow)
    : undefined;
}

export function parseRange(value: unknown): ActivityRange | undefined {
  return RANGE_OPTIONS.some((option) => option.value === value)
    ? (value as ActivityRange)
    : undefined;
}

export function apiKind(show: ActivityShow): ActivityKind | 'needs_you' | 'all' {
  return SHOW_OPTIONS.find((option) => option.value === show)?.kind ?? 'all';
}

/** Storage can be missing or throw (private windows, blocked site data). */
export function readRememberedRange(): ActivityRange {
  try {
    return parseRange(globalThis.localStorage?.getItem(RANGE_STORAGE_KEY)) ?? DEFAULT_RANGE;
  } catch {
    return DEFAULT_RANGE;
  }
}

export function rememberRange(range: ActivityRange): void {
  try {
    globalThis.localStorage?.setItem(RANGE_STORAGE_KEY, range);
  } catch {
    /* not remembered; the URL still carries it */
  }
}

/** The browser's own midnight today, in unix seconds. */
export function localMidnight(now: Date = new Date()): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor(midnight.getTime() / 1000);
}

/**
 * Query parameters for one page. "Today" sends the browser's midnight as
 * `since`, because `range=today` alone means the server's midnight.
 */
export function activityParams(
  show: ActivityShow,
  range: ActivityRange,
  before?: string | null,
  now: Date = new Date(),
): Record<string, string> {
  const params: Record<string, string> = { range };
  const kind = apiKind(show);
  if (kind !== 'all') params.kind = kind;
  if (range === 'today') params.since = String(localMidnight(now));
  if (before) params.before = before;
  return params;
}

/** "today", "in the last 7 days". */
export function rangePhrase(range: ActivityRange): string {
  if (range === 'today') return 'today';
  return range === '30d' ? 'in the last 30 days' : 'in the last 7 days';
}

export function loadingLabel(show: ActivityShow, range: ActivityRange): string {
  if (show === 'needs-you') return 'Loading what needs you…';
  if (range === 'today') return 'Loading today…';
  return range === '30d' ? 'Loading the last 30 days…' : 'Loading the last 7 days…';
}

/** The next range out, for the empty state's "Show 30 days". */
export function widerRange(range: ActivityRange): ActivityRange | null {
  if (range === 'today') return '7d';
  if (range === '7d') return '30d';
  return null;
}

/** Pinned items for a filter: a kind filter keeps its own kind only. */
export function pinnedFor(items: ActivityItem[], show: ActivityShow): ActivityItem[] {
  const kind = apiKind(show);
  if (kind === 'all' || kind === 'needs_you') return items;
  return items.filter((item) => item.kind === kind);
}

/** Poll every 10 s while something runs, every minute otherwise. */
export const LIVE_REFRESH_MS = 10_000;
export const IDLE_REFRESH_MS = 60_000;

export function isRunning(page: ActivityResponse | undefined): boolean {
  if (!page) return false;
  return page.running_count > 0 || page.items.some((item) => item.status === 'running');
}

export function refreshInterval(page: ActivityResponse | undefined): number | false {
  if (!page) return false;
  return isRunning(page) ? LIVE_REFRESH_MS : IDLE_REFRESH_MS;
}

/** Every page's items, newest first, each id once. */
export function flattenPages(pages: ActivityResponse[]): ActivityItem[] {
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

// ── dates and times, in the browser's locale ──────────────────────────────────

function asDate(seconds: number): Date {
  return new Date(seconds * 1000);
}

function dayStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetween(earlier: Date, later: Date): number {
  // calendar days, so a DST change doesn't shift the count
  const a = dayStart(earlier);
  const b = dayStart(later);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export function dayKey(seconds: number): string {
  const d = asDate(seconds);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "06:00", "16:02" (or "6:00 AM", as the browser's locale writes a short time). */
export function formatTime(seconds: number, locale?: string): string {
  return asDate(seconds).toLocaleTimeString(locale, { timeStyle: 'short' });
}

/** Full date and time, for a title tooltip. */
export function formatDateTime(seconds: number, locale?: string): string {
  return asDate(seconds).toLocaleString(locale, { dateStyle: 'full', timeStyle: 'short' });
}

export function isoTime(seconds: number): string {
  return asDate(seconds).toISOString();
}

/** "Wednesday 21 October", with the year when it isn't this year. */
export function formatDayDate(seconds: number, now: Date = new Date(), locale?: string): string {
  const d = asDate(seconds);
  return d.toLocaleDateString(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** A day group's heading: "Today", "Yesterday", or none, then the date. */
export function dayLabel(
  seconds: number,
  now: Date = new Date(),
  locale?: string,
): { lead: string | null; date: string } {
  const days = daysBetween(asDate(seconds), now);
  const lead = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : null;
  return { lead, date: formatDayDate(seconds, now, locale) };
}

export interface DayGroup {
  key: string;
  label: { lead: string | null; date: string };
  items: ActivityItem[];
}

/** Newest-first items into local-day groups, newest day first. */
export function groupByDay(items: ActivityItem[], now: Date = new Date(), locale?: string) {
  const groups: DayGroup[] = [];
  for (const item of items) {
    const key = dayKey(item.time);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
      continue;
    }
    const existing = groups.find((group) => group.key === key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    groups.push({ key, label: dayLabel(item.time, now, locale), items: [item] });
  }
  return groups;
}

/** A pinned row's time: "13:40" today, "Mon" this week, "12 Oct" before. */
export function formatPinnedWhen(seconds: number, now: Date = new Date(), locale?: string): string {
  const d = asDate(seconds);
  const days = daysBetween(d, now);
  if (days <= 0) return formatTime(seconds, locale);
  if (days < 7) return d.toLocaleDateString(locale, { weekday: 'short' });
  return d.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** "at 15:15", "tomorrow at 06:00", "on Friday at 06:00", "on 30 October at 06:00". */
export function retryWhen(seconds: number, now: Date = new Date(), locale?: string): string {
  const d = asDate(seconds);
  const time = formatTime(seconds, locale);
  const days = daysBetween(now, d);
  if (days <= 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `on ${d.toLocaleDateString(locale, { weekday: 'long' })} at ${time}`;
  return `on ${d.toLocaleDateString(locale, { day: 'numeric', month: 'long' })} at ${time}`;
}

// core/activity/common.py in_words(): "in under a minute", "in 5 minutes",
// "in about 2 hours", "in 3 days"
const RELATIVE_RETRY = /\bin (?:under a minute|\d+ minutes?|about \d+ hours?|\d+ days?)\b/;

/**
 * The detail with the server's "in about 2 hours" swapped for the retry time
 * in the browser's locale ("at 15:15"), so it doesn't go stale while the page
 * stays open. Without that phrase, the time is added as its own sentence.
 */
export function detailWithRetry(
  item: Pick<ActivityItem, 'detail' | 'retry_at'>,
  now: Date = new Date(),
  locale?: string,
): string {
  const detail = item.detail ?? '';
  if (!item.retry_at) return detail;
  const when = retryWhen(item.retry_at, now, locale);
  if (RELATIVE_RETRY.test(detail)) return detail.replace(RELATIVE_RETRY, when);
  if (item.retry_at * 1000 <= now.getTime()) return detail;
  const sep = detail && !/[.!?]$/.test(detail) ? '. ' : detail ? ' ' : '';
  return `${detail}${sep}Next try ${when}.`;
}

// ── status and actions ────────────────────────────────────────────────────────

export type TagTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Every status has a word: Running, Done, Failed, Needs you, Incomplete. */
export function statusTag(item: Pick<ActivityItem, 'status' | 'needs_you' | 'kind'>): {
  label: string;
  tone: TagTone;
  live: boolean;
} {
  const status: ActivityStatus = item.status;
  switch (status) {
    case 'running':
      return { label: 'Running', tone: 'info', live: true };
    case 'ok':
      return { label: 'Done', tone: 'success', live: false };
    case 'error':
      return { label: 'Failed', tone: 'danger', live: false };
    case 'warning':
      return { label: item.needs_you ? 'Needs you' : 'Incomplete', tone: 'warning', live: false };
    default:
      return { label: item.kind === 'safety' ? 'Preview' : 'Info', tone: 'neutral', live: false };
  }
}

export interface RetryAction {
  /** POST target under /api/. */
  path: string;
  label: string;
}

/**
 * A one-click retry, only where the server has one: a failed import-folder
 * item (POST /api/auto-import/retry/<id>) or a failed automation run
 * (POST /api/automations/<id>/run). Download batches have no such route.
 */
export function retryAction(item: ActivityItem): RetryAction | null {
  if (item.status !== 'error') return null;
  const ref = item.ref ?? {};
  if (item.kind === 'import' && item.id.startsWith('import:') && ref.auto_import_id != null) {
    if (ref.import_status && ref.import_status !== 'failed') return null;
    return { path: `auto-import/retry/${ref.auto_import_id}`, label: 'Retry now' };
  }
  if (
    item.kind === 'automation' &&
    item.id.startsWith('automation:') &&
    ref.automation_id != null
  ) {
    return { path: `automations/${ref.automation_id}/run`, label: 'Retry now' };
  }
  return null;
}

/**
 * Stop, where a running item can be stopped: a library job such as "Looking
 * for releases you don't have" (HANDOFF 68) names its stop route in
 * `ref.stop_path`, under /api/library/.
 */
export function stopAction(item: ActivityItem): RetryAction | null {
  if (item.status !== 'running') return null;
  const path = item.ref?.stop_path;
  if (typeof path !== 'string' || !/^library\/[a-z0-9/-]+$/.test(path)) return null;
  return { path, label: 'Stop' };
}

export type RowAction =
  | { type: 'log' }
  | { type: 'retry'; retry: RetryAction }
  | { type: 'stop'; stop: RetryAction }
  | { type: 'open'; href: string }
  | null;

/** The one action on the right of a timeline row. */
export function rowAction(item: ActivityItem): RowAction {
  if (item.has_log) return { type: 'log' };
  const stop = stopAction(item);
  if (stop) return { type: 'stop', stop };
  const retry = retryAction(item);
  if (retry) return { type: 'retry', retry };
  if (item.link) return { type: 'open', href: item.link };
  return null;
}

/** Under an open log: "Open this automation", or the page the run belongs to. */
export function logOpenLabel(item: ActivityItem): string {
  return item.kind === 'automation' ? 'Open this automation' : 'Open playlists';
}

export interface ToolDestination {
  href: string;
  /** A card on the Tools page to bring into view (window.revealToolsTabFor). */
  reveal?: string;
}

/** Where "Preview again" goes: the tool that made the preview. */
export function toolDestination(tool: unknown, fallback = '/tools'): ToolDestination {
  switch (tool) {
    case 'duplicate_cleaner':
      return { href: '/tools', reveal: '#duplicate-cleaner-card' };
    case 'deep_scan':
      return { href: '/tools', reveal: '#db-updater-card' };
    case 'repair_bulk_fix':
      return { href: '/tools' };
    // Empty bin and Clear quarantine live on Downloads, in Review
    case 'recycle_bin_purge':
    case 'quarantine_clear':
      return { href: '/active-downloads' };
    default:
      return { href: fallback || '/tools' };
  }
}

export type PinnedAction =
  | { type: 'preview-again'; label: string; destination: ToolDestination }
  | { type: 'dismiss'; label: string }
  | { type: 'link'; label: string; href: string };

const IMPORT_CHOICES = new Set(['pending_review', 'needs_identification']);

/** A pinned row's buttons: Preview again + Dismiss, Choose, or Open. */
export function pinnedActions(item: ActivityItem): PinnedAction[] {
  if (item.kind === 'safety') {
    return [
      {
        type: 'preview-again',
        label: 'Preview again',
        destination: toolDestination(item.ref?.tool, item.link),
      },
      { type: 'dismiss', label: 'Dismiss' },
    ];
  }
  if (!item.link) return [];
  const choose = item.kind === 'import' && IMPORT_CHOICES.has(String(item.ref?.import_status));
  return [{ type: 'link', label: choose ? 'Choose' : 'Open', href: item.link }];
}

// ── logs ──────────────────────────────────────────────────────────────────────

/** One line per log entry, its type as a word in a column: "error    Soulseek…". */
export function logText(lines: ActivityLogLine[]): string {
  return lines
    .map((line) => {
      const type = String(line.type || 'info').toLowerCase();
      return `${type.padEnd(8)} ${String(line.text ?? '')}`.trimEnd();
    })
    .join('\n');
}

// ── empty and failure copy ────────────────────────────────────────────────────

export interface EmptyCopy {
  title: string;
  description: string;
  hint: string;
  /** The page a second button opens. */
  link: { label: string; href: string } | null;
}

export function emptyCopy(show: ActivityShow, range: ActivityRange): EmptyCopy {
  const when = rangePhrase(range);
  switch (show) {
    case 'downloads':
      return {
        title: `No downloads ${when}`,
        description:
          'Every download shows here as it finishes, and when one fails it says why and whether it will try again.',
        hint: 'Automations search for what you want on their schedule, or you can run one now.',
        link: { label: 'Open Automations', href: '/automations' },
      };
    case 'imports':
      return {
        title: `No imports ${when}`,
        description:
          'Music added to your library shows here: from the import folder, from Staging, and from your media server’s scans.',
        hint: 'Anything that needs a decision from you stays at the top until you deal with it.',
        link: { label: 'Open Import', href: '/import' },
      };
    case 'automations':
      return {
        title: `No automation runs ${when}`,
        description:
          'Every run of your automations shows here, with why it failed when it did and a log one click away.',
        hint: 'Automations run on their schedule, or you can run one now.',
        link: { label: 'Open Automations', href: '/automations' },
      };
    case 'playlists':
      return {
        title: `No playlist mirrors ${when}`,
        description:
          'Each time a mirrored playlist is checked or synced, it shows here with what changed.',
        hint: 'Playlists are mirrored on their schedule, or you can sync one now.',
        link: { label: 'Open playlists', href: '/sync' },
      };
    case 'radio':
      return {
        title: `Nothing added from radio ${when}`,
        description:
          'When auto-add puts tracks a station played on Wanted, they show here, one item per station per hour.',
        hint: 'Auto-add is off on every station until you turn it on for one.',
        link: { label: 'Open Radio', href: '/radio' },
      };
    case 'needs-you':
      return {
        title: 'Nothing needs you',
        description:
          'When an import needs a decision, a preview expires, or an automation keeps failing, it shows here until it’s dealt with.',
        hint: 'Everything else SYNCHRO.S does is in the timeline.',
        link: null,
      };
    default:
      return {
        title: range === 'today' ? 'Nothing today' : `Nothing ${when}`,
        description:
          'Every download, import, playlist mirror and automation run shows here as it happens, with why it failed when it did. Anything that needs a decision from you stays at the top until you deal with it.',
        hint: 'Automations run on their schedule, or you can run one now.',
        link: { label: 'Open Automations', href: '/automations' },
      };
  }
}

/** The failure Notice's sentence: why it didn't load, and that nothing is lost. */
export function failureSentence(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const why =
    name === 'TimeoutError'
      ? 'SYNCHRO.S didn’t answer in 10 seconds.'
      : name === 'HTTPError'
        ? 'SYNCHRO.S ran into a problem reading its history.'
        : 'SYNCHRO.S didn’t answer.';
  return `${why} Downloads and automations carry on as normal; this is a display problem. If it keeps happening, the Setup check can tell you why.`;
}

/** Under the last page: "That’s everything from the last 7 days." */
export function endNote(range: ActivityRange): string {
  if (range === 'today') return 'That’s everything from today.';
  return `That’s everything from the last ${range === '30d' ? '30' : '7'} days.`;
}

export function runningLabel(count: number): string {
  return `${count} running now`;
}
