import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/form';
import { StatusTag } from '@/components/primitives';
import { useProfile } from '@/platform/shell/route-controllers';

import type { IndexArtist, LibrarySearch } from '../-library.types';

import { addToWanted, artistIndexInfiniteQueryOptions, followArtists } from '../-library.api';
import { addedSentence } from '../-library.grid';
import { ARTIST_SHOWS, ARTIST_SORTS, pick } from '../-library.types';
import { loadTopTracks, trackArtistLabel } from '../../artist-detail/-artist-detail.top-tracks';
import { AddConfirm, QualityPicker, useRefreshLibrary, type AddRequest } from './add-confirm';
import { GridSkeleton, LoadFailed, pageMenuEntries, type Go } from './albums-page';
import { ExportArtistsModal } from './export-modal';
import styles from './library.module.css';
import {
  CheckMark,
  FilterField,
  GenreChips,
  MoreMenu,
  PlayIcon,
  ShowButtons,
  SortSelect,
  plural,
} from './parts';
import { Art } from './release-tile';
import { SelectionBar } from './selection-bar';
import { WatchAllModal } from './watch-all-modal';

const SORT_LABELS = {
  name: 'Name A–Z',
  recent: 'Recently added',
  missing: 'Most missing',
} as const;

function artistHref(artist: IndexArtist): string {
  return `/artist-detail/library/${encodeURIComponent(String(artist.id))}`;
}

/**
 * Library → Artists (7f): the same flat grid, square art (the Artist page's
 * header shape), "9 of 14 releases", Following where it applies, and on hover
 * the artist's own bulk action. Opens the Artist page (2g).
 */
