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
 *   element: never silent, never "playing" while silent.
 * - **Hand over (step 4, 414, 37i):** the fader to B and B to the player's
 *   own speed over a bar, then the player takes B where deck B is (B's row
 *   after the playing one, `playIndex` with a `handoff`), deck B fades out;
 *   A's deck goes on silent for the Undo (10 s), which joins A back the
 *   same way and takes B's row out again (Up next untouched, 422).
 * - **The ends and changes (37j):** A running out while B plays is a Hand
 *   over (the player leaves that advance to DJ mode, `ownsAdvance`); Next
 *   or another track cuts B back over a bar (the player obeys, B stays
 *   cued); a seek is the hard stop; a pause pauses both (a pause or seek is
 *   told from a load over SETTLE_MS); A finished with nothing next, Play B
 *   plays B on its own and Hand over then carries on.
 */
import type { DeckData } from '@/features/engine/engine';
import type { BeatGrid } from '@/features/engine/grid';
import type { DeckId, ParamKey, ParamName } from '@/features/engine/score';

import { glideKnots } from '@/features/engine/clock';
import { LIMIT_DELAY_S } from '@/features/engine/graph';
import { relativeTrimDb } from '@/features/engine/grid';
import { MAX_WINDOW_S } from '@/features/engine/loader';
import { NEUTRAL, rampFor } from '@/features/engine/score';
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
  /** Hand over (414): the fader to B over a bar, then the player takes B */
  | 'handing'
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
  /** B: the track as the player's queue takes it (Hand over, 414), once known */
  queue?: Record<string, unknown> | null;
  /** B: why the player can't take it (its file isn't there), when that's known */
  queueWhy?: string | null;
  /** the analysed loudness (the grid route's), for Auto-gain (step 5) */
  loudness?: { replaygain_db: number | null; level_db: number | null } | null;
}

/** What the last Hand over did, for the lane's notice and its Undo (37i). */
export interface Handed {
  /** B's title (the player's track now) */
  title: string;
  /** A's title */
  from: string;
  /** A ran out mid-blend (37j): it's over, so there's nothing to put back */
  ended: boolean;
  /** Undo can put A back (10 s, 414) */
  undo: boolean;
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
  /** B playing on its own: A had finished and Up next had run out (37j) */
  solo: boolean;
  /** the last Hand over, while its notice shows (10 s) */
  handed: Handed | null;
  /** B plays before the blend, for the headphones only (B's Play or a held CUE, step 4b) */
  previewB: boolean;
  /** where B sits while it's cued and stopped (a scrub, its Play paused), else null: at its cue */
  parkB: number | null;
  /** the deck a hand is on (a drag on its waveform, step 4b), else null */
  hand: DeckId | null;
  /**
   * The player's element plays through deck A's channel strip (step 5, M6):
   * A's Volume, EQ, KILL, Filter, the crossfader and the echo act on the
   * playing track before Play B. False where the player can't route it:
   * then they wait for Play B, and say so.
   */
  elementLive: boolean;
  /** A's speed on its deck against its own tempo (its Tempo, the player's speed), else null (M2) */
  rateA: number | null;
  /** Auto-gain (S6, on by default): B matched to A's loudness, dB on B's trim (A is the player's, untouched) */
  autoGain: boolean;
  gain: Record<DeckId, number>;
  /** each deck's loop (step 6): its region, its size in beats, and whether it's looping now */
  loops: Record<DeckId, DeckLoop | null>;
  /** a loop's In set, waiting for its Out */
  loopIn: Record<DeckId, number | null>;
  /** each deck's auto loop size (beats: 1/32 … 32) and beatjump (1, 4, 16, 32) */
  loopSize: Record<DeckId, number>;
  jumpSize: Record<DeckId, number>;
  /** Quantize (step 6, on by default): jumps, cues and loops on the beat */
  quantize: boolean;
}

export interface DeckLoop {
  start: number;
  end: number;
  /** its length in beats (null without a grid) */
  beats: number | null;
  active: boolean;
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
    /** the element strip's send to the cue bus (deck A's Headphones before Play B, step 5) */
    element?: { cueSend: { gain: AudioParam } } | null;
    /** the meters' analysers (step 5) */
    meters?(): import('@/features/engine/graph').GraphMeters;
    limiter?: { reduction: number } | null;
  };
  /**
   * The element strip's params while the player's element plays through it
   * (step 5, M4–M6: deck A's channel on the playing track before Play B),
   * else null (this browser's player has no way to route it).
   */
  elementParams?(): Record<ParamName, AutomatedParam> | null;
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
  /** loops (step 6, engine/loops.ts): from a frame, a deck loops over a region; null ends it */
  loop?(deck: DeckId, region: { start: number; end: number } | null, atFrame: number): void;
  /** leave the loop at a frame and play on from where it is */
  endLoop?(deck: DeckId, atFrame: number): void;
  loopAt?(deck: DeckId, at?: number): { start: number; end: number } | null;
  /** move a deck by track seconds from a frame, its map's shape kept */
  shift?(deck: DeckId, atFrame: number, delta: number): void;
  /** the limiter's lookahead measured on this browser (seconds), else LIMIT_DELAY_S */
  lookahead?: number;
  /** the context stopping under the decks (lifecycle.ts), not the listener's own pause */
  onLifecycle?(fn: (e: { kind: 'interrupted' | 'resumed'; reason: string }) => void): () => void;
  /** the worklet node: its processor's errors end a blend */
  node?: { onprocessorerror: ((e: Event) => void) | null };
  dispose?(): void;
}

/**
 * What the player's load joins (media-player.js `startAudioPlayback`'s
 * `handoff`): a deck's position read as late as possible, and `pause` once
 * the element plays (auto-mix's hand-back has the same shape).
 */
export interface HandoffLike {
  readonly currentTime: number;
  pause(): void;
  src: string;
  volume: number;
}

export interface PlayerPort {
  audio(): HTMLAudioElement | null;
  state(): {
    volume?: number;
    muted?: boolean;
    index?: number;
    queue?: unknown[];
    track?: { id?: unknown } | null;
  } | null;
  /** the player's own seek (a cue on A while A is on its element) */
  seek?(seconds: number): void;
  /** the player's Next (A's end was DJ mode's, and the Hand over couldn't happen) */
  next?(): void;
  /** Hand over (414): a queue row played, joining a deck where it is */
  playIndex?(index: number, options: { handoff?: HandoffLike }): Promise<{ status: string }>;
  /** B's row straight after the playing one (Up next after it stays as it was, 422); its index */
  insertNext?(track: Record<string, unknown>): number;
  /** a queue row out (Undo takes B's row out again) */
  remove?(index: number): void;
  /** a queued row moved to straight after the playing one; its index */
  moveNext?(index: number): number;
  /** a queued row moved from one place to another */
  move?(from: number, to: number): void;
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
  /** Auto-gain's start (the person's setting, step 5; on by default) */
  autoGain?: boolean;
  /** Quantize's start (the person's setting, step 6; on by default) */
  quantize?: boolean;
}

/** Scheduling lead: the decks start this far ahead (auto-mix's AHEAD_S). */
export const AHEAD_S = 0.12;
/** The element and the decks cross over this long (auto-mix's FADE_S). */
export const FADE_S = 0.08;
/** The hard stop's fade. */
export const HARD_S = 0.04;
/** A control's change is a ramp this long: no zipper, no click. */
export const RAMP_S = 0.02;
/** the element further than this from deck A is put where A is before A goes back onto it (M1) */
export const ALIGN_S = 0.04;
/** Hand over's Undo (414): this long after the player takes B */
export const UNDO_MS = 10_000;
/** The deck the player joined fades out over this once the element plays (auto-mix's hand-back) */
const JOIN_S = 0.06;
/**
 * A pause or seek of the element under a blend waits this long before it's
 * taken for the listener's (a pause, a seek): the player loading another
 * track pauses and seeks its element first, then empties it (step 4: the
 * player obeys and B is cut back over a bar instead).
 */
