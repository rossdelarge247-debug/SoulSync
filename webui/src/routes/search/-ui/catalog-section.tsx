/**
 * The connected metadata service's section (board 2m "Spotify"): releases,
 * playlists, tracks, artists and labels it found, showing what you don't have
 * yet first. Releases and tracks offer "Add to Wanted", playlists "Mirror this
 * playlist"; a title opens today's download window (releases and tracks) or
 * the playlist's track preview. The service can be switched here, including
 * music videos from YouTube.
 */

import { useState } from 'react';

import { Button, Select } from '@/components/form';
import { LoadingState, Notice, SkeletonList, StatusTag } from '@/components/primitives';
import { AddToPlaylistButton } from '@/features/playlists/add-to-playlist';
import { AppLink } from '@/routes/activity/-ui/app-link';

import type { CatalogRow } from '../-catalog.model';
import type { OwnershipState } from '../-search.ownership';
import type {
  LibraryCheckTrack,
  SearchAlbum,
  SearchLabel,
  SearchPlaylist,
  SearchTrack,
  SearchVideo,
  SourceResults,
} from '../-search.types';
import type { SearchType } from '../-search.url';
import type { VideoProgress } from './video-grid';

import { catalogCounts, catalogMeta, catalogRows, catalogShortMeta } from '../-catalog.model';
import {
  artistDetailPath,
  fallbackBannerText,
  labelDetailPath,
  playlistTrackOf,
  sourceLabel,
  trackIdentity,
} from '../-search.helpers';
import styles from './search-page.module.css';
import { Art, ButtonLink, ofLine, rowLimit, SectionHead, usePhoneWidth } from './search-parts';
import { VideoGrid } from './video-grid';

export interface CatalogActions {
  onAddAlbum: (album: SearchAlbum) => void;
  onAddTrack: (track: SearchTrack) => void;
  onOpenAlbum: (album: SearchAlbum) => void;
  onOpenTrack: (track: SearchTrack) => void;
  onPlayTrack: (track: SearchTrack, owned: LibraryCheckTrack | undefined) => void;
  onPreviewPlaylist: (playlist: SearchPlaylist) => void;
  onMirrorPlaylist: (playlist: SearchPlaylist) => void;
  onVideo: (video: SearchVideo) => void;
}

function rowArt(row: CatalogRow, artistImages: Record<string, string>): string | undefined {
  switch (row.kind) {
    case 'album':
      return row.item.image_url || row.item.images?.[0]?.url || undefined;
    case 'playlist':
      return row.item.image_url || undefined;
    case 'track':
      return row.item.image_url || undefined;
    case 'artist':
      return (
        artistImages[String(row.item.id ?? '')] ||
        row.item.image_url ||
        row.item.images?.[0]?.url ||
        undefined
      );
    default:
      return undefined;
  }
}

