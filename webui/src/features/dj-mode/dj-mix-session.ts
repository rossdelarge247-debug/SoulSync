import type { AutomatedParam } from '@/features/engine/automation';
import type { Knot } from '@/features/engine/clock';
/**
 * DJ mode's decks (Brief F, step 3: 37g, 37h; 412, 416, 421, 424, 432–434):
 * the two-deck engine (features/engine) driven by hand.
 *
 * - **The engine is made lazily**, the first time B is loaded, on the
 *   player's AudioContext and into its analyser (as auto-mix's is), never
 *   behind the mixing setting (425), and auto-mix's controller and planner
 *   never run for it (while A is on DJ mode's deck auto-mix is held:
 *   `SoulSyncAutomix.hold`). When B goes (DJ mode off, the overlay closed,
 *   B removed) the decks let their windows go and the engine is disposed,
 *   so with DJ mode off nothing of it runs and normal playback never
 *   changes. A context that stops under the decks (suspended, interrupted,
 *   closed, stalled) or a worklet error ends the blend at once with A back
 *   on its element.
 * - **Cued:** B's window is fetched from its own mix-in (434), 3 minutes,
 *   and loaded on deck B; A's window from where the player is, kept fresh
 *   while B waits (A has a minute of its window left: fetched again).
 * - **Play B (421):** A moves onto deck A at the element's position
 *   (0.12 s ahead, on the context's clock), the decks fade in over 80 ms as
 *   the element fades out, and the element plays on **muted**: it keeps
 *   time for the player (its position, the bar, scrobbling, the Media
 *   Session, the queue and its own advance all stay the element's; 432).
 *   B starts at its cue on A's next bar: locked to A's beats with Sync
 *   (dj-sync.ts), at its own tempo without.
 * - **Back (413):** mid-blend the crossfader goes to A over one bar, B
 *   stops, and A goes back to the element (`release`): the element is
 *   unmuted and fades in over 80 ms as the decks fade out (auto-mix's
 *   rejoin). Closing, DJ mode off, a seek, another track or the track's end
 *   take the hard-stop path: the decks fade out over 40 ms and the element
 *   is unmuted at the player's level at once (auto-mix's `hardStop`).
 * - **The windows' ends:** a bar before B's 3 minutes (or A's) run out,
 *   the fader comes back to A over a bar by itself and A goes back to the
 *   element: never silent, never "playing" while silent. Hand over and the
 *   other ends are step 4's.
 */
import type { DeckData } from '@/features/engine/engine';
import type { BeatGrid } from '@/features/engine/grid';
import type { DeckId, ParamKey, ParamName } from '@/features/engine/score';

import { glideKnots } from '@/features/engine/clock';
import { MAX_WINDOW_S } from '@/features/engine/loader';
import { rampFor } from '@/features/engine/score';
import { windowLevels } from '@/features/engine/windows';

import type { Band, DeckControlId, MixValues } from './dj-mixer.logic';

import {
  DEFAULT_TEMPO_RANGE,
  defaultMix,
  engineTargets,
  killWords,
  tempoRate,
  tempoWords,
  type TempoRange,
} from './dj-mixer.logic';
import {
  cueBeat,
  lockedKnots,
  MIN_LEAD_S,
  nextBar,
  rateAt,
  syncRatio,
  syncRatioFromBpm,
  type SyncRatio,
} from './dj-sync';

export type MixPhase =
  /** nothing loaded on the decks */
  | 'idle'
  /** the windows are on their way */
  | 'loading'
  /** B cued on its deck; A still on the element */
  | 'ready'
  /** Play B pressed: A on its deck, B starts on A's next bar */
  | 'starting'
  | 'playing'
  /** B paused (Pause B); A stays on its deck */
  | 'paused'
  /** Back: the fader on its way to A over a bar */
  | 'backing'
  | 'failed';

export interface MixLane {
  id: string;
  title: string;
  grid: BeatGrid | null;
  bpm: number | null;
  /** B: its cue (mix-in), seconds */
  cue: number;
  /** A: its length, seconds */
  duration: number | null;
  /** its grid is being worked out (Brief A's bar in the lane) */
  analysing?: boolean;
}

export interface MixView {
  phase: MixPhase;
  error: string | null;
  values: MixValues;
  /** Sync is on (416: on by default) */
  sync: boolean;
  /** Sync can work: both have their grids, close enough in tempo */
  syncable: boolean;
  /** why not, in words */
  syncWhy: string | null;
  /** B's speed while Sync stretches it (1.0 is its own tempo) */
  rateB: number | null;
  /** B's window on its deck, track seconds (424: the thin line over its waveform) */
  window: { start: number; end: number } | null;
  /** A is playing on deck A (the element muted under it) */
  aOnDeck: boolean;
  /** each deck's strip and Tempo (3b): its range, Key lock, Headphones */
  decks: Record<DeckId, DeckSettings>;
  /** the Monitor block (441): Cue mix 0 (cue only) … 100 (the speakers), Cue volume in dB */
  monitor: { mix: number; volume: number };
  /** each deck's window as levels, for a zoomed lane's detail (37s: "the transient shapes") */
  levels: Record<DeckId, DeckLevels | null>;
}

/** A window's level every `step` seconds from `offset` (track seconds), 0–1. */
export interface DeckLevels {
  offset: number;
  step: number;
  levels: Float32Array;
}

/** A zoomed lane's detail: 20 ms a level (a 3-minute window is 9,000). */
export const LEVEL_STEP_S = 0.02;

export interface DeckSettings {
  /** Tempo's range, ±% (438) */
  range: TempoRange;
  /** the key stays as the tempo moves (440; on by default): time-stretch; off, varispeed */
  keyLock: boolean;
  /** heard in the headphones (443) */
  phones: boolean;
}

export function defaultDecks(): Record<DeckId, DeckSettings> {
  return {
    A: { range: DEFAULT_TEMPO_RANGE, keyLock: true, phones: false },
    // 443: B goes into the headphones when it loads (open for Ross: keep the auto-on?)
    B: { range: DEFAULT_TEMPO_RANGE, keyLock: true, phones: true },
  };
}

export interface EngineLike {
  context: BaseAudioContext;
  sampleRate: number;
  graph: {
    master: { gain: AudioParam };
    /** each deck's send to the cue bus (the headphones, 3b) */
    decks?: Record<DeckId, { cueSend: { gain: AudioParam } }>;
    out?: AudioNode;
    cueBus?: AudioNode;
  };
  params(deck: DeckId): Record<ParamName, AutomatedParam>;
  load(deck: DeckId, data: DeckData): void;
  unload(deck: DeckId): void;
  play(deck: DeckId, at: number, from: number, rate?: number): void;
  map(deck: DeckId, from: number, knots: Knot[], jump?: boolean): void;
  current(deck: DeckId): Knot[];
  stop(deck: DeckId, atFrame: number): void;
  mode(deck: DeckId, mode: 'resample' | 'stretch'): void;
  position(deck: DeckId, at?: number): number | null;
  setPaused(on: boolean): void;
  /** the context stopping under the decks (lifecycle.ts), not the listener's own pause */
  onLifecycle?(fn: (e: { kind: 'interrupted' | 'resumed'; reason: string }) => void): () => void;
  /** the worklet node: its processor's errors end a blend */
  node?: { onprocessorerror: ((e: Event) => void) | null };
  dispose?(): void;
}

