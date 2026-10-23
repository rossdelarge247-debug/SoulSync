import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button, TextInput } from '@/components/form';
import { EmptyState, LoadingState, SkeletonList, StatusTag } from '@/components/primitives';
import { openWishlistInspector } from '@/features/downloads/inspector-modal';
import { profileAsksFirst } from '@/platform/shell/download-rights';

import type { useWantedData } from '../-wanted.hooks';
import type { WantedView } from '../-wanted.nebula';

import {
  qualityProfilesQueryOptions,
  searchWantedNow,
  wantedFoundQueryOptions,
} from '../-wanted.api';
import {
  automationAside,
  cycleText,
  filterWantedRows,
  findSystemAutomation,
  plural,
  qualityNames,
  scheduleState,
  sortWantedRows,
  toFoundItems,
  wantedCounts,
  wantedRows,
  type ScheduleState,
} from '../-wanted.helpers';
import {
  useCountdownFrom,
  useDropFromWantedCache,
  useNow,
  useRefreshWanted,
} from '../-wanted.hooks';
import {
  PAGE_SIZE,
  resolveWantedFilter,
  resolveWantedSort,
  type WantedFilter,
  type WantedItem,
  type WantedSearch,
  type WantedSort,
  type WantedTrack,
} from '../-wanted.types';
import {
  automationsListQueryOptions,
  automationsMasterQueryOptions,
} from '../../automations/-automations.api';
import {
  bulkWishlistActionChunked,
  removeWishlistTrack,
  wishlistCycleQueryOptions,
  wishlistStatsQueryOptions,
} from '../../wishlist/-wishlist.api';
import { useLiveWishlist } from '../../wishlist/-wishlist.live';
import { ConfirmDialog } from './confirm-dialog';
import { AudiobooksView } from './legacy-views';
import { NebulaView } from './nebula-view';
import {
  FilterButtons,
  ListFailure,
  ListFooter,
  SortSelect,
  SubHead,
  ViewToggle,
  type FilterOption,
} from './parts';
import { FoundRowView, WantedRowView, type WantedRowHandlers } from './rows';
import styles from './wanted-page.module.css';

export const WANTED_SORT_OPTIONS: { key: WantedSort; label: string }[] = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'most-tries', label: 'Most tries first' },
  { key: 'artist', label: 'Artist A–Z' },
];

export type Go = (patch: Partial<WantedSearch>, options?: { replace?: boolean }) => void;

function toast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') {
  window.showToast?.(message, type);
}

/** A grab refused because a search is already running reads as that, in words. */
function searchErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/currently running|already in progress/i.test(message)) {
    return 'A search is running now. Try again when it finishes.';
  }
  return message.replace(/[.\s]+$/, '') + '.';
}

function ScheduleLine({
  processing,
  schedule,
  cycle,
  canSearch,
  pending,
  onSearchNow,
  note,
}: {
  processing: boolean;
  schedule: ScheduleState;
  cycle: string;
  canSearch: boolean;
  pending: boolean;
  onSearchNow: () => void;
  /** A sentence after the action (the nebula says how it's drawn); wide only. */
  note?: string;
}) {
  if (processing) {
    return (
      <p className={styles.live} role="status">
        <StatusTag tone="info" live>
          Searching now
        </StatusTag>
        <span>
          SYNCHRO.S is looking for what you want.{' '}
          <Link to="/active-downloads" search={{ media: 'music' }} className={styles.link}>
            See downloads
          </Link>
        </span>
      </p>
    );
  }
  const action =
    canSearch && !pending ? (
      <button type="button" className={styles.linkButton} onClick={onSearchNow}>
        Search now
      </button>
    ) : canSearch ? (
      <span>Starting…</span>
    ) : null;
  let long: ReactNode;
  let short: ReactNode;
  if (schedule.kind === 'paused') {
    long = "Automations are paused, so scheduled searches won't run.";
    short = 'Scheduled searches are paused ·';
  } else if (schedule.kind === 'off') {
    long = 'Scheduled searches are off.';
    short = 'Scheduled searches are off ·';
  } else {
    const what = cycle ? `, for ${cycle}` : '';
    long = `Next scheduled search ${schedule.when}${what}${automationAside(schedule)}.`;
    short = `Next search ${schedule.when} ·`;
  }
  return (
    <p className={styles.line}>
      <span className={styles.lineLong}>{long}</span>
      <span className={styles.lineShort}>{short}</span>
      {action}
      {note ? <span className={styles.lineLong}> · {note}</span> : null}
    </p>
  );
}

