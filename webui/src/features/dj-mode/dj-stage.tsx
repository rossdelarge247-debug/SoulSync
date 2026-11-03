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
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { Drag, DropTarget } from '@/features/dnd/dnd-engine';
import type { DragItem } from '@/features/dnd/dnd-model';

import { AnalysisBar, AnalysisLine, useAnalysis } from '@/features/dj/analysis-line';
import { KeyChip } from '@/features/dj/key-chip';
import { refreshOver, useDndSelect, useDropTarget } from '@/features/dnd/dnd-engine';
import { pyRound } from '@/features/dnd/dnd-model';

import type { DjModeSnapshot, DjModeStore, LaneState, LaneTrack } from './dj-mode-store';

import { LaneBody } from './dj-lane-body';
import { djModeStore } from './dj-mode-store';
import {
  clock,
  cuedLine,
  dropStepLine,
  laneGroupName,
  laneLine,
  laneVerdict,
  noGridWords,
  inMixOut,
} from './dj-mode.logic';
import styles from './dj-mode.module.css';
import { syncRatioFromBpm } from './dj-sync';

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

function LaneHead({
  deck,
  lane,
  label,
  time,
  timeRef,
  rate,
}: {
  deck: 'a' | 'b';
  lane: LaneState;
  label: string;
  time: string;
  timeRef?: React.Ref<HTMLSpanElement>;
  /** B with Sync on: the speed it plays at (37g's "124.0 (−1.6%)") */
  rate?: number | null;
}) {
  const { track, info, grid } = lane;
  const own = info?.bpm ?? grid?.bpm ?? null;
  const bpm = own && rate ? own * rate : own;
  const pct = rate ? pyRound((rate - 1) * 100, 1) : 0;
  const note = rate && pct !== 0 ? ` (${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)` : '';
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
              {note}
            </span>
          ) : null}
        </span>
        <span ref={timeRef} className={`${styles.mono} ${styles.time}`} data-dj-time={deck}>
          {time}
        </span>
      </div>
    </div>
  );
}

/**
 * A lane's keys (3b, 37p) on the lane itself: Enter places the picked cue at
 * the playhead (cues without a pointer), Delete takes the picked cue off.
 */
function laneKeys(store: DjModeStore, deck: 'a' | 'b') {
  return (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter' && store.placeAtPlayhead(deck)) e.preventDefault();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && store.removeCue(deck))
      e.preventDefault();
    // step 4b on the focused lane: C is CUE (held), G Play/Pause, ← → nudge while held
    else if ((e.key === 'c' || e.key === 'C') && !e.shiftKey) {
      e.preventDefault();
      if (!e.repeat) store.transport(deck, 'cueDown');
    } else if ((e.key === 'g' || e.key === 'G') && !e.shiftKey) {
      e.preventDefault();
      if (!e.repeat) store.transport(deck, 'play');
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // the player's ±5 s stays the player's where the deck can't be nudged
      const held = e.repeat
        ? store.isNudging(deck)
        : store.nudge(deck, e.key === 'ArrowLeft' ? -1 : 1);
      if (held) e.preventDefault();
    }
  };
}

function laneKeysUp(store: DjModeStore, deck: 'a' | 'b') {
  return (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      store.transport(deck, 'cueUp');
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      store.nudge(deck, 0);
    }
  };
}

/** The lane strip's row (37g): under the line; in the head's corner at 1280 (37m, CSS). */
function StripRow({ strip }: { strip?: ReactNode }) {
  return strip ? (
    <div className={styles.stripRow} data-dj-strip-row="">
      {strip}
    </div>
  ) : null;
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
 * The playhead follows the player's element every frame, and the elapsed
 * time and the line in words every second (review M2), written straight to
 * the page, no render. The line isn't a live region (it would talk every
 * phrase, review M3): the group points at it with `aria-describedby`, and
 * the one change of state it shows, the mix-out reached, is said once.
 */
