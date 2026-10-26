/**
 * The set itself (22c, 22d, 22e without the AI's parts): the name, the meta
 * line, Export to Traktor… and Save as mix, the energy graph, then the rows
 * with the step between each pair (Smooth / Jump / Not known yet and why, in
 * the Mixes panel's words, worked out by the server's Camelot rules). Lock
 * per row; reorder by the grip, or Move up / Move down / Move… from the "…"
 * (the keyboard's way and the phone's); Swap in the docked panel or the
 * phone's sheet. A draft lives in this browser; a saved set saves as it's
 * changed, and its playlist follows.
 */
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';

import type { DjBrowseResponse, DjTrack } from '@/features/dj/dj.api';

import { apiClient, readJson } from '@/app/api-client';
import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button, TextInput } from '@/components/form';
import { Notice, Skeleton, StatusTag } from '@/components/primitives';
import { playTrackNext } from '@/features/dj/dj-actions';
import { bpmNumber, keyTitle } from '@/features/dj/dj.format';
import { KeyChip } from '@/features/dj/key-chip';
import { openMixes } from '@/features/dj/mixes-store';
import { TraktorExportDialog } from '@/features/dj/traktor-export-dialog';
import { useProfile } from '@/platform/shell/route-controllers';
import { MoreMenu } from '@/routes/library/-ui/parts';

import type { Draft } from './draft-store';
import type { SetRow, SetView, Step, ViewRow } from './sets.api';

import { clearDraft, writeDraft } from './draft-store';
import { EnergyGraph } from './energy-graph';
import {
  SETS_QUERY_KEY,
  StaleSaveError,
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
  moveRow,
  safeSourceLink,
  sourceLine,
  wantLabel,
} from './sets.format';
import styles from './sets.module.css';
import { SwapPanel, TrackSheet, trackMeta } from './swap-panel';

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

