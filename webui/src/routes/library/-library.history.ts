/**
 * Library → Listening history (board 13a, 13b; HANDOFF 64): the reads, the
 * remembered range and the words. Music is GET /api/library/listening-history,
 * Podcasts and Audiobooks GET /api/player/plays with a range, and the Kind
 * buttons' counts GET /api/library/listening-history/counts (one ask for every
 * kind and range). The contract is docs/design/CONTRACTS.md, "Listening
 * history".
 */

import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import { apiClient, readJson } from '@/app/api-client';
import { spokenProgressWords } from '@/shell/player-state';

import { LIBRARY_QUERY_KEY } from './-library.api';

export type HistoryKind = 'music' | 'podcast' | 'audiobook';
export type HistoryRange = 'today' | '7d' | '30d' | 'all';

export const HISTORY_KINDS: ReadonlyArray<{ value: HistoryKind; label: string }> = [
  { value: 'music', label: 'Music' },
  { value: 'podcast', label: 'Podcasts' },
  { value: 'audiobook', label: 'Audiobooks' },
];

/** Range buttons; the phone says "All" (13b). */
export const HISTORY_RANGES: ReadonlyArray<{ value: HistoryRange; label: string; short: string }> =
  [
    { value: 'today', label: 'Today', short: 'Today' },
    { value: '7d', label: '7 days', short: '7 days' },
    { value: '30d', label: '30 days', short: '30 days' },
    { value: 'all', label: 'All time', short: 'All' },
  ];

export const DEFAULT_HISTORY_RANGE: HistoryRange = '7d';
export const HISTORY_PAGE_SIZE = 50;

/** The range picked last, per browser (13a: 7 days, remembered). */
export const HISTORY_RANGE_KEY = 'soulsync.library.history.range';

export function parseHistoryKind(value: unknown): HistoryKind | undefined {
  return HISTORY_KINDS.some((k) => k.value === value) ? (value as HistoryKind) : undefined;
}

export function parseHistoryRange(value: unknown): HistoryRange | undefined {
  return HISTORY_RANGES.some((r) => r.value === value) ? (value as HistoryRange) : undefined;
}

/** Storage can be missing or throw (private windows, blocked site data). */
export function readRememberedRange(): HistoryRange {
  try {
    return (
      parseHistoryRange(globalThis.localStorage?.getItem(HISTORY_RANGE_KEY)) ??
      DEFAULT_HISTORY_RANGE
    );
  } catch {
    return DEFAULT_HISTORY_RANGE;
  }
}

export function rememberRange(range: HistoryRange): void {
  try {
    globalThis.localStorage?.setItem(HISTORY_RANGE_KEY, range);
  } catch {
    /* not remembered; the URL still carries it */
  }
}

// ── shapes ────────────────────────────────────────────────────────────────────

export interface MusicPlay {
  id: number;
  kind: 'music';
  /** UTC "YYYY-MM-DD HH:MM:SS". */
  played_at: string;
  /** The browser's day ("YYYY-MM-DD"), from the tz the page sent. */
  day: string;
  title: string;
  artist: string;
  album: string;
  track_id: string | null;
  artist_id: string | number | null;
  album_id: string | number | null;
  file_path: string | null;
  bitrate: number | null;
  format: string | null;
  below_target: boolean;
  length_s: number | null;
  image_url: string | null;
  in_library: boolean;
  was_in_library: boolean;
  server_source: string | null;
  player_name: string | null;
  heard_on: string | null;
}

export interface SpokenHistoryPlay {
  play_id: number;
  kind: 'podcast' | 'audiobook';
  media_id: string;
  title: string;
  subtitle?: string | null;
  image_url?: string | null;
  src?: string | null;
  duration_s?: number | null;
  played_at: string;
  day?: string | null;
  position_s?: number | null;
  finished?: boolean;
}

export interface MusicHistoryPage {
  success?: boolean;
  error?: string;
  items: MusicPlay[];
  total: number;
  offset: number;
  days: Record<string, number>;
  sources: string[];
  shared_with: number;
}

export interface SpokenHistoryPage {
  success?: boolean;
  error?: string;
  items: SpokenHistoryPlay[];
  total: number;
  offset: number;
  days: Record<string, number>;
}

