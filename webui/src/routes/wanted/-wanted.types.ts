import { z } from 'zod';

import { WATCHLIST_SORT_VALUES, type WatchlistSort } from '../watchlist/-watchlist.types';

// ---------------------------------------------------------------------------
// Search params
// ---------------------------------------------------------------------------

export const WANTED_TABS = ['wanted', 'followed'] as const;
export type WantedTab = (typeof WANTED_TABS)[number];

/**
 * The Wanted tab's Show filters: one per step of a wanted song's journey
 * (Waiting → Searching → Downloading → Needs your decision → Not found →
 * Got it). Searching is `searching-now` (a search running now). An old
 * `?filter=searching` meant "fewer than three tries", which is Waiting now,
 * so it resolves to Waiting; `not-found` and `found` keep their meaning.
 */
export const WANTED_FILTERS = [
  'all',
  'waiting',
  'searching-now',
  'downloading',
  'decision',
  'not-found',
  'found',
] as const;
export type WantedFilter = (typeof WANTED_FILTERS)[number];

/**
 * The Following tab's Show filters (HANDOFF answer 7): New release, Not
 * checked yet, Nothing new. "Checked 30+ days ago" and "Own settings" are
 * artist-only extras, offered under Kind → Artists.
 */
export const FOLLOWED_FILTERS = [
  'all',
  'new',
  'unchecked',
  'quiet',
  'stale',
  'own-settings',
] as const;
export type FollowedFilter = (typeof FOLLOWED_FILTERS)[number];

/** The Following tab's Kind row (board 5e). "Authors" holds every audiobook
 *  follow: authors, narrators and series. */
export const FOLLOW_KINDS = ['all', 'artists', 'labels', 'podcasts', 'authors'] as const;
export type FollowKindFilter = (typeof FOLLOW_KINDS)[number];

/** "Needs you first" is the default (the Wanted journey's board 1); the
 *  others keep their old values, so an old ?sort= link means the same. */
export const WANTED_SORTS = ['needs-you', 'newest', 'oldest', 'most-tries', 'artist'] as const;
export type WantedSort = (typeof WANTED_SORTS)[number];

/** The Following tab's sorts: newest activity first (the default, board 5e),
 *  then the watchlist page's values, so an old /watchlist?sort= link means
 *  the same thing after the redirect. */
export const FOLLOWED_SORTS = ['activity', ...WATCHLIST_SORT_VALUES] as const;
export type FollowedSort = 'activity' | WatchlistSort;

/** The old Watchlist's other tabs (?list=), now a Kind on the Following tab. */
export const FOLLOWED_LISTS = ['labels', 'podcasts', 'audiobooks'] as const;
export type FollowedList = (typeof FOLLOWED_LISTS)[number];

/** Where an old ?list= link lands on the Kind row. */
export const LIST_TO_KIND: Record<FollowedList, Exclude<FollowKindFilter, 'all' | 'artists'>> = {
  labels: 'labels',
  podcasts: 'podcasts',
  audiobooks: 'authors',
};

/** Rows per page; "Show 50 more" adds one page. */
export const PAGE_SIZE = 50;

/**
 * Coerce a raw search value to a string. TanStack JSON-parses search values,
 * so an all-digits value arrives as a NUMBER, and a hand-edited `?q[]=x` as an
 * object, which must read as absent rather than "[object Object]".
 */
export function searchString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  const text = searchString(value);
  return text ? text : undefined;
}

function optionalPage(value: unknown): number | undefined {
  const page = Number(value);
  return Number.isInteger(page) && page > 1 && page < 10_000 ? page : undefined;
}

/**
 * Every field is optional and a default is left out of the URL: /wanted is the
 * Wanted tab, All, newest first, first page. `filter` and `sort` are read per
 * tab (see resolveWantedFilter and friends), so a value from the other tab
 * falls back to the default instead of failing the route.
 */
