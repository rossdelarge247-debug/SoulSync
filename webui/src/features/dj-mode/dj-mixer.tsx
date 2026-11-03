/**
 * DJ mode's mixer (Brief F, 37g, 37h): under the lanes once B has a track,
 * sliding up in 200 ms (in place with Reduce motion), on #101010, in three
 * columns:
 *
 * - **the centre:** Play B (filled cyan; Pause B while it plays), Sync (on
 *   by default; with its reason when it can't), Hand over to B (step 4:
 *   drawn, not yet working, and says so), the 32px crossfader (A→B), and
 *   the echo's Send A, Time and Feedback;
 * - **deck A and deck B:** Volume, Hi, Mid, Low (each with KILL) and Filter,
 *   drawn from `DECK_CONTROLS` by `DeckColumn`: 3b turns each into a
 *   vertical fader (`layout="faders"`) and adds Tempo.
 *
 * In the page the centre comes first (37p's focus order: Play B → Sync →
 * Hand over → crossfader → echo → deck A → deck B); the grid puts it in the
 * middle. Every control is a real range input (or a button) with its mono
 * value and `aria-valuetext`; nothing is automatic, so nothing says AUTO.
 * The engine side is dj-mix-session.ts; the store lends it Back, Esc and ⇧P.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { DeckId } from '@/features/engine/score';

import type { DjMixSession, MixLane, MixView } from './dj-mix-session';
import type { DjModeStore, LaneState } from './dj-mode-store';

import {
  clampTo,
  controlName,
  DECK_CONTROLS,
  ECHO_CONTROLS,
  XF_CONTROL,
  type Band,
  type ControlSpec,
  type DeckControlId,
  type DeckValues,
} from './dj-mixer.logic';
import styles from './dj-mixer.module.css';
import { useDjMode } from './dj-stage';

export const HAND_OVER_WAIT = 'Hand over comes in the next update · Back ends the blend for now';

export function useMixView(session: DjMixSession): MixView {
  return useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
}

/** A lane as the decks need it: its grid only once it's ready to blend on. */
export function mixLane(lane: LaneState | null): MixLane | null {
  if (!lane) return null;
  const ready = lane.phase === 'ready' && lane.grid ? lane.grid : null;
  return {
    id: lane.track.id,
    title: lane.track.title,
    grid: ready ? ready.grid : null,
    bpm: lane.info?.bpm ?? lane.grid?.bpm ?? null,
    cue: lane.cue,
    duration: lane.duration,
    analysing: lane.phase === 'analysing' || lane.phase === 'waiting',
  };
}

function laneKey(lane: LaneState | null): string {
  if (!lane) return '';
  return [lane.track.id, lane.phase, lane.cue, lane.info?.bpm ?? '', lane.duration ?? ''].join('|');
}

/** Reduce motion: the mixer appears in place. */
function prefersReducedMotion(): boolean {
  try {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/* ── one control ──────────────────────────────────────────────────────── */

function Slider({
  spec,
  deck,
  value,
  killed,
  disabled,
  onChange,
  onKill,
  className,
}: {
  spec: ControlSpec;
  deck: DeckId | null;
  value: number;
  killed?: boolean;
  disabled?: boolean;
  onChange: (v: number) => void;
  onKill?: () => void;
  className?: string;
}) {
  const words = spec.words(value, killed);
  const name = controlName(deck, spec);
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'k' || e.key === 'K') && onKill && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      onKill();
      return;
    }
    if (e.shiftKey && spec.bigStep) {
      const dir =
        e.key === 'ArrowRight' || e.key === 'ArrowUp'
          ? 1
          : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
            ? -1
            : 0;
      if (dir) {
        e.preventDefault();
        onChange(clampTo(spec, value + dir * spec.bigStep));
      }
    }
  };
  return (
    <div className={`${styles.control} ${className ?? ''}`} data-control={spec.id}>
      <span className={styles.controlLabel} aria-hidden="true">
        {spec.label}
      </span>
      <input
        type="range"
        className={styles.range}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        aria-label={name}
        aria-valuetext={words}
        aria-keyshortcuts={onKill ? 'K' : undefined}
        disabled={disabled}
        data-killed={killed ? '' : undefined}
        onChange={(e) => onChange(clampTo(spec, Number(e.target.value)))}
        onKeyDown={onKeyDown}
      />
      <output className={styles.value} data-killed={killed ? '' : undefined} aria-hidden="true">
        {words}
      </output>
      {onKill ? (
        <button
          type="button"
          className={styles.kill}
          aria-pressed={Boolean(killed)}
          aria-label={`Kill deck ${deck} ${spec.label}`}
          aria-keyshortcuts="K"
          onClick={onKill}
          onKeyDown={(e) => {
            if ((e.key === 'k' || e.key === 'K') && !e.ctrlKey && !e.metaKey && !e.altKey) {
              e.preventDefault();
              onKill();
            }
          }}
        >
          KILL
        </button>
      ) : (
        <span className={styles.killGap} aria-hidden="true" />
      )}
    </div>
  );
}