export function WantedTab({
  profileId,
  search,
  data,
  tabs,
  view,
  onView,
  selecting,
  onStopSelecting,
  findOpen,
  onCloseFind,
  go,
}: {
  profileId: number;
  search: WantedSearch;
  data: ReturnType<typeof useWantedData>;
  /** The tab bar, drawn at the start of this tab's toolbar row. */
  tabs: ReactNode;
  /** List or nebula (9a), remembered per browser by the page. */
  view: WantedView;
  onView: (view: WantedView) => void;
  selecting: boolean;
  onStopSelecting: () => void;
  findOpen: boolean;
  onCloseFind: () => void;
  go: Go;
}) {
  const navigate = useNavigate();
  const filter = resolveWantedFilter(search.filter);
  const sort = resolveWantedSort(search.sort);
  const nebula = view === 'nebula';
  const pages = search.page ?? 1;
  const query = search.q ?? '';
  const now = useNow();
  const canSearch = !profileAsksFirst();

  const stats = useQuery(wishlistStatsQueryOptions(profileId));
  const cycle = useQuery(wishlistCycleQueryOptions(profileId));
  const foundQuery = useQuery(wantedFoundQueryOptions(profileId));
  const automations = useQuery(automationsListQueryOptions(profileId));
  const master = useQuery(automationsMasterQueryOptions());
  const quality = useQuery(qualityProfilesQueryOptions());

  const refresh = useRefreshWanted();
  const drop = useDropFromWantedCache(profileId);
  const { processing } = useLiveWishlist(() => void refresh());
  const nextRun = useCountdownFrom(stats.data?.next_run_in_seconds);

  const found = useMemo(() => toFoundItems(foundQuery.data), [foundQuery.data]);
  const counts = wantedCounts(data.items, found);
  const rows = useMemo(
    () => sortWantedRows(filterWantedRows(wantedRows(data.items, found), filter, query), sort),
    [data.items, found, filter, query, sort],
  );
  const shown = rows.slice(0, pages * PAGE_SIZE);
  const names = useMemo(() => qualityNames(quality.data?.profiles), [quality.data]);

  const schedule = scheduleState({
    nextRunSeconds: nextRun,
    automation: findSystemAutomation(automations.data, 'process_wishlist'),
    paused: master.data?.music === false,
  });

  // ── actions ────────────────────────────────────────────────────────────
  const [searching, setSearching] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [confirm, setConfirm] = useState<WantedItem[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const lastPicked = useRef<string | null>(null);

  const markSearching = (key: string, on: boolean) =>
    setSearching((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const grab = async (items: WantedItem[], label: string) => {
    const ids = items.flatMap((item) => item.trackIds);
    if (ids.length === 0) return;
    items.forEach((item) => markSearching(item.key, true));
    try {
      const response = await bulkWishlistActionChunked('grab', ids);
      const results = response.results ?? [];
      const ok = results.filter((r) => r.ok).length;
      if (ok === ids.length) toast(`Searching for ${label} now.`);
      else {
        const why = results.find((r) => !r.ok)?.message;
        toast(
          `Started ${ok} of ${plural(ids.length, 'track')}${why ? `; the rest: ${why}` : ''}.`,
          'warning',
        );
      }
      void refresh();
    } catch (error) {
      toast(`Couldn't search for ${label}. ${searchErrorText(error)}`, 'error');
    } finally {
      items.forEach((item) => markSearching(item.key, false));
    }
  };

  const retry = async (items: WantedItem[], label: string) => {
    const ids = items.flatMap((item) => item.trackIds);
    try {
      await bulkWishlistActionChunked('retry', ids);
      toast(`${label} will be searched for on the next scheduled search.`);
      void refresh();
    } catch (error) {
      toast(`Couldn't reset the tries: ${searchErrorText(error)}`, 'error');
    }
  };

  const removeItems = async (items: WantedItem[]) => {
    const ids = items.flatMap((item) => item.trackIds);
    if (ids.length === 0) return;
    drop(ids);
    try {
      if (ids.length === 1) await removeWishlistTrack(ids[0]);
      else {
        const response = await bulkWishlistActionChunked('skip', ids);
        const failed = (response.results ?? []).filter((r) => !r.ok).length;
        if (failed > 0) throw new Error(`${failed} of ${plural(ids.length, 'track')} stayed`);
      }
      toast(
        items.length === 1
          ? `Removed “${items[0].title}” from Wanted.`
          : `Removed ${plural(items.length, 'thing')} from Wanted.`,
      );
      window.updateWishlistCount?.();
    } catch (error) {
      toast(`Couldn't remove everything: ${searchErrorText(error)}`, 'error');
    }
    void refresh();
  };

  const searchAll = useMutation({
    mutationFn: searchWantedNow,
    onSuccess: () => toast('Searching for everything on Wanted now.', 'info'),
    onError: (error: Error) => toast(`The search didn't start. ${searchErrorText(error)}`, 'error'),
  });

  const handlers: WantedRowHandlers = {
    onOpenArtist: (artist) => window._navigateToArtistFromWishlist?.(artist),
    onSearchNow: (item) => void grab([item], `“${item.title}”`),
    onRetry: (item) => void retry([item], `“${item.title}”`),
    onRemove: (item) => {
      if (item.trackIds.length > 1) setConfirm([item]);
      else void removeItems([item]);
    },
    onRemoveTrack: (track: WantedTrack) => {
      drop([track.id]);
      void removeWishlistTrack(track.id)
        .then(() => toast(`Removed “${track.title}” from Wanted.`))
        .catch((error: Error) => toast(`Couldn't remove it: ${error.message}`, 'error'))
        .finally(() => void refresh());
    },
    onSearchByHand: (track) =>
      openWishlistInspector({
        id: track.id,
        name: track.title,
        artist: track.artist,
        album: track.album,
      }),
    onToggleTracks: (item) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(item.key)) next.delete(item.key);
        else next.add(item.key);
        return next;
      }),
  };

  // ── selection ──────────────────────────────────────────────────────────
  const shownWantedKeys = shown.filter((row) => row.type === 'wanted').map((row) => row.item.key);
  const shownKey = shownWantedKeys.join('\u0000');
  useEffect(() => {
    // a selection never outlives the rows it was made on
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const keep = new Set(shownKey.split('\u0000'));
      const next = new Set([...prev].filter((key) => keep.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [shownKey]);
  useEffect(() => {
    if (!selecting) setSelected(new Set());
  }, [selecting]);

  const toggle = (key: string, range: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const from = lastPicked.current ? shownWantedKeys.indexOf(lastPicked.current) : -1;
      const to = shownWantedKeys.indexOf(key);
      if (range && from !== -1 && to !== -1) {
        const [a, b] = from < to ? [from, to] : [to, from];
        for (let i = a; i <= b; i++) next.add(shownWantedKeys[i]);
      } else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    lastPicked.current = key;
  };
  const selectedItems = data.items.filter((item) => selected.has(item.key));

  // ── the views ──────────────────────────────────────────────────────────
  const toolbar = (controls: ReactNode) => (
    <div className={styles.toolbar}>
      {tabs}
      {controls}
    </div>
  );

  if (search.media === 'audiobooks') {
    return (
      <>
        {toolbar(null)}
        <SubHead
          backLabel="Music on Wanted"
          onBack={() => go({ media: undefined })}
          title="Audiobooks on Wanted"
        />
        <div className={styles.legacyView}>
          <AudiobooksView
            profileId={profileId}
            routedArtists={data.routedArtists}
            onChanged={() => void refresh()}
          />
        </div>
      </>
    );
  }

  if (data.isPending) {
    return (
      <>
        {toolbar(null)}
        <LoadingState label="Loading your list…">
          <SkeletonList rows={5} />
        </LoadingState>
      </>
    );
  }

  if (data.isError) {
    return (
      <>
        {toolbar(null)}
        <ListFailure
          title="Couldn't load your list"
          safeLine="Your list is safe."
          error={data.error}
          onRetry={() => void data.refetch()}
        />
      </>
    );
  }

  if (data.items.length === 0 && found.length === 0) {
    return (
      <>
        {toolbar(null)}
        <EmptyState
          variant="panel"
          title="Nothing wanted yet"
          description="Add tracks or albums you want and SYNCHRO.S looks for them on every scheduled search, at the quality you set. When one turns up it is downloaded, tagged and filed, and leaves this list."
          hint="You can add from Search, from a playlist, or from an artist page."
          actions={
            <>
              <Button size="lg" variant="primary" onClick={() => void navigate({ to: '/search' })}>
                Search for music
              </Button>
              <Button size="lg" onClick={() => void navigate({ to: '/sync' })}>
                Mirror a playlist
              </Button>
            </>
          }
        />
      </>
    );
  }

  const filterOptions: FilterOption<WantedFilter>[] = [
    { key: 'all', label: 'All' },
    { key: 'searching', label: 'Searching', count: counts.searching },
    { key: 'not-found', label: 'Not found yet', count: counts.notFound },
    {
      key: 'found',
      label: 'Found this week',
      count: foundQuery.isSuccess ? counts.found : undefined,
    },
  ];

  const emptyFilterText =
    query && filter === 'all'
      ? `Nothing on Wanted matches “${query}”.`
      : filter === 'searching'
        ? 'Nothing on Wanted is in its first searches.'
        : filter === 'not-found'
          ? 'Nothing has gone unfound for three tries or more.'
          : filter === 'found'
            ? 'Nothing was found in the last 7 days.'
            : 'Nothing to show.';

  return (
    <>
      {toolbar(
        <div className={styles.controls}>
          <FilterButtons
            options={filterOptions}
            value={filter}
            onChange={(next) => go({ filter: next === 'all' ? undefined : next, page: undefined })}
          />
          {nebula ? null : (
            <SortSelect
              options={WANTED_SORT_OPTIONS}
              value={sort}
              onChange={(next) =>
                go({ sort: next === 'newest' ? undefined : next, page: undefined })
              }
            />
          )}
          <ViewToggle view={view} onView={onView} />
        </div>,
      )}

      <ScheduleLine
        processing={processing}
        schedule={schedule}
        cycle={cycleText(cycle.data?.cycle)}
        canSearch={canSearch}
        pending={searchAll.isPending}
        onSearchNow={() => searchAll.mutate()}
        note={
          nebula
            ? 'Each artist is sized by how much of theirs you’re waiting on; the groups are what the searches say.'
            : undefined
        }
      />

      {filter === 'not-found' && counts.notFound > 0 ? (
        <p className={styles.line}>
          <span>
            These have been searched for three times or more without a result. SYNCHRO.S waits
            longer between tries as they fail.
          </span>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() =>
              void retry(
                data.items.filter((item) => item.status === 'not-found'),
                `All ${counts.notFound}`,
              )
            }
          >
            Try them all on the next search
          </button>
        </p>
      ) : null}

      {findOpen || query ? (
        <div className={styles.find} role="search">
          <TextInput
            aria-label="Find in this list"
            placeholder="Find a title, artist or album"
            value={query}
            autoFocus={findOpen && !query}
            onChange={(event) =>
              go({ q: event.target.value || undefined, page: undefined }, { replace: true })
            }
          />
          <Button
            size="lg"
            variant="ghost"
            onClick={() => {
              go({ q: undefined, page: undefined }, { replace: true });
              onCloseFind();
            }}
          >
            Close
          </Button>
        </div>
      ) : null}

      {selecting ? (
        <div className={styles.bulkBar} role="region" aria-label="Selected">
          <span className={styles.bulkCount} aria-live="polite">
            {selected.size} selected
          </span>
          {canSearch ? (
            <Button
              size="lg"
              disabled={selected.size === 0}
              onClick={() => void grab(selectedItems, plural(selectedItems.length, 'thing'))}
            >
              Search now
            </Button>
          ) : null}
          <Button
            size="lg"
            disabled={selected.size === 0}
            onClick={() => void retry(selectedItems, plural(selectedItems.length, 'thing'))}
          >
            Try again on the next search
          </Button>
          <Button
            size="lg"
            disabled={selected.size === 0}
            onClick={() => setConfirm(selectedItems)}
          >
            Remove from Wanted…
          </Button>
          <Button size="lg" variant="ghost" onClick={() => setSelected(new Set(shownWantedKeys))}>
            Select all {shownWantedKeys.length} shown
          </Button>
          <Button size="lg" variant="ghost" onClick={onStopSelecting}>
            Done
          </Button>
        </div>
      ) : null}

      {nebula ? (
        <NebulaView
          profileId={profileId}
          items={data.items}
          found={found}
          query={query}
          filter={filter}
          imageSources={data.imageSources}
          now={now}
          canSearch={canSearch}
          qualityName={(item) =>
            (item.qualityProfileId ? names.byId.get(item.qualityProfileId) : undefined) ??
            names.fallback
          }
          handlers={{
            onOpenArtist: handlers.onOpenArtist,
            onSearchNow: (items, label) => void grab(items, label),
            onRemove: (items) => {
              if (items.length === 1 && items[0].trackIds.length === 1) void removeItems(items);
              else setConfirm(items);
            },
            onSearchByHand: handlers.onSearchByHand,
          }}
        />
      ) : (
        <>
          <ul className={styles.list} aria-label="Wanted">
            {shown.length === 0 ? (
              <li>
                <p className={styles.listEmpty}>{emptyFilterText}</p>
              </li>
            ) : (
              shown.map((row) =>
                row.type === 'found' ? (
                  <FoundRowView
                    key={row.item.key}
                    item={row.item}
                    now={now}
                    selecting={selecting}
                    onOpenArtist={handlers.onOpenArtist}
                  />
                ) : (
                  <WantedRowView
                    key={row.item.key}
                    item={row.item}
                    now={now}
                    qualityName={
                      (row.item.qualityProfileId
                        ? names.byId.get(row.item.qualityProfileId)
                        : undefined) ?? names.fallback
                    }
                    canSearch={canSearch}
                    searching={searching.has(row.item.key)}
                    expanded={expanded.has(row.item.key)}
                    selecting={selecting}
                    selected={selected.has(row.item.key)}
                    onToggleSelect={(range) => toggle(row.item.key, range)}
                    handlers={handlers}
                  />
                ),
              )
            )}
          </ul>
          <ListFooter
            shown={shown.length}
            total={rows.length}
            onMore={() => go({ page: pages + 1 }, { replace: true })}
          />
        </>
      )}

      {/* The legacy "Download everything now" dialog reads its counts from
          these two ids (api-monitor.js _showNebulaDownloadChoice). */}
      <span id="wishlist-stat-albums" hidden>
        {stats.data?.albums ?? 0}
      </span>
      <span id="wishlist-stat-singles" hidden>
        {stats.data?.singles ?? 0}
      </span>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm && confirm.length === 1
            ? `Remove “${confirm[0].title}” from Wanted?`
            : `Remove ${plural(confirm?.length ?? 0, 'thing')} from Wanted?`
        }
        confirmLabel={
          confirm && confirm.length === 1
            ? 'Remove from Wanted'
            : `Remove ${plural(confirm?.length ?? 0, 'thing')}`
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const items = confirm ?? [];
          setConfirm(null);
          onStopSelecting();
          void removeItems(items);
        }}
      >
        <p className={styles.dialogText}>
          {(() => {
            const tracks = (confirm ?? []).reduce((n, item) => n + item.trackIds.length, 0);
            return `SYNCHRO.S stops searching for ${plural(tracks, 'track')}. Nothing in your library changes.`;
          })()}
        </p>
        <p className={styles.dialogNote}>
          A followed artist&apos;s check won&apos;t add them back for a while. They&apos;re listed
          under Removed and skipped, in this page&apos;s menu.
        </p>
      </ConfirmDialog>
    </>
  );
}
