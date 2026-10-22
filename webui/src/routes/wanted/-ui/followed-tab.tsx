import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button, TextInput } from '@/components/form';
import { EmptyState, LoadingState, Notice, SkeletonList, StatusTag } from '@/components/primitives';
import { useRoutedArtists } from '@/features/audiobook-routes/audiobook-routes.queries';
import { useShellBridge } from '@/platform/shell/route-controllers';

import type { AudiobookFollowedAuthor } from '../../audiobooks/-audiobooks.types';
import type { Automation } from '../../automations/-automations.types';
import type { WatchlistScanFrame } from '../../watchlist/-watchlist.scan';
import type { WatchlistLabel, WatchlistPodcast } from '../../watchlist/-watchlist.types';
import type { Go } from './wanted-tab';

import {
  audiobookWantedQueryOptions,
  findLibraryArtist,
  followedAuthorsQueryOptions,
  followedSummaryQueryOptions,
  podcastSummaryQueryOptions,
  scanPodcastsNow,
} from '../-wanted.api';
import {
  artistRow,
  audiobookRole,
  authorRow,
  filterFollowing,
  kindCounts,
  labelRow,
  ofKind,
  podcastRow,
  sortFollowing,
  statusCounts,
  wantedByLabel,
  type FollowingContext,
  type FollowingRow,
  type FollowKind,
} from '../-wanted.following';
import {
  aboutIn,
  buildFollowedRows,
  findSystemAutomation,
  intervalText,
  plural,
  relativeAgo,
  scheduleState,
  serverTime,
  wantedByArtist,
} from '../-wanted.helpers';
import { useCountdownFrom, useNow } from '../-wanted.hooks';
import {
  PAGE_SIZE,
  resolveFollowedFilter,
  resolveFollowedSort,
  resolveFollowKind,
  type FollowedFilter,
  type FollowedSort,
  type FollowKindFilter,
  type WantedItem,
  type WantedSearch,
} from '../-wanted.types';
import { runAuthorScan, unfollowAuthor } from '../../audiobooks/-audiobooks.api';
import {
  automationsListQueryOptions,
  automationsMasterQueryOptions,
} from '../../automations/-automations.api';
import { AudiobookAuthorSettingsModal } from '../../watchlist/-ui/audiobook-author-settings-modal';
import { PodcastSettingsModal } from '../../watchlist/-ui/podcast-settings-modal';
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
  removeWatchlistLabel,
  removeWatchlistPodcast,
  setWatchlistLabelBacklog,
  startWatchlistScan,
  updateWatchlistPodcastSettings,
  WATCHLIST_QUERY_KEY,
  watchlistArtistConfigQueryOptions,
  watchlistArtistsQueryOptions,
  watchlistCountQueryOptions,
  watchlistGlobalConfigQueryOptions,
  watchlistLabelsQueryOptions,
  watchlistPodcastsQueryOptions,
} from '../../watchlist/-watchlist.api';
import { scanProgressText } from '../../watchlist/-watchlist.scan';
import { type MenuEntry } from './action-menu';
import { ConfirmDialog } from './confirm-dialog';
import { FilterButtons, ListFailure, ListFooter, SortSelect, type FilterOption } from './parts';
import { FollowingRowView } from './rows';
import styles from './wanted-page.module.css';

export const FOLLOWED_SORT_OPTIONS: { key: FollowedSort; label: string }[] = [
  { key: 'activity', label: 'Newest activity first' },
  { key: 'name-asc', label: 'Name A–Z' },
  { key: 'name-desc', label: 'Name Z–A' },
  { key: 'scan-oldest', label: 'Checked longest ago' },
  { key: 'scan-newest', label: 'Checked most recently' },
  { key: 'added-newest', label: 'Followed most recently' },
];

/** Which kinds this profile can follow: podcasts and audiobooks are modules. */
export interface FollowKindsAllowed {
  podcasts: boolean;
  authors: boolean;
}

const KIND_NOUN: Record<FollowKind, [string, string]> = {
  artist: ['artist', 'artists'],
  label: ['label', 'labels'],
  podcast: ['podcast', 'podcasts'],
  author: ['author', 'authors'],
};

function toast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') {
  window.showToast?.(message, type);
}