export type HistoryCounts = Record<HistoryKind, Record<HistoryRange, number>>;

/** Date.getTimezoneOffset(): minutes, UTC minus local, as the routes take it. */
export function browserTz(now: Date = new Date()): number {
  return now.getTimezoneOffset();
}

async function ok<T extends { success?: boolean; error?: string }>(
  promise: Promise<T>,
): Promise<T> {
  const payload = await promise;
  if (payload.success === false) throw new Error(payload.error || "Couldn't load what you played");
  return payload;
}

export const HISTORY_QUERY_KEY = [...LIBRARY_QUERY_KEY, 'history'] as const;

export interface HistoryQuery {
  kind: HistoryKind;
  range: HistoryRange;
  q: string;
}

/** One kind's plays, 50 at a time ("Show 50 more" adds the next page). */
export function historyInfiniteQueryOptions(profileId: number, query: HistoryQuery, tz: number) {
  return infiniteQueryOptions({
    queryKey: [...HISTORY_QUERY_KEY, 'plays', profileId, query, tz] as const,
    initialPageParam: 0,
    queryFn: ({ pageParam }): Promise<MusicHistoryPage | SpokenHistoryPage> => {
      const searchParams: Record<string, string | number> = {
        range: query.range,
        tz,
        offset: pageParam,
        limit: HISTORY_PAGE_SIZE,
      };
      if (query.q) searchParams.q = query.q;
      if (query.kind === 'music')
        return ok(
          readJson<MusicHistoryPage>(apiClient.get('library/listening-history', { searchParams })),
        );
      return ok(
        readJson<SpokenHistoryPage>(
          apiClient.get('player/plays', { searchParams: { ...searchParams, kind: query.kind } }),
        ),
      );
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total && last.items.length ? loaded : undefined;
    },
    staleTime: 15_000,
  });
}

export function historyCountsQueryOptions(profileId: number, tz: number) {
  return queryOptions({
    queryKey: [...HISTORY_QUERY_KEY, 'counts', profileId, tz] as const,
    queryFn: async () =>
      (
        await ok(
          readJson<{ success?: boolean; error?: string; counts: HistoryCounts }>(
            apiClient.get('library/listening-history/counts', { searchParams: { tz } }),
          ),
        )
      ).counts,
    staleTime: 15_000,
  });
}

// ── words ─────────────────────────────────────────────────────────────────────

const SERVER_NAMES: Record<string, string> = {
  plex: 'Plex',
  jellyfin: 'Jellyfin',
  navidrome: 'Navidrome',
  emby: 'Emby',
  lastfm: 'Last.fm',
  listenbrainz: 'ListenBrainz',
};

const WEB_PLAYER = 'soulsync_web';

/**
 * Where a play happened, only when it wasn't SYNCHRO.S's own player: "on
 * Plex, Living room", "on Jellyfin", "from Last.fm"; a radio find you added
 * and then played here: "heard on FIP Jazz" (13a). '' for a plain play here.
 */
