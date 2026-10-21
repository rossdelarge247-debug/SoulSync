import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button, TextInput } from '@/components/form';
import { EmptyState, LoadingState, Notice, SkeletonList, StatusTag } from '@/components/primitives';
import { useRoutedArtists } from '@/features/audiobook-routes/audiobook-routes.queries';

import type { WatchlistScanFrame } from '../../watchlist/-watchlist.scan';
import type { Go } from './wanted-tab';

import { findLibraryArtist, followedSummaryQueryOptions } from '../-wanted.api';
import {
  buildFollowedRows,
  filterFollowedRows,
  findSystemAutomation,
  followedCounts,
  plural,
  relativeAgo,
  scheduleState,
  serverTime,
  sortFollowedRows,
  wantedByArtist,
  type FollowedRow,
} from '../-wanted.helpers';
import { useCountdownFrom, useNow } from '../-wanted.hooks';
import {
  PAGE_SIZE,
  resolveFollowedFilter,
  resolveFollowedSort,
  type FollowedFilter,
  type FollowedSort,
  type WantedItem,
  type WantedSearch,
} from '../-wanted.types';
import {
  automationsListQueryOptions,
  automationsMasterQueryOptions,
} from '../../automations/-automations.api';
import { WatchlistArtistConfigModal } from '../../watchlist/-ui/watchlist-artist-config-modal';
import {
  pickDiscographySource,
  WatchlistArtistDetail,
} from '../../watchlist/-ui/watchlist-artist-detail';
import { WatchlistGlobalSettingsModal } from '../../watchlist/-ui/watchlist-global-settings-modal';
import { WatchlistScanDeck } from '../../watchlist/-ui/watchlist-scan-deck';
import {
  cancelWatchlistScan,
  removeWatchlistArtistsBatch,
  startWatchlistScan,
  WATCHLIST_QUERY_KEY,
  watchlistArtistConfigQueryOptions,
  watchlistArtistsQueryOptions,
  watchlistCountQueryOptions,
  watchlistGlobalConfigQueryOptions,
} from '../../watchlist/-watchlist.api';
import { scanProgressText } from '../../watchlist/-watchlist.scan';
import { ConfirmDialog } from './confirm-dialog';
import { FollowedListView } from './legacy-views';
import {
  FilterButtons,
  ListFailure,
  ListFooter,
  SortSelect,
  SubHead,
  type FilterOption,
} from './parts';
import { FollowedRowView, type FollowedRowHandlers } from './rows';
import styles from './wanted-page.module.css';

export const FOLLOWED_SORT_OPTIONS: { key: FollowedSort; label: string }[] = [
  { key: 'name-asc', label: 'Name A–Z' },
  { key: 'name-desc', label: 'Name Z–A' },
  { key: 'scan-oldest', label: 'Checked longest ago' },
  { key: 'scan-newest', label: 'Checked most recently' },
  { key: 'added-newest', label: 'Followed most recently' },
];

export const FOLLOWED_LIST_TITLES = {
  labels: 'Labels you follow',
  podcasts: 'Podcasts you follow',
  audiobooks: 'Audiobook authors you follow',
} as const;

function toast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') {
  window.showToast?.(message, type);
}

