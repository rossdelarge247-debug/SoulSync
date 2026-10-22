/**
 * Search (boards 2m, 2n): one query, three sources, grouped in the order that
 * costs least: your library (instant), the download source (Soulseek streams
 * in with a running count), then the connected metadata service. The query
 * and the type (Everything / Artists / Albums / Tracks) are in the URL.
 *
 * Only one primary button on the page: the Soulseek row that completes
 * something you already want. Everything else is secondary.
 *
 * Typing searches the library and the metadata service as it settles. The
 * download source is searched only for a submitted query (`files=1` in the
 * URL): Enter, a hand-off from another page, a recent search, or a link that
 * arrives with `?q=`. Every Soulseek search holds a server thread until slskd
 * answers, and partial words are bad manners on the network.
 *
 * Hand-offs kept from today's page:
 *   - `#enhanced-search-input` honours a native `input` event (the top bar's
 *     search field, ⌘K, the library and chat hand a query over that way);
 *   - `window._searchPageSetQuery(q)` searches for `q` (the global download
 *     widget);
 *   - `#enhanced-main-results-area` is where the legacy painter draws the
 *     bubbles of downloads started from this page.
 */

import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MirrorCandidate } from '@/features/mirror/mirror.model';

import { Button, OptionButton } from '@/components/form';
import { TitleWithHelp } from '@/components/page-header';
import { EmptyState } from '@/components/primitives';
import { MirrorPlaylistDialog } from '@/features/mirror/mirror-playlist-dialog';
import { candidateLink } from '@/features/mirror/mirror.model';
import { qualityPresetsQueryOptions } from '@/features/quality/quality.api';
import { acquireVerb, profileAsksFirst } from '@/platform/shell/download-rights';
import { useProfile, useReactPageShell } from '@/platform/shell/route-controllers';

import type { BasicSource } from '../-basic.types';
import type { SearchLabel, SearchPlaylist, SearchVideo } from '../-search.types';
import type { SearchType } from '../-search.url';
import type { SoulseekFilters } from '../-soulseek.model';
import type { CatalogActions } from './catalog-section';
import type { VideoProgress } from './video-grid';

import {
  fetchBasicSources,
  isSingleSourceMode,
  sourceLabel as downloadSourceLabel,
} from '../-basic.api';
import {
  addSearchAlbumToWanted,
  addSearchTrackToWanted,
  openSearchAlbum,
  openSearchTrack,
  playOwnedTrack,
  streamSearchTrack,
} from '../-search.actions';
import { fetchLabels, lookupById } from '../-search.api';
import {
  isIdLookupQuery,
  loadRecentSearches,
  removeRecentSearch,
  saveRecentSearch,
  SEARCH_DEBOUNCE_MS,
  shouldSearch,
  sourceLabel,
  visibleSources,
} from '../-search.helpers';
import { libraryResultsQueryOptions } from '../-search.library';
import {
  parseSubmitted,
  parseType,
  SEARCH_TYPE_LABELS,
  SEARCH_TYPES,
  searchUrlFor,
} from '../-search.url';
import { useArtistImages } from '../-search.use-artist-images';
import { activeResults, useSearchController } from '../-search.use-controller';
import { useLibraryCheck } from '../-search.use-library-check';
import { useVideoDownloads } from '../-search.use-video-downloads';
import { DEFAULT_SOULSEEK_FILTERS } from '../-soulseek.model';
import { useFileSearch } from '../-soulseek.stream';
import { CatalogSection } from './catalog-section';
import { libraryRows, LibrarySection } from './library-section';
import { PlaylistPreviewModal } from './playlist-preview-modal';
import styles from './search-page.module.css';
import { SoulseekPrompt, SoulseekSection } from './soulseek-section';

const routeApi = getRouteApi('/search');

/** Browse ideas for the empty page. Plain tiles: the design system has no gradient washes. */
const BROWSE = [
  { label: 'Top trending', query: 'Trending' },
  { label: 'New releases', query: 'New Releases' },
  { label: 'Electronic and dance', query: 'Electronic' },
  { label: 'Rock and alternative', query: 'Rock' },
  { label: 'Hip-hop and rap', query: 'Hip Hop' },
  { label: 'Lo-fi and chill', query: 'Chill' },
  { label: 'Jazz and soul', query: 'Jazz' },
  { label: 'Soundtracks and score', query: 'Soundtrack' },
];