/** "in about 40 minutes": when a system automation runs next, '' when it won't. */
function nextRunText(list: unknown, actionType: string, now: number): string {
  if (!Array.isArray(list)) return '';
  const automation = (list as Automation[]).find(
    (row) => Boolean(row?.is_system) && row?.action_type === actionType,
  );
  if (!automation || !automation.enabled) return '';
  const at = serverTime(automation.next_run ?? null);
  return at > now ? aboutIn((at - now) / 1000) : '';
}

/** "Unfollow Pale Harbour?", "Unfollow 3 artists?", "Unfollow these 5?" */
function unfollowWords(rows: FollowingRow[]): { title: string; confirm: string } {
  if (rows.length === 1) return { title: `Unfollow ${rows[0].name}?`, confirm: 'Unfollow' };
  const kinds = new Set(rows.map((row) => row.kind));
  if (kinds.size === 1) {
    const [one, many] = KIND_NOUN[rows[0].kind];
    const words = plural(rows.length, one, many);
    return { title: `Unfollow ${words}?`, confirm: `Unfollow ${words}` };
  }
  return { title: `Unfollow these ${rows.length}?`, confirm: `Unfollow ${rows.length}` };
}

/** What stops, and what stays, when these are unfollowed. */
function unfollowText(rows: FollowingRow[]): string {
  if (rows.length === 1) {
    const row = rows[0];
    if (row.kind === 'podcast') {
      return `SYNCHRO.S stops checking ${row.name} for new episodes. Episodes you’ve downloaded stay.`;
    }
    const what = row.kind === 'author' ? 'new books' : 'new releases';
    const stays =
      row.onWanted > 0
        ? `The ${plural(row.onWanted, 'thing')} already on Wanted stay${row.onWanted === 1 ? 's' : ''} there and keep${row.onWanted === 1 ? 's' : ''} being searched for.`
        : 'Anything of theirs already on Wanted stays there.';
    return `SYNCHRO.S stops checking ${row.name} for ${what}. ${stays}`;
  }
  const onWanted = rows.reduce((n, row) => n + row.onWanted, 0);
  return `SYNCHRO.S stops checking them for anything new. ${
    onWanted > 0
      ? `The ${plural(onWanted, 'thing')} already on Wanted stay${onWanted === 1 ? 's' : ''} there and keep${onWanted === 1 ? 's' : ''} being searched for.`
      : 'Anything of theirs already on Wanted stays there.'
  }${rows.some((row) => row.kind === 'podcast') ? ' Downloaded episodes stay.' : ''}`;
}