export function sourcePhrase(play: Pick<MusicPlay, 'server_source' | 'player_name' | 'heard_on'>) {
  const source = play.server_source || '';
  if (!source || source === WEB_PLAYER) return play.heard_on ? `heard on ${play.heard_on}` : '';
  const name = SERVER_NAMES[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
  if (source === 'lastfm' || source === 'listenbrainz') return `from ${name}`;
  return play.player_name ? `on ${name}, ${play.player_name}` : `on ${name}`;
}

/** "4:36", "1:02:10". */
export function lengthWords(seconds: number | null | undefined): string {
  const s = Math.round(Number(seconds) || 0);
  if (s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** A stored UTC stamp as a Date. */
export function playedDate(playedAt: string): Date | null {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(playedAt) ? playedAt : `${playedAt.replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** The row's time on the browser's clock: "14:02". */
export function clockTime(playedAt: string): string {
  const d = playedDate(playedAt);
  if (!d) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A day group's head: "Today · Thursday 23 October", "Yesterday · Wednesday
 * 22 October", "Monday 20 October"; the year joins once it isn't this one.
 * The phone keeps the first part only ("Today", "Yesterday", "Monday 20
 * October"), as 13b draws.
 */
export function dayHead(day: string, now: Date, phone = false): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const date = new Date(y, m - 1, d);
  const named = `${WEEKDAYS[date.getDay()]} ${d} ${MONTHS[m - 1]}${y === now.getFullYear() ? '' : ` ${y}`}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const lead = day === dayKey(now) ? 'Today' : day === dayKey(yesterday) ? 'Yesterday' : '';
  if (!lead) return named;
  return phone ? lead : `${lead} · ${named}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

const RANGE_PHRASE: Record<HistoryRange, string> = {
  today: 'today',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
  all: 'in all',
};

export function rangePhrase(range: HistoryRange): string {
  return RANGE_PHRASE[range];
}

/** "from SYNCHRO.S's player and Plex", "from Plex, Last.fm and SYNCHRO.S's player". */
export function sourcesPhrase(sources: readonly string[]): string {
  const names = sources.map((s) =>
    s === WEB_PLAYER
      ? "SYNCHRO.S's player"
      : (SERVER_NAMES[s] ?? s.charAt(0).toUpperCase() + s.slice(1)),
  );
  if (!names.length) return '';
  if (names.length === 1) return `from ${names[0]}`;
  return `from ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The meta line (13a): "412 plays in the last 7 days · from SYNCHRO.S's player
 * and Plex · yours only". A filter says "12 plays match". Podcasts and
 * audiobooks say what they are and that they're kept apart from Stats (13b).
 */
export function historyMeta({
  kind,
  range,
  total,
  filtered,
  sources = [],
  sharedWith = 0,
}: {
  kind: HistoryKind;
  range: HistoryRange;
  total: number;
  filtered: boolean;
  sources?: readonly string[];
  sharedWith?: number;
}): string {
  const noun =
    kind === 'music'
      ? plural(total, 'play')
      : kind === 'podcast'
        ? plural(total, 'episode')
        : plural(total, 'audiobook play', 'audiobook plays');
  const head = `${noun}${filtered ? ` ${total === 1 ? 'matches' : 'match'}` : ''} ${rangePhrase(range)}`;
  if (kind !== 'music') return `${head} · kept apart from Stats`;
  const whose =
    sharedWith > 0
      ? `shared with ${plural(sharedWith, 'profile')} that ${sharedWith === 1 ? "doesn't" : "don't"} keep their own`
      : 'yours only';
  return [head, sourcesPhrase(sources), whose].filter(Boolean).join(' · ');
}

/** The empty state's title: "Nothing played in the last 7 days". */
export function emptyTitle(kind: HistoryKind, range: HistoryRange, filtered: boolean): string {
  if (filtered) return 'Nothing you played matches';
  const what =
    kind === 'music'
      ? 'Nothing played'
      : kind === 'podcast'
        ? 'No episodes played'
        : 'No audiobooks played';
  return range === 'all' ? `${what} yet` : `${what} ${rangePhrase(range)}`;
}

/** The wider range the empty state offers ("Try 30 days"), or null at All time. */
export function widerRange(range: HistoryRange): HistoryRange | null {
  if (range === 'today') return '7d';
  if (range === '7d') return '30d';
  if (range === '30d') return 'all';
  return null;
}

/** A spoken play's progress, split so the page can colour "23 min left". */
export function spokenParts(play: SpokenHistoryPlay): {
  lead: string;
  progress: string;
  resumable: boolean;
} {
  const progress = spokenProgressWords(play);
  const lead = [play.subtitle || '', play.kind === 'audiobook' ? 'sample' : '']
    .filter(Boolean)
    .join(' · ');
  return { lead, progress, resumable: Boolean(progress) && progress !== 'Finished' };
}

/** Group plays under their day, keeping order. */
export function groupByDay<T extends { day?: string | null; played_at: string }>(
  items: readonly T[],
): { day: string; items: T[] }[] {
  const groups: { day: string; items: T[] }[] = [];
  for (const item of items) {
    const day = item.day || (playedDate(item.played_at) ? dayKey(playedDate(item.played_at)!) : '');
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}