const SETTLE_MS = 60;
/** The hand on the platter (step 4b): how often the deck follows it, and how fast it catches up. */
const HAND_MS = 15;
const HAND_TAU = 0.06;
/** at most four times its speed either way under the hand */
const HAND_MAX = 4;
/** Play B from B's preview: its catch-up onto A's beat stays within this of Sync's speed (review L1) */
const CATCH_UP = 0.08;
/** an arrow-key nudge: 4% faster or slower while held */
export const NUDGE = 0.04;
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
  private readonly d: Required<
    Omit<SessionDeps, 'autoHold' | 'onPhase' | 'support' | 'autoGain' | 'quantize'>
  > &
    Pick<SessionDeps, 'autoHold' | 'onPhase' | 'support' | 'autoGain' | 'quantize'>;
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
  /** A has left its own speed during this take-over: its mode stays stretch (L3) */
  private aMoved = false;
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
  /** the Undo of the last Hand over, while it can be (414) */
  private undo: {
    /** A's queue row (found again by itself: rows before it may go, review M-2) */
    aRow: unknown;
    aTitle: string;
    bId: string;
    bRow: unknown;
    /** where B's row was in Up next before it was moved next, or -1 (inserted) */
    bFrom: number;
    posA: number;
    timer: unknown;
  } | null = null;
  /** the notice after a Hand over with nothing to put back (10 s) */
  private handedTimer: unknown = null;
  /** a pause or seek of the element waiting to be told from a load (SETTLE_MS) */
  private settleTimer: unknown = null;
  /** the element's events while B plays on its own (37j) */
  private soloEl: HTMLAudioElement | null = null;
  /** the hand on a deck's platter (a drag on its waveform, step 4b) */
  private handOn: {
    deck: DeckId;
    /** the deck's speed when grabbed (0: it was stopped) */
    base: number;
    p0: number;
    t0: number;
    /** where the hand has moved it, track seconds */
    offset: number;
    stopped: boolean;
    timer: unknown;
    /** the session's phase when grabbed: a let-go after it changed does nothing (review M-3) */
    phase: MixPhase;
  } | null = null;
  /** the end of B's preview (its window runs out) */
  private previewTimer: unknown = null;
  /** B's speed before an arrow-key nudge (its map is replaced while the key is held) */
  private nudgeBase: number | null = null;
  /** the two as they were when Hand over was pressed (the lanes follow the player meanwhile) */
  private handing: { a: MixLane | null; b: MixLane } | null = null;
  /** the player takes B (Hand over's switch): the element strip is flat, at full (step 5) */
  private switching = false;
  /** deck A runs on silent for Hand over's Undo: its fader and echo send stay shut (step 5) */
  private aSilent = false;
  /** what the element strip's params were last set to */
  private appliedE: Partial<Record<ParamName, number>> = {};

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
      solo: false,
      handed: null,
      previewB: false,
      parkB: null,
      hand: null,
      elementLive: false,
      rateA: null,
      autoGain: deps.autoGain ?? true,
      gain: { A: 0, B: 0 },
      loops: { A: null, B: null },
      loopIn: { A: null, B: null },
      loopSize: { A: 4, B: 4 },
      jumpSize: { A: 4, B: 4 },
      quantize: deps.quantize ?? true,
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
    // the element strip follows the controls whoever changed them (Back,
    // Next, a window's end, B on its own ending move the crossfader to A
    // without the decks' applyAll: the playing track is never left at the
    // fader's old A side, review H1)
    if (patch.values && this.engine)
      this.applyElement(this.elementTargets(this.targets()), this.now());
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
    return ['starting', 'playing', 'backing', 'handing'].includes(this.v.phase);
  }

  /**
   * A's place in its track while it's on its deck (deck A's own position:
   * the muted element under it keeps time, but only near enough), else null.
   * Cue placement, lane A's playhead and zoom read this first (review M1).
   */
  positionA(): number | null {
    if (!this.engine || !this.v.aOnDeck) return null;
    return this.engine.position('A');
  }

  /** B's place in its track now, while it plays (lane B's playhead), else null. */
  positionB(): number | null {
    if (this.engine && this.v.phase === 'ready') {
      if (this.v.previewB || this.v.hand === 'B') return this.engine.position('B');
      return this.v.parkB;
    }
    if (
      !this.engine ||
      !['starting', 'playing', 'backing', 'paused', 'handing'].includes(this.v.phase)
    )
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
    this.refreshGain();
    // Hand over on its way: the lanes follow the player taking B (A becomes
    // B's track, B empties); the decks are the hand-over's until it's done
    if (this.v.phase === 'handing') return;
    if (this.undo) {
      // the player's track is B's and lane B is empty: the Undo stands
      if (!b && a?.id === this.undo.bId) return;
      // B loaded again, or the player moved on from B (Next, L-3): the Undo has gone
      this.dropUndo();
      if (!b) return;
    }
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
      // A moved on under the blend (another track): the player obeys, B is
      // cut back over a bar (37j); a new B while B was paused stops at once
      if (!sameA && this.v.aOnDeck) this.cutBack();
      else this.hardStop(null, false, false);
    }
    this.ratio = null;
    void this.prepare(!sameB);
  }

  /**
   * Auto-gain's trims for these lanes (S6). Not under a blend: a level never
   * moves while both play (the next blend has it).
   */
  private refreshGain(): void {
    if (this.v.aOnDeck || this.blending || this.v.phase === 'handing') return;
    const g = this.gainDb();
    if (g.A === this.v.gain.A && g.B === this.v.gain.B) return;
    this.update({ gain: g });
    this.applyAll();
  }

  /** Auto-gain on or off (the person's setting, S6): B's trim follows from the next blend. */
  setAutoGain(on: boolean): void {
    if (this.v.autoGain === on) return;
    this.update({ autoGain: on });
    this.refreshGain();
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
    this.appliedE = {};
    this.update({ elementLive: Boolean(engine.elementParams?.()) });
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
    // the context stopped: deck A's place is frozen, so the element isn't
    // put there (it's where the listener heard A last, near enough; L-new-2),
    // except while A loops: the element ran on past the loop, so it comes
    // back where A was heard, not a loop's length away (review round 2)
    if (this.v.solo) this.soloOut(0, words);
    else if (this.v.aOnDeck || this.blending)
      this.hardStop(words, true, Boolean(this.v.loops.A?.active));
  }

  /** Let the engine go (its worklet, graph and lifecycle watch, review M4). */
  private dropEngine(): void {
    const engine = this.engine;
    if (!engine) return;
    this.offEngine?.();
    this.offEngine = null;
    this.engine = null;
    this.applied = {};
    this.appliedE = {};
    this.aWin = null;
    this.bWin = null;
    try {
      engine.dispose?.();
    } catch {
      /* a closed context */
    }
    // whoever routes off the engine's graph (the Monitor) lets it go too
    this.update({ elementLive: false });
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

  /** Auto-gain (S6): B's trim (dB) matched to A's loudness; A is the player's track, untouched. */
  private gainDb(): Record<DeckId, number> {
    if (!this.v.autoGain || !this.a || !this.b) return { A: 0, B: 0 };
    return {
      A: 0,
      B: relativeTrimDb({ loudness: this.a.loudness }, { loudness: this.b.loudness }),
    };
  }

  /** Every engine param for the controls' values (the trims Auto-gain's). */
  private targets(): Partial<Record<ParamKey, number>> {
    const t = engineTargets(this.v.values, this.beatPeriodA());
    const g = this.v.gain;
    t['A.trim'] = Math.pow(10, g.A / 20);
    t['B.trim'] = Math.pow(10, g.B / 20);
    return t;
  }

  /**
   * The element strip's values (step 5, M4–M6): deck A's channel and the
   * crossfader's A side, as deck A's are, so the playing track sounds the
   * same on the element and on deck A. While the player takes B (Hand over)
   * it's flat at full: the element is B's then, and B's channel was eased
   * flat over the bar.
   */
  private elementTargets(
    all: Partial<Record<ParamKey, number>>,
  ): Partial<Record<ParamName, number>> {
    const out: Partial<Record<ParamName, number>> = {};
    const flat = this.handing !== null || this.switching;
    for (const [key, value] of Object.entries(all) as [ParamKey, number][]) {
      if (!key.startsWith('A.')) continue;
      const name = key.slice(2) as ParamName;
      out[name] = flat ? NEUTRAL[name] : value;
    }
    if (flat) out.echoSend = 0;
    return out;
  }

  /** Every param to the controls' values: changed ones ramp over RAMP_S. */
  private applyAll(at?: number): void {
    if (!this.engine) return;
    const targets = this.targets();
    const t = at ?? this.now();
    for (const [key, value] of Object.entries(targets) as [ParamKey, number][]) {
      // deck A running on silent for the Undo keeps its fader and echo shut
      if (this.aSilent && (key === 'A.xf' || key === 'A.echoSend')) continue;
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
    this.applyElement(this.elementTargets(targets), t);
  }

  private applyElement(targets: Partial<Record<ParamName, number>>, t: number): void {
    const params = this.engine?.elementParams?.() ?? null;
    if (!params) return;
    for (const [name, value] of Object.entries(targets) as [ParamName, number][]) {
      const was = this.appliedE[name];
      if (was !== undefined && Math.abs(was - value) < 1e-9) continue;
      const p = params[name];
      if (!p) continue;
      if (was === undefined) p.reset(t, value);
      else {
        p.hold(t);
        p.ramp(rampFor(name), t + RAMP_S, value);
      }
      this.appliedE[name] = value;
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
    this.endPreviewTimer();
    // B's own play stops with it: the lanes changed (review L-1)
    this.dropHand();
    this.nudgeBase = null;
    if (this.v.previewB && this.engine) {
      try {
        this.engine.stop('B', Math.round((this.now() + 0.01) * this.engine.sampleRate));
      } catch {
        /* a closed context */
      }
    }
    this.update({
      phase: 'loading',
      error: null,
      previewB: false,
      ...(newB ? { window: null, parkB: null } : {}),
    });
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
    if (deck === 'B') return 'stretch';
    // at its own speed the two are the same samples; A stretches once it
    // moves, and stays stretched for the rest of this take-over, so a Tempo
    // passing 0 doesn't flip the mode back and forth (review L3)
    if (Math.abs(rate - 1) > 1e-6) this.aMoved = true;
    return this.aMoved ? 'stretch' : 'resample';
  }

  /**
   * Tempo (438): A's moves deck A (and the element under it, which keeps
   * time) and B with it when Sync holds B to A; B's turns Sync off (B is set
   * by Sync while it's on) and moves B on its own. Each change is from now,
   * the place carried on: no jump, so no click.
   */
  setTempo(deck: DeckId, value: number): void {
    // B on its way in: its start (and Sync's lock) is laid for A's next
    // bar, so both Tempos wait until it's in (the faders say so, L2)
    if (this.v.phase === 'starting') return;
    const range = this.v.decks[deck].range;
    // to a hundredth of a percent (S1: the fader's finest step is 0.02%)
    const v = Math.max(-range, Math.min(range, Math.round(value * 100) / 100));
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
      // the muted element keeps time with deck A (so the player's clock and
      // its end stay A's); the player's speed control ignores a change while
      // DJ mode holds the track and never saves it (media-player-v2.js), and
      // lane A and the cues read deck A itself (positionA, review M1)
      if (this.el) this.el.playbackRate = this.rateA;
      this.update({ rateA: this.rateA });
      // B held to A follows A's new tempo, where it is
      if (this.v.rateB !== null && (this.v.phase === 'playing' || this.v.phase === 'backing'))
        this.lockInPlace(t);
      return;
    }
    // B in the headphones before the blend follows its Tempo too, as a CDJ does
    const preview = this.v.phase === 'ready' && this.v.previewB;
    if (this.v.phase !== 'playing' && this.v.phase !== 'backing' && !preview) return;
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
    // a narrower range would move the tempo, which waits while B starts (L2)
    if (this.v.phase === 'starting' && Math.abs(this.v.values[deck].tempo) > range) return;
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
    // deck A's Headphones hear the playing track on the element too (step 5)
    try {
      const on = this.v.decks.A.phones && !this.aSilent && !this.switching && !this.handing;
      this.engine?.graph.element?.cueSend.gain.setTargetAtTime(on ? 1 : 0, t, 0.01);
    } catch {
      /* a closed context */
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
    // the session's own pause: both decks stop now, no settling (37r)
    this.cancelSettle();
    this.pauseNow();
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
      // Quantize: the cue in phase with where A is (step 6), else exactly there
      const target = this.inPhase('A', seconds, t);
      this.leaveLoopFor('A', target, t);
      const el = this.el;
      if (el) {
        this.ownSeek = true;
        // where deck A is heard: the limiter's lookahead behind it (review L5)
        el.currentTime = Math.max(0, target - this.look() * this.rateA);
      }
      engine.map('A', 0, [{ f: t * sr, p: target + 0.03 * this.rateA, r: this.rateA }], true);
      if (this.v.rateB !== null && this.v.phase === 'playing') this.relock();
      return 'jumped';
    }
    // B in the headphones before the blend, or playing in it: at once, in
    // phase with Quantize (step 6, the parity review's S7), its lock kept
    const running =
      (this.v.phase === 'ready' && this.v.previewB) ||
      this.v.phase === 'playing' ||
      this.v.phase === 'backing';
    if (running && engine?.shift) {
      if (!covers(this.bWin, seconds, 2)) return 'outside';
      const t = this.now() + 0.03;
      const pos = engine.position('B', t);
      if (pos === null) return 'outside';
      const target = this.inPhase('B', seconds, t);
      // moved while its loop is in force (the map from where it's heard), then out of it
      engine.shift('B', t * engine.sampleRate, target - pos);
      this.leaveLoopFor('B', target, t);
      // off the beat with Sync on: eased back onto A's over a bar
      if (!this.quantizes('B') && this.v.rateB !== null && this.v.phase === 'playing')
        this.relock();
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

  // ── loops, beatjump and Quantize (step 6) ──────────────────────────────

  /** The limiter's lookahead on this browser (measured by the engine), else Chromium's. */
  private look(): number {
    return this.engine?.lookahead ?? LIMIT_DELAY_S;
  }

  /** Quantize on or off (the person's setting). */
  setQuantize(on: boolean): void {
    if (this.v.quantize === on) return;
    this.update({ quantize: on });
  }

  private gridOf(deck: DeckId): BeatGrid | null {
    return (deck === 'A' ? this.a : this.b)?.grid ?? null;
  }

  /** Quantize acts on this deck: it's on, and the deck has a grid. */
  quantizes(deck: DeckId): boolean {
    return this.v.quantize && this.gridOf(deck) !== null;
  }

  /** A beat's length (s) on a deck near track second p: its grid's, else its BPM's, else 0.5. */
  private beatAt(deck: DeckId, p: number): number {
    const g = this.gridOf(deck);
    if (g) return g.periodAt(g.beatAt(p));
    const bpm = (deck === 'A' ? this.a : this.b)?.bpm;
    return bpm && bpm > 0 ? 60 / bpm : 0.5;
  }

  /** `beats` on from track second p (the grid's beats, else the BPM's). */
  private beatsFrom(deck: DeckId, p: number, beats: number): number {
    const g = this.gridOf(deck);
    if (g) return g.timeAt(g.beatAt(p) + beats);
    return p + beats * this.beatAt(deck, p);
  }

  /** A track second on the nearest beat with Quantize, else as it is. */
  private snap(deck: DeckId, p: number): number {
    const g = this.gridOf(deck);
    return this.quantizes(deck) && g ? g.timeAt(Math.round(g.beatAt(p))) : p;
  }

  /** The first beat at or after track second p (p itself without a grid). */
  private nextBeat(deck: DeckId, p: number): number {
    const g = this.gridOf(deck);
    return g ? g.timeAt(Math.ceil(g.beatAt(p) - 1e-9)) : p;
  }

  /** A jump's target in phase with where the deck is now (Quantize), else as it is. */
  private inPhase(deck: DeckId, seconds: number, t: number): number {
    const g = this.gridOf(deck);
    const pos = this.engine?.position(deck, t) ?? null;
    if (!this.quantizes(deck) || !g || pos === null) return seconds;
    const b = g.beatAt(pos);
    return g.timeAt(Math.round(g.beatAt(seconds)) + (b - Math.floor(b)));
  }

  /** Where a deck is: playing, its place; B stopped, where it's parked (or paused, or cued). */
  private deckPos(deck: DeckId, t = this.now() + 0.03): number | null {
    if (this.deckRuns(deck)) return this.engine?.position(deck, t) ?? null;
    if (deck === 'A') return this.d.player.audio()?.currentTime ?? null;
    if (this.v.phase === 'paused') return this.pausedAt;
    return this.v.parkB ?? this.b?.cue ?? null;
  }

  /** A deck runs on the engine now (A on its deck; B in the headphones or the blend). */
  private deckRuns(deck: DeckId): boolean {
    if (deck === 'A') return this.v.aOnDeck && !this.suspended;
    return this.v.previewB || ['starting', 'playing', 'backing', 'handing'].includes(this.v.phase);
  }

  /** Why a deck can't loop now, in words; null when it can. */
  loopWhy(deck: DeckId): string | null {
    if (!this.engine?.loop) return 'The decks aren’t ready';
    if (deck === 'A')
      return this.v.aOnDeck
        ? null
        : 'A loops once it’s on its deck (Play B): the player’s own playback can’t loop to the sample';
    if (!this.b || !this.bWin || ['idle', 'loading', 'failed', 'handing'].includes(this.v.phase))
      return 'B loops once it’s on its deck';
    return null;
  }

  private loopName(deck: DeckId, beats: number | null): string {
    return beats === null ? `Deck ${deck} loop` : `Deck ${deck} loop ${beatWords(beats)}`;
  }

  /**
   * A loop's end kept inside what the deck has: its window (its 3 minutes)
   * and the track's end, a little short of either (review L1); null when
   * nothing sensible fits (under a 1/32 beat).
   */
  private fitEnd(deck: DeckId, start: number, end: number): number | null {
    const win = deck === 'A' ? this.aWin : this.bWin;
    const track = (deck === 'A' ? this.a : this.b)?.duration ?? Infinity;
    const limit = Math.min(win ? win.offset + win.duration - 0.25 : Infinity, track - 0.1);
    const e = Math.min(end, limit);
    const shortest = this.beatAt(deck, start) / 32;
    return e - start >= shortest ? e : null;
  }

  /** Beats between two places on a deck's grid (to a 1/32), or null without one. */
  private beatsBetween(deck: DeckId, start: number, end: number): number | null {
    const g = this.gridOf(deck);
    return g ? Math.round((g.beatAt(end) - g.beatAt(start)) * 32) / 32 : null;
  }

  /** The deck loops over `region` from now (its In … Out), from where it is. */
  private startLoop(deck: DeckId, start: number, end: number, beats: number | null): void {
    const engine = this.engine!;
    const f = (this.now() + 0.03) * engine.sampleRate;
    engine.endLoop?.(deck, f);
    engine.loop!(deck, { start, end }, f);
    this.update({
      loops: { ...this.v.loops, [deck]: { start, end, beats, active: true } },
      loopIn: { ...this.v.loopIn, [deck]: null },
    });
  }

  /** Auto loop (its size): on from the nearest beat with Quantize, else from here; pressed again, out. */
  autoLoop(deck: DeckId): boolean {
    const why = this.loopWhy(deck);
    if (why) {
      this.say(why);
      return false;
    }
    if (this.v.loops[deck]?.active) return this.exitLoop(deck);
    const pos = this.deckPos(deck);
    if (pos === null) return false;
    const want = this.v.loopSize[deck];
    // on the beat, but never before what the deck has (its window's start)
    const win = deck === 'A' ? this.aWin : this.bWin;
    let start = this.snap(deck, pos);
    if (win && start < win.offset + 0.05)
      start =
        this.gridOf(deck) && this.quantizes(deck)
          ? this.nextBeat(deck, win.offset + 0.05)
          : win.offset + 0.05;
    const end = this.fitEnd(deck, start, this.beatsFrom(deck, start, want));
    if (end === null) {
      this.say(
        `No room for a loop here: deck ${deck}’s ${deck === 'A' ? 'track' : '3 minutes'} end`,
      );
      return false;
    }
    const beats = this.gridOf(deck) ? this.beatsBetween(deck, start, end) : null;
    this.startLoop(deck, start, end, beats);
    this.say(
      `${this.loopName(deck, beats ?? want)}${this.gridOf(deck) ? '' : ': no beat grid, the length is by its BPM'}`,
    );
    return true;
  }

  /** Loop In: here (on the beat with Quantize). */
  loopInHere(deck: DeckId): boolean {
    const why = this.loopWhy(deck);
    if (why) {
      this.say(why);
      return false;
    }
    const pos = this.deckPos(deck);
    if (pos === null) return false;
    const win = deck === 'A' ? this.aWin : this.bWin;
    let at = this.snap(deck, pos);
    if (win && at < win.offset + 0.05) at = this.nextBeat(deck, win.offset + 0.05);
    this.update({ loopIn: { ...this.v.loopIn, [deck]: at } });
    this.say(`Deck ${deck} loop in`);
    return true;
  }

  /** Loop Out: the loop from its In to here, looping now (back to its In at once). */
  loopOutHere(deck: DeckId): boolean {
    const why = this.loopWhy(deck);
    if (why) {
      this.say(why);
      return false;
    }
    const from = this.v.loopIn[deck];
    const pos = this.deckPos(deck);
    if (from === null || pos === null) {
      this.say(`Set deck ${deck}’s loop in first (I)`);
      return false;
    }
    const at = this.snap(deck, pos);
    const end = at - from < 0.01 ? null : this.fitEnd(deck, from, at);
    if (end === null) {
      this.say('The loop’s out has to be after its in');
      return false;
    }
    const beats = this.beatsBetween(deck, from, end);
    this.startLoop(deck, from, end, beats);
    this.say(this.loopName(deck, beats));
    return true;
  }

  /** Reloop: the last loop again, from its start, looping. */
  reloop(deck: DeckId): boolean {
    const why = this.loopWhy(deck);
    const l = this.v.loops[deck];
    if (why || !l) {
      this.say(why ?? `Deck ${deck} has no loop yet`);
      return false;
    }
    const engine = this.engine!;
    const t = this.now() + 0.03;
    const f = t * engine.sampleRate;
    if (this.deckRuns(deck)) {
      const pos = engine.position(deck, t);
      engine.endLoop?.(deck, f);
      if (pos !== null) this.moveDeck(deck, f, l.start - pos, l.start);
      engine.loop!(deck, { start: l.start, end: l.end }, f);
    } else {
      engine.loop!(deck, { start: l.start, end: l.end }, f);
      this.moveStopped(deck, l.start);
    }
    this.update({ loops: { ...this.v.loops, [deck]: { ...l, active: true } } });
    this.say(`${this.loopName(deck, l.beats)}: again`);
    return true;
  }

  /** Out of the loop: the deck plays on from where it is (the loop stays drawn for Reloop). */
  exitLoop(deck: DeckId, words = true): boolean {
    const l = this.v.loops[deck];
    if (!l?.active || !this.engine) return false;
    const f = (this.now() + 0.03) * this.engine.sampleRate;
    this.engine.endLoop?.(deck, f);
    this.update({ loops: { ...this.v.loops, [deck]: { ...l, active: false } } });
    // the element where A is again (it was let run while A looped)
    if (deck === 'A') this.alignElement();
    if (words) this.say(`Deck ${deck} out of the loop`);
    return true;
  }

  /** The auto loop's size (beats, 1/32 … 32); an active loop takes it from its start. */
  setLoopSize(deck: DeckId, beats: number): void {
    const b = Math.max(1 / 32, Math.min(32, beats));
    if (b === this.v.loopSize[deck] && !this.v.loops[deck]?.active) return;
    this.update({ loopSize: { ...this.v.loopSize, [deck]: b } });
    const l = this.v.loops[deck];
    if (l?.active && this.engine?.loop) {
      // smaller: the part of the loop the deck is in, so it doesn't jump (it
      // wraps as usual, crossfaded); larger, from its start; kept inside the deck's window
      const pos = this.deckRuns(deck) ? this.engine.position(deck, this.now() + 0.03) : null;
      let start = l.start;
      const g = this.gridOf(deck);
      if (pos !== null && g && l.beats !== null && b < l.beats) {
        const into = g.beatAt(pos) - g.beatAt(l.start);
        start = g.timeAt(g.beatAt(l.start) + Math.max(0, Math.floor(into / b)) * b);
      }
      const end = this.fitEnd(deck, start, this.beatsFrom(deck, start, b));
      if (end === null) {
        this.say(
          `No room for that loop: deck ${deck}’s ${deck === 'A' ? 'track' : '3 minutes'} end`,
        );
        return;
      }
      this.startLoop(deck, start, end, g ? this.beatsBetween(deck, start, end) : null);
    }
    this.say(`${this.loopName(deck, b)}${l?.active ? '' : ' size'}`);
  }

  /** ½ and ×2: the size halved or doubled (an active loop with it). */
  resizeLoop(deck: DeckId, factor: 0.5 | 2): void {
    const l = this.v.loops[deck];
    const now = l?.active && l.beats !== null ? l.beats : this.v.loopSize[deck];
    this.setLoopSize(deck, now * factor);
  }

  /** Beatjump's size (beats: 1, 4, 16, 32). */
  setJumpSize(deck: DeckId, beats: number): void {
    this.update({ jumpSize: { ...this.v.jumpSize, [deck]: beats } });
  }

  /**
   * Beatjump: back or on by its size (the loop's while looping), on the grid
   * (the beat's phase kept); an active loop moves with it. A before Play B
   * is the player's seek; B stopped moves where it's parked.
   */
  beatjump(deck: DeckId, dir: -1 | 1): boolean {
    const engine = this.engine;
    const l = this.v.loops[deck];
    const looping = Boolean(l?.active);
    const beats = looping && l!.beats !== null ? l!.beats : this.v.jumpSize[deck];
    const t = this.now() + 0.03;
    const pos = this.deckPos(deck, t);
    if (pos === null) return false;
    const by = looping && l!.beats === null ? dir * (l!.end - l!.start) : null;
    const target = by !== null ? pos + by : this.beatsFrom(deck, pos, dir * beats);
    const delta = target - pos;
    const noGrid = !this.gridOf(deck);
    // a loop moved with the jump has to fit the deck's window and track (review L1)
    if (looping && this.fitEnd(deck, l!.start + delta, l!.end + delta) !== l!.end + delta) {
      this.say(
        `The loop would run past deck ${deck}’s ${deck === 'A' ? 'track' : '3 minutes'}: no jump`,
      );
      return false;
    }
    if (deck === 'A' && !this.v.aOnDeck) {
      // A on the player's element: the player's own seek
      this.d.player.seek?.(Math.max(0, target));
    } else if (this.deckRuns(deck) && engine?.shift) {
      const win = deck === 'A' ? this.aWin : this.bWin;
      if (!covers(win, target, 2)) {
        this.say(`That jump is outside deck ${deck}’s 3 minutes`);
        return false;
      }
      const f = t * engine.sampleRate;
      // moved first (from where it's heard in its loop), then the loop moves with it
      this.moveDeck(deck, f, delta, target);
      if (looping) engine.loop!(deck, { start: l!.start + delta, end: l!.end + delta }, f);
    } else if (deck === 'B') {
      if (looping && engine?.loop) {
        const f = t * engine.sampleRate;
        engine.loop(deck, { start: l!.start + delta, end: l!.end + delta }, f);
      }
      this.moveStopped('B', this.clampB(target));
    } else return false;
    if (looping)
      this.update({
        loops: { ...this.v.loops, [deck]: { ...l!, start: l!.start + delta, end: l!.end + delta } },
      });
    this.say(
      `Deck ${deck} ${dir < 0 ? 'back' : 'on'} ${beatWords(beats)}${noGrid ? ': no beat grid, by its BPM' : ''}`,
    );
    return true;
  }

  /** A running deck moved by delta from frame f (A's element with it, B's lock kept). */
  private moveDeck(deck: DeckId, f: number, delta: number, target: number): void {
    const engine = this.engine!;
    engine.shift?.(deck, f, delta);
    if (deck === 'A') {
      const el = this.el;
      if (el) {
        this.ownSeek = true;
        el.currentTime = Math.max(0, target - this.look() * this.rateA);
      }
      if (this.v.rateB !== null && this.v.phase === 'playing') this.relock();
    } else if (!this.quantizes('B') && this.v.rateB !== null && this.v.phase === 'playing') {
      this.relock();
    }
  }

  /** B stopped: where it's parked (paused, or cued in the headphones' sense). */
  private moveStopped(deck: DeckId, p: number): void {
    if (deck !== 'B') return;
    if (this.v.phase === 'paused') {
      this.pausedAt = p;
      this.update({});
    } else this.update({ parkB: p });
  }

  /** A jump outside an active loop leaves it (Traktor's). */
  private leaveLoopFor(deck: DeckId, target: number, t: number): void {
    const l = this.v.loops[deck];
    if (!l?.active || !this.engine) return;
    if (target >= l.start && target < l.end) return;
    this.engine.loop?.(deck, null, t * this.engine.sampleRate);
    this.update({ loops: { ...this.v.loops, [deck]: { ...l, active: false } } });
  }

  /** Both decks out of their loops at once (a release, a stop, DJ mode off). */
  private dropLoops(): void {
    const engine = this.engine;
    if (engine?.loop) {
      // unwound: each deck plays on from where it is, no jump (review L2)
      const f = (this.now() + 0.03) * engine.sampleRate;
      for (const d of ['A', 'B'] as const)
        if (this.v.loops[d]?.active) {
          if (engine.endLoop) engine.endLoop(d, f);
          else engine.loop(d, null, f);
        }
    }
    const off = (l: DeckLoop | null) => (l ? { ...l, active: false } : null);
    if (
      this.v.loops.A?.active ||
      this.v.loops.B?.active ||
      this.v.loopIn.A !== null ||
      this.v.loopIn.B !== null
    )
      this.update({
        loops: { A: off(this.v.loops.A), B: off(this.v.loops.B) },
        loopIn: { A: null, B: null },
      });
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
    // A finished and Up next ran out (37j): Play B starts B on its own
    if (el && el.ended) return this.startSolo(el);
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
    // B already running in the headphones comes in from where it is (M7)
    const live = this.v.previewB;
    // a new blend: deck A is the playing track's again, heard
    this.aSilent = false;
    const ctx = engine.context;
    this.rateA0 = el.playbackRate > 0 ? el.playbackRate : 1;
    this.rateA = this.rateA0 * tempoRate(this.v.values.A.tempo);
    this.aMoved = false;
    const T = ctx.currentTime + AHEAD_S;
    // the decks are heard through the limiter's lookahead (LIMIT_DELAY_S), the
    // element isn't (review M2): deck A starts that much further on, in line
    const from = el.currentTime + (AHEAD_S + this.look()) * this.rateA;
    this.applyAll(ctx.currentTime);
    this.applyPhones();
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
    this.update({ aOnDeck: true, rateA: this.rateA });
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
    if (live) this.bringInLive(T, from);
    else this.startB(T, from, null);
  }

  /**
   * Play B while B plays in the headphones (M7): B isn't started again from
   * its cue. With Sync it glides from where it is onto A's beat (its nearest
   * beat lands on the first of A's bars, at least a beat away, it can reach
   * within 8% of Sync's speed, so the catch-up doesn't warble) at A's tempo,
   * and stays locked there; without Sync (or a grid) it carries on at its own speed.
   * The room hears it from that bar (A's next beat without Sync), at the
   * crossfader's level: until then it's in the headphones only, as before.
   */
  private bringInLive(T: number, posA: number): void {
    const engine = this.engine!;
    const { a, b } = this;
    if (!a || !b) return;
    const sr = engine.sampleRate;
    const pB = engine.position('B', T);
    if (pB === null) {
      this.startB(T, posA, null);
      return;
    }
    const lock = Boolean(this.v.sync && this.v.syncable && a.grid && b.grid);
    let Tb = T + MIN_LEAD_S;
    // with Sync: the bar B lands on, the beat of B there, and the glide's speed
    let plan: { aBeat: number; b0: number; ratio: SyncRatio; r: number } | null = null;
    if (a.grid && lock) {
      const g = b.grid!;
      const beat = a.grid.periodAt(a.grid.beatAt(posA));
      const first = nextBar(a.grid, posA, Math.max(MIN_LEAD_S * this.rateA, beat));
      const r0 = rateAt(engine.current('B'), T, sr) ?? tempoRate(this.v.values.B.tempo);
      // the first of A's bars B can reach within CATCH_UP of Sync's speed
      // (no warble), its nearest beat on that bar (review L1)
      for (let k = 0; k < 8; k++) {
        const tb = T + (a.grid.barTime(first.bar + k) - posA) / this.rateA;
        const aBeat = a.grid.barBeat(first.bar + k);
        const b0 = Math.round(g.beatAt(pB + (tb - T) * r0));
        const ratio = syncRatio(a.grid.periodAt(aBeat), g.periodAt(b0), this.rateA);
        if (!ratio) break;
        const r = (g.timeAt(b0) - pB) / Math.max(0.05, tb - T);
        Tb = tb;
        plan = { aBeat, b0, ratio, r };
        if (Math.abs(r / ratio.rate - 1) <= CATCH_UP) break;
      }
    } else if (a.grid) {
      const i = Math.ceil(a.grid.beatAt(posA + MIN_LEAD_S * this.rateA) - 1e-6);
      Tb = T + Math.max(MIN_LEAD_S, (a.grid.timeAt(i) - posA) / this.rateA);
    }
    this.started = { T, posA, bFrom: pB, Tb };
    this.dropHand();
    this.nudgeBase = null;
    this.endPreviewTimer();
    this.update({ previewB: false, parkB: null });
    let rateB: number | null = null;
    if (plan) {
      const { aBeat, b0, ratio } = plan;
      this.ratio = ratio;
      const locked = lockedKnots({
        gridA: a.grid!,
        a0: aBeat,
        rateA: this.rateA,
        gridB: b.grid!,
        b0,
        m: ratio.m,
        t0: Tb,
        sampleRate: sr,
        untilB: (this.bWin ? this.bWin.offset + this.bWin.duration : Infinity) + 1,
      });
      const r = Math.max(
        ratio.rate * (1 - CATCH_UP),
        Math.min(ratio.rate * (1 + CATCH_UP), plan.r),
      );
      engine.mode('B', this.modeFor('B', ratio.rate));
      engine.map('B', T * sr, [{ f: T * sr, p: pB, r }, ...locked]);
      rateB = locked[0]?.r ?? ratio.rate;
    }
    // the room hears B from Tb, at the crossfader's level (the decks' master comes up at T)
    const xf = this.param('B.xf');
    const to = this.targets()['B.xf'] ?? 0;
    if (xf) {
      const now = this.now();
      xf.reset(now, 0);
      xf.set(Tb, 0);
      xf.linear(Tb + RAMP_S, to);
      this.applied['B.xf'] = to;
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
            ? `${b.title || 'B'} in, on ${a.title || 'A'}’s beat`
            : `${b.title || 'B'} in: blend by ear`,
        );
      },
      (Tb - this.now()) * 1000,
    );
    this.startWatch();
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
    // a hand on B gives way to the blend (review M-3), and an arrow's base goes (N-3)
    this.dropHand();
    this.nudgeBase = null;
    // B's own play before the blend gives way to the synced start (step 4b)
    this.endPreviewTimer();
    if (this.v.previewB || this.v.parkB !== null) this.update({ previewB: false, parkB: null });
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
    if (this.v.solo) {
      // B on its own: the decks' master down at once, B stopped where it is
      const t = this.now() + 0.01;
      const pos = this.engine.position('B', t);
      this.fadeMaster(0, t, RAMP_S);
      this.engine.stop('B', Math.round((t + RAMP_S + 0.01) * this.engine.sampleRate));
      this.pausedAt = pos ?? this.b?.cue ?? 0;
      this.update({ phase: 'paused' });
      this.say(`${this.b?.title || 'B'} paused`);
      return true;
    }
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
    if (this.v.solo) {
      const sr = engine.sampleRate;
      const T = this.now() + AHEAD_S;
      const r = tempoRate(this.v.values.B.tempo) * this.rateA0;
      engine.stop('B', Infinity);
      engine.map('B', 0, [{ f: T * sr, p: this.pausedAt, r }], true);
      const g = engine.graph.master.gain;
      g.cancelScheduledValues(this.now());
      g.setValueAtTime(0, T);
      g.linearRampToValueAtTime(this.level(), T + FADE_S);
      this.master = this.level();
      this.pausedAt = null;
      this.update({ phase: 'playing' });
      this.say(`${this.b?.title || 'B'} playing on its own`);
      this.startWatch();
      return true;
    }
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

  // ── Hand over (414, 37i, 37j) ──────────────────────────────────────────

  /** Whether a deck is playing: B in a blend or before it (its preview), A on its deck. */
  deckPlaying(deck: DeckId): boolean {
    if (deck === 'A') return this.v.aOnDeck && !this.suspended;
    return this.v.previewB || ['starting', 'playing', 'backing', 'handing'].includes(this.v.phase);
  }

  /** Why Hand over can't happen now, in words; null when it can. */
  handOverWhy(): string | null {
    const b = this.b;
    if (!b) return null;
    if (this.v.phase === 'handing') return `Handing over to ${b.title || 'B'}`;
    if (this.v.phase !== 'playing') return `Hand over once ${b.title || 'B'} is playing (Play B)`;
    if (!this.engine) return 'The decks aren’t running';
    const p = this.d.player;
    if (!p.playIndex || !p.insertNext) return 'The player can’t take B here';
    if (!b.queue) return b.queueWhy ?? `Getting ${b.title || 'B'} ready for the player: a moment`;
    return null;
  }

  /** A ran out under a blend: whose advance it is (the player asks, media-player.js). */
  ownsAdvance(): boolean {
    // A on its deck in the blend (B playing, starting, paused; A looping or
    // not): the element's end is the session's to handle, never the player's
    // own skip under the decks (step 6 review N1). It hands over, or stops
    // the blend and asks the player for the next track itself.
    return this.v.aOnDeck || this.v.phase === 'handing';
  }

  /**
   * Hand over (414): the fader goes to B and B glides to its own tempo over
   * a bar (A leaves cleanly, B's speed carries on unbroken), then the player
   * takes B where the deck is: B's row goes straight after the playing one
   * (Up next after it is as it was, 422) and the player's load joins deck B
   * (`handoff`), which then fades out. `ended`: A ran out mid-blend (37j), a
   * Hand over too, over what's left of A's bar. A's deck keeps going, silent,
   * for the Undo (10 s).
   */
  handOver(reason: 'press' | 'ended' = 'press', now = false): boolean {
    const why = this.handOverWhy();
    if (why) {
      if (reason === 'press') this.say(why);
      return false;
    }
    const engine = this.engine!;
    this.clearLater();
    this.cancelSettle();
    this.dropHand();
    // loops end here, each deck playing on from where it is (step 6): the
    // player can't loop B, and A is leaving
    if (this.v.loops.B?.active) {
      this.exitLoop('B', false);
      if (reason === 'press')
        this.say(
          `${this.b?.title || 'B'}’s loop ends: the player can’t loop, it plays on from here`,
        );
    }
    if (this.v.loops.A?.active) this.exitLoop('A', false);
    const sr = engine.sampleRate;
    const t = this.now() + 0.03;
    let bar = this.barSeconds();
    if (now) bar = 0.05;
    else if (reason === 'ended') {
      const posA = engine.position('A', t);
      const left = posA !== null && this.a?.duration ? (this.a.duration - posA) / this.rateA : 0;
      bar = Math.max(0.05, Math.min(bar, left - 0.15));
    }
    // the fader to B: A out over the bar
    for (const [key, to] of [
      ['A.xf', 0],
      ['B.xf', 1],
    ] as const) {
      const p = this.param(key);
      if (!p) continue;
      p.hold(t);
      p.linear(t + bar, to);
      this.applied[key] = to;
    }
    // A's echo send out over the same bar too (it taps before the fader), and
    // A out of the headphones: A leaves cleanly (review H-1)
    const echo = this.param('A.echoSend');
    if (echo) {
      echo.hold(t);
      echo.linear(t + bar, 0);
      this.applied['A.echoSend'] = 0;
    }
    try {
      engine.graph.decks?.A.cueSend.gain.setTargetAtTime(0, t, bar / 3);
    } catch {
      /* a closed context */
    }
    // B to the player's own speed over the same bar: the element takes it there
    const pB = engine.position('B', t);
    const r0 = rateAt(engine.current('B'), t, sr) ?? 1;
    if (pB !== null && Math.abs(r0 - this.rateA0) > 1e-4) {
      engine.map('B', t * sr, glideKnots(t, pB, r0, this.rateA0, bar, sr));
      engine.mode('B', this.modeFor('B', r0 / this.rateA0));
    }
    this.ratio = null;
    this.handing = { a: this.a, b: this.b! };
    // B's channel flat over the same bar (its EQ, kills, filter, volume and
    // Auto-gain's trim): the player plays B as it is, so it's handed over as
    // it'll sound there, with no step in tone or level at the switch (M4)
    const flat = engineTargets(defaultMix(), this.beatPeriodA());
    for (const name of ['low', 'mid', 'high', 'hp', 'lp', 'volume', 'trim'] as const) {
      const key = `B.${name}` as const;
      const to = name === 'trim' ? 1 : flat[key]!;
      const p = this.param(key);
      if (!p) continue;
      p.hold(t);
      p.ramp(rampFor(name), t + bar, to);
      this.applied[key] = to;
    }
    this.update({
      phase: 'handing',
      rateB: null,
      gain: { ...this.v.gain, B: 0 },
      values: {
        ...this.v.values,
        xf: 100,
        echoSend: 0,
        B: { ...defaultMix().B, tempo: 0 },
      },
    });
    // the element (muted under deck A) flat at full: it'll be B's
    this.applyElement(this.elementTargets(this.targets()), t);
    this.applyPhones();
    const gen = this.gen;
    this.later(() => void this.switchToB(gen, reason), (bar + 0.02) * 1000);
    return true;
  }

  /** The player takes B (the bar's over). */
  private async switchToB(gen: number, reason: 'press' | 'ended'): Promise<void> {
    const engine = this.engine;
    const b = this.handing?.b ?? null;
    const player = this.d.player;
    if (gen !== this.gen || this.v.phase !== 'handing' || !engine || !b?.queue) return;
    const el = this.el ?? player.audio();
    // the listener paused during the bar (and it hasn't settled yet): the
    // Hand over stops there, paused (review M-1)
    if (
      this.settleTimer !== null ||
      this.suspended ||
      (el && this.v.aOnDeck && el.paused && !el.ended)
    ) {
      this.cancelSettle();
      this.pauseNow(true);
      return;
    }
    const solo = this.v.solo;
    const aTitle = this.handing?.a?.title || 'A';
    this.handing = null;
    // the element strip stays flat at full while the player takes B (step 5)
    this.switching = true;
    const sr = engine.sampleRate;
    const now = engine.context.currentTime;
    // A's deck goes on, silent (its fader, echo send and headphones send at
    // 0, review H-1) and at the player's own speed, while Undo can put it
    // back (only where its window has the next seconds of it)
    const posA = this.v.aOnDeck ? engine.position('A', now + 0.03) : null;
    const deckA =
      reason === 'press' &&
      posA !== null &&
      covers(this.aWin, posA, (UNDO_MS / 1000) * this.rateA0 + 2);
    if (posA !== null) {
      if (deckA)
        engine.map('A', (now + 0.03) * sr, [{ f: (now + 0.03) * sr, p: posA, r: this.rateA0 }]);
      else engine.stop('A', Math.round((now + 0.05) * sr));
    }
    // the element lets go of A: the blend no longer listens to it
    this.unbind();
    this.unbindSolo();
    this.cancelFade();
    // the queue: B's row straight after the playing one; if B is further on
    // in Up next already, that row is moved there rather than doubled (L-6)
    const st = player.state();
    const queue = st?.queue ?? [];
    const aIndex = typeof st?.index === 'number' ? st.index : -1;
    const aRow = aIndex >= 0 ? (queue[aIndex] ?? null) : null;
    let bFrom = -1;
    for (let i = aIndex + 1; i < queue.length; i++) {
      const r = queue[i] as { id?: string | number; file_path?: unknown } | null;
      const id = r?.id;
      // only a row the player can play from its file (N-3); else B's own record is inserted
      if (
        (typeof id === 'string' || typeof id === 'number') &&
        String(id) === b.id &&
        typeof r?.file_path === 'string' &&
        r.file_path
      ) {
        bFrom = i;
        break;
      }
    }
    if (el) {
      try {
        el.pause();
      } catch {
        /* not playing */
      }
      if (el.playbackRate !== this.rateA0) el.playbackRate = this.rateA0;
      el.muted = false;
      el.volume = this.level();
    }
    let stopped = false;
    let used = false;
    const stopB = () => {
      if (stopped) return;
      stopped = true;
      used = true;
      const t = engine.context.currentTime;
      const p = this.param('B.xf');
      p?.hold(t);
      p?.linear(t + JOIN_S, 0);
      this.applied['B.xf'] = 0;
      engine.stop('B', Math.round((t + JOIN_S + 0.04) * sr));
    };
    const rate0 = this.rateA0;
    const look = this.look();
    const handoff: HandoffLike = {
      // read once the player's load is ready; NaN once used or given up (review M-4)
      get currentTime() {
        // where deck B is heard (its place less the limiter's lookahead)
        const p = engine.position('B');
        return used || p === null ? Number.NaN : p - look * rate0;
      },
      pause: stopB,
      get src() {
        return '';
      },
      set src(_v: string) {
        /* the deck's source is its window */
      },
      get volume() {
        return 1;
      },
      set volume(_v: number) {
        /* the deck's level is the fader's */
      },
    };
    // A is off its deck: the player's own from here (its speed, its keys)
    this.update({ aOnDeck: false, solo: false, rateA: null });
    let idx = -1;
    let row: unknown = null;
    let result: { status: string };
    try {
      if (bFrom >= 0 && player.moveNext) {
        row = queue[bFrom] ?? null;
        idx = player.moveNext(bFrom);
      } else {
        idx = player.insertNext!(b.queue);
        row = player.state()?.queue?.[idx] ?? null;
      }
      result = await player.playIndex!(idx, { handoff });
    } catch {
      result = { status: 'failed' };
    }
    used = true;
    // auto-mix is let go whatever happened (review L-1)
    this.hold(false);
    // a failed result: the player may keep this handoff registered, and a
    // later load would stop deck B through it; it's spent now (N-2)
    const wasStopped = stopped;
    if (result.status !== 'played') stopped = true;
    if (gen !== this.gen) return;
    if (result.status !== 'played') {
      this.switching = false;
      this.handFailed(b, result.status, reason, row, bFrom, deckA, wasStopped);
      return;
    }
    if (this.suspended) {
      this.suspended = false;
      engine.setPaused(false);
    }
    this.afterHand();
    const undoable = deckA && aRow !== null && !solo;
    if (undoable) {
      this.undo = {
        aRow,
        aTitle,
        bId: b.id,
        bRow: row,
        bFrom,
        posA: posA ?? 0,
        timer: this.d.setTimeout(() => this.dropUndo(), UNDO_MS),
      };
    } else {
      if (posA !== null) engine.stop('A', Math.round((engine.context.currentTime + 0.05) * sr));
      // nothing to put back: the notice for 10 s, then the decks go (with no B loaded)
      this.handedTimer = this.d.setTimeout(() => {
        this.handedTimer = null;
        this.update({ handed: null });
        if (!this.b && !this.undo && this.v.phase === 'idle') this.end();
      }, UNDO_MS);
    }
    this.update({
      phase: 'idle',
      handed: { title: b.title, from: aTitle, ended: reason === 'ended', undo: undoable },
    });
    this.say(
      reason === 'ended'
        ? `${aTitle} ended · handed over to ${b.title || 'B'}`
        : `Handed over to ${b.title || 'B'}`,
    );
  }

  /**
   * The player didn't take B (its load failed, it was busy, nothing was
   * there, or another load superseded it; review H-2). Deck B plays on, on
   * its own, so nothing goes quiet; the queue is as it was; and if A's end
   * was owed to the player, the player advances (B then goes out over a bar
   * under what it plays, as with B on its own).
   */
  private handFailed(
    b: MixLane,
    status: string,
    reason: 'press' | 'ended',
    row: unknown,
    bFrom: number,
    deckA: boolean,
    bStopped = false,
  ): void {
    const engine = this.engine;
    const player = this.d.player;
    if (engine && deckA)
      engine.stop('A', Math.round((engine.context.currentTime + 0.05) * engine.sampleRate));
    // a newer load already stopped deck B (N-1): nothing plays here, the player's own load is on
    if (bStopped) {
      this.update({ phase: 'idle', solo: false, handed: null });
      this.gen += 1;
      this.say(`Couldn’t hand over to ${b.title || 'B'}: the player moved on`);
      return;
    }
    // B's row as it was: taken out again (or back where it was), unless it's playing
    const st = player.state();
    const at = st?.queue && row !== null ? st.queue.indexOf(row) : -1;
    if (at >= 0 && at !== st?.index) {
      try {
        if (bFrom >= 0) player.move?.(at, bFrom);
        else player.remove?.(at);
      } catch {
        /* the queue moved on */
      }
    }
    const el = player.audio();
    if (el) this.bindSolo(el);
    this.update({ phase: 'playing', solo: true, handed: null, sync: false });
    this.startWatch();
    const moving = status === 'skipped' || status === 'superseded';
    this.say(
      moving
        ? `Couldn’t hand over to ${b.title || 'B'}: the player moved on`
        : `Couldn’t hand over to ${b.title || 'B'}: it plays on here · ${this.b ? 'Hand over again or Back' : 'Back ends it'}`,
    );
    // A's end was left to DJ mode: the player's advance again
    if (reason === 'ended' && (status === 'busy' || status === 'empty')) player.next?.();
  }

  /** After a Hand over: the blend's state goes (A's tempo, Sync's ratio, the cue's start). */
  private afterHand(): void {
    this.rateA = this.rateA0;
    this.aMoved = false;
    this.ownSeek = false;
    this.started = null;
    this.pausedAt = null;
    this.ratio = null;
    // A's window stays with A's deck while the Undo can join it; it isn't read again
    this.bWin = null;
    this.bStale = false;
    this.gen += 1;
    // B is the player's track now, so lane A's: the crossfader is back on
    // A's side as the lanes swap, and the element strip (B's sound now) stays
    // flat at full (step 5)
    this.update({
      values: { ...defaultMix(), A: { ...defaultMix().A }, xf: 0 },
      rateB: null,
      rateA: null,
      window: null,
      sync: true,
      gain: { A: 0, B: 0 },
      levels: { A: this.v.levels.A, B: null },
    });
    // every param to those values; deck A runs on silent for the Undo (its
    // fader and echo send stay shut, review H-1); B's fader is left to its
    // join fade (deck B stops at the end of it)
    this.aSilent = true;
    this.switching = false;
    this.applied['B.xf'] = 0;
    this.applyAll();
    this.silenceCueA();
  }

  /** Deck A out of the headphones while it runs silent for the Undo (review H-1). */
  private silenceCueA(): void {
    try {
      this.engine?.graph.decks?.A.cueSend.gain.setTargetAtTime(0, this.now(), 0.01);
    } catch {
      /* a closed context */
    }
  }

  /** The Undo isn't offered any more: A's silent deck goes; with no B the engine too. */
  private dropUndo(): void {
    const u = this.undo;
    if (!u) return;
    this.undo = null;
    this.aSilent = false;
    this.d.clearTimeout(u.timer);
    const engine = this.engine;
    if (engine) {
      try {
        engine.stop('A', Math.round((engine.context.currentTime + 0.05) * engine.sampleRate));
      } catch {
        /* a closed context */
      }
    }
    this.update({ handed: null });
    if (!this.b) this.end();
  }

  /**
   * Undo (414, 10 s): A is the player's track again where it would be now,
   * joined from its deck (heard again over 80 ms as the player loads it, so
   * nothing goes quiet); B's row goes back as it was (out again, or back
   * where it was in Up next), so Up next is untouched (422). The store puts
   * B back in its lane, cued. A's row is found by itself, not by its old
   * place (review M-2); if it's gone there's nothing to put back.
   */
  async undoHandOver(): Promise<boolean> {
    const u = this.undo;
    const engine = this.engine;
    const player = this.d.player;
    if (!u || !engine || !player.playIndex) return false;
    const aIndex = player.state()?.queue?.indexOf(u.aRow) ?? -1;
    if (aIndex < 0) {
      this.dropUndo();
      this.say(`Can’t undo: ${u.aTitle} isn’t in the queue any more`);
      return false;
    }
    this.undo = null;
    this.d.clearTimeout(u.timer);
    // deck A heard again: its fader comes up here, and is the controls' from now
    this.aSilent = false;
    const sr = engine.sampleRate;
    const t = engine.context.currentTime + 0.01;
    // the fader to A: deck A heard again while the player loads A
    for (const [key, to] of [
      ['A.xf', 1],
      ['B.xf', 0],
    ] as const) {
      const p = this.param(key);
      if (!p) continue;
      p.hold(t);
      p.linear(t + FADE_S, to);
      this.applied[key] = to;
    }
    this.fadeMaster(this.level(), t, FADE_S);
    let stopped = false;
    let used = false;
    const stopA = () => {
      if (stopped) return;
      stopped = true;
      used = true;
      const now = engine.context.currentTime;
      this.fadeMaster(0, now + 0.005, JOIN_S);
      engine.stop('A', Math.round((now + JOIN_S + 0.04) * sr));
    };
    const rate0 = this.rateA0;
    const look = this.look();
    const handoff: HandoffLike = {
      get currentTime() {
        const p = engine.position('A');
        return used || p === null ? Number.NaN : p - look * rate0;
      },
      pause: stopA,
      get src() {
        return '';
      },
      set src(_v: string) {
        /* the deck's */
      },
      get volume() {
        return 1;
      },
      set volume(_v: number) {
        /* the fader's */
      },
    };
    this.update({ handed: null, values: { ...this.v.values, xf: 0 } });
    let result: { status: string };
    try {
      result = await player.playIndex(aIndex, { handoff });
    } catch {
      result = { status: 'failed' };
    }
    used = true;
    if (!stopped) stopA();
    if (result.status !== 'played') {
      // B carries on as the player's track (review M-3)
      this.say(`Couldn’t put ${u.aTitle} back: the player carries on`);
      if (!this.b) this.end();
      return false;
    }
    // B's row as it was, unless it's the one playing
    const st = player.state();
    const at = st?.queue && u.bRow !== null ? st.queue.indexOf(u.bRow) : -1;
    if (at >= 0 && at !== st?.index) {
      try {
        if (u.bFrom >= 0) player.move?.(at, u.bFrom);
        else player.remove?.(at);
      } catch {
        /* the queue moved on */
      }
    }
    return true;
  }

  // ── B on its own (37j: A finished and Up next ran out) ─────────────────

  /** Play B with A finished: B starts at its cue now, on its own, the fader at B. */
  private startSolo(el: HTMLAudioElement): boolean {
    const engine = this.engine;
    const b = this.b;
    if (!engine || !b || this.v.phase !== 'ready') return false;
    try {
      this.stopFresh();
      const sr = engine.sampleRate;
      const T = engine.context.currentTime + AHEAD_S;
      this.rateA0 = el.playbackRate > 0 ? el.playbackRate : 1;
      this.rateA = this.rateA0;
      this.update({ values: { ...this.v.values, xf: 100 } });
      this.applyAll(engine.context.currentTime);
      const r = tempoRate(this.v.values.B.tempo) * this.rateA0;
      engine.stop('A', Infinity);
      engine.stop('B', Infinity);
      engine.mode('B', this.modeFor('B', r));
      engine.map('B', 0, [{ f: T * sr, p: b.cue, r }], true);
      const level = this.level();
      const g = engine.graph.master.gain;
      g.cancelScheduledValues(engine.context.currentTime);
      g.setValueAtTime(0, engine.context.currentTime);
      g.setValueAtTime(0, T);
      g.linearRampToValueAtTime(level, T + FADE_S);
      this.master = level;
      this.bindSolo(el);
      this.update({ phase: 'playing', solo: true, rateB: null });
      this.say(`${b.title || 'B'} playing on its own: Hand over makes it the player’s track`);
      this.startWatch();
      return true;
    } catch {
      this.soloOut(0, 'B couldn’t start');
      return false;
    }
  }

  /** B on its own goes out over `seconds` (Back, its window's end, the player starting again). */
  private soloOut(seconds: number, words: string | null, keep = true): void {
    const engine = this.engine;
    this.clearLater();
    this.dropLoops();
    this.unbindSolo();
    if (engine && this.v.solo) {
      const t = engine.context.currentTime + 0.01;
      const s2 = Math.max(HARD_S, seconds);
      this.fadeMaster(0, t, s2);
      engine.stop('B', Math.round((t + s2 + 0.05) * engine.sampleRate));
    }
    this.update({
      solo: false,
      phase: 'idle',
      values: { ...this.v.values, xf: 0 },
    });
    delete this.applied['A.xf'];
    delete this.applied['B.xf'];
    this.gen += 1;
    if (words) this.say(words);
    // cued again for another go, once the fade is over
    if (keep && this.a && this.b)
      this.d.setTimeout(
        () => {
          if (this.v.phase === 'idle' && this.a && this.b) void this.prepare(false);
        },
        (Math.max(HARD_S, seconds) + 0.1) * 1000,
      );
  }

  private bindSolo(el: HTMLAudioElement): void {
    this.unbindSolo();
    this.soloEl = el;
    el.addEventListener('play', this.onSoloPlayer);
    el.addEventListener('loadstart', this.onSoloPlayer);
  }

  private unbindSolo(): void {
    const el = this.soloEl;
    if (!el) return;
    el.removeEventListener('play', this.onSoloPlayer);
    el.removeEventListener('loadstart', this.onSoloPlayer);
    this.soloEl = null;
  }

  /** The player plays again (Play, another track): it obeys, B goes out over a bar. */
  private readonly onSoloPlayer = () => {
    if (!this.v.solo || this.v.phase === 'handing') return;
    this.soloOut(this.barSeconds(), `${this.b?.title || 'B'} out: the player plays again`);
  };

  // ── Next or another track under a blend (37j) ──────────────────────────

  /**
   * The player obeys: A's deck stops at once (the element is loading what
   * comes next, unmuted), B is cut back over a bar, then stays loaded and is
   * cued again for the new A (Sync replans for its tempo).
   */
  private cutBack(): void {
    const engine = this.engine;
    const el = this.el;
    this.clearLater();
    this.cancelSettle();
    if (engine && this.v.aOnDeck) {
      const now = engine.context.currentTime;
      const sr = engine.sampleRate;
      const bOn = ['playing', 'starting', 'backing'].includes(this.v.phase);
      const bar = bOn ? this.barSeconds() : HARD_S;
      const pa = this.param('A.xf');
      pa?.hold(now);
      pa?.linear(now + HARD_S, 0);
      this.applied['A.xf'] = 0;
      engine.stop('A', Math.round((now + HARD_S + 0.02) * sr));
      const pb = this.param('B.xf');
      pb?.hold(now);
      pb?.linear(now + bar, 0);
      this.applied['B.xf'] = 0;
      engine.stop('B', Math.round((now + bar + 0.05) * sr));
      this.cancelFade();
      if (el) {
        el.muted = false;
        el.volume = this.level();
      }
      this.update({ values: { ...this.v.values, xf: 0 } });
      if (bOn) this.say(`${this.b?.title || 'B'} cut back over a bar`);
    }
    this.afterRelease(false);
  }

  private cancelSettle(): void {
    if (this.settleTimer !== null) this.d.clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  // ── B before the blend, and the hand on the platter (step 4b) ──────────

  /**
   * B's own Play before the blend (a CDJ's Play on deck B): B plays from
   * where it's parked (its cue unless a scrub or a pause moved it), at its
   * own tempo, into the headphones; the speakers don't hear it (A is on the
   * player, so the decks' master is down, and the fader is at A). Play B is
   * still the synced start: it takes B back to its cue and brings it in on
   * A's next bar.
   */
  previewB(on: boolean): boolean {
    const engine = this.engine;
    const b = this.b;
    if (!engine || !b || this.v.phase !== 'ready' || !this.bWin || this.v.aOnDeck) return false;
    if (on === this.v.previewB) return true;
    const sr = engine.sampleRate;
    const t = this.now() + 0.03;
    if (!on) {
      const p = engine.position('B', t);
      engine.stop('B', Math.round((t + 0.01) * sr));
      this.endPreviewTimer();
      this.update({ previewB: false, parkB: p ?? this.v.parkB });
      return true;
    }
    const ctx = engine.context as BaseAudioContext & {
      state?: string;
      resume?: () => Promise<void>;
    };
    if (ctx.state && ctx.state !== 'running') void ctx.resume?.().catch(() => undefined);
    const from = this.clampB(this.v.parkB ?? b.cue);
    const r = tempoRate(this.v.values.B.tempo);
    this.speakersOff();
    engine.stop('B', Infinity);
    engine.mode('B', this.modeFor('B', r));
    engine.map('B', 0, [{ f: t * sr, p: from, r }], true);
    this.update({ previewB: true, parkB: null });
    // the window's end stops it (there's nothing past it on the deck)
    const end = this.bWin.offset + this.bWin.duration;
    this.endPreviewTimer();
    this.previewTimer = this.d.setTimeout(
      () => {
        this.previewTimer = null;
        if (this.v.previewB) this.previewB(false);
      },
      (Math.max(0, end - from) / Math.max(0.25, r)) * 1000,
    );
    return true;
  }

  /** The decks' master held at 0: before the blend B is for the headphones only. */
  private speakersOff(): void {
    const engine = this.engine;
    if (!engine) return;
    try {
      const g = engine.graph.master.gain;
      const now = engine.context.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(0, now);
      this.master = 0;
    } catch {
      /* a closed context */
    }
  }

  private endPreviewTimer(): void {
    if (this.previewTimer !== null) this.d.clearTimeout(this.previewTimer);
    this.previewTimer = null;
  }

  /** B's place while it's stopped (CUE's return, a seek of B's transport): ready or paused. */
  parkB(seconds: number): void {
    const p = this.clampB(seconds);
    if (this.v.phase === 'paused') {
      this.pausedAt = p;
      this.update({});
      return;
    }
    if (this.v.phase !== 'ready') return;
    if (this.v.previewB) {
      this.previewB(false);
    }
    this.update({ parkB: p });
  }

  /** A track second inside B's window (the deck has nothing outside it). */
  private clampB(p: number): number {
    const w = this.bWin;
    if (!w) return p;
    return Math.max(w.offset + 0.05, Math.min(w.offset + w.duration - 0.05, p));
  }

  /**
   * A hand on a deck's platter (a press on its waveform): null when it's
   * on, else why not. A playing deck is nudged (it speeds up or slows down
   * with the hand and keeps where it's moved to); a stopped one scrubs
   * (it moves only as the hand does, audibly). Deck A only once it's on its
   * deck: on the player's element it's the player's own (step 4b, 496).
   */
  grab(deck: DeckId): string | null {
    const engine = this.engine;
    if (!engine) return 'The decks aren’t ready';
    const ctx = engine.context as BaseAudioContext & { state?: string };
    if (ctx.state && ctx.state !== 'running') return 'Paused: play to move the decks';
    if (this.v.phase === 'handing') return 'Handing over: a moment';
    let p: number | null;
    let base: number;
    const t = this.now() + 0.03;
    if (deck === 'A') {
      if (!this.v.aOnDeck)
        return 'A is the player’s: nudge and scrub it once it’s on its deck (Play B)';
      p = engine.position('A', t);
      base = this.rateA;
    } else {
      if (!this.b || !this.bWin) return 'B isn’t on its deck yet';
      if (this.v.phase === 'starting') return 'B comes in on A’s next bar';
      const moving =
        (this.v.phase === 'playing' || this.v.phase === 'backing' || this.v.previewB) &&
        this.v.phase !== 'paused';
      if (moving) {
        p = engine.position('B', t);
        base = rateAt(engine.current('B'), t, engine.sampleRate) ?? 1;
      } else if (this.v.phase === 'ready' || this.v.phase === 'paused') {
        p =
          this.v.phase === 'paused' ? (this.pausedAt ?? this.b.cue) : (this.v.parkB ?? this.b.cue);
        base = 0;
      } else return 'B isn’t on its deck yet';
    }
    if (p === null) return 'The deck isn’t playing';
    this.dropHand();
    const stopped = base === 0;
    // B scrubbed before the blend: the headphones only
    if (!this.v.aOnDeck && !this.v.solo) this.speakersOff();
    engine.mode(deck, 'resample');
    if (stopped) {
      // the platter held still: the deck runs at speed 0 where it is
      engine.stop(deck, Infinity);
      engine.map(deck, 0, [{ f: t * engine.sampleRate, p, r: 0 }], true);
    }
    this.handOn = {
      deck,
      base,
      p0: p,
      t0: t,
      offset: 0,
      stopped,
      timer: null,
      phase: this.v.phase,
    };
    this.update({ hand: deck });
    const tick = () => {
      const h = this.handOn;
      if (!h) return;
      this.followHand();
      h.timer = this.d.setTimeout(tick, HAND_MS);
    };
    this.handOn.timer = this.d.setTimeout(tick, HAND_MS);
    return null;
  }

  /** The hand has moved the deck `offset` track seconds from where it was grabbed. */
  moveHand(deck: DeckId, offset: number): void {
    const h = this.handOn;
    if (!h || h.deck !== deck || !Number.isFinite(offset)) return;
    h.offset = offset;
    this.followHand();
  }

  /** The deck follows the hand: its speed is what gets it there over HAND_TAU. */
  private followHand(): void {
    const h = this.handOn;
    const engine = this.engine;
    if (!h || !engine) return;
    const sr = engine.sampleRate;
    const t = this.now() + 0.03;
    const pNow = engine.position(h.deck, t) ?? h.p0;
    const target = h.p0 + h.base * (t - h.t0) + h.offset;
    let r = h.base + (target - pNow) / HAND_TAU;
    r = Math.max(-HAND_MAX, Math.min(HAND_MAX, r));
    // never past the window's ends
    const w = h.deck === 'A' ? this.aWin : this.bWin;
    if (
      w &&
      ((pNow <= w.offset + 0.05 && r < 0) || (pNow >= w.offset + w.duration - 0.05 && r > 0))
    )
      r = 0;
    engine.map(h.deck, t * sr, [{ f: t * sr, p: pNow, r }]);
  }

  /** B held to A's beat by Sync right now. */
  private lockedB(): boolean {
    return (
      this.v.rateB !== null &&
      this.ratio !== null &&
      this.v.aOnDeck &&
      (this.v.phase === 'playing' || this.v.phase === 'backing')
    );
  }

  /** Whoever had a hand on a deck lets go (the overlay closed). */
  releaseHand(): void {
    if (this.handOn) this.letGo(this.handOn.deck);
  }

  /** The hand lets go: a nudged deck carries on at its speed from where it is; a scrubbed one stays put. */
  letGo(deck: DeckId): void {
    const h = this.handOn;
    const engine = this.engine;
    if (!h || h.deck !== deck) return;
    this.dropHand(false);
    // the deck has moved on since (Play B, Hand over, Back): it's not the hand's any more
    if (!engine || h.phase !== this.v.phase) return;
    const sr = engine.sampleRate;
    const t = this.now() + 0.03;
    const p = engine.position(deck, t) ?? h.p0;
    if (h.stopped) {
      engine.stop(deck, Math.round((t + 0.01) * sr));
      if (deck === 'B') {
        if (this.v.phase === 'paused') this.pausedAt = p;
        else if (this.v.phase === 'ready') this.update({ parkB: p });
      }
    } else if (deck === 'B' && this.lockedB()) {
      // held to A by Sync: locked again where the hand moved it (review L-2)
      this.lockInPlace(t);
    } else {
      engine.map(deck, t * sr, [{ f: t * sr, p, r: h.base }]);
    }
    engine.mode(deck, this.modeFor(deck, deck === 'A' ? this.rateA / this.rateA0 : h.base));
    this.update({ hand: null });
  }

  /**
   * The hand comes off. `settle` (a phase change took it, not a let-go): a
   * playing deck goes back to its speed from where it is (Sync's lock for
   * B, re-review N-2), a scrubbed one stops there.
   */
  private dropHand(settle = true): void {
    const h = this.handOn;
    if (!h) return;
    this.d.clearTimeout(h.timer);
    this.handOn = null;
    const engine = this.engine;
    if (settle && engine) {
      try {
        const sr = engine.sampleRate;
        const t = this.now() + 0.03;
        if (h.stopped) engine.stop(h.deck, Math.round((t + 0.01) * sr));
        else if (h.deck === 'B' && this.lockedB()) this.lockInPlace(t);
        else {
          const p = engine.position(h.deck, t);
          if (p !== null) engine.map(h.deck, t * sr, [{ f: t * sr, p, r: h.base }]);
        }
        engine.mode(
          h.deck,
          this.modeFor(h.deck, h.deck === 'A' ? this.rateA / this.rateA0 : h.base),
        );
      } catch {
        /* a closed context */
      }
    }
    if (this.v.hand !== null) this.update({ hand: null });
  }

  /**
   * ← → on a lane (37p's nudge): the deck a little faster or slower while
   * the key is held (`dir` ±1), back to its speed where it is when let go
   * (0). Only a playing deck; A once it's on its deck.
   */
  nudge(deck: DeckId, dir: -1 | 0 | 1): boolean {
    const engine = this.engine;
    // a let-go always forgets the base, even when the deck stopped meanwhile (re-review N-3)
    const heldBase = this.nudgeBase;
    if (dir === 0) this.nudgeBase = null;
    if (!engine) return false;
    const playing =
      deck === 'A'
        ? this.v.aOnDeck && this.v.phase !== 'handing'
        : this.v.phase === 'playing' || this.v.phase === 'backing' || this.v.previewB;
    if (!playing) return false;
    const sr = engine.sampleRate;
    const t = this.now() + 0.03;
    const p = engine.position(deck, t);
    if (p === null) return false;
    const base = deck === 'A' ? this.rateA : (heldBase ?? rateAt(engine.current('B'), t, sr) ?? 1);
    if (dir === 0) {
      if (deck === 'B' && this.lockedB()) this.lockInPlace(t);
      else engine.map(deck, t * sr, [{ f: t * sr, p, r: base }]);
      return true;
    }
    if (deck === 'B' && this.nudgeBase === null) this.nudgeBase = base;
    engine.map(deck, t * sr, [{ f: t * sr, p, r: base * (1 + dir * NUDGE) }]);
    return true;
  }

  // ── the ends of the windows ────────────────────────────────────────────

  /** A bar before either deck's window runs out, the fader comes back to A by itself (424). */
  private startWatch(): void {
    if (this.watchTimer !== null) this.d.clearTimeout(this.watchTimer);
    const tick = () => {
      this.watchTimer = null;
      if ((!this.v.aOnDeck && !this.v.solo) || !this.engine) return;
      if (this.v.phase === 'handing') return;
      // auto-mix turned on (or made again) under the blend hears the hold again (re-review N3)
      if (this.held) {
        try {
          this.d.autoHold?.(true);
        } catch {
          /* never block the decks */
        }
      }
      // A looping on its deck: the muted element is kept where A is, so the
      // player's clock, its end and Back's join stay A's (step 6)
      // (seeked only once it's run past the loop, about once a loop, review L3)
      const la = this.v.loops.A;
      if (la?.active && this.el) {
        const t = this.el.currentTime;
        // and before it can reach the track's end under a loop near it (review N1)
        const end = this.a?.duration ?? Infinity;
        if (t < la.start - 0.5 || t > la.end + 0.5 || t > end - 1) this.alignElement(0.25);
      }
      // A running out while B plays is a Hand over (37j), over what's left of A
      const leftA = this.trackLeftA();
      if (
        leftA !== null &&
        leftA < this.barSeconds() + END_MARGIN_S &&
        this.v.phase === 'playing' &&
        this.handOverWhy() === null
      ) {
        this.handOver('ended');
        return;
      }
      const left = this.timeLeft();
      if (left !== null && left < this.barSeconds() + END_MARGIN_S) {
        if (this.v.solo) {
          this.soloOut(
            this.barSeconds(),
            `${this.b?.title || 'B'} stopped: the decks’ 3 minutes are up · Hand over to carry on next time`,
          );
          return;
        }
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

  /** Output seconds until A's track ends on its deck, or null. */
  private trackLeftA(): number | null {
    if (!this.v.aOnDeck || !this.a?.duration) return null;
    // looping, A can't run out: its end is weighed again once it's out of the loop (review M2)
    if (this.v.loops.A?.active) return null;
    const posA = this.engine?.position('A') ?? null;
    return posA === null ? null : (this.a.duration - posA) / this.rateA;
  }

  /** Output seconds until the first window runs out (A's only where the track goes on past it). */
  private timeLeft(): number | null {
    const engine = this.engine!;
    const out: number[] = [];
    const posA = this.v.aOnDeck ? engine.position('A') : null;
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
    this.dropHand();
    if (this.v.solo && this.v.phase === 'playing') {
      // B on its own: it goes out over a bar (A had finished)
      this.soloOut(
        this.barSeconds(),
        done ? null : `${this.b?.title || 'B'} out over a bar`,
        !done,
      );
      if (done) {
        this.later(
          () => {
            this.end();
            done();
          },
          (this.barSeconds() + 0.1) * 1000,
        );
      }
      return;
    }
    if (this.v.phase === 'handing') return;
    if (!engine || !this.blending || this.v.phase === 'backing') {
      if (done) {
        this.end();
        done();
      }
      return;
    }
    // A goes back to the player's element, which can't loop: it plays on from where it is (step 6)
    if (this.v.loops.A?.active) {
      this.exitLoop('A', false);
      this.say(`${this.a?.title || 'A'}’s loop ends: back on the player it plays on`);
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
    this.dropHand();
    if (engine && this.v.aOnDeck) {
      const now = engine.context.currentTime;
      const level = this.level();
      this.alignElement();
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
   * The element to where deck A is (review M1): it follows A's speed, but a
   * browser's rate is only near enough, so before A goes back onto it the
   * element is put where A is when they've drifted apart (the session's own
   * seek, not a person's).
   */
  private alignElement(within = ALIGN_S): void {
    const el = this.el;
    if (!el || !this.v.aOnDeck || (el.ended && within > 0)) return;
    const at = this.engine?.position('A') ?? null;
    // where deck A is heard: its place less the limiter's lookahead
    const p = at === null ? null : at - this.look() * this.rateA;
    if (p === null || !Number.isFinite(p)) return;
    if (within > 0 && Math.abs(el.currentTime - p) <= within) return;
    this.ownSeek = true;
    try {
      el.currentTime = p;
    } catch {
      this.ownSeek = false;
    }
  }

  /**
   * The hard stop (a close, DJ mode off, a seek, another track, the track's
   * end): the decks out over 40 ms, the element unmuted at its level at once.
   * `align`: the element put where deck A is first (not for a person's seek
   * or the track's end, where the element is already where it should be).
   */
  private hardStop(words: string | null, keep = true, align = true): void {
    const engine = this.engine;
    this.clearLater();
    this.dropHand();
    if (align) this.alignElement();
    if (this.v.aOnDeck) {
      // A back on its element at full, wherever the crossfader was: A is
      // never left silent (as Back and Next do, review L3)
      if (this.v.values.xf !== 0) this.update({ values: { ...this.v.values, xf: 0 } });
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
    this.handing = null;
    // the decks' loops end with the blend (A is the element's again)
    this.dropLoops();
    // A goes back onto its element at its own tempo (413)
    const el = this.el;
    if (el && this.v.aOnDeck && el.playbackRate !== this.rateA0) el.playbackRate = this.rateA0;
    this.rateA = this.rateA0;
    this.aMoved = false;
    this.ownSeek = false;
    if (this.v.values.A.tempo !== 0)
      this.update({ values: { ...this.v.values, A: { ...this.v.values.A, tempo: 0 } } });
    this.unbind();
    this.started = null;
    this.hold(false);
    this.pausedAt = null;
    // A is off its deck first: nothing after this is a blend to stop (re-review N2)
    this.update({ aOnDeck: false, rateB: null, rateA: null });
    // Auto-gain's trims for the lanes as they are now (they waited out the blend)
    this.refreshGain();
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
    this.cancelSettle();
    this.handing = null;
    this.dropHand();
    this.endPreviewTimer();
    if (this.undo) {
      this.d.clearTimeout(this.undo.timer);
      this.undo = null;
    }
    if (this.handedTimer !== null) this.d.clearTimeout(this.handedTimer);
    this.handedTimer = null;
    this.hold(false);
    if (this.v.solo) this.soloOut(0, null, false);
    if (this.v.aOnDeck) this.hardStop(null, false);
    this.dropLoops();
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
    this.switching = false;
    this.aSilent = false;
    this.update({
      phase: 'idle',
      error: null,
      window: null,
      rateB: null,
      rateA: null,
      gain: { A: 0, B: 0 },
      aOnDeck: false,
      values: defaultMix(),
      sync: true,
      solo: false,
      handed: null,
      previewB: false,
      parkB: null,
      hand: null,
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

  /**
   * Pause pauses both: the context stops (the listener's, not an
   * interruption). It waits SETTLE_MS first: the player loading another
   * track pauses its element on the way (then B is cut back, not paused).
   */
  private readonly onPause = () => {
    if (!this.engine || !this.v.aOnDeck || this.el?.ended) return;
    this.settle(() => this.pauseNow());
  };

  private settle(fn: () => void): void {
    this.cancelSettle();
    this.settleTimer = this.d.setTimeout(() => {
      this.settleTimer = null;
      fn();
    }, SETTLE_MS);
  }

  /**
   * The listener's Pause, settled: both decks pause. During Hand over's bar
   * it stops the Hand over there (review M-1): the fader and B's speed carry
   * on to where they were going when Play resumes, B playing at its own
   * speed with the fader at B, and H hands over again.
   */
  private pauseNow(handing = false): void {
    const engine = this.engine;
    const el = this.el;
    if (this.v.phase === 'handing' && (handing || (el?.paused && !el.ended))) {
      this.clearLater();
      this.handing = null;
      this.update({ phase: 'playing', sync: false });
      this.say(`Paused: Hand over stopped · H hands over to ${this.b?.title || 'B'} again`);
      this.startWatch();
    }
    if (!engine || !this.v.aOnDeck || !el || !el.paused || el.ended) return;
    if (this.suspended) return;
    this.suspended = true;
    engine.setPaused(true);
    const ctx = engine.context as AudioContext;
    if (typeof ctx.suspend === 'function') void ctx.suspend().catch(() => undefined);
  }

  private readonly onPlay = () => {
    const engine = this.engine;
    // a pause that hadn't settled yet: nothing to resume
    if (this.settleTimer !== null && this.el && !this.el.paused) this.cancelSettle();
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
    // a person's seek (not the player loading another track, which empties
    // the element next): the hard stop, A where they put it
    this.settle(() => {
      if (!this.v.aOnDeck) return;
      this.hardStop(`The blend stopped: ${this.a?.title || 'the track'} moved`, true, false);
    });
  };

  /** A ran out on its deck's watch: the player goes on as it always does (Hand over is step 4). */
  private readonly onEnded = () => {
    // A looping on its deck: the element ran on to the end under it; it's
    // put back where A is and plays on (A hasn't ended, step 6)
    if (this.v.loops.A?.active && this.v.aOnDeck && this.el) {
      this.alignElement(0);
      void this.el.play?.()?.catch?.(() => undefined);
      return;
    }
    if (this.ended) return;
    this.ended = true;
    // A ran out while B plays (37j): a Hand over now, B where it is; the
    // player left the advance to DJ mode (ownsAdvance), so if the Hand over
    // can't happen the advance is the player's again
    if (this.v.phase === 'handing') return;
    if (this.v.phase === 'playing' && this.handOverWhy() === null) {
      if (this.handOver('ended', true)) return;
    }
    // the blend stops and the player goes on as it would have (its advance was left to us)
    const owned = this.v.aOnDeck;
    this.hardStop(`${this.a?.title || 'The track'} ended: the blend stopped`, false, false);
    if (owned) this.d.player.next?.();
  };

  /** Another track loading on the element (Next, a row played): the player obeys (37j). */
  private readonly onOther = () => {
    if (!this.v.aOnDeck || this.v.phase === 'handing') return;
    this.cancelSettle();
    // a context the listener's Pause suspended is resumed with the release
    this.cutBack();
  };

  dispose(): void {
    this.end();
    this.listeners.clear();
  }
}

/** A loop's or a jump's size in words: "4 beats", "1 beat", "1/8 beat". */
export function beatWords(beats: number): string {
  if (beats >= 1) return `${beats} ${beats === 1 ? 'beat' : 'beats'}`;
  return `1/${Math.round(1 / beats)} beat`;
}