/** Each kind's check, running now or when it runs next (the line over the list). */
function CheckLine({
  kind,
  allowed,
  scan,
  scanning,
  nextRunSeconds,
  automations,
  paused,
  checkDisabled,
  now,
  onCheck,
  onStop,
  stopping,
  detailsOpen,
  onToggleDetails,
  otherCheck,
}: {
  kind: FollowKindFilter;
  allowed: FollowKindsAllowed;
  scan: WatchlistScanFrame | undefined;
  scanning: boolean;
  nextRunSeconds: number;
  automations: unknown;
  paused: boolean;
  checkDisabled: boolean;
  now: number;
  onCheck: () => void;
  onStop: () => void;
  stopping: boolean;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /** A podcast or author check started here, still running. */
  otherCheck: string;
}) {
  const artistsAndLabels = kind === 'all' || kind === 'artists' || kind === 'labels';
  if (scanning && scan && artistsAndLabels) {
    const progress = scanProgressText(scan);
    const added = scan.tracks_added_this_scan ?? 0;
    return (
      <p className={styles.live} role="status">
        <span>
          {[progress, scan.current_artist_name].filter(Boolean).join(' · ') ||
            'Checking your followed artists and labels for new releases.'}
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
  if (otherCheck) {
    return (
      <p className={styles.live} role="status">
        {otherCheck}
      </p>
    );
  }

  const sentences: string[] = [];
  let short = '';
  if (artistsAndLabels) {
    const state = scheduleState({
      nextRunSeconds,
      automation: findSystemAutomation(automations, 'scan_watchlist'),
      paused,
    });
    const who =
      kind === 'artists' ? 'Artists' : kind === 'labels' ? 'Labels' : 'Artists and labels';
    if (state.kind === 'paused') {
      sentences.push(
        `Automations are paused, so ${who.toLowerCase()} aren't checked for new releases.`,
      );
      short = 'Checks are paused ·';
    } else if (state.kind === 'off') {
      sentences.push(`${who} aren’t checked for new releases on a schedule.`);
      short = 'Scheduled checks are off ·';
    } else {
      sentences.push(
        `${who} are checked ${state.every || 'on a schedule'}${
          state.name ? ` (${state.name})` : ''
        } and new releases go to Wanted; the next check is ${state.when}.`,
      );
      short = `Next check ${state.when} ·`;
    }
    const summary = scan?.summary;
    const finished = scan?.status === 'completed' || scan?.status === 'cancelled';
    if (finished && summary && Object.keys(summary).length > 0) {
      const finishedMs = serverTime(scan?.completed_at ?? null);
      sentences.push(
        `The last check${finishedMs ? `, ${relativeAgo(finishedMs, now)},` : ''} found ${plural(
          summary.new_tracks_found ?? 0,
          'new track',
        )} and added ${summary.tracks_added_to_wishlist ?? 0} to Wanted.`,
      );
    }
  }
  const cadence = (actionType: string) => {
    const automation = findSystemAutomation(automations, actionType);
    if (paused || !automation || !automation.enabled) return '';
    return intervalText(automation.trigger_config ?? null) || 'on a schedule';
  };
  const extra: string[] = [];
  if ((kind === 'all' || kind === 'podcasts') && allowed.podcasts) {
    const every = cadence('scan_watchlist_podcasts');
    extra.push(every ? `podcasts are checked ${every}` : 'podcasts aren’t checked on a schedule');
  }
  if ((kind === 'all' || kind === 'authors') && allowed.authors) {
    const every = cadence('audiobook_scan_watchlist');
    extra.push(
      every
        ? `audiobook authors ${kind === 'authors' ? 'are checked ' : ''}${every}`
        : 'audiobook authors aren’t checked on a schedule',
    );
  }
  if (extra.length) {
    const joined = extra.join('; ');
    sentences.push(`${joined[0].toUpperCase()}${joined.slice(1)}.`);
    if (!short) short = `${extra[0][0].toUpperCase()}${extra[0].slice(1)} ·`;
  }
  const finished = scan?.status === 'completed' || scan?.status === 'cancelled';
  const hasSummary = Boolean(scan?.summary && Object.keys(scan.summary).length > 0);
  const checkLabel =
    kind === 'podcasts'
      ? 'Check podcasts now'
      : kind === 'authors'
        ? 'Check authors now'
        : 'Check now';
  return (
    <p className={styles.line}>
      <span className={styles.lineLong}>{sentences.join(' ')}</span>
      <span className={styles.lineShort}>{short}</span>
      {artistsAndLabels && finished && hasSummary ? (
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
      {checkDisabled && artistsAndLabels ? (
        <span>Check now is free once similar artists finish updating.</span>
      ) : (
        <button type="button" className={styles.linkButton} onClick={onCheck}>
          {checkLabel}
        </button>
      )}
    </p>
  );
}

/** Where to follow more of a kind, for its empty list. */
function KindEmpty({
  kind,
  onFollowArtist,
}: {
  kind: FollowKindFilter;
  onFollowArtist: () => void;
}) {
  const navigate = useNavigate();
  const go = (to: '/search' | '/podcasts' | '/audiobooks') => void navigate({ to });
  const [text, action, onClick] =
    kind === 'labels'
      ? [
          'You don’t follow any labels yet. Search for one, open it, and choose Follow.',
          'Search for a label',
          () => go('/search'),
        ]
      : kind === 'podcasts'
        ? [
            'You don’t follow any podcasts yet. Find one on the Podcasts page and follow it.',
            'Find a podcast',
            () => go('/podcasts'),
          ]
        : kind === 'authors'
          ? [
              'You don’t follow any audiobook authors yet. Open an author from Audiobooks and follow them.',
              'Browse audiobooks',
              () => go('/audiobooks'),
            ]
          : ['You don’t follow any artists yet.', 'Search for an artist', onFollowArtist];
  return (
    <div className={styles.listEmpty}>
      <p className={styles.dialogText}>{text}</p>
      <Button size="lg" onClick={onClick}>
        {action}
      </Button>
    </div>
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
  allowed,
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
  allowed: FollowKindsAllowed;
}) {
  const navigate = useNavigate();
  const bridge = useShellBridge();
  const queryClient = useQueryClient();
  const filter = resolveFollowedFilter(search.filter);
  const sort = resolveFollowedSort(search.sort);
  const requestedKind = resolveFollowKind(search);
  const kind: FollowKindFilter =
    (requestedKind === 'podcasts' && !allowed.podcasts) ||
    (requestedKind === 'authors' && !allowed.authors)
      ? 'all'
      : requestedKind;
  const pages = search.page ?? 1;
  const query = search.q ?? '';
  const now = useNow();

  // an old ?list= link (the Watchlist's tabs) is the Kind row now
  useEffect(() => {
    if (!search.list) return;
    go({ list: undefined, kind: requestedKind }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.list]);

  const artists = useQuery(watchlistArtistsQueryOptions(profileId));
  const summary = useQuery(followedSummaryQueryOptions(profileId));
  const count = useQuery(watchlistCountQueryOptions(profileId));
  const automations = useQuery(automationsListQueryOptions(profileId));
  const master = useQuery(automationsMasterQueryOptions());
  const globalConfig = useQuery(watchlistGlobalConfigQueryOptions(profileId));
  const labels = useQuery(watchlistLabelsQueryOptions(profileId));
  const podcasts = useQuery({
    ...watchlistPodcastsQueryOptions(profileId),
    enabled: allowed.podcasts,
  });
  const podcastSummary = useQuery({
    ...podcastSummaryQueryOptions(profileId),
    enabled: allowed.podcasts,
  });
  const authors = useQuery({ ...followedAuthorsQueryOptions(profileId), enabled: allowed.authors });
  const books = useQuery({ ...audiobookWantedQueryOptions(profileId), enabled: allowed.authors });
  const nextRun = useCountdownFrom(count.data?.nextRunInSeconds);

  const byArtist = useMemo(() => wantedByArtist(wantedItems), [wantedItems]);
  const fromLabels = useMemo(() => wantedByLabel(wantedItems), [wantedItems]);
  const artistRows = useMemo(
    () => buildFollowedRows(artists.data ?? [], summary.data?.artists, byArtist, now),
    [artists.data, summary.data, byArtist, now],
  );
  const audiobookArtists = useRoutedArtists(artistRows.map((row) => row.name));
  const audiobookKey = [...audiobookArtists].sort().join('\u0000');

  const scheduleNext = scheduleState({
    nextRunSeconds: nextRun,
    automation: findSystemAutomation(automations.data, 'scan_watchlist'),
    paused: master.data?.music === false,
  });
  const ctx: FollowingContext = {
    now,
    nextArtistCheck: scheduleNext.kind === 'next' ? scheduleNext.when : '',
    nextPodcastCheck: nextRunText(automations.data, 'scan_watchlist_podcasts', now),
    nextAuthorCheck: nextRunText(automations.data, 'audiobook_scan_watchlist', now),
    checkingArtist:
      scanning && scan?.current_artist_name ? scan.current_artist_name.trim().toLowerCase() : '',
  };
  const ctxKey = `${ctx.nextArtistCheck}|${ctx.nextPodcastCheck}|${ctx.nextAuthorCheck}|${ctx.checkingArtist}`;

  const allRows = useMemo(() => {
    const out: FollowingRow[] = artistRows.map((row) =>
      artistRow(row, ctx, audiobookArtists.has(row.name)),
    );
    for (const label of labels.data ?? []) out.push(labelRow(label, fromLabels, ctx));
    if (allowed.podcasts) {
      const byFeed = new Map((podcastSummary.data ?? []).map((entry) => [entry.feed_url, entry]));
      for (const podcast of podcasts.data ?? []) {
        out.push(podcastRow(podcast, byFeed.get(podcast.feed_url), ctx));
      }
    }
    if (allowed.authors) {
      for (const author of authors.data ?? []) out.push(authorRow(author, books.data ?? [], ctx));
    }
    return out;
    // ctx is rebuilt each render; its contents are what matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    artistRows,
    audiobookKey,
    labels.data,
    fromLabels,
    podcasts.data,
    podcastSummary.data,
    authors.data,
    books.data,
    allowed.podcasts,
    allowed.authors,
    ctxKey,
    now,
  ]);

  const kinds = kindCounts(allRows);
  const inKind = useMemo(() => ofKind(allRows, kind), [allRows, kind]);
  const counts = statusCounts(inKind);
  const rows = useMemo(
    () => sortFollowing(filterFollowing(inKind, filter, query), sort),
    [inKind, filter, query, sort],
  );
  const shown = rows.slice(0, pages * PAGE_SIZE);
  const overrideOn = Boolean(globalConfig.data?.global_override_enabled);

  // ── actions ────────────────────────────────────────────────────────────
  const [unfollow, setUnfollow] = useState<FollowingRow[] | null>(null);
  const [deckOpen, setDeckOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [podcastSettings, setPodcastSettings] = useState<WatchlistPodcast | null>(null);
  const [authorSettings, setAuthorSettings] = useState<AudiobookFollowedAuthor | null>(null);
  const lastPicked = useRef<string | null>(null);

  const refreshFollowing = async () => {
    await queryClient.invalidateQueries({ queryKey: WATCHLIST_QUERY_KEY });
    try {
      window.updateWatchlistButtonCount?.();
    } catch {
      /* the nav badge is the shell's */
    }
  };

  const startScan = useMutation({
    mutationFn: startWatchlistScan,
    onSuccess: () => toast('Checking your followed artists and labels for new releases.', 'info'),
    onError: (error: Error) => toast(`The check didn't start: ${error.message}`, 'error'),
  });
  const stopScan = useMutation({
    mutationFn: cancelWatchlistScan,
    onSuccess: () => toast('The check stops after the artist it is on.', 'info'),
    onError: (error: Error) => toast(`Couldn't stop the check: ${error.message}`, 'error'),
  });
  const podcastScan = useMutation({
    mutationFn: scanPodcastsNow,
    onSuccess: (result) => {
      const queued = result.episodes_queued ?? 0;
      const failed = result.errors?.length ?? 0;
      toast(
        `Checked ${plural(result.podcasts_checked ?? 0, 'podcast')}: ${
          queued > 0 ? `${plural(queued, 'new episode')} downloading` : 'nothing new'
        }${failed ? `, ${failed} couldn't be read` : ''}.`,
        failed ? 'warning' : 'success',
      );
      void refreshFollowing();
    },
    onError: (error: Error) => toast(`The podcast check didn't run: ${error.message}`, 'error'),
  });
  const authorScan = useMutation({
    mutationFn: runAuthorScan,
    onSuccess: (result) => {
      if (!result) {
        toast("The audiobook author check didn't run. Try again later.", 'error');
        return;
      }
      const found = result.wishlisted ?? 0;
      toast(
        found > 0
          ? `Added ${plural(found, 'new book')} to Wanted.`
          : 'No new books since the last check.',
      );
      void refreshFollowing();
      void queryClient.invalidateQueries({
        queryKey: audiobookWantedQueryOptions(profileId).queryKey,
      });
    },
  });
  const otherCheck = podcastScan.isPending
    ? 'Checking each followed podcast’s feed…'
    : authorScan.isPending
      ? 'Checking your followed audiobook authors…'
      : '';
  const checking = scanning || Boolean(otherCheck);

  const remove = useMutation({
    mutationFn: async (list: FollowingRow[]) => {
      const failures: string[] = [];
      const artistIds = list.map((row) => row.artist?.id).filter((id): id is string => Boolean(id));
      const jobs: Promise<unknown>[] = [];
      if (artistIds.length) jobs.push(removeWatchlistArtistsBatch(artistIds));
      for (const row of list) {
        if (row.label) jobs.push(removeWatchlistLabel(row.label.musicbrainz_label_id));
        if (row.podcast)
          jobs.push(removeWatchlistPodcast(row.podcast.feed_url, row.podcast.itunes_id));
        if (row.author) {
          const author = row.author;
          jobs.push(
            unfollowAuthor(author.name, audiobookRole(author)).then((ok) => {
              if (!ok) throw new Error(`${author.name} is still followed`);
            }),
          );
        }
      }
      for (const result of await Promise.allSettled(jobs)) {
        if (result.status === 'rejected') failures.push((result.reason as Error)?.message ?? '');
      }
      return { total: list.length, failures };
    },
    onSuccess: async ({ total, failures }) => {
      setSelected(new Set());
      if (failures.length) {
        toast(
          `Couldn't unfollow everything: ${failures.filter(Boolean)[0] ?? 'try again'}.`,
          'error',
        );
      } else {
        toast(total === 1 ? 'Unfollowed.' : `Unfollowed ${total}.`);
      }
      await refreshFollowing();
    },
  });

  const labelBacklog = useMutation({
    mutationFn: (label: WatchlistLabel) =>
      setWatchlistLabelBacklog(label.musicbrainz_label_id, !label.backlog),
    onSuccess: (_ignored, label) => {
      toast(
        label.backlog
          ? `${label.label_name}: only new releases from now on.`
          : `${label.label_name}: the whole catalogue goes to Wanted from the next check.`,
      );
      void refreshFollowing();
    },
    onError: (error: Error) => toast(`Couldn't change that: ${error.message}`, 'error'),
  });

  const podcastDownloads = useMutation({
    mutationFn: (podcast: WatchlistPodcast) =>
      updateWatchlistPodcastSettings(podcast.feed_url, podcast.itunes_id, {
        auto_download: !podcast.auto_download,
        retention_days: podcast.retention_days,
      }),
    onSuccess: (_ignored, podcast) => {
      toast(
        podcast.auto_download
          ? `New episodes of ${podcast.title} won’t download.`
          : `New episodes of ${podcast.title} download from the next check.`,
      );
      void refreshFollowing();
    },
    onError: (error: Error) => toast(`Couldn't change that: ${error.message}`, 'error'),
  });

  /**
   * The artist's page: their library record when they're in the library,
   * else the metadata source they're matched on. Says so, and answers false,
   * when neither can be opened.
   */
  const openArtist = async (
    row: { id: string | null; name: string },
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

  const open = (row: FollowingRow) => {
    if (row.artist) {
      void openArtist(row.artist);
      return;
    }
    if (row.label) {
      bridge?.navigateToLabelDetail(row.label.musicbrainz_label_id, row.label.label_name);
      return;
    }
    if (row.podcast) {
      const podcastId = row.podcast.itunes_id
        ? String(row.podcast.itunes_id)
        : encodeURIComponent(row.podcast.feed_url);
      void navigate({ to: '/podcasts/$podcastId', params: { podcastId } });
      return;
    }
    if (row.author) {
      const role = audiobookRole(row.author);
      const name = row.author.name;
      if (role === 'series')
        void navigate({ to: '/audiobooks', search: { q: name, type: 'title' } });
      else if (role === 'narrator')
        void navigate({ to: '/audiobooks/narrator/$name', params: { name } });
      else void navigate({ to: '/audiobooks/author/$name', params: { name } });
    }
  };

  const menu = (row: FollowingRow, withOpen: boolean): MenuEntry[] => {
    const list: MenuEntry[] = [];
    if (withOpen) list.push({ key: 'open', label: row.openLabel, onSelect: () => open(row) });
    if (row.artist?.id) {
      const id = row.artist.id;
      list.push({
        key: 'settings',
        label: 'Settings for this artist…',
        onSelect: () => go({ configId: id }),
      });
    }
    if (row.label) {
      const label = row.label;
      list.push({
        key: 'backlog',
        label: label.backlog ? 'Only new releases from now on' : 'Also get the whole catalogue',
        disabled: labelBacklog.isPending,
        onSelect: () => labelBacklog.mutate(label),
      });
    }
    if (row.podcast) {
      const podcast = row.podcast;
      list.push(
        {
          key: 'downloads',
          label: podcast.auto_download ? 'Stop downloading new episodes' : 'Download new episodes',
          disabled: podcastDownloads.isPending,
          onSelect: () => podcastDownloads.mutate(podcast),
        },
        {
          key: 'keep',
          label: 'Keep and download settings…',
          onSelect: () => setPodcastSettings(podcast),
        },
      );
    }
    if (row.author) {
      const author = row.author;
      list.push({
        key: 'settings',
        label: `Settings for this ${row.kindLabel.toLowerCase()}…`,
        onSelect: () => setAuthorSettings(author),
      });
    }
    list.push(
      { key: 'sep', separator: true },
      { key: 'unfollow', label: 'Unfollow…', tone: 'danger', onSelect: () => setUnfollow([row]) },
    );
    return list;
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
    if (!detailId || !artists.isSuccess) return;
    if (handingOff.current === detailId) return;
    handingOff.current = detailId;
    const row = artistRows.find((r) => r.id === detailId);
    if (!row) {
      go({ detailId: undefined }, { replace: true });
      return;
    }
    void openArtist(row, { replace: true, quiet: true }).then((opened) => {
      if (!opened) setPanelFallback(detailId);
    });
    // artistRows changes as the summary loads; the hand-off runs once per id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.detailId, artists.isSuccess]);

  // ── selection ──────────────────────────────────────────────────────────
  const shownKeys = shown.map((row) => row.key);
  const shownKey = shownKeys.join('\u0000');
  useEffect(() => {
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
      const from = lastPicked.current ? shownKeys.indexOf(lastPicked.current) : -1;
      const to = shownKeys.indexOf(key);
      if (range && from !== -1 && to !== -1) {
        const [a, b] = from < to ? [from, to] : [to, from];
        for (let i = a; i <= b; i++) next.add(shownKeys[i]);
      } else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    lastPicked.current = key;
  };

  // ── modals the old Watchlist opened from the URL, and the row menus' ──
  const detailRow = search.detailId
    ? artistRows.find((row) => row.id === search.detailId)
    : undefined;
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
          backLabel="Back to Following"
          onClose={() => go({ detailId: undefined })}
          onOpenSettings={() => go({ detailId: undefined, configId: search.detailId })}
          onUnfollow={
            detailRow
              ? () => {
                  go({ detailId: undefined });
                  setUnfollow(allRows.filter((row) => row.artist === detailRow));
                }
              : undefined
          }
        />
      ) : null}
      {podcastSettings ? (
        <PodcastSettingsModal
          podcast={podcastSettings}
          profileId={profileId}
          isOpen
          onClose={() => {
            setPodcastSettings(null);
            void refreshFollowing();
          }}
        />
      ) : null}
      {authorSettings ? (
        <AudiobookAuthorSettingsModal
          author={authorSettings}
          isOpen
          onClose={() => setAuthorSettings(null)}
          onSaved={() => void refreshFollowing()}
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

  if (artists.isPending) {
    return (
      <>
        {toolbar(null)}
        <LoadingState label="Loading who you follow…">
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
          title="Couldn't load who you follow"
          safeLine="Who you follow is safe."
          error={artists.error}
          onRetry={() => void artists.refetch()}
          roundArt
        />
        {modals}
      </>
    );
  }

  const stillLoading =
    labels.isPending ||
    (allowed.podcasts && podcasts.isPending) ||
    (allowed.authors && authors.isPending);
  if (allRows.length === 0 && !stillLoading) {
    return (
      <>
        {toolbar(null)}
        <EmptyState
          variant="panel"
          title="You're not following anyone yet"
          description="Follow an artist or a label and each new release is added to Wanted as it comes out, then searched for like anything else on the list. Podcasts and audiobook authors can be followed too. Following is the only thing here that keeps adding to Wanted by itself."
          hint="You can follow from Search, from an artist or label page, or from Podcasts and Audiobooks."
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

  const known = (ready: boolean, n: number) => (ready ? n : undefined);
  const filterOptions: FilterOption<FollowedFilter>[] = [
    { key: 'all', label: 'All' },
    { key: 'new', label: 'New release', count: summary.isSuccess ? counts.new : undefined },
    { key: 'unchecked', label: 'Not checked yet', count: counts.unchecked },
    { key: 'quiet', label: 'Nothing new' },
  ];
  if (kind === 'artists' && (counts.stale > 0 || filter === 'stale'))
    filterOptions.push({ key: 'stale', label: 'Checked 30+ days ago', count: counts.stale });
  if (kind === 'artists' && (counts.ownSettings > 0 || filter === 'own-settings'))
    filterOptions.push({ key: 'own-settings', label: 'Own settings', count: counts.ownSettings });

  const kindOptions: FilterOption<FollowKindFilter>[] = [
    { key: 'all', label: 'All', count: stillLoading ? undefined : kinds.all },
    { key: 'artists', label: 'Artists', count: kinds.artists },
    { key: 'labels', label: 'Labels', count: known(labels.isSuccess, kinds.labels) },
  ];
  if (allowed.podcasts)
    kindOptions.push({
      key: 'podcasts',
      label: 'Podcasts',
      count: known(podcasts.isSuccess, kinds.podcasts),
    });
  if (allowed.authors)
    kindOptions.push({
      key: 'authors',
      label: 'Authors',
      count: known(authors.isSuccess, kinds.authors),
    });

  const emptyFilterText =
    query && filter === 'all'
      ? `You don't follow anything called “${query}”.`
      : filter === 'new'
        ? 'Nothing here had a new release in the last 7 days.'
        : filter === 'unchecked'
          ? 'Everything here has been checked at least once.'
          : filter === 'quiet'
            ? 'Everything here has something new, or hasn’t been checked yet.'
            : 'Nobody here right now.';

  const onCheck = () => {
    if (kind === 'podcasts') podcastScan.mutate();
    else if (kind === 'authors') authorScan.mutate();
    else startScan.mutate();
  };

  return (
    <>
      {toolbar(
        <div className={styles.controls}>
          <FilterButtons
            options={filterOptions}
            value={filter}
            onChange={(next) => go({ filter: next === 'all' ? undefined : next, page: undefined })}
          />
          {checking ? (
            <StatusTag tone="info" live className={styles.checkingTag}>
              Checking…
            </StatusTag>
          ) : null}
        </div>,
      )}

      <div className={styles.kindRow}>
        <span className={styles.kindLabel} aria-hidden="true">
          Kind
        </span>
        <FilterButtons
          label="Kind"
          options={kindOptions}
          value={kind}
          onChange={(next) =>
            go({
              kind: next === 'all' ? undefined : next,
              // the artist-only filters don't carry over to another kind
              filter:
                next !== 'artists' && (filter === 'stale' || filter === 'own-settings')
                  ? undefined
                  : search.filter,
              page: undefined,
            })
          }
        />
        <SortSelect
          options={FOLLOWED_SORT_OPTIONS}
          value={sort}
          onChange={(next) => go({ sort: next === 'activity' ? undefined : next, page: undefined })}
        />
      </div>

      <CheckLine
        kind={kind}
        allowed={allowed}
        scan={scan}
        scanning={scanning}
        nextRunSeconds={nextRun}
        automations={automations.data}
        paused={master.data?.music === false}
        checkDisabled={similarRunning || startScan.isPending}
        now={now}
        onCheck={onCheck}
        onStop={() => stopScan.mutate()}
        stopping={stopScan.isPending || Boolean(scan?.cancel_requested)}
        detailsOpen={deckOpen}
        onToggleDetails={() => setDeckOpen((isOpen) => !isOpen)}
        otherCheck={otherCheck}
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

      {overrideOn && (kind === 'all' || kind === 'artists') ? (
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

      {allowed.podcasts &&
      (podcasts.isError || podcastSummary.isError) &&
      (kind === 'all' || kind === 'podcasts') ? (
        <Notice
          tone="warning"
          title={
            podcasts.isError
              ? "Couldn't load the podcasts you follow"
              : "Couldn't read what came in for your podcasts"
          }
          actions={
            <Button
              size="lg"
              onClick={() => {
                void podcasts.refetch();
                void podcastSummary.refetch();
              }}
            >
              Try again
            </Button>
          }
        >
          {podcasts.isError
            ? 'They aren’t in this list until they load. Who you follow is safe.'
            : 'Their latest episodes aren’t shown until it loads. Nothing changed.'}
        </Notice>
      ) : null}

      {findOpen || query ? (
        <div className={styles.find} role="search">
          <TextInput
            aria-label="Find in this list"
            placeholder="Find an artist, label, podcast or author"
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
            onClick={() => setUnfollow(allRows.filter((row) => selected.has(row.key)))}
          >
            Unfollow…
          </Button>
          <Button size="lg" variant="ghost" onClick={() => setSelected(new Set(shownKeys))}>
            Select all {shownKeys.length} shown
          </Button>
          <Button size="lg" variant="ghost" onClick={onStopSelecting}>
            Done
          </Button>
        </div>
      ) : null}

      <ul className={styles.list} aria-label="Following">
        {inKind.length === 0 && !query && filter === 'all' && kind !== 'all' ? (
          <li>
            <KindEmpty kind={kind} onFollowArtist={onFollowArtist} />
          </li>
        ) : shown.length === 0 ? (
          <li>
            <p className={styles.listEmpty}>{emptyFilterText}</p>
          </li>
        ) : (
          shown.map((row) => (
            <FollowingRowView
              key={row.key}
              row={row}
              selecting={selecting}
              selected={selected.has(row.key)}
              onToggleSelect={(range) => toggle(row.key, range)}
              onOpen={open}
              menu={menu}
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
        title={unfollowWords(unfollow ?? []).title}
        confirmLabel={unfollowWords(unfollow ?? []).confirm}
        cancelLabel="Keep following"
        busy={remove.isPending}
        onCancel={() => setUnfollow(null)}
        onConfirm={() => {
          const list = unfollow ?? [];
          setUnfollow(null);
          onStopSelecting();
          if (list.length) remove.mutate(list);
        }}
      >
        <p className={styles.dialogText}>{unfollowText(unfollow ?? [])}</p>
        <p className={styles.dialogNote}>Nothing in your library changes.</p>
      </ConfirmDialog>

      {modals}
    </>
  );
}
