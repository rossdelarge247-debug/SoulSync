/**
 * Swap (22c, 22e): tracks that fit both neighbours, found by "Mixes well
 * with" from the track before and the track after and ranked by how many
 * sides are smooth, then in Mixes well with's own order (no AI in Sets 1).
 * On a desktop it's the Mixes panel's docked 400px frame (17a's place); on
 * a phone it's the track's sheet with Lock, Move… and Remove.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type { DjTrack } from '@/features/dj/dj.api';

import { DialogFrame } from '@/components/dialog';
import { Button } from '@/components/form';
import { LoadingState, Notice } from '@/components/primitives';
import { bpmNumber, keyTitle } from '@/features/dj/dj.format';
import djStyles from '@/features/dj/dj.module.css';
import { KeyChip } from '@/features/dj/key-chip';
import { useStar } from '@/features/stars/star-button';
import { showsStar, starStore } from '@/features/stars/stars-store';

import type { Step, SwapAlternative, ViewRow } from './sets.api';

import { SETS_QUERY_KEY, fetchSwap } from './sets.api';
import styles from './sets.module.css';

/** The rows either side of `index` that play (missing lines are stepped over). */
export function neighbours(
  rows: ViewRow[],
  index: number,
): { before: string | null; after: string | null } {
  let before: string | null = null;
  let after: string | null = null;
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i].track) {
      before = rows[i].track!.id;
      break;
    }
  }
  for (let i = index + 1; i < rows.length; i++) {
    if (rows[i].track) {
      after = rows[i].track!.id;
      break;
    }
  }
  return { before, after };
}

function side(step: Step | null, into: boolean): string {
  if (!step) return '';
  const word = step.kind === 'smooth' ? 'Smooth' : step.kind === 'jump' ? 'Jump' : 'Not known yet';
  return `${word} ${into ? 'in' : 'out'} (${step.reason})`;
}

/** "Smooth in (7A → 7A, +1 BPM · same key) and out (7A → 8A, +2 BPM)". */
export function fitLine(alt: Pick<SwapAlternative, 'into' | 'out_of'>): string {
  const a = side(alt.into, true);
  const b = side(alt.out_of, false);
  if (a && b && alt.into?.kind === alt.out_of?.kind)
    return `${a} and ${b.replace(/^\S+( yet)? /, '')}`;
  return [a, b].filter(Boolean).join(' · ');
}

/** The phone's short fit (22e): "Smooth both sides", "Jump out: 6A → 8A". */
export function fitShort(alt: Pick<SwapAlternative, 'into' | 'out_of'>): string {
  const steps = [alt.into, alt.out_of].filter(Boolean) as Step[];
  if (steps.length && steps.every((s) => s.kind === 'smooth'))
    return steps.length === 2 ? 'Smooth both sides' : 'Smooth';
  const bad = alt.into && alt.into.kind !== 'smooth' ? alt.into : alt.out_of;
  const where = bad === alt.into ? 'in' : 'out';
  const word = bad?.kind === 'jump' ? 'Jump' : 'Not known';
  return `${word} ${where}: ${bad?.reason.split(',')[0] ?? ''}`;
}

export function trackMeta(track: DjTrack, withArtist = true): ReactNode {
  const dj = track.dj;
  return (
    <>
      {[withArtist ? track.artist_name : '', dj?.bpm ? `${bpmNumber(dj.bpm)} BPM` : '']
        .filter(Boolean)
        .join(' · ')}
      {dj?.key ? (
        <>
          {' · '}
          <KeyChip code={dj.key} uncertain={dj.key_uncertain} title={keyTitle(dj)} variant="text" />
        </>
      ) : null}
      {dj?.energy ? ` · E${dj.energy}` : ''}
    </>
  );
}

function shortKey(track: DjTrack | null): string {
  const dj = track?.dj;
  return [dj?.key, dj?.bpm ? bpmNumber(dj.bpm) : ''].filter(Boolean).join(', ');
}