function StepLine({ step, short = false }: { step: Step; short?: boolean }) {
  return (
    <div className={styles.step} data-step={step.kind}>
      <i aria-hidden="true" />
      <span className={styles.stepWord}>{STEP_WORDS[step.kind]}</span>
      <span className={styles.stepWhy}>
        {short ? ' · ' : ' '}
        {step.reason}
      </span>
    </div>
  );
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

function MoveDialog({
  title,
  from,
  count,
  onMove,
  onClose,
}: {
  title: string;
  from: number;
  count: number;
  onMove: (to: number) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState(String(from + 1));
  const n = Number(value);
  const ok = Number.isInteger(n) && n >= 1 && n <= count;
  return (
    <DialogFrame
      open
      onOpenChange={(open) => (open ? null : onClose())}
      className={styles.moveDialog}
    >
      <DialogHeader title={`Move ${title}`} closeLabel="Close" />
      <DialogBody>
        <label className={styles.moveLabel} htmlFor={id}>
          To place (1–{count})
        </label>
        <TextInput
          id={id}
          inputMode="numeric"
          value={value}
          autoFocus
          onChange={(event) => setValue(event.target.value.replace(/\D/g, '').slice(0, 4))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ok) onMove(n - 1);
          }}
        />
      </DialogBody>
      <DialogFooter>
        <Button size="lg" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={!ok}
          disabledReason={ok ? undefined : `Type a place from 1 to ${count}`}
          onClick={() => onMove(n - 1)}
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
  drag,
  step,
}: {
  step: Step | null;
  row: ViewRow;
  index: number;
  /** its place among the playing rows, or null */
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
  const track = row.track;
  const dj = track?.dj;
  const title = track?.title ?? row.title ?? '';
  const artist = track?.artist_name ?? row.artist ?? '';
  // a locked row holds its place: its moves are there, disabled
  const held = Boolean(row.locked);
  const entries = [
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
    ...(track
      ? [
          { key: 'next', label: 'Play next', onSelect: () => playTrackNext(track) },
          {
            key: 'mixes',
            label: 'Mixes well with…',
            onSelect: () => openMixes({ id: track.id, title: track.title }),
          },
        ]
      : []),
    { key: 'remove', label: 'Remove from set', onSelect: onRemove },
  ];
  const second =
    row.state === 'version' && track
      ? row.want === 'wanted'
        ? `Wanted: ${wantLabel(row.version).replace(/^Want /, '')} · yours plays until it arrives`
        : haveLine(versionOf(track.title))
      : null;
  return (
    <li
      className={styles.rowItem}
      data-set-row={index}
      data-state={track ? 'playing' : row.state}
      data-swapping={swapping ? 'true' : undefined}
      data-drag-over={drag.over ? 'true' : undefined}
      data-locked={held ? 'true' : undefined}
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
        <span className={styles.num}>{number ?? ''}</span>
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>{title}</span>
          {phone && track ? (
            <span className={styles.rowMeta}>{trackMeta(track)}</span>
          ) : (
            <span className={styles.rowMeta}>
              {track
                ? artist
                : row.state === 'id'
                  ? 'Not identified in the tracklist'
                  : row.unreachable
                    ? `${artist ? `${artist} · ` : ''}Can't be reached right now; it plays again when its file is back`
                    : `${artist ? `${artist} · ` : ''}Not in your library`}
              {second ? ` · ${second}` : ''}
            </span>
          )}
        </span>
        {phone || !track ? null : (
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
            <span className={styles.len}>{clock(track.duration_ms)}</span>
          </>
        )}
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
        ) : (
          <span className={styles.rowTag}>
            {row.state === 'id' ? null : (
              <StatusTag tone="neutral">{row.unreachable ? 'Away' : 'Missing'}</StatusTag>
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
      {step ? <StepLine step={step} short={phone} /> : null}
    </li>
  );
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

export function SetEditor({
  source,
  onSaved,
  onDeleted,
  onBack,
}: {
  source: EditorSource;
  onSaved: (id: number) => void;
  onDeleted: () => void;
  onBack: () => void;
}) {
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
  // autosaves count up, so one that arrives late can't undo a newer one
  const revision = useRef(source.kind === 'saved' ? source.revision : 0);
  // the revisions this window has sent: a refusal naming one of them only
  // means a later save from here got there first, not another window
  const sentRevisions = useRef(new Set<number>());
  const [playlistState, setPlaylistState] = useState(
    source.kind === 'saved' ? source.playlistState : null,
  );
  const [playlistId, setPlaylistId] = useState(source.kind === 'saved' ? source.playlistId : null);

  // keep the draft in this browser, or save a saved set as it changes
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (source.kind === 'draft') {
      writeDraft(profileId, { ...source.draft, name, rows });
      return;
    }
    const nextName = name.trim() || savedName.current;
    const nextRows = JSON.stringify(rowsBody(rows));
    const patch: { name?: string; rows?: SetRow[] } = {};
    if (nextName !== savedName.current) patch.name = nextName;
    if (nextRows !== savedRows.current) patch.rows = rows;
    if (patch.name === undefined && !patch.rows) return;
    setSaving('saving');
    const timer = setTimeout(() => {
      revision.current += 1;
      const sent = revision.current;
      sentRevisions.current.add(sent);
      for (const old of sentRevisions.current) {
        if (old < sent - 50) sentRevisions.current.delete(old);
      }
      updateSet(source.id, { ...patch, revision: sent })
        .then((done) => {
          if (patch.name !== undefined) savedName.current = nextName;
          if (patch.rows) savedRows.current = nextRows;
          revision.current = Math.max(revision.current, done.revision);
          setPlaylistState(done.playlist_state);
          if (done.playlist_state) setPlaylistId(null);
          setSaving('saved');
          void queryClient.invalidateQueries({ queryKey: [...SETS_QUERY_KEY, 'list'] });
        })
        .catch((err: unknown) => {
          if (err instanceof StaleSaveError && sentRevisions.current.has(err.revision)) {
            // a later save from this window, which holds this change too,
            // was applied first: nothing to say
            revision.current = Math.max(revision.current, err.revision);
            return;
          }
          setSaving('error');
          if (err instanceof StaleSaveError) {
            revision.current = Math.max(revision.current, err.revision);
            setError(
              'This set was changed in another window. Reload the page to see the newest version.',
            );
          } else setError(err instanceof Error ? err.message : "The change wasn't saved.");
        });
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, rows]);

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
  const remove = (index: number) => {
    setRows((cur) => cur.filter((_r, i) => i !== index));
    setSwap(null);
    setSheet(null);
  };
  const moveTo = (from: number, to: number) => {
    if (rows[from]?.locked) {
      window.showToast?.('That track is locked in its place. Unlock it to move it.', 'info');
      return;
    }
    setRows((cur) => moveRow(cur, from, to));
  };
  const use = (index: number, track: DjTrack) => {
    update(index, {
      track_id: track.id,
      artist: track.artist_name,
      title: track.title,
      state: 'owned',
      version: null,
      want: 'yours',
    });
    window.showToast?.(`${track.title} is in place ${index + 1}`, 'success');
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
      void queryClient.invalidateQueries({ queryKey: [...SETS_QUERY_KEY, 'list'] });
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

  let number = 0;
  return (
    <div className={styles.editor} data-set-editor={source.kind}>
      <nav className={styles.crumbs} aria-label="Where you are">
        <button type="button" className={styles.crumbLink} onClick={onBack}>
          Sets
        </button>
        <span aria-hidden="true">/</span>
        <span className={styles.crumbHere}>{name || 'New set'}</span>
        {source.kind === 'draft' ? (
          <StatusTag tone="neutral" className={styles.draftTag}>
            Draft · not saved
          </StatusTag>
        ) : saving === 'saving' ? (
          <span className={styles.savedNote}>Saving…</span>
        ) : saving === 'saved' ? (
          <span className={styles.savedNote}>Saved</span>
        ) : null}
      </nav>

      <header className={styles.editorHead}>
        <label className={styles.srOnly} htmlFor={nameId}>
          The set’s name
        </label>
        <input
          id={nameId}
          className={styles.nameInput}
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => !name.trim() && setName(initial.name)}
        />
        <p className={styles.metaLine} aria-live="polite">
          {data ? (phone ? metaLineShort(data.summary) : metaLine(data.summary)) : ' '}
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
        </p>
        <div className={styles.editorActions}>
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
              Save as mix
            </Button>
          ) : null}
          <MoreMenu
            className={styles.headMore}
            label={`More for ${name}`}
            entries={
              source.kind === 'draft'
                ? [
                    {
                      key: 'discard',
                      label: 'Discard this draft',
                      onSelect: discard,
                      tone: 'danger',
                    },
                  ]
                : [
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
                      key: 'remove',
                      label: 'Remove this set',
                      onSelect: () => void remove_set(),
                      tone: 'danger',
                    },
                  ]
            }
          />
        </div>
      </header>

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
        <div className={styles.emptyCard}>
          <h2>An empty set</h2>
          <p>
            Add tracks from your library below, or pick some on Tracks and use “Start a set from
            these”. SYNCHRO.S says how each step mixes as you go.
          </p>
        </div>
      )}

      {rows.length ? (
        <ol className={styles.rows} aria-label={`Tracks in ${name}`}>
          {viewRows.map((row, index) => {
            const n = row.track ? ++number : null;
            const step = steps[index];
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
                drag={dragFor(index)}
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
          count={rows.length}
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
