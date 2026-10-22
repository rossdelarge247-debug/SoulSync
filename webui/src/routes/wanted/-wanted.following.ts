/**
 * The Following tab (board 5e): everything a profile follows, as one list
 * with a kind on each row. Artists come from the watchlist and its summary
 * (FollowedRow, in -wanted.helpers.ts); labels, podcasts and audiobook
 * follows from their own watchlist routes, with what each has put on Wanted.
 *
 * Statuses are HANDOFF answer 7's set, said per kind from what is stored:
 *
 * - artist: a check found something in the last 7 days (the summary route);
 * - label: a release the label check found went onto Wanted in the last 7
 *   days and is still there (wishlist source "watchlist_label");
 * - podcast: an episode was downloaded in the last 7 days ("New episode");
 *   a show that doesn't download new episodes says so instead, since its
 *   check only counts them;
 * - audiobook follow: a book by them (published after you followed) went
 *   onto the audiobook wishlist in the last 7 days; a check that failed
 *   says so, with the reason.
 *
 * Never checked is "Not checked yet" for every kind.
 */

import type {
  AudiobookFollowedAuthor,
  AudiobookWishlistEntry,
} from '../audiobooks/-audiobooks.types';
import type { WatchlistLabel, WatchlistPodcast } from '../watchlist/-watchlist.types';
import type {
  FollowedFilter,
  FollowedSort,
  FollowKindFilter,
  PodcastSummaryEntry,
  WantedItem,
} from './-wanted.types';

import {
  followedLatest,
  followedMeta,
  plural,
  relativeAgo,
  serverTime,
  type FollowedRow,
} from './-wanted.helpers';

const DAY = 86_400_000;
export const NEW_DAYS = 7;

export type FollowKind = 'artist' | 'label' | 'podcast' | 'author';

export type FollowingStatus =
  | 'new'
  | 'unchecked'
  | 'quiet'
  | 'checking'
  | 'failed'
  | 'not-downloading';

export type FollowingTone = 'info' | 'neutral' | 'warning';

/** The Kind filter value for each row kind. */
export const KIND_FILTER: Record<FollowKind, Exclude<FollowKindFilter, 'all'>> = {
  artist: 'artists',
  label: 'labels',
  podcast: 'podcasts',
  author: 'authors',
};

export interface FollowingRow {
  /** Unique across kinds. */
  key: string;
  kind: FollowKind;
  /** The meta line's first word: Artist, Label, Podcast, Author, Narrator, Series. */
  kindLabel: string;
  name: string;
  image: string;
  /** People (artists, authors, narrators) get round art. */
  round: boolean;
  /** Shown in the square when a label has no art. */
  initials: string;
  /** The rest of the meta line, after the kind. */
  meta: string;
  /** The shorter line a phone shows under the name. */
  phoneMeta: string;
  /** The 260px column: the latest thing, or when it's checked. */
  latest: string;
  latestWarning: boolean;
  status: FollowingStatus;
  statusText: string;
  tone: FollowingTone;
  /** "Open artist", "Open label"… */
  openLabel: string;
  addedAt: number;
  checkedAt: number;
  /** When something last happened: a find, or the follow itself. */
  activityAt: number;
  onWanted: number;
  /** Artist-only filters ("Checked 30+ days ago", "Own settings"). */
  stale: boolean;
  ownSettings: boolean;
  artist?: FollowedRow;
  label?: WatchlistLabel;
  podcast?: WatchlistPodcast;
  author?: AudiobookFollowedAuthor;
}

export interface FollowingContext {
  now: number;
  /** "in about 9 hours": when the artist-and-label check next runs ('' = unknown). */
  nextArtistCheck: string;
  nextPodcastCheck: string;
  nextAuthorCheck: string;
  /** The followed artist being checked right now, lower-cased ('' = none). */
  checkingArtist: string;
}

