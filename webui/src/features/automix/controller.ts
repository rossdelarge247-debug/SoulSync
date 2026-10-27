/**
 * Auto-mix in real playback (stage C; BACKLOG "Auto-mix: beat-matched
 * transitions in Up next"; boards 26a–26j; HANDOFF "Dev, auto-mix stage C
 * of 27 October").
 *
 * The player (static/media-player.js) plays every track on its `<audio>`
 * element as it always has. With DJ mix on, for the pair that's next (the
 * playing track and the one after it, both library tracks with their
 * files), this:
 *
 * 1. plans the pair (`GET /api/library/dj/plan` with the chip's style);
 * 2. about 45 s before the plan's `out.start`, fetches both tracks' grids
 *    and each deck's window, one at a time through the loader's line;
 * 3. two bars before `out.start` (the run-up), takes the outgoing track
 *    over from the element: deck A starts at the element's place on the
 *    context's clock, the element fades out under it and goes on muted,
 *    keeping time for the bar and the record; the engine mixes deck B in;
 * 4. once the mix is over and the incoming deck is back at its own speed,
 *    hands it back to the element: the player loads the incoming track and
 *    joins the deck where it is (the crossfade's own hand-off), and the
 *    decks let go of their windows.
 *
 * So the engine only ever plays a transition: every track is the player's
 * from shortly after its mix in to shortly before its mix out, with its
 * seek, scrobble, lyrics, Media Session and EQ as before. (The other way,
 * keeping the incoming track on the engine to the next transition, would
 * need the whole track decoded in the browser, 100–200 MB a deck, and
 * every one of the player's features moved onto the decks.)
 *
 * Interruptions and the listener: Pause pauses both (the context is
 * suspended and lifecycle.ts told it's the listener's, so it's no
 * interruption); a seek during the countdown cancels the mix and the
 * element plays on from where it was sent, during the mix it finishes the
 * mix over one bar; Next during the mix cuts to the incoming track where it
 * is, during the countdown it cancels and skips as always; any other load
 * (a row, Previous, a page's Play) lets the mix go; a queue edit that
 * changes the next track cancels a countdown (a mix in progress finishes
 * into its track, which is put back after the playing one if it was
 * removed); a context the system suspends cancels a countdown and finishes
 * a mix with a 2 s crossfade when sound is back, and a phone's page going
 * hidden finishes the mix over one bar (executor.ts, Design's 252).
 *
 * DJ mix off, a podcast, an audiobook, radio, a stream, shuffle or repeat
 * one: nothing here runs, and the player plays as it always has.
 */

import type { BeatClock, Knot } from '@/features/engine/clock';
import type { DeckData, DeckReport } from '@/features/engine/engine';
import type { TransitionInput, TransitionState } from '@/features/engine/executor';
import type { ApiGrid, BeatGrid } from '@/features/engine/grid';
import type { DeckId, Score } from '@/features/engine/score';

import { gridFromApi, relativeTrimDb } from '@/features/engine/grid';
import { correction, onsets } from '@/features/engine/refine';
import { windowLevels, windowsFor, type Windows } from '@/features/engine/windows';

import type { AutomixPrefs } from './prefs';

import { AUTO_CHOICE, type Choice, type ChipStyle, type PairPlan } from './plans';

// ── what auto-mix reads and drives ─────────────────────────────────────────

export interface QueueTrack {
  id?: string | number | null;
  title?: string;
  artist?: string;
  album_id?: string | number | null;
  file_path?: string;
  is_library?: boolean;
  kind?: string;
  media_src?: string;
  duration?: number | null;
  image_url?: string | null;
  /** the chip chosen in Up next for the gap after this track (lasts for this queue) */
  automix?: Choice | null;
  /** queued from a mix set (Play as a mix): its row and the set's chip after it */
  mix_set?: { id: number; name: string; row: number; transition?: Choice | null } | null;
}

export interface PlayerSnapshotLike {
  track: QueueTrack | null;
  kind: string | null;
  playing: boolean;
  queue: QueueTrack[];
  index: number;
  shuffle: boolean;
  repeat: string;
  volume: number;
  muted: boolean;
  crossfading?: boolean;
  crossfadeSeconds?: number;
  playbackRate?: number;
  /** the sleep timer: minutes, or 'track' (pause at the end of this one) */
  sleep?: number | 'track';
}

export interface CrossfadeHint {
  skip?: boolean;
  startAt?: number;
  inAt?: number;
  gain?: number;
  seconds?: number;
}

export interface HandoffLike {
  readonly currentTime: number;
  pause(): void;
  src: string;
  volume: number;
}

export interface PlayerPort {
  state(): PlayerSnapshotLike;
  audio(): HTMLAudioElement | null;
  playIndex(
    index: number,
    options: { handoff?: HandoffLike; automix?: boolean },
  ): Promise<{ status: string } | undefined>;
  crossfadeInto(index: number, hint: CrossfadeHint | null): boolean;
  insertNext(track: QueueTrack): number;
  renderQueue(): void;
}

export interface TransitionLike {
  state(): TransitionState;
  cancel(): void;
  finishNow(bars?: number): void;
  back(): void;
  readonly beatClock: BeatClock;
  readonly score: Score;
}

export interface EngineLike {
  readonly context: BaseAudioContext;
  readonly sampleRate: number;
  readonly graph: { master: GainNode };
  load(deck: DeckId, data: DeckData): void;
  unload(deck: DeckId): void;
  play(deck: DeckId, at: number, from: number, rate?: number): void;
  stop(deck: DeckId, atFrame: number): void;
  position(deck: DeckId, at?: number): number | null;
  current(deck: DeckId): Knot[];
  report(deck: DeckId): { frame: number; report: DeckReport } | null;
  mix(input: TransitionInput): TransitionLike;
  setPaused(on: boolean): void;
}

export interface AutomixServices {
  plan(from: string, to: string, choice: Choice, lean: AutomixPrefs['lean']): Promise<PairPlan>;
  grids(ids: string[]): Promise<Record<string, ApiGrid>>;
  window(ctx: BaseAudioContext, id: string, start: number, dur: number): Promise<DeckData>;
  /** the engine on the player's audio graph (made once), or null where it can't be */
  engine(): Promise<EngineLike | null>;
  /** a track's waveform (200 peaks), for Smart crossfade's silences */
  peaks(id: string): Promise<number[] | null>;
  prefs(): AutomixPrefs;
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(id: unknown): void;
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(id: unknown): void;
  };
}

