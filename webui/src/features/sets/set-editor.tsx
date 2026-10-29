/**
 * The set itself (22c, 22d, 22e without the AI's parts): the name, the meta
 * line, Export to Traktor… and Save as a set, the energy graph, then the rows
 * with the step between each pair (Smooth / Jump / Not known yet and why, in
 * the Mixes panel's words, worked out by the server's Camelot rules). Lock
 * per row; reorder by the grip, or Move up / Move down / Move… from the "…"
 * (the keyboard's way and the phone's); Swap in the docked panel or the
 * phone's sheet. A draft lives in this browser; a saved set saves as it's
 * changed, and its playlist follows.
 */
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';

import type { DjBrowseResponse, DjTrack } from '@/features/dj/dj.api';

import { apiClient, readJson } from '@/app/api-client';
import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button, TextInput } from '@/components/form';
import { Notice, Skeleton, StatusTag } from '@/components/primitives';
import { AutoMixOffLine } from '@/features/automix/between-tracks';
import { SetStepChip } from '@/features/automix/set-chip';
import { playSet, playSetAsMix } from '@/features/automix/set-play';
import {
  AnalysisLine,
  useAnalysis,
  useAnalysisViewer,
  useAutoAnalyse,
} from '@/features/dj/analysis-line';
import { requestAnalysis, type AnalysisEntry } from '@/features/dj/analysis.api';
import {
  analyseTheseHint,
  analyseTheseWords,
  isReady,
  notReadyNotice,
} from '@/features/dj/analysis.format';
import { addTrackToPlaylist, playTrackNext } from '@/features/dj/dj-actions';
import { bpmNumber, keyTitle } from '@/features/dj/dj.format';
import { KeyChip } from '@/features/dj/key-chip';
import { usePlayingTrack } from '@/features/dj/playing-track';
import { PlayGlyph, RowPlay, rowPlayHandlers } from '@/features/dj/row-play';
import { trackMenu } from '@/features/dj/track-menu';
import { TraktorExportDialog } from '@/features/dj/traktor-export-dialog';
import { playingRowIndex } from '@/features/mix/mix-model';
import { useQueueFrom } from '@/features/mix/mix-subject';
import { StarButton } from '@/features/stars/star-button';
import { useProfile } from '@/platform/shell/route-controllers';
import { appURL } from '@/platform/url-base';
import { MoreMenu } from '@/routes/library/-ui/parts';

import type { Draft } from './draft-store';
import type { SetRow, SetView, Step, Transition, ViewRow } from './sets.api';

import { clearDraft, readDraft, writeDraft } from './draft-store';
import { EnergyGraph } from './energy-graph';
import { NoteLine } from './mix-set-parts';
import {
  RemoveSetDialog,
  WorkingSetToggle,
  afterSetRemoved,
  chooseWorking,
  duplicateSet,
  useIsWorking,
} from './set-actions';
import {
  MIX_SET_CHANGED,
  SETS_QUERY_KEY,
  StaleSaveError,
  addToWanted,
  createSet,
  deleteSet,
  postView,
  rowsBody,
  setPlaylist,
  updateSet,
} from './sets.api';
import {
  haveLine,
  metaLine,
  metaLineShort,
  missingWords,
  unsavedWords,
  moveRow,
  safeSourceLink,
  sourceLine,
  wantLabel,
} from './sets.format';
import styles from './sets.module.css';
import { SwapPanel, TrackSheet, trackMeta } from './swap-panel';
import { undoMove, undoRemove, undoSwap } from './undo-rows';

/** what a swap changes, so its Undo puts exactly those back */
const SWAP_FIELDS = ['track_id', 'artist', 'title', 'state', 'version', 'want'] as const;

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

/** The cut a library title names ("Signal Fire (Original Mix)" -> null). */
export function versionOf(title: string): string | null {
  const m = /\(([^)]*)\)\s*$/.exec(title) ?? /\s[-–]\s(.+)$/.exec(title);
  const v = m?.[1]?.trim() ?? '';
  return !v || /^original( mix| version)?$/i.test(v) ? null : v;
}

function openPlaylist(id: number): void {
  const open = (window as unknown as { openMirroredPlaylistModal?: (id: number) => unknown })
    .openMirroredPlaylistModal;
  if (open) void open(id);
  else window.location.assign('/sync');
}

