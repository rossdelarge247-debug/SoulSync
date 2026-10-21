import { queryOptions } from '@tanstack/react-query';

import { apiClient, readJson } from '@/app/api-client';

import type {
  FollowedSummaryResponse,
  FoundResponse,
  QualityProfilesResponse,
} from './-wanted.types';

import { WATCHLIST_QUERY_KEY } from '../watchlist/-watchlist.api';
import { WISHLIST_QUERY_KEY } from '../wishlist/-wishlist.api';

/**
 * The reads this page adds. Like the wishlist and watchlist routes they take
 * the profile from the session; the profile still keys every query so a
 * profile switch never serves the previous profile's list from the cache.
 *
 * Found and the followed summary sit under the wishlist and watchlist keys on
 * purpose: everything that refreshes those lists (a removal, a finished scan)
 * refreshes these too.
 */

export const FOUND_DAYS = 7;

export function wantedFoundQueryOptions(profileId: number) {
  return queryOptions({
    queryKey: [...WISHLIST_QUERY_KEY, 'found', profileId, FOUND_DAYS] as const,
    queryFn: () =>
      readJson<FoundResponse>(
        apiClient.get('wishlist/found', { searchParams: { days: FOUND_DAYS } }),
      ),
  });
}

export function followedSummaryQueryOptions(profileId: number) {
  return queryOptions({
    queryKey: [...WATCHLIST_QUERY_KEY, 'summary', profileId] as const,
    queryFn: async () => {
      const payload = await readJson<FollowedSummaryResponse>(
        apiClient.get('watchlist/artists/summary'),
      );
      if (payload.success === false) throw new Error(payload.error || 'No summary');
      return payload;
    },
  });
}

/** Quality profile names, for the quality a wanted item is held to. */
export function qualityProfilesQueryOptions() {
  return queryOptions({
    queryKey: ['quality-profiles', 'list'] as const,
    queryFn: () => readJson<QualityProfilesResponse>(apiClient.get('quality-profile/custom')),
    staleTime: 60_000,
  });
}

interface SuccessResponse {
  success?: boolean;
  error?: string;
}

/**
 * Search for everything on Wanted now: the scheduled search's own pipeline,
 * run by hand, which skips the wait between tries (a click is the override).
 * 409 while a search is already running; 403 for a profile without download
 * rights.
 */
export async function searchWantedNow(): Promise<void> {
  const payload = await readJson<SuccessResponse>(apiClient.post('wishlist/process'));
  if (payload.success === false) throw new Error(payload.error || 'The search did not start.');
}

/** The library artist with exactly this name, if the library has one. */
export async function findLibraryArtist(
  name: string,
): Promise<{ id: string; name: string } | null> {
  const payload = await readJson<{ artists?: { id?: number | string; name?: string }[] }>(
    apiClient.get('library/artists', { searchParams: { search: name, limit: 5 } }),
  );
  const wanted = name.trim().toLowerCase();
  const exact = (payload.artists ?? []).find(
    (artist) => (artist.name ?? '').trim().toLowerCase() === wanted && artist.id != null,
  );
  return exact ? { id: String(exact.id), name: exact.name ?? name } : null;
}