/** The followed-artist check: running now, or when it runs next. */
function CheckLine({
  scan,
  scanning,
  nextRunSeconds,
  automation,
  paused,
  checkDisabled,
  now,
  onCheck,
  onStop,
  stopping,
  detailsOpen,
  onToggleDetails,
}: {
  scan: WatchlistScanFrame | undefined;
  scanning: boolean;
  nextRunSeconds: number;
  automation: ReturnType<typeof findSystemAutomation>;
  paused: boolean;
  checkDisabled: boolean;
  now: number;
  onCheck: () => void;
  onStop: () => void;
  stopping: boolean;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  if (scanning && scan) {
    const progress = scanProgressText(scan);
    const added = scan.tracks_added_this_scan ?? 0;
    return (
      <p className={styles.live} role="status">
        <StatusTag tone="info" live>
          Checking now
        </StatusTag>
        <span>
          {[progress, scan.current_artist_name].filter(Boolean).join(' · ') ||
            'Checking your followed artists for new releases.'}
          <span className={styles.liveDetail}>
            {' · '}
            {plural(added, 'track')} added to Wanted so far
          </span>
        </span>
        <button
          type="button"
          className={styles.linkButton}
          aria-expanded={detailsOpen}
          onClick={onToggleDetails}
        >
          {detailsOpen ? 'Hide details' : 'Show details'}
        </button>
        <button type="button" className={styles.linkButton} onClick={onStop} disabled={stopping}>
          {stopping ? 'Stopping after this artist…' : 'Stop checking'}
        </button>
      </p>
    );
  }
  const state = scheduleState({ nextRunSeconds, automation, paused });
  const finished = scan?.status === 'completed' || scan?.status === 'cancelled';
  const finishedMs = serverTime(scan?.completed_at ?? null);
  const summary = scan?.summary;
  const hasSummary = Boolean(summary && Object.keys(summary).length > 0);
  const found = summary
    ? `found ${plural(summary.new_tracks_found ?? 0, 'new track')} and added ${
        summary.tracks_added_to_wishlist ?? 0
      } to Wanted.`
    : '';
  const last = !hasSummary
    ? ''
    : finishedMs
      ? ` The last check, ${relativeAgo(finishedMs, now)}, ${found}`
      : finished
        ? ` The last check ${found}`
        : '';
  let long: string;
  let short: string;
  if (state.kind === 'paused') {
    long = "Automations are paused, so followed artists aren't checked for new releases.";
    short = 'Checks are paused ·';
  } else if (state.kind === 'off') {
    long = 'Followed artists aren’t checked for new releases on a schedule.';
    short = 'Scheduled checks are off ·';
  } else {
    long = `New releases are checked ${state.every || 'on a schedule'}${
      state.name ? ` (${state.name})` : ''
    }; the next check is ${state.when}.`;
    short = `Next check ${state.when} ·`;
  }
  return (
    <p className={styles.line}>
      <span className={styles.lineLong}>
        {long}
        {last}
      </span>
      <span className={styles.lineShort}>{short}</span>
      {finished && hasSummary ? (
        // the old Watchlist's result panel and its list of tracks, one click away
        <button
          type="button"
          className={styles.linkButton}
          aria-expanded={detailsOpen}
          onClick={onToggleDetails}
        >
          {detailsOpen ? 'Hide what it found' : 'What it found'}
        </button>
      ) : null}
      {checkDisabled ? (
        <span>Check now is free once similar artists finish updating.</span>
      ) : (
        <button type="button" className={styles.linkButton} onClick={onCheck}>
          Check now
        </button>
      )}
    </p>
  );
}

export function FollowedTab({
  profileId,
  search,
  wantedItems,
  tabs,
  selecting,
  onStopSelecting,
  findOpen,
  onCloseFind,
  go,
  scan,
  scanning,
  similarRunning,
  onFollowArtist,
}: {
  profileId: number;
  search: WantedSearch;
  wantedItems: WantedItem[];
  tabs: ReactNode;
  selecting: boolean;
  onStopSelecting: () => void;
  findOpen: boolean;
  onCloseFind: () => void;
  go: Go;
  scan: WatchlistScanFrame | undefined;
  scanning: boolean;
  /** "Update similar artists" shares the scan worker. */
  similarRunning: boolean;
  onFollowArtist: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const filter = resolveFollowedFilter(search.filter);
  const sort = resolveFollowedSort(search.sort);
  const pages = search.page ?? 1;
  const query = search.q ?? '';
  const now = useNow();

  const artists = useQuery(watchlistArtistsQueryOptions(profileId));
  const summary = useQuery(followedSummaryQueryOptions(profileId));
  const count = useQuery(watchlistCountQueryOptions(profileId));
  const automations = useQuery(automationsListQueryOptions(profileId));
  const master = useQuery(automationsMasterQueryOptions());
  const globalConfig = useQuery(watchlistGlobalConfigQueryOptions(profileId));
  const nextRun = useCountdownFrom(count.data?.nextRunInSeconds);

  const byArtist = useMemo(() => wantedByArtist(wantedItems), [wantedItems]);
  const allRows = useMemo(
    () => buildFollowedRows(artists.data ?? [], summary.data?.artists, byArtist, now),
    [artists.data, summary.data, byArtist, now],
  );
  const counts = followedCounts(allRows);
  const audiobookArtists = useRoutedArtists(allRows.map((row) => row.name));
  const rows = useMemo(
    () => sortFollowedRows(filterFollowedRows(allRows, filter, query), sort),
    [allRows, filter, query, sort],
  );
  const shown = rows.slice(0, pages * PAGE_SIZE);
  const overrideOn = Boolean(globalConfig.data?.global_override_enabled);

  // ── actions ────────────────────────────────────────────────────────────
  const [unfollow, setUnfollow] = useState<FollowedRow[] | null>(null);
  const [deckOpen, setDeckOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const lastPicked = useRef<string | null>(null);

  const startScan = useMutation({
    mutationFn: startWatchlistScan,
    onSuccess: () => toast('Checking your followed artists for new releases.', 'info'),
    onError: (error: Error) => toast(`The check didn't start: ${error.message}`, 'error'),
  });
  const stopScan = useMutation({
    mutationFn: cancelWatchlistScan,
    onSuccess: () => toast('The check stops after the artist it is on.', 'info'),
    onError: (error: Error) => toast(`Couldn't stop the check: ${error.message}`, 'error'),
  });

  const remove = useMutation({
    mutationFn: (ids: string[]) => removeWatchlistArtistsBatch(ids),
    onSuccess: async (_ignored, ids) => {
      toast(ids.length === 1 ? 'Unfollowed.' : `Unfollowed ${plural(ids.length, 'artist')}.`);
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: WATCHLIST_QUERY_KEY });
      try {
        window.updateWatchlistButtonCount?.();
      } catch {
        /* the nav badge is the shell's */
      }
    },
    onError: (error: Error) => toast(`Couldn't unfollow: ${error.message}`, 'error'),
  });

  /**
   * The artist's page: their library record when they're in the library,
   * else the metadata source they're matched on. Says so, and answers false,
   * when neither can be opened.
   */
  const openArtist = async (
    row: FollowedRow,
    options: { replace?: boolean; quiet?: boolean } = {},
  ): Promise<boolean> => {
    try {
      const library = await findLibraryArtist(row.name);
      if (library) {
        void navigate({
          to: '/artist-detail/$source/$id',
          params: { source: 'library', id: library.id },
          search: { name: library.name },
          replace: options.replace,
        });
        return true;
      }
    } catch {
      /* the library didn't answer; try the provider match next */
    }
    if (row.id) {
      try {
        const config = await queryClient.fetchQuery(
          watchlistArtistConfigQueryOptions(profileId, row.id),
        );
        const pick = pickDiscographySource(config);
        if (pick) {
          void navigate({
            to: '/artist-detail/$source/$id',
            params: { source: pick.source, id: pick.id },
            search: { name: row.name },
            replace: options.replace,
          });
          return true;
        }
      } catch {
        /* fall through to the explanation */
      }
    }
    if (!options.quiet) {
      toast(
        `Couldn't open ${row.name}: it's only matched on sources that are switched off. Open its settings to match it again.`,
        'warning',
      );
    }
    return false;
  };

  const handlers: FollowedRowHandlers = {
    onOpenArtist: (row) => void openArtist(row),
    onSettings: (row) => row.id && go({ configId: row.id }),
    onUnfollow: (row) => setUnfollow([row]),
  };

  /**
   * An old "About this artist" link (/watchlist?detailId=…) opens the Artist
   * page, which holds everything that panel showed. The panel stays only for
   * an artist whose page can't be opened (matched on switched-off sources),
   * since it explains that and links to the settings.
   */
  const [panelFallback, setPanelFallback] = useState<string | null>(null);
  const handingOff = useRef<string | null>(null);
  useEffect(() => {
    const detailId = search.detailId;
    if (!detailId || search.list || !artists.isSuccess) return;
    if (handingOff.current === detailId) return;
    handingOff.current = detailId;
    const row = allRows.find((r) => r.id === detailId);
    if (!row) {
      go({ detailId: undefined }, { replace: true });
      return;
    }
    void openArtist(row, { replace: true, quiet: true }).then((opened) => {
      if (!opened) setPanelFallback(detailId);
    });
    // allRows changes as the summary loads; the hand-off runs once per id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.detailId, search.list, artists.isSuccess]);

  // ── selection ──────────────────────────────────────────────────────────
  const shownIds = shown.map((row) => row.id).filter((id): id is string => Boolean(id));
  const shownKey = shownIds.join('\u0000');
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const keep = new Set(shownKey.split('\u0000'));
      const next = new Set([...prev].filter((id) => keep.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [shownKey]);
  useEffect(() => {
    if (!selecting) setSelected(new Set());
  }, [selecting]);
  const toggle = (id: string, range: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const from = lastPicked.current ? shownIds.indexOf(lastPicked.current) : -1;
      const to = shownIds.indexOf(id);
      if (range && from !== -1 && to !== -1) {
        const [a, b] = from < to ? [from, to] : [to, from];
        for (let i = a; i <= b; i++) next.add(shownIds[i]);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastPicked.current = id;
  };

  // ── modals the old Watchlist opened from the URL ───────────────────────
  const detailRow =
    search.detailId && !search.list ? allRows.find((row) => row.id === search.detailId) : undefined;
  const modals = (
    <>
      {/* opened from a link, the modal waits for the stored settings: drawn
          from defaults first, they could be edited or saved over */}
      {search.settings && !globalConfig.isPending ? (
        <WatchlistGlobalSettingsModal
          profileId={profileId}
          initialConfig={globalConfig.data ?? null}
          onClose={() => go({ settings: undefined })}
        />
      ) : null}
      {search.configId ? (
        <WatchlistArtistConfigModal
          profileId={profileId}
          artistId={search.configId}
          globalOverrideActive={overrideOn}
          onClose={() => go({ configId: undefined })}
        />
      ) : null}
      {search.detailId && panelFallback === search.detailId ? (
        <WatchlistArtistDetail
          profileId={profileId}
          artistId={search.detailId}
          backLabel="Back to Followed artists"
          onClose={() => go({ detailId: undefined })}
          onOpenSettings={() => go({ detailId: undefined, configId: search.detailId })}
          onUnfollow={
            detailRow
              ? () => {
                  go({ detailId: undefined });
                  setUnfollow([detailRow]);
                }
              : undefined
          }
        />
      ) : null}
    </>
  );

  const toolbar = (controls: ReactNode) => (
    <div className={styles.toolbar}>
      {tabs}
      {controls}
    </div>
  );

  if (search.list) {
    return (
      <>
        {toolbar(null)}
        <SubHead
          backLabel="Followed artists"
          onBack={() => go({ list: undefined })}
          title={FOLLOWED_LIST_TITLES[search.list]}
        />
        <div className={styles.legacyView}>
          <FollowedListView list={search.list} profileId={profileId} query={query} />
        </div>
        {modals}
      </>
    );
  }

  if (artists.isPending) {
    return (
      <>
        {toolbar(null)}
        <LoadingState label="Loading the artists you follow…">
          <SkeletonList rows={5} roundArt />
        </LoadingState>
        {modals}
      </>
    );
  }

  if (artists.isError) {
    return (
      <>
        {toolbar(null)}
        <ListFailure
          title="Couldn't load the artists you follow"
          safeLine="Who you follow is safe."
          error={artists.error}
          onRetry={() => void artists.refetch()}
          roundArt
        />
        {modals}
      </>
    );
  }

  if (allRows.length === 0) {
    return (
      <>
        {toolbar(null)}
        <EmptyState
          variant="panel"
          title="You're not following anyone yet"
          description="Follow an artist and each new release is added to Wanted as it comes out, then searched for like anything else on the list. Following is the only thing here that keeps adding to Wanted by itself."
          hint="You can follow from Search or from an artist page."
          actions={
            <Button size="lg" variant="primary" onClick={onFollowArtist}>
              Search for an artist
            </Button>
          }
        />
        {modals}
      </>
    );
  }

  const filterOptions: FilterOption<FollowedFilter>[] = [
    { key: 'all', label: 'All' },
    { key: 'new', label: 'New release', count: summary.isSuccess ? counts.new : undefined },
  ];
  if (counts.unchecked > 0 || filter === 'unchecked')
    filterOptions.push({ key: 'unchecked', label: 'Not checked yet', count: counts.unchecked });
  if (counts.stale > 0 || filter === 'stale')
    filterOptions.push({ key: 'stale', label: 'Checked 30+ days ago', count: counts.stale });
  if (counts.ownSettings > 0 || filter === 'own-settings')
    filterOptions.push({ key: 'own-settings', label: 'Own settings', count: counts.ownSettings });

  const emptyFilterText =
    query && filter === 'all'
      ? `You don't follow anyone called “${query}”.`
      : filter === 'new'
        ? 'No followed artist had a new release in the last 7 days.'
        : 'Nobody here right now.';

  return (
    <>
      {toolbar(
        <div className={styles.controls}>
          <FilterButtons
            options={filterOptions}
            value={filter}
            onChange={(next) => go({ filter: next === 'all' ? undefined : next, page: undefined })}
          />
          <SortSelect
            options={FOLLOWED_SORT_OPTIONS}
            value={sort}
            onChange={(next) =>
              go({ sort: next === 'name-asc' ? undefined : next, page: undefined })
            }
          />
        </div>,
      )}

      <CheckLine
        scan={scan}
        scanning={scanning}
        nextRunSeconds={nextRun}
        automation={findSystemAutomation(automations.data, 'scan_watchlist')}
        paused={master.data?.music === false}
        checkDisabled={similarRunning || startScan.isPending}
        now={now}
        onCheck={() => startScan.mutate()}
        onStop={() => stopScan.mutate()}
        stopping={stopScan.isPending || Boolean(scan?.cancel_requested)}
        detailsOpen={deckOpen}
        onToggleDetails={() => setDeckOpen((open) => !open)}
      />

      {/* The old Watchlist's live scan deck (artist, album, recent finds) and
          its result panel, kept one click away rather than drawn by default. */}
      {scan &&
      deckOpen &&
      (scanning || scan.status === 'completed' || scan.status === 'cancelled') ? (
        <div className={styles.legacyView}>
          <WatchlistScanDeck frame={scan} />
        </div>
      ) : null}

      {overrideOn ? (
        <Notice
          tone="warning"
          title="Global override is on"
          actions={
            <Button size="lg" onClick={() => go({ settings: true })}>
              Followed artist settings
            </Button>
          }
        >
          Each artist&apos;s own release settings are ignored when checking for new releases; the
          global ones apply to everyone.
        </Notice>
      ) : null}

      {findOpen || query ? (
        <div className={styles.find} role="search">
          <TextInput
            aria-label="Find in this list"
            placeholder="Find an artist"
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
          <Button
            size="lg"
            disabled={selected.size === 0}
            onClick={() => setUnfollow(allRows.filter((row) => row.id && selected.has(row.id)))}
          >
            Unfollow…
          </Button>
          <Button size="lg" variant="ghost" onClick={() => setSelected(new Set(shownIds))}>
            Select all {shownIds.length} shown
          </Button>
          <Button size="lg" variant="ghost" onClick={onStopSelecting}>
            Done
          </Button>
        </div>
      ) : null}

      <ul className={styles.list} aria-label="Followed artists">
        {shown.length === 0 ? (
          <li>
            <p className={styles.listEmpty}>{emptyFilterText}</p>
          </li>
        ) : (
          shown.map((row) => (
            <FollowedRowView
              key={row.artist.id}
              row={row}
              now={now}
              audiobook={audiobookArtists.has(row.name)}
              selecting={selecting}
              selected={Boolean(row.id && selected.has(row.id))}
              onToggleSelect={(range) => row.id && toggle(row.id, range)}
              handlers={handlers}
            />
          ))
        )}
      </ul>
      <ListFooter
        shown={shown.length}
        total={rows.length}
        onMore={() => go({ page: pages + 1 }, { replace: true })}
      />

      <ConfirmDialog
        open={unfollow !== null}
        title={
          unfollow && unfollow.length === 1
            ? `Unfollow ${unfollow[0].name}?`
            : `Unfollow ${plural(unfollow?.length ?? 0, 'artist')}?`
        }
        confirmLabel={
          unfollow && unfollow.length === 1
            ? 'Unfollow'
            : `Unfollow ${plural(unfollow?.length ?? 0, 'artist')}`
        }
        cancelLabel="Keep following"
        busy={remove.isPending}
        onCancel={() => setUnfollow(null)}
        onConfirm={() => {
          const ids = (unfollow ?? []).map((row) => row.id).filter((id): id is string => !!id);
          setUnfollow(null);
          onStopSelecting();
          if (ids.length) remove.mutate(ids);
        }}
      >
        {(() => {
          const list = unfollow ?? [];
          const onWanted = list.reduce((n, row) => n + row.onWanted, 0);
          const who = list.length === 1 ? list[0].name : 'them';
          return (
            <>
              <p className={styles.dialogText}>
                SoulSync stops checking {who} for new releases.{' '}
                {onWanted > 0
                  ? `The ${plural(onWanted, 'thing')} already on Wanted stay${onWanted === 1 ? 's' : ''} there and keep${onWanted === 1 ? 's' : ''} being searched for.`
                  : 'Anything of theirs already on Wanted stays there.'}
              </p>
              <p className={styles.dialogNote}>Nothing in your library changes.</p>
            </>
          );
        })()}
      </ConfirmDialog>

      {modals}
    </>
  );
}