export function CatalogSection({
  query,
  type,
  activeSource,
  sources,
  configured,
  onSource,
  loading,
  failed,
  onRetry,
  served,
  results,
  labels,
  ownership,
  artistImages,
  videoProgress,
  acquireVerb,
  actions,
}: {
  query: string;
  type: SearchType;
  activeSource: string;
  /** The services that can be picked here, in picker order. */
  sources: string[];
  configured: Record<string, boolean>;
  onSource: (source: string) => void;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  /** What actually answered, when it isn't what was asked. */
  served: string | null;
  results: SourceResults;
  labels: SearchLabel[];
  ownership: OwnershipState;
  artistImages: Record<string, string>;
  videoProgress: Record<string, VideoProgress>;
  /** "Download" or "Request", for a profile that asks first. */
  acquireVerb: string;
  actions: CatalogActions;
}) {
  const [showAll, setShowAll] = useState(false);
  const videos = activeSource === 'youtube_videos';
  const title = videos ? 'Music videos' : sourceLabel(activeSource);
  const { rows, all, hiddenOwned } = catalogRows({
    results,
    labels,
    ownership,
    type,
    query,
    showOwned: showAll,
  });
  const phone = usePhoneWidth();
  const baseLimit = rowLimit(type, phone, 1);
  const limit = showAll ? rows.length : baseLimit;
  const shown = rows.slice(0, limit);

  const picker = (
    <Select
      size="lg"
      className={styles.sourceSelect}
      aria-label="Service to search"
      value={activeSource}
      onChange={(event) => onSource(event.target.value)}
    >
      {sources.map((source) => (
        <option key={source} value={source}>
          {source === 'youtube_videos' ? 'Music videos (YouTube)' : sourceLabel(source)}
          {configured[source] === false ? ' (not set up)' : ''}
        </option>
      ))}
    </Select>
  );

  let body: React.ReactNode;
  if (loading) {
    body = (
      <LoadingState label={`Searching ${title}…`}>
        <SkeletonList rows={3} />
      </LoadingState>
    );
  } else if (failed) {
    body = (
      <>
        <Notice
          tone="danger"
          role="alert"
          title={`Couldn’t search ${title}`}
          actions={
            <Button size="lg" onClick={onRetry}>
              Try again
            </Button>
          }
        >
          {title} didn’t answer, so this part of the page is empty. The other sections still
          searched.
        </Notice>
        <SkeletonList rows={2} faded />
      </>
    );
  } else if (videos) {
    body = results.videos.length ? (
      <VideoGrid videos={results.videos} progress={videoProgress} onDownload={actions.onVideo} />
    ) : (
      <div className={styles.card}>
        <p className={styles.note}>No music videos match “{query}”.</p>
      </div>
    );
  } else if (!rows.length) {
    body = (
      <div className={styles.card}>
        <p className={styles.note}>
          {hiddenOwned ? (
            <>
              You have everything {title} found for “{query}”.{' '}
              <button type="button" className={styles.linkButton} onClick={() => setShowAll(true)}>
                Show it anyway
              </button>
            </>
          ) : (
            `${title} has nothing for “${query}”${type === 'everything' ? '' : ` among its ${type}`}.`
          )}
        </p>
      </div>
    );
  } else {
    body = (
      <div className={styles.card}>
        {shown.map((row) => (
          <CatalogRowView
            key={row.key}
            row={row}
            art={rowArt(row, artistImages)}
            activeSource={activeSource}
            ownership={ownership}
            acquireVerb={acquireVerb}
            actions={actions}
          />
        ))}
        <div className={styles.cardFoot}>
          <span>
            {hiddenOwned && !showAll ? (
              <>
                <span className={styles.wideOnly}>Showing what you don’t have yet</span>
                <span className={styles.phoneOnly}>{ofLine(shown.length, all.length)}</span>
              </>
            ) : (
              ofLine(shown.length, rows.length)
            )}
          </span>
          {!showAll && all.length > shown.length ? (
            <button type="button" className={styles.linkButton} onClick={() => setShowAll(true)}>
              All {all.length.toLocaleString('en-GB')}
            </button>
          ) : showAll && all.length > baseLimit ? (
            <button type="button" className={styles.linkButton} onClick={() => setShowAll(false)}>
              Show fewer
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <section className={styles.section} aria-labelledby="search-catalog-title" id="search-catalog">
      <SectionHead
        id="search-catalog-title"
        title={title}
        aside={
          <>
            {!loading && !failed && all.length && !videos ? (
              <span className={styles.wideOnly}>{catalogCounts(all)}</span>
            ) : null}
            {sources.length > 1 ? picker : null}
          </>
        }
      />
      {served && !loading ? (
        <Notice tone="info" id="enh-fallback-banner">
          {fallbackBannerText(activeSource, served)}
        </Notice>
      ) : null}
      {body}
    </section>
  );
}

function CatalogRowView({
  row,
  art,
  activeSource,
  ownership,
  acquireVerb,
  actions,
}: {
  row: CatalogRow;
  art: string | undefined;
  activeSource: string;
  ownership: OwnershipState;
  acquireVerb: string;
  actions: CatalogActions;
}) {
  const meta = catalogMeta(row);
  let titleNode: React.ReactNode;
  let tag: React.ReactNode = null;
  let buttons: React.ReactNode = null;

  switch (row.kind) {
    case 'album': {
      const album = row.item;
      titleNode = (
        <button
          type="button"
          className={styles.rowTitle}
          title={`${acquireVerb}: pick tracks from ${album.name ?? 'this release'}`}
          onClick={() => actions.onOpenAlbum(album)}
        >
          {album.name}
        </button>
      );
      tag = row.owned ? (
        <StatusTag tone="success">In your library</StatusTag>
      ) : (
        <StatusTag tone="neutral">Not in library</StatusTag>
      );
      buttons = row.owned ? null : (
        <Button
          size="lg"
          aria-label={`Add ${album.name ?? 'this release'} to Wanted`}
          onClick={() => actions.onAddAlbum(album)}
        >
          Add to Wanted
        </Button>
      );
      break;
    }
    case 'playlist': {
      const playlist = row.item;
      titleNode = (
        <button
          type="button"
          className={styles.rowTitle}
          title="See its tracks"
          onClick={() => actions.onPreviewPlaylist(playlist)}
        >
          {playlist.name}
        </button>
      );
      buttons = (
        <Button
          size="lg"
          aria-label={`Mirror this playlist: ${playlist.name ?? ''}`}
          onClick={() => actions.onMirrorPlaylist(playlist)}
        >
          Mirror this playlist
        </Button>
      );
      break;
    }
    case 'track': {
      const track = row.item;
      const owned = ownership.libraryTracks.get(trackIdentity(track));
      titleNode = (
        <button
          type="button"
          className={styles.rowTitle}
          title={`${acquireVerb}: find ${track.name ?? 'this track'}`}
          onClick={() => actions.onOpenTrack(track)}
        >
          {track.name}
        </button>
      );
      tag = row.owned ? (
        <StatusTag tone="success">In your library</StatusTag>
      ) : row.wanted ? (
        <StatusTag tone="info">On Wanted</StatusTag>
      ) : (
        <StatusTag tone="neutral">Not in library</StatusTag>
      );
      buttons = (
        <>
          <Button
            size="lg"
            variant="ghost"
            aria-label={`${owned ? 'Play' : 'Preview'} ${track.name ?? ''}`}
            onClick={() => actions.onPlayTrack(track, owned)}
          >
            {owned ? 'Play' : 'Preview'}
          </Button>
          <AddToPlaylistButton
            track={playlistTrackOf(track)}
            className={styles.iconButton}
            size={18}
          />
          {row.owned || row.wanted ? null : (
            <Button
              size="lg"
              aria-label={`Add ${track.name ?? 'this track'} to Wanted`}
              onClick={() => actions.onAddTrack(track)}
            >
              Add to Wanted
            </Button>
          )}
        </>
      );
      break;
    }
    case 'artist': {
      const artist = row.item;
      const to = artistDetailPath(artist.id ?? '', activeSource, artist.name);
      titleNode = (
        <AppLink to={to} className={styles.rowTitle}>
          {artist.name}
        </AppLink>
      );
      buttons = (
        <ButtonLink to={to} variant="ghost" label={`Open artist ${artist.name ?? ''}`}>
          Open artist
        </ButtonLink>
      );
      break;
    }
    case 'label': {
      const label = row.item;
      const to = labelDetailPath(label.id ?? '', label.name);
      titleNode = (
        <AppLink to={to} className={styles.rowTitle}>
          {label.name}
        </AppLink>
      );
      buttons = (
        <ButtonLink to={to} variant="ghost" label={`Open label ${label.name ?? ''}`}>
          Open label
        </ButtonLink>
      );
      break;
    }
  }

  return (
    <div className={styles.row} data-kind="catalog" data-testid={`catalog-${row.kind}`}>
      <Art url={art} round={row.kind === 'artist'} />
      <div className={styles.rowText}>
        {titleNode}
        <span className={`${styles.rowMeta} ${styles.wideOnly}`}>{meta}</span>
        <span className={`${styles.rowMeta} ${styles.phoneOnly}`}>{catalogShortMeta(row)}</span>
      </div>
      <span className={styles.tagCell}>{tag}</span>
      <div className={styles.actions}>{buttons}</div>
    </div>
  );
}