// ── what the chips and the handover view read ──────────────────────────────

export type Stage =
  | 'idle'
  | 'planned'
  | 'loading'
  | 'ready'
  | 'counting'
  | 'mixing'
  | 'settling'
  | 'handback'
  | 'back'
  | 'rejoin'
  | 'fallback';

export interface Lane {
  /** 0–1 levels, one per step of the ruler */
  levels: Float32Array;
}

export interface HandoverLanes {
  /** the ruler, in master beats from the mix's start (φ): from φ0 to φ1 */
  phi0: number;
  phi1: number;
  /** the window: 0 to beats */
  beats: number;
  /** a marker (the bass swap, the drop) */
  marker: { beat: number; label: string } | null;
  a: Lane;
  b: Lane;
}

export interface AutomixView {
  /** DJ mix applies to the playing pair (the setting, or a set played as a mix) */
  dj: boolean;
  stage: Stage;
  /** the pair that's next, while there is one */
  pair: {
    fromId: string;
    toId: string;
    fromTitle: string;
    fromArtist: string;
    toTitle: string;
    toArtist: string;
    toIndex: number;
    choice: Choice;
    fromSet: QueueTrack['mix_set'] | null;
  } | null;
  plan: PairPlan | null;
  planError: string | null;
  /** seconds to `out.start` (the first chip's "in 2:58") */
  inSeconds: number | null;
  /** where the mix starts, in the playing track's seconds (the waveform's cyan marker) */
  outStart: number | null;
  /** the countdown, in bars (Mix now, or the last 16 bars before an automatic mix) */
  barsToGo: number | null;
  manual: boolean;
  transition: TransitionState | null;
  /** where the ruler's playhead is (φ), while it mixes */
  phi: number | null;
  lanes: HandoverLanes | null;
  /** the fallback's reason, while a crossfade plays in a mix's place (26e) */
  fallback: string | null;
  canMixNow: boolean;
  mixNowWhy: string | null;
  /** the incoming deck's tempo change against its own (26d: "124.0 (−1.6%)") */
  incomingBpm: { bpm: number; pct: number } | null;
}

const EMPTY_VIEW: AutomixView = {
  dj: false,
  stage: 'idle',
  pair: null,
  plan: null,
  planError: null,
  inSeconds: null,
  outStart: null,
  barsToGo: null,
  manual: false,
  transition: null,
  phi: null,
  lanes: null,
  fallback: null,
  canMixNow: false,
  mixNowWhy: null,
  incomingBpm: null,
};

// ── timings ────────────────────────────────────────────────────────────────

/** windows are fetched this long before the mix starts (seconds) */
export const PRELOAD_S = 45;
/** the decks take over this many bars before the mix starts (the run-up) */
export const LEAD_BARS = 2;
/** and the window for deck A starts this many bars before (room for a late tick) */
const PREROLL_BARS = 4;
/** an automatic mix counts down over its last 16 bars (26e) */
const COUNTDOWN_BARS = 16;
/** Mix now waits at least this long for the windows (seconds) */
const MIX_NOW_LEAD_S = 6;
/** the hand-over fades between the element and a deck (seconds) */
const FADE_S = 0.08;
/** how far ahead the decks start, past the context's time */
const AHEAD_S = 0.12;
const TICK_MS = 120;

// ── helpers ────────────────────────────────────────────────────────────────

const PER = { same: 1, half: 0.5, double: 2 } as const;

function idOf(t: QueueTrack | null | undefined): string {
  return t && t.id !== null && t.id !== undefined ? String(t.id) : '';
}

/** A library track with its file: what a deck can play. */
export function mixable(t: QueueTrack | null | undefined): boolean {
  if (!t || !idOf(t) || !t.file_path || t.media_src) return false;
  return !t.kind || t.kind === 'library';
}

/** The chip for the gap after a track: Up next's choice, else its set's, else Auto. */
export function choiceOf(t: QueueTrack | null | undefined): Choice {
  const c = t?.automix ?? t?.mix_set?.transition ?? null;
  return c && c.style ? { style: c.style as ChipStyle, bars: c.bars ?? null } : AUTO_CHOICE;
}

/** Two rows of a set played as a mix, one after the other: DJ mix for this play (28e). */
export function playedAsMix(from: QueueTrack, to: QueueTrack): boolean {
  return Boolean(
    from.mix_set &&
    to.mix_set &&
    from.mix_set.id === to.mix_set.id &&
    to.mix_set.row > from.mix_set.row,
  );
}

/** The rate a deck's map has at a frame. */
export function rateAt(knots: readonly Knot[], frame: number): number | null {
  if (!knots.length || frame < knots[0].f) return null;
  let k = knots[0];
  for (const kn of knots) {
    if (kn.f <= frame) k = kn;
    else break;
  }
  return k.r;
}

/**
 * Mix now (26a, 26e): the plan moved to the outgoing track's next phrase
 * that leaves time for the windows, its length shortened to what the track
 * has left. Null when there isn't room for even two bars.
 */
export function mixNowPlan(
  plan: PairPlan,
  gridA: BeatGrid,
  phrases: ApiGrid['phrases'],
  position: number,
  duration: number,
  lead = MIX_NOW_LEAD_S,
): PairPlan | null {
  const earliest = position + lead;
  const barOf = (t: number) => Math.ceil((gridA.beatAt(t) - gridA.downbeatIndex) / 4 - 1e-6);
  let bar: number | null = null;
  for (const ph of phrases ?? []) {
    if (ph.time >= earliest) {
      bar = ph.bar;
      break;
    }
  }
  if (bar === null) {
    // past the analysed phrases: the next bar on the line of eights
    bar = Math.max(0, barOf(earliest));
    bar = Math.ceil(bar / 8) * 8;
  }
  const start = gridA.barTime(bar);
  const barS = gridA.barTime(bar + 1) - start;
  const left = (duration > 0 ? duration : Infinity) - start - 1;
  const wanted = plan.bars ?? 0;
  let bars = wanted;
  if (wanted > 0) {
    bars = 0;
    for (const n of [wanted, 32, 16, 8, 4, 2]) {
      if (n <= wanted && n * barS <= left) {
        bars = n;
        break;
      }
    }
    if (!bars) return null;
  } else if (left < barS) return null;
  return {
    ...plan,
    bars: wanted > 0 ? bars : plan.bars,
    out: { ...plan.out, start, bar, end: gridA.barTime(bar + bars), end_bar: bar + bars },
  };
}