function usePlayhead(
  lane: LaneState,
  duration: number,
  refs: {
    wave: React.RefObject<HTMLElement | null>;
    time: React.RefObject<HTMLSpanElement | null>;
    line: React.RefObject<HTMLParagraphElement | null>;
  },
  announce: (words: string) => void,
  onElementDuration: (seconds: number) => void,
  posA: () => number | null,
): void {
  const grid = lane.phase === 'ready' ? lane.grid : null;
  const title = lane.track.title;
  const sayRef = useRef(announce);
  sayRef.current = announce;
  // the mix-out is said once per track loaded into the lane, not at every crossing (review N4)
  const saidFor = useRef<string | null>(null);
  const trackId = lane.track.id;
  const durRef = useRef(onElementDuration);
  durRef.current = onElementDuration;
  const posRef = useRef(posA);
  posRef.current = posA;
  useEffect(() => {
    let id = 0;
    let second = Number.NaN;
    let mixOut: boolean | null = null;
    let elDur = Number.NaN;
    const tick = () => {
      const el = playerAudio();
      // deck A's own place while it's on its deck (M1), else the element's
      const t = posRef.current() ?? el?.currentTime ?? 0;
      const ed = el && Number.isFinite(el.duration) ? el.duration : 0;
      // the element's length as it loads (review N2): the lane draws its map once it's known
      if (ed !== elDur) {
        elDur = ed;
        durRef.current(ed);
      }
      const d = duration || ed || 0;
      refs.wave.current?.style.setProperty(
        '--played',
        d > 0 ? String(Math.min(1, Math.max(0, t / d))) : '0',
      );
      const s = Math.floor(t);
      if (s !== second) {
        second = s;
        if (refs.time.current) refs.time.current.textContent = clock(t);
        const words = grid && d > 0 ? laneLine(grid, t) : '';
        if (refs.line.current && refs.line.current.textContent !== words)
          refs.line.current.textContent = words;
        const now = inMixOut(grid, t);
        // said when it's reached while playing, not when the lane opens past it
        if (mixOut === false && now && saidFor.current !== trackId) {
          saidFor.current = trackId;
          sayRef.current(`${title || 'Deck A'}: mix-out reached`);
        }
        mixOut = now;
      }
      id = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(id);
  }, [grid, duration, title, trackId, refs]);
}

function LaneA({
  lane,
  store,
  s,
  strip,
  lineEnd,
}: {
  lane: LaneState;
  store: DjModeStore;
  s: DjModeSnapshot;
  strip?: ReactNode;
  lineEnd?: ReactNode;
}) {
  // the lane carries --played: the waveform, its zoom layer and the beat map read it
  const wave = useRef<HTMLElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const lineEl = useRef<HTMLParagraphElement>(null);
  const refs = useMemo(() => ({ wave, time, line: lineEl }), []);
  const lineId = useId();
  // A's length: the peaks', else the track's, else the player's element (L7),
  // kept in state as the element's loads (N2)
  const [elementDuration, setElementDuration] = useState(0);
  const duration = lane.duration || elementDuration;
  usePlayhead(
    lane,
    duration,
    refs,
    (w) => store.announce(w),
    setElementDuration,
    () => store.positionA(),
  );
  return (
    <section
      ref={wave}
      className={styles.lane}
      data-deck="a"
      data-dj-lane="a"
      data-has-strip={strip ? '' : undefined}
      role="group"
      aria-label={laneGroupName('A', lane.track.title, 'playing')}
      aria-describedby={lineId}
      tabIndex={0}
      onKeyDown={laneKeys(store, 'a')}
      onKeyUp={laneKeysUp(store, 'a')}
    >
      <LaneHead
        deck="a"
        lane={lane}
        label="A · playing · the player’s track"
        // the elapsed time is written each second by usePlayhead, not rendered
        time=""
        timeRef={time}
      />
      <LaneBody
        deck="a"
        lane={lane}
        // the real length even without a grid (M4): zoom falls back to 2 s
        // a bar and cues can still be placed; LaneBody gates the grid's layers
        duration={duration}
        store={store}
        s={s}
        now={() => store.positionA() ?? 0}
      />
      {lane.phase === 'analysing' || lane.phase === 'waiting' ? <Analysing lane={lane} /> : null}
      {lane.phase === 'no_grid' ? <NoGrid lane={lane} /> : null}
      <div className={styles.foot}>
        {/* written each second by usePlayhead */}
        <p ref={lineEl} id={lineId} className={styles.line} data-dj-line="a" />
        {lineEnd}
      </div>
      <StripRow strip={strip} />
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
      if (!store.loadB(item, { announce: false })) return null;
      return {
        words: `${item.title || 'The track'} loaded as B, cued`,
        // a failed Undo says so (the engine's toast shows the error, review L8)
        undo: () => {
          if (!store.snapshot().on) throw new Error('Can’t undo: DJ mode is off');
          if (before) {
            if (!store.loadB(before, { announce: false }))
              throw new Error(`Can’t undo: ${before.title || 'that track'} is playing now`);
          } else store.removeB();
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
  const timeB = useRef<HTMLSpanElement>(null);
  const lineB = useRef<HTMLParagraphElement>(null);
  useDropTarget(LANE_B_TARGET, () => laneTarget(store, () => ref.current));
  const drag = useDndSelect((d) => d.drag);
  const over = useDndSelect((d) => (d.over?.id === LANE_B_TARGET ? d.over : null));
  const lane = s.b;
  const verdict = drag ? laneVerdict(drag.items, { playingId: store.playingId() }) : null;
  const dragState = over ? (over.verdict.ok ? 'over' : 'invalid') : verdict?.ok ? 'lit' : undefined;
  const aTitle = s.a?.track.title || 'the playing track';
  const browse = s.browse ? () => store.openBrowse() : null;
  const lineId = useId();
  // after Hand over the focus goes to lane B's Browse (37p), else the lane
  const handed = s.mix.handed;
  useEffect(() => {
    if (!handed) return;
    const el = ref.current;
    const active = document.activeElement as HTMLElement | null;
    // only when the focus was on the mixer (now gone) or nowhere
    if (active && active !== document.body && active.isConnected && active.offsetParent !== null)
      return;
    (el?.querySelector<HTMLElement>('[data-dj-browse-b]') ?? el)?.focus();
  }, [handed]);
  // the Remove button goes with the track: the focus stays in the lane (review L3)
  const remove = () => {
    store.removeB();
    window.setTimeout(() => ref.current?.focus(), 0);
  };

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
            <button
              type="button"
              className={styles.browse}
              aria-keyshortcuts="B"
              onClick={browse}
              data-dj-browse-b=""
            >
              Browse…
            </button>
            or press B
          </span>
        ) : null}
        {s.mix.handed ? <HandedNotice store={store} s={s} /> : null}
      </div>
    );
  } else {
    const duration = lane.duration ?? 0;
    const ready = lane.phase === 'ready' && lane.grid && duration > 0;
    const mix = s.mix;
    const moving = mix.phase === 'playing' || mix.phase === 'backing';
    // B's own Play, a hand on it, or parked somewhere: the playhead follows the deck (4b)
    const follow =
      moving ||
      Boolean(mix.previewB) ||
      mix.hand === 'B' ||
      ['ready', 'paused'].includes(mix.phase);
    // Sync's speed: as it plays, else as it will (37g, before Play B)
    const planned = mix.sync
      ? (mix.rateB ??
        syncRatioFromBpm(s.a?.info?.bpm ?? s.a?.grid?.bpm, lane.info?.bpm ?? lane.grid?.bpm)
          ?.rate ??
        null)
      : null;
    const line = ready ? cuedLine(lane.grid!) : '';
    body = (
      <>
        <LaneHead
          deck="b"
          lane={lane}
          label={
            mix.solo && mix.phase === 'playing'
              ? 'B · playing · on its own'
              : mix.previewB
                ? 'B · in the headphones · Play B brings it in'
                : laneBLabel(mix.phase, mix.sync)
          }
          time={`${clock(lane.cue)} · ${clock(duration)}`}
          timeRef={timeB}
          rate={planned}
        />
        <LanePlayheadB
          lane={lane}
          store={store}
          moving={moving}
          follow={follow}
          target={ref}
          timeRef={timeB}
          lineRef={lineB}
        />
        <LaneBody
          deck="b"
          lane={lane}
          duration={duration}
          store={store}
          s={s}
          now={() => store.positionB() ?? lane.cue}
          window={mix.window}
        />
        {lane.phase === 'analysing' || lane.phase === 'waiting' ? (
          <Analysing lane={lane} onRemove={remove} />
        ) : null}
        {lane.phase === 'no_grid' ? (
          <NoGrid lane={lane} onBrowse={browse} onRemove={remove} />
        ) : null}
        <div className={styles.foot}>
          <p ref={lineB} id={lineId} className={styles.line} data-dj-line="b">
            {/* while B plays, written each second by WaveformB */}
            {moving ? null : line}
          </p>
          {lineEnd}
        </div>
        <StripRow strip={strip} />
      </>
    );
  }
  const playingB = s.mix.phase === 'playing' || s.mix.phase === 'backing';
  const name = lane
    ? laneGroupName(
        'B',
        lane.track.title,
        playingB ? 'playing' : s.mix.phase === 'paused' ? 'paused' : 'cued',
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
      data-has-strip={lane && strip ? '' : undefined}
      role="group"
      aria-label={lane ? name : 'Deck B, empty: drag a track here'}
      aria-describedby={lane && !over ? lineId : undefined}
      // with Browse there, it takes the focus in the lane's place (37p)
      tabIndex={lane || !s.browse ? 0 : -1}
      onKeyDown={laneKeys(store, 'b')}
      onKeyUp={laneKeysUp(store, 'b')}
    >
      {!lane || over ? <p className={styles.label}>B · the second track</p> : null}
      {body}
    </section>
  );
}