function clock(ms: number | null | undefined): string {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const STEP_WORDS: Record<Step['kind'], string> = {
  smooth: 'Smooth',
  jump: 'Jump',
  unknown: 'Not known yet',
};

function StepLine({
  step,
  short = false,
  chip = null,
}: {
  step: Step;
  short?: boolean;
  /** 26i: the transition chip at the line's end (28e), or first on a phone (28f) */
  chip?: ReactNode;
}) {
  return (
    <div className={styles.step} data-step={step.kind} data-chip={chip ? '' : undefined}>
      {short && chip ? chip : null}
      <i aria-hidden="true" />
      <span className={styles.stepWord}>{STEP_WORDS[step.kind]}</span>
      <span className={styles.stepWhy}>
        {short ? ' · ' : ' '}
        {step.reason}
      </span>
      {!short && chip ? chip : null}
    </div>
  );
}

/** Under a File missing row (28e): playing skips it, and the step goes around it. */
function SkippedLine() {
  return (
    <div className={styles.step} data-step="skipped">
      <i aria-hidden="true" />
      <span className={styles.stepWord}>Skipped</span>
      <span className={styles.stepWhy}>
        {' '}
        when played: the step goes from the track before to the one after
      </span>
    </div>
  );
}

/**
 * A set's analysis line (31a state 11, 31b): the track being analysed and
 * how many of the set's own are left ("Analysing Canopy · beat grid (5 of
 * 6) · 11 more in this set"), or "3 tracks aren't ready to mix", with
 * "Analyse all 12" (an admin's) or "Analyse mine" (a member's); a ready set
 * says so quietly.
 */
function SetAnalysisLine({
  ids,
  progressOf,
  titleOf,
  setId,
}: {
  ids: string[];
  progressOf: Record<string, AnalysisEntry>;
  titleOf: Map<string, string>;
  setId: number | null;
}) {
  const viewer = useAnalysisViewer();
  const known = ids.filter((id) => progressOf[id]);
  if (!known.length) return null;
  const notReady = known.filter((id) => !isReady(progressOf[id]));
  const working = notReady.find((id) => progressOf[id]?.state === 'working') ?? null;
  // what an ask can move on: not being analysed now; a "can't be
  // beat-matched" only by an admin, whose ask finds its grid again (Ross's
  // report of 28 October), as it tries a failed one again
  const askable = notReady.filter((id) => {
    const e = progressOf[id]!;
    if (e.state === 'working') return false;
    if (e.state === 'done') return viewer.admin && e.beat !== 'too_short';
    if (e.state === 'failed') return viewer.admin && e.reason !== 'too_long';
    return true;
  });
  const ask = () => {
    void requestAnalysis(askable, {
      force: true,
      reason: 'asked',
      source: 'set',
      setId,
      retry: viewer.admin && askable.some((id) => progressOf[id]?.state === 'failed'),
      again: viewer.admin && askable.some((id) => progressOf[id]?.state === 'done'),
    }).catch((error: unknown) =>
      window.showToast?.(error instanceof Error ? error.message : "That didn't work.", 'error'),
    );
  };
  // "Analyse all N" counts what the ask takes, not the one being analysed
  // nor a settled can't (review L11); only failed ones left: Try again
  const retryOnly = askable.every((id) => progressOf[id]?.state === 'failed');
  const againOnly = askable.every((id) => progressOf[id]?.state === 'done');
  const action = askable.length
    ? {
        label: viewer.admin
          ? againOnly
            ? 'Analyse again'
            : retryOnly
              ? 'Try again'
              : working
                ? `Analyse all ${askable.length.toLocaleString()}`
                : 'Analyse them now'
          : 'Analyse mine',
        onClick: ask,
      }
    : false;
  if (working) {
    const rest = notReady.length - 1;
    return (
      <AnalysisLine
        size="line"
        entry={progressOf[working]}
        title={titleOf.get(working) ?? null}
        trackId={working}
        extra={rest ? `${rest.toLocaleString()} more in this set` : null}
        action={action}
        className={styles.setAnalysis}
      />
    );
  }
  if (!notReady.length)
    return (
      <AnalysisLine
        size="line"
        entry={null}
        sentence={`Ready to mix · all ${known.length.toLocaleString()} ${known.length === 1 ? 'track' : 'tracks'}`}
        tone="ready"
        action={false}
        className={styles.setAnalysis}
      />
    );
  const n = notReady.length;
  return (
    <AnalysisLine
      size="line"
      entry={null}
      sentence={`${n.toLocaleString()} ${n === 1 ? "track isn't" : "tracks aren't"} ready to mix`}
      tone="neutral"
      action={action}
      className={styles.setAnalysis}
    />
  );
}

/** 31b's warning Notice: what isn't ready, by kind. */
function SetNotReadyNotice({
  ids,
  progressOf,
}: {
  ids: string[];
  progressOf: Record<string, AnalysisEntry>;
}) {
  const words = notReadyNotice(ids.map((id) => progressOf[id]));
  if (!words) return null;
  return (
    <Notice tone="warning" className={styles.notReady} data-set-not-ready="">
      {words}
    </Notice>
  );
}

/** Not analysed yet (28e): its values read "—" and its steps Not known yet. */
export function beingWorkedOut(track: DjTrack | null | undefined): boolean {
  const dj = track?.dj;
  if (!track) return false;
  if (!dj) return true;
  return !dj.analyzed && !dj.skipped && !dj.bpm && !dj.key;
}

/* ── icons ─────────────────────────────────────────────────────────────── */

function Grip() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {[6, 12, 18].map((y) => (
        <g key={y}>
          <circle cx="9" cy={y} r="1.6" />
          <circle cx="15" cy={y} r="1.6" />
        </g>
      ))}
    </svg>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d={locked ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 7.5-2'} />
    </svg>
  );
}

/* ── Move… ─────────────────────────────────────────────────────────────── */

/**
 * Move… (UX-30): the places by their neighbour, "To the top" and "After
 * Night Ferry", not a bare number; the current place is marked and chosen.
 */
function MoveDialog({
  title,
  from,
  titles,
  onMove,
  onClose,
}: {
  title: string;
  from: number;
  /** every row's title, in order */
  titles: string[];
  onMove: (to: number) => void;
  onClose: () => void;
}) {
  const name = useId();
  const [to, setTo] = useState(from);
  // where each choice puts the row: the top, or straight after another row
  const places = [
    { key: 'top', label: 'To the top', to: 0 },
    ...titles.flatMap((t, k) =>
      k === from
        ? []
        : [
            {
              key: `after-${k}`,
              label: `After ${t || 'an unnamed line'}`,
              to: k < from ? k + 1 : k,
            },
          ],
    ),
  ].filter((p, k, all) => all.findIndex((q) => q.to === p.to) === k || p.key === 'top');
  return (
    <DialogFrame
      open
      onOpenChange={(open) => (open ? null : onClose())}
      className={styles.moveDialog}
    >
      <DialogHeader title={`Move ${title}`} closeLabel="Close" />
      <DialogBody>
        <fieldset className={styles.movePlaces}>
          <legend className={styles.moveLabel}>Where it goes</legend>
          {places.map((p) => (
            <label key={p.key} className={styles.movePlace}>
              <input
                type="radio"
                name={name}
                checked={to === p.to}
                onChange={() => setTo(p.to)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onMove(p.to);
                }}
              />
              <span>{p.label}</span>
              {p.to === from ? <span className={styles.moveHere}>its place now</span> : null}
            </label>
          ))}
        </fieldset>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={to === from}
          disabledReason={to === from ? 'Choose another place' : undefined}
          onClick={() => onMove(to)}
        >
          Move here
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}

/* ── Add a track (a set built by hand) ─────────────────────────────────── */

