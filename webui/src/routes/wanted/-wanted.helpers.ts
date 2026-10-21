import { parseServerTime } from '@/features/automations/format';

import type { Automation } from '../automations/-automations.types';
import type { WatchlistArtist } from '../watchlist/-watchlist.types';

import { primaryArtistId, sortArtists } from '../watchlist/-watchlist.helpers';
import { WL_FAILING_ATTEMPTS } from '../wishlist/-wishlist.types';
import {
  type FollowedArtistSummary,
  type FollowedFilter,
  type FollowedSort,
  type FoundItem,
  type FoundResponse,
  type QualityProfileRow,
  type WantedFilter,
  type WantedItem,
  type WantedKind,
  type WantedRow,
  type WantedSort,
  type WantedTrack,
} from './-wanted.types';

// ---------------------------------------------------------------------------
// Time and counts, in words
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A server timestamp in ms, 0 when missing or unreadable. Zone-less values
 *  are UTC (SQLite CURRENT_TIMESTAMP). */
export function serverTime(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = parseServerTime(String(value).trim().replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : 0;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "just now", "5 minutes ago", "yesterday", "3 days ago", "2 weeks ago"… */
export function relativeAgo(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${plural(Math.floor(diff / MINUTE), 'minute')} ago`;
  if (diff < DAY) return `${plural(Math.floor(diff / HOUR), 'hour')} ago`;
  const days = Math.floor(diff / DAY);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 35) return `${plural(Math.floor(days / 7), 'week')} ago`;
  if (days < 365) return `${plural(Math.floor(days / 30), 'month')} ago`;
  return `${plural(Math.floor(days / 365), 'year')} ago`;
}

/** "Added 3 days ago", '' when the date is unknown. */
export function addedLabel(addedAt: string, now: number): string {
  const ms = serverTime(addedAt);
  return ms ? `Added ${relativeAgo(ms, now)}` : '';
}

/** "in under a minute", "in about 20 minutes", "in about 2 hours", "in about 3 days". */
export function aboutIn(seconds: number): string {
  if (seconds < 60) return 'in under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in about ${plural(minutes, 'minute')}`;
  const hours = Math.round(seconds / 3600);
  if (hours < 36) return `in about ${plural(hours, 'hour')}`;
  return `in about ${plural(Math.round(seconds / 86_400), 'day')}`;
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** When a find happened, as the status tag says it: the day ("today",
 *  "yesterday", "Mon", "12 Oct") and the time, which phones leave out. */
export function foundWhen(ms: number, now: number): { day: string; time: string } {
  const date = new Date(ms);
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  let day: string;
  if (days <= 0) day = 'today';
  else if (days === 1) day = 'yesterday';
  else if (days < 7) day = WEEKDAYS[date.getDay()];
  else day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return { day, time: clock(date) };
}

/** "Mar 2026" from a release date ("2026-03-02", "2026-03" or "2026"). */
export function monthYear(value: string | null | undefined): string {
  const match = /^(\d{4})(?:-(\d{2}))?/.exec(String(value ?? '').trim());
  if (!match) return '';
  const month = match[2] ? Number(match[2]) : 0;
  return month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${match[1]}` : match[1];
}

// ---------------------------------------------------------------------------
// Wanted: tracks into rows
// ---------------------------------------------------------------------------

/** One row as /api/wishlist/tracks returns it. `spotify_data` may be a JSON string. */
export interface WishlistApiTrack {
  id?: string | number;
  spotify_track_id?: string | null;
  spotify_data?: unknown;
  retry_count?: number | string | null;
  last_attempted?: string | null;
  failure_reason?: string | null;
  date_added?: string | null;
  source_type?: string | null;
  source_info?: unknown;
  quality_profile_id?: number | string | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstArtistName(artists: unknown): string {
  if (!Array.isArray(artists) || artists.length === 0) return '';
  const first = artists[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && typeof (first as { name?: unknown }).name === 'string')
    return (first as { name: string }).name;
  return '';
}

/** Unpack one wishlist row; null for a row that can't be read (no track data). */
export function parseWantedTrack(row: WishlistApiTrack): WantedTrack | null {
  const data = asObject(row.spotify_data);
  if (!data) return null;
  const rawAlbum = data.album;
  const album = asObject(rawAlbum);
  const albumName =
    (typeof rawAlbum === 'string' ? rawAlbum : typeof album?.name === 'string' ? album.name : '') ||
    '';
  const images = Array.isArray(album?.images) ? (album.images as { url?: unknown }[]) : [];
  const image = images.find((img) => typeof img?.url === 'string' && img.url)?.url as
    | string
    | undefined;
  const total = Number(album?.total_tracks);
  const rawId = row.spotify_track_id || row.id || data.id;
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : '';
  if (!id) return null;
  const quality = Number(row.quality_profile_id);
  return {
    id,
    title: (typeof data.name === 'string' && data.name) || 'Unknown track',
    artist: firstArtistName(data.artists) || 'Unknown artist',
    album: albumName,
    albumType: typeof album?.album_type === 'string' ? album.album_type.toLowerCase() : '',
    albumTotal: Number.isFinite(total) && total > 0 ? total : null,
    image: image ?? '',
    addedAt: row.date_added || '',
    tries: Math.max(0, Number(row.retry_count) || 0),
    lastTried: row.last_attempted || '',
    lastError: row.failure_reason || '',
    sourceType: row.source_type || '',
    sourceInfo: asObject(row.source_info),
    qualityProfileId: Number.isInteger(quality) && quality > 0 ? quality : null,
  };
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Why a track's last try failed, worth showing. `failure_reason` is also
 * written when a track is ADDED ("Added via Download Discography"), so it
 * only means "the last try" once the track has actually been tried.
 */
function lastErrorOf(track: WantedTrack): string {
  if (track.tries <= 0 || !track.lastError) return '';
  const reason = track.lastError.trim();
  if (/^added\b/i.test(reason)) return '';
  return reason;
}

function kindOf(tracks: WantedTrack[]): WantedKind {
  const first = tracks[0];
  if (tracks.length === 1) {
    if (first.albumType === 'single' || !first.album || lower(first.album) === lower(first.title))
      return 'single';
    return 'track';
  }
  if (first.albumType === 'ep') return 'ep';
  if (first.albumType === 'single') return 'single';
  return 'album';
}

/**
 * Wishlist tracks grouped into the things a person asked for: tracks of the
 * same release by the same artist are one row (an album, EP or single), and a
 * lone track is a row of its own. Order follows the API (oldest first).
 */
export function buildWantedItems(tracks: WantedTrack[]): WantedItem[] {
  const groups = new Map<string, WantedTrack[]>();
  for (const track of tracks) {
    // a lone track without an album name can't share a row with anything
    const key = track.album
      ? `release:${lower(track.artist)}\u0000${lower(track.album)}`
      : `track:${track.id}`;
    const group = groups.get(key);
    if (group) group.push(track);
    else groups.set(key, [track]);
  }

  return [...groups.entries()].map(([groupKey, group]) => {
    const kind = kindOf(group);
    const first = group[0];
    const single = group.length === 1;
    const tries = Math.max(...group.map((t) => t.tries));
    const tried = group
      .filter((t) => lastErrorOf(t))
      .sort((a, b) => serverTime(b.lastTried) - serverTime(a.lastTried));
    const added = group
      .map((t) => t.addedAt)
      .filter(Boolean)
      .sort((a, b) => serverTime(a) - serverTime(b));
    const totals = group.map((t) => t.albumTotal ?? 0);
    return {
      key: single ? `track:${first.id}` : groupKey,
      kind,
      title: single ? first.title : first.album,
      artist: first.artist,
      album: first.album,
      image: group.find((t) => t.image)?.image ?? '',
      tracks: group,
      trackIds: group.map((t) => t.id),
      albumTotal: Math.max(...totals) || null,
      addedAt: added[0] ?? '',
      tries,
      lastError: tried[0] ? lastErrorOf(tried[0]) : '',
      sourceType: first.sourceType,
      sourceInfo: first.sourceInfo,
      qualityProfileId: group.find((t) => t.qualityProfileId)?.qualityProfileId ?? null,
      status: tries >= WL_FAILING_ATTEMPTS ? 'not-found' : 'searching',
    };
  });
}

export function toFoundItems(response: FoundResponse | undefined): FoundItem[] {
  return (response?.items ?? [])
    .filter((item) => item.id && item.title)
    .map((item) => ({
      key: `found:${item.id}`,
      id: String(item.id),
      title: String(item.title),
      artist: item.artist ?? '',
      album: item.album ?? '',
      quality: item.quality ?? '',
      image: item.image ?? '',
      foundAt: item.found_at ?? '',
    }));
}

// ---------------------------------------------------------------------------
// Wanted: what a row says
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<WantedKind, string> = {
  track: 'Track',
  album: 'Album',
  single: 'Single',
  ep: 'EP',
};

export function kindLabel(kind: WantedKind): string {
  return KIND_LABEL[kind];
}

/** The status tag: always a word, with the try count once there is one. */
export function wantedStatus(item: WantedItem): {
  text: string;
  tone: 'info' | 'neutral';
} {
  if (item.status === 'not-found') {
    return { text: `Not found yet · ${plural(item.tries, 'try', 'tries')}`, tone: 'neutral' };
  }
  return {
    text: item.tries > 0 ? `Searching · ${plural(item.tries, 'try', 'tries')}` : 'Searching',
    tone: 'info',
  };
}

const UNNAMED_PLAYLISTS = new Set(['', 'unknown playlist', 'wishlist']);

/** Where a wanted thing came from, when that says something ("from Followed artists"). */
export function sourceLabel(type: string, info: Record<string, unknown> | null): string {
  switch (type) {
    case 'watchlist':
      return 'from Followed artists';
    case 'watchlist_label':
      return 'from a followed label';
    case 'playlist': {
      const name = typeof info?.playlist_name === 'string' ? info.playlist_name.trim() : '';
      return UNNAMED_PLAYLISTS.has(name.toLowerCase()) ? '' : `from ${name}`;
    }
    case 'discography':
      return 'from Download discography';
    case 'enhance':
      return 'to upgrade its quality';
    case 'redownload':
      return 'to download again';
    default:
      return '';
  }
}

export interface MetaPart {
  key: string;
  text: string;
  /** The artist name, which opens the artist. */
  artist?: boolean;
  /** A failed last try, in the warning colour. */
  warning?: boolean;
  /** Left out on phones, where the meta line is shorter. */
  wide?: boolean;
}

/** "last try: user went offline" (lower-cases a capitalised first word). */
function lastTryText(reason: string): string {
  const text = /^[A-Z][a-z]/.test(reason) ? reason[0].toLowerCase() + reason.slice(1) : reason;
  return text.replace(/[.\s]+$/, '');
}

/**
 * The meta line under a wanted row's title: artist · album (for a track) ·
 * kind · track count · the quality it's held to · where it came from · why
 * the last try failed.
 */
export function wantedMeta(item: WantedItem, qualityName: string): MetaPart[] {
  const parts: MetaPart[] = [{ key: 'artist', text: item.artist, artist: true }];
  if (item.kind === 'track' && item.album)
    parts.push({ key: 'album', text: item.album, wide: true });
  parts.push({ key: 'kind', text: kindLabel(item.kind) });
  const wanted = item.trackIds.length;
  if (wanted > 1) {
    parts.push({
      key: 'count',
      text:
        item.albumTotal && wanted < item.albumTotal
          ? `${wanted} of ${item.albumTotal} tracks wanted`
          : plural(wanted, 'track'),
    });
  }
  if (qualityName) parts.push({ key: 'quality', text: qualityName, wide: true });
  const source = sourceLabel(item.sourceType, item.sourceInfo);
  if (source) parts.push({ key: 'source', text: source, wide: true });
  if (item.lastError) {
    parts.push({ key: 'error', text: `last try: ${lastTryText(item.lastError)}`, warning: true });
  }
  return parts;
}

/** The found row's meta: artist · album · quality. */
export function foundMeta(item: FoundItem): MetaPart[] {
  const parts: MetaPart[] = [];
  if (item.artist) parts.push({ key: 'artist', text: item.artist, artist: true });
  if (item.album && lower(item.album) !== lower(item.title))
    parts.push({ key: 'album', text: item.album, wide: true });
  if (item.quality) parts.push({ key: 'quality', text: item.quality, wide: true });
  return parts;
}

/** id → name, and the name an item without its own profile is held to. */
export function qualityNames(profiles: QualityProfileRow[] | undefined): {
  byId: Map<number, string>;
  fallback: string;
} {
  const byId = new Map<number, string>();
  let fallback = '';
  for (const profile of profiles ?? []) {
    if (!profile.name) continue;
    byId.set(profile.id, profile.name);
    if (profile.is_default && !fallback) fallback = profile.name;
  }
  return { byId, fallback };
}

// ---------------------------------------------------------------------------
// Wanted: filter, sort, count
// ---------------------------------------------------------------------------

export function wantedRows(items: WantedItem[], found: FoundItem[]): WantedRow[] {
  return [
    ...items.map((item) => ({ type: 'wanted' as const, item })),
    ...found.map((item) => ({ type: 'found' as const, item })),
  ];
}

function rowMatches(row: WantedRow, needle: string): boolean {
  const { title, artist, album } = row.item;
  return [title, artist, album].some((value) => value.toLowerCase().includes(needle));
}

export function filterWantedRows(rows: WantedRow[], filter: WantedFilter, query = ''): WantedRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === 'found' && row.type !== 'found') return false;
    if (filter === 'searching' && (row.type !== 'wanted' || row.item.status !== 'searching'))
      return false;
    if (filter === 'not-found' && (row.type !== 'wanted' || row.item.status !== 'not-found'))
      return false;
    return needle ? rowMatches(row, needle) : true;
  });
}

function rowDate(row: WantedRow): number {
  return serverTime(row.type === 'found' ? row.item.foundAt : row.item.addedAt);
}

export function sortWantedRows(rows: WantedRow[], sort: WantedSort): WantedRow[] {
  const out = [...rows];
  const byTitle = (a: WantedRow, b: WantedRow) => a.item.title.localeCompare(b.item.title);
  switch (sort) {
    case 'oldest':
      return out.sort((a, b) => rowDate(a) - rowDate(b) || byTitle(a, b));
    case 'most-tries':
      return out.sort((a, b) => {
        const triesA = a.type === 'wanted' ? a.item.tries : -1;
        const triesB = b.type === 'wanted' ? b.item.tries : -1;
        return triesB - triesA || rowDate(b) - rowDate(a) || byTitle(a, b);
      });
    case 'artist':
      return out.sort(
        (a, b) =>
          a.item.artist.localeCompare(b.item.artist, undefined, { sensitivity: 'base' }) ||
          byTitle(a, b),
      );
    default:
      return out.sort((a, b) => rowDate(b) - rowDate(a) || byTitle(a, b));
  }
}

export function wantedCounts(items: WantedItem[], found: FoundItem[]) {
  let searching = 0;
  let notFound = 0;
  for (const item of items) {
    if (item.status === 'not-found') notFound += 1;
    else searching += 1;
  }
  return { wanted: items.length, searching, notFound, found: found.length };
}

/** How many wanted things each artist has, by lower-cased name. */
export function wantedByArtist(items: WantedItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = lower(item.artist);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// The schedule lines
// ---------------------------------------------------------------------------

/** The system automation behind a schedule line, from GET /api/automations. */
export function findSystemAutomation(
  list: unknown,
  actionType: string,
): Pick<Automation, 'name' | 'enabled' | 'trigger_config'> | null {
  if (!Array.isArray(list)) return null;
  const match = (list as Automation[]).find(
    (row) => Boolean(row?.is_system) && row?.action_type === actionType,
  );
  return match ?? null;
}

/** "every 30 minutes", "every 6 hours", "every hour", '' when unknown. */
export function intervalText(config: Record<string, unknown> | null | undefined): string {
  const interval = Number(config?.interval);
  const unit = typeof config?.unit === 'string' ? config.unit.toLowerCase() : '';
  if (!Number.isFinite(interval) || interval <= 0) return '';
  const singular = unit.replace(/s$/, '');
  if (!['minute', 'hour', 'day', 'week'].includes(singular)) return '';
  return interval === 1 ? `every ${singular}` : `every ${interval} ${singular}s`;
}

export interface ScheduleInput {
  /** Seconds until the next run; 0 when it isn't scheduled. */
  nextRunSeconds: number;
  automation: Pick<Automation, 'name' | 'enabled' | 'trigger_config'> | null;
  /** The music side's automations are paused (Automations → pause). */
  paused: boolean;
}

export type ScheduleState =
  | { kind: 'paused' }
  | { kind: 'off' }
  | { kind: 'next'; when: string; name: string; every: string };

export function scheduleState({
  nextRunSeconds,
  automation,
  paused,
}: ScheduleInput): ScheduleState {
  if (paused) return { kind: 'paused' };
  if (automation && !automation.enabled) return { kind: 'off' };
  if (!nextRunSeconds || nextRunSeconds <= 0) return { kind: 'off' };
  return {
    kind: 'next',
    when: aboutIn(nextRunSeconds),
    name: automation?.name ?? '',
    every: intervalText(automation?.trigger_config ?? null),
  };
}

/** "(Auto-Process Wishlist, every 30 minutes)", '' when neither is known. */
export function automationAside(state: Extract<ScheduleState, { kind: 'next' }>): string {
  const bits = [state.name, state.every].filter(Boolean);
  return bits.length ? ` (${bits.join(', ')})` : '';
}

/** The scheduled search alternates between albums and singles each run. */
export function cycleText(cycle: string | undefined): string {
  if (cycle === 'albums') return 'albums';
  if (cycle === 'singles') return 'singles and EPs';
  return '';
}

// ---------------------------------------------------------------------------
// Followed artists
// ---------------------------------------------------------------------------

export type FollowedStatus = 'new' | 'unchecked' | 'quiet';

export interface FollowedRow {
  artist: WatchlistArtist;
  /** The provider id the watchlist routes take (artist settings, unfollow). */
  id: string | null;
  name: string;
  image: string;
  summary: FollowedArtistSummary | null;
  onWanted: number;
  status: FollowedStatus;
  /** Release types or filters differ from the defaults. */
  ownSettings: boolean;
  /** Last checked 30 or more days ago. */
  stale: boolean;
}

const STALE_DAYS = 30;

/** The old Watchlist's "Custom rules": any release type off, or a content
 *  filter (live, remixes, acoustic, compilations) on. */
export function hasOwnSettings(artist: WatchlistArtist): boolean {
  return (
    !artist.include_albums ||
    !artist.include_eps ||
    !artist.include_singles ||
    artist.include_live ||
    artist.include_remixes ||
    artist.include_acoustic ||
    artist.include_compilations
  );
}

function daysSince(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now - ms) / DAY));
}

export function buildFollowedRows(
  artists: WatchlistArtist[],
  summaries: FollowedArtistSummary[] | undefined,
  wantedCountsByArtist: Map<string, number>,
  now: number,
): FollowedRow[] {
  const byId = new Map((summaries ?? []).map((summary) => [summary.id, summary]));
  return artists.map((artist) => {
    const summary = byId.get(artist.id) ?? null;
    const checkedDays = daysSince(artist.last_scan_timestamp, now);
    const status: FollowedStatus = summary?.new_release
      ? 'new'
      : checkedDays === null
        ? 'unchecked'
        : 'quiet';
    return {
      artist,
      id: primaryArtistId(artist),
      name: artist.artist_name,
      image: artist.image_url ?? '',
      summary,
      onWanted: wantedCountsByArtist.get(lower(artist.artist_name)) ?? 0,
      status,
      ownSettings: hasOwnSettings(artist),
      stale: checkedDays !== null && checkedDays >= STALE_DAYS,
    };
  });
}

export function followedStatusTag(status: FollowedStatus): {
  text: string;
  tone: 'info' | 'neutral';
} {
  if (status === 'new') return { text: 'New release', tone: 'info' };
  if (status === 'unchecked') return { text: 'Not checked yet', tone: 'neutral' };
  return { text: 'Nothing new', tone: 'neutral' };
}

export function followedCounts(rows: FollowedRow[]) {
  return {
    all: rows.length,
    new: rows.filter((row) => row.status === 'new').length,
    unchecked: rows.filter((row) => row.status === 'unchecked').length,
    stale: rows.filter((row) => row.stale).length,
    ownSettings: rows.filter((row) => row.ownSettings).length,
  };
}

export function filterFollowedRows(
  rows: FollowedRow[],
  filter: FollowedFilter,
  query = '',
): FollowedRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === 'new' && row.status !== 'new') return false;
    if (filter === 'unchecked' && row.status !== 'unchecked') return false;
    if (filter === 'stale' && !row.stale) return false;
    if (filter === 'own-settings' && !row.ownSettings) return false;
    return needle ? row.name.toLowerCase().includes(needle) : true;
  });
}

export function sortFollowedRows(rows: FollowedRow[], sort: FollowedSort): FollowedRow[] {
  const order = new Map(
    sortArtists(
      rows.map((row) => row.artist),
      sort,
    ).map((a, i) => [a.id, i]),
  );
  return [...rows].sort((a, b) => (order.get(a.artist.id) ?? 0) - (order.get(b.artist.id) ?? 0));
}

/** "9 releases in your library · 5 on Wanted". */
/** "9 releases in your library · 5 on Wanted", and where its downloads go
 *  when the artist is filed as audiobooks (the old card's badge). */
export function followedMeta(row: FollowedRow, audiobook = false): string {
  const bits: string[] = [];
  if (row.summary) {
    bits.push(
      row.summary.library_releases > 0
        ? `${plural(row.summary.library_releases, 'release')} in your library`
        : 'Nothing in your library yet',
    );
  }
  if (row.onWanted > 0) bits.push(`${row.onWanted} on Wanted`);
  if (audiobook) bits.push('Filed in your audiobook library');
  return bits.join(' · ');
}

/** "Latest: Tidewater · Mar 2026" from the release cache, else the last
 *  release a check found ("Last found: Tidewater · 3 days ago"). */
export function followedLatest(
  row: FollowedRow,
  now: number,
): { label: string; album: string; when: string } | null {
  const latest = row.summary?.latest_release;
  if (latest?.album_name) {
    return { label: 'Latest', album: latest.album_name, when: monthYear(latest.release_date) };
  }
  const found = row.summary?.last_found;
  if (found?.album_name) {
    const ms = serverTime(found.found_at);
    return { label: 'Last found', album: found.album_name, when: ms ? relativeAgo(ms, now) : '' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Failure copy
// ---------------------------------------------------------------------------

/** Why a list didn't load, in a sentence: never a code alone. */
export function whyItFailed(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError') return "SoulSync didn't answer in 10 seconds.";
  if (name === 'HTTPError') return 'SoulSync ran into a problem reading it.';
  return "SoulSync didn't answer.";
}