export interface PlayerPort {
  audio(): HTMLAudioElement | null;
  state(): { volume?: number; muted?: boolean } | null;
  /** the player's own seek (a cue on A while A is on its element) */
  seek?(seconds: number): void;
}

export interface SessionDeps {
  player: PlayerPort;
  /** the engine, made once (null: this browser can't) */
  engine: () => Promise<EngineLike | null>;
  fetchWindow: (
    ctx: BaseAudioContext,
    id: string,
    start: number,
    dur: number,
    signal?: AbortSignal,
  ) => Promise<DeckData>;
  say: (words: string) => void;
  /**
   * auto-mix (with the mixing features shown) is held while A is on DJ
   * mode's deck: no plans, no countdowns, the element left muted (review H1)
   */
  autoHold?: (on: boolean) => void;
  /** why this page can't run the decks (plain http on another machine's address), or null */
  support?: () => string | null;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  /** tell the page's store the phase (the header's line, Esc's rule) */
  onPhase?: (view: MixView) => void;
}

/** Scheduling lead: the decks start this far ahead (auto-mix's AHEAD_S). */
export const AHEAD_S = 0.12;
/** The element and the decks cross over this long (auto-mix's FADE_S). */
export const FADE_S = 0.08;
/** The hard stop's fade. */
export const HARD_S = 0.04;
/** A control's change is a ramp this long: no zipper, no click. */
export const RAMP_S = 0.02;
/** A window starts this far before where it's needed. */
const PRE_S = 0.5;
/**
 * While B waits, A's window is fetched again when less than this is left of
 * it, and Play B takes A onto its deck at once when at least this much is
 * ahead (re-review N4: a fresh window is 180 s, so it's fetched again about
 * once a minute while B waits, and Play B doesn't wait on a fetch unless the
 * player has just jumped; a blend can last two minutes on A's deck before
 * the fader comes back by itself).
 */
const A_AHEAD_S = 120;
/** How often the windows' ends are watched while A is on its deck (ms). */
const WATCH_MS = 250;
/**
 * Margin past a bar before a window's end when the fader starts back: the
 * watch is a timer, and a background tab's timers can run a second late
 * (review L1).
 */
const END_MARGIN_S = 1.5;
const FRESH_MS = 2000;

function covers(
  w: { offset: number; duration: number } | null,
  pos: number,
  ahead: number,
): boolean {
  return Boolean(w && pos >= w.offset && pos + ahead <= w.offset + w.duration);
}

export class DjMixSession {
  private v: MixView;
  private readonly listeners = new Set<() => void>();
  private readonly d: Required<Omit<SessionDeps, 'autoHold' | 'onPhase' | 'support'>> &
    Pick<SessionDeps, 'autoHold' | 'onPhase' | 'support'>;
  private engine: EngineLike | null = null;
  private making: Promise<EngineLike | null> | null = null;
  private a: MixLane | null = null;
  private b: MixLane | null = null;
  private aWin: { offset: number; duration: number } | null = null;
  private bWin: { offset: number; duration: number } | null = null;
  private loadingA = false;
  /** each preparation's generation: an answer for an older one is dropped */
  private gen = 0;
  private timers = new Set<unknown>();
  private watchTimer: unknown = null;
  private freshTimer: unknown = null;
  private fadeTimer: unknown = null;
  private el: HTMLAudioElement | null = null;
  private master = 0;
  private suspended = false;
  private pausedAt: number | null = null;
  private applied: Partial<Record<ParamKey, number>> = {};
  private ratio: SyncRatio | null = null;
  private rateA = 1;
  /** the element's own speed when A went onto its deck: A goes back at it (413) */
  private rateA0 = 1;
  /** the session's own seek of the element (a cue on A): not a person's */
  private ownSeek = false;
  private ended = false;
  /** a lane was waiting for its grid: Sync arriving with it is said (420) */
  private waited = false;
  /** each start of B's: a later start's timer replaces an earlier one's */
  private startToken = 0;
  /** the last start (Sync toggled while B is starting re-runs it) */
  private started: { T: number; posA: number; bFrom: number | null; Tb: number } | null = null;
  /** the windows' fetches on their way (aborted when the lanes change, review L2) */
  private fetching: AbortController | null = null;
  private offEngine: (() => void) | null = null;
  private held = false;
  private aRefetched = false;
  /** B's cue moved under a blend: its window is fetched again after it */
  private bStale = false;