function AddTracks({
  profileId,
  have,
  onAdd,
}: {
  profileId: number;
  have: Set<string>;
  onAdd: (track: DjTrack) => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const query = useQuery({
    queryKey: [...SETS_QUERY_KEY, 'add', profileId, q],
    queryFn: async () =>
      (
        await readJson<DjBrowseResponse>(
          apiClient.get('library/dj/browse', { searchParams: { q, sort: 'title', limit: 8 } }),
        )
      ).tracks,
    enabled: q.length > 1,
    retry: false,
  });
  const found = (query.data ?? []).filter((t) => !have.has(t.id));
  return (
    <div className={styles.addTracks}>
      <label className={styles.addLabel} htmlFor={id}>
        Add a track
      </label>
      <TextInput
        id={id}
        value={text}
        placeholder="Title or artist from your library"
        onChange={(event) => setText(event.target.value)}
      />
      {q.length > 1 && found.length ? (
        <ul className={styles.addList} aria-label="Tracks to add">
          {found.map((track) => (
            <li key={track.id} className={styles.addRow}>
              <span className={styles.swapText}>
                <span className={styles.swapTitle}>{track.title}</span>
                <span className={styles.swapMeta}>{trackMeta(track)}</span>
              </span>
              <Button
                size="lg"
                variant="secondary"
                aria-label={`Add ${track.title}`}
                onClick={() => {
                  onAdd(track);
                  setText('');
                }}
              >
                Add
              </Button>
            </li>
          ))}
        </ul>
      ) : q.length > 1 && !query.isFetching ? (
        <p className={styles.stateLine}>Nothing in your library matches “{q}”.</p>
      ) : null}
    </div>
  );
}

/* ── one row ───────────────────────────────────────────────────────────── */

function Row({
  row,
  index,
  number,
  count,
  phone,
  swapping,
  onLock,
  onSwap,
  onMore,
  onMove,
  onMoveTo,
  onRemove,
  onWant,
  onNote,
  onTransition,
  nextTitle,
  nextId,
  setName,
  drag,
  step,
  progress = null,
  playing = false,
  onPlay = null,
}: {
  step: Step | null;
  /** the row the player is on (the queue came from this set, 294): a green ▶ for its number (33c) */
  playing?: boolean;
  /** Play (34b): the set from this row */
  onPlay?: (() => void) | null;
  /** where its track is in the analysis (analyse on demand) */
  progress?: AnalysisEntry | null;
  row: ViewRow;
  index: number;
  /** its number in the set (a track whose file is missing keeps one), or null */
  number: number | null;
  count: number;
  phone: boolean;
  swapping: boolean;
  onLock: () => void;
  onSwap: () => void;
  onMore: () => void;
  onMove: () => void;
  onMoveTo: (to: number) => void;
  onRemove: () => void;
  onWant: (want: 'yours' | 'wanted') => void;
  onNote: (note: string | null) => void;
  onTransition: (next: Transition) => void;
  /** the next playing track's title, for the chip's words */
  nextTitle: string;
  /** and its id, for the pair's plan (26i) */
  nextId: string | null;
  setName: string;
  drag: {
    onGrip: () => void;
    onDragStart: (event: DragEvent) => void;
    onDragOver: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
    onDragEnd: () => void;
    armed: boolean;
    over: boolean;
  };
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const track = row.track;
  // 28e: a file gone missing keeps its place, its star and its values
  const gone = !track && row.unreachable ? (row.gone_track ?? null) : null;
  const shown = track ?? gone;
  const dj = shown?.dj;
  const title = shown?.title ?? row.title ?? '';
  const artist = shown?.artist_name ?? row.artist ?? '';
  const missing = !track && Boolean(row.unreachable);
  const working = beingWorkedOut(track);
  const starId = track?.id ?? (missing ? row.track_id : null);
  // a locked row holds its place: its moves are there, disabled
  const held = Boolean(row.locked);
  const moves = [
    ...(index > 0
      ? [{ key: 'up', label: 'Move up', onSelect: () => onMoveTo(index - 1), disabled: held }]
      : []),
    ...(index < count - 1
      ? [{ key: 'down', label: 'Move down', onSelect: () => onMoveTo(index + 1), disabled: held }]
      : []),
    {
      key: 'move',
      label: held ? 'Move… (unlock it first)' : 'Move…',
      onSelect: onMove,
      disabled: held,
    },
  ];
  const isAdmin = Boolean(useProfile().isAdmin);
  const entries = [
    // 28e: a missing file's "…" leads with Find it again and Add to Wanted
    ...(missing
      ? [
          {
            key: 'find',
            label: 'Find it again',
            onSelect: () => void findAgain(),
            disabled: !isAdmin,
            reason: isAdmin ? undefined : 'An admin rescans the library',
          },
          {
            key: 'wanted',
            label: 'Add to Wanted',
            onSelect: () => void wantIt({ artist, title }, setName),
          },
        ]
      : []),
    // 24a's one order for a track, then the set's own
    ...(track
      ? trackMenu(
          { id: track.id, title: track.title, artist: track.artist_name },
          {
            playNext: { onSelect: () => playTrackNext(track) },
            anchor: () => rowRef.current?.querySelector<HTMLElement>('[aria-label^="More for"]'),
            addToPlaylist: () =>
              addTrackToPlaylist(
                track,
                rowRef.current?.querySelector<HTMLElement>('[aria-label^="More for"]'),
              ),
          },
        )
      : []),
    ...moves,
    { key: 'remove', label: 'Remove from set', onSelect: onRemove },
  ];
  const second =
    row.state === 'version' && track
      ? row.want === 'wanted'
        ? `Wanted: ${wantLabel(row.version).replace(/^Want /, '')} · yours plays until it arrives`
        : haveLine(versionOf(track.title))
      : null;
  const chip =
    track && step && step.kind !== 'unknown' ? (
      <SetStepChip
        transition={row.transition}
        step={step}
        from={title}
        to={nextTitle}
        fromId={track.id ? String(track.id) : null}
        toId={nextId}
        onChange={onTransition}
      />
    ) : null;
  return (
    <li
      ref={rowRef}
      className={styles.rowItem}
      data-set-row={index}
      data-state={track ? 'playing' : missing ? 'gone' : row.state}
      data-star-row={starId ?? undefined}
      data-has-values={shown ? '' : undefined}
      data-swapping={swapping ? 'true' : undefined}
      data-drag-over={drag.over ? 'true' : undefined}
      data-locked={held ? 'true' : undefined}
      data-playing={playing ? 'true' : undefined}
      data-row-play-host=""
      {...rowPlayHandlers(phone ? null : onPlay, playing)}
      draggable={drag.armed}
      onDragStart={drag.onDragStart}
      onDragOver={drag.onDragOver}
      onDrop={drag.onDrop}
      onDragEnd={drag.onDragEnd}
    >
      <div className={styles.row}>
        {phone ? null : (
          <span
            className={styles.grip}
            aria-hidden="true"
            title={held ? 'Locked in its place' : 'Drag to reorder'}
            onPointerDown={drag.onGrip}
          >
            <Grip />
          </span>
        )}
        <span className={styles.num}>
          {playing ? (
            <span className={styles.numPlaying} role="img" aria-label={`Playing, #${number ?? ''}`}>
              <PlayGlyph size={16} />
            </span>
          ) : (
            (number ?? '')
          )}
        </span>
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>
            {title}
            {missing ? (
              <StatusTag tone="warning" className={styles.rowTitleTag}>
                File missing
              </StatusTag>
            ) : working && !progress ? (
              <StatusTag tone="info" className={styles.rowTitleTag}>
                Being worked out
              </StatusTag>
            ) : null}
          </span>
          {phone && shown ? (
            <span className={styles.rowMeta}>{trackMeta(shown as DjTrack)}</span>
          ) : (
            <span className={styles.rowMeta}>
              {shown
                ? artist
                : row.state === 'id'
                  ? 'Not identified in the tracklist'
                  : row.unreachable
                    ? `${artist ? `${artist} · ` : ''}Its file isn't on this computer; playing skips it`
                    : `${artist ? `${artist} · ` : ''}Not in your library`}
              {second ? ` · ${second}` : ''}
            </span>
          )}
          {/* the row's marker (31b): Ready, In line · 1st, the bar while it's analysed */}
          {track ? (
            <AnalysisLine size="marker" entry={progress} showReady className={styles.rowMarker} />
          ) : null}
          {shown ? <NoteLine note={row.note} title={title} onSave={onNote} /> : null}
        </span>
        {phone || !shown ? null : (
          <>
            <span className={styles.bpm}>{dj?.bpm ? bpmNumber(dj.bpm) : '—'}</span>
            <span className={styles.keyCell}>
              {dj?.key ? (
                <KeyChip code={dj.key} uncertain={dj.key_uncertain} title={keyTitle(dj)} />
              ) : (
                '—'
              )}
            </span>
            <span className={styles.energy}>{dj?.energy ? `E${dj.energy}` : '—'}</span>
            <span className={styles.len}>{clock(shown.duration_ms)}</span>
            {/* 34b: Play (the set from here), Play next (this one track, outside the set) */}
            <RowPlay
              title={title}
              playing={playing}
              hidden={!track || !onPlay}
              onPlay={() => onPlay?.()}
              onPlayNext={track ? () => playTrackNext(track) : null}
            />
          </>
        )}
        {shown ? (
          <span className={styles.starCell}>
            <StarButton id={starId} title={title} />
          </span>
        ) : null}
        {track ? (
          phone ? (
            row.locked ? (
              <span className={styles.lockedMark} aria-label="Locked">
                <LockIcon locked />
              </span>
            ) : (
              <span />
            )
          ) : (
            <>
              <button
                type="button"
                className={styles.lock}
                aria-pressed={Boolean(row.locked)}
                aria-label={`${row.locked ? 'Unlock' : 'Lock'} ${title}`}
                title={row.locked ? 'Locked: kept in its place' : 'Lock it in its place'}
                onClick={onLock}
              >
                <LockIcon locked={Boolean(row.locked)} />
              </button>
              <Button
                variant="secondary"
                className={styles.swapButton}
                aria-pressed={swapping}
                aria-label={`Swap ${title}`}
                onClick={onSwap}
              >
                Swap
              </Button>
            </>
          )
        ) : missing && gone ? (
          phone ? (
            <span />
          ) : (
            <>
              <span />
              <span />
            </>
          )
        ) : (
          <span className={styles.rowTag}>
            {row.state === 'id' ? null : (
              <StatusTag tone={missing ? 'warning' : 'neutral'}>
                {missing ? 'File missing' : 'Missing'}
              </StatusTag>
            )}
          </span>
        )}
        {phone ? (
          <button
            type="button"
            className={styles.more}
            aria-label={`More for ${title}`}
            aria-haspopup="dialog"
            onClick={onMore}
          >
            …
          </button>
        ) : (
          <MoreMenu className={styles.more} label={`More for ${title}`} entries={entries} />
        )}
        {row.state === 'version' && track ? (
          <span className={styles.wantPair} role="radiogroup" aria-label={`Which cut of ${title}`}>
            <button
              type="button"
              role="radio"
              aria-checked={row.want !== 'wanted'}
              onClick={() => onWant('yours')}
            >
              Use yours
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={row.want === 'wanted'}
              onClick={() => onWant('wanted')}
            >
              {wantLabel(row.version)}
            </button>
          </span>
        ) : null}
      </div>
      {step ? <StepLine step={step} short={phone} chip={chip} /> : missing ? <SkippedLine /> : null}
    </li>
  );
}

/** Play as a mix's glyph (33c): two rings, as the Mix tab's mark. */
function MixGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="9" cy="12" r="5" />
      <circle cx="15" cy="12" r="5" />
    </svg>
  );
}

