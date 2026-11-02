/**
 * DJ mode's stage (Brief F, step 2: 37b–37e, 37m, 37n): two lanes in the
 * Visuals overlay, between its header and the player's own transport.
 *
 * - **Lane A** is the player's track: 48px art, "A · playing · the player's
 *   track", title · artist, the key chip and BPM in mono, the player's 200
 *   peaks with the played part tinted and a white playhead, the sections
 *   strip and the beat map from its grid, and one line in words (its text
 *   equivalent, polite, changed once a phrase).
 * - **Lane B** is empty ("Drag a track here", and Browse… once step 3
 *   registers it) or a loaded track, cued. It's the drag's `dj` target: a
 *   track dropped there is loaded, not played (37c; 37d's amber reasons).
 * - while a lane's grid is worked out it shows Brief A's bar and line; the
 *   waveform is there at once, the sections and the beat map with the grid.
 *
 * Seams: step 3's mixer goes under `.lanes` (it slides up once B has a
 * track) and its Browse registers through `store.setBrowseOpener`; step 3b's
 * lane strip and zoom pill take the lane's `strip` and `lineEnd` slots, and
 * zoom passes a `view` to `beatMap` (dj-mode.logic.ts).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { Drag, DropTarget } from '@/features/dnd/dnd-engine';
import type { DragItem } from '@/features/dnd/dnd-model';

import { AnalysisBar, AnalysisLine, useAnalysis } from '@/features/dj/analysis-line';
import { KeyChip } from '@/features/dj/key-chip';
import { refreshOver, useDndSelect, useDropTarget } from '@/features/dnd/dnd-engine';

import type { DjModeSnapshot, DjModeStore, LaneState, LaneTrack } from './dj-mode-store';

import { djModeStore } from './dj-mode-store';
import {
  beatMap,
  beatMapWords,
  clock,
  cuedLine,
  dropStepLine,
  laneGroupName,
  laneLine,
  laneVerdict,
  noGridWords,
  phraseAt,
  type LaneGrid,
} from './dj-mode.logic';
import styles from './dj-mode.module.css';

export const LANE_B_TARGET = 'dj-lane-b';

export function useDjMode(store: DjModeStore): DjModeSnapshot {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

interface AudioLike {
  currentTime: number;
  duration: number;
}

function playerAudio(): AudioLike | null {
  try {
    const w = window as Window & { SoulSyncPlayer?: { audio?: () => AudioLike | null } };
    return w.SoulSyncPlayer?.audio?.() ?? null;
  } catch {
    return null;
  }
}

/* ── the pieces ───────────────────────────────────────────────────────── */

/** The player's 200 peaks as bars, the played part tinted, a white playhead. */
function Waveform({
  peaks,
  playhead,
  waveRef,
}: {
  peaks: number[] | null;
  playhead: boolean;
  waveRef?: React.Ref<HTMLDivElement>;
}) {
  const bars = useMemo(() => {
    const list = peaks && peaks.length ? peaks : Array.from({ length: 200 }, () => 0.04);
    return list.map((v, i) => {
      const h = Math.max(0.02, Math.min(1, Number(v) || 0)) * 100;
      return <rect key={i} x={i + 0.18} y={(100 - h) / 2} width={0.64} height={h} />;
    });
  }, [peaks]);
  const n = peaks && peaks.length ? peaks.length : 200;
  return (
    <div
      ref={waveRef}
      className={styles.wave}
      data-empty={peaks ? undefined : ''}
      aria-hidden="true"
    >
      <svg className={styles.waveSvg} viewBox={`0 0 ${n} 100`} preserveAspectRatio="none">
        {bars}
      </svg>
      {playhead ? (
        <>
          <span className={styles.played} />
          <span className={styles.playhead} data-dj-playhead="" />
        </>
      ) : null}
    </div>
  );
}

