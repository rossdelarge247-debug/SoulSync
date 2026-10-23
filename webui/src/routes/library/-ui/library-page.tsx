import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { Button } from '@/components/form';
import { Notice } from '@/components/primitives';
import { useReactPageShell } from '@/platform/shell/route-controllers';

import type { LibrarySearch, LibrarySearchParams } from '../-library.types';

import { libraryUnmatchedQueryOptions } from '../-library.api';
import { useLibraryChanged } from '../-library.live';
import { resolveLibrarySearch } from '../-library.types';
import { Route } from '../route';
import { AlbumsPage, type Go } from './albums-page';
import { ArtistsPage } from './artists-page';
import { HistoryPage } from './history-page';
import styles from './library.module.css';
import { TracksPage } from './tracks-page';

/** Search params without the empty or default ones, so a default never sits in the URL. */
function tidy(search: Partial<LibrarySearch>): LibrarySearchParams {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(search)) {
    if (value === '' || value === undefined || value === null) continue;
    if (key === 'view' && value === 'artists') continue;
    if (key === 'tab' && value === 'albums') continue;
    out[key] = value;
  }
  return out as LibrarySearchParams;
}

/**
 * The "you have tracks nobody could identify" note (#1202). A file that
 * imports with unreadable tags is parked under a made-up "Unknown Artist";
 * the library says so out loud and links straight there. Nothing at all when
 * the count is 0 or the query failed.
 */
function UnmatchedImportsNotice() {
  const { data } = useQuery({ ...libraryUnmatchedQueryOptions(), retry: false });
  const count = data?.count ?? 0;
  if (count <= 0 || !data?.artist_id) return null;
  return (
    <Notice
      tone="warning"
      title={`${count} ${count === 1 ? 'track' : 'tracks'} imported without a match`}
      actions={
        <Button
          size="lg"
          variant="secondary"
          onClick={() => window.location.assign(`/artist-detail/library/${data.artist_id}`)}
        >
          Show them
        </Button>
      }
    >
      Their tags couldn't be read, so they're filed under Unknown Artist instead of the album they
      belong to. Open the artist and use Re-identify on a track to put it back.
    </Notice>
  );
}

/**
 * Library → Artists (/library, its own sidebar row, 7f), Library → Albums
 * (/library?view=albums, with its Genres tab, 7a–7e), Tracks
 * (/library?view=tracks, the DJ data) and Listening history
 * (/library?view=history, 13a). Everything the grid shows is in the URL:
 * view, tab, show, genre, sort and the filter text (and history's kind).
 */
export function LibraryPage() {
  useReactPageShell('library');
  useLibraryChanged();
  const search = resolveLibrarySearch(Route.useSearch());
  const navigate = useNavigate({ from: Route.fullPath });

  const go: Go = (patch, options) =>
    void navigate({
      search: (prev: LibrarySearchParams) => tidy({ ...prev, ...patch }),
      replace: options?.replace,
    });

  // TRAP 0: showLibraryDownloadsSection (shared-helpers.js) owns a node it
  // inserts into [data-library-downloads-host] and refreshes it on download
  // events. The host has no React children, so React never reconciles it away.
  const downloadsHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    window.showLibraryDownloadsSection?.();
  }, []);

  // Library → Tracks: the DJ data (BPM, key and energy), its own page
  if (search.view === 'tracks') {
    return (
      <div id="library-page" className={styles.root}>
        <TracksPage search={search} go={go} />
      </div>
    );
  }

  return (
    // #library-page is the guided tour's anchor (helper.js) and tells these
    // controls apart from the video library's
    <div id="library-page" className={styles.root}>
      <UnmatchedImportsNotice />
      <div ref={downloadsHost} data-library-downloads-host="" />
      {search.view === 'albums' ? (
        <AlbumsPage search={search} go={go} />
      ) : search.view === 'history' ? (
        <HistoryPage search={search} go={go} />
      ) : (
        <ArtistsPage search={search} go={go} />
      )}
    </div>
  );
}
