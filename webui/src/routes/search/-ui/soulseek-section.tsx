/**
 * The download source's section (board 2m "Soulseek", 2n on phones): files
 * streaming in with "Still searching · N files from M users so far", the
 * filters (At your target by default), rows grouped by folder with the best
 * copy first, and each row's consequence line in colour. Only the first row
 * that completes something you already want gets the primary button.
 *
 * Every Download opens today's chooser (as-is, enriched, or tag it yourself;
 * the last pick is remembered), so the download modes are unchanged. A
 * folder's tracks and a row's other copies open under it.
 */

import { Fragment, useEffect, useLayoutEffect, useMemo, useState } from 'react';

import type { QualityRule } from '@/features/quality/quality.model';

import { Button, OptionButton, Select } from '@/components/form';
import { LoadingState, Notice, Skeleton, Spinner } from '@/components/primitives';

import type {
  BasicAlbum,
  BasicResult,
  BasicSource,
  DownloadTarget,
  FormatFilter,
  SortKey,
} from '../-basic.types';
import type { SearchType } from '../-search.url';
import type { Consequence, FileGroup, SoulseekFilters } from '../-soulseek.model';
import type { FileSearch } from '../-soulseek.stream';

import { startDownload } from '../-basic.actions';
import { sourceLabel as downloadSourceLabel } from '../-basic.api';
import { detectDiscBreaks, formatDuration, qualityLabel } from '../-basic.helpers';
import { FORMAT_FILTERS, SORT_OPTIONS, isAlbum } from '../-basic.types';
import {
  betterCopyFolders,
  consequenceFor,
  dropOwned,
  fileSize,
  groupResults,
  missingOnly,
  ownershipKey,
  primaryKey,
  rowActions,
  rowMeta,
  slotLine,
  SORT_LABELS,
  targetFilterLabel,
} from '../-soulseek.model';
import { useFileOwnership } from '../-soulseek.ownership';
import { DownloadChooser } from './download-chooser';
import { EnrichedModal } from './enriched-modal';
import { ManualModal } from './manual-modal';
import styles from './search-page.module.css';
import {
  ButtonLink,
  ChevronIcon,
  ofLine,
  plural,
  rowLimit,
  SectionHead,
  usePhoneWidth,
} from './search-parts';

/** The folder's own name, as shared ("Pale Harbour - Tidewater (2026) [FLAC 24-96]"). */
function folderName(album: BasicAlbum): string {
  const parts = String(album.album_path || '')
    .split(/[\\/]/)
    .filter(Boolean);
  return parts[parts.length - 1] || album.album_title || 'Unknown folder';
}

function fileName(result: BasicResult): string {
  if (isAlbum(result)) return folderName(result);
  const parts = String(result.filename || '')
    .split(/[\\/]/)
    .filter(Boolean);
  return parts[parts.length - 1] || result.title || 'Unknown file';
}

/**
 * Bring a row to the middle of the page's own scroller (.main-content), not
 * the document: body is overflow: hidden, and scrollIntoView would shift it
 * anyway if anything ever overflowed it.
 */
function centreInScroller(row: HTMLElement): void {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const behavior: ScrollBehavior = reduced ? 'auto' : 'smooth';
  let box = row.parentElement;
  while (box && box !== document.body) {
    const overflow = window.getComputedStyle(box).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && box.scrollHeight > box.clientHeight)
      break;
    box = box.parentElement;
  }
  if (!box || box === document.body) {
    row.scrollIntoView?.({ block: 'center', behavior });
    return;
  }
  const rowBox = row.getBoundingClientRect();
  const view = box.getBoundingClientRect();
  const top = box.scrollTop + (rowBox.top - view.top) - (view.height - rowBox.height) / 2;
  box.scrollTo?.({ top: Math.max(0, top), behavior });
}