/** The sections strip (18px) and the beat map (22px) from the grid (37b). */
function GridRows({ grid, duration }: { grid: LaneGrid; duration: number }) {
  const layout = useMemo(() => beatMap(grid, duration), [grid, duration]);
  return (
    <>
      {layout.sections.length ? (
        <div className={styles.sections} aria-hidden="true" data-dj-sections="">
          {layout.sections.map((s, i) => (
            <span
              key={i}
              className={styles.section}
              data-kind={s.kind}
              style={{ left: `${s.x0 * 100}%`, width: `${(s.x1 - s.x0) * 100}%` }}
            >
              {s.kind}
            </span>
          ))}
        </div>
      ) : null}
      <div className={styles.map} role="img" aria-label={beatMapWords(grid)} data-dj-beat-map="">
        {layout.mixIn ? (
          <span
            className={styles.region}
            data-region="in"
            style={{
              left: `${layout.mixIn.x0 * 100}%`,
              width: `${(layout.mixIn.x1 - layout.mixIn.x0) * 100}%`,
            }}
          />
        ) : null}
        {layout.mixOut ? (
          <span
            className={styles.region}
            data-region="out"
            style={{
              left: `${layout.mixOut.x0 * 100}%`,
              width: `${(layout.mixOut.x1 - layout.mixOut.x0) * 100}%`,
            }}
          />
        ) : null}
        {layout.ticks.map((t) => (
          <span key={t.bar}>
            <span
              className={styles.tick}
              data-phrase={t.phrase ? '' : undefined}
              style={{ left: `${t.x * 100}%` }}
            />
            {t.label !== null ? (
              <span className={`${styles.num} ${styles.mono}`} style={{ left: `${t.x * 100}%` }}>
                {t.label}
              </span>
            ) : null}
          </span>
        ))}
      </div>
    </>
  );
}

function LaneHead({
  deck,
  lane,
  label,
  time,
  timeRef,
  strip,
}: {
  deck: 'a' | 'b';
  lane: LaneState;
  label: string;
  time: string;
  timeRef?: React.Ref<HTMLSpanElement>;
  strip?: ReactNode;
}) {
  const { track, info, grid } = lane;
  const bpm = info?.bpm ?? grid?.bpm ?? null;
  return (
    <div className={styles.head}>
      {track.image ? (
        <img className={styles.art} src={track.image} alt="" />
      ) : (
        <span className={styles.art} aria-hidden="true" />
      )}
      <div className={styles.who}>
        <p className={styles.label}>{label}</p>
        <p className={styles.title}>
          {track.title || 'Unknown track'}
          {track.artist ? <span className={styles.artist}> · {track.artist}</span> : null}
        </p>
      </div>
      <div className={styles.data}>
        <span className={styles.keyBpm}>
          {info?.key ? <KeyChip code={info.key} uncertain={info.keyUncertain} /> : null}
          {bpm ? (
            <span className={`${styles.mono} ${styles.bpm}`}>
              {info?.key ? '· ' : ''}
              {bpm.toFixed(1)}
            </span>
          ) : null}
        </span>
        <span ref={timeRef} className={`${styles.mono} ${styles.time}`} data-dj-time={deck}>
          {time}
        </span>
      </div>
      {strip}
    </div>
  );
}