  constructor(deps: SessionDeps) {
    this.d = {
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id as number),
      ...deps,
    };
    this.v = {
      phase: 'idle',
      error: null,
      values: defaultMix(),
      sync: true,
      syncable: false,
      syncWhy: null,
      rateB: null,
      window: null,
      aOnDeck: false,
      decks: defaultDecks(),
      monitor: { mix: 0, volume: -6 },
      levels: { A: null, B: null },
    };
  }

  // ── store ──────────────────────────────────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): MixView => this.v;

  private update(patch: Partial<MixView>): void {
    const was = this.v.phase;
    this.v = { ...this.v, ...patch };
    for (const fn of this.listeners) fn();
    if (patch.phase !== undefined && patch.phase !== was) this.d.onPhase?.(this.v);
  }

  private say(words: string): void {
    try {
      this.d.say(words);
    } catch {
      /* no live region */
    }
  }

  // ── timers ─────────────────────────────────────────────────────────────

  private later(fn: () => void, ms: number): void {
    const id = this.d.setTimeout(
      () => {
        this.timers.delete(id);
        fn();
      },
      Math.max(0, ms),
    );
    this.timers.add(id);
  }

  private clearLater(): void {
    for (const id of this.timers) this.d.clearTimeout(id);
    this.timers.clear();
    if (this.watchTimer !== null) this.d.clearTimeout(this.watchTimer);
    this.watchTimer = null;
  }

  // ── what's loaded ──────────────────────────────────────────────────────

  get blending(): boolean {
    return ['starting', 'playing', 'backing'].includes(this.v.phase);
  }

  /** B's place in its track now, while it plays (lane B's playhead), else null. */
  positionB(): number | null {
    if (!this.engine || !['starting', 'playing', 'backing', 'paused'].includes(this.v.phase))
      return null;
    if (this.v.phase === 'paused') return this.pausedAt;
    const p = this.engine.position('B');
    return p === null ? null : p;
  }

  /**
   * The lanes as they are (the mixer calls this whenever they change): B
   * with its cue and grid, A with its grid. A new B, a new cue or a new A
   * (the player moved on) prepares the decks again; no B lets them go.
   */
  setLanes(a: MixLane | null, b: MixLane | null): void {
    const was = { a: this.a, b: this.b };
    this.a = a;
    this.b = b;
    if (this.v.aOnDeck && a && b && was.a?.id === a.id && was.b?.id === b.id) {
      // the same two tracks under a blend: B's grid (and with it its cue)
      // may land now (re-review N1). B plays on as it is, by ear: Sync shows
      // off and a press locks it to A's beat; its new cue is for the next go
      if (Math.abs((was.b?.cue ?? b.cue) - b.cue) > 0.05) this.bStale = true;
      const landed = !was.b?.grid && Boolean(b.grid);
      if (landed && this.v.rateB === null && this.v.sync) {
        this.waited = false;
        this.update({ sync: false });
        this.syncCheck();
        this.say(`${b.title || 'B'} has its beat grid now: Sync locks it to the beat`);
        return;
      }
      this.syncCheck();
      return;
    }
    this.syncCheck();
    if (!a || !b) {
      if (this.v.phase !== 'idle') this.end();
      return;
    }
    const sameB = was.b?.id === b.id && Math.abs((was.b?.cue ?? -1) - b.cue) < 0.05;
    const sameA = was.a?.id === a.id;
    // a grid that lands while cued only changes Sync's answer (above)
    if (sameA && sameB && this.v.phase !== 'idle' && this.v.phase !== 'failed') return;
    if (this.blending || this.v.aOnDeck) {
      // B can't change mid-blend (the store refuses); A moved on, or a new B
      // while B was paused (review M1): the decks stop first, then prepare
      if (sameA && sameB) return;
      this.hardStop(null, false);
    }
    this.ratio = null;
    void this.prepare(!sameB);
  }

  private syncCheck(): void {
    const { a, b } = this;
    if (a?.analysing || b?.analysing) this.waited = true;
    let why: string | null = null;
    if (!a || !b) why = null;
    else if (!a.grid)
      why = `${a.title || 'The playing track'} has no beat grid: Sync is off, blend by ear`;
    else if (!b.grid)
      why = `${b.title || 'The second track'} has no beat grid: Sync is off, blend by ear`;
    else if (!syncRatioFromBpm(a.bpm ?? 60 / a.grid.period, b.bpm ?? 60 / b.grid.period))
      why = 'The two are too far apart in tempo for Sync: blend by ear';
    const syncable = Boolean(a && b && !why);
    if (syncable !== this.v.syncable || why !== this.v.syncWhy) {
      const wasable = this.v.syncable;
      this.update({ syncable, syncWhy: why });
      // 420: Sync turns on by itself when both grids exist, and says so once
      // (when a grid lands after its analysis, not as a track loads with its grid)
      if (syncable && !wasable && this.waited && this.v.sync && b && !this.blending) {
        this.waited = false;
        this.say(`Sync on: ${b.title || 'B'} will play at ${a?.title || 'A'}’s tempo`);
      }
    }
  }

  // ── the engine ─────────────────────────────────────────────────────────

  private async ensureEngine(): Promise<EngineLike | null> {
    if (this.engine) return this.engine;
    this.making ??= this.d.engine().catch(() => null);
    const engine = await this.making;
    this.making = null;
    if (!engine || this.engine) return this.engine ?? engine;
    this.engine = engine;
    try {
      engine.graph.master.gain.cancelScheduledValues(0);
      engine.graph.master.gain.value = 0;
    } catch {
      /* a closed context */
    }
    this.master = 0;
    this.applied = {};
    // the context stopping under the decks (not the listener's Pause, which
    // setPaused marks) or the worklet failing: A back on its element at once (review H2)
    const off = engine.onLifecycle?.((e) => {
      if (e.kind === 'interrupted')
        this.broke(
          `The decks stopped (${e.reason}): ${this.a?.title || 'A'} is back on the player`,
        );
    });
    if (engine.node) {
      engine.node.onprocessorerror = () => {
        // the worklet is dead: it goes first, then A is back on its element
        this.dropEngine();
        this.broke('The decks failed: the blend stopped');
      };
    }
    this.offEngine = () => {
      off?.();
      if (engine.node) engine.node.onprocessorerror = null;
    };
    this.applyAll();
    this.applyPhones();
    return engine;
  }

  /** Something under the decks stopped: never "playing" while silent. */
  private broke(words: string): void {
    if (this.v.aOnDeck) this.hardStop(words);
    else if (this.blending) this.hardStop(words);
  }

  /** Let the engine go (its worklet, graph and lifecycle watch, review M4). */
  private dropEngine(): void {
    const engine = this.engine;
    if (!engine) return;
    this.offEngine?.();
    this.offEngine = null;
    this.engine = null;
    this.applied = {};
    this.aWin = null;
    this.bWin = null;
    try {
      engine.dispose?.();
    } catch {
      /* a closed context */
    }
    // whoever routes off the engine's graph (the Monitor) lets it go too
    this.update({});
  }

  /** Auto-mix held or let go (review H1). */
  private hold(on: boolean): void {
    if (on === this.held) return;
    this.held = on;
    try {
      this.d.autoHold?.(on);
    } catch {
      /* never block the decks */
    }
  }

  /** A new fetch's signal; the one before it is aborted (review L2). */
  private signal(): AbortSignal {
    this.fetching?.abort();
    this.fetching = new AbortController();
    return this.fetching.signal;
  }

  private now(): number {
    return this.engine?.context.currentTime ?? 0;
  }

  /** The player's level (its volume, linear; 0 when muted): the decks' master follows it. */
  private level(): number {
    let st: { volume?: number; muted?: boolean } | null = null;
    try {
      st = this.d.player.state();
    } catch {
      st = null;
    }
    if (!st) return 0.7;
    return st.muted ? 0 : Math.max(0, Math.min(1, (st.volume ?? 70) / 100));
  }

  private beatPeriodA(): number | null {
    const g = this.a?.grid;
    if (g) {
      const pos = this.engine?.position('A') ?? this.d.player.audio()?.currentTime ?? 0;
      return g.periodAt(g.beatAt(pos));
    }
    return this.a?.bpm ? 60 / this.a.bpm : null;
  }

  /** One bar of A in output seconds (2 s without a grid). */
  private barSeconds(): number {
    const p = this.beatPeriodA();
    return p ? (4 * p) / this.rateA : 2;
  }

  private param(key: ParamKey): AutomatedParam | null {
    if (!this.engine) return null;
    const [deck, name] = key.split('.') as [DeckId, ParamName];
    return this.engine.params(deck)[name] ?? null;
  }

  /** Every param to the controls' values: changed ones ramp over RAMP_S. */
  private applyAll(at?: number): void {
    if (!this.engine) return;
    const targets = engineTargets(this.v.values, this.beatPeriodA());
    const t = at ?? this.now();
    for (const [key, value] of Object.entries(targets) as [ParamKey, number][]) {
      if (this.applied[key] !== undefined && Math.abs(this.applied[key]! - value) < 1e-9) continue;
      const p = this.param(key);
      if (!p) continue;
      const name = key.split('.')[1] as ParamName;
      if (this.applied[key] === undefined) p.reset(t, value);
      else {
        p.hold(t);
        p.ramp(rampFor(name), t + RAMP_S, value);
      }
      this.applied[key] = value;
    }
  }

  // ── cueing ─────────────────────────────────────────────────────────────

  private async prepare(newB: boolean): Promise<void> {
    const gen = ++this.gen;
    // what an earlier preparation still fetches isn't wanted any more (review L2)
    this.fetching?.abort();
    this.fetching = null;
    const { a, b } = this;
    if (!a || !b) return;
    this.stopFresh();
    const why = this.d.support?.() ?? null;
    if (why) {
      // the lanes still work; Play B says why it can't (once)
      if (this.v.error !== why) this.say(why);
      this.update({ phase: 'failed', error: why });
      return;
    }
    this.update({ phase: 'loading', error: null, ...(newB ? { window: null } : {}) });
    const engine = await this.ensureEngine();
    if (gen !== this.gen) return;
    if (!engine) {
      this.update({
        phase: 'failed',
        error: 'This browser can’t play two decks, so B can’t be played here',
      });
      return;
    }
    try {
      if (newB || !this.bWin) {
        const data = await this.d.fetchWindow(
          engine.context,
          b.id,
          Math.max(0, b.cue - PRE_S),
          MAX_WINDOW_S,
          this.signal(),
        );
        if (gen !== this.gen) return;
        // the levels are read before the samples go to the worklet (they're handed over)
        const levels = {
          offset: data.offset,
          step: LEVEL_STEP_S,
          levels: windowLevels(data, LEVEL_STEP_S),
        };
        engine.load('B', data);
        this.update({ levels: { ...this.v.levels, B: levels } });
        this.bWin = { offset: data.offset, duration: data.duration };
      }
      await this.loadA(gen);
      if (gen !== this.gen) return;
      const w = this.bWin!;
      this.update({ phase: 'ready', window: { start: w.offset, end: w.offset + w.duration } });
      this.startFresh();
    } catch (e) {
      if (gen !== this.gen) return;
      if (e instanceof DOMException && e.name === 'AbortError') return;
      const words = e instanceof Error && e.message ? e.message : 'couldn’t load the audio';
      this.update({ phase: 'failed', error: `Couldn’t get the decks ready: ${words}` });
      this.say(`Couldn’t get ${b.title || 'B'} ready: ${words}`);
    }
  }

  /** A's window from where the element is (A isn't on its deck yet). */
  private async loadA(gen: number): Promise<void> {
    const engine = this.engine;
    const a = this.a;
    if (!engine || !a) return;
    const pos = this.d.player.audio()?.currentTime ?? 0;
    this.loadingA = true;
    try {
      const data = await this.d.fetchWindow(
        engine.context,
        a.id,
        Math.max(0, pos - PRE_S),
        MAX_WINDOW_S,
        this.signal(),
      );
      if (gen !== this.gen || this.v.aOnDeck) return;
      const levels = {
        offset: data.offset,
        step: LEVEL_STEP_S,
        levels: windowLevels(data, LEVEL_STEP_S),
      };
      engine.load('A', data);
      this.update({ levels: { ...this.v.levels, A: levels } });
      this.aWin = { offset: data.offset, duration: data.duration };
    } finally {
      this.loadingA = false;
    }
  }

  /** While B waits, A's window follows the player (a minute left: fetched again). */
  private startFresh(): void {
    this.stopFresh();
    const tick = () => {
      this.freshTimer = this.d.setTimeout(tick, FRESH_MS);
      if (this.v.phase !== 'ready' || this.loadingA) return;
      const pos = this.d.player.audio()?.currentTime ?? 0;
      const end = this.a?.duration ?? Infinity;
      const ahead = Math.min(A_AHEAD_S, Math.max(0, end - pos - 1));
      if (!covers(this.aWin, pos, ahead)) {
        const gen = this.gen;
        void this.loadA(gen).catch(() => undefined);
      }
    };
    this.freshTimer = this.d.setTimeout(tick, FRESH_MS);
  }

  private stopFresh(): void {
    if (this.freshTimer !== null) this.d.clearTimeout(this.freshTimer);
    this.freshTimer = null;
  }

  // ── the controls ───────────────────────────────────────────────────────

  setDeck(deck: DeckId, id: DeckControlId, value: number): void {
    if (id === 'tempo') {
      this.setTempo(deck, value);
      return;
    }
    const values = { ...this.v.values, [deck]: { ...this.v.values[deck], [id]: value } };
    this.update({ values });
    this.applyAll();
  }

  // ── Tempo, Key lock, Headphones (3b: 438, 440, 443) ────────────────────

  /** A deck's mode: Key lock time-stretches (the key stays); off, the deck varispeeds. */
  private modeFor(deck: DeckId, rate: number): 'resample' | 'stretch' {
    if (!this.v.decks[deck].keyLock) return 'resample';
    // at its own speed the two are the same samples; stretch only when it moves
    return deck === 'B' || Math.abs(rate - 1) > 1e-6 ? 'stretch' : 'resample';
  }

  /**
   * Tempo (438): A's moves deck A (and the element under it, which keeps
   * time) and B with it when Sync holds B to A; B's turns Sync off (B is set
   * by Sync while it's on) and moves B on its own. Each change is from now,
   * the place carried on: no jump, so no click.
   */
  setTempo(deck: DeckId, value: number): void {
    const range = this.v.decks[deck].range;
    const v = Math.max(-range, Math.min(range, Math.round(value * 10) / 10));
    if (deck === 'B' && this.v.sync && this.v.syncable) {
      this.update({ sync: false });
      if (this.v.phase === 'playing') this.ratio = null;
      this.say(`Sync off: ${this.b?.title || 'B'} at ${tempoWords(v)}`);
    }
    this.update({ values: { ...this.v.values, [deck]: { ...this.v.values[deck], tempo: v } } });
    try {
      this.retime(deck);
    } catch {
      this.hardStop('The blend stopped: the decks couldn’t change speed');
    }
  }

  private retime(deck: DeckId): void {
    const engine = this.engine;
    if (!engine) return;
    const sr = engine.sampleRate;
    const t = this.now() + 0.03;
    if (deck === 'A') {
      if (!this.v.aOnDeck) return;
      const p = engine.position('A', t);
      if (p === null) return;
      this.rateA = this.rateA0 * tempoRate(this.v.values.A.tempo);
      engine.mode('A', this.modeFor('A', this.rateA / this.rateA0));
      engine.map('A', t * sr, [{ f: t * sr, p, r: this.rateA }]);
      if (this.el) this.el.playbackRate = this.rateA;
      // B held to A follows A's new tempo, where it is
      if (this.v.rateB !== null && (this.v.phase === 'playing' || this.v.phase === 'backing'))
        this.lockInPlace(t);
      return;
    }
    if (this.v.phase !== 'playing' && this.v.phase !== 'backing') return;
    const p = engine.position('B', t);
    if (p === null) return;
    const r = tempoRate(this.v.values.B.tempo);
    engine.mode('B', this.modeFor('B', r));
    engine.map('B', t * sr, [{ f: t * sr, p, r }]);
    this.update({ rateB: null });
  }

  /** B kept on A's beat where both are now, at A's new speed (A's tempo moved). */
  private lockInPlace(t: number): void {
    const engine = this.engine!;
    const { a, b } = this;
    if (!a?.grid || !b?.grid || !this.ratio) return;
    const posA = engine.position('A', t);
    const posB = engine.position('B', t);
    if (posA === null || posB === null) return;
    const knots = lockedKnots({
      gridA: a.grid,
      a0: a.grid.beatAt(posA),
      rateA: this.rateA,
      gridB: b.grid,
      b0: b.grid.beatAt(posB),
      m: this.ratio.m,
      t0: t,
      sampleRate: engine.sampleRate,
      untilB: (this.bWin ? this.bWin.offset + this.bWin.duration : Infinity) + 1,
    });
    engine.map('B', t * engine.sampleRate, knots);
    this.update({ rateB: knots[0]?.r ?? this.v.rateB });
  }

  setRange(deck: DeckId, range: TempoRange): void {
    const decks = { ...this.v.decks, [deck]: { ...this.v.decks[deck], range } };
    this.update({ decks });
    const tempo = this.v.values[deck].tempo;
    if (Math.abs(tempo) > range) this.setTempo(deck, Math.sign(tempo) * range);
    this.say(`Deck ${deck} tempo range ±${range}%`);
  }

  setKeyLock(deck: DeckId, on: boolean): void {
    if (this.v.decks[deck].keyLock === on) return;
    this.update({ decks: { ...this.v.decks, [deck]: { ...this.v.decks[deck], keyLock: on } } });
    const engine = this.engine;
    const playing =
      deck === 'A' ? this.v.aOnDeck : ['playing', 'starting', 'backing'].includes(this.v.phase);
    if (engine && playing) {
      const rate =
        deck === 'A'
          ? this.rateA / this.rateA0
          : (this.v.rateB ?? tempoRate(this.v.values.B.tempo));
      engine.mode(deck, this.modeFor(deck, rate));
    }
    this.say(`Deck ${deck} key lock ${on ? 'on' : 'off: the pitch moves with the tempo'}`);
  }

  setPhones(deck: DeckId, on: boolean, quiet = false): void {
    if (this.v.decks[deck].phones === on) return;
    this.update({ decks: { ...this.v.decks, [deck]: { ...this.v.decks[deck], phones: on } } });
    this.applyPhones();
    if (!quiet) this.say(`Deck ${deck} ${on ? 'in the headphones' : 'out of the headphones'}`);
  }

  private applyPhones(): void {
    const decks = this.engine?.graph.decks;
    if (!decks) return;
    const t = this.now();
    for (const d of ['A', 'B'] as const) {
      try {
        decks[d].cueSend.gain.setTargetAtTime(this.v.decks[d].phones ? 1 : 0, t, 0.01);
      } catch {
        /* a closed context */
      }
    }
  }

  setMonitor(mix: number, volume: number): void {
    this.update({ monitor: { mix, volume } });
  }

  /** The engine's context and graph for the Monitor (null until it's made, and once it's gone). */
  engineParts(): { context: BaseAudioContext; graph: EngineLike['graph'] } | null {
    return this.engine ? { context: this.engine.context, graph: this.engine.graph } : null;
  }

  /**
   * The speakers went (37r) while A is on its deck: both decks pause where
   * they are (the player's Pause: the element pauses, the context with it),
   * and nothing is moved to the headphones.
   */
  speakersLost(): boolean {
    const el = this.el;
    if (!this.v.aOnDeck || !el || el.paused) return false;
    el.pause();
    return true;
  }

  // ── cues (3b: 439) ─────────────────────────────────────────────────────

  /**
   * A set cue pressed: deck A (on its element) seeks the player; on its
   * deck it jumps within its window, the element with it (the session's own
   * seek), B eased back onto its beat. B cued: Play B starts there (the
   * store moves B's cue). B playing or paused: B comes in from the cue on
   * A's next bar. Outside the deck's 3 minutes it says so.
   */
  jump(deck: DeckId, seconds: number): 'seek' | 'cue' | 'jumped' | 'outside' {
    const engine = this.engine;
    if (deck === 'A') {
      if (!this.v.aOnDeck || !engine) {
        this.d.player.seek?.(seconds);
        return 'seek';
      }
      if (!covers(this.aWin, seconds, 4)) return 'outside';
      const sr = engine.sampleRate;
      const t = this.now() + 0.03;
      const el = this.el;
      if (el) {
        this.ownSeek = true;
        el.currentTime = seconds;
      }
      engine.map('A', 0, [{ f: t * sr, p: seconds + 0.03 * this.rateA, r: this.rateA }], true);
      if (this.v.rateB !== null && this.v.phase === 'playing') this.relock();
      return 'jumped';
    }
    if (!['playing', 'starting', 'paused'].includes(this.v.phase) || !engine) return 'cue';
    if (!covers(this.bWin, seconds, 2)) return 'outside';
    if (this.v.phase === 'paused') {
      this.pausedAt = seconds;
      return 'jumped';
    }
    const T = this.now() + 0.03;
    const posA = engine.position('A', T);
    if (posA === null) return 'outside';
    try {
      this.startB(T, posA, seconds, true);
    } catch {
      this.hardStop('The blend stopped: the decks couldn’t start');
    }
    return 'jumped';
  }

  setCentre(id: 'xf' | 'echoSend' | 'echoTime' | 'echoFeedback', value: number): void {
    if (this.v.phase === 'backing' && id === 'xf') return; // Back has the fader
    this.update({ values: { ...this.v.values, [id]: value } });
    this.applyAll();
  }

  setKill(deck: DeckId, band: Band, on: boolean): void {
    const d = this.v.values[deck];
    if (d.kill[band] === on) return;
    const values = { ...this.v.values, [deck]: { ...d, kill: { ...d.kill, [band]: on } } };
    this.update({ values });
    this.applyAll();
    this.say(killWords(deck, band, on));
  }

  setSync(on: boolean): boolean {
    if (on === this.v.sync) return true;
    if (on && !this.v.syncable) {
      if (this.v.syncWhy) this.say(this.v.syncWhy);
      return false;
    }
    if (this.v.phase === 'starting') {
      // B hasn't come in yet: start it again on the same bar, with Sync as asked (review M2)
      const st = this.started;
      if (!st || st.Tb - this.now() < 0.1) {
        this.say('Sync changes once B is in');
        return false;
      }
      this.update({ sync: on });
      try {
        this.startB(st.T, st.posA, st.bFrom);
      } catch {
        this.hardStop('The blend stopped: the decks couldn’t start');
        return false;
      }
      this.say(on ? 'Sync on' : 'Sync off');
      return true;
    }
    this.update({ sync: on });
    const b = this.b?.title || 'B';
    if (this.v.phase === 'playing') {
      if (on) this.relock();
      else this.glideFree();
      this.say(
        on ? `Sync on: ${b} back on the beat` : `Sync off: ${b} back to its own tempo over a bar`,
      );
    } else {
      this.say(on ? 'Sync on' : 'Sync off');
    }
    return true;
  }

  // ── Play B ─────────────────────────────────────────────────────────────

  /** Play B (⇧P): B starts at its cue on A's next bar, A onto its deck (421, 432). */
  playB(): boolean {
    const { a, b } = this;
    if (!a || !b) return false;
    if (this.v.phase === 'paused') return this.resumeB();
    if (this.v.phase === 'idle' || this.v.phase === 'failed') {
      const why = this.d.support?.() ?? null;
      if (why) {
        // pressed anyway: why, again (a person's action, answered)
        this.say(why);
        return false;
      }
      // after A ended, or a load that failed: get ready again; Play B once more starts it
      void this.prepare(!this.bWin);
      this.say(`Getting ${b.title || 'B'} ready: a moment`);
      return false;
    }
    if (this.v.phase !== 'ready') {
      if (this.v.phase === 'loading') this.say(`Getting ${b.title || 'B'} ready: a moment`);
      return false;
    }
    const el = this.d.player.audio();
    if (!el || el.paused || el.ended) {
      this.say(`Play ${a.title || 'the track'} first: B comes in on its beat`);
      return false;
    }
    const ctx = this.engine?.context as (BaseAudioContext & { state?: string }) | undefined;
    if (ctx && ctx.state && ctx.state !== 'running') {
      // the decks can't start on a stopped context: ask for it, then start (review H2)
      const resume = (ctx as AudioContext).resume?.bind(ctx);
      const gen = this.gen;
      void Promise.resolve(resume?.())
        .catch(() => undefined)
        .then(() => {
          if (gen !== this.gen || this.v.phase !== 'ready') return;
          if (ctx.state === 'running') this.playB();
          else this.say('The browser has stopped the audio: press Play B again');
        });
      return true;
    }
    // as much of A as the decks can hold, so A's window never ends the blend first (review M3)
    const pos = el.currentTime + AHEAD_S;
    const ahead = Math.max(8, Math.min(A_AHEAD_S, (this.a?.duration ?? Infinity) - pos - 1));
    // once fetched again for this press, what the server gave is what there is
    const need = this.aRefetched ? 8 : ahead;
    this.aRefetched = false;
    if (!covers(this.aWin, pos, need)) {
      // the player jumped past A's window: fetch it again, then start
      const gen = ++this.gen;
      this.update({ phase: 'loading' });
      void this.loadA(gen)
        .then(() => {
          if (gen !== this.gen) return;
          this.update({ phase: 'ready' });
          this.aRefetched = true;
          this.playB();
        })
        .catch(() => {
          if (gen === this.gen)
            this.update({ phase: 'failed', error: 'Couldn’t get the decks ready' });
        });
      return true;
    }
    this.takeOver(el);
    return true;
  }

  private takeOver(el: HTMLAudioElement): void {
    try {
      this.takeOverNow(el);
    } catch {
      // anything half-done is undone: A back on its element (review M5)
      this.hardStop('The blend stopped: the decks couldn’t start');
    }
  }

  private takeOverNow(el: HTMLAudioElement): void {
    const engine = this.engine!;
    this.stopFresh();
    this.hold(true);
    const ctx = engine.context;
    this.rateA0 = el.playbackRate > 0 ? el.playbackRate : 1;
    this.rateA = this.rateA0 * tempoRate(this.v.values.A.tempo);
    const T = ctx.currentTime + AHEAD_S;
    const from = el.currentTime + AHEAD_S * this.rateA;
    this.applyAll(ctx.currentTime);
    engine.mode('A', this.modeFor('A', this.rateA / this.rateA0));
    // the element keeps time with deck A, at deck A's speed (it's muted)
    if (this.rateA !== this.rateA0) el.playbackRate = this.rateA;
    // the whole map replaced: nothing of an earlier go plays before T (review H3)
    engine.stop('A', Infinity);
    engine.map('A', 0, [{ f: T * engine.sampleRate, p: from, r: this.rateA }], true);
    const level = this.level();
    const g = engine.graph.master.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(0, ctx.currentTime);
    g.setValueAtTime(0, T);
    g.linearRampToValueAtTime(level, T + FADE_S);
    this.master = level;
    this.ended = false;
    this.bind(el);
    this.update({ aOnDeck: true });
    // the element fades out as deck A fades in, then plays on muted (it keeps time)
    this.later(
      () => {
        if (!this.v.aOnDeck || this.el !== el) return;
        this.fadeElement(el, level, 0, () => {
          if (!this.v.aOnDeck || this.el !== el) return;
          el.muted = true;
          el.volume = level;
        });
      },
      (T - ctx.currentTime) * 1000,
    );
    this.startB(T, from, null);
  }

  /** B on its deck from A's next bar after A's position `posA` at context second `T`. */
  private startB(T: number, posA: number, bFrom: number | null, onBeat = false): void {
    const engine = this.engine!;
    const { a, b } = this;
    if (!a || !b) return;
    const sr = engine.sampleRate;
    let Tb = T + MIN_LEAD_S;
    let aBeat: number | null = null;
    if (a.grid) {
      const nb = nextBar(a.grid, posA, MIN_LEAD_S * this.rateA);
      Tb = T + (nb.time - posA) / this.rateA;
      aBeat = a.grid.barBeat(nb.bar);
    }
    this.started = { T, posA, bFrom, Tb };
    const lock = this.v.sync && this.v.syncable && a.grid && b.grid && aBeat !== null;
    engine.stop('B', Infinity);
    let rateB: number | null = null;
    if (lock) {
      const pa = a.grid!.periodAt(aBeat!);
      let b0: number;
      if (bFrom === null) b0 = cueBeat(b.grid!, b.cue).beat;
      else {
        // resuming: B's next bar from where it paused
        const g = b.grid!;
        // a cue (on its beat) comes in from that beat; a resume from B's next bar
        b0 = onBeat
          ? Math.round(g.beatAt(bFrom))
          : g.barBeat(Math.ceil((g.beatAt(bFrom) - g.downbeatIndex) / 4 - 1e-6));
      }
      const ratio = syncRatio(pa, b.grid!.periodAt(b0), this.rateA);
      if (ratio) {
        this.ratio = ratio;
        const knots = lockedKnots({
          gridA: a.grid!,
          a0: aBeat!,
          rateA: this.rateA,
          gridB: b.grid!,
          b0,
          m: ratio.m,
          t0: Tb,
          sampleRate: sr,
          untilB: (this.bWin ? this.bWin.offset + this.bWin.duration : Infinity) + 1,
        });
        engine.mode('B', this.modeFor('B', ratio.rate));
        // from frame 0: B's whole map replaced, silent until Tb (review H3)
        engine.map('B', 0, knots, true);
        rateB = knots[0]!.r;
      }
    }
    if (rateB === null) {
      const r = tempoRate(this.v.values.B.tempo);
      engine.mode('B', this.modeFor('B', r));
      engine.map('B', 0, [{ f: Tb * sr, p: bFrom ?? b.cue, r }], true);
    }
    this.pausedAt = null;
    this.update({ phase: 'starting', rateB });
    const gen = this.gen;
    const token = ++this.startToken;
    this.later(
      () => {
        if (gen !== this.gen || token !== this.startToken || this.v.phase !== 'starting') return;
        this.update({ phase: 'playing' });
        this.say(
          rateB !== null
            ? `${b.title || 'B'} playing, on ${a.title || 'A'}’s beat`
            : `${b.title || 'B'} playing: blend by ear`,
        );
      },
      (Tb - this.now()) * 1000,
    );
    this.startWatch();
  }

  /** Pause B: deck B stops where it is; A plays on, on its deck. */
  pauseB(): boolean {
    if (!this.engine || !['starting', 'playing'].includes(this.v.phase)) return false;
    const t = this.now() + 0.03;
    const pos = this.engine.position('B', t);
    this.engine.stop('B', Math.round(t * this.engine.sampleRate));
    this.pausedAt = pos ?? this.b?.cue ?? 0;
    this.update({ phase: 'paused' });
    this.say(`${this.b?.title || 'B'} paused`);
    return true;
  }

  private resumeB(): boolean {
    const engine = this.engine;
    if (!engine || this.pausedAt === null) return false;
    const T = this.now() + 0.03;
    const posA = engine.position('A', T);
    if (posA === null) return false;
    try {
      this.startB(T, posA, this.pausedAt);
    } catch {
      this.hardStop('The blend stopped: the decks couldn’t start');
    }
    return true;
  }

  /** Sync off mid-blend: B glides back to its own tempo over a bar, no jump (433). */
  private glideFree(): void {
    const engine = this.engine;
    if (!engine) return;
    const sr = engine.sampleRate;
    const t = this.now() + 0.03;
    const p = engine.position('B', t);
    if (p === null) return;
    const r0 = rateAt(engine.current('B'), t, sr) ?? 1;
    engine.map('B', t * sr, glideKnots(t, p, r0, 1, this.barSeconds(), sr));
    engine.mode('B', 'stretch');
    this.ratio = null;
    this.update({ rateB: null });
  }

  /** Sync on mid-blend: over the bar to A's next bar B is eased onto A's nearest beat, then locked. */
  private relock(): void {
    const engine = this.engine;
    const { a, b } = this;
    if (!engine || !a?.grid || !b?.grid) return;
    const sr = engine.sampleRate;
    const t = this.now() + 0.03;
    const posA = engine.position('A', t);
    const posB = engine.position('B', t);
    if (posA === null || posB === null) return;
    // a full bar to ease B over, onto its nearest bar (review L7)
    const nb = nextBar(a.grid, posA, 4 * a.grid.periodAt(a.grid.beatAt(posA)));
    const tk = t + (nb.time - posA) / this.rateA;
    const free = engine.position('B', tk) ?? posB;
    const b0 = b.grid.barBeat(
      Math.max(0, Math.round((b.grid.beatAt(free) - b.grid.downbeatIndex) / 4)),
    );
    const target = b.grid.timeAt(b0);
    const aBeat = a.grid.barBeat(nb.bar);
    const ratio = syncRatio(a.grid.periodAt(aBeat), b.grid.periodAt(b0), this.rateA);
    if (!ratio) return;
    this.ratio = ratio;
    const locked = lockedKnots({
      gridA: a.grid,
      a0: aBeat,
      rateA: this.rateA,
      gridB: b.grid,
      b0,
      m: ratio.m,
      t0: tk,
      sampleRate: sr,
      untilB: (this.bWin ? this.bWin.offset + this.bWin.duration : Infinity) + 1,
    });
    const glide: Knot = { f: t * sr, p: posB, r: Math.max(0.5, (target - posB) / (tk - t)) };
    engine.mode('B', 'stretch');
    engine.map('B', t * sr, [glide, ...locked]);
    this.update({ rateB: locked[0]?.r ?? ratio.rate });
  }

  // ── the ends of the windows ────────────────────────────────────────────

  /** A bar before either deck's window runs out, the fader comes back to A by itself (424). */
  private startWatch(): void {
    if (this.watchTimer !== null) this.d.clearTimeout(this.watchTimer);
    const tick = () => {
      this.watchTimer = null;
      if (!this.v.aOnDeck || !this.engine) return;
      // auto-mix turned on (or made again) under the blend hears the hold again (re-review N3)
      if (this.held) {
        try {
          this.d.autoHold?.(true);
        } catch {
          /* never block the decks */
        }
      }
      const left = this.timeLeft();
      if (left !== null && left < this.barSeconds() + END_MARGIN_S) {
        if (this.v.phase === 'playing' || this.v.phase === 'starting') {
          this.backOverBar(null);
          return;
        }
        if (this.v.phase === 'paused') {
          this.release(true);
          this.say(`${this.a?.title || 'A'} is back on the player`);
          return;
        }
      }
      this.watchTimer = this.d.setTimeout(tick, WATCH_MS);
    };
    this.watchTimer = this.d.setTimeout(tick, WATCH_MS);
  }

  /** Output seconds until the first window runs out (A's only where the track goes on past it). */
  private timeLeft(): number | null {
    const engine = this.engine!;
    const out: number[] = [];
    const posA = engine.position('A');
    if (posA !== null && this.aWin) {
      const end = this.aWin.offset + this.aWin.duration;
      // a window that ends with the track: the track's end is the element's (its `ended`)
      if (end < (this.a?.duration ?? Infinity) - 1) out.push((end - posA) / this.rateA);
    }
    if (this.v.phase !== 'paused') {
      const posB = engine.position('B');
      if (posB !== null && this.bWin) {
        const r = rateAt(engine.current('B'), this.now(), engine.sampleRate) ?? 1;
        out.push((this.bWin.offset + this.bWin.duration - posB) / Math.max(0.25, r));
      }
    }
    return out.length ? Math.min(...out) : null;
  }

  // ── Back ───────────────────────────────────────────────────────────────

  /**
   * Back mid-blend (413): the fader to A over one bar, then B stops and A
   * goes back to the element; `done` then (Back's DJ mode off). With `done`
   * null it's the window's end: B stays cued for another go.
   */
  backOverBar(done: (() => void) | null): void {
    const engine = this.engine;
    if (!engine || !this.blending || this.v.phase === 'backing') {
      if (done) {
        this.end();
        done();
      }
      return;
    }
    const t = this.now() + 0.03;
    const bar = this.barSeconds();
    for (const [key, to] of [
      ['A.xf', 1],
      ['B.xf', 0],
    ] as const) {
      const p = this.param(key);
      if (!p) continue;
      p.hold(t);
      p.linear(t + bar, to);
      this.applied[key] = to;
    }
    this.update({ phase: 'backing', values: { ...this.v.values, xf: 0 } });
    const a = this.a?.title || 'A';
    this.say(done ? `Bringing ${a} back over a bar` : `The decks’ 3 minutes are up: back to ${a}`);
    const gen = this.gen;
    this.later(
      () => {
        if (gen !== this.gen) return;
        if (done) {
          // A back on its element over 80 ms, then everything goes
          this.release(false);
          this.end();
          done();
        } else this.release(true);
      },
      (bar + 0.05) * 1000,
    );
  }

  /**
   * A back onto its element (Back, a window's end): the element unmuted and
   * faded in over 80 ms as the decks fade out; B stays cued when `keep`.
   */
  private release(keep: boolean): void {
    const engine = this.engine;
    const el = this.el;
    this.clearLater();
    if (engine && this.v.aOnDeck) {
      const now = engine.context.currentTime;
      const level = this.level();
      if (el && !el.paused && !el.ended && !this.suspended) {
        el.volume = 0;
        el.muted = false;
        this.fadeElement(el, 0, level);
        this.fadeMaster(0, now + 0.01, FADE_S);
        engine.stop('A', Math.round((now + FADE_S + 0.05) * engine.sampleRate));
        engine.stop('B', Math.round((now + FADE_S + 0.05) * engine.sampleRate));
      } else {
        this.silence(engine, el, level);
      }
    }
    this.afterRelease(keep);
  }

  /**
   * The hard stop (a close, DJ mode off, a seek, another track, the track's
   * end): the decks out over 40 ms, the element unmuted at its level at once.
   */
  private hardStop(words: string | null, keep = true): void {
    const engine = this.engine;
    this.clearLater();
    if (this.v.aOnDeck) {
      if (engine) this.silence(engine, this.el, this.level());
      else if (this.el) {
        // the engine is gone (a worklet error): the element is all there is
        this.cancelFade();
        this.el.muted = false;
        this.el.volume = this.level();
      }
    }
    this.afterRelease(keep);
    if (words) this.say(words);
  }

  private silence(engine: EngineLike, el: HTMLAudioElement | null, level: number): void {
    const now = engine.context.currentTime;
    this.fadeMaster(0, now + 0.005, HARD_S);
    engine.stop('A', Math.round((now + HARD_S + 0.02) * engine.sampleRate));
    engine.stop('B', Math.round((now + HARD_S + 0.02) * engine.sampleRate));
    this.cancelFade();
    if (el) {
      el.muted = false;
      el.volume = level;
    }
  }

  private afterRelease(keep: boolean): void {
    // A goes back onto its element at its own tempo (413)
    const el = this.el;
    if (el && this.v.aOnDeck && el.playbackRate !== this.rateA0) el.playbackRate = this.rateA0;
    this.rateA = this.rateA0;
    this.ownSeek = false;
    if (this.v.values.A.tempo !== 0)
      this.update({ values: { ...this.v.values, A: { ...this.v.values.A, tempo: 0 } } });
    this.unbind();
    this.started = null;
    this.hold(false);
    this.pausedAt = null;
    // A is off its deck first: nothing after this is a blend to stop (re-review N2)
    this.update({ aOnDeck: false, rateB: null });
    if (this.suspended) {
      // the listener's Pause suspended the context: it's resumed, and only
      // once it runs is the watch told the pause is over (so a suspended
      // context isn't taken for an interruption on the way, re-review N2)
      this.suspended = false;
      const engine = this.engine;
      const ctx = engine?.context as AudioContext | undefined;
      const done = () => engine?.setPaused(false);
      if (ctx && typeof ctx.resume === 'function') void ctx.resume().then(done, done);
      else done();
    }
    if (keep && this.a && this.b) {
      // A's deck has moved on: its window is fetched again from the element
      this.aWin = null;
      const stale = this.bStale;
      this.bStale = false;
      void this.prepare(stale);
    } else if (this.v.phase !== 'idle') {
      // the track ended or another loaded: B stays loaded; the next lanes
      // (or Play B) get the decks ready again. A cue that moved mid-blend
      // (its grid landed) drops B's window, so it's fetched from the new
      // mix-in then (re-review R1)
      this.aWin = null;
      if (this.bStale) {
        this.bWin = null;
        this.bStale = false;
      }
      this.gen += 1;
      this.update({ phase: 'idle' });
    }
  }

  /** Let everything go (DJ mode off, B removed, the overlay closed). */
  end(): void {
    this.fetching?.abort();
    this.fetching = null;
    this.stopFresh();
    if (this.v.aOnDeck) this.hardStop(null, false);
    this.clearLater();
    this.gen += 1;
    const engine = this.engine;
    const gen = this.gen;
    // the windows go once the decks' fade is over (auto-mix's letGo)
    if (engine)
      this.d.setTimeout(() => {
        if (gen !== this.gen) return;
        try {
          engine.unload('A');
          engine.unload('B');
        } catch {
          /* a closed context */
        }
        // nothing cued: the engine goes too (its worklet, graph and watch, review M4)
        if (this.engine === engine && this.v.phase === 'idle') this.dropEngine();
      }, 250);
    this.aWin = null;
    this.bWin = null;
    this.ratio = null;
    this.update({
      phase: 'idle',
      error: null,
      window: null,
      rateB: null,
      aOnDeck: false,
      values: defaultMix(),
      sync: true,
    });
    this.applyAll();
  }

  // ── the element ────────────────────────────────────────────────────────

  private fadeMaster(to: number, at: number, seconds: number): void {
    const g = this.engine!.graph.master.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(this.master, at);
    g.linearRampToValueAtTime(to, at + seconds);
    this.master = to;
  }

  private followVolume = (): void => {
    const engine = this.engine;
    if (!engine || !this.v.aOnDeck || this.suspended) return;
    const want = this.level();
    if (Math.abs(want - this.master) < 0.005) return;
    const now = engine.context.currentTime;
    this.fadeMaster(want, now, 0.05);
    if (this.el?.muted) this.el.volume = want;
  };

  /**
   * The element's volume over FADE_S in six steps (auto-mix's fadeElement).
   * Its own timer: clearing the mix's timers never leaves the element half
   * faded; a new fade (or the hard stop) replaces it.
   */
  private fadeElement(el: HTMLAudioElement, from: number, to: number, after?: () => void): void {
    this.cancelFade();
    const steps = 6;
    let n = 0;
    el.volume = Math.max(0, Math.min(1, from));
    const step = () => {
      n += 1;
      el.volume = Math.max(0, Math.min(1, from + ((to - from) * n) / steps));
      if (n >= steps) {
        this.fadeTimer = null;
        after?.();
      } else this.fadeTimer = this.d.setTimeout(step, (FADE_S * 1000) / steps);
    };
    this.fadeTimer = this.d.setTimeout(step, (FADE_S * 1000) / steps);
  }

  private cancelFade(): void {
    if (this.fadeTimer !== null) this.d.clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
  }

  private bind(el: HTMLAudioElement): void {
    this.unbind();
    this.el = el;
    el.addEventListener('pause', this.onPause);
    el.addEventListener('play', this.onPlay);
    el.addEventListener('seeking', this.onSeeking);
    el.addEventListener('ended', this.onEnded);
    el.addEventListener('emptied', this.onOther);
    el.addEventListener('loadstart', this.onOther);
    el.addEventListener('volumechange', this.followVolume);
    window.addEventListener('ss:player', this.followVolume);
  }

  private unbind(): void {
    const el = this.el;
    if (!el) return;
    el.removeEventListener('pause', this.onPause);
    el.removeEventListener('play', this.onPlay);
    el.removeEventListener('seeking', this.onSeeking);
    el.removeEventListener('ended', this.onEnded);
    el.removeEventListener('emptied', this.onOther);
    el.removeEventListener('loadstart', this.onOther);
    el.removeEventListener('volumechange', this.followVolume);
    window.removeEventListener('ss:player', this.followVolume);
    this.el = null;
  }

  /** Pause pauses both: the context stops (the listener's, not an interruption). */
  private readonly onPause = () => {
    const engine = this.engine;
    if (!engine || !this.v.aOnDeck || this.el?.ended) return;
    this.suspended = true;
    engine.setPaused(true);
    const ctx = engine.context as AudioContext;
    if (typeof ctx.suspend === 'function') void ctx.suspend().catch(() => undefined);
  };

  private readonly onPlay = () => {
    const engine = this.engine;
    if (!engine || !this.suspended) return;
    this.suspended = false;
    const ctx = engine.context as AudioContext;
    const done = () => engine.setPaused(false);
    if (typeof ctx.resume === 'function') void ctx.resume().then(done, done);
    else done();
  };

  private readonly onSeeking = () => {
    if (this.ownSeek) {
      this.ownSeek = false;
      return;
    }
    this.hardStop(`The blend stopped: ${this.a?.title || 'the track'} moved`);
  };

  /** A ran out on its deck's watch: the player goes on as it always does (Hand over is step 4). */
  private readonly onEnded = () => {
    if (this.ended) return;
    this.ended = true;
    this.hardStop(`${this.a?.title || 'The track'} ended: the blend stopped`, false);
  };

  private readonly onOther = () => {
    if (!this.v.aOnDeck) return;
    this.hardStop('The blend stopped', false);
  };

  dispose(): void {
    this.end();
    this.listeners.clear();
  }
}
