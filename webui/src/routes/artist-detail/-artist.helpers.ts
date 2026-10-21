import type { WishlistApiTrack } from '../wanted/-wanted.helpers';
import type { WatchlistArtist } from '../watchlist/-watchlist.types';

import { parseWantedTrack } from '../wanted/-wanted.helpers';
import { WL_FAILING_ATTEMPTS } from '../wishlist/-wishlist.types';
import {
  releaseYearText,
  musicbrainzReleaseUrl,
  releaseBackgroundSrc,
} from './-artist-detail.card';
import {
  type DiscographyFilterState,
  isMusicBrainzDiscography,
  releaseFlags,
} from './-artist-detail.filters';
import { buildHeroBadges } from './-artist-detail.hero';
import {
  type ArtistInfo,
  type Discography,
  type DiscographyBucket,
  type DiscographyRelease,
  type ReleaseFilter,
} from './-artist-detail.types';

/**
 * The Artist page (Artist v2, boards 2g and 2h), as pure functions over the
 * data the page already loads:
 *
 *   - releases: GET /api/artist-detail (the metadata provider's discography,
 *     or the library's own albums when the provider fails), with ownership
 *     from the library completion stream;
 *   - Wanted: /api/wishlist/tracks (both categories), matched to a release by
 *     album id or title;
 *   - quality: GET /api/quality/artist/<id>, joined on the library album the
 *     completion stream matched;
 *   - following: /api/watchlist/check, and the followed row from
 *     /api/watchlist/artists for "since" and its settings.
 */

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

export type ReleaseKind = 'album' | 'ep' | 'single' | 'compilation';

const KIND_LABEL: Record<ReleaseKind, string> = {
  album: 'Album',
  ep: 'EP',
  single: 'Single',
  compilation: 'Compilation',
};

export interface ArtistRelease {
  /** Unique on the page: bucket, position and id (a source can repeat an id). */
  key: string;
  /** The provider's release id (what Add to Wanted and the tracklist need). */
  id: string;
  title: string;
  bucket: DiscographyBucket;
  kind: ReleaseKind;
  year: string;
  /** Sort key: the release date in ms, 0 when unknown. */
  date: number;
  releaseDate: string;
  /** The release's track count, when anything said. */
  trackCount: number | null;
  image: string;
  /** true in the library (fully or partly), false not, null still being checked. */
  owned: boolean | null;
  ownedTracks: number;
  totalTracks: number;
  libraryAlbumId: string | null;
  /** The library's formats for it, from the completion check ("FLAC", "MP3-320"). */
  formats: string[];
  /** Gap-fill: listed only by another source (#1067). */
  gapSource: string | null;
  musicbrainzUrl: string | null;
  /** Following would skip it (live, remix…), from the completion check. */
  watchlistExcluded: string | null;
  isLive: boolean;
  isCompilation: boolean;
  isFeatured: boolean;
  raw: DiscographyRelease;
}

/** A string or number as text; anything else is ''. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function positive(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The section a release sits in. Compilations keep their own word. */
export function releaseKind(release: DiscographyRelease, bucket: DiscographyBucket): ReleaseKind {
  const type = text(release.album_type).toLowerCase();
  if (type === 'compilation' || type === 'compile') return 'compilation';
  if (bucket === 'eps') return 'ep';
  if (bucket === 'singles') return type === 'ep' ? 'ep' : 'single';
  if (type === 'ep') return 'ep';
  if (type === 'single') return 'single';
  return 'album';
}

export function kindLabel(kind: ReleaseKind): string {
  return KIND_LABEL[kind];
}

function releaseDateMs(release: DiscographyRelease, year: string): number {
  const raw = text(release.release_date);
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(raw);
  if (match) {
    const ms = Date.UTC(
      Number(match[1]),
      match[2] ? Number(match[2]) - 1 : 0,
      match[3] ? Number(match[3]) : 1,
    );
    if (Number.isFinite(ms)) return ms;
  }
  return year ? Date.UTC(Number(year), 0, 1) : 0;
}

