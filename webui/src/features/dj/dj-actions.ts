import type { UserPlaylistTrack } from '@/features/playlists/user-playlists';

/** What a DJ row's buttons do: Play next, and Add to playlist. */
import { openAddToPlaylist } from '@/features/playlists/add-to-playlist';

import type { DjTrack } from './dj.api';

/** Queue a library track after the current one (the player says "Playing next"). */
export function playTrackNext(track: DjTrack): void {
  if (!window.playNext) {
    window.showToast?.("The player isn't ready yet. Try again in a moment.", 'error');
    return;
  }
  window.playNext({
    id: track.id,
    title: track.title,
    artist: track.artist_name,
    album: track.album_title,
    file_path: track.file_path,
    artist_id: track.artist_id,
    album_id: track.album_id,
    image_url: track.image_url,
    bitrate: track.bitrate,
    duration: track.duration_ms ? Math.round(track.duration_ms / 1000) : undefined,
  });
}

/** A library track as the playlist routes take it. */
export function playlistTrack(track: DjTrack): UserPlaylistTrack {
  return {
    track_name: track.title,
    artist_name: track.artist_name,
    album_name: track.album_title,
    duration_ms: track.duration_ms ?? 0,
    image_url: track.image_url,
  };
}

export function addTrackToPlaylist(track: DjTrack, anchor?: HTMLElement | null): void {
  openAddToPlaylist(playlistTrack(track), anchor);
}
