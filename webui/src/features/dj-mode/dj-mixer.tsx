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
import type { DjModeStore, LaneState } from './dj-mode-store';
import type { DjOutputs } from './dj-outputs-host';

import {
  clampTo,
  controlName,
  DECK_CONTROLS,
  ECHO_CONTROLS,
  TEMPO_RANGES,
  tempoSpan,
  XF_CONTROL,
  type Band,
  type ControlSpec,
  type DeckControlId,
  type DeckValues,
  type TempoRange,
} from './dj-mixer.logic';
import styles from './dj-mixer.module.css';
import { MonitorBlock } from './dj-monitor';
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
}) {
  const words = spec.words(value, killed);
  const name = controlName(deck, spec);
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (onReset && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
      onReset();
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
      <input
        type="range"
        className={styles.range}
        aria-orientation={vertical ? 'vertical' : undefined}
        data-vertical={vertical ? '' : undefined}
        onDoubleClick={onReset}
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
}: {
  deck: DeckId;
  values: DeckValues;
  controls?: readonly ControlSpec<DeckControlId>[];
  layout?: 'rows' | 'faders';
  onChange: (id: DeckControlId, v: number) => void;
  onKill: (band: Band) => void;
  tempo?: TempoProps;
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
          const ranged = { ...spec, min: -r, max: r };
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
            onChange={(v) => onChange(spec.id, v)}
            onKill={spec.kill ? () => onKill(spec.kill!) : undefined}
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
}: {
  store: DjModeStore;
  session: DjMixSession;
  outputs?: DjOutputs;
}) {
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
    });
    // the outputs are watched while DJ mode is on (37r)
    outputs?.start();
    return () => {
      session.end();
      outputs?.stop();
      store.setMixer(null);
    };
  }, [store, session, outputs]);

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
      // B on its own (37j) has nothing to be synced to
      sync: v.sync && v.syncable && !v.solo,
      levels: v.levels,
      handed: v.handed,
      solo: v.solo,
      previewB: v.previewB,
      hand: v.hand,
    });
  }, [
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
          tempo={{
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