export const wantedSearchSchema = z.object({
  tab: z.enum(WANTED_TABS).optional().catch(undefined),
  filter: z.preprocess(optionalString, z.string().optional()).catch(undefined),
  sort: z.preprocess(optionalString, z.string().optional()).catch(undefined),
  page: z.preprocess(optionalPage, z.number().optional()).catch(undefined),
  q: z.preprocess(optionalString, z.string().optional()).catch(undefined),
  /** The Wanted tab drawn as the artist nebula instead of the list. */
  view: z.enum(['nebula']).optional().catch(undefined),
  /** The Wanted tab's From filter: where wanted things came from (see sourceKey). */
  from: z.preprocess(optionalString, z.string().optional()).catch(undefined),
  /** Songs or Sources; absent, the profile's last choice in this browser. */
  browse: z.enum(['songs', 'sources']).optional().catch(undefined),
  /** One source's page under Sources (board 3), by its From key. */
  source: z.preprocess(optionalString, z.string().optional()).catch(undefined),
  /** The Wanted tab's audiobooks (the old Wishlist → Audiobooks tab). */
  media: z.enum(['audiobooks']).optional().catch(undefined),
  /** The Following tab's Kind row. */
  kind: z.enum(FOLLOW_KINDS).optional().catch(undefined),
  /** An old link to a Watchlist tab other than artists; read as `kind`. */
  list: z.enum(FOLLOWED_LISTS).optional().catch(undefined),
  /** Which followed artist's settings or profile is open, by provider id. */
  configId: z.preprocess(optionalString, z.string().optional()).catch(undefined),
  detailId: z.preprocess(optionalString, z.string().optional()).catch(undefined),
  /** Followed artist settings (the old watchlist global settings). */
  settings: z
    .preprocess((v) => (v === true || v === 'true' ? true : undefined), z.boolean().optional())
    .catch(undefined),
});

export type WantedSearch = z.infer<typeof wantedSearchSchema>;

export function resolveTab(search: Pick<WantedSearch, 'tab'>): WantedTab {
  return search.tab ?? 'wanted';
}

export function resolveWantedFilter(value: string | undefined): WantedFilter {
  if (value === 'searching') return 'waiting';
  return (WANTED_FILTERS as readonly string[]).includes(value ?? '')
    ? (value as WantedFilter)
    : 'all';
}

export function resolveFollowedFilter(value: string | undefined): FollowedFilter {
  return (FOLLOWED_FILTERS as readonly string[]).includes(value ?? '')
    ? (value as FollowedFilter)
    : 'all';
}

export function resolveWantedSort(value: string | undefined): WantedSort {
  return (WANTED_SORTS as readonly string[]).includes(value ?? '')
    ? (value as WantedSort)
    : 'needs-you';
}

export function resolveFollowedSort(value: string | undefined): FollowedSort {
  return (FOLLOWED_SORTS as readonly string[]).includes(value ?? '')
    ? (value as FollowedSort)
    : 'activity';
}

export function resolveFollowKind(search: Pick<WantedSearch, 'kind' | 'list'>): FollowKindFilter {
  if (search.kind) return search.kind;
  return search.list ? LIST_TO_KIND[search.list] : 'all';
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** What a wanted row is: one track, or a release with several wanted tracks. */
export type WantedKind = 'track' | 'album' | 'single' | 'ep';

/** One wishlist row from /api/wishlist/tracks, unpacked. */
export interface WantedTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  /** Spotify-style album_type: album, single, ep, compilation, or ''. */
  albumType: string;
  /** The release's track count, when the source said. */
  albumTotal: number | null;
  image: string;
  /** SQLite UTC timestamp, '' when unknown. */
  addedAt: string;
  tries: number;
  lastTried: string;
  /** Why the last try failed; only meaningful once tries > 0. */
  lastError: string;
  sourceType: string;
  sourceInfo: Record<string, unknown> | null;
  qualityProfileId: number | null;
}

/** Where the scheduled searches have got to: the nebula's two groups. */
export type WantedStatus = 'searching' | 'not-found';

/**
 * Where a wanted song is on its way in (the Wanted journey, board 4):
 * - waiting: wanted, not tried yet, or between tries;
 * - searching: being searched for right now;
 * - downloading: a file is coming in, or being checked and tagged;
 * - decision: downloaded but held back in quarantine, for you to decide;
 * - not-found: three tries or more found nothing (it's still tried, less often).
 * Got it is the found rows.
 */
export type JourneyStatus = 'waiting' | 'searching' | 'downloading' | 'decision' | 'not-found';

