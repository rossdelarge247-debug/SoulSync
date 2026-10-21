import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/form';
import { EmptyState, LoadingState, Notice, SkeletonList } from '@/components/primitives';
import { openAddToPlaylist } from '@/features/playlists/add-to-playlist';
import { getShellBridge } from '@/platform/shell/bridge';
import { profileAsksFirst } from '@/platform/shell/download-rights';

import type { EnhancedAlbum, EnhancedData, EnhancedTrack } from '../-artist-detail.enhanced';
import type { ArtistDetailTrack } from '../-artist-detail.types';

import { extractFormat, formatDurationMs, releaseType } from '../-artist-detail.enhanced';
import { playlistTrackPayload, queueTrackPayload } from '../-artist-detail.enhanced-album';
import {
  formatPlaycount,
  loadTopTracks,
  playTrackByMetadata,
  topTracksBulkContext,
  trackArtistLabel,
  wishlistTrackBody,
} from '../-artist-detail.top-tracks';
import { ARTIST_PAGE_QUERY_KEY, libraryTracksQueryOptions } from '../-artist.api';
import { plural, text } from '../-artist.helpers';
import { ArtistMenu } from './artist-menu';
import styles from './artist-page.module.css';
import { EnhancedView } from './enhanced-view';

/** Rows shown before "Show all". */
const LIBRARY_PAGE = 50;

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5z" />
    </svg>
  );
}

export function topTracksQueryOptions(artistId: unknown, artistName: string) {
  return {
    queryKey: [...ARTIST_PAGE_QUERY_KEY, 'top', text(artistId), artistName] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => loadTopTracks(artistId, artistName, signal),
    enabled: Boolean(artistName),
    staleTime: 10 * 60_000,
  };
}

function durationText(value: unknown): string {
  const text = formatDurationMs(value);
  return text === '-' ? '' : text;
}

function qualityText(track: EnhancedTrack): string {
  const format = extractFormat(track.file_path);
  if (format === '-') return '';
  const bitrate = Number(track.bitrate);
  const lossless = ['FLAC', 'WAV', 'ALAC', 'AIFF', 'DSF'].includes(format);
  return !lossless && bitrate > 0 ? `${format} ${bitrate}` : format;
}

function sortedTracks(album: EnhancedAlbum): EnhancedTrack[] {
  return [...(album.tracks ?? [])].sort(
    (a, b) =>
      (Number(a.disc_number) || 1) - (Number(b.disc_number) || 1) ||
      (Number(a.track_number) || 0) - (Number(b.track_number) || 0) ||
      text(a.title).localeCompare(text(b.title)),
  );
}

function albumYear(album: EnhancedAlbum): number {
  return Number(album.year) || 0;
}

