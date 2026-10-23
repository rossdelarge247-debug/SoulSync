import { z } from 'zod';

/**
 * Coerce a raw search value to a string.
 *
 * TanStack JSON-parses search values, so an all-digits query arrives as a
 * NUMBER and a bare `z.string()` would throw SearchParamError and take the
 * route down. Only primitives are stringified — a hand-edited `?q[]=x` parses
 * to an object, which must read as absent rather than "[object Object]".
 */
function searchString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Show filters per grid (boards 7a, 7e, 7f). The first is the default. */
export const ALBUM_SHOWS = ['all', 'library', 'missing', 'below'] as const;
export const GENRE_SHOWS = ['all', 'gaps'] as const;
export const ARTIST_SHOWS = ['all', 'following', 'incomplete'] as const;
export type AlbumShow = (typeof ALBUM_SHOWS)[number];
export type GenreShow = (typeof GENRE_SHOWS)[number];
export type ArtistShow = (typeof ARTIST_SHOWS)[number];

/** Sorts per grid; the first is the default. */
export const ALBUM_SORTS = ['recent', 'artist', 'title', 'year', 'genre'] as const;
export const GENRE_SORTS = ['albums', 'name'] as const;
export const ARTIST_SORTS = ['name', 'recent', 'missing'] as const;
export type AlbumSort = (typeof ALBUM_SORTS)[number];
export type GenreSort = (typeof GENRE_SORTS)[number];
export type ArtistSort = (typeof ARTIST_SORTS)[number];

/** "Show 50 more" adds this many (board 7a's footer). */
export const LIBRARY_PAGE_SIZE = 50;

/** The old grid's sort values, read into the new ones so old links keep their order. */
const LEGACY_SORTS: Record<string, string> = { year_desc: 'year', year_asc: 'year', '': '' };

function optional(value: unknown): string | undefined {
  const s = searchString(value);
  return s === undefined || s === '' ? undefined : s;
}

/**
 * Everything the page shows lives in the URL: which grid, the tab, the Show
 * filter, the genre, the sort and the filter text. Every field is optional and
 * a default is left out, so /library?view=albums stays that short; values a
 * grid doesn't know fall back to its default when read (see `pick`), so a
 * hand-typed or old link never takes the route down.
 */
export const librarySearchSchema = z.object({
  /**
   * Which page: Artists (its own sidebar row, the default), Albums, or
   * Listening history (13a, its own row after Albums).
   */
  view: z
    .preprocess((v) => {
      const s = searchString(v);
      return s === 'albums' || s === 'history' ? s : undefined;
    }, z.enum(['albums', 'history']).optional())
    .catch(undefined),
  /** Listening history's Kind (Music is the default). */
  kind: z
    .preprocess((v) => {
      const s = searchString(v);
      return s === 'podcast' || s === 'audiobook' ? s : undefined;
    }, z.enum(['podcast', 'audiobook']).optional())
    .catch(undefined),
  /** Listening history's Range; absent means the one remembered per browser. */
  range: z
    .preprocess((v) => {
      const s = searchString(v);
      return s === 'today' || s === '7d' || s === '30d' || s === 'all' ? s : undefined;
    }, z.enum(['today', '7d', '30d', 'all']).optional())
    .catch(undefined),
  /** Albums' two tabs (7a, 7e); Albums is the default. */
  tab: z
    .preprocess(
      (v) => (searchString(v) === 'genres' ? 'genres' : undefined),
      z.enum(['genres']).optional(),
    )
    .catch(undefined),
  show: z.preprocess(optional, z.string().optional()).catch(undefined),
  /** A genre's key (lower case). */
  genre: z
    .preprocess((v) => optional(v)?.trim().toLowerCase() || undefined, z.string().optional())
    .catch(undefined),
  sort: z
    .preprocess((v) => {
      const s = optional(v);
      return s === undefined ? undefined : (LEGACY_SORTS[s] ?? s) || undefined;
    }, z.string().optional())
    .catch(undefined),
  /** The filter field: title, artist or genre (names, for Artists). */
  q: z.preprocess(optional, z.string().optional()).catch(undefined),
});

