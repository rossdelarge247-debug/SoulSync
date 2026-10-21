import { queryOptions } from '@tanstack/react-query';

import { apiClient, readJson } from '@/app/api-client';

import type { EnhancedData } from './-artist-detail.enhanced';
import type { QualityAlbum } from './-artist.helpers';

import { WATCHLIST_QUERY_KEY } from '../watchlist/-watchlist.api';

/** The Artist page's own reads, beside GET /api/artist-detail (-artist-detail.api.ts). */
export const ARTIST_PAGE_QUERY_KEY = ['artist-page'] as const;

export interface ArtistQualityResponse {
  success?: boolean;
  error?: string;
  artist_id?: string | number;
  target?: {
    name?: string | null;
    preset?: string | null;
    quality_profile_id?: number | null;
    quality_profile_name?: string | null;
  };
  tracks?: number;
  below_target?: number;
  albums?: QualityAlbum[];
}

/**
 * GET /api/quality/artist/<library id>: each of a library artist's albums
 * against the quality target, for the "Below quality target" tag.
 */
export function artistQualityQueryOptions(libraryArtistId: string | null) {
  return queryOptions({
    queryKey: [...ARTIST_PAGE_QUERY_KEY, 'quality', libraryArtistId] as const,
    queryFn: () =>
      readJson<ArtistQualityResponse>(
        apiClient.get(`quality/artist/${encodeURIComponent(String(libraryArtistId))}`),
      ),
    enabled: Boolean(libraryArtistId),
    staleTime: 60_000,
  });
}

export interface SimilarArtist {
  id?: string | number | null;
  name: string;
  image_url?: string | null;
  source?: string | null;
  genres?: string[] | null;
}

export interface SimilarArtistsResponse {
  success?: boolean;
  error?: string;
  similar_artists?: SimilarArtist[];
}

/**
 * GET /api/artist/similar/<name>: the MusicMap neighbours the old page drew
 * as bubbles, matched to your metadata sources. Slow on a cold cache, so it
 * starts with the page (the tab shows its count) and is kept for 10 minutes.
 */
export function similarArtistsQueryOptions(artistName: string) {
  return queryOptions({
    queryKey: [...ARTIST_PAGE_QUERY_KEY, 'similar', artistName] as const,
    queryFn: () =>
      readJson<SimilarArtistsResponse>(
        apiClient.get(`artist/similar/${encodeURIComponent(artistName)}`, { timeout: 60_000 }),
      ),
    enabled: Boolean(artistName),
    staleTime: 10 * 60_000,
  });
}

/**
 * POST /api/watchlist/check: whether this profile follows the artist. Keyed
 * under the watchlist key so the Wanted page's changes reach it.
 */
export function followCheckQueryOptions(profileId: number, artistId: string | null) {
  return queryOptions({
    queryKey: [...WATCHLIST_QUERY_KEY, 'check', profileId, artistId] as const,
    queryFn: async () => {
      const payload = await readJson<{ success?: boolean; is_watching?: boolean; error?: string }>(
        apiClient.post('watchlist/check', { json: { artist_id: artistId } }),
      );
      if (payload.success === false) throw new Error(payload.error || "Couldn't check following");
      return Boolean(payload.is_watching);
    },
    enabled: Boolean(artistId),
  });
}

/**
 * GET /api/library/artist/<id>/enhanced: every album and track of a library
 * artist, for the Tracks tab (and the tag and file tools behind it).
 */
export function libraryTracksQueryOptions(libraryArtistId: string | null) {
  return queryOptions({
    queryKey: [...ARTIST_PAGE_QUERY_KEY, 'library', libraryArtistId] as const,
    queryFn: async () => {
      const payload = await readJson<EnhancedData & { success?: boolean; error?: string }>(
        apiClient.get(`library/artist/${encodeURIComponent(String(libraryArtistId))}/enhanced`, {
          timeout: 60_000,
        }),
      );
      if (payload.success === false) throw new Error(payload.error || "Couldn't load the library");
      return payload;
    },
    enabled: Boolean(libraryArtistId),
  });
}

/** POST /api/library/artist/<id>/sync (admins): the media server's view of this artist, again. */
export async function syncArtistFromServer(
  libraryArtistId: string,
): Promise<Record<string, unknown>> {
  const payload = await readJson<Record<string, unknown> & { success?: boolean; error?: string }>(
    apiClient.post(`library/artist/${encodeURIComponent(libraryArtistId)}/sync`, {
      timeout: 120_000,
    }),
  );
  if (payload.success === false) throw new Error(String(payload.error || 'The sync failed'));
  return payload;
}