/** Brief A's bar and line while the grid is worked out (37e), or the drive it waits for (37d). */
function Analysing({ lane, onRemove }: { lane: LaneState; onRemove?: () => void }) {
  const id = lane.track.id;
  const entries = useAnalysis([id]);
  const entry = entries[id];
  const title = lane.track.title || 'this track';
  if (lane.phase === 'waiting') {
    return (
      <div className={styles.noGrid} data-dj-lane-state="waiting">
        <div style={{ flex: '1 1 100%' }}>
          <AnalysisBar step={0} tone="neutral" />
        </div>
        <p className={styles.noGridWords}>
          <span className={styles.dot} data-tone="grey" aria-hidden="true" />
          Waiting for the library’s drive · {title} can’t be read yet
        </p>
        {onRemove ? (
          <button type="button" className={styles.quiet} onClick={onRemove}>
            Remove
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className={styles.analysing} data-dj-lane-state="analysing">
      <AnalysisLine
        size="line"
        entry={entry}
        title={lane.track.title}
        trackId={id}
        extra={entry?.state === 'working' ? 'a few seconds' : null}
        sentence={entry ? null : `Analysing ${title} · in line`}
        action={false}
      />
      <p className={styles.analysingNote}>
        the waveform is here now; the beat map arrives with the grid
      </p>
    </div>
  );
}

/** No grid to blend on (37d): the reason, and (B) Browse another… and Remove. */
function NoGrid({
  lane,
  onBrowse,
  onRemove,
}: {
  lane: LaneState;
  onBrowse?: (() => void) | null;
  onRemove?: () => void;
}) {
  return (
    <div className={styles.noGrid} data-dj-lane-state="no-grid">
      <p className={styles.noGridWords}>
        <span className={styles.dot} aria-hidden="true" />
        {noGridWords(lane.track.title, lane.reason)}
      </p>
      {onBrowse ? (
        <button type="button" className={styles.quiet} onClick={onBrowse}>
          Browse another…
        </button>
      ) : null}
      {onRemove ? (
        <button type="button" className={styles.quiet} onClick={onRemove}>
          Remove
        </button>
      ) : null}
    </div>
  );
}

/* ── lane A: the player's track ───────────────────────────────────────── */

/**
 * The playhead and the elapsed time follow the player's element every frame
 * (written straight to the page, no render); the line is worked out again
 * once a phrase, and on a seek that changes the phrase (37p).
 */
function usePlayhead(
  lane: LaneState,
  waveRef: React.RefObject<HTMLDivElement | null>,
  timeRef: React.RefObject<HTMLSpanElement | null>,
): number {
  const [at, setAt] = useState(() => playerAudio()?.currentTime ?? 0);
  const grid = lane.grid;
  const known = lane.duration;
  useEffect(() => {
    let id = 0;
    let phrase = Number.NaN;
    let second = -1;
    const tick = () => {
      const el = playerAudio();
      const t = el?.currentTime ?? 0;
      const d = known || (el && Number.isFinite(el.duration) ? el.duration : 0) || 0;
      waveRef.current?.style.setProperty(
        '--played',
        d > 0 ? String(Math.min(1, Math.max(0, t / d))) : '0',
      );
      const s = Math.floor(t);
      if (s !== second && timeRef.current) {
        second = s;
        timeRef.current.textContent = clock(t);
      }
      const p = grid ? phraseAt(grid, t) : -2;
      if (p !== phrase) {
        phrase = p;
        setAt(t);
      }
      id = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(id);
  }, [grid, known, waveRef, timeRef]);
  return at;
}

function LaneA({
  lane,
  strip,
  lineEnd,
}: {
  lane: LaneState;
  strip?: ReactNode;
  lineEnd?: ReactNode;
}) {
  const waveRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const at = usePlayhead(lane, waveRef, timeRef);
  const duration = lane.duration ?? 0;
  const ready = lane.phase === 'ready' && lane.grid && duration > 0;
  const line = ready ? laneLine(lane.grid!, at) : null;
  const name = laneGroupName('A', lane.track.title, 'playing', line);
  return (
    <section
      className={styles.lane}
      data-deck="a"
      data-dj-lane="a"
      role="group"
      aria-label={name}
      tabIndex={0}
    >
      <LaneHead
        deck="a"
        lane={lane}
        label="A · playing · the player’s track"
        // the elapsed time is written each second by usePlayhead, not rendered
        time=""
        timeRef={timeRef}
        strip={strip}
      />
      <Waveform peaks={lane.peaks} playhead waveRef={waveRef} />
      {ready ? <GridRows grid={lane.grid!} duration={duration} /> : null}
      {lane.phase === 'analysing' || lane.phase === 'waiting' ? <Analysing lane={lane} /> : null}
      {lane.phase === 'no_grid' ? <NoGrid lane={lane} /> : null}
      <div className={styles.foot}>
        <p className={styles.line} aria-live="polite" data-dj-line="a">
          {line ?? ''}
        </p>
        {lineEnd}
      </div>
    </section>
  );
}

/* ── lane B: empty, a drag over it, or a track cued ───────────────────── */

function laneTarget(store: DjModeStore, el: () => HTMLElement | null): DropTarget {
  return {
    id: LANE_B_TARGET,
    kind: 'dj',
    listId: LANE_B_TARGET,
    name: 'Lane B',
    inlineReason: true,
    el,
    accepts: (drag: Drag) => laneVerdict(drag.items, { playingId: store.playingId() }),
    hint: (drag: Drag) => `Drop to load ${drag.items[0]?.title || 'it'}`,
    drop: async (drag: Drag) => {
      const item = drag.items[0];
      if (!item) return null;
      const before: LaneTrack | null = store.snapshot().b?.track ?? null;
      if (!store.loadB(item)) return null;
      return {
        words: `${item.title || 'The track'} loaded as B, cued`,
        undo: () => {
          if (before) store.loadB(before);
          else store.removeB();
        },
        focus: () => el()?.focus(),
      };
    },
  };
}

function DragBody({
  item,
  ok,
  reason,
  a,
  store,
}: {
  item: DragItem | undefined;
  ok: boolean;
  reason: string | null;
  a: LaneState | null;
  store: DjModeStore;
}) {
  const [, bump] = useState(0);
  const grid =
    item && ok
      ? store.readinessOf(item.id, () => {
          bump((n) => n + 1);
          refreshOver();
        })
      : null;
  if (!ok) {
    return (
      <div className={styles.emptyBody}>
        <p className={styles.dropLine} data-dj-drop-line="">
          <span className={styles.dot} aria-hidden="true" />
          {reason}
        </p>
      </div>
    );
  }
  const aStep = a ? { key: a.info?.key ?? null, bpm: a.info?.bpm ?? a.grid?.bpm ?? null } : null;
  const step = item ? dropStepLine(aStep, { key: item.key, bpm: item.bpm }, grid) : '';
  return (
    <div className={styles.emptyBody}>
      <p className={styles.dropLine} data-dj-drop-line="">
        Drop to load {item?.title || 'it'}
      </p>
      {step ? <p className={styles.dropStep}>{step}</p> : null}
    </div>
  );
}

function LaneB({
  store,
  s,
  strip,
  lineEnd,
}: {
  store: DjModeStore;
  s: DjModeSnapshot;
  strip?: ReactNode;
  lineEnd?: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useDropTarget(LANE_B_TARGET, () => laneTarget(store, () => ref.current));
  const drag = useDndSelect((d) => d.drag);
  const over = useDndSelect((d) => (d.over?.id === LANE_B_TARGET ? d.over : null));
  const lane = s.b;
  const verdict = drag ? laneVerdict(drag.items, { playingId: store.playingId() }) : null;
  const dragState = over ? (over.verdict.ok ? 'over' : 'invalid') : verdict?.ok ? 'lit' : undefined;
  const aTitle = s.a?.track.title || 'the playing track';
  const browse = s.browse ? () => store.openBrowse() : null;
  const remove = () => store.removeB();

  let body: ReactNode;
  if (over) {
    body = (
      <DragBody
        item={drag?.items[0]}
        ok={over.verdict.ok}
        reason={over.verdict.reason ?? null}
        a={s.a}
        store={store}
      />
    );
  } else if (!lane) {
    body = (
      <div className={styles.emptyBody}>
        <svg
          className={styles.drop}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
        </svg>
        <p className={styles.emptyTitle}>Drag a track here</p>
        <p className={styles.emptyText}>
          From Tracks, an album, an artist, Search or Up next. It plays at {aTitle}’s tempo, on its
          beat, when you bring it in.
        </p>
        {browse ? (
          <span className={styles.browseRow}>
            <button type="button" className={styles.browse} aria-keyshortcuts="B" onClick={browse}>
              Browse…
            </button>
            or press B
          </span>
        ) : null}
      </div>
    );
  } else {
    const duration = lane.duration ?? 0;
    const ready = lane.phase === 'ready' && lane.grid && duration > 0;
    const line = ready ? cuedLine(lane.grid!) : '';
    body = (
      <>
        <LaneHead
          deck="b"
          lane={lane}
          label="B · cued"
          time={`${clock(lane.cue)} · ${clock(duration)}`}
          strip={strip}
        />
        <WaveformB lane={lane} />
        {ready ? <GridRows grid={lane.grid!} duration={duration} /> : null}
        {lane.phase === 'analysing' || lane.phase === 'waiting' ? (
          <Analysing lane={lane} onRemove={remove} />
        ) : null}
        {lane.phase === 'no_grid' ? (
          <NoGrid lane={lane} onBrowse={browse} onRemove={remove} />
        ) : null}
        <div className={styles.foot}>
          <p className={styles.line} aria-live="polite" data-dj-line="b">
            {line}
          </p>
          {lineEnd}
        </div>
      </>
    );
  }
  const name = lane
    ? laneGroupName(
        'B',
        lane.track.title,
        'cued',
        lane.phase === 'ready' && lane.grid ? cuedLine(lane.grid) : null,
      )
    : laneGroupName('B', null, '');
  return (
    <section
      ref={ref}
      className={`${styles.lane} ${!lane || over ? styles.empty : ''}`}
      data-deck="b"
      data-dj-lane="b"
      data-drag={dragState}
      data-dnd-target={LANE_B_TARGET}
      role="group"
      aria-label={lane ? name : 'Deck B, empty: drag a track here'}
      // with Browse there, it takes the focus in the lane's place (37p)
      tabIndex={lane || !s.browse ? 0 : -1}
    >
      {!lane || over ? <p className={styles.label}>B · the second track</p> : null}
      {body}
    </section>
  );
}

/** B's waveform, its playhead at the cue (step 3 starts it there). */
function WaveformB({ lane }: { lane: LaneState }) {
  const ref = useRef<HTMLDivElement>(null);
  const d = lane.duration ?? 0;
  useEffect(() => {
    ref.current?.style.setProperty('--played', d > 0 ? String(Math.min(1, lane.cue / d)) : '0');
  }, [lane.cue, d]);
  return <Waveform peaks={lane.peaks} playhead waveRef={ref} />;
}

/* ── the stage ────────────────────────────────────────────────────────── */

export interface DjStageSlots {
  /** 3b: the lane strip (Headphones, cues 1–4, Key lock), per deck */
  strip?: Partial<Record<'a' | 'b', ReactNode>>;
  /** 3b: the zoom pill at the end of each lane's line row */
  lineEnd?: Partial<Record<'a' | 'b', ReactNode>>;
  /** 3: the mixer, under the lanes once B has a track */
  mixer?: ReactNode;
}

export function DjStage({
  store = djModeStore(),
  slots = {},
}: {
  store?: DjModeStore;
  slots?: DjStageSlots;
}) {
  const s = useDjMode(store);
  if (!s.on) return null;
  return (
    <div className={styles.stage} data-dj-stage="" aria-label="DJ mode">
      <div className={styles.lanes}>
        {s.a ? (
          <LaneA lane={s.a} strip={slots.strip?.a} lineEnd={slots.lineEnd?.a} />
        ) : (
          <section className={styles.lane} data-deck="a" role="group" aria-label="Deck A, empty" />
        )}
        <LaneB store={store} s={s} strip={slots.strip?.b} lineEnd={slots.lineEnd?.b} />
      </div>
      {slots.mixer ?? null}
    </div>
  );
}
