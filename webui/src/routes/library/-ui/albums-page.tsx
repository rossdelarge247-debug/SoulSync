import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { Button } from '@/components/form';
import { Notice, Skeleton } from '@/components/primitives';
import { useProfile } from '@/platform/shell/route-controllers';

import type { LibrarySearch, LibraryRelease, ReleasesResponse } from '../-library.types';

import {
  followArtists,
  genresQueryOptions,
  loadAlbumTracks,
  releasesInfiniteQueryOptions,
  selectionSummary,
  upgradeAlbums,
} from '../-library.api';
import {
  EMPTY_SELECTION,
  isChecked,
  ownedIds,
  selectAll,
  selectionBody,
  selectionCount,
  selectionTracks,
  toggleRelease,
  type Selection,
} from '../-library.grid';
import { albumQueueTrack } from '../-library.helpers';
import { ALBUM_SHOWS, ALBUM_SORTS, GENRE_SHOWS, GENRE_SORTS, pick } from '../-library.types';
import {
  AddConfirm,
  QualityPicker,
  useAddOne,
  useRefreshLibrary,
  type AddRequest,
} from './add-confirm';
import { GenresGrid } from './genres-tab';
import styles from './library.module.css';
import {
  FilterField,
  GenreChips,
  MoreMenu,
  PageTabs,
  ShowButtons,
  SortSelect,
  plural,
  type MenuEntry,
} from './parts';
import { ReleaseTile } from './release-tile';
import { RemoveFromLibrary } from './remove-flow';
import { SelectionBar } from './selection-bar';

export type Go = (patch: Partial<LibrarySearch>, options?: { replace?: boolean }) => void;

const SORT_LABELS = {
  recent: 'Recently added',
  artist: 'Artist A–Z',
  title: 'Title',
  year: 'Year',
  genre: 'Genre',
} as const;

const GENRE_SORT_LABELS = { albums: 'Most albums', name: 'Name A–Z' } as const;

/** The squares that stand in while the grid loads (and, faded, behind a failure). */
export function GridSkeleton({ count = 18, cols = 6 }: { count?: number; cols?: 4 | 6 }) {
  return (
    <ul className={styles.grid} data-cols={cols === 4 ? '4' : undefined} aria-hidden="true">
      {Array.from({ length: count }, (_v, i) => (
        <li key={i} className={styles.tile}>
          <Skeleton className={styles.skeletonSquare} />
          <Skeleton />
        </li>
      ))}
    </ul>
  );
}