/** Every release in the discography, flattened, with what the cards need. */
export function buildReleases(discography: Discography, now: Date = new Date()): ArtistRelease[] {
  const isMusicBrainz = isMusicBrainzDiscography(discography.source);
  const out: ArtistRelease[] = [];
  for (const bucket of ['albums', 'eps', 'singles'] as const) {
    (discography[bucket] ?? []).forEach((release, index) => {
      const id = text(release.id);
      const title = text(release.title) || text(release.name) || 'Untitled release';
      const year = releaseYearText(release, now);
      const completion = release.track_completion as
        | { owned_tracks?: number; total_tracks?: number }
        | number
        | string
        | undefined;
      const ownedTracks =
        completion && typeof completion === 'object' ? positive(completion.owned_tracks) : 0;
      const completionTotal =
        completion && typeof completion === 'object' ? positive(completion.total_tracks) : 0;
      const cardTotal =
        positive(release.track_count) ||
        positive(release.total_tracks) ||
        positive(release.total_track_count);
      const flags = releaseFlags(release, isMusicBrainz);
      const libraryAlbumId = release.library_album_id;
      out.push({
        key: `${bucket}-${index}-${id}`,
        id,
        title,
        bucket,
        kind: releaseKind(release, bucket),
        year,
        date: releaseDateMs(release, year),
        releaseDate: text(release.release_date),
        trackCount: completionTotal || cardTotal || null,
        image: releaseBackgroundSrc(release) ?? '',
        owned: release.owned === undefined ? null : (release.owned as boolean | null),
        ownedTracks,
        totalTracks: completionTotal || cardTotal,
        libraryAlbumId:
          libraryAlbumId === undefined || libraryAlbumId === null || libraryAlbumId === ''
            ? null
            : text(libraryAlbumId),
        formats: Array.isArray(release.library_formats)
          ? (release.library_formats as unknown[]).map(String)
          : [],
        gapSource: release._gap_source ? text(release._gap_source) : null,
        musicbrainzUrl: musicbrainzReleaseUrl(release),
        watchlistExcluded: release.watchlist_excluded ? text(release.watchlist_excluded) : null,
        isLive: flags.isLive,
        isCompilation: flags.isCompilation,
        isFeatured: flags.isFeatured,
        raw: release,
      });
    });
  }
  return out;
}

function isAlbumKind(kind: ReleaseKind): boolean {
  return kind === 'album' || kind === 'compilation';
}

/** Albums newest first, then EPs and singles newest first (the board's order). */
export function orderReleases(releases: ArtistRelease[]): ArtistRelease[] {
  const byDate = (a: ArtistRelease, b: ArtistRelease) =>
    b.date - a.date || a.title.localeCompare(b.title);
  return [
    ...releases.filter((r) => isAlbumKind(r.kind)).sort(byDate),
    ...releases.filter((r) => !isAlbumKind(r.kind)).sort(byDate),
  ];
}

/**
 * What "More filters…" can switch off, carried over from the old page's
 * filter bar: release types, live / compilations / featured, and the
 * MusicBrainz declutter (non-studio releases hidden unless owned).
 */
export type ContentOptions = DiscographyFilterState;