interface Decks {
  A: DeckData;
  B: DeckData;
  w: Windows;
  gridA: BeatGrid | null;
  gridB: BeatGrid | null;
  fix?: (phi: number) => number;
  levelsA: Float32Array;
  levelsB: Float32Array;
  trimDb: number;
}

interface Pending {
  key: string;
  from: QueueTrack;
  to: QueueTrack;
  fromId: string;
  toId: string;
  choice: Choice;
  forced: boolean;
  plan: PairPlan | null;
  planning: boolean;
  planError: string | null;
  /** the plan the decks play: the planner's, or Mix now's */
  effective: PairPlan | null;
  grids: Record<string, ApiGrid> | null;
  decks: Decks | null;
  loading: boolean;
  loadError: string | null;
  manual: boolean;
  /** Mix now pressed before the plan came */
  wantNow: boolean;
  cancelled: boolean;
  missed: string | null;
  wentBack: boolean;
  /** the crossfade in the mix's place was started */
  crossfaded: boolean;
}

// ── the controller ─────────────────────────────────────────────────────────

export class AutomixController {
  private readonly player: PlayerPort;
  private readonly svc: AutomixServices;
  private readonly timers: NonNullable<AutomixServices['timers']>;
  private pending: Pending | null = null;
  private engine: EngineLike | null = null;
  private transition: TransitionLike | null = null;
  private stage: Stage = 'idle';
  private ticker: unknown = null;
  /** our own pauses, plays and seeks on the element (its events are ours, not the listener's) */
  private own = 0;
  private paused = false;
  private handing = false;
  private released = true;
  private lanes: HandoverLanes | null = null;
  private master = 0;
  private view: AutomixView = EMPTY_VIEW;
  private readonly listeners = new Set<() => void>();
  private boundEl: HTMLAudioElement | null = null;
  private readonly smart = new Map<string, SmartData | 'loading' | null>();

