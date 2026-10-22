import { useCallback } from 'react';

import type { ArtistDetailResponse, DiscographyRelease } from './-artist-detail.types';

import {
  albumTracksParams,
  isReleaseClickable,
  lockSectionType,
  openReleaseArtist,
  reconcileAlbumWithTracksResponse,
  releasePlaylistName,
  releaseToAlbumData,
  releaseVirtualPlaylistId,
  stillCheckingMessage,
} from './-artist-detail.open-release';
import { checkTracksBody, mergeOwnership } from './-artist-detail.owned-tracks';

/**
 * Open a release (its tracklist in the download modal: pick tracks, download
 * them, or add the picked ones to Wanted, #1297) and play a release you have,
 * exactly as the old artist page's cards did.
 */
export function useReleaseActions(payload: ArtistDetailResponse | null, photo: string) {
  const open = useCallback(
    async (release: DiscographyRelease) => {
      if (!isReleaseClickable(release)) {
        window.showToast?.(stillCheckingMessage(release), 'info');
        return;
      }
      if (!payload) return;
      const artist = openReleaseArtist(payload, payload.artist?.id, photo);
      if (!artist) {
        window.showToast?.('There is no artist to open this release for.', 'error');
        return;
      }

      const cardAlbum = releaseToAlbumData(release);
      const virtualId = releaseVirtualPlaylistId(artist, cardAlbum);
      // an album mid-download just comes back up
      if (window.reopenActiveDownloadModal?.(virtualId, { runningOnly: true })) return;

      window.showLoadingOverlay?.('Loading album...');
      try {
        const params = new URLSearchParams(albumTracksParams(release, artist));
        const response = await fetch(`/api/album/${cardAlbum.id}/tracks?${params}`);
        if (!response.ok) throw new Error(`the source answered ${response.status}`);
        const data = await response.json();
        if (!data.success || !data.tracks?.length) throw new Error('the source listed no tracks');
        // the card's count is often a guess; the release just fetched has the
        // real type and count, and the type stays the section it was shown in
        const album = lockSectionType(reconcileAlbumWithTracksResponse(cardAlbum, data), release);
        await window.openDownloadMissingModalForArtistAlbum?.(
          virtualId,
          releasePlaylistName(artist, album),
          data.tracks,
          album,
          artist,
          false,
        );
        window.registerArtistDownload?.(artist, album, virtualId, album.album_type);
      } catch (error) {
        window.showToast?.(`Couldn't open that release: ${(error as Error).message}.`, 'error');
      } finally {
        window.hideLoadingOverlay?.();
      }
    },
    [payload, photo],
  );

  const play = useCallback(
    async (release: DiscographyRelease) => {
      if (!isReleaseClickable(release)) {
        window.showToast?.(stillCheckingMessage(release), 'info');
        return;
      }
      if (!payload) return;
      const artist = openReleaseArtist(payload, payload.artist?.id, photo);
      if (!artist) {
        window.showToast?.('There is no artist to play this release for.', 'error');
        return;
      }
      window.showLoadingOverlay?.('Loading album...');
      try {
        const album = releaseToAlbumData(release);
        const params = new URLSearchParams(albumTracksParams(release, artist));
        const response = await fetch(`/api/album/${album.id}/tracks?${params}`);
        if (!response.ok) throw new Error(`the source answered ${response.status}`);
        const data = await response.json();
        if (!data.success || !data.tracks?.length) throw new Error('the source listed no tracks');
        const tracks = data.tracks.map((track: Record<string, unknown>) => ({
          ...track,
          title: track.title || track.name || 'Unknown Track',
          name: track.name || track.title || 'Unknown Track',
          artist: track.artist || track.artist_name || artist.name,
          artists:
            Array.isArray(track.artists) && track.artists.length
              ? track.artists
              : [{ name: artist.name }],
          album: track.album || track.album_title || album.name,
          image_url: track.image_url || album.image_url || artist.image_url,
        }));
        // what the library has, before the queue gets it: rows from the
        // metadata source carry no file, and the player would try to download
        // them first. A failed lookup plays what there is.
        let playable = tracks;
        try {
          const owned = await fetch('/api/library/check-tracks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(checkTracksBody(artist.name, String(album.name || ''), tracks)),
          });
          if (owned.ok) {
            const ownedData = await owned.json();
            if (ownedData?.success) playable = mergeOwnership(tracks, ownedData.owned_tracks);
          }
        } catch {
          // ignored on purpose, see above
        }
        window.hideLoadingOverlay?.();
        await window.playTrackList?.(playable, String(album.name || 'Album'));
      } catch (error) {
        window.hideLoadingOverlay?.();
        window.showToast?.(`Couldn't play that release: ${(error as Error).message}.`, 'error');
      }
    },
    [payload, photo],
  );

  return { open, play };
}