/** A song's live state from GET /api/wishlist/journey. */
export interface TrackJourney {
  /** The live download task's status (pending, searching, queued, downloading, post_processing). */
  downloadStatus: string | null;
  downloadPhase: 'searching' | 'downloading' | null;
  /** 0–100 while downloading, when the task says. */
  progress: number | null;
  /** The newest quarantined attempt at it (admins only: a member's read
   *  carries the count, not the entry), and how many there are. */
  quarantineEntry: string | null;
  quarantineCount: number;
  quarantineReason: string;
  /** Which check held it (integrity, acoustid_unverified, bit_depth, quality, silence). */
  quarantineTrigger: string;
  quarantineMatchedBy: string;
}

export interface WantedItem {
  key: string;
  kind: WantedKind;
  title: string;
  artist: string;
  album: string;
  image: string;
  tracks: WantedTrack[];
  trackIds: string[];
  albumTotal: number | null;
  addedAt: string;
  /** The most tries any of its tracks has had. */
  tries: number;
  /** The last failed try's reason, '' when none worth showing. */
  lastError: string;
  sourceType: string;
  sourceInfo: Record<string, unknown> | null;
  qualityProfileId: number | null;
  status: WantedStatus;
  /** The row's one status: its songs', Needs you first (see itemJourney). */
  journey: JourneyStatus;
  /** How many of its songs are at that status. */
  journeyCount: number;
  /** How many of its songs are at each status. */
  trackStates: Record<JourneyStatus, number>;
  /** The newest quarantined attempt at any of its tracks, for the Review link. */
  quarantineEntry: string | null;
  /** How many quarantined attempts there are, across its tracks. */
  quarantineCount: number;
  /** A live task is searching for it right now (not just "will be tried again"). */
  searchingNow: boolean;
}

/** A track Wanted found recently (GET /api/wishlist/found). */
export interface FoundItem {
  key: string;
  id: string;
  title: string;
  artist: string;
  album: string;
  quality: string;
  image: string;
  foundAt: string;
}

export type WantedRow = { type: 'wanted'; item: WantedItem } | { type: 'found'; item: FoundItem };

// ---------------------------------------------------------------------------
// API payloads added for this page
// ---------------------------------------------------------------------------

export interface FoundResponse {
  success?: boolean;
  days?: number;
  count?: number;
  items?: {
    id?: string;
    title?: string;
    artist?: string;
    album?: string;
    quality?: string;
    image?: string;
    found_at?: string | null;
    reason?: string;
  }[];
  error?: string;
}

/** GET /api/wishlist/journey (core/wishlist/journey.py). */
export interface JourneyResponse {
  success?: boolean;
  tracks?: Record<
    string,
    {
      download?: {
        status?: string;
        phase?: string;
        task_id?: string;
        batch_id?: string;
        progress?: number;
      };
      quarantine?: {
        entry_id?: string;
        count?: number;
        reason?: string;
        trigger?: string;
        matched_by?: string;
      };
    }
  >;
  retry?: { name?: string; label?: string; ladder?: Record<string, number>; max_cooldown?: number };
  playlists?: {
    name?: string;
    mirror?: {
      id?: number;
      name?: string;
      source?: string;
      total?: number;
      in_library?: number;
      library_checked?: number;
      library_known?: boolean;
    } | null;
  }[];
  generated_at?: number;
  error?: string;
}

export interface FollowedArtistSummary {
  /** watchlist_artists row id (WatchlistArtist.id). */
  id: number;
  library_releases: number;
  latest_release: { album_name: string; release_date: string | null } | null;
  last_found: { album_name: string; found_at: string; added_to_wanted: boolean } | null;
  new_release: boolean;
}

export interface FollowedSummaryResponse {
  success?: boolean;
  new_release_days?: number;
  artists?: FollowedArtistSummary[];
  error?: string;
}

/** GET /api/podcasts/watchlist/summary: what came in for each followed show. */
export interface PodcastSummaryEntry {
  feed_url: string;
  /** Downloaded episodes still on disk. */
  kept: number;
  latest_episode: { title: string; downloaded_at: string } | null;
  /** The latest was downloaded in the last `new_episode_days` days. */
  new_episode: boolean;
}

export interface PodcastSummaryResponse {
  success?: boolean;
  new_episode_days?: number;
  podcasts?: PodcastSummaryEntry[];
  error?: string;
}

/** A row of GET /api/quality-profile/custom; only what this page reads. */
export interface QualityProfileRow {
  id: number;
  name?: string;
  is_default?: boolean | number;
}

export interface QualityProfilesResponse {
  success?: boolean;
  profiles?: QualityProfileRow[];
  error?: string;
}
