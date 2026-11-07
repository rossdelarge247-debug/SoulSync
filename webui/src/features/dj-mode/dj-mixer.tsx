/**
 * DJ mode's mixer (Brief F, 37g, 37h): under the lanes once B has a track,
 * sliding up in 200 ms (in place with Reduce motion), on #101010, in three
 * columns:
 *
 * - **the centre:** Play B (filled cyan; Pause B while it plays), Sync (on
 *   by default; with its reason when it can't), Hand over to B (step 4,
 *   414: B becomes the player's track; H), the 32px crossfader (A→B), and
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
import type { DjModeStore, LaneState, LoopAction } from './dj-mode-store';
import type { DjOutputs } from './dj-outputs-host';

import { DeckMeter, MasterMeter, useMeters } from './dj-meters';
import {
  clampTo,
  controlName,
  DECK_CONTROLS,
  ECHO_CONTROLS,
  TEMPO_RANGES,
  tempoRate,
  tempoSpan,
  tempoStep,
  XF_CONTROL,
  type Band,
  type ControlSpec,
  type DeckControlId,
  type DeckValues,
  type TempoRange,
} from './dj-mixer.logic';
import styles from './dj-mixer.module.css';
import { MonitorBlock } from './dj-monitor';
import { djPrefs, type DjPrefsStore } from './dj-prefs';
import { useDjMode } from './dj-stage';
import { syncRatioFromBpm } from './dj-sync';

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
    queue: lane.track.queue ?? null,
    queueWhy: lane.track.queueWhy ?? null,
    loudness: lane.grid?.loudness ?? null,
  };
}

function laneKey(lane: LaneState | null): string {
  if (!lane) return '';
  return [
    lane.track.id,
    lane.phase,
    lane.cue,
    lane.info?.bpm ?? '',
    lane.duration ?? '',
    lane.track.queue ? 'q' : lane.track.queueWhy ? 'x' : '',
    lane.grid?.loudness?.replaygain_db ?? '',
    lane.grid?.loudness?.level_db ?? '',
  ].join('|');
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
  vertical = false,
  label,
  title,
  tone,
  onReset,
  plusDown,
  fine,
  foot,
  meter,
}: {
  spec: ControlSpec;
  deck: DeckId | null;
  value: number;
  killed?: boolean;
  disabled?: boolean;
  onChange: (v: number) => void;
  onKill?: () => void;
  className?: string;
  /** 3b: a vertical fader (37g; up is more) */
  vertical?: boolean;
  /** the label as something else (Tempo's menu button) */
  label?: ReactNode;
  title?: string;
  /** "sync": the value set by Sync (green, the thumb dimmed) */
  tone?: 'sync';
  /** double-click or Backspace: back to its rest (Tempo's 0) */
  onReset?: () => void;
  /** a vertical fader with + at the bottom (Tempo, a CDJ's: M8); ↓ is + then */
  plusDown?: boolean;
  /** ⇧-drag moves it a tenth as far (Tempo's fine adjust, S1) */
  fine?: boolean;
  /** what shows under the value where a KILL would be (Volume's Auto-gain, S6) */
  foot?: ReactNode;
  /** beside the fader (Volume's level meter, S5) */
  meter?: ReactNode;
}) {
  const words = spec.words(value, killed);
  const name = controlName(deck, spec);
  const drag = useRef<{ id: number; y: number; from: number; px: number } | null>(null);
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (onReset && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
      onReset();
      return;
    }
    // + at the bottom: ↓ moves the thumb down, which is faster (M8)
    if (vertical && plusDown && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const by = e.shiftKey && spec.bigStep ? spec.bigStep : spec.step;
      onChange(clampTo(spec, value + dir * by));
      return;
    }
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
    <div
      className={`${styles.control} ${className ?? ''}`}
      data-control={spec.id}
      data-tone={tone}
      title={title}
    >
      {label ?? (
        <span className={styles.controlLabel} aria-hidden="true">
          {spec.label}
        </span>
      )}
      {vertical && plusDown !== undefined ? (
        <span className={styles.faderEnd} aria-hidden="true" data-end="top">
          {plusDown ? '−' : '+'}
        </span>
      ) : null}
      {meter ? (
        <span className={styles.rangeRow}>
          <input
            type="range"
            className={styles.range}
            aria-orientation={vertical ? 'vertical' : undefined}
            data-vertical={vertical ? '' : undefined}
            data-plus={vertical && plusDown ? 'down' : undefined}
            onDoubleClick={onReset}
            onPointerDown={(e) => {
              // ⇧-drag: a tenth of the travel, for a fine tempo (S1)
              if (!fine || !e.shiftKey || disabled) return;
              e.preventDefault();
              const el = e.currentTarget;
              const box = el.getBoundingClientRect();
              const px = Math.max(40, vertical ? box.height : box.width);
              drag.current = {
                id: e.pointerId,
                y: vertical ? e.clientY : e.clientX,
                from: value,
                px,
              };
              try {
                el.setPointerCapture(e.pointerId);
              } catch {
                /* a synthetic event */
              }
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || d.id !== e.pointerId) return;
              const at = vertical ? e.clientY : e.clientX;
              // down the screen is + with + at the bottom; up is + otherwise (and right is +)
              const sign = vertical ? (plusDown ? 1 : -1) : 1;
              const moved = ((at - d.y) * sign * (spec.max - spec.min)) / d.px / 10;
              onChange(clampTo(spec, d.from + moved));
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
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
          {meter}
        </span>
      ) : (
        <input
          type="range"
          className={styles.range}
          aria-orientation={vertical ? 'vertical' : undefined}
          data-vertical={vertical ? '' : undefined}
          data-plus={vertical && plusDown ? 'down' : undefined}
          onDoubleClick={onReset}
          onPointerDown={(e) => {
            // ⇧-drag: a tenth of the travel, for a fine tempo (S1)
            if (!fine || !e.shiftKey || disabled) return;
            e.preventDefault();
            const el = e.currentTarget;
            const box = el.getBoundingClientRect();
            const px = Math.max(40, vertical ? box.height : box.width);
            drag.current = {
              id: e.pointerId,
              y: vertical ? e.clientY : e.clientX,
              from: value,
              px,
            };
            try {
              el.setPointerCapture(e.pointerId);
            } catch {
              /* a synthetic event */
            }
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            const at = vertical ? e.clientY : e.clientX;
            // down the screen is + with + at the bottom; up is + otherwise (and right is +)
            const sign = vertical ? (plusDown ? 1 : -1) : 1;
            const moved = ((at - d.y) * sign * (spec.max - spec.min)) / d.px / 10;
            onChange(clampTo(spec, d.from + moved));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
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
      )}
      {vertical && plusDown !== undefined ? (
        <span className={styles.faderEnd} aria-hidden="true" data-end="bottom">
          {plusDown ? '+' : '−'}
        </span>
      ) : null}
      <output className={styles.value} data-killed={killed ? '' : undefined} aria-hidden="true">
        {words}
      </output>
      {foot ? (
        <span className={styles.foot}>{foot}</span>
      ) : onKill ? (
        <button
          type="button"
          className={styles.kill}
          aria-pressed={Boolean(killed)}
          aria-label={`Kill deck ${deck} ${spec.label}`}
          aria-keyshortcuts="K"
          disabled={disabled}
          title={disabled ? title : undefined}
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

export interface TempoProps {
  range: TempoRange;
  onRange: (r: TempoRange) => void;
  /** A's BPM, for the menu's spans (438) */
  bpm: number | null;
  /** B with Sync on: the speed Sync sets, shown in green (moving it turns Sync off) */
  sync: number | null;
  /** why it can't move now (A before it's on its deck) */
  why: string | null;
  /** the overlay's Esc closes the open menu first (the store's) */
  addCloser?: (close: () => void) => () => void;
  /** + at the bottom (a CDJ's, the default) or the top: the person's setting (M8) */
  plusDown?: boolean;
}

/**
 * Tempo's label: its name with a chevron that opens the range menu (438):
 * ±6, ±8, ±10, ±16%, each with its BPM span at A's tempo.
 */
function TempoMenu({ deck, t }: { deck: DeckId; t: TempoProps }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return t.addCloser?.(() => closeRef.current());
  }, [open, t.addCloser]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className={styles.tempoLabel}>
      <button
        ref={btn}
        type="button"
        className={styles.tempoBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Deck ${deck} tempo range, ±${t.range}%`}
        onClick={() => setOpen((o) => !o)}
      >
        Tempo <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div
          ref={menu}
          className={styles.tempoMenu}
          role="menu"
          aria-label={`Deck ${deck} tempo range`}
          onKeyDown={(e) => {
            const items = Array.from(
              menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [],
            );
            const i = items.indexOf(document.activeElement as HTMLElement);
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const n = items.length;
              items[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n]?.focus();
            }
          }}
        >
          {TEMPO_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="menuitemradio"
              aria-checked={r === t.range}
              className={styles.tempoItem}
              onClick={() => {
                t.onRange(r);
                close();
              }}
            >
              <span>±{r}%</span>
              <span className={styles.mono}>{tempoSpan(r, t.bpm) ?? ''}</span>
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

/**
 * A deck's controls from a list (`DECK_CONTROLS`): 37g's six vertical
 * faders, Volume · Hi · Mid · Low · Filter · Tempo, KILL under the value on
 * the EQ bands (`layout="faders"`, 3b); `rows` is step 3's slider a row.
 */
export function DeckColumn({
  deck,
  values,
  controls = DECK_CONTROLS,
  layout = 'faders',
  onChange,
  onKill,
  tempo,
  why,
  gain,
}: {
  deck: DeckId;
  values: DeckValues;
  controls?: readonly ControlSpec<DeckControlId>[];
  layout?: 'rows' | 'faders';
  onChange: (id: DeckControlId, v: number) => void;
  onKill: (band: Band) => void;
  tempo?: TempoProps;
  /** why the channel (Volume, EQ, KILL, Filter) can't act now, or null (M6) */
  why?: string | null;
  /** Auto-gain's trim on this deck, dB (S6), when it's on */
  gain?: number | null;
}) {
  return (
    <div
      className={styles.deck}
      data-deck={deck.toLowerCase()}
      data-layout={layout}
      role="group"
      aria-label={`Deck ${deck}`}
    >
      {controls.map((spec) => {
        if (spec.id === 'tempo') {
          if (!tempo) return null;
          const r = tempo.range;
          // its finest step at the range: 0.02% on ±6/8, 0.05% on ±10/16 (S1)
          const ranged = { ...spec, min: -r, max: r, step: tempoStep(r) };
          const shown = tempo.sync ?? values.tempo;
          return (
            <Slider
              key={spec.id}
              spec={ranged}
              deck={deck}
              value={Math.max(-r, Math.min(r, shown))}
              vertical={layout === 'faders'}
              label={<TempoMenu deck={deck} t={tempo} />}
              tone={tempo.sync !== null ? 'sync' : undefined}
              disabled={Boolean(tempo.why)}
              title={
                tempo.why ??
                (tempo.sync !== null ? 'Set by Sync · moving it turns Sync off' : undefined)
              }
              onChange={(v) => onChange('tempo', v)}
              onReset={() => onChange('tempo', 0)}
              plusDown={layout === 'faders' ? tempo.plusDown !== false : undefined}
              fine
            />
          );
        }
        return (
          <Slider
            key={spec.id}
            spec={spec}
            deck={deck}
            value={values[spec.id]}
            vertical={layout === 'faders'}
            killed={spec.kill ? values.kill[spec.kill] : undefined}
            disabled={Boolean(why)}
            title={why ?? undefined}
            onChange={(v) => onChange(spec.id, v)}
            onKill={spec.kill ? () => onKill(spec.kill!) : undefined}
            meter={
              spec.id === 'volume' && layout === 'faders' ? (
                <DeckMeter deck={deck === 'A' ? 'a' : 'b'} />
              ) : undefined
            }
            foot={
              spec.id === 'volume' && gain !== null && gain !== undefined ? (
                <span data-dj-gain={deck.toLowerCase()} title="Auto-gain: matched to A’s loudness">
                  {gainWords(gain)}
                </span>
              ) : undefined
            }
          />
        );
      })}
    </div>
  );
}

/* ── the mixer ────────────────────────────────────────────────────────── */

export function DjMixer({
  store,
  session,
  outputs,
  prefs = djPrefs(),
}: {
  store: DjModeStore;
  session: DjMixSession;
  outputs?: DjOutputs;
  prefs?: DjPrefsStore;
}) {
  const s = useDjMode(store);
  const v = useMixView(session);
  const p = useSyncExternalStore(prefs.subscribe, prefs.snapshot, prefs.snapshot);
  const [reduce] = useState(prefersReducedMotion);
  // Auto-gain as the person set it (S6)
  useEffect(() => {
    session.setAutoGain(p.autoGain);
  }, [session, p.autoGain]);
  // Quantize as the person set it (step 6)
  useEffect(() => {
    session.setQuantize(p.quantize);
  }, [session, p.quantize]);

  // the store borrows Back, Esc's rule, ⇧P and B's place
  useEffect(() => {
    store.setMixer({
      blending: () => session.blending,
      backOverBar: (done) => session.backOverBar(done),
      end: () => session.end(),
      playB: () => {
        const phase = session.snapshot().phase;
        // a second press while B is about to come in does nothing (review L5)
        if (phase === 'starting') return true;
        return phase === 'playing' ? session.pauseB() : session.playB();
      },
      positionB: () => session.positionB(),
      positionA: () => session.positionA(),
      holdsTrack: () => session.snapshot().aOnDeck,
      togglePhones: (d) => session.setPhones(d, !session.snapshot().decks[d].phones),
      toggleKeyLock: (d) => session.setKeyLock(d, !session.snapshot().decks[d].keyLock),
      jump: (d, seconds) => session.jump(d, seconds),
      deckPlaying: (d) => session.deckPlaying(d),
      previewB: (on) => session.previewB(on),
      parkB: (p) => session.parkB(p),
      grab: (d) => session.grab(d),
      moveHand: (d, offset) => session.moveHand(d, offset),
      letGo: (d) => session.letGo(d),
      releaseHand: () => session.releaseHand(),
      nudge: (d, dir) => session.nudge(d, dir),
      aOnDeck: () => session.snapshot().aOnDeck,
      handOver: () => session.handOver('press'),
      handOverWhy: () => session.handOverWhy(),
      undoHandOver: () => session.undoHandOver(),
      ownsAdvance: () => session.ownsAdvance(),
      loopAction: (d, action) => loopAction(session, d, action),
      toggleQuantize: () => {
        const on = !prefs.snapshot().quantize;
        prefs.set({ quantize: on });
        store.announce(
          on
            ? 'Quantize on: jumps, cues and loops on the beat'
            : 'Quantize off: at once, where you press',
        );
      },
    });
    // the outputs are watched while DJ mode is on (37r)
    outputs?.start();
    return () => {
      session.end();
      outputs?.stop();
      store.setMixer(null);
    };
  }, [store, session, outputs, prefs]);

  // the decks follow the lanes (B's cue and grid, A's track)
  const lanes = useRef({ a: s.a, b: s.b });
  lanes.current = { a: s.a, b: s.b };
  const key = `${laneKey(s.a)}§${laneKey(s.b)}`;
  useEffect(() => {
    session.setLanes(mixLane(lanes.current.a), mixLane(lanes.current.b));
  }, [key, session]);

  // the heads' BPM (M2): what each deck plays at, by its Tempo or Sync
  const syncNow = v.sync && v.syncable && !v.solo;
  const bpmA = s.a?.info?.bpm ?? s.a?.grid?.bpm ?? null;
  const bpmB = s.b?.info?.bpm ?? s.b?.grid?.bpm ?? null;
  const rateBShown = syncNow
    ? (v.rateB ?? syncRatioFromBpm(bpmA, bpmB)?.rate ?? null)
    : tempoRate(v.values.B.tempo);
  const rateAShown = v.rateA;

  // the header's line and Esc's rule read the phase from the store
  useEffect(() => {
    store.setMix({
      phase: v.phase,
      window: v.window,
      rateB: v.rateB,
      // B on its own (37j) has nothing to be synced to
      sync: v.sync && v.syncable && !v.solo,
      levels: v.levels,
      handed: v.handed,
      solo: v.solo,
      previewB: v.previewB,
      hand: v.hand,
      rates: { A: rateAShown, B: rateBShown },
      loops: v.loops,
    });
  }, [
    v.loops,
    rateAShown,
    rateBShown,
    store,
    v.phase,
    v.window,
    v.rateB,
    v.sync,
    v.syncable,
    v.levels,
    v.handed,
    v.solo,
    v.previewB,
    v.hand,
  ]);

  const aTitle = s.a?.track.title || 'A';
  const bTitle = s.b?.track.title || 'B';
  const status = useMemo(() => statusWords(v, aTitle, bTitle), [v, aTitle, bTitle]);
  // the meters (S5) only while the overlay shows, with the decks made
  const root = useRef<HTMLElement>(null);
  useMeters(session, s.on && s.open && Boolean(s.b) && v.phase !== 'idle', root);
  if (!s.on || !s.b) return null;

  const playing = v.phase === 'playing' || v.phase === 'starting';
  // while B is about to come in the button waits (a second press does nothing, review L5)
  const canPlay = ['ready', 'paused', 'playing'].includes(v.phase);
  const syncOn = v.sync && v.syncable && !v.solo;
  const backing = v.phase === 'backing';
  // B's tempo as Sync sets it (37g: "−1.6%" in green): as it plays, else as it will
  const aBpm = s.a?.info?.bpm ?? s.a?.grid?.bpm ?? null;
  const bBpm = s.b?.info?.bpm ?? s.b?.grid?.bpm ?? null;
  const syncRate = v.rateB ?? syncRatioFromBpm(aBpm, bBpm)?.rate ?? 1;
  const syncPct = Math.round((syncRate - 1) * 1000) / 10;
  const playWhy = canPlay ? null : status;
  const handWhy = session.handOverWhy();
  const handing = v.phase === 'handing';
  // deck A's channel and the centre before Play B (M6): live through the element strip
  const aWhy = channelWhy(v);

  return (
    <section
      ref={root}
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
            className={styles.sync}
            aria-pressed={v.quantize}
            aria-label="Quantize"
            aria-keyshortcuts="Q"
            title={
              v.quantize
                ? 'Quantize: jumps, cues and loops land on the beat (Q)'
                : 'Quantize off: jumps, cues and loops at once, where you press (Q)'
            }
            data-dj-quantize=""
            onClick={() => store.laneKey('Q', null)}
          >
            <span className={styles.syncDot} aria-hidden="true" />Q
          </button>
          <button
            type="button"
            className={styles.handOver}
            aria-disabled={handWhy !== null}
            aria-keyshortcuts="H"
            title={handWhy ?? `Hand over: ${bTitle} becomes the player’s track (H)`}
            data-dj-hand-over=""
            data-handing={handing ? '' : undefined}
            onClick={() => store.handOver()}
          >
            {handing ? 'Handing over…' : 'Hand over to B'}
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
            disabled={Boolean(aWhy)}
            title={aWhy ?? undefined}
            className={styles.xf}
            onChange={(x) => session.setCentre('xf', x)}
          />
          <MasterMeter />
        </div>
        <div className={styles.echo}>
          {ECHO_CONTROLS.map((spec) => (
            <Slider
              key={spec.id}
              spec={spec}
              deck={null}
              value={v.values[spec.id]}
              className={styles.echoBox}
              disabled={Boolean(aWhy)}
              title={aWhy ?? undefined}
              onChange={(x) => session.setCentre(spec.id, x)}
            />
          ))}
        </div>
        {outputs ? (
          <MonitorBlock session={session} outputs={outputs} addCloser={(c) => store.addCloser(c)} />
        ) : null}
      </div>
      {(['A', 'B'] as const).map((deck) => (
        <DeckColumn
          key={deck}
          deck={deck}
          values={v.values[deck]}
          onChange={(id, x) => session.setDeck(deck, id, x)}
          onKill={(band) => session.setKill(deck, band, !v.values[deck].kill[band])}
          why={deck === 'A' ? aWhy : null}
          gain={v.autoGain && deck === 'B' ? v.gain.B : null}
          tempo={{
            plusDown: p.tempoPlus !== 'up',
            range: v.decks[deck].range,
            onRange: (r: TempoRange) => session.setRange(deck, r),
            bpm: aBpm,
            sync: deck === 'B' && syncOn ? syncPct : null,
            addCloser: (c: () => void) => store.addCloser(c),
            why:
              deck === 'A' && !v.aOnDeck
                ? 'A’s tempo moves once A is on its deck (Play B): the player’s own speed is untouched'
                : v.phase === 'starting'
                  ? TEMPO_STARTING_WHY
                  : null,
          }}
        />
      ))}
    </section>
  );
}

/** Auto-gain's trim in words (S6): "Gain +2.5 dB", "Gain 0 dB". */
export function gainWords(db: number): string {
  const r = Math.round(db * 10) / 10;
  if (r === 0) return 'Gain 0 dB';
  return `Gain ${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(1)} dB`;
}

/**
 * Why deck A's channel and the centre wait (M6), or null: before Play B
 * they act on the playing track through the element strip; a player that
 * can't route it leaves them to deck A, so they wait for Play B and say so.
 */
export function channelWhy(v: Pick<MixView, 'aOnDeck' | 'elementLive' | 'solo'>): string | null {
  if (v.aOnDeck || v.elementLive || v.solo) return null;
  return 'Deck A’s channel acts once A is on its deck (Play B): this player can’t send the playing track through it';
}

/** A loop or beatjump key on a deck (step 6), on the session. */
export function loopAction(session: DjMixSession, deck: DeckId, action: LoopAction): boolean {
  switch (action) {
    case 'loop':
      return session.autoLoop(deck);
    case 'in':
      return session.loopInHere(deck);
    case 'out':
      return session.loopOutHere(deck);
    case 'reloop':
      return session.reloop(deck);
    case 'half':
      session.resizeLoop(deck, 0.5);
      return true;
    case 'double':
      session.resizeLoop(deck, 2);
      return true;
    case 'back':
      return session.beatjump(deck, -1);
    case 'on':
      return session.beatjump(deck, 1);
  }
}

/** B on its way in (on A's next bar, L2): both Tempos wait, as B's map is being laid. */
export const TEMPO_STARTING_WHY = 'Tempo moves once B is in, on A’s next bar';

/** The one line under the buttons: where the blend is, in words (not a live region). */
export function statusWords(v: MixView, a: string, b: string): string {
  switch (v.phase) {
    case 'loading':
      return `Getting ${b} onto its deck…`;
    case 'failed':
      return v.error ?? 'The decks couldn’t be made ready';
    case 'ready':
      // B running in the headphones: Play B takes it from where it is (M7)
      if (v.previewB)
        return v.sync && v.syncable
          ? `${b} in the headphones · Play B brings it in from here, onto ${a}’s beat`
          : `${b} in the headphones · Play B brings it in from here`;
      return v.sync && v.syncable
        ? `${b} starts at its mix-in on ${a}’s next bar, at ${a}’s tempo`
        : `${b} starts at its mix-in${v.syncWhy ? ` · ${v.syncWhy}` : ''}`;
    case 'starting':
      return `${b} comes in on ${a}’s next bar`;
    case 'playing':
      if (v.solo) return `${b} on its own · Hand over makes it the player’s track`;
      return v.rateB !== null
        ? `Both on the speakers · ${b} on ${a}’s beat`
        : 'Both on the speakers';
    case 'paused':
      return `${b} paused · Play B carries on on ${a}’s next bar`;
    case 'backing':
      return `Bringing ${a} back over a bar`;
    case 'handing':
      return `Handing over to ${b}: ${a} out over a bar`;
    default:
      return '';
  }
}