  constructor(player: PlayerPort, services: AutomixServices) {
    this.player = player;
    this.svc = services;
    this.timers = services.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    };
  }

  // ── the view ──

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getView(): AutomixView {
    return this.view;
  }

  private emit(): void {
    this.view = this.buildView();
    for (const fn of this.listeners) fn();
  }

  // ── running ──

  /** Start listening (the host calls it once). */
  start(): void {
    if (this.ticker !== null) return;
    this.ticker = this.timers.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.ticker !== null) this.timers.clearInterval(this.ticker);
    this.ticker = null;
    this.letGo();
    this.unbind();
  }

  /** The player said something changed (`ss:player`). */
  poke(): void {
    this.tick();
  }

  private bind(el: HTMLAudioElement | null): void {
    if (el === this.boundEl) return;
    this.unbind();
    this.boundEl = el;
    if (!el) return;
    el.addEventListener('pause', this.onPause);
    el.addEventListener('play', this.onPlay);
    el.addEventListener('seeking', this.onSeeking);
  }

  private unbind(): void {
    const el = this.boundEl;
    if (!el) return;
    el.removeEventListener('pause', this.onPause);
    el.removeEventListener('play', this.onPlay);
    el.removeEventListener('seeking', this.onSeeking);
    this.boundEl = null;
  }

  /** The decks are playing what's heard (or about to). */
  engineOwns(): boolean {
    return (
      this.transition !== null &&
      (this.stage === 'counting' ||
        this.stage === 'mixing' ||
        this.stage === 'settling' ||
        this.stage === 'handback' ||
        this.stage === 'back' ||
        this.stage === 'rejoin')
    );
  }

  /** media-player.js's 'ended' and crossfade leave the advance to us. */
  ownsAdvance(): boolean {
    return this.engineOwns() || this.handing;
  }

  private pairNow(
    st: PlayerSnapshotLike,
  ): { from: QueueTrack; to: QueueTrack; toIndex: number } | null {
    if (!st.track || (st.kind && st.kind !== 'library')) return null;
    // shuffle picks at the end, repeat one loops, and the sleep timer's end
    // of track pauses there: nothing to mix into
    if (st.shuffle || st.repeat === 'one' || st.sleep === 'track') return null;
    const i = st.index;
    if (i < 0 || i >= st.queue.length - 1) return null;
    const from = st.queue[i];
    const to = st.queue[i + 1];
    if (!mixable(from) || !mixable(to)) return null;
    return { from, to, toIndex: i + 1 };
  }

  private djFor(from: QueueTrack, to: QueueTrack): { on: boolean; forced: boolean } {
    const forced = playedAsMix(from, to);
    return { on: forced || this.svc.prefs().between === 'dj', forced };
  }

  private tick(): void {
    const el = this.player.audio();
    this.bind(el);
    this.followVolume();
    if (this.engineOwns()) {
      this.tickEngine();
      this.emit();
      return;
    }
    const st = this.player.state();
    const pair = this.pairNow(st);
    const dj = pair ? this.djFor(pair.from, pair.to) : { on: false, forced: false };
    if (!pair || !dj.on) {
      if (this.pending) this.pending = null;
      this.stage = 'idle';
      this.emit();
      return;
    }
    const prefs = this.svc.prefs();
    const choice = choiceOf(pair.from);
    const key = [idOf(pair.from), idOf(pair.to), choice.style, choice.bars ?? 0, prefs.lean].join(
      '|',
    );
    if (!this.pending || this.pending.key !== key || this.pending.from !== pair.from) {
      this.pending = {
        key,
        from: pair.from,
        to: pair.to,
        fromId: idOf(pair.from),
        toId: idOf(pair.to),
        choice,
        forced: dj.forced,
        plan: null,
        planning: false,
        planError: null,
        effective: null,
        grids: null,
        decks: null,
        loading: false,
        loadError: null,
        manual: false,
        wantNow: false,
        cancelled: false,
        missed: null,
        wentBack: false,
        crossfaded: false,
      };
    }
    const p = this.pending;
    // the pair's object is the queue's (an edit that moved it keeps it)
    p.to = pair.to;
    if (!p.plan) {
      if (!p.planning && !p.planError) void this.fetchPlan(p);
      this.stage = 'planned';
      this.emit();
      return;
    }
    if (st.crossfading && (p.plan.status !== 'ok' || p.missed)) {
      p.crossfaded = true;
      this.stage = 'fallback';
      this.emit();
      return;
    }
    this.stage = p.decks ? 'ready' : p.loading ? 'loading' : 'planned';
    if (p.plan.status !== 'ok' || p.cancelled || p.missed || p.wentBack || !el) {
      this.emit();
      return;
    }
    const armed = p.manual || p.forced || prefs.auto;
    const plan = p.effective ?? p.plan;
    const outStart = plan.out.start;
    if (!armed || outStart == null || el.paused || (el.playbackRate ?? 1) !== 1) {
      this.emit();
      return;
    }
    const pos = el.currentTime;
    if (pos >= outStart - PRELOAD_S && !p.decks && !p.loading && !p.loadError) void this.preload(p);
    const lead = this.leadSeconds(p);
    if (pos >= outStart - lead) {
      if (p.decks && pos <= outStart - 0.3) this.takeOver(p);
      else if (p.loadError || pos > outStart - 0.3) {
        p.missed = p.loadError ?? "the tracks didn't load in time";
      }
    }
    this.emit();
  }

  private barSeconds(p: Pending): number {
    const g = gridFromApi(p.grids?.[p.fromId]);
    if (g) return 4 * g.period;
    const bpm = p.plan?.tempo?.from_bpm;
    return bpm ? (4 * 60) / bpm : 2;
  }

  private leadSeconds(p: Pending): number {
    return Math.max(3, LEAD_BARS * this.barSeconds(p));
  }

  private async fetchPlan(p: Pending): Promise<void> {
    p.planning = true;
    try {
      const plan = await this.svc.plan(p.fromId, p.toId, p.choice, this.svc.prefs().lean);
      if (this.pending !== p) return;
      p.plan = plan;
      if (p.wantNow) {
        p.wantNow = false;
        this.mixNow();
      }
    } catch (e) {
      if (this.pending === p) p.planError = e instanceof Error ? e.message : String(e);
    } finally {
      p.planning = false;
      if (this.pending === p) this.emit();
    }
  }

  private async preload(p: Pending): Promise<void> {
    p.loading = true;
    this.emit();
    try {
      const engine = await this.ensureEngine();
      if (!engine) throw new Error("this browser can't mix two tracks");
      if (!p.grids) p.grids = await this.svc.grids([p.fromId, p.toId]);
      if (this.pending !== p) return;
      const gridA = gridFromApi(p.grids[p.fromId]);
      const gridB = gridFromApi(p.grids[p.toId]);
      const plan = p.effective ?? p.plan!;
      const w = windowsFor(plan, gridA, gridB, PREROLL_BARS);
      const A = await this.svc.window(engine.context, p.fromId, w.a.start, w.a.dur);
      if (this.pending !== p) return;
      const B = await this.svc.window(engine.context, p.toId, w.b.start, w.b.dur);
      if (this.pending !== p) return;
      let fix: ((phi: number) => number) | undefined;
      if (
        plan.beatmatch &&
        gridA &&
        gridB &&
        plan.out.bar != null &&
        plan.in.bar != null &&
        plan.bars
      ) {
        const a0 = gridA.barBeat(plan.out.bar);
        const b0 = gridB.barBeat(plan.in.bar);
        const per = PER[plan.tempo?.relation ?? 'same'];
        const beats = plan.bars * 4;
        try {
          fix = correction(
            onsets(A, gridA, a0 - 2, a0 + beats + 2),
            onsets(B, gridB, b0 - 2, b0 + beats * per + 2),
            { from: 0, to: beats },
            (phi) => a0 + phi,
            (phi) => b0 + phi * per,
          );
        } catch {
          fix = undefined;
        }
      }
      p.decks = {
        A,
        B,
        w,
        gridA,
        gridB,
        fix,
        levelsA: windowLevels(A),
        levelsB: windowLevels(B),
        trimDb: relativeTrimDb(p.grids[p.fromId] ?? null, p.grids[p.toId] ?? null),
      };
    } catch (e) {
      if (this.pending === p) p.loadError = e instanceof Error ? e.message : String(e);
    } finally {
      p.loading = false;
      if (this.pending === p && !this.engineOwns()) {
        this.stage = p.decks ? 'ready' : 'planned';
        this.emit();
      }
    }
  }

  private async ensureEngine(): Promise<EngineLike | null> {
    if (this.engine) return this.engine;
    const engine = await this.svc.engine();
    if (engine) {
      engine.graph.master.gain.value = 0;
      this.master = 0;
    }
    this.engine = engine;
    return engine;
  }

  /** The player's level for the decks (the element's volume, linear). */
  private level(): number {
    const st = this.player.state();
    return st.muted ? 0 : Math.max(0, Math.min(1, (st.volume ?? 70) / 100));
  }

  private followVolume(): void {
    const engine = this.engine;
    if (!engine || this.released) return;
    if (!['counting', 'mixing', 'settling', 'back'].includes(this.stage)) return;
    const want = this.level();
    if (Math.abs(want - this.master) < 0.005) return;
    const g = engine.graph.master.gain;
    const now = engine.context.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(this.master, now);
    g.linearRampToValueAtTime(want, now + 0.05);
    this.master = want;
  }

  private fadeMaster(to: number, at: number, seconds: number): void {
    const g = this.engine!.graph.master.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(this.master, at);
    g.linearRampToValueAtTime(to, at + seconds);
    this.master = to;
  }

  /** The element's volume, faded over FADE_S (then muted, or not). */
  private fadeElement(el: HTMLAudioElement, from: number, to: number, after?: () => void): void {
    const steps = 6;
    let n = 0;
    el.volume = Math.max(0, Math.min(1, from));
    const id = this.timers.setInterval(
      () => {
        n++;
        el.volume = Math.max(0, Math.min(1, from + ((to - from) * n) / steps));
        if (n >= steps) {
          this.timers.clearInterval(id);
          after?.();
        }
      },
      (FADE_S * 1000) / steps,
    );
  }

  /** Two bars before the mix: the decks take the outgoing track over. */
  private takeOver(p: Pending): void {
    const engine = this.engine;
    const el = this.player.audio();
    const d = p.decks;
    if (!engine || !el || !d) return;
    const ctx = engine.context;
    const plan = p.effective ?? p.plan!;
    const T = ctx.currentTime + AHEAD_S;
    const from = el.currentTime + AHEAD_S;
    if (from < d.w.a.start || from > d.w.a.start + d.w.a.dur - 1) {
      p.missed = "the tracks didn't load in time";
      return;
    }
    engine.load('A', d.A);
    engine.load('B', d.B);
    this.released = false;
    engine.play('A', T, from, 1);
    this.master = 0;
    this.fadeMaster(this.level(), T, FADE_S);
    const level = this.level();
    this.timers.setTimeout(
      () => {
        this.fadeElement(el, level, 0, () => {
          // the element goes on, muted: it keeps time for the bar and the record
          el.muted = true;
          el.volume = level;
        });
      },
      Math.max(0, (T - ctx.currentTime) * 1000),
    );
    const t0 = T + ((plan.out.start ?? from) - from);
    try {
      this.transition = engine.mix({
        plan,
        from: 'A',
        to: 'B',
        gridA: d.gridA,
        gridB: d.gridB,
        t0,
        trimDb: d.trimDb,
        correction: d.fix,
      });
    } catch (e) {
      // nothing scheduled: the element carries on
      engine.unload('A');
      engine.unload('B');
      this.released = true;
      el.muted = false;
      p.missed = e instanceof Error ? e.message : String(e);
      return;
    }
    this.lanes = this.buildLanes(p, this.transition, d, from);
    this.stage = 'counting';
  }

  private tickEngine(): void {
    const t = this.transition;
    const engine = this.engine;
    const p = this.pending;
    if (!t || !engine || !p) return;
    if (this.handing || this.stage === 'rejoin') return;
    const s = t.state();
    if (s.phase === 'counting') {
      this.stage = 'counting';
      // the next track changed under the countdown, or DJ mix went off: cancel
      const st = this.player.state();
      const pair = this.pairNow(st);
      const still =
        pair && pair.to === p.to && pair.from === p.from && this.djFor(pair.from, pair.to).on;
      if (!still) {
        p.cancelled = true;
        this.cancelCountdown(t);
        return;
      }
      // the outgoing window ran out before the mix (a shorter file than its analysis)
      if (engine.report('A')?.report.ended) t.finishNow(1);
      return;
    }
    if (s.phase === 'mixing' || s.phase === 'interrupted' || s.phase === 'yours') {
      this.stage = 'mixing';
      return;
    }
    if (s.phase === 'cancelled') {
      void this.rejoin(false);
      return;
    }
    if (s.phase === 'back') {
      this.stage = 'back';
      p.wentBack = true;
      if (s.secondsLeft > 0) return;
      const r = rateAt(engine.current('A'), engine.context.currentTime * engine.sampleRate);
      if (r === null || Math.abs(r - 1) < 1e-3) void this.rejoin(true);
      return;
    }
    if (s.phase === 'done') {
      this.stage = 'settling';
      const now = engine.context.currentTime;
      const r = rateAt(engine.current('B'), now * engine.sampleRate);
      const pos = engine.position('B');
      const w = p.decks?.w.b;
      const nearEnd = pos !== null && w ? pos > w.start + w.dur - 8 : false;
      if (r === null || Math.abs(r - 1) < 1e-3 || nearEnd) void this.handBack();
    }
  }

  /** The mix is over: the player takes the incoming track from deck B where it is. */
  private async handBack(): Promise<void> {
    if (this.handing) return;
    const engine = this.engine;
    const p = this.pending;
    const el = this.player.audio();
    if (!engine || !p) return;
    this.handing = true;
    this.stage = 'handback';
    this.emit();
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      const now = engine.context.currentTime;
      this.fadeMaster(0, now + 0.01, 0.06);
      engine.stop('B', Math.round((now + 0.1) * engine.sampleRate));
      engine.stop('A', Math.round((now + 0.1) * engine.sampleRate));
      this.timers.setTimeout(() => this.letGo(), 200);
    };
    const handoff: HandoffLike = {
      get currentTime() {
        return engine.position('B') ?? 0;
      },
      pause: stop,
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
        /* the deck's level is the master's */
      },
    };
    const st = this.player.state();
    let idx = st.queue.indexOf(p.to);
    if (idx < 0) idx = this.player.insertNext(p.to);
    this.own++;
    try {
      if (el) {
        el.pause();
        el.muted = false;
      }
    } finally {
      this.own--;
    }
    this.own++;
    let result: { status: string } | undefined;
    try {
      result = await this.player.playIndex(idx, { handoff, automix: true });
    } catch {
      result = { status: 'failed' };
    } finally {
      this.own--;
    }
    if (!stopped && result?.status !== 'played') {
      // the player moved on some other way (a failed load skips on): the
      // deck stops once it does, or after a moment
      this.timers.setTimeout(stop, 1500);
    }
  }

  /**
   * Back to the outgoing track on the element: after a Cancel (the element
   * is where deck A is: unmute it under a short crossfade), or after Back
   * (the deck moved with the mix's tempo: the element is sent just ahead and
   * started as the deck gets there).
   */
  private async rejoin(precise: boolean): Promise<void> {
    if (this.stage === 'rejoin') return;
    const engine = this.engine;
    const el = this.player.audio();
    this.stage = 'rejoin';
    this.emit();
    if (!engine || !el) {
      this.letGo(true);
      return;
    }
    const level = this.level();
    this.own++;
    try {
      if (precise) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const a = engine.position('A');
          if (a === null) break;
          const target = a + 0.6 + attempt * 0.6;
          el.pause();
          el.currentTime = target;
          await seeked(el, 1500, this.timers);
          const now = engine.position('A');
          if (now === null) break;
          const wait = target - now - 0.03;
          if (wait < 0) continue;
          await new Promise<void>((r) => this.timers.setTimeout(r, wait * 1000));
          break;
        }
        el.volume = 0;
        el.muted = false;
        await el.play().catch(() => undefined);
      } else {
        el.volume = 0;
        el.muted = false;
      }
      this.fadeElement(el, 0, level);
      const now = engine.context.currentTime;
      this.fadeMaster(0, now + 0.01, FADE_S);
      engine.stop('A', Math.round((now + FADE_S + 0.05) * engine.sampleRate));
      engine.stop('B', Math.round((now + FADE_S + 0.05) * engine.sampleRate));
    } finally {
      this.own--;
    }
    this.timers.setTimeout(() => this.letGo(true), 250);
  }

  /** Let the decks go (their windows with them); `keep` keeps the pair's flags. */
  private letGo(keep = false): void {
    const engine = this.engine;
    if (engine && !this.released) {
      try {
        engine.graph.master.gain.cancelScheduledValues(0);
        engine.graph.master.gain.value = 0;
      } catch {
        /* a closed context */
      }
      engine.unload('A');
      engine.unload('B');
    }
    if (this.paused) {
      engine?.setPaused(false);
      this.paused = false;
    }
    this.master = 0;
    this.released = true;
    this.transition = null;
    this.lanes = null;
    this.handing = false;
    const el = this.player.audio();
    if (el && el.muted) el.muted = false;
    if (keep && this.pending) this.pending.decks = null;
    else this.pending = null;
    this.stage = 'idle';
    this.emit();
  }

  // ── the listener's actions ──

  /** Mix now (26a, X): into the next track from the outgoing track's next phrase. */
  mixNow(): boolean {
    if (this.engineOwns()) return false;
    const st = this.player.state();
    const pair = this.pairNow(st);
    if (!pair) return false;
    if (!this.pending || this.pending.from !== pair.from || this.pending.to !== pair.to)
      this.tick();
    const p = this.pending;
    if (!p) return false;
    p.cancelled = false;
    p.missed = null;
    p.wentBack = false;
    p.manual = true;
    if (!p.plan) {
      p.wantNow = true;
      this.emit();
      return true;
    }
    const el = this.player.audio();
    if (!el) return false;
    if (p.plan.status !== 'ok') {
      // waiting or a crossfade: a crossfade now (26e's fallback line says why)
      const hint: CrossfadeHint = {
        seconds: p.plan.length_s ?? 6,
        inAt: p.plan.status === 'crossfade' ? p.plan.in.start : 0,
      };
      if (this.player.crossfadeInto(pair.toIndex, hint)) {
        p.crossfaded = true;
        this.stage = 'fallback';
      }
      this.emit();
      return true;
    }
    void this.armNow(p, el);
    return true;
  }

  private async armNow(p: Pending, el: HTMLAudioElement): Promise<void> {
    try {
      if (!p.grids) p.grids = await this.svc.grids([p.fromId, p.toId]);
    } catch (e) {
      p.loadError = e instanceof Error ? e.message : String(e);
      this.emit();
      return;
    }
    if (this.pending !== p) return;
    const gridA = gridFromApi(p.grids[p.fromId]);
    if (!gridA) {
      p.missed = 'the track going out has no beat grid';
      this.emit();
      return;
    }
    const moved = mixNowPlan(
      p.plan!,
      gridA,
      p.grids[p.fromId]?.phrases,
      el.currentTime,
      Number.isFinite(el.duration) ? el.duration : 0,
    );
    if (!moved) {
      // no room left for a mix: a crossfade now
      const st = this.player.state();
      const toIndex = st.queue.indexOf(p.to);
      if (toIndex >= 0 && this.player.crossfadeInto(toIndex, { seconds: 6 })) {
        p.missed = 'too near the end to mix';
        p.crossfaded = true;
      }
      this.emit();
      return;
    }
    p.effective = moved;
    p.decks = null;
    p.loadError = null;
    this.emit();
    void this.preload(p);
  }

  /** A countdown on the decks is called off: the element takes over again where it is. */
  private cancelCountdown(t: TransitionLike): void {
    t.cancel();
    if (t.state().phase === 'cancelled') void this.rejoin(false);
  }

  /** The countdown's Cancel (26e): the track plays out, as without DJ mix. */
  cancel(): void {
    const p = this.pending;
    if (!p) return;
    p.cancelled = true;
    p.manual = false;
    if (this.transition && this.stage === 'counting') this.cancelCountdown(this.transition);
    this.emit();
  }

  /** Finish now (26d): the rest of the handover over one bar. */
  finishNow(): void {
    const phase = this.transition?.state().phase;
    if (this.transition && (phase === 'mixing' || phase === 'counting'))
      this.transition.finishNow(1);
    this.emit();
  }

  /** Back to the outgoing track over one bar (26d, Design's 251). */
  back(): void {
    if (!this.transition || this.stage !== 'mixing') return;
    if (!this.transition.state().canGoBack) return;
    this.transition.back();
    if (this.pending) this.pending.wentBack = true;
    this.emit();
  }

  /** Next while mixing cuts to the incoming track where it is; true when it acted. */
  next(): boolean {
    if (!this.transition) return false;
    if (this.stage === 'mixing' || this.stage === 'settling') {
      void this.handBack();
      return true;
    }
    if (this.stage === 'counting') {
      if (this.pending) this.pending.cancelled = true;
      this.hardStop();
    }
    return false;
  }

  /** Previous, a row, a page's Play: the decks let go at once, the element is the player's again. */
  previous(): void {
    if (this.engineOwns()) this.hardStop();
  }

  beforeLoad(_index: number, options?: { automix?: boolean }): void {
    if (options?.automix) return;
    if (this.engineOwns() || this.handing) this.hardStop();
    else if (this.pending) this.pending = null;
  }

  private hardStop(): void {
    const engine = this.engine;
    if (engine && !this.released) {
      const now = engine.context.currentTime;
      this.fadeMaster(0, now + 0.005, 0.04);
      engine.stop('A', Math.round((now + 0.06) * engine.sampleRate));
      engine.stop('B', Math.round((now + 0.06) * engine.sampleRate));
    }
    const el = this.player.audio();
    if (el) {
      el.muted = false;
      el.volume = this.level();
    }
    this.letGo();
  }

  /** X (24a): Mix now, when DJ mix is on and there's a pair it can mix. */
  key(k: string): boolean {
    if (k.toUpperCase() !== 'X') return false;
    if (!this.view.canMixNow) return false;
    return this.mixNow();
  }

  // ── the element's events ──

  private readonly onPause = () => {
    const el = this.boundEl;
    if (this.own || !el || el.ended || !this.engineOwns() || this.handing) return;
    // Pause pauses both (26d): the context stops; it's the listener's, not an interruption
    const engine = this.engine!;
    this.paused = true;
    engine.setPaused(true);
    const ctx = engine.context as AudioContext;
    if (typeof ctx.suspend === 'function') void ctx.suspend().catch(() => undefined);
    this.emit();
  };

  private readonly onPlay = () => {
    if (this.own || !this.paused) return;
    const engine = this.engine;
    if (!engine) return;
    const ctx = engine.context as AudioContext;
    const done = () => {
      this.paused = false;
      engine.setPaused(false);
      this.emit();
    };
    if (typeof ctx.resume === 'function') void ctx.resume().then(done, done);
    else done();
  };

  private readonly onSeeking = () => {
    if (this.own) return;
    const p = this.pending;
    if (this.transition && this.stage === 'counting') {
      // a seek during the countdown: the mix is cancelled, the element plays
      // on from where it was sent (the rejoin unmutes it there)
      if (p) p.decks = null;
      this.cancelCountdown(this.transition);
      return;
    }
    if (this.transition && this.stage === 'mixing') {
      this.transition.finishNow(1);
      return;
    }
    const el = this.boundEl;
    if (p && el && !this.engineOwns()) {
      const out = (p.effective ?? p.plan)?.out.start;
      // sent back before the mix: it can happen again
      if (out != null && el.currentTime < out - this.leadSeconds(p) - 1) {
        p.missed = null;
        p.wentBack = false;
      }
    }
  };

  // ── the crossfade's hint (media-player.js asks on every timeupdate) ──

  crossfade(current: QueueTrack | null, next: QueueTrack | null): CrossfadeHint | null {
    if (this.engineOwns() || !current || !next) return null;
    const prefs = this.svc.prefs();
    const dj = mixable(current) && mixable(next) ? this.djFor(current, next) : { on: false };
    if (dj.on) {
      const p = this.pending;
      if (!p || p.to !== next || idOf(p.from) !== idOf(current)) return null;
      if (p.cancelled) return null;
      if (!prefs.auto && !p.manual && !p.forced) return null;
      if (!p.plan || p.plan.status === 'waiting') return { seconds: 6 };
      if (p.plan.status === 'crossfade') {
        const gain = gainFromTrim(this.smartTrim(p));
        return {
          startAt: p.plan.out.start ?? undefined,
          seconds: p.plan.length_s ?? 6,
          inAt: p.plan.in.start,
          gain,
        };
      }
      if (p.missed || p.wentBack) return { seconds: 6 };
      return null;
    }
    if (prefs.between !== 'smart') return null;
    return this.smartHint(current, next);
  }

  private smartTrim(p: Pending): number {
    return p.grids ? relativeTrimDb(p.grids[p.fromId] ?? null, p.grids[p.toId] ?? null) : 0;
  }

  /**
   * Smart crossfade (26h): the player's crossfade, on a downbeat where the
   * outgoing track has a grid, past the silence at its end and the next
   * one's start (from their waveforms), at the outgoing track's loudness
   * where both are analysed; not between tracks of one album in order.
   * Worked out once a pair, in the background; until then (or with nothing
   * known) the plain crossfade.
   */
  private smartHint(current: QueueTrack, next: QueueTrack): CrossfadeHint | null {
    if (
      current.album_id !== null &&
      current.album_id !== undefined &&
      current.album_id !== '' &&
      String(current.album_id) === String(next.album_id ?? '')
    )
      return { skip: true };
    const a = idOf(current);
    const b = idOf(next);
    if (!a || !b || !mixable(current) || !mixable(next)) return null;
    const key = `${a}|${b}`;
    const data = this.smart.get(key);
    if (data === undefined) {
      this.smart.set(key, 'loading');
      void this.loadSmart(key, a, b, next.duration ?? null);
      return null;
    }
    if (data === 'loading' || data === null) return null;
    const el = this.player.audio();
    const duration = el && Number.isFinite(el.duration) ? el.duration : 0;
    const seconds = this.player.state().crossfadeSeconds ?? 6;
    return smartCrossfade(data, duration, seconds);
  }

  private async loadSmart(key: string, a: string, b: string, durB: number | null): Promise<void> {
    try {
      const [grids, pa, pb] = await Promise.all([
        this.svc.grids([a, b]).catch(() => ({}) as Record<string, ApiGrid>),
        this.svc.peaks(a).catch(() => null),
        this.svc.peaks(b).catch(() => null),
      ]);
      this.smart.set(key, {
        gridA: gridFromApi(grids[a]),
        apiA: grids[a] ?? null,
        apiB: grids[b] ?? null,
        peaksA: pa,
        peaksB: pb,
        // the next track's length: the queue's, else its analysis's when it was analysed whole
        durB:
          durB && durB > 0
            ? durB
            : grids[b] && !grids[b].truncated
              ? (grids[b].analysed_s ?? null)
              : null,
      });
    } catch {
      this.smart.set(key, null);
    }
    if (this.smart.size > 40) {
      const first = this.smart.keys().next().value;
      if (first !== undefined) this.smart.delete(first);
    }
  }

  // ── the view ──

  private buildLanes(
    p: Pending,
    t: TransitionLike,
    d: Decks,
    takenAt: number,
  ): HandoverLanes | null {
    const clock = t.beatClock;
    const beats = t.score.beats;
    const T = clock.timeAt(0);
    // from the run-up to two bars past the window
    const ctxNow = this.engine?.context.currentTime ?? T;
    const phi0 = Math.min(-8, Math.floor(clock.beatAt(ctxNow)) - 1);
    const phi1 = Math.max(beats, 4) + 8;
    const n = 160;
    const step = 0.05;
    const levelsA = new Float32Array(n);
    const levelsB = new Float32Array(n);
    const plan = p.effective ?? p.plan!;
    const per = PER[plan.tempo?.relation ?? 'same'];
    const gA = d.gridA;
    const gB = d.gridB;
    const outStart = plan.out.start ?? takenAt;
    for (let i = 0; i < n; i++) {
      const phi = phi0 + ((phi1 - phi0) * (i + 0.5)) / n;
      // each deck's own place at that beat (from its grid, else seconds at its rate)
      let posA: number;
      let posB: number;
      if (t.state().beatmatch && gA && gB && plan.out.bar != null && plan.in.bar != null) {
        posA = gA.timeAt(gA.barBeat(plan.out.bar) + phi);
        posB = gB.timeAt(gB.barBeat(plan.in.bar) + phi * per);
      } else {
        const secs = clock.timeAt(phi) - T;
        posA = outStart + secs;
        posB = plan.in.start + secs;
      }
      const ia = Math.floor((posA - d.w.a.start) / step);
      const ib = Math.floor((posB - d.w.b.start) / step);
      levelsA[i] = ia >= 0 && ia < d.levelsA.length ? d.levelsA[ia] : 0;
      levelsB[i] = ib >= 0 && ib < d.levelsB.length && phi >= 0 ? d.levelsB[ib] : 0;
    }
    return {
      phi0,
      phi1,
      beats,
      marker: t.score.marker,
      a: { levels: levelsA },
      b: { levels: levelsB },
    };
  }

  private buildView(): AutomixView {
    const p = this.pending;
    const st = this.player.state();
    const el = this.player.audio();
    const pair = p
      ? {
          fromId: p.fromId,
          toId: p.toId,
          fromTitle: p.from.title ?? '',
          fromArtist: p.from.artist ?? '',
          toTitle: p.to.title ?? '',
          toArtist: p.to.artist ?? '',
          toIndex: st.queue.indexOf(p.to),
          choice: p.choice,
          fromSet: p.from.mix_set ?? null,
        }
      : null;
    const plan = p ? (p.effective ?? p.plan) : null;
    const outStart = plan?.status === 'ok' ? (plan.out.start ?? null) : null;
    const pos = el ? el.currentTime : 0;
    const t = this.transition;
    const ts = t ? t.state() : null;
    let inSeconds: number | null = null;
    let barsToGo: number | null = null;
    const prefs = this.svc.prefs();
    if (p && outStart !== null && !p.cancelled && !p.missed && !p.wentBack) {
      if (ts && (ts.phase === 'counting' || this.stage === 'counting')) {
        inSeconds = ts.secondsLeft;
      } else if (!t) inSeconds = Math.max(0, outStart - pos);
      if (inSeconds !== null && (p.manual || p.forced || prefs.auto)) {
        const bars = Math.ceil(inSeconds / this.barSeconds(p) - 1e-6);
        if (p.manual || bars <= COUNTDOWN_BARS) barsToGo = Math.max(0, bars);
      }
    }
    let phi: number | null = null;
    if (t && this.engine) phi = t.beatClock.beatAt(this.engine.context.currentTime);
    let fallback: string | null = null;
    if (p && (this.stage === 'fallback' || st.crossfading)) {
      if (p.plan?.status === 'crossfade') fallback = p.plan.fallback?.reason ?? 'no steady beat';
      else if (p.missed) fallback = p.missed;
      else if (p.plan?.status === 'waiting')
        fallback = `${p.to.title || 'the next track'} is still being analysed`;
    }
    const dj = Boolean(p);
    let canMixNow = false;
    let mixNowWhy: string | null = null;
    if (!dj) mixNowWhy = prefs.between === 'dj' ? 'Nothing up next to mix into' : 'DJ mix is off';
    else if (this.engineOwns()) mixNowWhy = 'Mixing now';
    else if (st.crossfading) mixNowWhy = 'Crossfading now';
    else if (!el || el.paused) mixNowWhy = 'Play first';
    else {
      canMixNow = true;
    }
    let incomingBpm: AutomixView['incomingBpm'] = null;
    const toBpm = plan?.tempo?.to_bpm;
    if (ts?.rates && toBpm) {
      incomingBpm = { bpm: toBpm * ts.rates.in, pct: (ts.rates.in - 1) * 100 };
    }
    return {
      dj,
      stage: this.stage,
      pair,
      plan,
      planError: p?.planError ?? null,
      inSeconds,
      outStart,
      barsToGo,
      manual: Boolean(p?.manual),
      transition: ts,
      phi,
      lanes: this.lanes,
      fallback,
      canMixNow,
      mixNowWhy,
      incomingBpm,
    };
  }
}

