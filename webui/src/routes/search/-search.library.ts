/**
 * "In your library": the library's own searches, asked together.
 *
 * - artists: GET /api/library/artists?search= (name; album and track counts,
 *   followed or not), with the total;
 * - albums: GET /api/library/albums?search= (title), with the total;
 * - tracks: GET /api/library/search-tracks?q= (title; file path and bitrate,
 *   so the row can name its quality). It has no total, so at the limit the
 *   count reads "50+".
 *
 * One failing doesn't hide the others; all three failing is the section's
 * failure state.
 */

import { queryOptions } from '@tanstack/react-query';

import type { QualityRule } from '@/features/quality/quality.model';

import { apiClient, readJson } from '@/app/api-client';
import {
  meetsBar,
  qualityFromPath,
  qualityLabel,
  qualityRank,
} from '@/features/quality/quality.model';

export interface LibraryArtist {
  id: number | string;
  name: string;
  image_url?: string | null;
  album_count?: number;
  track_count?: number;
  is_watched?: boolean;
}

export interface LibraryAlbum {
  id: number | string;
  title: string;
  year?: number | string | null;
  thumb_url?: string | null;
  artist_id?: number | string | null;
  artist_name?: string;
  track_count?: number;
}

export interface LibraryTrack {
  id: number | string;
  title: string;
  artist_name?: string;
  album_title?: string;
  album_thumb_url?: string;
  file_path?: string;
  bitrate?: number | null;
  duration?: number | null;
}

export interface LibraryResults {
  artists: LibraryArtist[];
  artistTotal: number;
  albums: LibraryAlbum[];
  albumTotal: number;
  tracks: LibraryTrack[];
  /** No total from the API: at the limit there may be more. */
  tracksCapped: boolean;
  /** Some kinds didn't answer; what's here is what did. */
  partial: boolean;
}

export const LIBRARY_LIMIT = 20;
export const TRACK_LIMIT = 50;

async function artists(q: string, signal?: AbortSignal) {
  const body = await readJson<{
    success?: boolean;
    artists?: LibraryArtist[];
    pagination?: { total_count?: number };
  }>(
    apiClient.get('library/artists', {
      searchParams: { search: q, limit: LIBRARY_LIMIT, page: 1 },
      signal,
    }),
  );
  if (body.success === false) throw new Error('artists');
  return {
    rows: body.artists ?? [],
    total: body.pagination?.total_count ?? body.artists?.length ?? 0,
  };
}

async function albums(q: string, signal?: AbortSignal) {
  const body = await readJson<{
    success?: boolean;
    albums?: LibraryAlbum[];
    pagination?: { total_count?: number };
  }>(
    apiClient.get('library/albums', {
      searchParams: { search: q, limit: LIBRARY_LIMIT, page: 1 },
      signal,
    }),
  );
  if (body.success === false) throw new Error('albums');
  return {
    rows: body.albums ?? [],
    total: body.pagination?.total_count ?? body.albums?.length ?? 0,
  };
}

async function tracks(q: string, signal?: AbortSignal) {
  const body = await readJson<{ success?: boolean; tracks?: LibraryTrack[] }>(
    apiClient.get('library/search-tracks', { searchParams: { q, limit: TRACK_LIMIT }, signal }),
  );
  if (body.success === false) throw new Error('tracks');
  return body.tracks ?? [];
}

export async function fetchLibraryResults(
  q: string,
  signal?: AbortSignal,
): Promise<LibraryResults> {
  const [a, b, c] = await Promise.allSettled([
    artists(q, signal),
    albums(q, signal),
    tracks(q, signal),
  ]);
  if (a.status === 'rejected' && b.status === 'rejected' && c.status === 'rejected') {
    throw new Error('SYNCHRO.S didn’t answer the library search.');
  }
  const trackRows = c.status === 'fulfilled' ? c.value : [];
  return {
    artists: a.status === 'fulfilled' ? a.value.rows : [],
    artistTotal: a.status === 'fulfilled' ? a.value.total : 0,
    albums: b.status === 'fulfilled' ? b.value.rows : [],
    albumTotal: b.status === 'fulfilled' ? b.value.total : 0,
    tracks: trackRows,
    tracksCapped: trackRows.length >= TRACK_LIMIT,
    partial: [a, b, c].some((r) => r.status === 'rejected'),
  };
}

export function libraryResultsQueryOptions(q: string) {
  return queryOptions({
    queryKey: ['search', 'library', q] as const,
    queryFn: ({ signal }) => fetchLibraryResults(q, signal),
    staleTime: 60_000,
  });
}

/** One owned album's tracks, for its quality and for Play. */
export interface OwnedTrack {
  id: number | string;
  title: string;
  track_number?: number | null;
  file_path: string;
  duration?: number | null;
  bitrate?: number | null;
}

