import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button, TextInput } from '@/components/form';
import { Checkbox } from '@/components/form/form';
import { Notice, Skeleton, StatusTag } from '@/components/primitives';
import { AnalysisProgress, useAnalysis } from '@/features/dj/analysis-progress';
import { requestAnalysis, type AnalysisEntry } from '@/features/dj/analysis.api';
import { analyseTheseHint, analyseTheseWords, inLine } from '@/features/dj/analysis.format';
import { addTrackToPlaylist, playlistTrack, playTrackNext } from '@/features/dj/dj-actions';
import {
  DJ_PAGE_SIZE,
  DJ_QUERY_KEY,
  djBrowseInfiniteQueryOptions,
  djStatusQueryOptions,
  postDjJob,
  type DjTrack,
} from '@/features/dj/dj.api';
import {
  CAMELOT_KEYS,
  analysisLine,
  analysisProgress,
  bpmNumber,
  bpmTitle,
  filterCountLine,
  formatBpmRange,
  isCamelot,
  keyTitle,
  parseBpmRange,
} from '@/features/dj/dj.format';
import { EnergyMeter } from '@/features/dj/energy-meter';
import { KeyChip } from '@/features/dj/key-chip';
import { keyLongName } from '@/features/dj/key-colour';
import { usePlayingTrackId } from '@/features/dj/playing-track';
import { useSetTempo } from '@/features/dj/tempo';
import { trackMenu } from '@/features/dj/track-menu';
import { TraktorExportDialog } from '@/features/dj/traktor-export-dialog';
import { awayWords } from '@/features/drives/drives.format';
import { openAddToPlaylist } from '@/features/playlists/add-to-playlist';
import { openAddToMixSet } from '@/features/sets/add-to-mix-set';
import { readDraft, writeDraft } from '@/features/sets/draft-store';
import { newSetName } from '@/features/sets/sets.format';
import { StarButton, primeStars, useStar, useStarCount } from '@/features/stars/star-button';
import { starStore } from '@/features/stars/stars-store';
import { useProfile } from '@/platform/shell/route-controllers';

import type { LibrarySearch } from '../-library.types';
import type { Go } from './albums-page';

import { TRACK_SORTS, pick, type TrackSort } from '../-library.types';
import { ActionSheet, type SheetAction } from './action-sheet';
import hs from './history.module.css';
import ls from './library.module.css';
import { ChevronDown, FilterField, MoreIcon, MoreMenu, PlayIcon, plural } from './parts';
import { SelectionBar } from './selection-bar';
import styles from './tracks.module.css';

const SORT_LABELS: Record<TrackSort, string> = {
  bpm: 'BPM',
  key: 'Key',
  energy: 'Energy',
  title: 'Title',
  artist: 'Artist',
  recent: 'Recently added',
};

const ANALYSIS_PREFIX = 'BPM, key and energy: ';

/** Why a member can't set a shared track's BPM (the menus' second line). */
const SHARED_TEMPO_WORDS = 'Only an admin can change a shared track’s BPM';

function usePhone(): boolean {
  const query = '(max-width: 640px)';
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches),
  );
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const on = () => setPhone(list.matches);
    list.addEventListener?.('change', on);
    return () => list.removeEventListener?.('change', on);
  }, []);
  return phone;
}

/** "too long to analyse" -> "Too long to analyse", for the meta line. */
function sentenceCase(words: string): string {
  return words ? words[0].toUpperCase() + words.slice(1) : words;
}

function artistHref(track: DjTrack): string | null {
  return track.artist_id === null || track.artist_id === ''
    ? null
    : `/artist-detail/library/${encodeURIComponent(String(track.artist_id))}`;
}

/**
 * The "…" (24a's one order): Play next, Mixes well with…, Add to mix set…,
 * Add to playlist…, Double BPM, Halve BPM (Use the measured BPM after
 * either), Open artist, Open album; on a phone Star comes first (28d). A
 * starred track whose file is gone (the Starred filter) has only what still
 * makes sense.
 */