// ── Smart crossfade's sums ──────────────────────────────────────────────────

interface SmartData {
  gridA: BeatGrid | null;
  apiA: ApiGrid | null;
  apiB: ApiGrid | null;
  peaksA: number[] | null;
  peaksB: number[] | null;
  durB: number | null;
}

/** Quieter than this (of the loudest peak) is silence. */
const SILENT = 0.03;

function gainFromTrim(db: number): number | undefined {
  if (!(db < -0.5)) return undefined;
  return Math.max(0.35, Math.pow(10, db / 20));
}

/** Where a waveform's sound ends (fraction of the track), or null. */
export function soundEnds(peaks: number[] | null | undefined): number | null {
  if (!peaks?.length) return null;
  const top = Math.max(...peaks);
  if (!(top > 0)) return null;
  for (let i = peaks.length - 1; i >= 0; i--)
    if (peaks[i] / top >= SILENT) return (i + 1) / peaks.length;
  return null;
}

/** Where a waveform's sound starts (fraction of the track), or null. */
export function soundStarts(peaks: number[] | null | undefined): number | null {
  if (!peaks?.length) return null;
  const top = Math.max(...peaks);
  if (!(top > 0)) return null;
  for (let i = 0; i < peaks.length; i++) if (peaks[i] / top >= SILENT) return i / peaks.length;
  return null;
}