function SwapList({
  rows,
  index,
  phone,
  onUse,
}: {
  rows: ViewRow[];
  index: number;
  phone: boolean;
  onUse: (track: DjTrack) => void;
}) {
  const { before, after } = neighbours(rows, index);
  const current = rows[index]?.track?.id ?? null;
  const exclude = rows.map((r) => r.track?.id).filter((x): x is string => Boolean(x));
  const query = useQuery({
    queryKey: [...SETS_QUERY_KEY, 'swap', before, after, current, exclude.join(',')],
    queryFn: () => fetchSwap({ before, after, current, exclude }),
    retry: false,
  });
  if (query.isPending) return <LoadingState label="Finding tracks that fit…" />;
  if (query.isError) {
    return (
      <Notice
        tone="danger"
        role="alert"
        title="Couldn't look for tracks that fit"
        actions={
          <Button size="lg" variant="secondary" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      >
        SYNCHRO.S didn&apos;t answer. Nothing in the set changed.
      </Notice>
    );
  }
  const data = query.data;
  const b = data.before;
  const a = data.after;
  const between =
    b && a
      ? `Between ${b.title} (${shortKey(b)}) and ${a.title} (${shortKey(a)}). These fit both, in Mixes well with's order.`
      : b
        ? `After ${b.title} (${shortKey(b)}). These follow it, in Mixes well with's order.`
        : a
          ? `Before ${a.title} (${shortKey(a)}). These lead into it, in Mixes well with's order.`
          : "These mix well with it, in Mixes well with's order.";
  return (
    <>
      {phone ? null : <p className={styles.swapBetween}>{between}</p>}
      {data.alternatives.length ? (
        <ul className={styles.swapList} aria-label="Tracks that could go here">
          {data.alternatives.map((alt) => (
            <li key={alt.track.id} className={styles.swapRow} data-swap-row={alt.track.id}>
              <span className={styles.swapText}>
                <span className={styles.swapTitle}>{alt.track.title}</span>
                <span className={styles.swapMeta}>{trackMeta(alt.track)}</span>
                <span className={styles.swapFit} data-kind={alt.jumps ? 'jump' : 'smooth'}>
                  <i aria-hidden="true" />
                  {phone ? fitShort(alt) : fitLine(alt)}
                </span>
              </span>
              <Button
                size="lg"
                variant="secondary"
                aria-label={`Use ${alt.track.title}`}
                onClick={() => onUse(alt.track)}
              >
                Use
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.stateLine}>
          Nothing else in your library fits here. Try another place, or keep this one.
        </p>
      )}
    </>
  );
}

/** The docked panel (desktop), in "Mixes well with"'s place. */
export function SwapPanel({
  rows,
  index,
  onUse,
  onRemove,
  onClose,
}: {
  rows: ViewRow[];
  index: number;
  onUse: (track: DjTrack) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const row = rows[index];
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    const docked = window.matchMedia?.('(min-width: 1100px)').matches ?? true;
    root.dataset.mixesPanel = docked ? 'docked' : 'over';
    return () => {
      delete root.dataset.mixesPanel;
    };
  }, []);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [index]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!row) return null;
  const title = row.track?.title ?? row.title ?? '';
  return createPortal(
    <aside
      className={`${djStyles.panel} ${styles.swapPanel}`}
      aria-label={`Swap track ${index + 1}`}
      data-swap-panel=""
      style={{ top: 'var(--ss-topbar-h, 64px)', bottom: 'var(--ss-player-h, 0px)' }}
    >
      <div className={djStyles.panelHead}>
        <div className={djStyles.panelHeadText}>
          <span className={djStyles.panelLabel}>Swap track {index + 1}</span>
          <h2 ref={titleRef} tabIndex={-1} className={djStyles.panelTitle}>
            {title}
          </h2>
          {row.track ? <span className={djStyles.panelMeta}>{trackMeta(row.track)}</span> : null}
        </div>
        <button type="button" className={djStyles.closeButton} aria-label="Close" onClick={onClose}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className={`${djStyles.panelBody} ${styles.swapBody}`}>
        <SwapList rows={rows} index={index} phone={false} onUse={onUse} />
      </div>
      <div className={styles.swapFoot}>
        <Button size="lg" variant="secondary" onClick={onRemove}>
          Remove from set
        </Button>
      </div>
    </aside>,
    document.body,
  );
}

/** The phone's track sheet (22e): Track 3 of 16, Lock / Move… / Remove, then Swap. */
export function TrackSheet({
  rows,
  index,
  playing,
  onUse,
  onLock,
  onMove,
  onRemove,
  onClose,
}: {
  rows: ViewRow[];
  index: number;
  /** how many rows play, for "Track 3 of 16" */
  playing: number;
  onUse: (track: DjTrack) => void;
  onLock: () => void;
  onMove: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const row = rows[index];
  const starId = row?.track?.id ?? (row?.unreachable ? row.track_id : null);
  const star = useStar(starId);
  if (!row) return null;
  const place = rows.slice(0, index + 1).filter((r) => r.track).length;
  return (
    <DialogFrame
      open
      onOpenChange={(open) => (open ? null : onClose())}
      aria-label={`Track ${index + 1}`}
      viewportClassName={djStyles.sheetViewport}
      className={`${djStyles.sheet} ${styles.trackSheet}`}
    >
      <span className={djStyles.grabber} aria-hidden="true" />
      <div className={djStyles.panelHead}>
        <div className={djStyles.panelHeadText}>
          <span className={djStyles.panelLabel}>
            {row.track ? `Track ${place} of ${playing}` : `Line ${index + 1}`}
          </span>
          <h2 className={`${djStyles.panelTitle} ${djStyles.sheetTitle}`}>
            {row.track?.title ?? row.title}
          </h2>
          <span className={djStyles.panelMeta}>
            {row.track ? trackMeta(row.track) : (row.artist ?? '')}
          </span>
        </div>
        <button type="button" className={djStyles.closeButton} aria-label="Close" onClick={onClose}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className={styles.sheetButtons}>
        {/* 28d: on a phone Star comes first (Unstar once starred) */}
        {starId && showsStar(star) ? (
          <Button
            size="lg"
            variant="secondary"
            aria-pressed={Boolean(star?.starred)}
            onClick={() => void starStore().toggle(starId, row.track?.title ?? row.title ?? '')}
          >
            {star?.starred ? 'Unstar' : 'Star'}
          </Button>
        ) : null}
        {row.track ? (
          <Button size="lg" variant="secondary" aria-pressed={Boolean(row.locked)} onClick={onLock}>
            {row.locked ? 'Unlock' : 'Lock'}
          </Button>
        ) : null}
        <Button size="lg" variant="secondary" onClick={onMove}>
          Move…
        </Button>
        <Button size="lg" variant="secondary" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {row.track ? (
        <div className={`${djStyles.panelBody} ${djStyles.sheetBody}`}>
          <p className={styles.sheetLabel}>Swap for one that fits both sides</p>
          <SwapList rows={rows} index={index} phone onUse={onUse} />
          <p className={styles.sheetNote}>
            Move… asks for a place by number; on a desktop you drag the row.
          </p>
        </div>
      ) : null}
    </DialogFrame>
  );
}