function moreEntries(
  track: DjTrack,
  {
    artist,
    album,
    away,
    anchor,
    phone,
    star,
    setTempo,
    canSetTempo,
  }: {
    artist: string | null;
    album: string | null;
    away?: { words: string };
    anchor: () => HTMLElement | null | undefined;
    phone: boolean;
    star: ReturnType<typeof useStar>;
    setTempo: ReturnType<typeof useSetTempo>;
    /** a member can't set a shared track's BPM: why, or null */
    canSetTempo: string | null;
  },
): SheetAction[] {
  const missing = Boolean(track.file_missing);
  return trackMenu(
    { id: track.id, title: track.title, artist: track.artist_name, fileMissing: missing },
    {
      phone,
      star,
      anchor,
      playNext: missing
        ? null
        : { onSelect: () => playTrackNext(track), disabled: Boolean(away), reason: away?.words },
      addToPlaylist: missing ? null : () => addTrackToPlaylist(track, anchor()),
      tempo: {
        bpm: track.dj?.bpm ?? null,
        overridden: track.dj?.bpm_source === 'override',
        blocked: canSetTempo,
        onSet: (action) => void setTempo([track.id], action),
      },
      artistHref: artist,
      albumHref: album,
    },
  );
}

function TrackRow({
  track,
  phone,
  playing,
  away,
  selecting = false,
  checked = false,
  onToggle,
  progress = null,
}: {
  track: DjTrack;
  /** in line or being worked out (analyse on demand): its bar and step */
  progress?: AnalysisEntry | null;
  phone: boolean;
  /** selection mode (21a): a checkbox takes the art's place */
  selecting?: boolean;
  checked?: boolean;
  onToggle?: () => void;
  /** what the player has loaded: the row takes a 10% accent wash (17a) */
  playing: boolean;
  /** While the library's drive is away (123): Play is disabled-neutral and
   *  described by the reason ("Music HD isn't connected", element `id`). */
  away?: { id: string; words: string };
}) {
  const dj = track.dj;
  const artist = artistHref(track);
  const album =
    artist && track.album_id !== null && track.album_id !== ''
      ? `${artist}?album=${encodeURIComponent(String(track.album_id))}`
      : null;
  const rowRef = useRef<HTMLLIElement>(null);
  const [failed, setFailed] = useState(false);
  const [sheet, setSheet] = useState(false);
  const star = useStar(track.id);
  const setTempo = useSetTempo();
  const { isAdmin } = useProfile();
  const missing = Boolean(track.file_missing);
  const entries = moreEntries(track, {
    artist,
    album,
    away,
    phone,
    star,
    setTempo,
    canSetTempo: track.shared && !isAdmin ? SHARED_TEMPO_WORDS : null,
    anchor: () => rowRef.current?.querySelector<HTMLElement>('[aria-label^="More for"]'),
  });
  const key = dj?.key ? (
    <KeyChip
      code={dj.key}
      uncertain={dj.key_uncertain}
      title={keyTitle(dj)}
      variant={phone ? 'text' : 'chip'}
    />
  ) : null;
  return (
    <li
      ref={rowRef}
      className={styles.row}
      data-track-row={track.id}
      data-star-row={track.id}
      data-file-missing={missing ? 'true' : undefined}
      data-playing={playing ? 'true' : undefined}
      data-selected={selecting && checked ? 'true' : undefined}
    >
      {selecting ? (
        <span className={styles.check}>
          <Checkbox
            checked={checked}
            aria-label={`Select ${track.title}`}
            onCheckedChange={() => onToggle?.()}
          />
        </span>
      ) : (
        <span className={hs.art} aria-hidden="true">
          {track.image_url && !failed ? (
            <img src={track.image_url} alt="" loading="lazy" onError={() => setFailed(true)} />
          ) : null}
        </span>
      )}
      <div className={`${hs.text} ${styles.text}`}>
        <span className={hs.title}>
          {track.title}
          {missing ? (
            <StatusTag tone="warning" className={styles.missingTag}>
              File missing
            </StatusTag>
          ) : null}
        </span>
        {phone ? (
          // 17c: "124 BPM · 8A · E7 · Tidewater", the key's text in its hue
          <span className={hs.meta}>
            {[
              dj?.bpm ? (
                <span key="bpm" className={styles.tabular}>
                  {bpmNumber(dj.bpm)} BPM
                </span>
              ) : null,
              key,
              dj?.energy ? (
                <span key="energy" title={`Energy ${dj.energy} of 10`}>
                  E{dj.energy}
                </span>
              ) : null,
              dj?.skipped ? sentenceCase(dj.skipped) : null,
              artist ? (
                <a key="artist" href={artist}>
                  {track.artist_name}
                </a>
              ) : (
                track.artist_name || 'Unknown artist'
              ),
            ]
              .filter(Boolean)
              .map((part, i) => (
                <span key={i}>
                  {i ? ' · ' : null}
                  {part}
                </span>
              ))}
          </span>
        ) : (
          <span className={hs.meta}>
            {artist ? (
              <a href={artist}>{track.artist_name}</a>
            ) : (
              track.artist_name || 'Unknown artist'
            )}
            {track.album_title ? (
              <> · {album ? <a href={album}>{track.album_title}</a> : track.album_title}</>
            ) : null}
            {dj?.skipped ? <> · {sentenceCase(dj.skipped)}</> : null}
          </span>
        )}
        {inLine(progress ?? undefined) ? (
          <AnalysisProgress
            entry={progress}
            block
            compact={phone}
            label={`Analysis of ${track.title}`}
          />
        ) : null}
      </div>
      {phone ? null : (
        <>
          <span className={styles.bpm} title={dj ? bpmTitle(dj) : undefined}>
            {dj?.bpm ? bpmNumber(dj.bpm) : <span className={styles.none}>–</span>}
          </span>
          <span className={styles.keyCell}>{key ?? <span className={styles.none}>–</span>}</span>
          <span className={styles.energyCell}>
            <EnergyMeter energy={dj?.energy} />
          </span>
        </>
      )}
      <span className={styles.starCell}>
        <StarButton id={track.id} title={track.title} />
      </span>
      <div className={styles.actions}>
        {/* 28d: the phone's row has the star and "…"; Play next is in the sheet */}
        {phone || missing ? null : (
          <button
            type="button"
            className={hs.play}
            aria-label={`Play ${track.title} next`}
            title={away ? undefined : 'Play next, after the current track'}
            aria-disabled={away ? 'true' : undefined}
            aria-describedby={away?.id}
            onClick={away ? undefined : () => playTrackNext(track)}
          >
            <PlayIcon />
          </button>
        )}
        {phone ? (
          <>
            <button
              type="button"
              className={hs.phoneMore}
              aria-label={`More for ${track.title}`}
              aria-haspopup="dialog"
              aria-expanded={sheet}
              onClick={() => setSheet(true)}
            >
              <MoreIcon />
            </button>
            {sheet ? (
              <ActionSheet
                label={`More for ${track.title}`}
                heading={[track.title, track.artist_name].filter(Boolean).join(' · ')}
                onClose={() => setSheet(false)}
                actions={entries}
              />
            ) : null}
          </>
        ) : (
          <MoreMenu
            className={styles.more}
            label={`More for ${track.title}`}
            entries={entries.map(({ key: k, label, onSelect, disabled, reason }) => ({
              key: k,
              label,
              onSelect,
              disabled,
              reason,
            }))}
          />
        )}
      </div>
    </li>
  );
}