function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function statusLine(state: FileSearch['state'], short = false): string {
  const files = plural(state.files, 'file');
  const users = state.users != null ? ` from ${plural(state.users, 'user')}` : '';
  if (state.status === 'searching') {
    if (short) return `${state.files.toLocaleString('en-GB')} so far`;
    return state.files ? `Still searching · ${files}${users} so far` : 'Still searching';
  }
  if (state.status === 'stopped') return `Stopped · ${files}${users}`;
  if (state.status === 'done') return `${files}${users}`;
  return '';
}

export function SoulseekSection({
  search,
  query,
  type,
  filters,
  onFilters,
  bar,
  targetName,
  sources,
  source,
  singleSource,
  onSource,
  isAdmin,
  onBetterCopies,
  jumpTo,
}: {
  search: FileSearch;
  query: string;
  type: SearchType;
  filters: SoulseekFilters;
  onFilters: (patch: Partial<SoulseekFilters>) => void;
  /** The quality target's bar; null while it loads (every copy then counts). */
  bar: readonly QualityRule[] | null;
  targetName: string | null;
  sources: BasicSource[];
  source: string | null;
  singleSource: boolean;
  onSource: (name: string) => void;
  isAdmin: boolean;
  /** The folder rows a library album below target can jump to (HANDOFF 18). */
  onBetterCopies?: (keys: ReadonlySet<string>) => void;
  /** Scroll to this folder's row and focus it; `n` makes a repeat jump count. */
  jumpTo?: { key: string; n: number } | null;
}) {
  const { state, stop, retry } = search;
  const [more, setMore] = useState(false);
  const [openTracks, setOpenTracks] = useState<ReadonlySet<string>>(() => new Set());
  const [openCopies, setOpenCopies] = useState<ReadonlySet<string>>(() => new Set());
  const [target, setTarget] = useState<DownloadTarget | null>(null);
  const [enriched, setEnriched] = useState<DownloadTarget | null>(null);
  const [manual, setManual] = useState<DownloadTarget | null>(null);

  const current = singleSource
    ? sources[0]
    : (sources.find((s) => s.name === source) ?? sources[0]);
  const title = current ? downloadSourceLabel(current) : 'Soulseek';
  const effectiveBar = bar ?? [];
  const effective: SoulseekFilters = {
    ...filters,
    // with no target known yet every copy counts
    quality: bar ? filters.quality : 'any',
    albumsOnly: filters.albumsOnly || type === 'albums',
  };

  const grouped = useMemo(
    () => groupResults(state.results, effective, query, effectiveBar),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state.results,
      effective.quality,
      effective.albumsOnly,
      effective.format,
      effective.sort,
      effective.reversed,
      query,
      bar,
    ],
  );
  const typed = type === 'tracks' ? grouped.filter((g) => g.kind === 'file') : grouped;
  const bests = useMemo(() => typed.map((g) => g.best), [typed]);
  const ownership = useFileOwnership(bests);
  const consequences = useMemo(() => {
    const map = new Map<string, Consequence>();
    for (const group of typed)
      map.set(group.key, consequenceFor(group.best, ownership, effectiveBar));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, ownership, bar]);
  const visible = filters.notInLibrary ? dropOwned(typed, consequences) : typed;
  const phone = usePhoneWidth();
  const baseLimit = rowLimit(type, phone, 2);
  const limit = more ? visible.length : baseLimit;
  const shown = visible.slice(0, limit);
  const primary = primaryKey(shown, consequences);

  // "Better copies below": tell the library section which albums have a
  // folder here at your target, and go to one when it asks
  const betterKeys = useMemo(() => betterCopyFolders(visible, bar), [visible, bar]);
  const betterSignature = [...betterKeys].join('\n');
  useEffect(() => {
    onBetterCopies?.(betterKeys);
    // the signature stands for the set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betterSignature, onBetterCopies]);
  useEffect(() => () => onBetterCopies?.(new Set()), [onBetterCopies]);
  // each jump is handled once (its n), so Show fewer or a filter change later
  // doesn't jump again
  const [handledJump, setHandledJump] = useState(0);
  const pending = jumpTo && jumpTo.n !== handledJump ? jumpTo : null;
  const jumpIndex = pending ? visible.findIndex((g) => g.key === pending.key) : -1;
  useEffect(() => {
    if (jumpIndex >= limit) setMore(true);
  }, [jumpIndex, limit]);
  useLayoutEffect(() => {
    if (!pending || jumpIndex < 0 || jumpIndex >= limit) return;
    const row = [...document.querySelectorAll<HTMLElement>('[data-soulseek-group]')].find(
      (el) => el.dataset.soulseekGroup === pending.key,
    );
    if (!row) return;
    setHandledJump(pending.n);
    centreInScroller(row);
    // the row lights up until focus leaves it; focus goes to its action, whose
    // name says the folder ("Upgrade: Pale Harbour - Low Light")
    row.dataset.jumped = 'true';
    const leave = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
      delete row.dataset.jumped;
      row.removeEventListener('focusout', leave);
    };
    row.addEventListener('focusout', leave);
    const action = row.querySelector<HTMLElement>('[data-row-action]');
    if (action) action.focus({ preventScroll: true });
    else {
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
    }
  }, [pending, jumpIndex, limit]);

  const toggle = (setter: typeof setOpenTracks, key: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const choose = (picked: DownloadTarget, mode: 'plain' | 'enriched' | 'manual') => {
    if (mode === 'enriched') setEnriched(picked);
    else if (mode === 'manual') setManual(picked);
    else startDownload(picked);
  };

  const searching = state.status === 'searching';
  const live =
    state.status === 'searching' || state.status === 'stopped' || state.status === 'done';

  const aside = (
    <>
      {live ? (
        <span className={styles.live} role="status" aria-live="polite">
          {searching ? <Spinner size={16} /> : null}
          <span className={styles.wideOnly}>{statusLine(state)}</span>
          <span className={styles.phoneOnly}>{statusLine(state, true)}</span>
        </span>
      ) : null}
      {searching ? (
        <button type="button" className={styles.linkButton} onClick={stop}>
          Stop
        </button>
      ) : state.status === 'stopped' ? (
        <button type="button" className={styles.linkButton} onClick={retry}>
          Search again
        </button>
      ) : null}
      {!singleSource && sources.length > 1 ? (
        <Select
          size="lg"
          className={styles.sourceSelect}
          aria-label="Download source to search"
          value={current?.name ?? ''}
          onChange={(event) => onSource(event.target.value)}
        >
          {sources.map((s) => (
            <option key={s.name} value={s.name}>
              {downloadSourceLabel(s)}
            </option>
          ))}
        </Select>
      ) : null}
    </>
  );

  const renderRow = (group: FileGroup, result: BasicResult, copy: boolean) => {
    const consequence = copy ? undefined : consequences.get(group.key);
    const actions = copy ? { main: 'Download', all: false } : rowActions(group, consequence);
    const isPrimary = !copy && group.key === primary;
    const albumTarget = (album: BasicAlbum): DownloadTarget => ({ kind: 'album', album });
    const whole: DownloadTarget = isAlbum(result)
      ? albumTarget(result)
      : { kind: 'track', track: result };
    const mainTarget: DownloadTarget =
      actions.main === 'Download missing' && isAlbum(result) && consequence
        ? albumTarget(missingOnly(result, consequence.missing))
        : whole;
    const name = fileName(result);
    const rowKey = `${group.key}::${result.username}::${isAlbum(result) ? result.album_path : result.filename}`;
    const tracksOpen = openTracks.has(rowKey);
    return (
      <Fragment key={rowKey}>
        <div
          className={styles.fileRow}
          data-copy={copy ? 'true' : undefined}
          data-testid={copy ? 'soulseek-copy' : 'soulseek-row'}
          data-soulseek-group={copy ? undefined : group.key}
        >
          <div className={styles.rowText}>
            <span className={styles.rowTitle} title={name}>
              {name}
            </span>
            <span className={`${styles.rowMeta} ${styles.wideOnly}`}>
              {rowMeta(result)}
              {consequence?.text ? (
                <>
                  {' · '}
                  <span className={styles.consequence} data-kind={consequence.kind}>
                    {consequence.text}
                  </span>
                </>
              ) : null}
            </span>
            <span className={`${styles.rowMeta} ${styles.phoneOnly}`}>
              {[
                isAlbum(result)
                  ? plural(result.tracks?.length || result.track_count || 0, 'track')
                  : 'Track',
                fileSize(isAlbum(result) ? result.total_size : result.size),
                result.username,
                slotLine(result).split(' · ')[0],
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {consequence?.text ? (
              <span
                className={`${styles.rowMeta} ${styles.consequence} ${styles.phoneOnly}`}
                data-kind={consequence.kind}
              >
                {capitalise(consequence.text)}
              </span>
            ) : null}
            {!copy && (isAlbum(result) || group.copies.length > 1) ? (
              <span className={`${styles.rowLinks} ${styles.wideOnly}`}>
                {isAlbum(result) ? (
                  <button
                    type="button"
                    className={styles.disclosure}
                    aria-expanded={tracksOpen}
                    onClick={() => toggle(setOpenTracks, rowKey)}
                  >
                    <ChevronIcon />
                    {tracksOpen ? 'Hide tracks' : 'Show tracks'}
                  </button>
                ) : null}
                {group.copies.length > 1 ? (
                  <button
                    type="button"
                    className={styles.disclosure}
                    aria-expanded={openCopies.has(group.key)}
                    onClick={() => toggle(setOpenCopies, group.key)}
                  >
                    <ChevronIcon />
                    {plural(group.copies.length - 1, 'other copy', 'other copies')}
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
          <span className={styles.cell}>{qualityLabel(result) || '—'}</span>
          <span className={styles.cellMeta}>
            {fileSize(isAlbum(result) ? result.total_size : result.size)}
          </span>
          <div className={styles.user}>
            <button
              type="button"
              className={`${styles.userName} chat-user-link`}
              data-chat-msg-user={result.username}
              title={`Shared by ${result.username}. Message them on Soulseek`}
            >
              {result.username}
            </button>
            <span className={styles.cellMeta}>{slotLine(result)}</span>
          </div>
          <div className={styles.actions}>
            <Button
              size="lg"
              variant={isPrimary ? 'primary' : 'default'}
              aria-label={`${actions.main}: ${name}`}
              data-row-action=""
              onClick={() => setTarget(mainTarget)}
            >
              {actions.main}
            </Button>
            {actions.all ? (
              <Button
                size="lg"
                variant="ghost"
                aria-label={`Download all: ${name}`}
                onClick={() => setTarget(whole)}
              >
                Download all
              </Button>
            ) : null}
          </div>
        </div>
        {tracksOpen && isAlbum(result) ? (
          <FolderTracks album={result} ownership={ownership} onDownload={setTarget} />
        ) : null}
      </Fragment>
    );
  };

  let body: React.ReactNode;
  if (state.status === 'error') {
    body = (
      <Notice
        tone="danger"
        role="alert"
        title={`Couldn’t search ${title}`}
        actions={
          <>
            <Button size="lg" onClick={retry}>
              Try again
            </Button>
            {isAdmin ? (
              <ButtonLink to="/setup-check" variant="ghost">
                Run Setup check
              </ButtonLink>
            ) : null}
          </>
        }
      >
        {state.error} Nothing was downloaded.
      </Notice>
    );
  } else if (searching && state.results.length === 0) {
    body = (
      <LoadingState label={`Asking ${title} users for files…`}>
        <div className={`${styles.card} ${styles.fileTable}`} aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div className={styles.skeletonRow} key={i}>
              <div className={styles.skeletonStack}>
                <Skeleton className={styles.skel} style={{ width: `${70 - i * 12}%` }} />
                <Skeleton className={styles.skel} style={{ width: `${45 - i * 6}%` }} />
              </div>
              <Skeleton className={styles.skel} />
              <Skeleton className={styles.skel} />
              <Skeleton className={styles.skel} />
              <Skeleton className={styles.skelButton} />
            </div>
          ))}
        </div>
      </LoadingState>
    );
  } else if (!state.results.length && state.status !== 'idle') {
    body = (
      <div className={styles.card}>
        <p className={styles.note}>
          {state.status === 'stopped'
            ? 'You stopped the search before anyone answered.'
            : `No one on ${title} is sharing anything that matches “${query}”. Try fewer words or another spelling.`}
        </p>
      </div>
    );
  } else if (!visible.length && state.results.length) {
    body = (
      <div className={styles.card}>
        <p className={styles.note}>
          {effective.quality === 'target'
            ? `Nothing ${searching ? 'yet ' : ''}at your target. `
            : `Nothing ${searching ? 'yet ' : ''}matches these filters. `}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() =>
              onFilters(
                effective.quality === 'target'
                  ? { quality: 'any' }
                  : { quality: 'any', albumsOnly: false, notInLibrary: false, format: 'all' },
              )
            }
          >
            {effective.quality === 'target' ? 'Show any quality' : 'Show everything'}
          </button>
        </p>
      </div>
    );
  } else if (visible.length) {
    const pair = shown.some((group) => rowActions(group, consequences.get(group.key)).all);
    body = (
      <div className={`${styles.card} ${styles.fileTable}`} data-pair={pair ? 'true' : undefined}>
        <div className={styles.tableHead} aria-hidden="true">
          <span>Folder or file</span>
          <span>Quality</span>
          <span>Size</span>
          <span>User</span>
          <span />
        </div>
        {shown.map((group) => (
          <div className={styles.group} key={group.key}>
            {renderRow(group, group.best, false)}
            {openCopies.has(group.key)
              ? group.copies.slice(1).map((copy) => renderRow(group, copy, true))
              : null}
          </div>
        ))}
        <div className={styles.cardFoot}>
          <span>
            {ofLine(shown.length, visible.length)}
            <span className={styles.wideOnly}> · grouped by folder, best copy of each first</span>
          </span>
          {visible.length > shown.length ? (
            <button type="button" className={styles.linkButton} onClick={() => setMore(true)}>
              <span className={styles.wideOnly}>
                Show all {visible.length.toLocaleString('en-GB')}
              </span>
              <span className={styles.phoneOnly}>Show all</span>
            </button>
          ) : more && visible.length > baseLimit ? (
            <button type="button" className={styles.linkButton} onClick={() => setMore(false)}>
              Show fewer
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <section
      className={styles.section}
      aria-labelledby="search-soulseek-title"
      id="search-soulseek"
    >
      <SectionHead id="search-soulseek-title" title={title} aside={aside} />
      {state.status !== 'error' && state.results.length ? (
        <div className={styles.filters} role="group" aria-label="Show" id="search-soulseek-filters">
          <span className={`${styles.filtersLabel} ${styles.wideOnly}`}>Show</span>
          <OptionButton
            selected={effective.quality === 'target'}
            disabled={!bar}
            title={bar ? undefined : 'Your quality target is still loading'}
            onClick={() => onFilters({ quality: 'target' })}
          >
            {targetFilterLabel(targetName)}
          </OptionButton>
          <OptionButton
            selected={effective.quality === 'any'}
            onClick={() => onFilters({ quality: 'any' })}
          >
            Any quality
          </OptionButton>
          <OptionButton
            selected={effective.albumsOnly}
            disabled={type === 'albums'}
            onClick={() => onFilters({ albumsOnly: !filters.albumsOnly })}
          >
            Whole albums
          </OptionButton>
          <OptionButton
            selected={filters.notInLibrary}
            onClick={() => onFilters({ notInLibrary: !filters.notInLibrary })}
          >
            Not in my library
          </OptionButton>
          <span className={styles.filtersEnd}>
            <Select
              size="lg"
              aria-label="Format"
              value={filters.format}
              onChange={(event) => onFilters({ format: event.target.value as FormatFilter })}
            >
              {FORMAT_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === 'all' ? 'Any format' : option.label}
                </option>
              ))}
            </Select>
            <Select
              size="lg"
              aria-label="Sort"
              value={filters.sort}
              onChange={(event) => onFilters({ sort: event.target.value as SortKey })}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {SORT_LABELS[option.value]}
                </option>
              ))}
            </Select>
            <button
              type="button"
              className={styles.orderButton}
              aria-pressed={filters.reversed}
              aria-label="Reverse the order"
              title="Reverse the order"
              onClick={() => onFilters({ reversed: !filters.reversed })}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M6 13l6 6 6-6" />
              </svg>
            </button>
          </span>
        </div>
      ) : null}
      {body}
      <DownloadChooser target={target} onClose={() => setTarget(null)} onChoose={choose} />
      <EnrichedModal target={enriched} onClose={() => setEnriched(null)} />
      <ManualModal target={manual} onClose={() => setManual(null)} />
    </section>
  );
}