/**
 * Smart crossfade for a pair: the fade ends where the outgoing track's
 * sound does (at most 15 s early), starts on the downbeat just before where
 * it would otherwise (within 2 s), the next track starts where its sound
 * does (up to 8 s in), and comes in at the outgoing track's loudness.
 */
export function smartCrossfade(
  data: SmartData,
  duration: number,
  seconds: number,
): CrossfadeHint | null {
  if (!(duration > 0) || !(seconds > 0)) return null;
  let end = duration;
  const ends = soundEnds(data.peaksA);
  if (ends !== null) end = Math.max(duration - 15, Math.min(duration, ends * duration));
  let startAt = end - seconds;
  if (data.gridA) {
    const g = data.gridA;
    const beat = g.beatAt(startAt);
    const bar = Math.floor((beat - g.downbeatIndex) / 4);
    const t = g.barTime(bar);
    if (startAt - t >= 0 && startAt - t < 2) startAt = t;
  }
  let inAt: number | undefined;
  const starts = soundStarts(data.peaksB);
  const durB = data.durB;
  if (starts !== null && durB && starts * durB > 0.3 && starts * durB <= 8)
    inAt = Math.max(0, starts * durB - 0.05);
  const gain = gainFromTrim(relativeTrimDb(data.apiA, data.apiB));
  const hint: CrossfadeHint = { startAt: Math.max(0, startAt) };
  if (inAt !== undefined) hint.inAt = inAt;
  if (gain !== undefined) hint.gain = gain;
  return hint;
}

function seeked(
  el: HTMLAudioElement,
  ms: number,
  timers: NonNullable<AutomixServices['timers']>,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('seeked', finish);
      resolve();
    };
    el.addEventListener('seeked', finish);
    timers.setTimeout(finish, ms);
  });
}