/* ── a deck's column ──────────────────────────────────────────────────── */

/**
 * A deck's controls from a list. `layout="rows"` (step 3) is a slider a row;
 * 3b's `faders` draws the same list as 37g's vertical faders and appends
 * Tempo to `controls`.
 */
export function DeckColumn({
  deck,
  values,
  controls = DECK_CONTROLS,
  layout = 'rows',
  onChange,
  onKill,
  extra,
}: {
  deck: DeckId;
  values: DeckValues;
  controls?: readonly ControlSpec<DeckControlId>[];
  layout?: 'rows' | 'faders';
  onChange: (id: DeckControlId, v: number) => void;
  onKill: (band: Band) => void;
  /** 3b: what follows the faders (Tempo's menu) */
  extra?: ReactNode;
}) {
  return (
    <div
      className={styles.deck}
      data-deck={deck.toLowerCase()}
      data-layout={layout}
      role="group"
      aria-label={`Deck ${deck}`}
    >
      {controls.map((spec) => (
        <Slider
          key={spec.id}
          spec={spec}
          deck={deck}
          value={values[spec.id]}
          killed={spec.kill ? values.kill[spec.kill] : undefined}
          onChange={(v) => onChange(spec.id, v)}
          onKill={spec.kill ? () => onKill(spec.kill!) : undefined}
        />
      ))}
      {extra}
    </div>
  );
}

/* ── the mixer ────────────────────────────────────────────────────────── */

