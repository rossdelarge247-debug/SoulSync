/**
 * What the Search page keeps in its URL: the query and what kind of result
 * to show, `/search?q=pale+harbour&type=albums`. Defaults are left out, so a
 * plain `/search` is the empty page and Everything never appears.
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

export function validateSearchUrl(search: Record<string, unknown>): SearchUrl {
  const q = parseQuery(search.q).trim();
  const type = parseType(search.type);
  return {
    ...(q ? { q } : {}),
    ...(type !== 'everything' ? { type } : {}),
  };
}

/** The URL search for a query and type, defaults left out. */
export function searchUrlFor(query: string, type: SearchType): SearchUrl {
  const q = query.trim();
  return {
    ...(q ? { q } : {}),
    ...(type !== 'everything' ? { type } : {}),
  };
}
