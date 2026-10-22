import { queryOptions } from '@tanstack/react-query';

import { apiClient, readJson } from '@/app/api-client';

import type {
  FollowedSummaryResponse,
  FoundResponse,
  PodcastSummaryResponse,
  QualityProfilesResponse,
} from './-wanted.types';

import { fetchFollowedAuthors, fetchWishlist } from '../audiobooks/-audiobooks.api';
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

/** What came in for each followed podcast: kept episodes, the latest one. */
export function podcastSummaryQueryOptions(profileId: number) {
  return queryOptions({
    queryKey: [...WATCHLIST_QUERY_KEY, 'podcast-summary', profileId] as const,
    queryFn: async () => {
      const payload = await readJson<PodcastSummaryResponse>(
        apiClient.get('podcasts/watchlist/summary'),
      );
      if (payload.success === false) throw new Error(payload.error || 'No podcast summary');
      return payload.podcasts ?? [];
    },
  });
}

/**
 * Followed audiobook authors, narrators and series, and the audiobook
 * wishlist they add to (what's on Wanted from each, and when). Both readers
 * answer an empty list on a failure, as the audiobook pages expect.
 */
export function followedAuthorsQueryOptions(profileId: number) {
  return queryOptions({
    queryKey: [...WATCHLIST_QUERY_KEY, 'authors', profileId] as const,
    queryFn: () => fetchFollowedAuthors(),
  });
}

export function audiobookWantedQueryOptions(profileId: number) {
  return queryOptions({
    queryKey: [...WISHLIST_QUERY_KEY, 'audiobooks', profileId] as const,
    queryFn: async () => (await fetchWishlist()).items,
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

export interface PodcastScanResult {
  success?: boolean;
  podcasts_checked?: number;
  episodes_queued?: number;
  errors?: string[];
  error?: string;
}

/** Check every followed podcast's feed now: the scheduled check, by hand. */
export async function scanPodcastsNow(): Promise<PodcastScanResult> {
  // a feed per show, one after another: it can take a while
  return readJson<PodcastScanResult>(
    apiClient.post('podcasts/watchlist/scan-now', { timeout: 120_000 }),
  );
}