export async function fetchAlbumTracks(albumId: number | string): Promise<OwnedTrack[]> {
  const body = await readJson<{ success?: boolean; tracks?: OwnedTrack[]; error?: string }>(
    apiClient.get(`library/albums/${albumId}/tracks`),
  );
  if (!body.success) throw new Error(body.error || 'Could not load the album');
  return body.tracks ?? [];
}

export function albumTracksQueryOptions(albumId: number | string) {
  return queryOptions({
    queryKey: ['search', 'library-album', String(albumId)] as const,
    queryFn: () => fetchAlbumTracks(albumId),
    staleTime: 5 * 60_000,
  });
}

// ── What a row says ───────────────────────────────────────────────────────

export type LibraryKind = 'artist' | 'album' | 'track';

export interface QualityVerdict {
  /** "FLAC", "MP3 320"; the worst copy for an album. */
  label: string;
  /** Below the target's bar (most of the album's files, for an album). */
  below: boolean;
}

/** A track's or album's quality against the target; null when not known. */
export function qualityVerdict(
  files: readonly { file_path?: string | null; bitrate?: number | null }[],
  bar: readonly QualityRule[] | null,
): QualityVerdict | null {
  const qualities = files
    .map((f) => qualityFromPath(f.file_path, f.bitrate ?? null))
    .filter((q) => q.format !== 'unknown');
  if (!qualities.length) return null;
  const worst = [...qualities].sort((a, b) => qualityRank(a) - qualityRank(b))[0];
  const belowCount = bar && bar.length ? qualities.filter((q) => !meetsBar(q, bar)).length : 0;
  return { label: qualityLabel(worst), below: belowCount * 2 > qualities.length };
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? word : `${word}s`}`;
}

/** "Artist · 9 albums · 93 tracks in your library · Following". */
export function artistMeta(artist: LibraryArtist): string {
  const parts = ['Artist'];
  const counts: string[] = [];
  if (artist.album_count) counts.push(plural(artist.album_count, 'album'));
  if (artist.track_count) counts.push(plural(artist.track_count, 'track'));
  if (counts.length) parts.push(`${counts.join(' · ')} in your library`);
  if (artist.is_watched) parts.push('Following');
  return parts.join(' · ');
}

/** "Pale Harbour · Album · 2023 · 10 tracks · FLAC". */
export function albumMeta(album: LibraryAlbum, verdict: QualityVerdict | null): string {
  const parts: string[] = [];
  if (album.artist_name) parts.push(album.artist_name);
  parts.push('Album');
  if (album.year) parts.push(String(album.year));
  if (album.track_count) parts.push(plural(album.track_count, 'track'));
  if (verdict?.label) parts.push(verdict.label);
  return parts.join(' · ');
}

/** "Pale Harbour · Night Ferry · FLAC". */
export function trackMeta(track: LibraryTrack, verdict: QualityVerdict | null): string {
  const parts: string[] = [];
  if (track.artist_name) parts.push(track.artist_name);
  if (track.album_title) parts.push(track.album_title);
  else parts.push('Track');
  if (verdict?.label) parts.push(verdict.label);
  return parts.join(' · ');
}

/** The phone's shorter lines (board 2n): "Artist · 9 albums · Following", "Album · 2023 · FLAC". */
export function shortMeta(
  row:
    | { kind: 'artist'; item: LibraryArtist }
    | { kind: 'album'; item: LibraryAlbum }
    | { kind: 'track'; item: LibraryTrack },
  verdict: QualityVerdict | null,
): string {
  if (row.kind === 'artist') {
    const a = row.item;
    return [
      'Artist',
      a.album_count ? plural(a.album_count, 'album') : '',
      a.is_watched ? 'Following' : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (row.kind === 'album') {
    return ['Album', row.item.year ? String(row.item.year) : '', verdict?.label ?? '']
      .filter(Boolean)
      .join(' · ');
  }
  return [row.item.album_title || 'Track', verdict?.label ?? ''].filter(Boolean).join(' · ');
}

/** "1 artist · 9 albums · 93 tracks". */
export function libraryCounts(results: LibraryResults): string {
  const parts: string[] = [];
  if (results.artistTotal) parts.push(plural(results.artistTotal, 'artist'));
  if (results.albumTotal) parts.push(plural(results.albumTotal, 'album'));
  if (results.tracks.length) {
    parts.push(
      results.tracksCapped
        ? `${results.tracks.length}+ tracks`
        : plural(results.tracks.length, 'track'),
    );
  }
  return parts.join(' · ');
}

export function libraryTotal(results: LibraryResults): number {
  return results.artistTotal + results.albumTotal + results.tracks.length;
}