/** Popular tracks: the metadata source's top ten, or Last.fm's when it can't rank. */
function PopularTracks({ artistId, artistName }: { artistId: unknown; artistName: string }) {
  const query = useQuery(topTracksQueryOptions(artistId, artistName));
  const state = query.data;
  const asksFirst = profileAsksFirst();
  if (query.isPending) {
    return (
      <section className={styles.section} aria-labelledby="artist-popular">
        <h2 className={styles.sectionTitle} id="artist-popular">
          Popular
        </h2>
        <LoadingState label="Loading popular tracks…">
          <SkeletonList rows={3} art={0} tag={false} />
        </LoadingState>
      </section>
    );
  }
  if (!state || state.tracks.length === 0) return null;

  const play = (track: ArtistDetailTrack) =>
    void playTrackByMetadata(
      getShellBridge(),
      track.name ?? '',
      state.downloadable ? trackArtistLabel(track, artistName) : artistName,
      '',
    );

  const wishlist = async (track: ArtistDetailTrack) => {
    if (window.checkMusicRequestQuota && !(await window.checkMusicRequestQuota())) return;
    try {
      const response = await fetch('/api/add-album-to-wishlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wishlistTrackBody(track, artistName, artistId)),
      });
      const data = await response.json();
      if (data?.success) {
        if (!window.announceWishlistRequest?.())
          window.showToast?.(`Added “${track.name}” to Wanted.`, 'success');
      } else {
        window.showToast?.(
          `Couldn't add “${track.name}” to Wanted: ${data?.error || 'SoulSync said no'}.`,
          'error',
        );
      }
    } catch {
      window.showToast?.(
        `Couldn't add “${track.name}” to Wanted: SoulSync didn’t answer.`,
        'error',
      );
    }
  };

  const addAll = () => {
    const context = topTracksBulkContext(state, artistName, artistId);
    void window.openDownloadMissingModalForArtistAlbum?.(
      context.virtualPlaylistId,
      context.playlistName,
      state.tracks,
      context.wrapperAlbum,
      context.artist,
      true,
      'playlist',
    );
  };

  const where =
    state.source === 'lastfm'
      ? 'Most played on Last.fm.'
      : `The ${state.source === 'deezer' ? 'Deezer' : 'Spotify'} top ten.`;

  return (
    <section className={styles.section} aria-labelledby="artist-popular">
      <div className={styles.sectionHead}>
        <div>
          <h2 className={styles.sectionTitle} id="artist-popular">
            Popular
          </h2>
          <p className={styles.sectionNote}>{where}</p>
        </div>
        {state.downloadable ? (
          <Button size="lg" onClick={addAll}>
            {asksFirst ? 'Request these…' : 'Get these…'}
          </Button>
        ) : null}
      </div>
      <ol className={styles.rows}>
        {state.tracks.map((track, index) => (
          <li className={styles.row} key={`${index}-${track.name ?? ''}`}>
            <span className={styles.rowNum}>{index + 1}</span>
            <button
              type="button"
              className={styles.playButton}
              aria-label={`Play ${track.name}`}
              onClick={() => play(track)}
            >
              <PlayIcon />
            </button>
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>{track.name}</span>
              {state.downloadable ? (
                <span className={styles.rowMeta}>
                  {[trackArtistLabel(track, artistName), track.album?.name]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              ) : (
                <span className={`${styles.rowMeta} ${styles.rowMetaPhone}`}>
                  {formatPlaycount(track.playcount)} plays
                </span>
              )}
            </span>
            <span className={styles.rowAside}>
              {state.downloadable ? '' : formatPlaycount(track.playcount)}
            </span>
            <span className={styles.rowAside} />
            <ArtistMenu
              label={`More for ${track.name}`}
              variant="bare"
              entries={[
                { key: 'play', label: 'Play', onSelect: () => play(track) },
                ...(state.downloadable
                  ? [
                      {
                        key: 'wanted',
                        label: asksFirst ? 'Request it' : 'Add to Wanted',
                        onSelect: () => void wishlist(track),
                      },
                    ]
                  : []),
                {
                  key: 'playlist',
                  label: 'Add to a playlist…',
                  onSelect: () =>
                    openAddToPlaylist({
                      track_name: track.name ?? '',
                      artist_name: track.artists?.[0]?.name || artistName,
                    }),
                },
              ]}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Every track you have by them, grouped by release, newest release first. */
function LibraryTracks({
  data,
  artistName,
  focusAlbumId,
}: {
  data: EnhancedData;
  artistName: string;
  focusAlbumId?: string;
}) {
  const albums = useMemo(
    () =>
      [...(data.albums ?? [])]
        .filter((album) => (album.tracks ?? []).some((t) => t.file_path))
        .sort(
          (a, b) => albumYear(b) - albumYear(a) || String(a.title).localeCompare(String(b.title)),
        ),
    [data.albums],
  );
  const total = albums.reduce((n, a) => n + (a.tracks ?? []).filter((t) => t.file_path).length, 0);
  const [all, setAll] = useState(false);

  // an album named in the URL (the library's album grid, an old ?album= link)
  // is scrolled to and shown even past the first page
  useEffect(() => {
    if (!focusAlbumId) return;
    setAll(true);
    const frame = requestAnimationFrame(() =>
      document
        .querySelector(`[data-album-id="${CSS.escape(focusAlbumId)}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [focusAlbumId]);

  const artist = data.artist as Record<string, unknown> | undefined;
  let shown = 0;
  const groups: { album: EnhancedAlbum; tracks: EnhancedTrack[] }[] = [];
  for (const album of albums) {
    if (!all && shown >= LIBRARY_PAGE) break;
    const tracks = sortedTracks(album).filter((t) => t.file_path);
    const take = all ? tracks : tracks.slice(0, Math.max(0, LIBRARY_PAGE - shown));
    shown += take.length;
    groups.push({ album, tracks: take });
  }

  const play = (track: EnhancedTrack, album: EnhancedAlbum) =>
    getShellBridge()?.playLibraryTrack(track as never, text(album.title), artistName);

  return (
    <>
      <ul className={styles.rows} aria-label={`Tracks by ${artistName} in your library`}>
        {groups.map(({ album, tracks }) => (
          <li key={String(album.id)} style={{ display: 'contents' }}>
            <p
              className={styles.groupLabel}
              data-album-id={String(album.id)}
              data-focus={focusAlbumId && String(album.id) === focusAlbumId ? 'true' : undefined}
            >
              {[album.title, album.year, releaseType(album)].filter(Boolean).join(' · ')}
            </p>
            <ol style={{ display: 'contents' }}>
              {tracks.map((track) => {
                const title = text(track.title) || 'Unknown track';
                return (
                  <li
                    className={styles.row}
                    key={String(track.id)}
                    data-focus={
                      focusAlbumId && String(album.id) === focusAlbumId ? 'true' : undefined
                    }
                  >
                    <span className={styles.rowNum}>{text(track.track_number)}</span>
                    <button
                      type="button"
                      className={styles.playButton}
                      aria-label={`Play ${title}`}
                      onClick={() => play(track, album)}
                    >
                      <PlayIcon />
                    </button>
                    <span className={styles.rowText}>
                      <span className={styles.rowTitle}>{title}</span>
                      <span className={`${styles.rowMeta} ${styles.rowMetaPhone}`}>
                        {[durationText(track.duration), qualityText(track)]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <span className={styles.rowAside}>{durationText(track.duration)}</span>
                    <span className={styles.rowAside}>{qualityText(track)}</span>
                    <ArtistMenu
                      label={`More for ${title}`}
                      variant="bare"
                      entries={[
                        { key: 'play', label: 'Play', onSelect: () => play(track, album) },
                        {
                          key: 'next',
                          label: 'Play next',
                          onSelect: () => {
                            const payload = queueTrackPayload(track, album, artist);
                            if (typeof window.playNext === 'function') window.playNext(payload);
                            else window.addToQueue?.(payload);
                          },
                        },
                        {
                          key: 'queue',
                          label: 'Add to queue',
                          onSelect: () =>
                            window.addToQueue?.(queueTrackPayload(track, album, artist)),
                        },
                        {
                          key: 'playlist',
                          label: 'Add to a playlist…',
                          onSelect: () => {
                            const row = playlistTrackPayload(track, album, artist);
                            if (row) openAddToPlaylist(row);
                          },
                        },
                      ]}
                    />
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ul>
      {total > shown ? (
        <div className={styles.footer}>
          <p className={styles.footerCount}>
            {shown} of {plural(total, 'track')}
          </p>
          <Button size="lg" onClick={() => setAll(true)}>
            Show all {total.toLocaleString()}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * The Tracks tab: popular tracks, then every track of theirs you have. For
 * admins, "Edit tags and files" opens the library's tag, file and match tools
 * (the old "Your library" view) in place.
 */
export function TracksTab({
  artistId,
  artistName,
  libraryArtistId,
  isAdmin,
  manage,
  focusAlbumId,
  onManage,
}: {
  /** The id the page loaded the artist by (top tracks look it up). */
  artistId: unknown;
  artistName: string;
  /** null for an artist who isn't in the library. */
  libraryArtistId: string | null;
  isAdmin: boolean;
  manage: boolean;
  focusAlbumId?: string;
  onManage: (on: boolean) => void;
}) {
  const library = useQuery(libraryTracksQueryOptions(libraryArtistId));

  if (manage && isAdmin && libraryArtistId) {
    return (
      <section className={styles.section} aria-labelledby="artist-manage">
        <div className={styles.subBar}>
          <Button size="lg" variant="ghost" onClick={() => onManage(false)}>
            ← Back to tracks
          </Button>
          <h2 className={styles.sectionTitle} id="artist-manage">
            Tags, files and matches
          </h2>
        </div>
        <div className={`${styles.legacy} artist-detail-page`} id="enhanced-view-container">
          <EnhancedView
            data={library.data ?? null}
            status={{
              loading: library.isPending,
              error: library.isError ? (library.error as Error).message : '',
            }}
            isAdmin
            onReload={() => void library.refetch()}
            focusAlbumId={focusAlbumId}
          />
        </div>
      </section>
    );
  }

  return (
    <>
      <PopularTracks artistId={artistId} artistName={artistName} />
      <section className={styles.section} aria-labelledby="artist-library-tracks">
        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle} id="artist-library-tracks">
              In your library
            </h2>
            {library.data ? (
              <p className={styles.sectionNote}>
                {plural(
                  (library.data.albums ?? []).reduce(
                    (n, a) => n + (a.tracks ?? []).filter((t) => t.file_path).length,
                    0,
                  ),
                  'track',
                )}{' '}
                from your media server and downloads.
              </p>
            ) : null}
          </div>
          {isAdmin && libraryArtistId ? (
            <Button size="lg" onClick={() => onManage(true)}>
              Edit tags and files
            </Button>
          ) : null}
        </div>
        {!libraryArtistId ? (
          <EmptyState
            variant="panel"
            title={`Nothing by ${artistName} in your library yet`}
            description="Tracks you download or add to your media server show here. Add releases to Wanted from the Releases tab and SoulSync searches for them."
          />
        ) : library.isPending ? (
          <LoadingState label="Loading your tracks…">
            <SkeletonList rows={5} art={0} />
          </LoadingState>
        ) : library.isError ? (
          <>
            <Notice
              tone="danger"
              role="alert"
              title="Couldn't load your tracks"
              actions={
                <Button size="lg" onClick={() => void library.refetch()}>
                  Try again
                </Button>
              }
            >
              {(library.error as Error).message}. Your library is safe; this is a display problem.
            </Notice>
            <SkeletonList rows={2} art={0} faded />
          </>
        ) : (library.data.albums ?? []).every((a) => !(a.tracks ?? []).some((t) => t.file_path)) ? (
          <EmptyState
            variant="panel"
            title="No tracks with files yet"
            description={`SoulSync knows ${artistName}, but none of their tracks has a file in your library. Add releases to Wanted from the Releases tab and SoulSync searches for them.`}
          />
        ) : (
          <LibraryTracks data={library.data} artistName={artistName} focusAlbumId={focusAlbumId} />
        )}
      </section>
    </>
  );
}
