/**
 * "In your library" (board 2m): artists, albums and tracks you have that match
 * the query, each with a status tag (Following, In your library, Below quality
 * target) and its actions (Open artist; Play and Open). Everything shows the
 * first three and links to the Library page for the rest. An album below your
 * quality target that has a folder at your target in the download source's
 * results below says "Better copies below", which goes to that row (HANDOFF 18).
 */

import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';

import type { QualityRule } from '@/features/quality/quality.model';

import { Button } from '@/components/form';
import { LoadingState, Notice, SkeletonList, StatusTag } from '@/components/primitives';
import { DjMeta } from '@/features/dj/dj-meta';
import { useDjInfo } from '@/features/dj/dj.api';
import { openMixes } from '@/features/dj/mixes-store';
import { AppLink } from '@/routes/activity/-ui/app-link';
import { albumQueueTrack } from '@/routes/library/-library.helpers';

import type {
  LibraryAlbum,
  LibraryArtist,
  LibraryResults,
  LibraryTrack,
  QualityVerdict,
} from '../-search.library';
import type { SearchType } from '../-search.url';

import { playOwnedTrack } from '../-search.actions';
import {
  albumMeta,
  albumTracksQueryOptions,
  artistMeta,
  libraryCounts,
  libraryTotal,
  qualityVerdict,
  shortMeta,
  trackMeta,
} from '../-search.library';
import { albumGroupKey } from '../-soulseek.model';
import styles from './search-page.module.css';
import { Art, ButtonLink, ofLine, rowLimit, SectionHead, usePhoneWidth } from './search-parts';

const TYPED_ROWS = 10;

type Row =
  | { kind: 'artist'; item: LibraryArtist }
  | { kind: 'album'; item: LibraryAlbum }
  | { kind: 'track'; item: LibraryTrack };

function artistPath(id: number | string, name?: string): string {
  const path = `/artist-detail/library/${encodeURIComponent(String(id))}`;
  return name ? `${path}?name=${encodeURIComponent(name)}` : path;
}

function albumPath(album: LibraryAlbum): string | null {
  if (album.artist_id == null || album.artist_id === '') return null;
  return `/artist-detail/library/${encodeURIComponent(String(album.artist_id))}?album=${encodeURIComponent(String(album.id))}`;
}

function QualityTag({
  verdict,
  owned = 'In your library',
}: {
  verdict: QualityVerdict | null;
  owned?: string;
}) {
  return verdict?.below ? (
    <StatusTag tone="warning">Below quality target</StatusTag>
  ) : (
    <StatusTag tone="success">{owned}</StatusTag>
  );
}

/** The rows a type shows, in order: artists, albums, then tracks. */
export function libraryRows(data: LibraryResults | undefined, type: SearchType): Row[] {
  if (!data) return [];
  return [
    ...(type === 'everything' || type === 'artists'
      ? data.artists.map((item) => ({ kind: 'artist' as const, item }))
      : []),
    ...(type === 'everything' || type === 'albums'
      ? data.albums.map((item) => ({ kind: 'album' as const, item }))
      : []),
    ...(type === 'everything' || type === 'tracks'
      ? data.tracks.map((item) => ({ kind: 'track' as const, item }))
      : []),
  ];
}