function lower(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function firstCheck(when: string): string {
  return when ? `First check ${when}` : 'First check at the next scheduled check';
}

function checked(ms: number, now: number): string {
  return `Checked ${relativeAgo(ms, now)}`;
}

// ── artists ─────────────────────────────────────────────────────────────────

export function artistRow(
  row: FollowedRow,
  ctx: FollowingContext,
  audiobook = false,
): FollowingRow {
  const latest = followedLatest(row, ctx.now);
  const checkedAt = serverTime(row.artist.last_scan_timestamp);
  const addedAt = serverTime(row.artist.date_added);
  const foundAt = serverTime(row.summary?.last_found?.found_at ?? null);
  const checking = Boolean(ctx.checkingArtist) && lower(row.name) === ctx.checkingArtist;
  let latestText = latest
    ? `${latest.label}: ${latest.album}${latest.when ? ` · ${latest.when}` : ''}`
    : '';
  if (latest?.label === 'Last found' && row.summary?.last_found?.added_to_wanted) {
    latestText += ' · on Wanted';
  }
  if (!latestText && row.status === 'unchecked') latestText = firstCheck(ctx.nextArtistCheck);
  const status: FollowingStatus = checking ? 'checking' : row.status;
  const statusText = checking
    ? 'Checking'
    : row.status === 'new'
      ? 'New release'
      : row.status === 'unchecked'
        ? 'Not checked yet'
        : 'Nothing new';
  return {
    key: `artist:${row.artist.id}`,
    kind: 'artist',
    kindLabel: 'Artist',
    name: row.name,
    image: row.image,
    round: true,
    initials: '',
    meta: followedMeta(row, audiobook),
    phoneMeta: [
      row.summary ? `${row.summary.library_releases} in your library` : '',
      latest ? `${latest.label}: ${latest.album}` : '',
      audiobook ? 'Filed as audiobooks' : '',
    ]
      .filter(Boolean)
      .join(' · '),
    latest: checking ? 'Checking…' : latestText,
    latestWarning: false,
    status,
    statusText,
    tone: status === 'new' || status === 'checking' ? 'info' : 'neutral',
    openLabel: 'Open artist',
    addedAt,
    checkedAt,
    activityAt: Math.max(foundAt, addedAt),
    onWanted: row.onWanted,
    stale: row.stale,
    ownSettings: row.ownSettings,
    artist: row,
  };
}

// ── labels ──────────────────────────────────────────────────────────────────

/** What's on Wanted from each label's check, newest first, by label id. */
export function wantedByLabel(items: WantedItem[]): Map<string, WantedItem[]> {
  const out = new Map<string, WantedItem[]>();
  for (const item of items) {
    if (item.sourceType !== 'watchlist_label') continue;
    const info = item.sourceInfo ?? {};
    const id = typeof info.label_mbid === 'string' ? info.label_mbid.trim() : '';
    const name = typeof info.label_name === 'string' ? lower(info.label_name) : '';
    for (const key of [id, name ? `name:${name}` : ''].filter(Boolean)) {
      const list = out.get(key) ?? [];
      list.push(item);
      out.set(key, list);
    }
  }
  for (const list of out.values()) {
    list.sort((a, b) => serverTime(b.addedAt) - serverTime(a.addedAt));
  }
  return out;
}

export function labelRow(
  label: WatchlistLabel,
  fromLabels: Map<string, WantedItem[]>,
  ctx: FollowingContext,
): FollowingRow {
  const name = label.label_name || 'Label';
  const items =
    fromLabels.get(String(label.musicbrainz_label_id ?? '').trim()) ??
    fromLabels.get(`name:${lower(name)}`) ??
    [];
  const newest = items[0];
  const newestAt = newest ? serverTime(newest.addedAt) : 0;
  const checkedAt = serverTime(label.last_scan_timestamp);
  const addedAt = serverTime(label.date_added);
  const status: FollowingStatus = !checkedAt
    ? 'unchecked'
    : newestAt && ctx.now - newestAt < NEW_DAYS * DAY
      ? 'new'
      : 'quiet';
  const meta = [
    items.length > 0 ? `${items.length} on Wanted` : '',
    !checkedAt && addedAt ? `followed ${relativeAgo(addedAt, ctx.now)}` : '',
    label.backlog ? 'the whole catalogue' : 'new releases only',
  ].filter(Boolean);
  const latest = newest
    ? `Latest: ${newest.album || newest.title} · ${relativeAgo(newestAt, ctx.now)} · on Wanted`
    : checkedAt
      ? checked(checkedAt, ctx.now)
      : firstCheck(ctx.nextArtistCheck);
  return {
    key: `label:${label.musicbrainz_label_id || label.id}`,
    kind: 'label',
    kindLabel: 'Label',
    name,
    image: '',
    round: false,
    initials: initials(name),
    meta: meta.join(' · '),
    phoneMeta: items.length > 0 ? `${items.length} on Wanted` : '',
    latest,
    latestWarning: false,
    status,
    statusText:
      status === 'new' ? 'New release' : status === 'unchecked' ? 'Not checked yet' : 'Nothing new',
    tone: status === 'new' ? 'info' : 'neutral',
    openLabel: 'Open label',
    addedAt,
    checkedAt,
    activityAt: Math.max(newestAt, addedAt),
    onWanted: items.length,
    stale: false,
    ownSettings: false,
    label,
  };
}

// ── podcasts ────────────────────────────────────────────────────────────────

export function podcastRow(
  podcast: WatchlistPodcast,
  summary: PodcastSummaryEntry | undefined,
  ctx: FollowingContext,
): FollowingRow {
  const name = podcast.title || 'Podcast';
  const checkedAt = serverTime(podcast.last_scan_timestamp ?? null);
  const addedAt = serverTime(podcast.date_added ?? null);
  const latestEpisode = summary?.latest_episode ?? null;
  const latestAt = latestEpisode ? serverTime(latestEpisode.downloaded_at) : 0;
  const kept = summary?.kept ?? 0;
  const retention = podcast.retention_days ?? 14;
  const status: FollowingStatus = !checkedAt
    ? 'unchecked'
    : summary?.new_episode
      ? 'new'
      : !podcast.auto_download
        ? 'not-downloading'
        : 'quiet';
  const meta = [
    podcast.episode_count ? plural(podcast.episode_count, 'episode') : '',
    kept > 0
      ? `${kept} kept ${retention === 0 ? 'for good' : `for ${plural(retention, 'day')}`}`
      : '',
    podcast.auto_download ? 'new episodes download' : 'new episodes aren’t downloaded',
  ].filter(Boolean);
  const latest = latestEpisode
    ? `Latest: ${latestEpisode.title || 'an episode'} · ${relativeAgo(latestAt, ctx.now)} · downloaded`
    : checkedAt
      ? checked(checkedAt, ctx.now)
      : firstCheck(ctx.nextPodcastCheck);
  return {
    key: `podcast:${podcast.feed_url}`,
    kind: 'podcast',
    kindLabel: 'Podcast',
    name,
    image: podcast.artwork_url ?? '',
    round: false,
    initials: '',
    meta: meta.join(' · '),
    phoneMeta: podcast.episode_count ? plural(podcast.episode_count, 'episode') : '',
    latest,
    latestWarning: false,
    status,
    statusText:
      status === 'new'
        ? 'New episode'
        : status === 'unchecked'
          ? 'Not checked yet'
          : status === 'not-downloading'
            ? 'Not downloading'
            : 'Nothing new',
    tone: status === 'new' ? 'info' : 'neutral',
    openLabel: 'Open podcast',
    addedAt,
    checkedAt,
    activityAt: Math.max(latestAt, addedAt),
    onWanted: 0,
    stale: false,
    ownSettings: false,
    podcast,
  };
}

// ── audiobook authors, narrators and series ─────────────────────────────────

export type AudiobookRole = 'author' | 'narrator' | 'series';

export function audiobookRole(author: { role?: string }): AudiobookRole {
  return author.role === 'narrator' || author.role === 'series' ? author.role : 'author';
}

const ROLE_LABEL: Record<AudiobookRole, string> = {
  author: 'Author',
  narrator: 'Narrator',
  series: 'Series',
};

/** Audiobook wishlist entries this follow covers, newest first. */
export function booksFor(
  author: AudiobookFollowedAuthor,
  books: AudiobookWishlistEntry[],
): AudiobookWishlistEntry[] {
  const role = audiobookRole(author);
  const name = lower(author.name);
  return books
    .filter((book) => {
      if (role === 'series') return lower(book.series_title) === name;
      const people = role === 'narrator' ? book.narrators : book.authors;
      return (people ?? []).some((person) => lower(person) === name);
    })
    .sort((a, b) => (b.added_at || 0) - (a.added_at || 0));
}

const ON_WANTED = new Set(['wanted', 'searching', 'grabbed', 'failed']);

function bookWhere(book: AudiobookWishlistEntry): string {
  if (book.status === 'done') return 'downloaded';
  if (book.status === 'grabbed') return 'downloading';
  if (book.status === 'cancelled') return 'removed from Wanted';
  return 'on Wanted';
}

export function authorRow(
  author: AudiobookFollowedAuthor,
  books: AudiobookWishlistEntry[],
  ctx: FollowingContext,
): FollowingRow {
  const role = audiobookRole(author);
  const theirs = booksFor(author, books);
  const addedAt = (author.added_at || 0) * 1000;
  const checkedAt = (author.last_scanned_at || 0) * 1000;
  const since = String(author.since_date || '');
  // what following them has turned up: books added since the follow,
  // published after its cut-off date (what the check itself takes)
  const found = theirs.filter(
    (book) =>
      (book.added_at || 0) * 1000 >= addedAt &&
      (!since || !book.release_date || book.release_date >= since),
  );
  const newest = found[0];
  const newestAt = newest ? (newest.added_at || 0) * 1000 : 0;
  const onWanted = theirs.filter((book) => ON_WANTED.has(book.status)).length;
  const failed = Boolean(author.last_error);
  const status: FollowingStatus = !checkedAt
    ? 'unchecked'
    : failed
      ? 'failed'
      : newestAt && ctx.now - newestAt < NEW_DAYS * DAY
        ? 'new'
        : 'quiet';
  const meta = [
    author.found_total > 0 ? `${author.found_total} found since you followed` : '',
    onWanted > 0 ? `${onWanted} on Wanted` : '',
    author.auto_wishlist === 0 ? 'new books are only recorded' : '',
  ].filter(Boolean);
  const latest = failed
    ? `Last check failed: ${author.last_error}`
    : newest
      ? `Latest: ${newest.title} · ${relativeAgo(newestAt, ctx.now)} · ${bookWhere(newest)}`
      : checkedAt
        ? checked(checkedAt, ctx.now)
        : firstCheck(ctx.nextAuthorCheck);
  return {
    key: `author:${role}:${author.name}`,
    kind: 'author',
    kindLabel: ROLE_LABEL[role],
    name: author.name,
    image: author.cover_url || '',
    round: role !== 'series',
    initials: '',
    meta: meta.join(' · '),
    phoneMeta: onWanted > 0 ? `${onWanted} on Wanted` : '',
    latest,
    latestWarning: failed,
    status,
    statusText:
      status === 'new'
        ? 'New release'
        : status === 'unchecked'
          ? 'Not checked yet'
          : status === 'failed'
            ? 'Check failed'
            : 'Nothing new',
    tone: status === 'new' ? 'info' : status === 'failed' ? 'warning' : 'neutral',
    openLabel: `Open ${ROLE_LABEL[role].toLowerCase()}`,
    addedAt,
    checkedAt,
    activityAt: Math.max(newestAt, addedAt),
    onWanted,
    stale: false,
    ownSettings: false,
    author,
  };
}

// ── the list ────────────────────────────────────────────────────────────────

export function kindCounts(rows: FollowingRow[]): Record<FollowKindFilter, number> {
  const counts: Record<FollowKindFilter, number> = {
    all: rows.length,
    artists: 0,
    labels: 0,
    podcasts: 0,
    authors: 0,
  };
  for (const row of rows) counts[KIND_FILTER[row.kind]] += 1;
  return counts;
}

export function statusCounts(rows: FollowingRow[]) {
  const count = (test: (row: FollowingRow) => boolean) => rows.filter(test).length;
  return {
    all: rows.length,
    new: count((row) => row.status === 'new'),
    unchecked: count((row) => row.status === 'unchecked'),
    quiet: count((row) => row.status === 'quiet'),
    stale: count((row) => row.stale),
    ownSettings: count((row) => row.ownSettings),
  };
}

export function ofKind(rows: FollowingRow[], kind: FollowKindFilter): FollowingRow[] {
  return kind === 'all' ? rows : rows.filter((row) => KIND_FILTER[row.kind] === kind);
}

function matchesQuery(row: FollowingRow, needle: string): boolean {
  if (!needle) return true;
  const extra = row.podcast ? `${row.podcast.author ?? ''} ${row.podcast.description ?? ''}` : '';
  return `${row.name} ${extra}`.toLowerCase().includes(needle);
}

export function filterFollowing(
  rows: FollowingRow[],
  filter: FollowedFilter,
  query = '',
): FollowingRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === 'new' && row.status !== 'new') return false;
    if (filter === 'unchecked' && row.status !== 'unchecked') return false;
    if (filter === 'quiet' && row.status !== 'quiet') return false;
    if (filter === 'stale' && !row.stale) return false;
    if (filter === 'own-settings' && !row.ownSettings) return false;
    return matchesQuery(row, needle);
  });
}

function byName(a: FollowingRow, b: FollowingRow): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

export function sortFollowing(rows: FollowingRow[], sort: FollowedSort): FollowingRow[] {
  const out = [...rows];
  switch (sort) {
    case 'name-asc':
      return out.sort(byName);
    case 'name-desc':
      return out.sort((a, b) => byName(b, a));
    case 'scan-oldest':
      return out.sort((a, b) => a.checkedAt - b.checkedAt || byName(a, b));
    case 'scan-newest':
      return out.sort((a, b) => b.checkedAt - a.checkedAt || byName(a, b));
    case 'added-newest':
      return out.sort((a, b) => b.addedAt - a.addedAt || byName(a, b));
    default:
      return out.sort((a, b) => b.activityAt - a.activityAt || byName(a, b));
  }
}