export function DjMixer({ store, session }: { store: DjModeStore; session: DjMixSession }) {
  const s = useDjMode(store);
  const v = useMixView(session);
  const [reduce] = useState(prefersReducedMotion);

  // the store borrows Back, Esc's rule, ⇧P and B's place
  useEffect(() => {
    store.setMixer({
      blending: () => session.blending,
      backOverBar: (done) => session.backOverBar(done),
      end: () => session.end(),
      playB: () => {
        const phase = session.snapshot().phase;
        return phase === 'playing' || phase === 'starting' ? session.pauseB() : session.playB();
      },
      positionB: () => session.positionB(),
    });
    return () => {
      session.end();
      store.setMixer(null);
    };
  }, [store, session]);

  // the decks follow the lanes (B's cue and grid, A's track)
  const lanes = useRef({ a: s.a, b: s.b });
  lanes.current = { a: s.a, b: s.b };
  const key = `${laneKey(s.a)}§${laneKey(s.b)}`;
  useEffect(() => {
    session.setLanes(mixLane(lanes.current.a), mixLane(lanes.current.b));
  }, [key, session]);

  // the header's line and Esc's rule read the phase from the store
  useEffect(() => {
    store.setMix({
      phase: v.phase,
      window: v.window,
      rateB: v.rateB,
      sync: v.sync && v.syncable,
    });
  }, [store, v.phase, v.window, v.rateB, v.sync, v.syncable]);

  const aTitle = s.a?.track.title || 'A';
  const bTitle = s.b?.track.title || 'B';
  const status = useMemo(() => statusWords(v, aTitle, bTitle), [v, aTitle, bTitle]);
  if (!s.on || !s.b) return null;

  const playing = v.phase === 'playing' || v.phase === 'starting';
  const canPlay = ['ready', 'paused', 'playing', 'starting'].includes(v.phase);
  const syncOn = v.sync && v.syncable;
  const backing = v.phase === 'backing';
  const playWhy = canPlay ? null : status;

  return (
    <section
      className={styles.mixer}
      data-dj-mixer=""
      data-motion={reduce ? 'reduce' : 'slide'}
      data-phase={v.phase}
      aria-label="Mixer"
      onKeyDown={(e) => {
        // ⇧P from a slider (the player's keys leave inputs alone)
        if (
          e.shiftKey &&
          (e.key === 'P' || e.key === 'p') &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey
        ) {
          e.preventDefault();
          e.stopPropagation();
          store.playB();
        }
      }}
    >
      <div className={styles.centre}>
        <div className={styles.buttons}>
          <button
            type="button"
            className={styles.playB}
            aria-disabled={!canPlay || backing}
            aria-keyshortcuts="Shift+P"
            title={playWhy ?? (playing ? 'Pause B (⇧P)' : `Play B on ${aTitle}’s next bar (⇧P)`)}
            data-dj-play-b=""
            onClick={() => {
              if (!canPlay || backing) return;
              store.playB();
            }}
          >
            <svg className={styles.playIcon} viewBox="0 0 12 12" aria-hidden="true">
              {playing ? <path d="M2 1h3v10H2zM7 1h3v10H7z" /> : <path d="M2 1l9 5-9 5z" />}
            </svg>
            {playing ? 'Pause B' : 'Play B'}
          </button>
          <button
            type="button"
            className={styles.sync}
            aria-pressed={syncOn}
            aria-disabled={!v.syncable}
            title={v.syncable ? 'Sync: B at A’s tempo, on its beat' : (v.syncWhy ?? undefined)}
            data-dj-sync=""
            onClick={() => session.setSync(!syncOn)}
          >
            <span className={styles.syncDot} aria-hidden="true" />
            Sync
          </button>
          <button
            type="button"
            className={styles.handOver}
            aria-disabled="true"
            title={HAND_OVER_WAIT}
            data-dj-hand-over=""
            onClick={() => store.announce(HAND_OVER_WAIT)}
          >
            Hand over to B
          </button>
        </div>
        <p className={styles.status} data-dj-mix-status="">
          {status}
        </p>
        <div className={styles.fader}>
          <span className={styles.faderEnds} aria-hidden="true">
            <span data-end="a">A</span>
            <span>Crossfader</span>
            <span data-end="b">B</span>
          </span>
          <Slider
            spec={XF_CONTROL}
            deck={null}
            value={v.values.xf}
            disabled={false}
            className={styles.xf}
            onChange={(x) => session.setCentre('xf', x)}
          />
        </div>
        <div className={styles.echo}>
          {ECHO_CONTROLS.map((spec) => (
            <Slider
              key={spec.id}
              spec={spec}
              deck={null}
              value={v.values[spec.id]}
              className={styles.echoBox}
              onChange={(x) => session.setCentre(spec.id, x)}
            />
          ))}
        </div>
      </div>
      {(['A', 'B'] as const).map((deck) => (
        <DeckColumn
          key={deck}
          deck={deck}
          values={v.values[deck]}
          onChange={(id, x) => session.setDeck(deck, id, x)}
          onKill={(band) => session.setKill(deck, band, !v.values[deck].kill[band])}
        />
      ))}
    </section>
  );
}

/** The one line under the buttons: where the blend is, in words (not a live region). */
export function statusWords(v: MixView, a: string, b: string): string {
  switch (v.phase) {
    case 'loading':
      return `Getting ${b} onto its deck…`;
    case 'failed':
      return v.error ?? 'The decks couldn’t be made ready';
    case 'ready':
      return v.sync && v.syncable
        ? `${b} starts at its mix-in on ${a}’s next bar, at ${a}’s tempo`
        : `${b} starts at its mix-in${v.syncWhy ? ` · ${v.syncWhy}` : ''}`;
    case 'starting':
      return `${b} comes in on ${a}’s next bar`;
    case 'playing':
      return v.rateB !== null
        ? `Both on the speakers · ${b} on ${a}’s beat`
        : 'Both on the speakers';
    case 'paused':
      return `${b} paused · Play B carries on on ${a}’s next bar`;
    case 'backing':
      return `Bringing ${a} back over a bar`;
    default:
      return '';
  }
}
