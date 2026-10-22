import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';

import { Button, OptionButton } from '@/components/form';
import { EmptyState, LoadingState, Notice, Skeleton, StatusTag } from '@/components/primitives';
import {
  routedNamesQueryOptions,
  useAudiobookFolderConfigured,
  useSetAudiobookRoute,
} from '@/features/audiobook-routes/audiobook-routes.queries';
import { useModuleOff } from '@/features/modules/module-gate';
import { profileAsksFirst } from '@/platform/shell/download-rights';
import { useProfile, useReactPageShell } from '@/platform/shell/route-controllers';

import type { ArtistInfo, ArtistTab, Discography, ReleaseFilter } from '../-artist-detail.types';
import type { ArtistRelease, CardState, QualityAlbum } from '../-artist.helpers';
import type { WishlistApiTrack } from '../../wanted/-wanted.helpers';

import { Route } from '../$source/$id';
import {
  artistDetailQueryOptions,
  isSourceOnlyArtist,
  needsCompletionStream,
  readArtistDetail,
  settleOwnershipForSourceArtist,
  watchlistIdentity,
} from '../-artist-detail.api';
import { showsDbRecordButton } from '../-artist-detail.db-record';
import { deleteArtistRequest, deleteArtistToast } from '../-artist-detail.delete-artist';
import { peekArtistEdit } from '../-artist-detail.edit-focus';
import {
  applyMusicBrainzDeclutter,
  defaultFilterState,
  type DiscographyFilterState,
} from '../-artist-detail.filters';
import { mergeGapReleases } from '../-artist-detail.gap-fill';
import {
  heroImage,
  type HeroImage,
  type HeroImageStage,
  heroImageSrc,
  nextHeroImageStage,
  resolvedCategoryStats,
} from '../-artist-detail.hero-stats';
import { showsFixMatchButton } from '../-artist-detail.matches';
import { syncResultMessage } from '../-artist-detail.meta';
import { scrollArtistDetailToTop } from '../-artist-detail.scroll';
import { useCompletionStream } from '../-artist-detail.use-completion';
import { useGapFill } from '../-artist-detail.use-gap-fill';
import { clearVanillaArtist, syncVanillaArtist } from '../-artist-detail.vanilla-state';
import {
  artistQualityQueryOptions,
  similarArtistsQueryOptions,
  syncArtistFromServer,
} from '../-artist.api';
import {
  artistWantedTracks,
  buildReleases,
  canAddToWanted,
  cardState,
  countsLine,
  filterReleases,
  findFollowedRow,
  followingText,
  headerCounts,
  latestRelease,
  latestText,
  orderReleases,
  plural,
  shownReleases,
  sourceLinks,
  wantedByRelease,
  wantedThingCount,
} from '../-artist.helpers';
import { useAddToWanted, useFollow, usePhone } from '../-artist.hooks';
import { useReleaseActions } from '../-artist.release-actions';
import { whyItFailed } from '../../wanted/-wanted.helpers';
import { WatchlistArtistConfigModal } from '../../watchlist/-ui/watchlist-artist-config-modal';
import {
  watchlistArtistConfigQueryOptions,
  watchlistArtistsQueryOptions,
  watchlistGlobalConfigQueryOptions,
} from '../../watchlist/-watchlist.api';
import { primaryArtistId } from '../../watchlist/-watchlist.helpers';
import { wishlistTracksQueryOptions } from '../../wishlist/-wishlist.api';
import { AppearsOnSection } from './appears-on-section';
import { ArtPicker } from './art-picker';
import { ArtistRecordModal } from './artist-db-record';
import { AboutDialog, ConfirmDialog, MoreFiltersDialog } from './artist-dialogs';
import { ArtistMatchesModal } from './artist-matches-modal';
import { ArtistMenu, type MenuEntry } from './artist-menu';
import styles from './artist-page.module.css';
import { ArtistReleaseCard } from './artist-release-card';
import { ArtistVideosSection } from './artist-videos-section';
import { ConcertsSection } from './concerts-section';
import { DiscographyModal } from './discography-modal';
import { BodyPortal } from './portal';
import { SimilarTab } from './similar-tab';
import { topTracksQueryOptions, TracksTab } from './tracks-tab';

type Dialog =
  | 'unfollow'
  | 'add-all'
  | 'about'
  | 'filters'
  | 'remove'
  | 'choose'
  | 'photo'
  | 'matches'
  | 'record'
  | 'follow-settings'
  | null;

/** The 13px count on a tab; shimmers while it isn't known yet. */
function CountBadge({ count }: { count: number | 'loading' | undefined }) {
  if (count === 'loading') return <Skeleton className={styles.badgeLoading} />;
  if (count === undefined) return null;
  return <span className={styles.badge}>{count.toLocaleString()}</span>;
}

function CheckIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/**
 * The artist's photo with the old hero's fallbacks: their own image, then
 * Deezer's, then the first release cover, then the plain placeholder.
 */
function HeaderArt({
  artist,
  image,
  applied,
}: {
  artist: ArtistInfo;
  image: HeroImage | null;
  applied: string | null;
}) {
  const [stage, setStage] = useState<HeroImageStage>('primary');
  const primary = applied || image?.primary || '';
  useEffect(() => setStage(primary ? 'primary' : 'fallback'), [primary]);
  if (!image || stage === 'fallback' || !primary) {
    return <span className={styles.art} aria-hidden="true" />;
  }
  const src = stage === 'primary' ? primary : heroImageSrc(stage, artist, image);
  return (
    <img
      key={stage}
      className={styles.art}
      src={src}
      alt=""
      onError={() => setStage((s) => (applied ? 'fallback' : nextHeroImageStage(s, artist, image)))}
    />
  );
}

/** Card-shaped placeholders, in the grid's real shape (faded behind a failure). */
function CardSkeletons({ count, faded = false }: { count: number; faded?: boolean }) {
  return (
    <div className={styles.skeletonGrid} data-faded={faded ? 'true' : undefined} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className={styles.skeletonCard} key={i}>
          <Skeleton className={styles.skeletonArt} />
          <Skeleton className={styles.skeletonLine} style={{ width: '70%' }} />
          <Skeleton className={styles.skeletonLine} style={{ width: '50%' }} />
          <Skeleton className={styles.skeletonTag} />
        </div>
      ))}
    </div>
  );
}

/** Followers, popularity, style, mood and label from the followed-artist check. */
function followedFacts(
  artist:
    | {
        followers?: number | null;
        popularity?: number | null;
        style?: string | null;
        mood?: string | null;
        label?: string | null;
      }
    | null
    | undefined,
): { label: string; value: string }[] {
  if (!artist) return [];
  const facts: { label: string; value: string }[] = [];
  if (artist.followers)
    facts.push({ label: 'Followers', value: artist.followers.toLocaleString() });
  if (artist.popularity) facts.push({ label: 'Popularity', value: `${artist.popularity} of 100` });
  if (artist.style) facts.push({ label: 'Style', value: artist.style });
  if (artist.mood) facts.push({ label: 'Mood', value: artist.mood });
  if (artist.label) facts.push({ label: 'Label', value: artist.label });
  return facts;
}

/** Search params without the defaults, so a default never sits in the URL. */
function tidy<T extends Record<string, unknown>>(search: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === '' || value === null || value === false) continue;
    if (key === 'tab' && value === 'releases') continue;
    if (key === 'show' && value === 'all') continue;
    out[key] = value;
  }
  return out as T;
}

function rowsOf(payload: unknown): WishlistApiTrack[] {
  const tracks = (payload as { tracks?: unknown } | undefined)?.tracks;
  return Array.isArray(tracks) ? (tracks as WishlistApiTrack[]) : [];
}

const TAB_LABELS: Record<ArtistTab, { long: string; short: string }> = {
  releases: { long: 'Releases', short: 'Releases' },
  tracks: { long: 'Tracks', short: 'Tracks' },
  similar: { long: 'Similar artists', short: 'Similar' },
};

