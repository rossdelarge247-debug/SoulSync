import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/form';
import { useModuleOff } from '@/features/modules/module-gate';
import { profileAsksFirst } from '@/platform/shell/download-rights';
import { useProfile } from '@/platform/shell/route-controllers';

import type { Go } from './wanted-tab';

import { useFollowedScan, useWantedData, useWantedPageShell } from '../-wanted.hooks';
import { resolveTab, type WantedSearch, type WantedTab } from '../-wanted.types';
import {
  similarArtistsStatusQueryOptions,
  startSimilarArtistsUpdate,
  watchlistArtistsQueryOptions,
  watchlistCountQueryOptions,
} from '../../watchlist/-watchlist.api';
import { Route } from '../route';
import { ActionMenu, type MenuEntry } from './action-menu';
import { FollowArtistDialog } from './follow-artist-dialog';
import { FollowedTab } from './followed-tab';
import { CountBadge } from './parts';
import { RetryTimingDialog } from './retry-timing-dialog';
import styles from './wanted-page.module.css';
import { WantedTab as WantedPanel } from './wanted-tab';

/** Search params without the empty ones, so a default never sits in the URL. */
function tidy(search: WantedSearch): WantedSearch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined && value !== '' && value !== null) out[key] = value;
  }
  return out as WantedSearch;
}