export function LibrarySection({
  results,
  query,
  type,
  bar,
  isAdmin,
  betterCopies,
  onBetterCopies,
}: {
  results: UseQueryResult<LibraryResults>;
  query: string;
  type: SearchType;
  bar: readonly QualityRule[] | null;
  isAdmin: boolean;
  /** Folder keys (albumGroupKey) the download source's section has at your target. */
  betterCopies?: ReadonlySet<string>;
  /** Go to that folder's row. */
  onBetterCopies?: (key: string) => void;
}) {
  const queryClient = useQueryClient();
  const [more, setMore] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);

  const data = results.data;
  const rows = libraryRows(data, type);
  const phone = usePhoneWidth();
  const limit = type === 'everything' ? rowLimit(type, phone, 2) : more ? rows.length : TYPED_ROWS;
  const shown = rows.slice(0, limit);
  const albumIds = shown.filter((r) => r.kind === 'album').map((r) => r.item.id);
  // BPM and key on the track rows (the library's DJ data)
  const djInfo = useDjInfo(shown.filter((r) => r.kind === 'track').map((r) => String(r.item.id)));
  const albumTracks = useQueries({
    queries: albumIds.map((id) => ({ ...albumTracksQueryOptions(id), enabled: Boolean(bar) })),
  });
  const verdictFor = (albumId: number | string): QualityVerdict | null => {
    const index = albumIds.indexOf(albumId);
    const tracks = index >= 0 ? albumTracks[index]?.data : undefined;
    return tracks ? qualityVerdict(tracks, bar) : null;
  };

  const playAlbum = async (album: LibraryAlbum) => {
    const key = `album:${album.id}`;
    if (playing === key) return;
    setPlaying(key);
    try {
      const tracks = await queryClient.fetchQuery(albumTracksQueryOptions(album.id));
      if (!tracks.length) {
        window.showToast?.(`No playable tracks in ${album.title}`, 'info');
        return;
      }
      await window.playTrackList?.(
        tracks.map((track) => albumQueueTrack(track, album as never)),
        album.title,
      );
    } catch {
      window.showToast?.(`Could not play ${album.title}`, 'error');
    } finally {
      setPlaying(null);
    }
  };

  const total = data ? (type === 'everything' ? libraryTotal(data) : rows.length) : 0;
  const libraryLink = `/library?q=${encodeURIComponent(query)}`;

  return (
    <section className={styles.section} aria-labelledby="search-library-title" id="search-library">
      <SectionHead
        id="search-library-title"
        title="In your library"
        aside={
          data && rows.length ? (
            <>
              <span className={styles.wideOnly}>{libraryCounts(data)}</span>
              <span className={styles.phoneOnly}>
                <AppLink className={styles.link} to={libraryLink}>
                  All {total.toLocaleString('en-GB')}
                </AppLink>
              </span>
            </>
          ) : null
        }
      />
      {results.isPending ? (
        <LoadingState label="Searching your library…">
          <SkeletonList rows={3} />
        </LoadingState>
      ) : results.isError ? (
        <>
          <Notice
            tone="danger"
            role="alert"
            title="Couldn’t search your library"
            actions={
              <>
                <Button size="lg" onClick={() => void results.refetch()}>
                  {results.isFetching ? 'Trying…' : 'Try again'}
                </Button>
                {isAdmin ? (
                  <ButtonLink to="/setup-check" variant="ghost">
                    Run Setup check
                  </ButtonLink>
                ) : null}
              </>
            }
          >
            SYNCHRO.S didn’t answer, so this part of the page is empty. Your library is safe; the
            other sections still searched.
          </Notice>
          <SkeletonList rows={2} faded />
        </>
      ) : !rows.length ? (
        <div className={styles.card}>
          <p className={styles.note}>
            Nothing in your library matches “{query}”
            {type === 'everything' ? '' : ` among its ${type}`}.
          </p>
        </div>
      ) : (
        <div className={styles.card}>
          {shown.map((row) => {
            if (row.kind === 'artist') {
              const artist = row.item;
              const to = artistPath(artist.id, artist.name);
              return (
                <div className={styles.row} data-kind="library" key={`artist:${artist.id}`}>
                  <Art url={artist.image_url} round />
                  <div className={styles.rowText}>
                    <AppLink to={to} className={styles.rowTitle}>
                      {artist.name}
                    </AppLink>
                    <span className={`${styles.rowMeta} ${styles.wideOnly}`}>
                      {artistMeta(artist)}
                    </span>
                    <span className={`${styles.rowMeta} ${styles.phoneOnly}`}>
                      {shortMeta(row, null)}
                    </span>
                  </div>
                  <span className={styles.tagCell}>
                    <StatusTag tone="success">
                      {artist.is_watched ? 'Following' : 'In your library'}
                    </StatusTag>
                  </span>
                  <div className={styles.actions}>
                    <ButtonLink to={to} label={`Open artist ${artist.name}`}>
                      Open artist
                    </ButtonLink>
                  </div>
                </div>
              );
            }
            if (row.kind === 'album') {
              const album = row.item;
              const to = albumPath(album);
              const verdict = verdictFor(album.id);
              const folder = albumGroupKey(album.artist_name, album.title);
              // under the meta line, like a Soulseek row's links, so it never gets cut off
              const better =
                verdict?.below && onBetterCopies && betterCopies?.has(folder) ? (
                  <span className={styles.rowLinks}>
                    <a
                      href="#search-soulseek"
                      className={styles.link}
                      aria-label={`Better copies of ${album.title} below`}
                      onClick={(event) => {
                        event.preventDefault();
                        onBetterCopies(folder);
                      }}
                    >
                      Better copies below
                    </a>
                  </span>
                ) : null;
              return (
                <div className={styles.row} data-kind="library" key={`album:${album.id}`}>
                  <Art url={album.thumb_url} />
                  <div className={styles.rowText}>
                    {to ? (
                      <AppLink to={to} className={styles.rowTitle}>
                        {album.title}
                      </AppLink>
                    ) : (
                      <span className={styles.rowTitle}>{album.title}</span>
                    )}
                    <span className={`${styles.rowMeta} ${styles.wideOnly}`}>
                      {albumMeta(album, verdict)}
                    </span>
                    <span className={`${styles.rowMeta} ${styles.phoneOnly}`}>
                      {shortMeta(row, verdict)}
                    </span>
                    {better}
                  </div>
                  <span className={styles.tagCell}>
                    <QualityTag verdict={verdict} />
                  </span>
                  <div className={styles.actions}>
                    <Button
                      size="lg"
                      aria-label={`Play ${album.title}`}
                      aria-busy={playing === `album:${album.id}` || undefined}
                      onClick={() => void playAlbum(album)}
                    >
                      Play
                    </Button>
                    {to ? (
                      <ButtonLink to={to} variant="ghost" label={`Open ${album.title}`}>
                        Open
                      </ButtonLink>
                    ) : null}
                  </div>
                </div>
              );
            }
            const track = row.item;
            const verdict = qualityVerdict([track], bar);
            return (
              <div className={styles.row} data-kind="library" key={`track:${track.id}`}>
                <Art url={track.album_thumb_url} />
                <div className={styles.rowText}>
                  <span className={styles.rowTitle}>{track.title}</span>
                  <span className={`${styles.rowMeta} ${styles.wideOnly}`}>
                    {trackMeta(track, verdict)}
                    <DjMeta dj={djInfo[String(track.id)]} lead />
                  </span>
                  <span className={`${styles.rowMeta} ${styles.phoneOnly}`}>
                    {shortMeta(row, verdict)}
                    <DjMeta dj={djInfo[String(track.id)]} lead />
                  </span>
                </div>
                <span className={styles.tagCell}>
                  <QualityTag verdict={verdict} />
                </span>
                <div className={styles.actions}>
                  {track.file_path ? (
                    <Button
                      size="lg"
                      aria-label={`Play ${track.title}`}
                      onClick={() =>
                        playOwnedTrack({
                          track_id: track.id,
                          title: track.title,
                          file_path: track.file_path,
                          album_thumb_url: track.album_thumb_url,
                          album_title: track.album_title,
                          artist_name: track.artist_name,
                        })
                      }
                    >
                      Play
                    </Button>
                  ) : null}
                  {track.file_path ? (
                    // 152: "Mixes well with" opens the shell's docked panel
                    <Button
                      size="lg"
                      variant="ghost"
                      aria-label={`Mixes well with ${track.title}`}
                      onClick={() => openMixes({ id: String(track.id), title: track.title })}
                    >
                      Mixes well with…
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
          <div className={`${styles.cardFoot} ${styles.wideFoot}`}>
            <span>
              {ofLine(shown.length, total)}
              {data?.partial ? ' · some of your library didn’t answer' : ''}
            </span>
            {type === 'everything' ? (
              <AppLink className={styles.link} to={libraryLink}>
                All library results
              </AppLink>
            ) : rows.length > TYPED_ROWS && !more ? (
              <button type="button" className={styles.linkButton} onClick={() => setMore(true)}>
                Show all {rows.length.toLocaleString('en-GB')}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