/** Find it again (28e): the library rescans (an admin's Update the library). */
async function findAgain(): Promise<void> {
  try {
    const response = await apiClient.post('database/update', { json: {}, throwHttpErrors: false });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(body.error || "The library didn't start looking.");
    window.showToast?.(
      'Looking through your library again. The set updates when it’s found.',
      'info',
    );
  } catch (err) {
    window.showToast?.(err instanceof Error ? err.message : "That didn't work.", 'error');
  }
}

async function wantIt(track: { artist: string; title: string }, setName: string): Promise<void> {
  try {
    const done = await addToWanted([track], setName);
    window.showToast?.(
      done.added ? `Added ${track.title} to Wanted` : `${track.title} is on Wanted already`,
      'success',
    );
  } catch (err) {
    window.showToast?.(err instanceof Error ? err.message : "It wasn't added to Wanted.", 'error');
  }
}

/* ── the editor ────────────────────────────────────────────────────────── */

export type EditorSource =
  | { kind: 'draft'; draft: Draft }
  | {
      kind: 'saved';
      id: number;
      name: string;
      rows: SetRow[];
      base: Omit<Draft, 'rows' | 'name' | 'updatedAt'>;
      playlistId: number | null;
      playlistState: 'changed' | 'deleted' | null;
      revision: number;
    };

/** Why Suggest a set waits (Sets 2). */
const SUGGEST_LATER = 'Set suggestions come with the next step of Sets.';