/**
 * After Hand over (37i): one line at the foot of the empty lane, with Undo
 * for 10 s. Not a live region: the session says it once ("Handed over to …").
 */
function HandedNotice({ store, s }: { store: DjModeStore; s: DjModeSnapshot }) {
  const h = s.mix.handed!;
  return (
    <p className={styles.handed} data-dj-handed="">
      <span className={styles.dot} data-tone="ok" aria-hidden="true" />
      <span className={styles.handedText}>
        {h.ended
          ? `${h.from} ended · ${h.title} is the player’s track now. Up next follows it.`
          : `${h.title} is the player’s track now, at its own tempo. Up next follows it.`}
      </span>
      {h.undo ? (
        <button
          type="button"
          className={styles.undo}
          data-dj-undo=""
          onClick={() => void store.undoHandOver()}
        >
          Undo
        </button>
      ) : null}
    </p>
  );
}

/** Lane B's label (37g, 37h): cued, playing on A's beat, paused. */
export function laneBLabel(phase: string, sync: boolean): string {
  if (phase === 'playing' || phase === 'backing')
    return sync ? 'B · playing · on A’s beat' : 'B · playing';
  if (phase === 'paused') return 'B · paused';
  if (phase === 'ready' || phase === 'starting') return 'B · cued · plays on A’s next bar';
  return 'B · cued';
}