/** The releases under "All": the old page's type and content filters applied. */
export function shownReleases(releases: ArtistRelease[], options: ContentOptions): ArtistRelease[] {
  return releases.filter((release) => {
    if (!options.categories[release.bucket]) return false;
    // the MusicBrainz declutter never hides something you own
    const exempt = options.mbDeclutter && release.owned === true;
    if (exempt) return true;
    if (!options.content.live && release.isLive) return false;
    if (!options.content.compilations && release.isCompilation) return false;
    if (!options.content.featured && release.isFeatured) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Wanted
// ---------------------------------------------------------------------------

export type WantedStatus = 'searching' | 'not-found';

export interface WantedRelease {
  tracks: number;
  status: WantedStatus;
  tries: number;
}

/** Lowercase, accents and punctuation folded, so titles compare loosely but not fuzzily. */
export function normalizeTitle(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      // letters of any script stay (a Japanese title must not fold to nothing)
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  );
}

export interface ArtistWantedTrack {
  id: string;
  title: string;
  album: string;
  albumId: string;
  tries: number;
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

function artistNames(artists: unknown): string[] {
  if (!Array.isArray(artists)) return [];
  return artists
    .map((a) =>
      typeof a === 'string'
        ? a
        : a && typeof a === 'object'
          ? text((a as { name?: unknown }).name)
          : '',
    )
    .filter(Boolean);
}

/**
 * This artist's tracks on Wanted. A track counts when any credited artist is
 * this one (a feature lists them second), on the track or on its album.
 */
export function artistWantedTracks(
  rows: WishlistApiTrack[],
  artistName: string,
): ArtistWantedTrack[] {
  const want = normalizeTitle(artistName);
  if (!want) return [];
  const out: ArtistWantedTrack[] = [];
  for (const row of rows) {
    const track = parseWantedTrack(row);
    if (!track) continue;
    const data = asObject(row.spotify_data);
    const album = asObject(data?.album);
    const names = [...artistNames(data?.artists), ...artistNames(album?.artists)];
    if (!names.some((name) => normalizeTitle(name) === want)) continue;
    out.push({
      id: track.id,
      title: track.title,
      album: track.album,
      albumId: text(album?.id),
      tries: track.tries,
    });
  }
  return out;
}

/** How many separate things of this artist's are on Wanted (as the Wanted page groups them). */
export function wantedThingCount(tracks: ArtistWantedTrack[]): number {
  const groups = new Set(
    tracks.map((t) => (t.album ? `album:${normalizeTitle(t.album)}` : `track:${t.id}`)),
  );
  return groups.size;
}

/**
 * Which releases have tracks on Wanted, and how the search is going: matched
 * by the album id the track was added with, else by title. "Not found yet"
 * once its most-tried track reaches the slowest retry cadence, as on the
 * Wanted page.
 */
export function wantedByRelease(
  releases: ArtistRelease[],
  tracks: ArtistWantedTrack[],
): Map<string, WantedRelease> {
  const out = new Map<string, WantedRelease>();
  if (tracks.length === 0) return out;
  const byId = new Map<string, ArtistWantedTrack[]>();
  const byTitle = new Map<string, ArtistWantedTrack[]>();
  for (const track of tracks) {
    if (track.albumId) byId.set(track.albumId, [...(byId.get(track.albumId) ?? []), track]);
    const key = normalizeTitle(track.album || track.title);
    if (key) byTitle.set(key, [...(byTitle.get(key) ?? []), track]);
  }
  for (const release of releases) {
    const matched = new Map<string, ArtistWantedTrack>();
    for (const t of byId.get(release.id) ?? []) matched.set(t.id, t);
    for (const t of byTitle.get(normalizeTitle(release.title)) ?? []) matched.set(t.id, t);
    if (matched.size === 0) continue;
    const tries = Math.max(...[...matched.values()].map((t) => t.tries));
    out.set(release.key, {
      tracks: matched.size,
      tries,
      status: tries >= WL_FAILING_ATTEMPTS ? 'not-found' : 'searching',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Card states
// ---------------------------------------------------------------------------

export type CardState =
  | { kind: 'checking' }
  | { kind: 'owned'; below: number }
  | { kind: 'partial'; owned: number; total: number; wanted: WantedRelease | null }
  | { kind: 'wanted'; wanted: WantedRelease }
  | { kind: 'missing' };

export interface QualityAlbum {
  id: string;
  tracks: number;
  below_target: number;
  formats: string[];
}

/** A release just sent to Wanted reads as wanted until the list says so. */
const PENDING_WANTED: WantedRelease = { tracks: 0, tries: 0, status: 'searching' };

/**
 * One card's state, in the words Wanted uses: In your library (or Below
 * quality target), a partly complete album with its progress, Wanted ·
 * Searching / not found yet, or nothing yet (Add to Wanted).
 */
export function cardState(
  release: ArtistRelease,
  wanted: WantedRelease | undefined,
  quality: Map<string, QualityAlbum> | null,
  pending: boolean,
): CardState {
  const want = wanted ?? (pending ? PENDING_WANTED : undefined);
  if (release.owned === true) {
    const total = release.totalTracks;
    const complete = total <= 0 || release.ownedTracks <= 0 || release.ownedTracks >= total;
    if (!complete) {
      return { kind: 'partial', owned: release.ownedTracks, total, wanted: want ?? null };
    }
    const album = release.libraryAlbumId ? quality?.get(release.libraryAlbumId) : undefined;
    return { kind: 'owned', below: album?.below_target ?? 0 };
  }
  if (want) return { kind: 'wanted', wanted: want };
  if (release.owned === null) return { kind: 'checking' };
  return { kind: 'missing' };
}

/** What the tag says. Phone copy is shorter, as on board 2h. */
export function cardTag(
  state: CardState,
  short = false,
): { text: string; tone: 'success' | 'warning' | 'info' | 'neutral'; live?: boolean } | null {
  switch (state.kind) {
    case 'checking':
      return { text: short ? 'Checking…' : 'Checking your library…', tone: 'neutral' };
    case 'owned':
      return state.below > 0
        ? { text: short ? 'Below target' : 'Below quality target', tone: 'warning' }
        : { text: short ? 'In library' : 'In your library', tone: 'success' };
    case 'partial': {
      const count = `${state.owned} of ${state.total}`;
      if (state.wanted?.status === 'searching')
        return { text: short ? count : `${count} · Searching`, tone: 'info' };
      if (state.wanted?.status === 'not-found')
        return { text: short ? count : `${count} · not found yet`, tone: 'neutral' };
      return { text: short ? count : `${count} in your library`, tone: 'neutral' };
    }
    case 'wanted':
      return state.wanted.status === 'not-found'
        ? { text: 'Wanted · not found yet', tone: 'neutral' }
        : { text: 'Wanted · Searching', tone: 'info' };
    case 'missing':
      return null;
  }
}

/** Whether the card offers Add to Wanted (nothing of it owned or wanted, or a part missing). */
export function canAddToWanted(state: CardState): boolean {
  return state.kind === 'missing' || (state.kind === 'partial' && !state.wanted);
}

/** "FLAC", "MP3 320" — the library's format for a release, as the board writes it. */
export function formatLabel(formats: string[]): string {
  const labels = [...new Set(formats.map((f) => f.replace(/^MP3-(\d+)$/, 'MP3 $1')))];
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels[0]} and ${labels.length - 1} more`;
}

/** "2026 · Album · 12 tracks · FLAC" (phones: "2026 · Album · FLAC"). */
export function releaseMeta(release: ArtistRelease, state: CardState, short = false): string {
  const parts = [release.year, kindLabel(release.kind)];
  const count = release.trackCount;
  if (!short && count && count > 1) parts.push(`${count} tracks`);
  if (!short && count === 1 && release.kind !== 'single') parts.push('1 track');
  // the format of what you have, for a release you have whole (the board
  // leaves it off a partly complete one)
  if (state.kind === 'owned') {
    const format = formatLabel(release.formats);
    if (format) parts.push(format);
  }
  return parts.filter(Boolean).join(' · ');
}

/** The release filters: Albums are albums and compilations; Missing is anything not fully in the library. */
export function filterReleases(
  releases: ArtistRelease[],
  filter: ReleaseFilter,
  stateOf: (release: ArtistRelease) => CardState,
): ArtistRelease[] {
  if (filter === 'albums') return releases.filter((r) => isAlbumKind(r.kind));
  if (filter === 'missing')
    return releases.filter((r) => {
      const state = stateOf(r);
      return state.kind === 'missing' || state.kind === 'partial' || state.kind === 'wanted';
    });
  return releases;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export interface HeaderCounts {
  releases: number;
  inLibrary: number;
  onWanted: number;
  /** Library tracks (null for an artist who isn't in the library). */
  tracks: number | null;
  /** Some releases are still being checked against the library. */
  checking: boolean;
}

export function headerCounts(
  releases: ArtistRelease[],
  states: Map<string, CardState>,
  libraryTracks: number | null,
): HeaderCounts {
  let inLibrary = 0;
  let onWanted = 0;
  let checking = false;
  for (const release of releases) {
    const state = states.get(release.key);
    if (!state) continue;
    if (state.kind === 'owned' || state.kind === 'partial') inLibrary += 1;
    if (state.kind === 'wanted' || (state.kind === 'partial' && state.wanted)) onWanted += 1;
    if (state.kind === 'checking') checking = true;
  }
  return { releases: releases.length, inLibrary, onWanted, tracks: libraryTracks, checking };
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** "14 releases · 9 in your library · 5 on Wanted · 132 tracks"; phones get the 2h short form. */
export function countsLine(counts: HeaderCounts, sourceOnly: boolean, short = false): string {
  const parts = [plural(counts.releases, 'release')];
  if (sourceOnly) {
    parts.push(short ? 'not in library' : 'not in your library');
  } else if (counts.checking && counts.inLibrary === 0) {
    parts.push(short ? 'checking library…' : 'checking your library…');
  } else {
    parts.push(short ? `${counts.inLibrary} in library` : `${counts.inLibrary} in your library`);
  }
  parts.push(short ? `${counts.onWanted} wanted` : `${counts.onWanted} on Wanted`);
  if (!short && counts.tracks !== null && counts.tracks > 0)
    parts.push(plural(counts.tracks, 'track'));
  return parts.join(' · ');
}

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

/** "March 2026" from "2026-03-02" / "2026-03" / a timestamp; "2026" when only the year is known. */
export function monthYearLong(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  const match = /^(\d{4})(?:-(\d{2}))?/.exec(raw);
  if (!match) return '';
  const month = match[2] ? Number(match[2]) : 0;
  return month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${match[1]}` : match[1];
}

/** The newest release with a date (an undated one only when nothing has a date). */
export function latestRelease(releases: ArtistRelease[]): ArtistRelease | null {
  let best: ArtistRelease | null = null;
  for (const release of releases) {
    if (!best || release.date > best.date) best = release;
  }
  return best;
}

/** "Tidewater, March 2026". */
export function latestText(release: ArtistRelease): string {
  const when = monthYearLong(release.releaseDate) || release.year;
  return when ? `${release.title}, ${when}` : release.title;
}

/** The artist's pages on the services SoulSync matched them to, linkable ones only. */
export function sourceLinks(artist: ArtistInfo): { key: string; label: string; url: string }[] {
  return buildHeroBadges(artist)
    .filter((badge): badge is typeof badge & { url: string } => Boolean(badge.url))
    .map((badge) => ({ key: badge.key, label: badge.title, url: badge.url }));
}

/** Provider id columns on a followed-artist row, and the artist page's matching fields. */
const FOLLOW_ID_FIELDS: [keyof WatchlistArtist, string][] = [
  ['spotify_artist_id', 'spotify_artist_id'],
  ['itunes_artist_id', 'itunes_artist_id'],
  ['deezer_artist_id', 'deezer_id'],
  ['discogs_artist_id', 'discogs_id'],
  ['musicbrainz_artist_id', 'musicbrainz_id'],
  ['amazon_artist_id', 'amazon_id'],
];

/**
 * This artist's followed-artist row: by any provider id the two share (or the
 * id the follow button acts on), else by name.
 */
export function findFollowedRow(
  rows: WatchlistArtist[] | undefined,
  artist: ArtistInfo,
  identityId: string | null,
): WatchlistArtist | null {
  if (!rows?.length) return null;
  const ids = new Set<string>();
  if (identityId) ids.add(identityId);
  for (const [, field] of FOLLOW_ID_FIELDS) {
    const value = artist[field];
    if (text(value)) ids.add(text(value));
  }
  const byId = rows.find((row) =>
    FOLLOW_ID_FIELDS.some(([column]) => {
      const value = row[column];
      return value != null && value !== '' && ids.has(String(value));
    }),
  );
  if (byId) return byId;
  const name = normalizeTitle(text(artist.name));
  return name ? (rows.find((row) => normalizeTitle(row.artist_name) === name) ?? null) : null;
}

/** "Following since March 2025", or just "Following" when the date isn't known. */
export function followingText(row: WatchlistArtist | null): string {
  const since = monthYearLong(row?.date_added ?? null);
  return since ? `Following since ${since}` : 'Following';
}

// ---------------------------------------------------------------------------
// Add to Wanted outcomes
// ---------------------------------------------------------------------------

export interface AddUpdate {
  album_id?: unknown;
  name?: string;
  status?: string;
  message?: string;
  tracks_added?: number;
  tracks_skipped?: number;
  tracks_skipped_owned?: number;
  tracks_skipped_filter?: number;
  tracks_skipped_artist?: number;
}

/**
 * What one release's add came to. `ok` is false when nothing of it is on
 * Wanted afterwards (it failed, or every track was skipped), so the card goes
 * back to "Add to Wanted" and the reason is said.
 */
export function addOutcome(update: AddUpdate): { ok: boolean; reason: string } {
  if (update.status === 'error') {
    return { ok: false, reason: update.message || "the release couldn't be looked up" };
  }
  const added = update.tracks_added ?? 0;
  const queued = update.tracks_skipped ?? 0;
  if (added > 0 || queued > 0) return { ok: true, reason: '' };
  if ((update.tracks_skipped_owned ?? 0) > 0)
    return { ok: false, reason: 'you already have every track' };
  if ((update.tracks_skipped_filter ?? 0) > 0)
    return { ok: false, reason: 'your release filters leave its tracks out' };
  if ((update.tracks_skipped_artist ?? 0) > 0)
    return { ok: false, reason: 'its tracks are credited to other artists' };
  return { ok: false, reason: 'the source listed no tracks for it' };
}