function TabBar({
  tab,
  showWanted,
  showFollowed,
  wantedCount,
  followedCount,
}: {
  tab: WantedTab;
  showWanted: boolean;
  showFollowed: boolean;
  wantedCount: number | undefined | 'loading';
  followedCount: number | undefined | 'loading';
}) {
  const navigate = useNavigate();
  const wantedId = useId();
  const followedId = useId();
  const tabs: {
    key: WantedTab;
    id: string;
    long: string;
    short: string;
    count: typeof wantedCount;
  }[] = [];
  if (showWanted)
    tabs.push({ key: 'wanted', id: wantedId, long: 'Wanted', short: 'Wanted', count: wantedCount });
  if (showFollowed)
    tabs.push({
      key: 'followed',
      id: followedId,
      long: 'Followed artists',
      short: 'Followed',
      count: followedCount,
    });

  // Arrow keys move between the tabs, as a tablist does.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const at = tabs.findIndex((t) => t.key === tab);
    const next = tabs[(at + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    if (!next || next.key === tab) return;
    event.preventDefault();
    void navigate({ to: '/wanted', search: { tab: next.key } });
    requestAnimationFrame(() => document.getElementById(next.id)?.focus());
  };

  return (
    <div
      className={styles.tabs}
      role="tablist"
      aria-label="Wanted"
      onKeyDown={onKeyDown}
      data-tour="wanted-tabs"
    >
      {tabs.map((t) => (
        <Link
          key={t.key}
          id={t.id}
          to="/wanted"
          search={{ tab: t.key }}
          role="tab"
          aria-selected={tab === t.key}
          tabIndex={tab === t.key ? 0 : -1}
          className={styles.tab}
        >
          <span className={styles.tabLong}>{t.long}</span>
          <span className={styles.tabShort}>{t.short}</span>
          {t.count === 'loading' ? (
            <CountBadge loading />
          ) : t.count !== undefined ? (
            <CountBadge count={t.count} />
          ) : null}
        </Link>
      ))}
    </div>
  );
}

export function WantedPage() {
  const search = Route.useSearch();
  const tab = resolveTab(search);
  const navigate = useNavigate({ from: Route.fullPath });
  const bridge = useWantedPageShell(tab);
  const { profileId } = useProfile();
  const showWanted = bridge.isPageAllowed('wishlist');
  const showFollowed = bridge.isPageAllowed('watchlist');
  const audiobooksOff = useModuleOff('audiobooks');
  const podcastsOff = useModuleOff('podcasts');
  const audiobooksAllowed = bridge.isPageAllowed('audiobooks') && audiobooksOff === null;
  const podcastsAllowed = podcastsOff === null;

  const data = useWantedData(profileId);
  const followedCountQuery = useQuery(watchlistCountQueryOptions(profileId));
  const followedArtists = useQuery({
    ...watchlistArtistsQueryOptions(profileId),
    enabled: tab === 'followed',
  });
  const { scan, scanning } = useFollowedScan(profileId);

  const [selecting, setSelecting] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [dialog, setDialog] = useState<'follow' | 'retry' | null>(null);
  useEffect(() => {
    setSelecting(false);
    setFindOpen(false);
  }, [tab]);

  const go: Go = (patch, options) =>
    void navigate({
      search: (prev: WantedSearch) => tidy({ ...prev, ...patch }),
      replace: options?.replace,
    });

  // Update similar artists: started here, polled until it says done. It
  // shares the scan worker, so the two never run together.
  const [similarRunning, setSimilarRunning] = useState(false);
  const similar = useQuery(similarArtistsStatusQueryOptions(profileId, similarRunning));
  useEffect(() => {
    if (!similarRunning) return;
    const status = similar.data?.status;
    if (status === 'completed') {
      setSimilarRunning(false);
      window.showToast?.(
        `Updated similar artists for ${similar.data?.artists_processed || 0} followed artists.`,
        'success',
      );
    } else if (status === 'error') {
      setSimilarRunning(false);
      window.showToast?.("Similar artists didn't update. Try again later.", 'error');
    }
  }, [similarRunning, similar.data?.status, similar.data?.artists_processed]);
  const startSimilar = useMutation({
    mutationFn: startSimilarArtistsUpdate,
    onSuccess: () => {
      setSimilarRunning(true);
      window.showToast?.('Updating similar artists in the background.', 'info');
    },
    onError: (error: Error) => window.showToast?.(`Couldn't start it: ${error.message}`, 'error'),
  });

  const followedNames = useMemo(
    () => new Set((followedArtists.data ?? []).map((a) => a.artist_name.trim().toLowerCase())),
    [followedArtists.data],
  );

  const wantedCount = data.isPending ? 'loading' : data.isError ? undefined : data.items.length;
  const followedCount = followedCountQuery.isPending
    ? 'loading'
    : followedCountQuery.isError
      ? undefined
      : followedCountQuery.data?.count;
  // the counts aren't shown at all while a list failed to load (board 2s)
  const listFailed = tab === 'wanted' ? data.isError : followedArtists.isError;

  const tabs = (
    <TabBar
      tab={tab}
      showWanted={showWanted}
      showFollowed={showFollowed}
      wantedCount={listFailed ? undefined : wantedCount}
      followedCount={listFailed ? undefined : followedCount}
    />
  );

  const mainView = tab === 'wanted' ? !search.media : !search.list;
  const canSearch = !profileAsksFirst();

  const wantedMenu: MenuEntry[] = [
    ...(mainView
      ? ([
          { key: 'find', label: 'Find in this list', onSelect: () => setFindOpen(true) },
          ...(search.view === 'nebula'
            ? []
            : [
                {
                  key: 'select',
                  label: selecting ? 'Stop selecting' : 'Select several',
                  onSelect: () => setSelecting((on) => !on),
                },
              ]),
          {
            key: 'view',
            label: search.view === 'nebula' ? 'Show as a list' : 'Show as a nebula',
            onSelect: () => go({ view: search.view === 'nebula' ? undefined : 'nebula' }),
          },
        ] satisfies MenuEntry[])
      : [{ key: 'music', label: 'Music on Wanted', onSelect: () => go({ media: undefined }) }]),
    { key: 'retry', label: 'How often to try again…', onSelect: () => setDialog('retry') },
    { key: 'sep1', separator: true },
    ...(canSearch
      ? [
          {
            key: 'download',
            label: 'Download everything now…',
            onSelect: () => void window._nebulaDownload?.(),
          },
        ]
      : []),
    {
      key: 'ignored',
      label: 'Removed and skipped tracks…',
      onSelect: () => window.openWishlistIgnoreModal?.(),
    },
    {
      key: 'cleanup',
      label: 'Remove what’s already in your library…',
      onSelect: () => window.cleanupWishlistOverview?.(),
    },
    ...(audiobooksAllowed && mainView
      ? [
          {
            key: 'audiobooks',
            label: 'Audiobooks on Wanted',
            onSelect: () => go({ media: 'audiobooks' }),
          },
        ]
      : []),
    { key: 'sep2', separator: true },
    {
      key: 'clear',
      label: 'Clear Wanted…',
      tone: 'danger',
      onSelect: () => window.clearEntireWishlist?.(),
    },
  ];

  const followedMenu: MenuEntry[] = [
    ...(mainView
      ? ([
          { key: 'find', label: 'Find in this list', onSelect: () => setFindOpen(true) },
          {
            key: 'select',
            label: selecting ? 'Stop selecting' : 'Select several',
            onSelect: () => setSelecting((on) => !on),
          },
        ] satisfies MenuEntry[])
      : [{ key: 'artists', label: 'Followed artists', onSelect: () => go({ list: undefined }) }]),
    { key: 'settings', label: 'Followed artist settings…', onSelect: () => go({ settings: true }) },
    {
      key: 'similar',
      label: similarRunning ? 'Updating similar artists…' : 'Update similar artists',
      disabled: similarRunning || scanning || startSimilar.isPending,
      onSelect: () => startSimilar.mutate(),
    },
    { key: 'sep1', separator: true },
    {
      key: 'history',
      label: 'Check history…',
      onSelect: () => window.openWatchlistHistoryModal?.(),
    },
    {
      key: 'origins',
      label: 'Downloads from followed artists…',
      onSelect: () => window.openDownloadOriginsModal?.('watchlist'),
    },
    {
      key: 'blocklist',
      label: 'Blocklist…',
      onSelect: () => window.openBlocklistModal?.('artist'),
    },
    { key: 'sep2', separator: true },
    { key: 'also', group: 'Also followed' },
    { key: 'labels', label: 'Labels you follow', onSelect: () => go({ list: 'labels' }) },
    ...(podcastsAllowed
      ? [
          {
            key: 'podcasts',
            label: 'Podcasts you follow',
            onSelect: () => go({ list: 'podcasts' }),
          },
        ]
      : []),
    ...(audiobooksAllowed
      ? [
          {
            key: 'authors',
            label: 'Audiobook authors you follow',
            onSelect: () => go({ list: 'audiobooks' }),
          },
        ]
      : []),
  ];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Wanted</h1>
          <p className={styles.subtitle}>
            What you want, and who you follow.
            <span className={styles.subtitleMore}> SoulSync searches for both on a schedule.</span>
          </p>
        </div>
        <div className={styles.headActions}>
          {tab === 'wanted' ? (
            <Button
              size="lg"
              variant="primary"
              className={styles.primary}
              onClick={() => void navigate({ to: '/search' })}
            >
              Add to Wanted
            </Button>
          ) : (
            <Button
              size="lg"
              variant="primary"
              className={styles.primary}
              onClick={() => setDialog('follow')}
            >
              Follow an artist
            </Button>
          )}
          <ActionMenu
            label={tab === 'wanted' ? 'More for Wanted' : 'More for Followed artists'}
            entries={tab === 'wanted' ? wantedMenu : followedMenu}
          />
        </div>
      </header>

      {tab === 'wanted' ? (
        <WantedPanel
          profileId={profileId}
          search={search}
          data={data}
          tabs={tabs}
          selecting={selecting}
          onStopSelecting={() => setSelecting(false)}
          findOpen={findOpen}
          onCloseFind={() => setFindOpen(false)}
          go={go}
        />
      ) : (
        <FollowedTab
          profileId={profileId}
          search={search}
          wantedItems={data.items}
          tabs={tabs}
          selecting={selecting}
          onStopSelecting={() => setSelecting(false)}
          findOpen={findOpen}
          onCloseFind={() => setFindOpen(false)}
          go={go}
          scan={scan}
          scanning={scanning}
          similarRunning={similarRunning}
          onFollowArtist={() => setDialog('follow')}
        />
      )}

      <FollowArtistDialog
        open={dialog === 'follow'}
        profileId={profileId}
        followedNames={followedNames}
        onClose={() => setDialog(null)}
      />
      <RetryTimingDialog
        open={dialog === 'retry'}
        profileId={profileId}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}
