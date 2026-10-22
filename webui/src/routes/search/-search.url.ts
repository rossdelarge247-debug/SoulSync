/**
 * What the Search page keeps in its URL: the query, what kind of result to
 * show, and whether the query was submitted, `/search?q=pale+harbour&type=albums&files=1`.
 * Defaults are left out, so a plain `/search` is the empty page and
 * Everything never appears.
 *
 * `files=1` marks a submitted query (Enter, a hand-off, a recent search): only
 * then is the download source searched. Typing searches the library and the
 * metadata service as it settles, but a Soulseek search per pause would hold
 * a server thread each and send partial words to the network.
 */

export const SEARCH_TYPES = ['everything', 'artists', 'albums', 'tracks'] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

export const SEARCH_TYPE_LABELS: Readonly<Record<SearchType, string>> = {
  everything: 'Everything',
  artists: 'Artists',
  albums: 'Albums',
  tracks: 'Tracks',
};

export interface SearchUrl {
  q?: string;
  type?: Exclude<SearchType, 'everything'>;
  /** The query was submitted, so the download source is searched too. */
  files?: 1;
}

/**
 * TanStack JSON-parses search values, so `?q=311` arrives as the number 311
 * and `?q=true` as a boolean; both are still the text someone searched for.
 */
export function parseQuery(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function parseType(value: unknown): SearchType {
  return typeof value === 'string' && (SEARCH_TYPES as readonly string[]).includes(value)
    ? (value as SearchType)
    : 'everything';
}

/** `files=1` (or `true`): anything else is "not submitted". */
export function parseSubmitted(value: unknown): boolean {
  return value === 1 || value === '1' || value === true || value === 'true';
}

export function validateSearchUrl(search: Record<string, unknown>): SearchUrl {
  return searchUrlFor(parseQuery(search.q), parseType(search.type), parseSubmitted(search.files));
}

/** The URL search for a query and type, defaults left out. */
export function searchUrlFor(query: string, type: SearchType, submitted = false): SearchUrl {
  const q = query.trim();
  return {
    ...(q ? { q } : {}),
    ...(type !== 'everything' ? { type } : {}),
    ...(q && submitted ? { files: 1 as const } : {}),
  };
}