function RowsSkeleton() {
  return (
    <ul className={hs.list} aria-hidden="true">
      {Array.from({ length: 6 }, (_v, i) => (
        <li key={i} className={styles.row}>
          <Skeleton className={hs.art} />
          <div className={hs.text}>
            <Skeleton className={hs.skeletonTitle} />
            <Skeleton className={hs.skeletonMeta} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** "BPM from [ ] to [ ]": applied a moment after typing stops, like the filter. */
function BpmRange({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const parsed = parseBpmRange(value);
  const [min, setMin] = useState(parsed.min === null ? '' : String(parsed.min));
  const [max, setMax] = useState(parsed.max === null ? '' : String(parsed.max));
  const committed = useRef(value);
  const minId = useId();
  const maxId = useId();
  useEffect(() => {
    if (value === committed.current) return;
    committed.current = value;
    const next = parseBpmRange(value);
    setMin(next.min === null ? '' : String(next.min));
    setMax(next.max === null ? '' : String(next.max));
  }, [value]);
  useEffect(() => {
    const read = (raw: string) => {
      const n = Number(raw);
      return raw.trim() && Number.isFinite(n) && n >= 20 && n <= 400
        ? Math.round(n * 10) / 10
        : null;
    };
    const next = formatBpmRange(read(min), read(max));
    if (next === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = next;
      onChange(next);
    }, 400);
    return () => clearTimeout(timer);
  }, [min, max, onChange]);
  return (
    <div className={styles.bpmRange} role="group" aria-labelledby={`${minId}-label`}>
      <span className={`${hs.rowLabel} ${styles.label}`} id={`${minId}-label`}>
        BPM
      </span>
      <label className={styles.srOnly} htmlFor={minId}>
        Lowest BPM
      </label>
      <TextInput
        id={minId}
        className={styles.bpmInput}
        inputMode="decimal"
        placeholder="From"
        value={min}
        onChange={(event) => setMin(event.target.value)}
      />
      <span className={styles.dash} aria-hidden="true">
        –
      </span>
      <label className={styles.srOnly} htmlFor={maxId}>
        Highest BPM
      </label>
      <TextInput
        id={maxId}
        className={styles.bpmInput}
        inputMode="decimal"
        placeholder="To"
        value={max}
        onChange={(event) => setMax(event.target.value)}
      />
    </div>
  );
}

/**
 * A native select drawn as 17a's button: what's picked shows (the key with
 * its chip, "Sort: BPM") with a chevron, and the select itself lies over it,
 * transparent, so the list, the keyboard and the screen reader are the
 * browser's own.
 */
function PickButton({
  id,
  label,
  value,
  onChange,
  options,
  shown,
  variant,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
  shown: ReactNode;
  variant: 'input' | 'ghost';
  className?: string;
}) {
  return (
    <span className={[styles.pick, className].filter(Boolean).join(' ')} data-variant={variant}>
      <span className={styles.pickShown} aria-hidden="true">
        {shown}
        <ChevronDown />
      </span>
      <select
        id={id}
        aria-label={label}
        className={styles.pickSelect}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}

const KEY_OPTIONS = [
  { value: '', label: 'Any key' },
  ...CAMELOT_KEYS.map((k) => ({ value: k.code, label: `${k.code} · ${keyLongName(k.name)}` })),
];

/**
 * Library → Tracks (/library?view=tracks; boards 17a, 17c): every track you
 * have with its BPM, key (Camelot, in the wheel's colour) and energy (a
 * number and a ten-step bar), filtered by a BPM range and a key, sorted by
 * BPM by default. The URL holds the range (`bpm=120-128`), the key
 * (`key=8A`, `8A:mix` with the keys that mix with it), the sort and the
 * filter text. "Mixes well with…" opens the shell's docked panel.
 */
export function TracksPage({
  search,
  go,
  awayDrive = null,
}: {
  search: LibrarySearch;
  go: Go;
  /** The library's drive while it's away (123): Play waits for it. */
  awayDrive?: string | null;
}) {
  const awayId = useId();
  const away = awayDrive ? { id: awayId, words: awayWords(awayDrive) } : undefined;
  const { profileId, isAdmin } = useProfile();
  const phone = usePhone();
  const queryClient = useQueryClient();
  const setTempo = useSetTempo();
  const playingId = usePlayingTrackId();
  const sort = pick(search.sort, TRACK_SORTS);
  const withMix = search.key.endsWith(':mix');
  const keyCode = withMix ? search.key.slice(0, -4) : search.key;
  const key = isCamelot(keyCode) ? keyCode : '';
  const { min, max } = parseBpmRange(search.bpm);
  const q = search.q.trim();
  const starredOnly = search.starred === '1';
  const starCount = useStarCount();
  const keyId = useId();
  const sortId = useId();
  // selection (21a): pick tracks for "Export to Traktor…"
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const stopSelecting = () => {
    setSelecting(false);
    setPicked([]);
  };
  const toggle = (id: string) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  useEffect(() => {
    if (!selecting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"]')) return;
      setSelecting(false);
      setPicked([]);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selecting]);

  const status = useQuery({ ...djStatusQueryOptions(), retry: false });
  const query = useInfiniteQuery(
    djBrowseInfiniteQueryOptions(profileId, {
      bpmMin: min,
      bpmMax: max,
      key: key ? `${key}${withMix ? ':mix' : ''}` : '',
      q,
      sort,
      starred: starredOnly,
    }),
  );
  const pages = query.data?.pages ?? [];
  const tracks = useMemo(() => pages.flatMap((p) => p.tracks), [pages]);
  // browse says each row's star, so the rows don't look it up again
  useEffect(() => primeStars(tracks), [tracks]);
  const total = pages[0]?.total ?? 0;
  const filtered = Boolean(q || key || min !== null || max !== null || starredOnly);
  // what the key filter covered, as the server read it ("8A, 7A, 9A or 8B")
  const keys = pages[0]?.keys ?? (key ? [key] : []);

  // analyse on demand: the rows in line or being worked out show their step
  const progressOf = useAnalysis(tracks.slice(0, 500).map((t) => t.id));
  const analysePicked = () => {
    void requestAnalysis(picked.slice(0, 500), { force: true })
      .then((answer) => {
        if (!answer) return;
        const said = analyseTheseWords(answer);
        window.showToast?.(said.words, said.tone);
      })
      .catch((error: unknown) =>
        window.showToast?.(error instanceof Error ? error.message : "That didn't work.", 'error'),
      );
  };

  // a running analysis fills rows in: refresh the list when it moves on
  const done = status.data?.job?.status === 'running' ? status.data.job.done : null;
  useEffect(() => {
    if (done !== null && done > 0 && done % 25 === 0) {
      void queryClient.invalidateQueries({ queryKey: [...DJ_QUERY_KEY, 'browse'] });
    }
  }, [done, queryClient]);

  const job = useMutation({
    mutationFn: (action: 'start' | 'stop') => postDjJob(action),
    onError: (error: Error) => window.showToast?.(error.message, 'error'),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [...DJ_QUERY_KEY, 'status'] }),
  });

  const s = status.data;
  const running = s?.job?.status === 'running';
  const fullLine = s ? analysisLine(s) : '';
  // 17c: the phone drops the bar and the line's lead-in
  const line =
    phone && fullLine.startsWith(ANALYSIS_PREFIX)
      ? fullLine.slice(ANALYSIS_PREFIX.length)
      : fullLine;
  // 153: the 120px bar counts what's done, beside the words
  const progress = s && !phone ? analysisProgress(s) : null;
  const clearFilters = () => go({ q: '', bpm: '', key: '', starred: '' });
  // a member's picks all in the shared library: nothing they can set
  const pickedAllShared =
    !isAdmin &&
    picked.length > 0 &&
    tracks.filter((t) => picked.includes(t.id)).every((t) => t.shared);
  const pickedTracks = () => {
    const byId = new Map(tracks.map((t) => [t.id, t]));
    return picked.map((id) => byId.get(id)).filter((t): t is DjTrack => Boolean(t));
  };
  // 28b: the selection bar's primary
  const addPickedToMixSet = (anchor: HTMLElement | null) =>
    openAddToMixSet(
      pickedTracks().map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist_name,
        fileMissing: Boolean(t.file_missing),
      })),
      anchor,
    );
  const starAll = async () => {
    const ids = pickedTracks()
      .filter((t) => !t.file_missing)
      .map((t) => t.id);
    const n = await starStore().starMany(ids);
    if (n) window.showToast?.(`Starred ${plural(n, 'track')}`, 'success');
  };
  // 232: the selection's "…" starts a set (Library → Sets' draft) with them, in the order picked
  const startSet = () => {
    if (
      readDraft(profileId) &&
      !window.confirm('Start a new set? The draft you have in this browser is replaced.')
    )
      return;
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const rows = picked
      .map((id) => byId.get(id))
      .filter((t): t is DjTrack => Boolean(t))
      .map((t) => ({
        track_id: t.id,
        artist: t.artist_name,
        title: t.title,
        state: 'owned' as const,
        want: 'yours' as const,
      }));
    writeDraft(profileId, { name: newSetName(), kind: 'hand', rows });
    go({ view: 'sets', set: 'draft', q: '', bpm: '', key: '', sort: '' });
  };

  const keyPick = (
    <PickButton
      id={keyId}
      label="Key"
      variant="input"
      className={styles.keyPick}
      value={key}
      onChange={(next) => go({ key: next ? `${next}${withMix ? ':mix' : ''}` : '' })}
      options={KEY_OPTIONS}
      shown={
        key ? (
          <>
            <KeyChip code={key} />
            <span>{keyLongName(CAMELOT_KEYS.find((k) => k.code === key)?.name ?? '')}</span>
          </>
        ) : (
          <span>Any key</span>
        )
      }
    />
  );

  return (
    <div className={`${hs.page} ${styles.page}`}>
      <header className={`${hs.header} ${styles.header}`}>
        <div className={`${hs.headText} ${styles.headText}`}>
          <h1 className={hs.heading}>Tracks</h1>
          <p className={hs.subtitle}>
            Every track in your library, with its tempo, key and energy.
          </p>
        </div>
        <div className={`${hs.headActions} ${styles.filter}`}>
          <FilterField
            value={search.q}
            onChange={(next) => go({ q: next }, { replace: true })}
            placeholder="Filter by title or artist"
            phonePlaceholder="Title or artist"
            label="Filter your tracks"
          />
          {tracks.length ? (
            <button
              type="button"
              className={`${ls.selectToggle} ${styles.selectToggle}`}
              aria-pressed={selecting}
              onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
            >
              {selecting ? 'Done' : 'Select'}
            </button>
          ) : null}
        </div>
      </header>

      {line ? (
        <div className={styles.analysis}>
          {progress ? (
            <span
              className={styles.analysisBar}
              role="progressbar"
              aria-label="BPM, key and energy worked out"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
            >
              <span style={{ width: `${(100 * progress.done) / progress.total}%` }} />
            </span>
          ) : null}
          <span className={styles.analysisWords} aria-live="polite">
            {line}
          </span>
          {s?.can_stop && running ? (
            <button
              type="button"
              className={styles.textButton}
              disabled={job.isPending}
              onClick={() => job.mutate('stop')}
            >
              Stop
            </button>
          ) : s?.can_start && !running && s.counts.pending > 0 && s.settings.analyze ? (
            <button
              type="button"
              className={styles.textButton}
              disabled={job.isPending}
              onClick={() => job.mutate('start')}
            >
              Start now
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={styles.toolbar}>
        {/* 24a: Starred is a filter here, with its count, not a page of its own */}
        <button
          type="button"
          className={`${hs.chip} ${styles.starredChip}`}
          aria-pressed={starredOnly}
          onClick={() => go({ starred: starredOnly ? '' : '1' })}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.starredIcon}>
            <path d="M12 3.2l2.63 5.33 5.88.86-4.26 4.15 1.01 5.86L12 16.63 6.74 19.4l1.01-5.86L3.49 9.39l5.88-.86L12 3.2z" />
          </svg>
          Starred
          {starCount !== null ? (
            <span className={styles.starredCount}>{starCount.toLocaleString()}</span>
          ) : null}
        </button>
        <BpmRange value={search.bpm} onChange={(next) => go({ bpm: next }, { replace: true })} />
        <div className={styles.keyGroup}>
          <label className={`${hs.rowLabel} ${styles.label} ${styles.keyLabel}`} htmlFor={keyId}>
            Key
          </label>
          {keyPick}
          {key ? (
            <button
              type="button"
              className={`${hs.chip} ${styles.mixChip}`}
              aria-pressed={withMix}
              onClick={() => go({ key: `${key}${withMix ? '' : ':mix'}` })}
            >
              And keys that mix
            </button>
          ) : null}
        </div>
        <PickButton
          id={sortId}
          label="Sort"
          variant="ghost"
          className={styles.sort}
          value={sort}
          onChange={(next) => go({ sort: next === 'bpm' ? '' : next }, { replace: true })}
          options={TRACK_SORTS.map((k) => ({ value: k, label: SORT_LABELS[k] }))}
          shown={<span>Sort: {SORT_LABELS[sort]}</span>}
        />
      </div>

      {filtered && !query.isPending && !query.isError && tracks.length ? (
        <p className={styles.countLine} aria-live="polite">
          {filterCountLine({ total, bpmMin: min, bpmMax: max, keys, q, starred: starredOnly })} ·{' '}
          <button type="button" className={styles.linkButton} onClick={clearFilters}>
            Clear filters
          </button>
        </p>
      ) : null}

      {query.isError ? (
        <>
          <Notice
            tone="danger"
            role="alert"
            title="Couldn't load your tracks"
            actions={
              <Button size="lg" variant="secondary" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          >
            SYNCHRO.S couldn&apos;t read your library just now. Nothing is lost; this is a display
            problem.
          </Notice>
          <div className={hs.faded}>
            <RowsSkeleton />
          </div>
        </>
      ) : query.isPending ? (
        <RowsSkeleton />
      ) : tracks.length ? (
        <div className={styles.listWrap}>
          {phone ? null : (
            <div className={styles.head} aria-hidden="true">
              <span />
              <span>Track</span>
              <span className={styles.headBpm}>BPM</span>
              <span>Key</span>
              <span>Energy</span>
              <span />
              <span />
            </div>
          )}
          {away ? (
            <span id={away.id} className={styles.srOnly}>
              {away.words}
            </span>
          ) : null}
          <ul className={`${hs.list} ${styles.list}`} aria-label="Your tracks">
            {tracks.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                phone={phone}
                playing={track.id === playingId}
                away={away}
                selecting={selecting}
                checked={selecting && picked.includes(track.id)}
                onToggle={() => toggle(track.id)}
                progress={progressOf[track.id] ?? null}
              />
            ))}
          </ul>
        </div>
      ) : (
        <div className={hs.empty}>
          <h2>
            {starredOnly && !(q || key || min !== null || max !== null)
              ? 'No starred tracks yet'
              : filtered
                ? 'No tracks match these filters'
                : 'No tracks with a file in your library yet'}
          </h2>
          {starredOnly && !(q || key || min !== null || max !== null) ? (
            <p className={hs.subtitle}>
              Star a track from its row, the player or with S while it plays.
            </p>
          ) : null}
          {filtered ? (
            <div className={hs.emptyActions}>
              <Button size="lg" variant="secondary" onClick={clearFilters}>
                Clear the filters
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {tracks.length ? (
        <div className={hs.footer}>
          <span>
            {tracks.length.toLocaleString()} of {plural(total, 'track')}
          </span>
          {query.hasNextPage ? (
            <Button
              size="lg"
              variant="secondary"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage
                ? 'Loading…'
                : `Show ${Math.min(DJ_PAGE_SIZE, total - tracks.length)} more`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {selecting ? (
        <SelectionBar
          barLabel="Selected tracks"
          label={`${plural(picked.length, 'track')} selected`}
          shortLabel={plural(picked.length, 'track')}
          count={picked.length}
          primaryLabel="Add to mix set…"
          idleLabel="Add to mix set…"
          emptyReason="Tick tracks to select them"
          secondary={{ label: 'Export to Traktor…', onClick: () => setExporting(true) }}
          selectAll={
            picked.length < tracks.length
              ? {
                  label: `Select all ${tracks.length.toLocaleString()} shown`,
                  onClick: () => setPicked(tracks.map((t) => t.id)),
                }
              : null
          }
          onPrimary={(anchor) => addPickedToMixSet(anchor)}
          // 28b: Star all; 232: Add to playlist…, Start a set from these
          // (Library → Sets' draft), then Clear the selection; Double and
          // Halve BPM after Add to playlist… (HANDOFF 344)
          menu={[
            ...(phone
              ? [
                  {
                    key: 'traktor',
                    label: 'Export to Traktor…',
                    disabled: !picked.length,
                    onSelect: () => setExporting(true),
                  },
                ]
              : []),
            {
              key: 'star',
              label: 'Star all',
              disabled: !picked.length,
              onSelect: () => void starAll(),
            },
            {
              key: 'playlist',
              label: 'Add to playlist…',
              disabled: !picked.length,
              onSelect: () =>
                openAddToPlaylist(
                  tracks.filter((t) => picked.includes(t.id)).map(playlistTrack),
                  null,
                ),
            },
            // the picked tracks' BPM at double or half (a half-time read)
            {
              key: 'double',
              label: 'Double BPM',
              disabled: !picked.length || pickedAllShared,
              reason: pickedAllShared ? SHARED_TEMPO_WORDS : undefined,
              onSelect: () => void setTempo(picked, 'double'),
            },
            {
              key: 'halve',
              label: 'Halve BPM',
              disabled: !picked.length || pickedAllShared,
              reason: pickedAllShared ? SHARED_TEMPO_WORDS : undefined,
              onSelect: () => void setTempo(picked, 'halve'),
            },
            {
              key: 'set',
              label: 'Start a set from these',
              disabled: !picked.length,
              onSelect: () => startSet(),
            },
            {
              key: 'analyse',
              label: 'Analyse these',
              disabled: !picked.length,
              reason: picked.length
                ? analyseTheseHint(Math.min(picked.length, 500))
                : 'Tick tracks to select them',
              onSelect: () => analysePicked(),
            },
            {
              key: 'clear',
              label: 'Clear the selection',
              disabled: !picked.length,
              onSelect: () => setPicked([]),
            },
          ]}
          onDone={stopSelecting}
        />
      ) : null}
      {exporting && picked.length ? (
        <TraktorExportDialog
          from={{ source: 'tracks', track_ids: picked }}
          onClose={() => setExporting(false)}
        />
      ) : null}
    </div>
  );
}