export type LibrarySearchParams = z.infer<typeof librarySearchSchema>;

/** The URL's search with every default filled in, as the page reads it. */
export interface LibrarySearch {
  view: 'artists' | 'albums' | 'history';
  tab: 'albums' | 'genres';
  kind: 'music' | 'podcast' | 'audiobook';
  /** '' when the URL leaves it to the browser's remembered range. */
  range: '' | 'today' | '7d' | '30d' | 'all';
  show: string;
  genre: string;
  sort: string;
  q: string;
}

export function resolveLibrarySearch(raw: LibrarySearchParams): LibrarySearch {
  return {
    view: raw.view ?? 'artists',
    tab: raw.tab ?? 'albums',
    kind: raw.kind ?? 'music',
    range: raw.range ?? '',
    show: raw.show ?? '',
    genre: raw.genre ?? '',
    sort: raw.sort ?? '',
    q: raw.q ?? '',
  };
}

/** A value from the URL, or the grid's default when it isn't one of its own. */
export function pick<T extends string>(value: string, allowed: readonly T[]): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : allowed[0];
}

/**
 * One row from /api/library/artists.
 *
 * The provider id fields each drive one badge on the card; they are all
 * optional because an artist is only enriched by the providers that matched.
 */
export interface LibraryArtist {
  id: string | number;
  name: string;
  image_url?: string | null;
  track_count?: number;
  is_watched?: boolean;
  /** Tracks with a pending quality finding (they could be better). */
  upgradable_count?: number;
  /** Provider ids — each present one adds a badge, in this declaration order. */
  spotify_artist_id?: string | null;
  musicbrainz_id?: string | null;
  deezer_id?: string | number | null;
  audiodb_id?: string | number | null;
  itunes_artist_id?: string | number | null;
  lastfm_url?: string | null;
  genius_url?: string | null;
  tidal_id?: string | number | null;
  qobuz_id?: string | number | null;
  discogs_id?: string | number | null;
  amazon_id?: string | null;
  soul_id?: string | null;
}

export interface LibraryPagination {
  page: number;
  limit: number;
  total_count: number;
  total_pages: number;
  has_prev: boolean;
  has_next: boolean;
}

export interface LibraryArtistsResponse {
  success?: boolean;
  error?: string;
  artists?: LibraryArtist[];
  pagination?: LibraryPagination;
  /** Every track in this library that could be better, whatever the filters. */
  upgradable_total?: number;
}

export interface LibraryAlbum {
  id: string | number;
  title: string;
  year?: number | null;
  thumb_url?: string | null;
  artist_id: string | number;
  artist_name: string;
  track_count?: number;
  spotify_album_id?: string | null;
  musicbrainz_release_id?: string | null;
  deezer_id?: string | number | null;
  audiodb_id?: string | number | null;
  itunes_album_id?: string | number | null;
  lastfm_url?: string | null;
  tidal_id?: string | number | null;
  qobuz_id?: string | number | null;
  discogs_id?: string | number | null;
  jiosaavn_id?: string | null;
  bandcamp_url?: string | null;
  amazon_id?: string | null;
  soul_id?: string | null;
}

export interface LibraryAlbumsResponse {
  success?: boolean;
  error?: string;
  albums?: LibraryAlbum[];
  pagination?: LibraryPagination;
}

/** A resolved badge, ready to render. `url` null means it is not a link. */
export interface ArtistBadge {
  key: string;
  logo: string;
  /** Two/three-letter text shown if the logo image fails to load. */
  fallback: string;
  title: string;
  url: string | null;
}

/** The "these never got matched" banner's payload (#1202). */
export interface UnmatchedSummary {
  success?: boolean;
  /** Tracks currently filed under Unknown Artist; 0 means no banner. */
  count: number;
  /** Library artist row holding the most of them, for the link. */
  artist_id: string | number | null;
}

// ── the release index (GET /api/library/releases, genres, artist-index) ──────

export interface WantedState {
  status: 'searching' | 'not_found';
  tracks: number;
}