export function SetEditor({
  source,
  onSaved,
  onDeleted,
  onBack,
  onFamous = () => window.location.assign(appURL('/library?view=sets&set=famous')),
}: {
  source: EditorSource;
  onSaved: (id: number) => void;
  onDeleted: () => void;
  onBack: () => void;
  /** 28g's "Start from a famous mix…" */
  onFamous?: () => void;
}) {
  const playingNow = usePlayingTrack();
  const { profileId } = useProfile();
  const phone = usePhone();
  const queryClient = useQueryClient();
  const initial =
    source.kind === 'draft'
      ? source.draft
      : { ...source.base, name: source.name, rows: source.rows };
  const [name, setName] = useState(initial.name);
  const [rows, setRows] = useState<SetRow[]>(initial.rows);
  const [swap, setSwap] = useState<number | null>(null);
  const [sheet, setSheet] = useState<number | null>(null);
  const [moving, setMoving] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [removing, setRemoving] = useState(false);
  /** UX-27: what a move, a remove or a swap said, once, to a screen reader */
  const [announce, setAnnounce] = useState('');
  const [hideGaps, setHideGaps] = useState(false);
  const queueFrom = useQueueFrom();
  const working = useIsWorking(source.kind === 'saved' ? source.id : null);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const nameId = useId();
  const first = useRef(true);
  // what the server last stored, so a save sends only what changed (a
  // rename sends the name alone) and nothing when nothing did
  const savedName = useRef(initial.name);
  const savedRows = useRef(JSON.stringify(rowsBody(initial.rows)));
  // the revision this page last read or had a save confirmed at: a save
  // applies only while the set is still at it (H1, after the gauntlet review)
  const base = useRef(source.kind === 'saved' ? source.revision : 0);
  // one save in flight from this window; the newest edit goes after it
  const inFlight = useRef(false);
  const queued = useRef(false);
  // the set changed somewhere else: autosave stops, the edits stay here
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  const reloading = useRef(false);
  const [playlistState, setPlaylistState] = useState(
    source.kind === 'saved' ? source.playlistState : null,
  );
  const [playlistId, setPlaylistId] = useState(source.kind === 'saved' ? source.playlistId : null);

  const rowsNow = useRef(rows);
  rowsNow.current = rows;
  const nameNow = useRef(name);
  nameNow.current = name;
  const dirty = () =>
    (nameNow.current.trim() || savedName.current) !== savedName.current ||
    JSON.stringify(rowsBody(rowsNow.current)) !== savedRows.current;

  // a newer set from the server (the picker added to it here, another tab
  // or device changed it; refetched on focus): taken as it is when nothing
  // here is unsaved, or when Reload it was asked for. With edits here, the
  // next save is refused and the Notice says so.
  const serverRevision = source.kind === 'saved' ? source.revision : 0;
  const adopt = () => {
    if (source.kind !== 'saved') return;
    reloading.current = false;
    base.current = serverRevision;
    savedName.current = source.name;
    savedRows.current = JSON.stringify(rowsBody(source.rows));
    queued.current = false;
    conflictRef.current = false;
    setConflict(false);
    setError(null);
    setSaving('idle');
    setName(source.name);
    setRows(source.rows);
  };
  useEffect(() => {
    if (source.kind !== 'saved') return;
    if (reloading.current || (serverRevision > base.current && !dirty() && !inFlight.current))
      adopt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRevision]);

  useEffect(() => {
    if (source.kind !== 'saved') return;
    const onChanged = (event: Event) => {
      const id = (event as CustomEvent<{ id?: number }>).detail?.id;
      if (id !== undefined && id !== source.id) return;
      void queryClient.invalidateQueries({ queryKey: [...SETS_QUERY_KEY, 'set'] });
    };
    window.addEventListener(MIX_SET_CHANGED, onChanged);
    return () => window.removeEventListener(MIX_SET_CHANGED, onChanged);
  }, [source, queryClient]);

  /** Send what changed since the last confirmed save, from its revision. */
  const flush = () => {
    if (source.kind !== 'saved' || conflictRef.current) return;
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    const nextName = nameNow.current.trim() || savedName.current;
    const nextRows = JSON.stringify(rowsBody(rowsNow.current));
    const patch: { name?: string; rows?: SetRow[] } = {};
    if (nextName !== savedName.current) patch.name = nextName;
    if (nextRows !== savedRows.current) patch.rows = rowsNow.current;
    if (patch.name === undefined && !patch.rows) {
      setSaving((cur) => (cur === 'saving' ? 'saved' : cur));
      return;
    }
    inFlight.current = true;
    setSaving('saving');
    updateSet(source.id, { ...patch, baseRevision: base.current })
      .then((done) => {
        if (patch.name !== undefined) savedName.current = nextName;
        if (patch.rows) savedRows.current = nextRows;
        base.current = done.revision;
        setPlaylistState(done.playlist_state);
        if (done.playlist_state) setPlaylistId(null);
        setSaving('saved');
        setError(null);
        void queryClient.invalidateQueries({ queryKey: [...SETS_QUERY_KEY, 'list'] });
      })
      .catch((err: unknown) => {
        setSaving('error');
        if (err instanceof StaleSaveError) {
          // someone else changed it: never retried over the top
          conflictRef.current = true;
          queued.current = false;
          setConflict(true);
        } else setError(err instanceof Error ? err.message : "The change wasn't saved.");
      })
      .finally(() => {
        inFlight.current = false;
        if (queued.current && !conflictRef.current) {
          queued.current = false;
          flushRef.current();
        }
      });
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // 319 (step 2's review M2): a chip saved to this draft from Up next
  // ("Save it to … too?") is written to the draft in this browser while the
  // page is open; take its transitions in, so the next edit here doesn't
  // write the old ones back. Only rows still the same track at the same place.
  const written = useRef<string>(JSON.stringify(initial.rows));
  const externalRows = source.kind === 'draft' ? source.draft.rows : null;
  useEffect(() => {
    if (!externalRows) return;
    const theirs = JSON.stringify(externalRows);
    if (theirs === written.current) return;
    written.current = theirs;
    setRows((mine) => {
      let changed = false;
      const merged = mine.map((row, i) => {
        const other = externalRows[i];
        if (!other || String(other.track_id ?? '') !== String(row.track_id ?? '')) return row;
        if (JSON.stringify(other.transition ?? null) === JSON.stringify(row.transition ?? null))
          return row;
        changed = true;
        return { ...row, transition: other.transition ?? null };
      });
      return changed ? merged : mine;
    });
  }, [externalRows]);

  // keep the draft in this browser, or save a saved set as it changes
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (source.kind === 'draft') {
      written.current = JSON.stringify(rows);
      writeDraft(profileId, { ...source.draft, name, rows });
      return;
    }
    if (conflictRef.current || !dirty()) return;
    setSaving('saving');
    const timer = setTimeout(() => flushRef.current(), 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, rows]);

  /** The Notice's Reload it: the newest set from the server, these edits let go. */
  const reload = () => {
    reloading.current = true;
    if (serverRevision > base.current) adopt();
    void queryClient.invalidateQueries({ queryKey: [...SETS_QUERY_KEY, 'set'] });
  };

  /** The Notice's Keep mine as a draft: this page's version, in this browser. */
  const keepAsDraft = () => {
    if (source.kind !== 'saved') return;
    if (
      readDraft(profileId) &&
      !window.confirm(
        'Keep your version as the draft? The draft you have in this browser is replaced.',
      )
    )
      return;
    writeDraft(profileId, {
      ...source.base,
      name: `${nameNow.current.trim() || source.name} (my version)`,
      rows: rowsNow.current,
    });
    window.showToast?.('Your version is kept as a draft in this browser, under Sets.', 'success');
  };

  const playlistAction = async (action: 'new' | 'dismiss') => {
    if (source.kind !== 'saved') return;
    try {
      const done = await setPlaylist(source.id, action);
      setPlaylistState(null);
      if (action === 'new') {
        setPlaylistId(done.playlist_id);
        window.showToast?.(`Made a new playlist from ${name.trim() || source.name}`, 'success');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    }
  };

  const viewKey = JSON.stringify(rows.map((r) => [r.track_id, r.state, r.locked, r.want, r.title]));
  const view = useQuery({
    queryKey: [...SETS_QUERY_KEY, 'view', viewKey],
    queryFn: () => postView(rows),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data: SetView | undefined = view.data;
  // the view's rows line up with ours once it's caught up; until then ours
  const viewRows: ViewRow[] = useMemo(() => {
    if (data && data.rows.length === rows.length)
      return rows.map((r, i) => ({ ...data.rows[i], ...r, track: data.rows[i].track }));
    return rows.map((r) => ({ ...r, track: null }));
  }, [data, rows]);
  const steps = data && data.rows.length === rows.length ? data.steps : [];
  const playing = viewRows.filter((r) => r.track).length;
  const have = useMemo(
    () => new Set(rows.map((r) => r.track_id).filter(Boolean) as string[]),
    [rows],
  );

  const update = (index: number, patch: Partial<SetRow>) =>
    setRows((cur) => cur.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const rowTitle = (index: number) =>
    viewRows[index]?.track?.title ?? rows[index]?.title ?? 'The track';
  /**
   * UX-8: a remove, a move or a swap says so with Undo for 10 s. Undo is the
   * inverse edit on the rows as they are now (gauntlet review H1), so a track
   * added since (the Mix tab, another window) stays; it's used once, and if
   * the row it would act on has gone it says so and changes nothing. UX-27:
   * the toast's live region says the edit once; Undo's result is said here.
   */
  const undoable = (words: string, inverse: (cur: SetRow[]) => SetRow[] | null) => {
    window.showToast?.(words, 'success', null, {
      ms: 10_000,
      action: {
        label: 'Undo',
        run: () => {
          const next = inverse(rowsNow.current);
          if (!next) {
            setAnnounce(`Can't undo: that track isn't in the set any more`);
            window.showToast?.("Can't undo: that track isn't in the set any more", 'info');
            return;
          }
          setRows(next);
          setAnnounce(`Undone: ${words}`);
        },
      },
    });
  };
  const remove = (index: number) => {
    const removed = rows[index];
    if (!removed) return;
    const prev = index > 0 ? rows[index - 1] : null;
    const title = rowTitle(index);
    setRows((cur) => cur.filter((_r, i) => i !== index));
    setSwap(null);
    setSheet(null);
    undoable(`Removed ${title} from ${name.trim() || initial.name}`, (cur) =>
      undoRemove(cur, removed, index, prev),
    );
  };
  const moveTo = (from: number, to: number) => {
    if (rows[from]?.locked) {
      window.showToast?.('That track is locked in its place. Unlock it to move it.', 'info');
      return;
    }
    const moved = rows[from];
    const title = rowTitle(from);
    const next = moveRow(rows, from, to);
    setRows(next);
    const at = next.indexOf(moved);
    if (at !== from)
      undoable(`${title} moved to ${at + 1} of ${next.length}`, (cur) =>
        undoMove(cur, moved, at, from),
      );
  };
  const use = (index: number, track: DjTrack) => {
    const was = rows[index];
    if (!was) return;
    const swappedIn = { track_id: track.id, artist: track.artist_name, title: track.title };
    update(index, {
      ...swappedIn,
      state: 'owned',
      version: null,
      want: 'yours',
    });
    undoable(`Swapped ${rowTitle(index)} for ${track.title}`, (cur) =>
      undoSwap(cur, swappedIn, index, was, SWAP_FIELDS),
    );
  };

  const save = async () => {
    if (source.kind !== 'draft') return;
    setSaving('saving');
    setError(null);
    try {
      const made = await createSet({
        ...source.draft,
        name: name.trim() || source.draft.name,
        rows,
      });
      clearDraft(profileId);
      void queryClient.invalidateQueries({ queryKey: [...SETS_QUERY_KEY, 'list'] });
      window.showToast?.(
        `Saved ${name.trim() || source.draft.name}: in Your sets and as a playlist`,
        'success',
      );
      onSaved(made.id);
    } catch (err) {
      setSaving('error');
      setError(err instanceof Error ? err.message : "The set wasn't saved.");
    }
  };

  const remove_set = async () => {
    if (source.kind !== 'saved') return;
    try {
      await deleteSet(source.id);
      afterSetRemoved(queryClient);
      window.showToast?.(`Removed ${source.name}. Its playlist stays.`, 'success');
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The set wasn't removed.");
    }
  };

  const discard = () => {
    clearDraft(profileId);
    onDeleted();
  };

  const trackIds = viewRows.filter((r) => r.track).map((r) => r.track!.id);
  // analyse on demand: a set's tracks jump the queue while it's open (the
  // server skips those done), and every row says whether it's ready to mix
  const setId = source.kind === 'saved' ? source.id : null;
  useAutoAnalyse(trackIds.slice(0, 500), true, 'auto', { source: 'set', setId });
  const progressOf = useAnalysis(trackIds.slice(0, 500));
  const titleOf = new Map(
    viewRows.filter((r) => r.track).map((r) => [String(r.track!.id), r.track!.title || '']),
  );
  const analyseThese = () => {
    void requestAnalysis(trackIds.slice(0, 500), { force: true, source: 'set', setId })
      .then((answer) => {
        if (!answer) return;
        const said = analyseTheseWords(answer);
        window.showToast?.(said.words, said.tone);
      })
      .catch((error: unknown) =>
        window.showToast?.(error instanceof Error ? error.message : "That didn't work.", 'error'),
      );
  };
  // 4: "Analyse these", saying how many and that ones already done are skipped
  const analyseEntry = trackIds.length
    ? [
        {
          key: 'analyse',
          label: 'Analyse these',
          reason: analyseTheseHint(trackIds.length),
          onSelect: analyseThese,
        },
      ]
    : [];
  const leftOut = viewRows
    .filter((r) => !r.track)
    .map((r) => ({ title: r.title ?? '', artist: r.artist ?? '' }));
  const meta = initial.source_meta ?? {};
  const fromSource =
    initial.source && initial.source !== 'paste'
      ? sourceLine(initial.source, meta.edited)
      : initial.source === 'paste'
        ? 'Pasted tracklist'
        : '';

  const dragFor = (index: number) => ({
    armed: armed === index,
    over: over === index && dragFrom !== null && dragFrom !== index,
    onGrip: () => setArmed(rows[index]?.locked ? null : index),
    onDragStart: (event: DragEvent) => {
      setDragFrom(index);
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData('text/plain', String(index));
      } catch {
        /* some browsers refuse; the index is held here anyway */
      }
    },
    onDragOver: (event: DragEvent) => {
      if (dragFrom === null) return;
      event.preventDefault();
      setOver(index);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      if (dragFrom !== null) moveTo(dragFrom, index);
      setDragFrom(null);
      setOver(null);
      setArmed(null);
    },
    onDragEnd: () => {
      setDragFrom(null);
      setOver(null);
      setArmed(null);
    },
  });

  // the set as Play and Play as a mix take it (a draft is id 0)
  const setRef =
    source.kind === 'saved'
      ? { id: source.id, name: name.trim() || initial.name }
      : { id: 0, name: name.trim() || initial.name, draft: true };
  // 33c: the art, the playing row (the queue says which set it came from, 294)
  const headArt = viewRows.find((r) => r.track?.image_url)?.track?.image_url ?? null;
  const numberOfRow: (number | null)[] = [];
  let numberedCount = 0;
  for (const r of viewRows) numberOfRow.push(r.track || r.unreachable ? ++numberedCount : null);
  // M3: the row with the playing track nearest the queue's mark (rows above
  // it may have been removed or moved since it was queued)
  const playingRow =
    source.kind === 'saved' && queueFrom && queueFrom.id === source.id
      ? playingRowIndex(rows, queueFrom.row, playingNow?.id)
      : -1;
  const playingNumber =
    playingRow >= 0 && viewRows[playingRow]?.track ? (numberOfRow[playingRow] ?? null) : null;
  // 353: "all ready to mix" sits in the meta line once every track is
  const knownIds = trackIds.slice(0, 500).map(String);
  const allReady =
    knownIds.length > 0 && knownIds.every((id) => progressOf[id] && isReady(progressOf[id]));
  // 263: lines of a saved famous mix that aren't in your library
  const gapCount = viewRows.filter((r) => !r.track && !r.unreachable).length;

  let number = 0;
  return (
    <div className={styles.editor} data-set-editor={source.kind}>
      <nav className={styles.crumbs} aria-label="Where you are">
        <button type="button" className={styles.crumbLink} onClick={onBack}>
          Sets
        </button>
        <span aria-hidden="true">/</span>
        <span className={styles.crumbHere}>{name || 'New set'}</span>
      </nav>

      {/* 33c: the art, the name with its tags, the meta line (the analysis's
          "all ready to mix" in it, 353), then Play · Play as a mix · Export to
          Traktor… and, at the right, the working-set toggle and the "…". Not a
          <header>: the page's head isn't a second banner (UX-28). */}
      <div className={styles.editorHead} data-set-head="">
        <span className={styles.headArt} aria-hidden="true">
          {headArt ? <img src={headArt} alt="" /> : null}
        </span>
        <div className={styles.headBody}>
          <div className={styles.titleRow}>
            <label className={styles.srOnly} htmlFor={nameId}>
              The set’s name
            </label>
            <input
              id={nameId}
              className={styles.nameInput}
              value={name}
              maxLength={200}
              size={Math.max(8, Math.min(40, name.length + 1))}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => !name.trim() && setName(initial.name)}
            />
            {working ? (
              <span className={styles.headTag} data-tone="accent" data-set-tag="working">
                Working set
              </span>
            ) : null}
            {playingNumber !== null ? (
              <span className={styles.headTag} data-tone="playing" data-set-tag="playing">
                Playing · {playingNumber} of {numberedCount}
              </span>
            ) : null}
            {source.kind === 'draft' ? (
              <StatusTag tone="neutral" className={styles.draftTag}>
                Draft · not saved
              </StatusTag>
            ) : null}
          </div>
          <p className={styles.metaLine} aria-live="polite">
            {data
              ? [
                  phone ? metaLineShort(data.summary) : metaLine(data.summary),
                  // 28e: "1 file missing"
                  missingWords(viewRows.filter((r) => !r.track && r.unreachable).length),
                ]
                  .filter(Boolean)
                  .join(' · ')
              : ' '}
            {allReady ? (
              <>
                {' · '}
                <span className={styles.readyInline} data-set-ready="">
                  <i aria-hidden="true" />
                  all ready to mix
                </span>
              </>
            ) : null}
            {fromSource ? (
              <>
                {' · '}
                {fromSource}
                {safeSourceLink(initial.source_url) ? (
                  <>
                    {' · '}
                    <a
                      href={safeSourceLink(initial.source_url)!}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                    >
                      open it there
                    </a>
                  </>
                ) : null}
              </>
            ) : null}
            {source.kind === 'saved' && saving !== 'idle' && saving !== 'error' ? (
              <>
                {' · '}
                <span className={styles.savedNote}>
                  {saving === 'saving' ? 'Saving…' : 'Saved'}
                </span>
              </>
            ) : null}
            {gapCount ? (
              <>
                {' · '}
                {/* 263: a saved famous mix's lines not in your library, folded on ask */}
                <button
                  type="button"
                  className={styles.metaButton}
                  aria-pressed={hideGaps}
                  onClick={() => setHideGaps((h) => !h)}
                >
                  {hideGaps
                    ? `Show ${gapCount} not in your library`
                    : `Hide ${gapCount} not in your library`}
                </button>
              </>
            ) : null}
          </p>
          {/* 31b, 353: while anything isn't ready, the line (its bar and words)
              sits here, under the meta line; ready, it's the meta line's dot */}
          {allReady ? null : (
            <SetAnalysisLine
              ids={trackIds.slice(0, 500).map(String)}
              progressOf={progressOf}
              titleOf={titleOf}
              setId={setId}
            />
          )}
          <div className={styles.editorActions}>
            {/* 33c: Play is the primary (the set from its first row, as Up next);
                319: Play as a mix comes before Export, on a draft too */}
            <Button
              size="lg"
              variant={source.kind === 'draft' ? 'secondary' : 'primary'}
              disabled={!trackIds.length}
              disabledReason={trackIds.length ? undefined : 'Add a track from your library first'}
              onClick={() => void playSet(setRef, viewRows)}
            >
              <span className={styles.playGlyph} aria-hidden="true">
                <PlayGlyph size={16} />
              </span>
              Play
            </Button>
            <Button
              size="lg"
              variant="secondary"
              disabled={!trackIds.length}
              disabledReason={trackIds.length ? undefined : 'Add a track from your library first'}
              onClick={() => void playSetAsMix(setRef, viewRows)}
            >
              <span className={styles.playGlyph} aria-hidden="true">
                <MixGlyph />
              </span>
              Play as a mix
            </Button>
            <Button
              size="lg"
              variant="secondary"
              disabled={!trackIds.length}
              disabledReason={trackIds.length ? undefined : 'Add a track from your library first'}
              onClick={() => setExporting(true)}
            >
              Export to Traktor…
            </Button>
            {source.kind === 'draft' ? (
              <Button
                size="lg"
                variant="primary"
                disabled={!rows.length || saving === 'saving'}
                disabledReason={!rows.length ? 'Add a track first' : undefined}
                onClick={() => void save()}
              >
                Save as a set
              </Button>
            ) : null}
            <span className={styles.actionsSpacer} />
            {source.kind === 'saved' ? (
              <WorkingSetToggle setId={source.id} name={name.trim() || initial.name} />
            ) : null}
            <MoreMenu
              className={styles.headMore}
              label={`More for ${name}`}
              entries={
                source.kind === 'draft'
                  ? [
                      ...analyseEntry,
                      {
                        key: 'discard',
                        label: 'Discard this draft',
                        onSelect: discard,
                        tone: 'danger',
                      },
                    ]
                  : [
                      ...analyseEntry,
                      // 262: Open its playlist · Duplicate · Make this my working set · Remove this set…
                      ...(playlistId
                        ? [
                            {
                              key: 'playlist',
                              label: 'Open its playlist',
                              onSelect: () => openPlaylist(playlistId!),
                            },
                          ]
                        : []),
                      {
                        key: 'duplicate',
                        label: 'Duplicate',
                        onSelect: () =>
                          void duplicateSet({
                            name: name.trim() || initial.name,
                            kind: initial.kind,
                            rows,
                          }).then((id) => {
                            if (id === null) return;
                            void queryClient.invalidateQueries({
                              queryKey: [...SETS_QUERY_KEY, 'list'],
                            });
                            onSaved(id);
                          }),
                      },
                      {
                        key: 'working',
                        label: working ? 'No longer my working set' : 'Make this my working set',
                        onSelect: () =>
                          void chooseWorking(
                            working ? null : source.id,
                            name.trim() || initial.name,
                          ).then(() =>
                            queryClient.invalidateQueries({
                              queryKey: [...SETS_QUERY_KEY, 'working'],
                            }),
                          ),
                      },
                      {
                        key: 'remove',
                        label: 'Remove this set…',
                        onSelect: () => setRemoving(true),
                        tone: 'danger',
                      },
                    ]
              }
            />
          </div>
        </div>
      </div>
      {source.kind === 'saved' ? (
        <RemoveSetDialog
          name={name.trim() || initial.name}
          open={removing}
          onKeep={() => setRemoving(false)}
          onRemove={() => {
            setRemoving(false);
            void remove_set();
          }}
        />
      ) : null}

      {/* 31b: what isn't ready to mix, by kind, and what Play as a mix does meanwhile */}
      <SetNotReadyNotice ids={trackIds.slice(0, 500).map(String)} progressOf={progressOf} />
      {/* 320, UX-21: with Auto mix off the chips are dimmed, and it's said once here */}
      {rows.length > 1 ? <AutoMixOffLine className={styles.offLine} /> : null}

      {conflict ? (
        <Notice
          tone="warning"
          role="alert"
          title="This set changed somewhere else"
          data-set-conflict=""
          actions={
            <>
              <Button size="lg" variant="secondary" onClick={reload}>
                Reload it
              </Button>
              <Button size="lg" variant="ghost" onClick={keepAsDraft}>
                Keep mine as a draft
              </Button>
            </>
          }
        >
          {unsavedWords({
            savedRows: JSON.parse(savedRows.current) as SetRow[],
            rows,
            savedName: savedName.current,
            name,
          })}{' '}
          Nothing more is saved from here until you reload it.
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="danger" role="alert" title="That didn't work">
          {error}
        </Notice>
      ) : null}
      {playlistState ? (
        <Notice
          tone="info"
          title={
            playlistState === 'changed'
              ? 'Its playlist was changed elsewhere, so it no longer follows this set'
              : 'Its playlist was deleted, so it no longer follows this set'
          }
          actions={
            <>
              <Button size="lg" variant="secondary" onClick={() => void playlistAction('new')}>
                Make a new playlist from this set
              </Button>
              <Button size="lg" variant="ghost" onClick={() => void playlistAction('dismiss')}>
                Not now
              </Button>
            </>
          }
          data-playlist-state={playlistState}
        >
          The set is saved as it is. Your changes to the playlist stay in the playlist.
        </Notice>
      ) : null}
      {view.isError ? (
        <Notice
          tone="danger"
          role="alert"
          title="Couldn't work out the steps"
          actions={
            <Button size="lg" variant="secondary" onClick={() => void view.refetch()}>
              Try again
            </Button>
          }
        >
          SYNCHRO.S didn&apos;t answer. Nothing in the set is lost.
        </Notice>
      ) : null}

      {rows.length ? (
        <div className={styles.graphCard}>
          {data ? (
            <EnergyGraph rows={viewRows} shape={initial.shape} shaded={swap} />
          ) : (
            <Skeleton className={styles.graphSkeleton} />
          )}
        </div>
      ) : (
        // 28g: an empty set, and the ways to fill it
        <div className={styles.emptyCard}>
          <h2>Nothing in {name.trim() || 'this set'} yet</h2>
          {/* UX-19: a draft lives in this browser, so Add to set… can't reach it */}
          <p>
            {source.kind === 'draft'
              ? 'Add tracks below; a draft stays in this browser until you save it as a set. Or let SYNCHRO.S start it:'
              : 'Add tracks from any track’s “…” → Add to set…, or below. Or let SYNCHRO.S start it:'}
          </p>
          <div className={styles.emptyActions}>
            <Button size="lg" variant="secondary" disabled disabledReason={SUGGEST_LATER}>
              Suggest a set…
            </Button>
            <Button size="lg" variant="secondary" onClick={onFamous}>
              Start from a famous mix…
            </Button>
            <Button
              size="lg"
              variant="secondary"
              disabled={!playingNow}
              disabledReason={playingNow ? undefined : 'Play a track from your library first'}
              onClick={() => {
                if (!playingNow) return;
                setRows((cur) => [
                  ...cur,
                  {
                    track_id: playingNow.id,
                    artist: null,
                    title: playingNow.title,
                    state: 'owned',
                    want: 'yours',
                  },
                ]);
              }}
            >
              Add the playing track
            </Button>
          </div>
        </div>
      )}

      <p className={styles.srOnly} role="status" aria-live="polite" data-set-announce="">
        {announce}
      </p>
      {rows.length ? (
        <ol className={styles.rows} aria-label={`Tracks in ${name}`}>
          {viewRows.map((row, index) => {
            // 28e: a track whose file is missing keeps its number
            const n = row.track || row.unreachable ? ++number : null;
            if (hideGaps && !row.track && !row.unreachable) return null;
            const step = steps[index];
            const nextRow = viewRows.slice(index + 1).find((r) => r.track)?.track ?? null;
            const next = nextRow?.title ?? '';
            return (
              <Row
                key={`${row.track_id ?? row.title}-${index}`}
                step={step ?? null}
                row={row}
                index={index}
                number={n}
                count={rows.length}
                phone={phone}
                swapping={swap === index}
                onLock={() => update(index, { locked: !row.locked })}
                onSwap={() => setSwap(swap === index ? null : index)}
                onMore={() => setSheet(index)}
                onMove={() => setMoving(index)}
                onMoveTo={(to) => moveTo(index, to)}
                onRemove={() => remove(index)}
                onWant={(want) => update(index, { want })}
                onNote={(note) => update(index, { note })}
                onTransition={(transition) => update(index, { transition })}
                nextTitle={next}
                nextId={nextRow?.id ? String(nextRow.id) : null}
                setName={name.trim() || initial.name}
                drag={dragFor(index)}
                progress={row.track ? (progressOf[String(row.track.id)] ?? null) : null}
                playing={index === playingRow}
                onPlay={row.track ? () => void playSet(setRef, viewRows, index) : null}
              />
            );
          })}
        </ol>
      ) : null}

      <AddTracks
        profileId={profileId}
        have={have}
        onAdd={(track) =>
          setRows((cur) => [
            ...cur,
            {
              track_id: track.id,
              artist: track.artist_name,
              title: track.title,
              state: 'owned',
              want: 'yours',
            },
          ])
        }
      />

      {swap !== null && !phone && viewRows[swap]?.track ? (
        <SwapPanel
          rows={viewRows}
          index={swap}
          onUse={(track) => use(swap, track)}
          onRemove={() => remove(swap)}
          onClose={() => setSwap(null)}
        />
      ) : null}
      {sheet !== null && phone ? (
        <TrackSheet
          rows={viewRows}
          index={sheet}
          playing={playing}
          onUse={(track) => {
            use(sheet, track);
            setSheet(null);
          }}
          onLock={() => update(sheet, { locked: !rows[sheet]?.locked })}
          onMove={() => {
            setMoving(sheet);
            setSheet(null);
          }}
          onRemove={() => remove(sheet)}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {moving !== null ? (
        <MoveDialog
          title={viewRows[moving]?.track?.title ?? viewRows[moving]?.title ?? ''}
          from={moving}
          titles={viewRows.map((r) => r.track?.title ?? r.gone_track?.title ?? r.title ?? '')}
          onMove={(to) => {
            moveTo(moving, to);
            setMoving(null);
          }}
          onClose={() => setMoving(null)}
        />
      ) : null}
      {exporting ? (
        <TraktorExportDialog
          from={{
            source: 'tracks',
            track_ids: trackIds,
            name: name.trim() || initial.name,
            left_out: leftOut,
          }}
          name={name.trim() || initial.name}
          onClose={() => setExporting(false)}
        />
      ) : null}
    </div>
  );
}