export function LoadFailed({
  what,
  onRetry,
  children,
}: {
  what: string;
  onRetry: () => void;
  children?: ReactNode;
}) {
  return (
    <>
      <Notice
        tone="danger"
        role="alert"
        title={`Couldn't load your ${what}`}
        actions={
          <Button size="lg" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        SYNCHRO.S couldn't read your library just now. Your music and Wanted are safe; this is a
        display problem.
      </Notice>
      <div className={styles.faded}>{children}</div>
    </>
  );
}

function subtitleFor(totals: ReleasesResponse['totals'] | undefined): {
  long: string;
  short: string;
} {
  if (!totals) return { long: ' ', short: ' ' };
  const missing = totals.missing
    ? `${totals.missing.toLocaleString()} you don't have yet`
    : 'nothing missing';
  return {
    long: [
      plural(totals.albums, 'album'),
      plural(totals.tracks, 'track'),
      plural(totals.genres, 'genre'),
      missing,
    ].join(' · '),
    short: `${plural(totals.albums, 'album')} · ${missing}`,
  };
}

/** Shuffle and the old library's other tools, kept in the header's "…". */
export function pageMenuEntries(): MenuEntry[] {
  return [
    {
      key: 'shuffle',
      label: 'Shuffle your library',
      onSelect: () => void window.startLibraryRadio?.(),
    },
  ];
}

/**
 * Library → Albums (7a–7e): the Albums and Genres tabs, the toolbar, the
 * genre line, selection and the confirm. Selections live here, so they
 * survive the filter, the genre and switching tabs; Done or Escape clears.
 */
export function AlbumsPage({ search, go }: { search: LibrarySearch; go: Go }) {
  const { profileId, isAdmin } = useProfile();
  const tab = search.tab;
  const show = pick(search.show, tab === 'genres' ? GENRE_SHOWS : ALBUM_SHOWS);
  const sort = pick(search.sort, tab === 'genres' ? GENRE_SORTS : ALBUM_SORTS);
  const genre = search.genre;
  const q = search.q;

  const releasesQuery = useInfiniteQuery({
    ...releasesInfiniteQueryOptions(profileId, {
      show: tab === 'albums' ? show : 'all',
      genre: tab === 'albums' ? genre : '',
      q: tab === 'albums' ? q : '',
      sort: tab === 'albums' ? sort : 'recent',
    }),
    enabled: tab === 'albums',
  });
  const genresQuery = useQuery({
    ...genresQueryOptions(profileId, { show, sort, q }),
    enabled: tab === 'genres',
  });
  const first = releasesQuery.data?.pages[0];
  const releases = useMemo(
    () => releasesQuery.data?.pages.flatMap((p) => p.releases) ?? [],
    [releasesQuery.data],
  );
  const totals = first?.totals ?? genresQuery.data?.totals;
  const subtitle = subtitleFor(totals);

  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [genrePicks, setGenrePicks] = useState<ReadonlyMap<string, number>>(new Map());
  const [confirm, setConfirm] = useState<AddRequest | null>(null);
  const [qualityFor, setQualityFor] = useState<AddRequest | null>(null);
  const [removing, setRemoving] = useState<string[] | null>(null);
  const [playing, setPlaying] = useState<ReadonlySet<string>>(new Set());
  const addOne = useAddOne();
  const refresh = useRefreshLibrary();

  const stopSelecting = () => {
    setSelecting(false);
    setSelection(EMPTY_SELECTION);
    setGenrePicks(new Map());
  };
  useEffect(() => {
    if (!selecting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      stopSelecting();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting]);

  const playAlbum = async (release: LibraryRelease) => {
    if (release.album_id === null || playing.has(release.id)) return;
    setPlaying((s) => new Set(s).add(release.id));
    try {
      const tracks = await loadAlbumTracks(release.album_id);
      if (!tracks.length) {
        window.showToast?.(`No playable tracks in ${release.title}`, 'info');
        return;
      }
      const album = {
        id: release.album_id,
        title: release.title,
        artist_id: release.artist_id ?? '',
        artist_name: release.artist_name,
        thumb_url: release.art_url,
      };
      await window.playTrackList?.(
        tracks.map((track) => albumQueueTrack(track, album)),
        release.title,
      );
    } catch {
      window.showToast?.(`Couldn't play ${release.title}`, 'error');
    } finally {
      setPlaying((s) => {
        const next = new Set(s);
        next.delete(release.id);
        return next;
      });
    }
  };

  // ── header ──
  const header = (
    <header className={styles.header}>
      <div className={styles.headText}>
        <h1 className={styles.title}>Albums</h1>
        <p className={styles.subtitle}>
          <span className={styles.subtitleWide}>{subtitle.long}</span>
          <span className={styles.subtitlePhone}>{subtitle.short}</span>
        </p>
      </div>
      <div className={styles.headActions}>
        <FilterField
          id="library-search-input"
          value={q}
          onChange={(next) => go({ q: next }, { replace: true })}
          placeholder={tab === 'genres' ? 'Filter genres' : 'Filter by title, artist or genre'}
          phonePlaceholder={tab === 'genres' ? 'Genre' : 'Title, artist or genre'}
          label={tab === 'genres' ? 'Filter genres' : 'Filter albums'}
          genres={tab === 'albums' ? first?.genres : undefined}
          onPickGenre={(g) => go({ genre: g.key, q: '' })}
        />
        <button
          type="button"
          className={styles.selectToggle}
          aria-pressed={selecting}
          onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
        >
          {selecting ? 'Done' : 'Select'}
        </button>
        <MoreMenu
          className={styles.pageMenu}
          label="More for your library"
          entries={pageMenuEntries()}
        />
      </div>
    </header>
  );

  const tabs = (
    <PageTabs
      label="Albums"
      value={tab}
      onChange={(next) => go({ tab: next, show: '', sort: '', q: '' })}
      tabs={[
        { key: 'albums', label: 'Albums', count: totals?.albums },
        { key: 'genres', label: 'Genres', count: totals?.genres },
      ]}
    />
  );

  // ── genres tab ──
  if (tab === 'genres') {
    const data = genresQuery.data;
    const picked = [...genrePicks.keys()];
    const missingAcross = [...genrePicks.values()].reduce((a, b) => a + b, 0);
    return (
      <div className={styles.page}>
        {header}
        <div className={styles.toolbar}>
          {tabs}
          <div className={styles.toolbarEnd}>
            <ShowButtons
              value={show as 'all' | 'gaps'}
              onChange={(next) => go({ show: next === 'all' ? '' : next })}
              options={[
                { key: 'all', label: 'All' },
                { key: 'gaps', label: 'With gaps', count: data?.show_counts.gaps },
              ]}
            />
            <SortSelect
              value={sort as 'albums' | 'name'}
              onChange={(next) => go({ sort: next === 'albums' ? '' : next })}
              options={GENRE_SORTS.map((key) => ({ key, label: GENRE_SORT_LABELS[key] }))}
            />
          </div>
        </div>
        {genresQuery.isError ? (
          <LoadFailed what="genres" onRetry={() => void genresQuery.refetch()}>
            <GridSkeleton count={8} cols={4} />
          </LoadFailed>
        ) : !data ? (
          <GridSkeleton count={8} cols={4} />
        ) : (
          <GenresGrid
            tiles={data.genres}
            selecting={selecting}
            picked={genrePicks}
            onToggle={(tile) =>
              setGenrePicks((current) => {
                const next = new Map(current);
                if (next.has(tile.key)) next.delete(tile.key);
                else next.set(tile.key, tile.wantable);
                return next;
              })
            }
            onOpen={(tile) => go({ tab: 'albums', genre: tile.key, show: '', sort: '', q: '' })}
            onAdd={(tile) =>
              setConfirm({
                body: { filter: { genre: tile.key } },
                what: `Everything tagged ${tile.name} that isn't in your library.`,
              })
            }
          />
        )}
        {selecting ? (
          <SelectionBar
            barLabel="Selected genres"
            label={`${plural(picked.length, 'genre')} selected · ${missingAcross.toLocaleString()} missing`}
            shortLabel={`${plural(picked.length, 'genre')} · ${missingAcross.toLocaleString()} missing`}
            count={picked.length ? missingAcross : 0}
            primaryLabel={`Add ${missingAcross.toLocaleString()} missing across ${plural(picked.length, 'genre')}`}
            emptyReason={
              picked.length ? 'Nothing missing in these genres' : 'Click genres to select them'
            }
            onPrimary={() =>
              setConfirm({
                body: { filter: { genres: picked } },
                what: `Everything in ${plural(picked.length, 'genre')} that isn't in your library.`,
              })
            }
            menu={[
              {
                key: 'quality',
                label: 'Hold to a different quality…',
                disabled: !picked.length,
                onSelect: () =>
                  setQualityFor({
                    body: { filter: { genres: picked } },
                    what: `Everything in ${plural(picked.length, 'genre')} that isn't in your library.`,
                  }),
              },
            ]}
            onDone={stopSelecting}
          />
        ) : null}
        {confirm ? (
          <AddConfirm request={confirm} onClose={() => setConfirm(null)} onDone={stopSelecting} />
        ) : null}
        {qualityFor ? (
          <QualityPicker
            onClose={() => setQualityFor(null)}
            onPick={(quality) => {
              setConfirm({ ...qualityFor, quality });
              setQualityFor(null);
            }}
          />
        ) : null}
      </div>
    );
  }

  // ── albums tab ──
  const showCounts = first?.show_counts;
  const genreSummary = first?.genre_summary;
  const missing = first?.missing_summary;
  const count = selectionCount(selection);
  const tracks = selectionTracks(selection);
  const allActive =
    selection.all &&
    selection.all.filter.show === show &&
    selection.all.filter.genre === genre &&
    selection.all.filter.q === q;
  const viewWhat = genre
    ? `Everything tagged ${genreSummary?.name ?? genre} that isn't in your library.`
    : show === 'missing'
      ? "Everything of your artists' that isn't in your library."
      : 'The albums you picked.';

  const groups: ReactNode[] = [];
  let lastGroup: string | undefined;
  for (const release of releases) {
    if (sort === 'genre' && release.group !== lastGroup) {
      lastGroup = release.group;
      groups.push(
        <li key={`g-${release.group}`} className={styles.groupItem}>
          <h2 className={styles.groupHeading}>{release.group}</h2>
        </li>,
      );
    }
    groups.push(
      <ReleaseTile
        key={release.id}
        release={release}
        selecting={selecting}
        checked={isChecked(selection, release)}
        onToggle={() => setSelection((s) => toggleRelease(s, release))}
        onPlay={() => void playAlbum(release)}
        onAdd={() => addOne.mutate(release)}
        playPending={playing.has(release.id)}
        addPending={addOne.isPending && addOne.variables?.id === release.id}
      />,
    );
  }

  const total = first?.total ?? 0;
  const remaining = total - releases.length;
  const filtered = Boolean(q || genre || show !== 'all');

  const selectionMenu: MenuEntry[] = [
    {
      key: 'follow',
      label: 'Follow these artists',
      disabled: count === 0,
      onSelect: () => {
        void selectionSummary({ ...selectionBody(selection), sample: 1 })
          .then((summary) => followArtists(summary.artists.map((a) => a.id)))
          .then((result) => {
            window.showToast?.(
              [
                result.followed ? `Following ${plural(result.followed, 'more artist')}` : '',
                result.already_following ? `${result.already_following} already followed` : '',
                result.no_id ? `${result.no_id} not matched on a metadata service yet` : '',
              ]
                .filter(Boolean)
                .join(' · ') || 'Nothing to follow.',
              'success',
            );
            refresh();
          })
          .catch((error: Error) => window.showToast?.(error.message, 'error'));
      },
    },
    {
      key: 'quality',
      label: 'Hold to a different quality…',
      disabled: count === 0,
      onSelect: () => setQualityFor({ body: selectionBody(selection), what: viewWhat }),
    },
  ];
  if (isAdmin) {
    const owned = ownedIds(selection);
    selectionMenu.push(
      { key: 'sep', separator: true },
      {
        key: 'remove',
        label: owned.length
          ? `Remove ${plural(owned.length, 'album')} from library…`
          : 'Remove from library…',
        tone: 'danger',
        disabled: !owned.length,
        onSelect: () => setRemoving(owned),
      },
    );
  }

  return (
    <div className={styles.page}>
      {header}
      <div className={styles.toolbar}>
        {tabs}
        <div className={styles.toolbarEnd}>
          <ShowButtons
            value={show as (typeof ALBUM_SHOWS)[number]}
            onChange={(next) => go({ show: next === 'all' ? '' : next })}
            options={[
              { key: 'all', label: 'All' },
              { key: 'library', label: 'In your library', count: showCounts?.library },
              { key: 'missing', label: 'Missing', count: showCounts?.missing },
              { key: 'below', label: 'Below target', count: showCounts?.below },
            ]}
          />
          <SortSelect
            value={sort as (typeof ALBUM_SORTS)[number]}
            onChange={(next) => go({ sort: next === 'recent' ? '' : next })}
            options={ALBUM_SORTS.map((key) => ({ key, label: SORT_LABELS[key] }))}
          />
        </div>
      </div>
      {first && (first.genres.length || genre) ? (
        <GenreChips
          genres={first.genres}
          value={genre}
          total={first.genre_total}
          onChange={(key) => go({ genre: key })}
        />
      ) : null}
      {genre && genreSummary ? (
        <div className={styles.genreLine}>
          <p>
            <strong>{genreSummary.name}</strong> · {plural(genreSummary.albums, 'album')} ·{' '}
            {genreSummary.library.toLocaleString()} in your library ·{' '}
            <strong>{genreSummary.missing.toLocaleString()} you don't have</strong>
            {genreSummary.below ? (
              <span className={styles.belowNote}>
                {' '}
                · {genreSummary.below.toLocaleString()} below your quality target
              </span>
            ) : null}
          </p>
          <span className={styles.genreLineSpacer} />
          <div className={styles.genreLineActions}>
            {genreSummary.wantable.count ? (
              <Button
                size="lg"
                variant="primary"
                onClick={() =>
                  setConfirm({
                    body: { filter: { genre } },
                    what: `Everything tagged ${genreSummary.name} that isn't in your library.`,
                  })
                }
              >
                Add the {genreSummary.wantable.count.toLocaleString()} missing to Wanted
              </Button>
            ) : null}
            {genreSummary.below && isAdmin ? (
              <UpgradeButton albumIds={genreSummary.below_album_ids} count={genreSummary.below} />
            ) : null}
          </div>
        </div>
      ) : null}
      {releasesQuery.isError ? (
        <LoadFailed what="albums" onRetry={() => void releasesQuery.refetch()}>
          <GridSkeleton />
        </LoadFailed>
      ) : releasesQuery.isPending ? (
        <GridSkeleton />
      ) : releases.length ? (
        <ul className={styles.grid} id="library-albums-grid" data-kind="albums" aria-label="Albums">
          {groups}
        </ul>
      ) : (
        <div className={styles.empty}>
          <h2>{filtered ? 'No albums match' : 'No albums yet'}</h2>
          <p>
            {filtered
              ? 'Nothing here fits this filter. Clear it to see everything.'
              : 'Once your media server is scanned, or SYNCHRO.S files a download, your albums show up here.'}
          </p>
          {filtered ? (
            <Button
              size="lg"
              variant="secondary"
              onClick={() => go({ q: '', genre: '', show: '' })}
            >
              Clear the filter
            </Button>
          ) : null}
        </div>
      )}
      {releases.length ? (
        <div className={styles.footer}>
          <span>
            {releases.length.toLocaleString()} of {total.toLocaleString()}
          </span>
          {releasesQuery.hasNextPage ? (
            <>
              <Button
                size="lg"
                variant="secondary"
                disabled={releasesQuery.isFetchingNextPage}
                onClick={() => void releasesQuery.fetchNextPage()}
              >
                {releasesQuery.isFetchingNextPage
                  ? 'Loading…'
                  : `Show ${Math.min(50, remaining)} more`}
              </Button>
              <button
                type="button"
                className={`${styles.linkButton} ${styles.footerMore}`}
                onClick={() => void releasesQuery.fetchNextPage()}
              >
                Show more
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {selecting ? (
        <SelectionBar
          barLabel="Selected albums"
          label={`${plural(count, 'album')} selected · ${plural(tracks, 'track')}`}
          shortLabel={`${plural(count, 'album')} · ${plural(tracks, 'track')}`}
          count={count}
          primaryLabel={`Add ${count.toLocaleString()} to Wanted`}
          emptyReason="Click albums to select them"
          selectAll={
            missing && missing.count && !allActive
              ? {
                  label: `Select all ${missing.count.toLocaleString()} missing`,
                  onClick: () =>
                    setSelection((s) =>
                      selectAll(s, {
                        filter: { show, genre, q },
                        count: missing.count,
                        tracks: missing.tracks,
                      }),
                    ),
                }
              : null
          }
          onPrimary={() => setConfirm({ body: selectionBody(selection), what: viewWhat })}
          menu={selectionMenu}
          onDone={stopSelecting}
        />
      ) : null}
      {confirm ? (
        <AddConfirm request={confirm} onClose={() => setConfirm(null)} onDone={stopSelecting} />
      ) : null}
      {qualityFor ? (
        <QualityPicker
          onClose={() => setQualityFor(null)}
          onPick={(quality) => {
            setConfirm({ ...qualityFor, quality });
            setQualityFor(null);
          }}
        />
      ) : null}
      {removing ? (
        <RemoveFromLibrary
          body={{ release_ids: removing }}
          onClose={() => setRemoving(null)}
          onDone={() => {
            stopSelecting();
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** "Upgrade the 4 below target" (7b): hands them to the quality upgrades (admins). */
function UpgradeButton({ albumIds, count }: { albumIds: (string | number)[]; count: number }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const result = await upgradeAlbums(albumIds);
      const parts = [];
      if (result.queued)
        parts.push(`Queued ${plural(result.queued, 'better copy', 'better copies')} on Wanted`);
      if (result.albums_without)
        parts.push(
          `${plural(result.albums_without, 'album')} ${result.albums_without === 1 ? 'has' : 'have'} no better copy found yet; the Quality Upgrade Finder keeps looking`,
        );
      window.showToast?.(
        parts.join(' · ') || 'Nothing to upgrade yet.',
        result.queued ? 'success' : 'info',
      );
    } catch (error) {
      window.showToast?.((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="lg"
      variant="secondary"
      className={styles.upgrade}
      disabled={busy}
      onClick={() => void run()}
    >
      {busy ? 'Queuing…' : `Upgrade the ${count.toLocaleString()} below target`}
    </Button>
  );
}
