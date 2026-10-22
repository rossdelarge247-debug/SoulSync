/**
 * The mirroring routes the dialog stands on, all of them today's:
 *
 * - GET /api/spotify/playlists: your Spotify playlists (401 when Spotify
 *   isn't connected);
 * - GET /api/spotify/playlist/<id>, GET /api/deezer/playlist/<id>: a
 *   playlist's tracks;
 * - GET /api/mirrored-playlists: the mirrors you have;
 * - POST /api/enhanced-search/library-check: which tracks you already have;
 * - POST /api/mirror-playlist: save the mirror;
 * - POST /api/automations: its Auto-Sync schedule, the same row the Auto-Sync
 *   board makes;
 * - POST /api/mirrored-playlists/<id>/pipeline/run: the first check now
 *   (409 while another playlist pipeline runs).
 */

import { queryOptions } from '@tanstack/react-query';

import { apiClient, readJson } from '@/app/api-client';
import {
  fetchDeezerLinkPlaylist,
  fetchSpotifyPlaylistTracks,
  postMirrorPlaylist,
} from '@/routes/sync/-sync.api';
import { autoSyncSchedulePayload } from '@/routes/sync/-sync.autosync';
import { buildMirrorPayload } from '@/routes/sync/-sync.import';
import { deezerMirrorTracks } from '@/routes/sync/-sync.url-tabs';

import type { MirrorCandidate, MirroredRow, SourceTrack } from './mirror.model';

import { checkRow } from './mirror.model';

export interface SpotifyAccount {
  connected: boolean;
  playlists: MirrorCandidate[];
}

interface SpotifyPlaylistRow {
  id?: string | number;
  name?: string;
  owner?: string;
  track_count?: number;
  image_url?: string | null;
}

export async function fetchSpotifyAccount(): Promise<SpotifyAccount> {
  const response = await fetch('/api/spotify/playlists');
  if (response.status === 401) return { connected: false, playlists: [] };
  if (!response.ok) throw new Error('Could not load your Spotify playlists');
  const data = (await response.json()) as
    | SpotifyPlaylistRow[]
    | { playlists?: SpotifyPlaylistRow[] };
  const rows = Array.isArray(data) ? data : (data.playlists ?? []);
  return {
    connected: true,
    playlists: rows
      .filter((row) => row.id != null && row.name)
      .map((row) => ({
        source: 'spotify' as const,
        id: String(row.id),
        name: String(row.name),
        owner: row.owner || undefined,
        imageUrl: row.image_url || undefined,
        trackCount: typeof row.track_count === 'number' ? row.track_count : undefined,
      })),
  };
}

export function spotifyAccountQueryOptions() {
  return queryOptions({
    queryKey: ['mirror', 'spotify-playlists'] as const,
    queryFn: fetchSpotifyAccount,
    staleTime: 60_000,
  });
}

export async function fetchMirroredRows(): Promise<MirroredRow[]> {
  const data = await readJson<MirroredRow[] | { error?: string }>(
    apiClient.get('mirrored-playlists'),
  );
  if (!Array.isArray(data))
    throw new Error(data?.error || 'Could not load your mirrored playlists');
  return data;
}

export function mirroredRowsQueryOptions() {
  return queryOptions({
    queryKey: ['mirror', 'mirrored'] as const,
    queryFn: fetchMirroredRows,
    staleTime: 30_000,
  });
}

export interface LoadedPlaylist {
  name?: string;
  owner?: string;
  imageUrl?: string;
  tracks: SourceTrack[];
}

export async function loadPlaylist(
  candidate: Pick<MirrorCandidate, 'source' | 'id'>,
): Promise<LoadedPlaylist> {
  if (candidate.source === 'deezer') {
    const data = (await fetchDeezerLinkPlaylist(candidate.id)) as {
      name?: string;
      title?: string;
      owner?: string;
      creator?: string;
      image_url?: string;
      tracks?: SourceTrack[];
      error?: string;
    };
    if (data.error) throw new Error(data.error);
    return {
      name: data.name || data.title,
      owner: data.owner || data.creator,
      imageUrl: data.image_url,
      tracks: data.tracks ?? [],
    };
  }
  const data = await fetchSpotifyPlaylistTracks(candidate.id);
  if (data.error) throw new Error(data.error);
  return {
    name: data.name,
    owner: data.owner,
    imageUrl: data.image_url,
    tracks: (data.tracks ?? []) as SourceTrack[],
  };
}

export async function checkOwnership(
  tracks: readonly SourceTrack[],
  signal?: AbortSignal,
): Promise<{ tracks?: { in_library?: boolean; in_wishlist?: boolean }[] }> {
  if (!tracks.length) return { tracks: [] };
  return readJson(
    apiClient.post('enhanced-search/library-check', {
      json: { albums: [], tracks: tracks.map(checkRow) },
      signal,
      timeout: 60_000,
    }),
  );
}

export class MirrorStepError extends Error {
  /** busy: another playlist pipeline is running (409). */
  kind: 'busy' | 'failed';
  constructor(kind: 'busy' | 'failed', message: string) {
    super(message);
    this.kind = kind;
  }
}

export async function saveMirror(
  candidate: MirrorCandidate,
  loaded: LoadedPlaylist,
): Promise<number> {
  const payload = buildMirrorPayload(
    candidate.source,
    candidate.id,
    candidate.name,
    // the Deezer link tab's own normaliser, so both mirror a Deezer playlist alike
    (candidate.source === 'deezer' ? deezerMirrorTracks(loaded.tracks) : loaded.tracks) as never,
    {
      owner: loaded.owner ?? candidate.owner,
      image_url: loaded.imageUrl ?? candidate.imageUrl,
      description: candidate.link,
    },
  );
  let result: { success?: boolean; playlist_id?: number; error?: string };
  try {
    result = await postMirrorPlaylist(payload);
  } catch {
    throw new MirrorStepError(
      'failed',
      "SYNCHRO.S didn't answer, so the playlist wasn't mirrored.",
    );
  }
  if (result.success === false || result.playlist_id == null) {
    throw new MirrorStepError('failed', result.error || "SYNCHRO.S couldn't mirror the playlist.");
  }
  return result.playlist_id;
}

/** The interval every new mirror is checked on; the Auto-Sync board can change it. */
export const KEEP_IN_SYNC_HOURS = 24;

export async function scheduleMirror(name: string, playlistId: number): Promise<void> {
  const body = autoSyncSchedulePayload({ name }, playlistId, {
    trigger_type: 'schedule',
    trigger_config: { interval: KEEP_IN_SYNC_HOURS, unit: 'hours' },
  });
  const response = await fetch('/api/automations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!response)
    throw new MirrorStepError('failed', "SYNCHRO.S didn't answer, so the schedule wasn't saved.");
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new MirrorStepError('failed', data.error || "SYNCHRO.S couldn't save the schedule.");
  }
}

export async function runFirstCheck(playlistId: number): Promise<void> {
  const response = await fetch(`/api/mirrored-playlists/${playlistId}/pipeline/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => null);
  if (!response)
    throw new MirrorStepError(
      'failed',
      "SYNCHRO.S didn't answer, so the first check didn't start.",
    );
  if (response.status === 409) {
    throw new MirrorStepError(
      'busy',
      'Another playlist is being checked right now, and only one check runs at a time.',
    );
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new MirrorStepError('failed', data.error || "The first check didn't start.");
  }
}