/**
 * The download source before the query is submitted. Typing searches your
 * library and the metadata service as it settles; Soulseek waits for Enter
 * (or this button), so partial words never go out to the network.
 */
export function SoulseekPrompt({
  title,
  query,
  onSearch,
}: {
  title: string;
  query: string;
  onSearch: () => void;
}) {
  return (
    <section
      className={styles.section}
      aria-labelledby="search-soulseek-title"
      id="search-soulseek"
    >
      <SectionHead id="search-soulseek-title" title={title} />
      <div className={`${styles.card} ${styles.prompt}`} data-testid="soulseek-prompt">
        <p className={styles.note}>
          Press Enter to search {title} for “{query}”
        </p>
        <Button size="lg" onClick={onSearch}>
          Search {title}
        </Button>
      </div>
    </section>
  );
}

/** A folder's files, each downloadable on its own; the ones you have say so. */
function FolderTracks({
  album,
  ownership,
  onDownload,
}: {
  album: BasicAlbum;
  ownership: ReadonlyMap<string, { in_library?: boolean; in_wishlist?: boolean } | null>;
  onDownload: (target: DownloadTarget) => void;
}) {
  const tracks = album.tracks ?? [];
  const breaks = detectDiscBreaks(tracks);
  let disc = 1;
  return (
    <ul className={styles.tracks} aria-label={`Tracks in ${folderName(album)}`}>
      {breaks.size ? <li className={styles.disc}>Disc 1</li> : null}
      {tracks.map((track, index) => {
        const newDisc = breaks.has(index) ? ++disc : null;
        const answer = ownership.get(ownershipKey(track.title, track.artist || album.artist));
        const owned = Boolean(answer?.in_library);
        const title = track.title || `Track ${index + 1}`;
        return (
          <li key={`${track.filename}:${index}`} style={{ display: 'contents' }}>
            {newDisc ? <div className={styles.disc}>Disc {newDisc}</div> : null}
            <div className={styles.trackLine}>
              <span className={styles.trackNumber}>
                {String(track.track_number || index + 1).padStart(2, '0')}
              </span>
              <span className={styles.trackTitle} data-owned={owned ? 'true' : undefined}>
                {title}
                {owned ? ' · in your library' : answer?.in_wishlist ? ' · on your Wanted list' : ''}
              </span>
              <span className={styles.cellMeta}>{formatDuration(track.duration)}</span>
              <span className={styles.cellMeta}>{fileSize(track.size)}</span>
              <Button
                size="lg"
                variant="ghost"
                aria-label={`Download ${title}`}
                onClick={() => onDownload({ kind: 'albumTrack', album, trackIndex: index })}
              >
                Download
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