const SOUNDCLOUD_RE = /soundcloud\.com|snd\.sc/i;

/** Choices that outlive a visit to another page, like today's page kept them. */
let keptFilters: SoulseekFilters = DEFAULT_SOULSEEK_FILTERS;
let keptSource: string | null = null;

/** Test seam. */
export function resetSearchPageMemory(): void {
  keptFilters = DEFAULT_SOULSEEK_FILTERS;
  keptSource = null;
}

/** Marker the native listener stamps on an input event it has already handled. */
type ClaimedEvent = { _nativeHandled?: boolean };

function candidateFromPlaylist(playlist: SearchPlaylist): MirrorCandidate | null {
  const source =
    playlist.source === 'deezer'
      ? 'deezer'
      : playlist.source === 'spotify' || !playlist.source
        ? 'spotify'
        : null;
  if (!source || playlist.id == null || playlist.id === '') return null;
  const id = String(playlist.id);
  return {
    source,
    id,
    name: playlist.name || 'Playlist',
    owner: playlist.creator,
    imageUrl: playlist.image_url,
    trackCount: playlist.track_count,
    link: playlist.link || candidateLink(source, id),
  };
}

export function SearchPage() {
  useReactPageShell('search');
  const { isAdmin } = useProfile();
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const committed = search.q ?? '';
  const type: SearchType = parseType(search.type);
  const submitted = Boolean(committed) && parseSubmitted(search.files);

  const [input, setInput] = useState(committed);
  const [recents, setRecents] = useState<string[]>(loadRecentSearches);
  const [filters, setFiltersState] = useState<SoulseekFilters>(keptFilters);
  const [preview, setPreview] = useState<SearchPlaylist | null>(null);
  const [mirror, setMirror] = useState<{ open: boolean; initial: MirrorCandidate | null }>({
    open: false,
    initial: null,
  });

  // the URL moved (back, forward, a link): the field follows
  useEffect(() => {
    setInput((prev) => (prev.trim() === committed ? prev : committed));
  }, [committed]);

  /** Typing settled: the library and the metadata service search; Soulseek waits. */
  const commit = useCallback(
    (raw: string, { push = false }: { push?: boolean } = {}) => {
      const q = raw.trim();
      void navigate({ search: (prev) => searchUrlFor(q, parseType(prev.type)), replace: !push });
    },
    [navigate],
  );

  /**
   * A submitted query: every section searches, Soulseek included. A new
   * search is its own history entry; submitting what was typed takes over the
   * typed entry, so back doesn't land on the same query unsearched.
   */
  const urlRef = useRef({ committed, submitted });
  urlRef.current = { committed, submitted };
  const submit = useCallback(
    (raw: string) => {
      const q = raw.trim();
      if (!shouldSearch(q)) return;
      const now = urlRef.current;
      const push = !now.committed || (now.submitted && now.committed !== q);
      setInput(q);
      void navigate({
        search: (prev) => searchUrlFor(q, parseType(prev.type), true),
        replace: !push,
      });
    },
    [navigate],
  );

  // arriving with ?q= (a link, the top bar, a bookmark) is a submitted search
  const arrivedRef = useRef(committed && !submitted ? committed : '');
  useEffect(() => {
    const arrived = arrivedRef.current;
    arrivedRef.current = '';
    if (arrived)
      void navigate({
        search: (prev) => searchUrlFor(arrived, parseType(prev.type), true),
        replace: true,
      });
  }, [navigate]);

  // typing settles into a search; the first search of a visit is its own
  // history entry, refinements replace it. Typing away from a submitted search
  // starts a new entry, so back still finds that search's results.
  useEffect(() => {
    const q = input.trim();
    if (q === committed) return;
    if (q && !shouldSearch(q)) return;
    const timer = window.setTimeout(
      () => commit(q, { push: (!committed && Boolean(q)) || submitted }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [input, committed, submitted, commit]);

  const isLink = isIdLookupQuery(committed);
  const searchable = shouldSearch(committed);

  useEffect(() => {
    if (searchable && !isLink) setRecents(saveRecentSearch(committed));
  }, [committed, searchable, isLink]);

  // a type change keeps whether the query was submitted
  const setType = (next: SearchType) => {
    void navigate({
      search: (prev) => searchUrlFor(prev.q ?? '', next, parseSubmitted(prev.files)),
    });
  };

  const setFilters = useCallback((patch: Partial<SoulseekFilters>) => {
    setFiltersState((prev) => {
      const next = { ...prev, ...patch };
      keptFilters = next;
      return next;
    });
  }, []);

  // ── the quality target, for "At your target" and the consequences ─────
  const presets = useQuery(qualityPresetsQueryOptions());
  const bar = presets.data?.current?.targets ?? (presets.isError ? [] : null);
  const targetName = presets.data?.current?.name ?? null;

  // ── library ──────────────────────────────────────────────────────────
  const libraryEnabled = searchable && !isLink;
  const library = useQuery({ ...libraryResultsQueryOptions(committed), enabled: libraryEnabled });

  // ── download source ──────────────────────────────────────────────────
  const downloadSources = useQuery({
    queryKey: ['search', 'download-sources'],
    queryFn: fetchBasicSources,
    staleTime: 5 * 60_000,
  });
  const sourceList: BasicSource[] = downloadSources.data?.sources ?? [];
  const single = downloadSources.data ? isSingleSourceMode(downloadSources.data) : true;
  const [fileSourcePick, setFileSourcePick] = useState<string | null>(keptSource);
  const fileSource = single
    ? null
    : fileSourcePick && sourceList.some((s) => s.name === fileSourcePick)
      ? fileSourcePick
      : (sourceList[0]?.name ?? null);
  // an Artists search has no files to show, so Soulseek isn't asked
  // only a submitted query goes to Soulseek
  const filesApply = (q: string) =>
    type !== 'artists' && (!isIdLookupQuery(q) || SOUNDCLOUD_RE.test(q));
  const fileQuery =
    submitted && searchable && filesApply(committed) && (single || downloadSources.data)
      ? committed
      : null;
  const typed = input.trim();
  const filesPrompt =
    shouldSearch(typed) && filesApply(typed) && !(submitted && typed === committed);
  const files = useFileSearch(fileQuery, fileSource);
  // "Better copies below" (HANDOFF 18): the folders the download source has at
  // your target, and the one a library album asked to go to
  const [betterCopies, setBetterCopies] = useState<ReadonlySet<string>>(() => new Set());
  const [jumpTo, setJumpTo] = useState<{ key: string; n: number } | null>(null);
  const goToBetterCopies = useCallback(
    (key: string) => setJumpTo((prev) => ({ key, n: (prev?.n ?? 0) + 1 })),
    [],
  );
  const downloadName = single
    ? sourceList[0]
      ? downloadSourceLabel(sourceList[0])
      : 'Soulseek'
    : (sourceList.find((s) => s.name === fileSource) ?? sourceList[0])?.display_name || 'Soulseek';

  // ── metadata service ─────────────────────────────────────────────────
  const controller = useSearchController({
    onUnconfiguredSource: (source) => window.openSettingsForSource?.(source),
  });
  const { state: catalog, submitQuery, setActiveSource, seedFromIdLookup } = controller;
  const catalogSources = visibleSources(catalog.enabledExperimental).filter(
    (s) => s !== 'soulseek',
  );
  // today's page could be left on its Files tab; this page searches a service here
  useEffect(() => {
    if (catalog.activeSource === 'soulseek') {
      const fallback =
        catalogSources.find((s) => catalog.configuredSources[s] !== false) ?? 'spotify';
      setActiveSource(fallback);
    }
  }, [catalog.activeSource, catalog.configuredSources, catalogSources, setActiveSource]);

  const [lookupPending, setLookupPending] = useState(false);
  const [attempted, setAttempted] = useState('');
  const submitRef = useRef(submitQuery);
  submitRef.current = submitQuery;
  useEffect(() => {
    if (!searchable) return;
    let live = true;
    if (isLink) {
      setLookupPending(true);
      void lookupById(committed)
        .then((data) => {
          if (!live) return;
          if (data?.available && data.source) seedFromIdLookup(committed, data);
          else window.showToast?.(data?.message || 'No match for that link.', 'warning');
        })
        .catch(() => {
          if (live) window.showToast?.('Link or ID lookup failed.', 'error');
        })
        .finally(() => {
          if (live) setLookupPending(false);
        });
    } else if (catalog.activeSource !== 'soulseek') {
      submitRef.current(committed);
    }
    setAttempted(committed);
    return () => {
      live = false;
    };
    // the active source is followed by setActiveSource itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed, searchable, isLink, seedFromIdLookup]);

  const results = activeResults(catalog);
  const catalogLoading = catalog.loadingSources.has(catalog.activeSource) || lookupPending;
  const catalogCached = Boolean(catalog.sources[catalog.activeSource]);
  const catalogFailed =
    searchable &&
    attempted === committed &&
    !catalogLoading &&
    !catalogCached &&
    catalog.query === committed &&
    !isLink;

  const hasCatalogResults =
    results.artists.length +
      results.albums.length +
      results.tracks.length +
      results.playlists.length >
    0;
  const [labels, setLabels] = useState<SearchLabel[]>([]);
  useEffect(() => {
    if (!searchable || isLink || !hasCatalogResults) {
      setLabels([]);
      return;
    }
    let live = true;
    void fetchLabels(committed).then((found) => {
      if (live) setLabels(found);
    });
    return () => {
      live = false;
    };
  }, [committed, searchable, isLink, hasCatalogResults]);

  const ownership = useLibraryCheck(results.albums, results.tracks);
  const artistImages = useArtistImages([], results.artists, catalog.activeSource);
  const {
    progress: videoProgress,
    download: downloadVideo,
    request: requestVideo,
    requested: requestedVideos,
  } = useVideoDownloads();
  const videoProgressForGrid = useMemo(() => {
    if (requestedVideos.size === 0) return videoProgress;
    const merged: Record<string, VideoProgress> = { ...videoProgress };
    for (const id of requestedVideos)
      if (!merged[id]) merged[id] = { state: 'completed', percent: 100 };
    return merged;
  }, [videoProgress, requestedVideos]);

  const catalogActions: CatalogActions = {
    onAddAlbum: (album) => void addSearchAlbumToWanted(album, catalog.activeSource),
    onAddTrack: (track) => void addSearchTrackToWanted(track),
    onOpenAlbum: (album) => void openSearchAlbum(album, catalog.activeSource),
    onOpenTrack: (track) => void openSearchTrack(track),
    onPlayTrack: (track, owned) => {
      if (owned) playOwnedTrack(owned);
      else void streamSearchTrack(track);
    },
    onPreviewPlaylist: (playlist) => setPreview(playlist),
    onMirrorPlaylist: (playlist) =>
      setMirror({ open: true, initial: candidateFromPlaylist(playlist) }),
    onVideo: (video: SearchVideo) => {
      if (profileAsksFirst()) void requestVideo(video);
      else downloadVideo(video);
    },
  };

  // ── the legacy hand-offs ─────────────────────────────────────────────
  const handOffRef = useRef(submit);
  handOffRef.current = submit;
  useEffect(() => {
    window._searchPageSetQuery = (next: string) => handOffRef.current(next);
    return () => {
      delete window._searchPageSetQuery;
    };
  }, []);
  useEffect(() => {
    window.showSearchDownloadBubbles?.();
  }, []);

  const inputRef = useRef<HTMLInputElement>(null);
  const inputValueRef = useRef(input);
  inputValueRef.current = input;
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    // a programmatic write plus a native input event (the top bar, chat,
    // the library) never reaches React's onChange; this listener does. Those
    // hand-offs are searches someone asked for, so they're submitted; real
    // keystrokes (trusted events) are typing.
    const onNativeInput = (event: Event) => {
      (event as ClaimedEvent)._nativeHandled = true;
      const value = (event.target as HTMLInputElement).value;
      if (!event.isTrusted) {
        if (shouldSearch(value)) handOffRef.current(value);
        else setInput(value);
        return;
      }
      if (value !== inputValueRef.current) setInput(value);
    };
    element.addEventListener('input', onNativeInput);
    return () => element.removeEventListener('input', onNativeInput);
  }, []);

  // ── what to show ─────────────────────────────────────────────────────
  const catalogCount =
    catalog.activeSource === 'youtube_videos'
      ? results.videos.length
      : type === 'artists'
        ? results.artists.length
        : type === 'albums'
          ? results.albums.length
          : type === 'tracks'
            ? results.tracks.length
            : results.albums.length +
              results.playlists.length +
              results.tracks.length +
              results.artists.length +
              labels.length;
  const libraryEmpty =
    !libraryEnabled || (library.isSuccess && libraryRows(library.data, type).length === 0);
  // nothing found means looked everywhere: an unsubmitted query hasn't asked Soulseek
  const filesEmpty =
    !filesApply(committed) ||
    (fileQuery != null && files.state.status === 'done' && files.state.results.length === 0);
  const catalogEmpty = !catalogLoading && catalogCached && catalogCount === 0;
  const nothingFound = searchable && libraryEmpty && filesEmpty && catalogEmpty;
  const idle = !committed && !input.trim();
  const catalogName =
    catalog.activeSource === 'youtube_videos' ? 'YouTube' : sourceLabel(catalog.activeSource);

  return (
    <div className={styles.page} data-testid="search-page">
      <div className={styles.inner}>
        <header className={styles.header} id="search-head">
          <div className={styles.headText}>
            <h1 className={styles.title}>Search</h1>
            <p className={styles.subtitle}>
              Your library, {downloadName} and {catalogName}, in one go.
            </p>
          </div>
          <div className={styles.fieldRow}>
            {/* phones: the title is hidden there, so the "?" sits by the field */}
            <TitleWithHelp page="search">
              <form
                role="search"
                className={styles.field}
                id="enhanced-search-bar"
                data-active={committed ? 'true' : undefined}
                onSubmit={(event) => {
                  event.preventDefault();
                  const q = input.trim();
                  if (!q) return;
                  if (q === committed && submitted) return;
                  submit(q);
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.fieldIcon}>
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.3-4.3" />
                </svg>
                <input
                  ref={inputRef}
                  id="enhanced-search-input"
                  className={styles.input}
                  type="search"
                  aria-label="Search"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Artists, albums, tracks, or paste a link"
                  value={input}
                  onChange={(event) => {
                    if ((event.nativeEvent as ClaimedEvent)._nativeHandled) return;
                    setInput(event.currentTarget.value);
                  }}
                />
                {input ? (
                  <button
                    type="button"
                    className={styles.clear}
                    aria-label="Clear search"
                    title="Clear search"
                    onClick={() => {
                      setInput('');
                      commit('', { push: false });
                      inputRef.current?.focus();
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                ) : null}
              </form>
            </TitleWithHelp>
            <div className={styles.types} role="group" aria-label="Show" id="search-type-row">
              {SEARCH_TYPES.map((t) => (
                <OptionButton key={t} selected={type === t} onClick={() => setType(t)}>
                  {SEARCH_TYPE_LABELS[t]}
                </OptionButton>
              ))}
            </div>
          </div>
        </header>

        {/* React renders no children here: the legacy painter owns them */}
        <div className={styles.bubbles} id="enhanced-main-results-area" />

        {idle ? (
          <div className={styles.idle}>
            {recents.length ? (
              <section
                className={styles.section}
                aria-labelledby="search-recent-title"
                id="enh-recent-searches"
              >
                <div className={styles.sectionHead}>
                  <h2 className={styles.sectionTitle} id="search-recent-title">
                    Recent searches
                  </h2>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => {
                      try {
                        window.localStorage.removeItem('soulsyncRecentSearches');
                      } catch {
                        /* not remembered, nothing to forget */
                      }
                      setRecents([]);
                    }}
                  >
                    Clear all
                  </button>
                </div>
                <div className={styles.chips}>
                  {recents.map((entry) => (
                    <span className={styles.chip} key={entry}>
                      <button
                        type="button"
                        className={styles.chipLabel}
                        onClick={() => submit(entry)}
                      >
                        {entry}
                      </button>
                      <button
                        type="button"
                        className={styles.chipRemove}
                        aria-label={`Remove ${entry} from recent searches`}
                        onClick={() => setRecents(removeRecentSearch(entry))}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          width="16"
                          height="16"
                          aria-hidden="true"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                        >
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </span>
                  ))}
                </div>
              </section>
            ) : null}
            <section
              className={styles.section}
              aria-labelledby="search-browse-title"
              id="enh-explore-section"
            >
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle} id="search-browse-title">
                  Browse
                </h2>
              </div>
              <div className={styles.tiles}>
                {BROWSE.map((tile) => (
                  <button
                    type="button"
                    className={styles.tile}
                    key={tile.query}
                    onClick={() => submit(tile.query)}
                  >
                    {tile.label}
                  </button>
                ))}
              </div>
            </section>
          </div>
        ) : !searchable ? null : nothingFound ? (
          <EmptyState
            variant="panel"
            title={`Nothing found for “${committed}”`}
            description={`SoulSync looked in your library, on ${downloadName} and on ${catalogName}${type === 'everything' ? '' : `, for ${type}`}.`}
            hint="Check the spelling or try fewer words; an artist’s name on its own often finds the most."
            actions={
              type === 'everything' ? (
                <Button
                  size="lg"
                  onClick={() => {
                    setInput('');
                    commit('');
                    inputRef.current?.focus();
                  }}
                >
                  Clear the search
                </Button>
              ) : (
                <Button size="lg" onClick={() => setType('everything')}>
                  Search everything
                </Button>
              )
            }
          />
        ) : (
          <>
            {libraryEnabled ? (
              <LibrarySection
                results={library}
                query={committed}
                type={type}
                bar={bar}
                isAdmin={isAdmin}
                betterCopies={filesPrompt || fileQuery == null ? undefined : betterCopies}
                onBetterCopies={goToBetterCopies}
              />
            ) : null}
            {filesPrompt ? (
              <SoulseekPrompt title={downloadName} query={typed} onSearch={() => submit(typed)} />
            ) : fileQuery != null ? (
              <SoulseekSection
                search={files}
                query={committed}
                type={type}
                filters={filters}
                onFilters={setFilters}
                bar={bar}
                targetName={targetName}
                sources={sourceList}
                source={fileSource}
                singleSource={single}
                onSource={(name) => {
                  keptSource = name;
                  setFileSourcePick(name);
                }}
                isAdmin={isAdmin}
                onBetterCopies={setBetterCopies}
                jumpTo={jumpTo}
              />
            ) : null}
            <CatalogSection
              query={committed}
              type={type}
              activeSource={catalog.activeSource}
              sources={catalogSources}
              configured={catalog.configuredSources}
              onSource={(source) => {
                setAttempted(committed);
                setActiveSource(source);
              }}
              loading={catalogLoading || (!catalogCached && attempted !== committed)}
              failed={catalogFailed}
              onRetry={() => submitQuery(committed)}
              served={catalog.fallbacks[catalog.activeSource] ?? null}
              results={results}
              labels={labels}
              ownership={ownership}
              artistImages={artistImages}
              videoProgress={videoProgressForGrid}
              acquireVerb={acquireVerb()}
              actions={catalogActions}
            />
          </>
        )}
      </div>

      {preview ? (
        <PlaylistPreviewModal
          playlist={preview}
          onClose={() => setPreview(null)}
          onMirror={
            candidateFromPlaylist(preview)
              ? () => {
                  const initial = candidateFromPlaylist(preview);
                  setPreview(null);
                  setMirror({ open: true, initial });
                }
              : undefined
          }
        />
      ) : null}
      <MirrorPlaylistDialog
        open={mirror.open}
        initial={mirror.initial}
        onClose={() => setMirror((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
}