/** One release: an album you have, or one of your artists' you don't. */
export interface LibraryRelease {
  /** "album:12" for yours, "release:spotify:abc" / "wanted:…" for the rest. */
  id: string;
  kind: 'library' | 'missing';
  album_id: string | number | null;
  title: string;
  artist_id: string | number | null;
  artist_name: string;
  year: number | null;
  art_url: string | null;
  genres: string[];
  album_type: 'album' | 'ep' | 'single' | 'compilation';
  tracks_total: number | null;
  tracks_owned: number;
  below_target: number;
  format: string | null;
  state: 'owned' | 'partial' | 'below_target' | 'missing';
  wanted: WantedState | null;
  added_at: string | null;
  source: string | null;
  source_id: string | null;
  /** Only when the grid is grouped by genre: the heading it files under. */
  group?: string;
}

export interface GenreCount {
  key: string;
  name: string;
  count: number;
}

export interface LibraryTotals {
  albums: number;
  library: number;
  missing: number;
  below: number;
  tracks: number;
  genres: number;
  artists: number;
  following: number;
  incomplete: number;
}

export interface QualityTarget {
  name?: string | null;
  preset?: string | null;
  quality_profile_id?: number | null;
  quality_profile_name?: string | null;
}

/** What adding a set to Wanted would be. */
export interface AddSummary {
  count: number;
  tracks: number;
  artists: { id: string | number; name: string }[];
  sample: LibraryRelease[];
}

export interface GenreSummary {
  name: string;
  albums: number;
  library: number;
  missing: number;
  below: number;
  wantable: AddSummary;
  below_album_ids: (string | number)[];
}

export interface ReleasesResponse {
  success?: boolean;
  error?: string;
  releases: LibraryRelease[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
  show: AlbumShow;
  sort: AlbumSort;
  genre: string;
  show_counts: Record<AlbumShow, number>;
  genre_total: number;
  genres: GenreCount[];
  totals: LibraryTotals;
  missing_summary: AddSummary;
  genre_summary?: GenreSummary;
  target: QualityTarget;
}

export interface GenreTile {
  key: string;
  name: string;
  albums: number;
  library: number;
  missing: number;
  wantable: number;
  below: number;
  covers: string[];
}

export interface GenresResponse {
  success?: boolean;
  error?: string;
  genres: GenreTile[];
  total: number;
  show_counts: Record<GenreShow, number>;
  totals: LibraryTotals;
  target: QualityTarget;
}

export interface IndexArtist {
  id: string | number;
  name: string;
  image_url: string | null;
  genres: string[];
  following: boolean;
  releases: number;
  in_library: number;
  missing: number;
  wanted: number;
  /** Missing and not on Wanted: what "Add N missing to Wanted" adds. */
  wantable: number;
}

export interface ArtistIndexResponse {
  success?: boolean;
  error?: string;
  artists: IndexArtist[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
  show: ArtistShow;
  sort: ArtistSort;
  genre: string;
  show_counts: Record<ArtistShow, number>;
  genre_total: number;
  genres: GenreCount[];
  totals: LibraryTotals;
}

/** A selection as the bulk routes take it (core/library/release_index.resolve_selection). */
export interface SelectionBody {
  release_ids?: string[];
  filter?: {
    show?: string;
    genre?: string;
    genres?: string[];
    q?: string;
    artist_ids?: (string | number)[];
  };
  exclude_ids?: string[];
  /** The summary route only: how many to list (the confirm's Show all). */
  sample?: number;
}

export interface SelectionSummary extends AddSummary {
  selected: number;
  already_have: number;
  already_wanted: number;
  types: Record<string, number>;
  target: QualityTarget;
  following: (string | number)[];
}

export interface BulkAddResult {
  success?: boolean;
  error?: string;
  message?: string;
  added: number;
  already_wanted: number;
  already_have: number;
  failed: number;
  refused: number;
  tracks_added: number;
  asks_first: boolean;
  followed: { followed: number; already_following: number; no_id: number } | null;
  results: { id: string; title: string; artist_name: string; outcome: string; message: string }[];
}