/**
 * B's playhead: at the cue, and while B plays it follows the deck every
 * frame (`--played` on the lane, no render), with the elapsed time and the
 * line in words each second (37h: "bar 11 of 128 · …").
 */
function LanePlayheadB({
  lane,
  store,
  moving,
  follow,
  target,
  timeRef,
  lineRef,
}: {
  lane: LaneState;
  store: DjModeStore;
  moving: boolean;
  /** the playhead follows the deck every frame (it plays, or may be moved) */
  follow: boolean;
  target: React.RefObject<HTMLElement | null>;
  timeRef: React.RefObject<HTMLSpanElement | null>;
  lineRef: React.RefObject<HTMLParagraphElement | null>;
}) {
  const grid = lane.phase === 'ready' ? lane.grid : null;
  const d = lane.duration ?? 0;
  useEffect(() => {
    const put = (t: number) =>
      target.current?.style.setProperty(
        '--played',
        d > 0 ? String(Math.min(1, Math.max(0, t / d))) : '0',
      );
    if (!follow) {
      put(store.positionB() ?? lane.cue);
      return;
    }
    let id = 0;
    let second = Number.NaN;
    const tick = () => {
      const t = store.positionB() ?? lane.cue;
      put(t);
      const sec = Math.floor(t);
      if (sec !== second) {
        second = sec;
        if (timeRef.current) timeRef.current.textContent = `${clock(t)} · ${clock(d)}`;
        // the line in words is the blend's; cued, it's the cued line React draws
        if (moving && lineRef.current) lineRef.current.textContent = grid ? laneLine(grid, t) : '';
      }
      id = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(id);
  }, [lane.cue, d, moving, follow, store, target, timeRef, lineRef, grid]);
  return null;
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
          <LaneA lane={s.a} store={store} s={s} strip={slots.strip?.a} lineEnd={slots.lineEnd?.a} />
        ) : (
          <section className={styles.lane} data-deck="a" role="group" aria-label="Deck A, empty" />
        )}
        <LaneB store={store} s={s} strip={slots.strip?.b} lineEnd={slots.lineEnd?.b} />
      </div>
      {slots.mixer ?? null}
    </div>
  );
}