function TabBar({
  base,
  tab,
  counts,
  onSelect,
}: {
  /** Ids are `${base}-tab-<tab>`; the panel is `${base}-panel`. */
  base: string;
  tab: ArtistTab;
  counts: Record<ArtistTab, number | 'loading' | undefined>;
  onSelect: (next: ArtistTab) => void;
}) {
  const order: ArtistTab[] = ['releases', 'tracks', 'similar'];
  // arrow keys move between the tabs, as a tablist does
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const at = order.indexOf(tab);
    const next = order[(at + (event.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
    event.preventDefault();
    onSelect(next);
    requestAnimationFrame(() => document.getElementById(`${base}-tab-${next}`)?.focus());
  };
  return (
    <div
      className={styles.tabs}
      role="tablist"
      aria-label="Artist"
      onKeyDown={onKeyDown}
      data-tour="artist-tabs"
    >
      {order.map((key) => (
        <button
          key={key}
          id={`${base}-tab-${key}`}
          type="button"
          role="tab"
          aria-selected={tab === key}
          aria-controls={`${base}-panel`}
          tabIndex={tab === key ? 0 : -1}
          className={styles.tab}
          onClick={() => onSelect(key)}
        >
          <span className={styles.tabLong}>{TAB_LABELS[key].long}</span>
          <span className={styles.tabShort}>{TAB_LABELS[key].short}</span>
          <CountBadge count={counts[key]} />
        </button>
      ))}
    </div>
  );
}

const FILTERS: { key: ReleaseFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'albums', label: 'Albums' },
  { key: 'missing', label: 'Missing' },
];

export function ArtistPage() {
  useReactPageShell('artist-detail');
  const { source, id } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const profile = useProfile();
  const profileId = profile?.profileId ?? 0;
  const isAdmin = Boolean(profile?.isAdmin);
  const phone = usePhone();
  const tab: ArtistTab = search.tab ?? 'releases';
  const filter: ReleaseFilter = search.show ?? 'all';
  const asksFirst = profileAsksFirst();
  const tabBase = useId();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [appliedPhoto, setAppliedPhoto] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const go = (patch: Record<string, unknown>, options?: { replace?: boolean }) =>
    void navigate({
      search: (prev: Record<string, unknown>) => tidy({ ...prev, ...patch }) as never,
      replace: options?.replace,
      resetScroll: false,
    });

  // ── the artist ─────────────────────────────────────────────────────────
  const query = useQuery(artistDetailQueryOptions(source, id, search.name));
  const payload = useMemo(() => {
    try {
      return readArtistDetail(query.data);
    } catch {
      return null;
    }
  }, [query.data]);
  const failed = query.isError || query.data?.success === false;
  const sourceOnly = payload ? isSourceOnlyArtist(payload) : false;
  const artist = useMemo(() => payload?.artist ?? {}, [payload]);
  const artistName = String(artist.name || search.name || '');
  const libraryArtistId = payload && !sourceOnly && artist.id != null ? String(artist.id) : null;

  const discography: Discography = useMemo(() => {
    if (!payload?.discography) return {};
    return sourceOnly ? settleOwnershipForSourceArtist(payload.discography) : payload.discography;
  }, [payload, sourceOnly]);
  const stream = useCompletionStream(
    payload?.artist?.name,
    discography,
    payload ? needsCompletionStream(payload) : false,
  );
  const gapFill = useGapFill(
    payload?.artist?.id,
    payload?.artist?.name,
    discography.source ?? undefined,
    stream.discography,
  );
  const displayed = useMemo(
    () => mergeGapReleases(stream.discography, gapFill.releases),
    [stream.discography, gapFill.releases],
  );

  // the old filter bar's options, reset for each artist (MusicBrainz starts decluttered)
  const [options, setOptions] = useState<DiscographyFilterState>(defaultFilterState);
  useEffect(() => {
    setOptions(applyMusicBrainzDeclutter(defaultFilterState(), discography.source));
  }, [source, id, discography.source]);

  const releases = useMemo(() => orderReleases(buildReleases(displayed)), [displayed]);
  const shown = useMemo(() => shownReleases(releases, options), [releases, options]);

  // ── Wanted, quality, following ─────────────────────────────────────────
  const wishAlbums = useQuery(wishlistTracksQueryOptions(profileId, 'albums'));
  const wishSingles = useQuery(wishlistTracksQueryOptions(profileId, 'singles'));
  const wantedTracks = useMemo(
    () => artistWantedTracks([...rowsOf(wishAlbums.data), ...rowsOf(wishSingles.data)], artistName),
    [wishAlbums.data, wishSingles.data, artistName],
  );
  const wanted = useMemo(() => wantedByRelease(releases, wantedTracks), [releases, wantedTracks]);

  const quality = useQuery(artistQualityQueryOptions(libraryArtistId));
  const qualityMap = useMemo(() => {
    const albums = quality.data?.albums ?? [];
    return new Map<string, QualityAlbum>(albums.map((a) => [String(a.id), a]));
  }, [quality.data]);

  const adder = useAddToWanted({
    id: artist.id != null ? String(artist.id) : null,
    name: artistName,
    source: displayed.source ?? null,
  });

  const states = useMemo(() => {
    const map = new Map<string, CardState>();
    for (const release of releases) {
      map.set(
        release.key,
        cardState(release, wanted.get(release.key), qualityMap, adder.pending.has(release.key)),
      );
    }
    return map;
  }, [releases, wanted, qualityMap, adder.pending]);
  const stateOf = (release: ArtistRelease): CardState =>
    states.get(release.key) ?? { kind: 'checking' };

  const identity = payload ? watchlistIdentity(payload, source) : null;
  const followedRows = useQuery(watchlistArtistsQueryOptions(profileId));
  const followedRow = findFollowedRow(
    followedRows.data,
    artist,
    identity ? String(identity.id) : null,
  );
  const follow = useFollow(
    profileId,
    identity ? { id: String(identity.id), name: identity.name, source: identity.source } : null,
    followedRow ? primaryArtistId(followedRow) : null,
  );
  const globalConfig = useQuery({
    ...watchlistGlobalConfigQueryOptions(profileId),
    enabled: follow.following,
  });

  // what the followed-artist check knows about them, for About (read when it opens)
  const followedConfig = useQuery({
    ...watchlistArtistConfigQueryOptions(
      profileId,
      followedRow ? (primaryArtistId(followedRow) ?? '') : '',
    ),
    enabled: dialog === 'about' && Boolean(followedRow && primaryArtistId(followedRow)),
  });

  const similar = useQuery(similarArtistsQueryOptions(payload?.artist?.name ? artistName : ''));
  const topTracks = useQuery(
    topTracksQueryOptions(payload?.artist?.id, payload?.artist?.name ? artistName : ''),
  );

  // ── the shell ──────────────────────────────────────────────────────────
  useEffect(() => {
    scrollArtistDetailToTop();
  }, [source, id]);

  /**
   * An issue's "edit details" asks for this artist's album or track in the
   * library's tag tools: open them (admins; they're the ones fixing issues).
   */
  useEffect(() => {
    if (!isAdmin || !peekArtistEdit(id)) return;
    if (tab === 'tracks' && search.manage) return;
    go({ tab: 'tracks', manage: true }, { replace: true });
    // once per artist
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isAdmin]);

  useEffect(() => {
    if (!payload) return;
    document.body.dataset.artistSource = sourceOnly ? 'source' : 'library';
    return () => {
      delete document.body.dataset.artistSource;
    };
  }, [payload, sourceOnly]);

  /**
   * Artist Radio, the art picker, the Download Discography chooser and the top
   * bar's page name read the artist from the classic scripts' page state. The
   * id is the one the payload returned (a source click on an owned artist
   * comes back as the library row).
   */
  useEffect(() => {
    if (!payload) return;
    syncVanillaArtist({
      id: payload.artist?.id ?? null,
      name: payload.artist?.name ?? null,
      source: payload.discography?.source ?? payload.artist?.source ?? null,
    });
    window._updateSidebarLibraryBreadcrumb?.();
    return () => {
      clearVanillaArtist();
      window._updateSidebarLibraryBreadcrumb?.();
    };
  }, [payload]);

  useEffect(() => {
    setDialog(null);
    setAppliedPhoto(null);
  }, [source, id]);

  const image = heroImage(artist, displayed);
  const photo = appliedPhoto || image.primary;
  const releaseActions = useReleaseActions(payload, photo);

  // ── audiobook routing (the old "Treat as audiobook" toggle) ────────────
  const audiobooksOff = useModuleOff('audiobooks');
  const routed = useQuery(routedNamesQueryOptions(payload?.artist?.name ? [artistName] : []));
  const isRouted = (routed.data ?? []).includes(artistName);
  const folderSet = useAudiobookFolderConfigured();
  const setRoute = useSetAudiobookRoute(artistName);

  // ── derived ────────────────────────────────────────────────────────────
  const libraryTracks = sourceOnly
    ? null
    : (quality.data?.tracks ??
      (Number(payload?.enrichment_coverage?.total_tracks) || (payload ? 0 : null)));
  const counts = headerCounts(shown, states, libraryTracks);
  const filtered = filterReleases(shown, filter, stateOf);
  const pageSize = phone ? 4 : 8;
  const visible = search.all ? filtered : filtered.slice(0, pageSize);
  const missing = shown.filter((r) => canAddToWanted(stateOf(r)) && !adder.pending.has(r.key));
  const stillChecking =
    !sourceOnly && shown.some((r) => r.owned === null) && !stream.ended && !stream.completed;
  const latest = latestRelease(shown);
  const links = sourceLinks(artist);
  const wantedCount = wantedThingCount(wantedTracks);
  const followingSince = followingText(followedRow);
  const followId = followedRow ? primaryArtistId(followedRow) : null;

  const tabCounts: Record<ArtistTab, number | 'loading' | undefined> = {
    releases: !payload ? (failed ? undefined : 'loading') : shown.length,
    tracks: !payload
      ? failed
        ? undefined
        : 'loading'
      : sourceOnly
        ? topTracks.isPending
          ? 'loading'
          : topTracks.data?.tracks.length || undefined
        : (libraryTracks ?? undefined),
    similar: !payload
      ? failed
        ? undefined
        : 'loading'
      : similar.isPending
        ? 'loading'
        : similar.isError
          ? undefined
          : (similar.data?.similar_artists?.length ?? 0),
  };

  // ── actions ────────────────────────────────────────────────────────────
  const toggleFollow = () => {
    if (follow.busy) return;
    if (follow.following) setDialog('unfollow');
    else follow.follow();
  };

  const removeArtist = async () => {
    if (!libraryArtistId || removing) return;
    setRemoving(true);
    try {
      const result = await deleteArtistRequest(libraryArtistId);
      window.showToast?.(deleteArtistToast(artistName, result), 'success');
      window.updateWatchlistCount?.();
      setDialog(null);
      void navigate({ to: '/library' });
    } catch (error) {
      window.showToast?.(`Couldn't remove ${artistName}: ${(error as Error).message}`, 'error');
      setRemoving(false);
    }
  };

  const syncFromServer = async () => {
    if (!libraryArtistId || syncing) return;
    setSyncing(true);
    try {
      const result = await syncArtistFromServer(libraryArtistId);
      const { message, tone, changed } = syncResultMessage(result);
      window.showToast?.(message, tone);
      if (changed) void query.refetch();
    } catch (error) {
      window.showToast?.(`The refresh didn't work: ${(error as Error).message}`, 'error');
    }
    setSyncing(false);
  };

  const findBetterCopies = async () => {
    if (!libraryArtistId) return;
    // the classic script fills its own data, then opens its picker
    await Promise.resolve(window.checkArtistEnhanceEligibility?.(libraryArtistId));
    window.openEnhanceQualityModal?.();
  };

  const menu: MenuEntry[] = [
    ...(!sourceOnly && payload
      ? [{ key: 'radio', label: 'Play artist radio', onSelect: () => window.playArtistRadio?.() }]
      : []),
    ...(shown.length > 0
      ? [
          {
            key: 'choose',
            label: asksFirst ? 'Choose releases to request…' : 'Choose releases to add…',
            onSelect: () => setDialog('choose'),
          },
        ]
      : []),
    ...(libraryArtistId && (libraryTracks ?? 0) > 0
      ? [{ key: 'better', label: 'Find better copies…', onSelect: () => void findBetterCopies() }]
      : []),
    ...(follow.following && followId
      ? [
          {
            key: 'follow-settings',
            label: 'Following settings…',
            onSelect: () => setDialog('follow-settings'),
          },
        ]
      : []),
    ...(artistName && audiobooksOff === null
      ? [
          {
            key: 'audiobook',
            label:
              !folderSet && !isRouted
                ? 'File as audiobooks (set the folder first)'
                : 'File as audiobooks',
            checked: isRouted,
            disabled: routed.isPending || setRoute.isPending || (!folderSet && !isRouted),
            onCheckedChange: (next: boolean) => setRoute.mutate(next),
          },
        ]
      : []),
    {
      key: 'about',
      label: `About ${artistName || 'this artist'}…`,
      onSelect: () => setDialog('about'),
    },
    { key: 'filters', label: 'More filters…', onSelect: () => setDialog('filters') },
    { key: 'sep1', separator: true },
    ...(libraryArtistId
      ? [{ key: 'photo', label: 'Change photo…', onSelect: () => setDialog('photo') }]
      : []),
    ...(showsFixMatchButton(artist, sourceOnly, isAdmin)
      ? [
          {
            key: 'matches',
            label: 'Check matches on each source…',
            onSelect: () => setDialog('matches'),
          },
        ]
      : []),
    ...(isAdmin && libraryArtistId
      ? [
          {
            key: 'sync',
            label: syncing
              ? 'Refreshing from your media server…'
              : 'Refresh from your media server',
            disabled: syncing,
            onSelect: () => void syncFromServer(),
          },
        ]
      : []),
    ...(showsDbRecordButton(artist, sourceOnly)
      ? [{ key: 'record', label: 'Database record…', onSelect: () => setDialog('record') }]
      : []),
    ...(libraryArtistId
      ? [
          {
            key: 'report',
            label: 'Report a problem…',
            onSelect: () =>
              window.showReportIssueModal?.('artist', artist.id, artistName, '', undefined),
          },
        ]
      : []),
    ...(isAdmin && libraryArtistId
      ? [
          { key: 'sep2', separator: true } as MenuEntry,
          {
            key: 'remove',
            label: 'Remove from library…',
            tone: 'danger' as const,
            onSelect: () => setDialog('remove'),
          },
        ]
      : []),
  ];

  // ── header ─────────────────────────────────────────────────────────────
  const addAllLabel = asksFirst ? 'Request all missing' : 'Add all missing to Wanted';
  const addAllReason = !payload
    ? undefined
    : stillChecking
      ? 'Checking what’s in your library first.'
      : missing.length === 0
        ? shown.length === 0
          ? 'There are no releases to add.'
          : 'Everything here is in your library or on Wanted.'
        : undefined;

  const header = (
    <header className={styles.header} data-tour="artist-header">
      <HeaderArt artist={artist} image={payload ? image : null} applied={appliedPhoto} />
      <div className={styles.headText}>
        <p className={styles.label}>Artist</p>
        {artistName ? (
          <h1 className={styles.name}>{artistName}</h1>
        ) : (
          <h1 className={styles.name}>
            <Skeleton className={styles.nameLoading} />
            <span className="ss-sr">Loading the artist</span>
          </h1>
        )}
        {payload ? (
          <p className={styles.counts}>
            <span className={styles.countsLong}>{countsLine(counts, sourceOnly)}</span>
            <span className={styles.countsShort}>{countsLine(counts, sourceOnly, true)}</span>
          </p>
        ) : null}
        {payload && (follow.following || latest || links.length > 0) ? (
          <div className={styles.followRow}>
            {follow.following ? <StatusTag tone="success">{followingSince}</StatusTag> : null}
            {latest || links.length > 0 ? (
              <span className={styles.latest}>
                {latest ? `Latest: ${latestText(latest)}` : null}
                {links.map((link, i) => (
                  <span key={link.key}>
                    {latest || i > 0 ? ' · ' : ''}
                    <a href={link.url} target="_blank" rel="noopener noreferrer">
                      {link.label}
                    </a>
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {payload ? (
        <>
          {follow.following ? (
            <StatusTag tone="success" className={styles.phoneFollowing}>
              {followingSince}
            </StatusTag>
          ) : null}
          <div className={styles.actions} data-tour="artist-actions">
            <Button
              size="lg"
              variant="primary"
              className={styles.primary}
              disabled={Boolean(addAllReason) || adder.busy}
              disabledReason={addAllReason}
              focusableWhenDisabled={adder.busy}
              onClick={() => setDialog('add-all')}
            >
              {adder.busy ? 'Adding…' : addAllLabel}
            </Button>
            {identity ? (
              <button
                type="button"
                className={styles.follow}
                aria-pressed={follow.following}
                aria-label={follow.following ? `Following ${artistName}` : `Follow ${artistName}`}
                aria-busy={follow.busy || undefined}
                onClick={toggleFollow}
              >
                {follow.following ? <CheckIcon /> : null}
                <span className={styles.followLabel}>
                  {follow.following ? 'Following' : 'Follow'}
                </span>
              </button>
            ) : null}
            <ArtistMenu label={`More actions for ${artistName || 'this artist'}`} entries={menu} />
          </div>
        </>
      ) : null}
    </header>
  );

  const notice =
    payload && identity && !follow.following && !follow.unknown ? (
      <p className={styles.notice}>
        Follow {artistName} and each new release is added to Wanted as it comes out, at your quality
        target.
      </p>
    ) : null;

  const toolbar = (
    <div className={styles.toolbar}>
      <TabBar
        base={tabBase}
        tab={tab}
        counts={tabCounts}
        onSelect={(next) => go({ tab: next, all: undefined, manage: undefined })}
      />
      {tab === 'releases' ? (
        <div className={styles.filters} role="group" aria-label="Show" data-tour="artist-filters">
          {FILTERS.map((option) => (
            <OptionButton
              key={option.key}
              data-slot="filter"
              selected={option.key === filter}
              onClick={() => go({ show: option.key, all: undefined }, { replace: true })}
            >
              {option.label}
            </OptionButton>
          ))}
        </div>
      ) : null}
    </div>
  );

  // ── body ───────────────────────────────────────────────────────────────
  let body: ReactNode;
  if (failed) {
    const message =
      query.data?.success === false
        ? `${query.data.error || 'SoulSync couldn’t find this artist'}.`
        : whyItFailed(query.error);
    body = (
      <>
        <Notice
          tone="danger"
          role="alert"
          title={`Couldn't load ${search.name || 'this artist'}`}
          actions={
            <>
              <Button size="lg" onClick={() => void query.refetch()}>
                Try again
              </Button>
              {isAdmin ? (
                <Button size="lg" onClick={() => void navigate({ to: '/setup-check' })}>
                  Run Setup check
                </Button>
              ) : null}
            </>
          }
        >
          {message} Your library and Wanted are safe; this is a display problem.
        </Notice>
        <CardSkeletons count={phone ? 2 : 4} faded />
      </>
    );
  } else if (!payload) {
    body = (
      <LoadingState label={search.name ? `Loading ${search.name}…` : 'Loading this artist…'}>
        <CardSkeletons count={phone ? 4 : 8} />
      </LoadingState>
    );
  } else if (tab === 'tracks') {
    body = (
      <TracksTab
        artistId={payload.artist?.id}
        artistName={artistName}
        libraryArtistId={libraryArtistId}
        isAdmin={isAdmin}
        manage={Boolean(search.manage)}
        focusAlbumId={search.album}
        onManage={(on) => go({ manage: on || undefined })}
      />
    );
  } else if (tab === 'similar') {
    body = <SimilarTab artistName={artistName} query={similar} />;
  } else {
    const providerError = payload.provider_error?.error;
    body = (
      <>
        {providerError ? (
          <Notice
            tone="warning"
            title="Showing only what's in your library"
            actions={
              <Button size="lg" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          >
            SoulSync couldn&apos;t get the full discography from{' '}
            {payload.provider_error?.source || 'your metadata source'}: {providerError}. Releases
            you don&apos;t have yet are missing from this list until it answers.
          </Notice>
        ) : null}
        {releases.length === 0 ? (
          <EmptyState
            variant="panel"
            title={`No releases listed for ${artistName}`}
            description={`None of your metadata sources list releases for ${artistName}, and nothing of theirs is in your library yet. Search for them by name to find what's out there.`}
            actions={
              <Button size="lg" variant="primary" onClick={() => void navigate({ to: '/search' })}>
                Search for music
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <p className={styles.listEmpty}>
            {filter === 'missing'
              ? stillChecking
                ? 'Still checking your library. Missing releases show here as soon as it knows.'
                : `Nothing missing: you have every release of ${artistName} listed here, or it's on Wanted.`
              : filter === 'albums'
                ? `No albums listed for ${artistName}. Their EPs and singles are under All.`
                : 'Nothing here with the current filters. Check More filters in the … menu.'}
          </p>
        ) : (
          <ul
            className={styles.grid}
            aria-label={`Releases by ${artistName}`}
            data-tour="artist-releases"
          >
            {visible.map((release) => (
              <li key={release.key}>
                <ArtistReleaseCard
                  release={release}
                  state={stateOf(release)}
                  following={follow.following}
                  adding={adder.pending.has(release.key)}
                  actions={{
                    onOpen: (r) => void releaseActions.open(r.raw),
                    onPlay: (r) => void releaseActions.play(r.raw),
                    onAdd: (r) => void adder.add([r]),
                    onShowInLibrary: libraryArtistId
                      ? (r) =>
                          go({
                            tab: 'tracks',
                            album: r.libraryAlbumId ?? undefined,
                            all: undefined,
                          })
                      : undefined,
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {filtered.length > visible.length ? (
          <div className={styles.footer}>
            <p className={styles.footerCount}>
              {visible.length} of {plural(filtered.length, 'release')}
            </p>
            <Button size="lg" onClick={() => go({ all: true }, { replace: true })}>
              Show all {filtered.length.toLocaleString()}
            </Button>
          </div>
        ) : null}
        {!sourceOnly ? (
          <div className={styles.legacy}>
            <AppearsOnSection artistId={payload.artist?.id} artistName={artistName} />
          </div>
        ) : null}
        <div className={styles.legacy}>
          <ArtistVideosSection artistName={artistName} />
        </div>
      </>
    );
  }

  // ── dialogs ────────────────────────────────────────────────────────────
  const albumsMissing = missing.filter(
    (r) => r.kind === 'album' || r.kind === 'compilation',
  ).length;
  const othersMissing = missing.length - albumsMissing;
  const collection = (['albums', 'eps', 'singles'] as const)
    .map((bucket) => {
      const stats = resolvedCategoryStats(displayed[bucket] ?? []);
      const [owned, total] = stats.text.split('/').map(Number);
      return {
        label: bucket === 'albums' ? 'Albums' : bucket === 'eps' ? 'EPs' : 'Singles',
        owned,
        total,
      };
    })
    .filter((row) => row.total > 0);

  const dialogs = payload ? (
    <>
      <ConfirmDialog
        open={dialog === 'unfollow'}
        title={`Unfollow ${artistName}?`}
        confirmLabel="Unfollow"
        cancelLabel="Keep following"
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          setDialog(null);
          follow.unfollow();
        }}
      >
        <p className={styles.dialogText}>
          SoulSync stops checking {artistName} for new releases.{' '}
          {wantedCount > 0
            ? `The ${plural(wantedCount, 'thing')} already on Wanted stay${wantedCount === 1 ? 's' : ''} there and keep${wantedCount === 1 ? 's' : ''} being searched for.`
            : 'Anything of theirs already on Wanted stays there.'}
        </p>
        <p className={styles.dialogNote}>Nothing in your library changes.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'add-all'}
        title={
          asksFirst
            ? `Request ${plural(missing.length, 'release')}?`
            : `Add ${plural(missing.length, 'release')} to Wanted?`
        }
        confirmLabel={
          asksFirst
            ? `Request ${plural(missing.length, 'release')}`
            : `Add ${plural(missing.length, 'release')}`
        }
        busy={adder.busy}
        extra={
          <Button
            size="lg"
            variant="ghost"
            onClick={() => {
              setDialog('choose');
            }}
          >
            Choose releases…
          </Button>
        }
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          setDialog(null);
          void adder.add(missing);
        }}
      >
        <p className={styles.dialogText}>
          SoulSync adds the tracks you don&apos;t have from{' '}
          {[
            albumsMissing ? plural(albumsMissing, 'album') : '',
            othersMissing ? plural(othersMissing, 'EP or single', 'EPs and singles') : '',
          ]
            .filter(Boolean)
            .join(' and ')}{' '}
          to Wanted, and searches for them on the next scheduled search.
        </p>
        <p className={styles.dialogNote}>
          Tracks already in your library or on Wanted are skipped, and so are the kinds your release
          filters leave out (live, remixes and so on).
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'remove'}
        title={`Remove ${artistName} from your library?`}
        confirmLabel={removing ? 'Removing…' : 'Remove from library'}
        tone="danger"
        busy={removing}
        onCancel={() => setDialog(null)}
        onConfirm={() => void removeArtist()}
      >
        <p className={styles.dialogText}>
          SoulSync forgets {artistName} and all of their albums and tracks.
        </p>
        <p className={styles.dialogText}>
          Only the database entries go: not one file on disk is deleted, and a rescan finds them
          again.
        </p>
      </ConfirmDialog>

      <MoreFiltersDialog
        open={dialog === 'filters'}
        options={options}
        otherSources={gapFill.enabled}
        onChange={setOptions}
        onToggleOtherSources={gapFill.toggle}
        onClose={() => setDialog(null)}
      />

      <AboutDialog
        open={dialog === 'about'}
        artist={artist}
        sourceOnly={sourceOnly}
        enrichment={payload.enrichment_coverage}
        facts={{
          collection,
          formats: stream.completed && stream.counts ? [...stream.counts.formats].sort() : [],
          links,
          following: follow.following
            ? {
                since: followingSince,
                lastChecked: followedRow?.last_scan_timestamp
                  ? `last checked ${new Date(followedRow.last_scan_timestamp).toLocaleDateString()}`
                  : 'not checked yet',
              }
            : null,
          followedFacts: followedFacts(followedConfig.data?.artist),
        }}
        onClose={() => setDialog(null)}
      >
        <div className={styles.legacy}>
          <ConcertsSection
            artistName={artistName}
            mbid={String(payload.artist?.musicbrainz_id || '')}
          />
        </div>
      </AboutDialog>

      {dialog === 'choose' ? (
        <DiscographyModal
          libraryArtistId={payload.artist?.id}
          artistName={artistName}
          artistImage={photo || ''}
          discography={displayed}
          editionSuperseded={gapFill.editionSuperseded}
          onClose={() => setDialog(null)}
          watchlistIdentity={identity}
        />
      ) : null}

      {dialog === 'photo' && libraryArtistId ? (
        <BodyPortal>
          <ArtPicker
            target={{ kind: 'artist', id: payload.artist?.id }}
            currentUrl={photo || null}
            subtitle={`${artistName} · applies to SoulSync, your server, and artist.jpg on disk`}
            onApplied={(url) => setAppliedPhoto(url)}
            onClose={() => setDialog(null)}
          />
        </BodyPortal>
      ) : null}

      {dialog === 'matches' ? (
        <ArtistMatchesModal
          artistId={payload.artist?.id}
          artistName={artistName || 'Artist'}
          onChanged={() => void query.refetch()}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === 'record' ? (
        <ArtistRecordModal
          artistId={payload.artist?.id}
          artistName={artistName || 'Artist'}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === 'follow-settings' && followId ? (
        <WatchlistArtistConfigModal
          profileId={profileId}
          artistId={followId}
          globalOverrideActive={Boolean(globalConfig.data?.global_override_enabled)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  ) : null;

  return (
    <div className={styles.page}>
      {header}
      {notice}
      {toolbar}
      <div
        role="tabpanel"
        id={`${tabBase}-panel`}
        aria-labelledby={`${tabBase}-tab-${tab}`}
        className={styles.panel}
      >
        {body}
      </div>
      {dialogs}
      {/* The classic Enhance Quality script looks this button up by id before
          it will load its data; it is never shown. */}
      <button
        type="button"
        id="library-artist-enhance-btn"
        className={`hidden ${styles.hiddenAnchor}`}
        tabIndex={-1}
        aria-hidden="true"
      >
        <span className="enhance-text" />
      </button>
    </div>
  );
}
