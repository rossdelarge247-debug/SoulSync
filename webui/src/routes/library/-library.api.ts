import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import type { PlanSummary } from '@/features/safe-action/plan';

import { apiClient, readJson } from '@/app/api-client';

import type { LibraryAlbumTrack } from './-library.helpers';

import {
  LIBRARY_PAGE_SIZE,
  type ArtistIndexResponse,
  type BulkAddResult,
  type GenresResponse,
  type ReleasesResponse,
  type SelectionBody,
  type SelectionSummary,
  type UnmatchedSummary,
} from './-library.types';

export const LIBRARY_QUERY_KEY = ['library'] as const;

/** The params an index query sends: empty ones are left off the wire. */
function params(raw: Record<string, string | number | undefined>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

async function readOk<T extends { success?: boolean; error?: string }>(
  promise: Promise<T>,
): Promise<T> {
  const payload = await promise;
  if (payload.success === false) throw new Error(payload.error || 'Something went wrong');
  return payload;
}

export interface ReleasesQuery {
  show: string;
  genre: string;
  q: string;
  sort: string;
}

/**
 * The albums grid, 50 at a time: "Show 50 more" fetches the next page and the
 * grid keeps what it has. Every filter is in the key, so going back to a view
 * is a cache hit.
 */
export function releasesInfiniteQueryOptions(profileId: number, query: ReleasesQuery) {
  return infiniteQueryOptions({
    queryKey: [...LIBRARY_QUERY_KEY, 'releases', profileId, query] as const,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      readOk(
        readJson<ReleasesResponse>(
          apiClient.get('library/releases', {
            searchParams: params({ ...query, page: pageParam, limit: LIBRARY_PAGE_SIZE }),
          }),
        ),
      ),
    getNextPageParam: (last) => (last.has_more ? last.page + 1 : undefined),
  });
}

export function genresQueryOptions(
  profileId: number,
  query: { show: string; sort: string; q: string },
) {
  return queryOptions({
    queryKey: [...LIBRARY_QUERY_KEY, 'genres', profileId, query] as const,
    queryFn: () =>
      readOk(
        readJson<GenresResponse>(apiClient.get('library/genres', { searchParams: params(query) })),
      ),
  });
}

export function artistIndexInfiniteQueryOptions(profileId: number, query: ReleasesQuery) {
  return infiniteQueryOptions({
    queryKey: [...LIBRARY_QUERY_KEY, 'artist-index', profileId, query] as const,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      readOk(
        readJson<ArtistIndexResponse>(
          apiClient.get('library/artist-index', {
            searchParams: params({ ...query, page: pageParam, limit: LIBRARY_PAGE_SIZE }),
          }),
        ),
      ),
    getNextPageParam: (last) => (last.has_more ? last.page + 1 : undefined),
  });
}

/** The confirm's numbers for a selection (7d). */
export function selectionSummary(body: SelectionBody): Promise<SelectionSummary> {
  return readOk(
    readJson<SelectionSummary & { success?: boolean; error?: string }>(
      apiClient.post('library/releases/summary', { json: body }),
    ),
  );
}

/**
 * Put a selection on Wanted: POST /api/wishlist/bulk with action "add".
 * `quality` is "target" or a quality profile id. A refusal (too many, an
 * unknown quality) throws with the server's sentence.
 */
export async function addToWanted(
  body: SelectionBody & { quality: 'target' | number; follow_artists?: boolean },
): Promise<BulkAddResult> {
  const response = await apiClient.post('wishlist/bulk', {
    json: { action: 'add', ...body },
    throwHttpErrors: false,
  });
  const payload = (await response.json().catch(() => ({}))) as BulkAddResult;
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || payload.error || "Couldn't add them to Wanted");
  }
  return payload;
}

export async function followArtists(
  artistIds: (string | number)[],
): Promise<{ followed: number; already_following: number; no_id: number }> {
  return readOk(
    readJson<{
      success?: boolean;
      error?: string;
      followed: number;
      already_following: number;
      no_id: number;
    }>(apiClient.post('library/artists/follow', { json: { artist_ids: artistIds } })),
  );
}

/** Remove from library, step one: the plan (admins). */
export async function previewRemoval(body: SelectionBody): Promise<PlanSummary> {
  return readOk(
    readJson<PlanSummary & { success?: boolean; error?: string }>(
      apiClient.post('library/albums/remove-preview', { json: body }),
    ),
  );
}

/** "Upgrade the N below target" (7b, admins): pending upgrade findings to Wanted. */
export async function upgradeAlbums(albumIds: (string | number)[]): Promise<{
  queued: number;
  failed: number;
  albums: number;
  albums_with_upgrades: number;
  albums_without: number;
}> {
  const response = await apiClient.post('library/albums/upgrade', {
    json: { album_ids: albumIds },
    throwHttpErrors: false,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    message?: string;
    queued: number;
    failed: number;
    albums: number;
    albums_with_upgrades: number;
    albums_without: number;
  };
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || payload.error || "Couldn't start the upgrades");
  }
  return payload;
}

/**
 * The owned tracks of one album, for the tile's play button.
 *
 * Not a query: it is fetched on click, for one album, and caching a tracklist
 * the page never displays would only hold memory.
 */
export async function loadAlbumTracks(albumId: string | number): Promise<LibraryAlbumTrack[]> {
  const payload = await readJson<{
    success?: boolean;
    error?: string;
    tracks?: LibraryAlbumTrack[];
  }>(apiClient.get(`library/albums/${albumId}/tracks`));
  if (!payload.success) throw new Error(payload.error || 'Could not load the album');
  return payload.tracks ?? [];
}

/**
 * How many tracks landed under "Unknown Artist" because their tags were
 * unreadable on import (#1202). Failure is not worth surfacing: the caller
 * treats a rejected query as "nothing to report".
 */
export function libraryUnmatchedQueryOptions() {
  return queryOptions({
    queryKey: [...LIBRARY_QUERY_KEY, 'unmatched'] as const,
    queryFn: () => readJson<UnmatchedSummary>(apiClient.get('library/unmatched-summary')),
    staleTime: 60_000,
  });
}