export function ArtistsPage({ search, go }: { search: LibrarySearch; go: Go }) {
  const { profileId } = useProfile();
  const show = pick(search.show, ARTIST_SHOWS);
  const sort = pick(search.sort, ARTIST_SORTS);
  const { genre, q } = search;
  const query = useInfiniteQuery(
    artistIndexInfiniteQueryOptions(profileId, { show, genre, q, sort }),
  );
  const first = query.data?.pages[0];
  const artists = useMemo(() => query.data?.pages.flatMap((p) => p.artists) ?? [], [query.data]);
  const totals = first?.totals;

  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlyMap<string, IndexArtist>>(new Map());
  const [confirm, setConfirm] = useState<AddRequest | null>(null);
  const [qualityFor, setQualityFor] = useState<AddRequest | null>(null);
  const [exporting, setExporting] = useState(false);
  const [watchingAll, setWatchingAll] = useState(false);
  const [playing, setPlaying] = useState<ReadonlySet<string>>(new Set());
  const refresh = useRefreshLibrary();

  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Map());
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

  const addOne = useMutation({
    mutationFn: (artist: IndexArtist) =>
      addToWanted({ filter: { artist_ids: [artist.id] }, quality: 'target' }),
    onSuccess: (result) => {
      window.showToast?.(
        addedSentence(result),
        result.failed && !result.added ? 'error' : 'success',
      );
      refresh();
    },
    onError: (error: Error) => window.showToast?.(error.message, 'error'),
  });

  const addFor = (artist: IndexArtist) => {
    if (artist.wantable === 1) addOne.mutate(artist);
    else
      setConfirm({
        body: { filter: { artist_ids: [artist.id] } },
        what: `${artist.name}'s releases that aren't in your library.`,
      });
  };

  const playTopTracks = async (artist: IndexArtist) => {
    const key = String(artist.id);
    if (playing.has(key)) return;
    setPlaying((s) => new Set(s).add(key));
    try {
      const state = await loadTopTracks(artist.id, artist.name);
      if (!state.tracks.length) {
        window.showToast?.(`No top tracks found for ${artist.name}`, 'info');
        return;
      }
      const tracks = state.tracks.map((track) => {
        const name = trackArtistLabel(track, artist.name);
        return {
          ...track,
          title: track.title || track.name || 'Unknown Track',
          name: track.name || track.title || 'Unknown Track',
          artist: name,
          artists: track.artists?.length ? track.artists : [{ name }],
        };
      });
      await window.playTrackList?.(tracks, `${artist.name} — Top Tracks`);
    } catch {
      window.showToast?.(`Couldn't play ${artist.name}'s top tracks`, 'error');
    } finally {
      setPlaying((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  };

  const pickedList = [...picked.values()];
  const missingPicked = pickedList.reduce((n, a) => n + a.wantable, 0);
  const ids = pickedList.map((a) => a.id);
  const what = `The releases of ${plural(ids.length, 'artist')} that aren't in your library.`;
  const total = first?.total ?? 0;
  const filtered = Boolean(q || genre || show !== 'all');

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Artists</h1>
          <p className={styles.subtitle}>
            {totals
              ? [
                  plural(totals.artists, 'artist'),
                  `${totals.following.toLocaleString()} you follow`,
                  `${totals.incomplete.toLocaleString()} with releases you don't have`,
                ].join(' · ')
              : ' '}
          </p>
        </div>
        <div className={styles.headActions}>
          <FilterField
            id="library-search-input"
            value={q}
            onChange={(next) => go({ q: next }, { replace: true })}
            placeholder="Filter by name or genre"
            phonePlaceholder="Name or genre"
            label="Filter artists"
            genres={first?.genres}
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
            entries={[
              // HANDOFF 73's order; "Look for releases you don't have…" (68)
              // joins after the hairline in a later phase
              ...pageMenuEntries(),
              { key: 'tools', separator: true },
              {
                key: 'watch-all',
                label: "Follow every artist you don't follow…",
                onSelect: () => setWatchingAll(true),
              },
              { key: 'export', label: 'Export artists…', onSelect: () => setExporting(true) },
            ]}
          />
        </div>
      </header>
      <div className={styles.toolbar}>
        <ShowButtons
          id="library-show-filter"
          value={show}
          onChange={(next) => go({ show: next === 'all' ? '' : next })}
          options={[
            { key: 'all', label: 'All' },
            { key: 'following', label: 'Following', count: first?.show_counts.following },
            { key: 'incomplete', label: 'Incomplete', count: first?.show_counts.incomplete },
          ]}
        />
        <SortSelect
          value={sort}
          onChange={(next) => go({ sort: next === 'name' ? '' : next })}
          options={ARTIST_SORTS.map((key) => ({ key, label: SORT_LABELS[key] }))}
        />
      </div>
      {first && (first.genres.length || genre) ? (
        <GenreChips
          genres={first.genres}
          value={genre}
          total={first.genre_total}
          onChange={(key) => go({ genre: key })}
        />
      ) : null}
      {query.isError ? (
        <LoadFailed what="artists" onRetry={() => void query.refetch()}>
          <GridSkeleton count={12} />
        </LoadFailed>
      ) : query.isPending ? (
        <GridSkeleton count={12} />
      ) : artists.length ? (
        <ul
          className={styles.grid}
          id="library-artists-grid"
          data-kind="artists"
          aria-label="Artists"
        >
          {artists.map((artist) => {
            const key = String(artist.id);
            const checked = picked.has(key);
            return (
              <li key={key} className={styles.tile}>
                <div className={styles.art}>
                  {selecting ? (
                    <span className={styles.square}>
                      <Art url={artist.image_url} />
                    </span>
                  ) : (
                    <a
                      href={artistHref(artist)}
                      className={styles.squareLink}
                      tabIndex={-1}
                      aria-label={`Open ${artist.name}`}
                    >
                      <span className={styles.square}>
                        <Art url={artist.image_url} />
                      </span>
                    </a>
                  )}
                  {!selecting ? (
                    artist.wantable > 0 ? (
                      <div className={styles.overlay}>
                        <button
                          type="button"
                          className={styles.overlayButton}
                          onClick={() => addFor(artist)}
                        >
                          {addOne.isPending && addOne.variables?.id === artist.id
                            ? 'Adding…'
                            : `Add ${artist.wantable.toLocaleString()} missing to Wanted`}
                        </button>
                      </div>
                    ) : (
                      <div className={styles.overlay} data-place="corner">
                        <button
                          type="button"
                          className={styles.play}
                          aria-label={`Play ${artist.name}'s top tracks`}
                          aria-busy={playing.has(key) || undefined}
                          onClick={() => void playTopTracks(artist)}
                        >
                          <PlayIcon />
                        </button>
                      </div>
                    )
                  ) : (
                    <button
                      type="button"
                      className={styles.toggle}
                      aria-pressed={checked}
                      aria-label={`Select ${artist.name}`}
                      onClick={() =>
                        setPicked((current) => {
                          const next = new Map(current);
                          if (next.has(key)) next.delete(key);
                          else next.set(key, artist);
                          return next;
                        })
                      }
                    >
                      <span className={styles.check} aria-hidden="true">
                        <CheckMark />
                      </span>
                    </button>
                  )}
                </div>
                <div className={styles.text}>
                  <h3 className={styles.tileTitle}>
                    {selecting ? artist.name : <a href={artistHref(artist)}>{artist.name}</a>}
                  </h3>
                  <p className={styles.meta}>
                    {artist.releases
                      ? `${artist.in_library.toLocaleString()} of ${plural(artist.releases, 'release')}`
                      : 'No releases listed yet'}
                  </p>
                </div>
                {artist.following ? (
                  <StatusTag className={styles.tag} tone="success">
                    Following
                  </StatusTag>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={styles.empty}>
          <h2>{filtered ? 'No artists match' : 'No artists yet'}</h2>
          <p>
            {filtered
              ? 'Nothing here fits this filter. Clear it to see everyone.'
              : 'Once your media server is scanned, or SYNCHRO.S files a download, your artists show up here.'}
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
      {artists.length ? (
        // #library-pagination is the guided tour's anchor (helper.js)
        <div className={styles.footer} id="library-pagination">
          <span>
            {artists.length.toLocaleString()} of {total.toLocaleString()}
          </span>
          {query.hasNextPage ? (
            <>
              <Button
                size="lg"
                variant="secondary"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage
                  ? 'Loading…'
                  : `Show ${Math.min(50, total - artists.length)} more`}
              </Button>
              <button
                type="button"
                className={`${styles.linkButton} ${styles.footerMore}`}
                onClick={() => void query.fetchNextPage()}
              >
                Show more
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {selecting ? (
        <SelectionBarForArtists
          count={ids.length}
          missing={missingPicked}
          onAdd={() => setConfirm({ body: { filter: { artist_ids: ids } }, what })}
          onQuality={() => setQualityFor({ body: { filter: { artist_ids: ids } }, what })}
          onFollow={() =>
            void followArtists(ids)
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
              .catch((error: Error) => window.showToast?.(error.message, 'error'))
          }
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
      {exporting ? <ExportArtistsModal onClose={() => setExporting(false)} /> : null}
      {watchingAll ? <WatchAllModal onClose={() => setWatchingAll(false)} /> : null}
    </div>
  );
}

function SelectionBarForArtists({
  count,
  missing,
  onAdd,
  onQuality,
  onFollow,
  onDone,
}: {
  count: number;
  missing: number;
  onAdd: () => void;
  onQuality: () => void;
  onFollow: () => void;
  onDone: () => void;
}) {
  return (
    <SelectionBar
      barLabel="Selected artists"
      label={`${plural(count, 'artist')} selected · ${missing.toLocaleString()} missing`}
      shortLabel={`${plural(count, 'artist')} · ${missing.toLocaleString()} missing`}
      count={count ? missing : 0}
      primaryLabel={`Add ${missing.toLocaleString()} missing to Wanted`}
      emptyReason={
        count ? "They're complete, or what's missing is on Wanted" : 'Click artists to select them'
      }
      onPrimary={onAdd}
      menu={[
        { key: 'follow', label: 'Follow these artists', disabled: !count, onSelect: onFollow },
        {
          key: 'quality',
          label: 'Hold to a different quality…',
          disabled: !missing,
          onSelect: onQuality,
        },
      ]}
      onDone={onDone}
    />
  );
}
