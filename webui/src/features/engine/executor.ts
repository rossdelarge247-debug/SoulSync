/**
 * Runs one transition from a stage A plan (GET /api/library/dj/plan) on the
 * two decks: the decks' position maps from the beat clock (clock.ts) and
 * the style's score (score.ts) as AudioParam automation, all scheduled ahead
 * in the audio graph, so a busy main thread or a throttled background tab
 * can't make it late.
 *
 * Then, as 26d–26f and 26j ask:
 * - cancel() before it starts (the countdown's Cancel);
 * - finishNow(): the rest of the handover over one bar, from the next beat;
 * - back(): back to the outgoing track over one bar (Design's 251);
 * - takeover(): every control stops where it is, nothing jumps (250), the
 *   two decks stay on the beat at the tempo they're at; handBack() lets it
 *   finish from where the controls are;
 * - an interruption (252): a countdown is cancelled (the player crossfades
 *   as it always has); a mix that was cut off finishes with a short
 *   crossfade once sound is back, and on a phone a page that's hidden
 *   finishes over one bar at once, before the lock stops it.
 *
 * Roles: the score's "A" is the outgoing deck, "B" the incoming one; which
 * physical deck each is (Decks' A and B) is the transition's `from` / `to`.
 */

import type { AutomatedParam } from './automation';
import type { LifecycleEvent } from './lifecycle';

import { LOOKAHEAD } from './automation';
import {
  MasterClock,
  SplicedClock,
  freeKnots,
  glideKnots,
  positionAt,
  type BeatClock,
  type Knot,
  type Tempo,
} from './clock';
import { BeatGrid } from './grid';
import {
  FINISHED,
  NEUTRAL,
  PARAM_NAMES,
  STYLE_WORDS,
  WENT_BACK,
  rampFor,
  scoreFor,
  type DeckId,
  type ParamKey,
  type ParamName,
  type Score,
  type Style,
} from './score';

/** The planner's answer, as much of it as the engine reads. */
export interface PlanLike {
  /** 'ok', 'crossfade' or 'waiting' */
  status: string;
  style: string | null;
  label?: string;
  bars: number | null;
  beatmatch?: boolean;
  why?: string | null;
  fallback?: { kind: string; code: string; reason: string } | null;
  tempo?: { relation: 'same' | 'half' | 'double'; rate: number; speed_change_ok: boolean } | null;
  out: { start: number | null; bar?: number | null; end?: number | null; end_bar?: number | null };
  in: { start: number; bar?: number | null };
  length_s?: number | null;
}

export interface DeckPort {
  readonly sampleRate: number;
  now(): number;
  /** The deck's map as last sent (the engine's copy). */
  current(deck: DeckId): Knot[];
  /** Replace a deck's map from frame `from` on. */
  map(deck: DeckId, from: number, knots: Knot[], jump?: boolean): void;
  stop(deck: DeckId, atFrame: number): void;
  mode(deck: DeckId, mode: 'resample' | 'stretch'): void;
  params(deck: DeckId): Record<ParamName, AutomatedParam>;
}

export type KeyLock = 'auto' | 'always';

export interface TransitionInput {
  plan: PlanLike;
  from: DeckId;
  to: DeckId;
  gridA: BeatGrid | null;
  gridB: BeatGrid | null;
  /** context seconds at which the outgoing deck reaches `out.start` */
  t0: number;
  trimDb?: number;
  /** seconds added to the incoming deck's place (refine.ts) */
  correction?: (phi: number) => number;
  keyLock?: KeyLock;
  /** a hidden page counts as an interruption (a phone) */
  phone?: boolean;
}

export type Phase = 'counting' | 'mixing' | 'done' | 'cancelled' | 'back' | 'yours' | 'interrupted';

export interface TransitionState {
  phase: Phase;
  style: Style;
  label: string;
  /** 1-based bar of the window while mixing */
  bar: number | null;
  bars: number;
  /** seconds to the start (counting) or to the end (mixing) */
  secondsLeft: number;
  beatmatch: boolean;
  marker: Score['marker'];
  modes: Record<'out' | 'in', 'resample' | 'stretch'>;
  rates: { out: number; in: number } | null;
  fallback: string | null;
}

export type TransitionEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'interrupted'; reason: string }
  | { type: 'crossfaded'; reason: string };

/** Within this, a plain speed change (pitch moves) will do: the planner's 3%. */
export const SPEED_CHANGE_OK = 0.03;
/** After a mix the incoming deck's tempo has this long (bars) to get back to its own. */
const SETTLE_BARS = 4;
/** A mix cut off by an interruption ends with a crossfade this long once sound is back. */
export const INTERRUPTED_CROSSFADE_S = 2;

const PER_MASTER = { same: 1, half: 0.5, double: 2 } as const;

function styleOf(plan: PlanLike): Style {
  if (plan.status === 'crossfade' || !plan.style) return 'crossfade';
  return (plan.style in STYLE_WORDS ? plan.style : 'crossfade') as Style;
}

export class Transition {
  readonly input: TransitionInput;
  readonly style: Style;
  readonly score: Score;
  readonly beatmatch: boolean;
  /** the clock the transition was scheduled on */
  private readonly master: MasterClock;
  /** the clock it's on now (a finish, back or takeover changes course) */
  private clock: BeatClock;
  private readonly port: DeckPort;
  private readonly listeners = new Set<(e: TransitionEvent) => void>();
  private phaseOverride: Phase | null = null;
  private startedAt = Infinity;
  private endAt = Infinity;
  private touched = new Set<ParamKey>();
  readonly modes: Record<'out' | 'in', 'resample' | 'stretch'> = {
    out: 'resample',
    in: 'resample',
  };
  private interruptedMix = false;

  constructor(input: TransitionInput, port: DeckPort) {
    this.input = input;
    this.port = port;
    this.style = styleOf(input.plan);
    const plan = input.plan;
    const gridA = input.gridA;
    this.beatmatch = Boolean(
      plan.status === 'ok' &&
      plan.beatmatch !== false &&
      input.gridA &&
      input.gridB &&
      scoreFor(this.style, plan.bars).beatmatch,
    );
    const outStart = plan.out.start ?? 0;
    // the outgoing deck's beats; a crossfade with no grid counts seconds
    const aGrid = gridA ?? new BeatGrid({ period: 1, firstBeat: 0 });
    const aBeat0 =
      this.beatmatch && plan.out.bar != null ? aGrid.barBeat(plan.out.bar) : aGrid.beatAt(outStart);
    const bGrid = input.gridB ?? new BeatGrid({ period: 1, firstBeat: 0 });
    const bBeat0 =
      this.beatmatch && plan.in.bar != null
        ? bGrid.barBeat(plan.in.bar)
        : bGrid.beatAt(plan.in.start);
    const beatSeconds = aGrid.periodAt(aBeat0);
    this.score = scoreFor(this.style, plan.bars, {
      trimDb: input.trimDb,
      crossfadeSeconds: plan.length_s ?? undefined,
      beatSeconds,
    });
    const tempo: Tempo = this.beatmatch ? { kind: 'morph' } : { kind: 'followA' };
    this.master = new MasterClock({
      t0: input.t0,
      beats: this.score.beats,
      a: { grid: aGrid, beat0: aBeat0 },
      b: { grid: bGrid, beat0: bBeat0, perMaster: PER_MASTER[plan.tempo?.relation ?? 'same'] },
      tempo,
      correction: this.beatmatch ? input.correction : undefined,
      extra: 64,
    });
    this.clock = this.master;
    if (this.beatmatch) {
      const atStart = this.master.ratesAt(0);
      const atEnd = this.master.ratesAt(this.score.beats);
      const lock = input.keyLock === 'always';
      this.modes.out = lock || Math.abs(atEnd.a - 1) > SPEED_CHANGE_OK ? 'stretch' : 'resample';
      this.modes.in = lock || Math.abs(atStart.b - 1) > SPEED_CHANGE_OK ? 'stretch' : 'resample';
    }
  }

  on(fn: (e: TransitionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: TransitionEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  /** The beat clock (the harness and the handover view draw from it). */
  get beatClock(): BeatClock {
    return this.clock;
  }

  private deckOf(role: 'A' | 'B'): DeckId {
    return role === 'A' ? this.input.from : this.input.to;
  }

  private param(key: ParamKey): AutomatedParam {
    const [role, name] = key.split('.') as ['A' | 'B', ParamName];
    return this.port.params(this.deckOf(role))[name];
  }

  private frame(t: number): number {
    return t * this.port.sampleRate;
  }

  /** Schedule the whole transition. */
  start(): void {
    const sr = this.port.sampleRate;
    const now = this.port.now() + LOOKAHEAD;
    const score = this.score;
    const out = this.input.from;
    const inc = this.input.to;
    // every control of both decks from where it is: the incoming deck at rest
    // and silent, the outgoing one as it plays
    let first = Infinity;
    for (const points of Object.values(score.lanes)) {
      if (points?.length) first = Math.min(first, this.clock.timeAt(points[0].beat));
    }
    first = Math.min(first, this.clock.timeAt(score.bStart));
    const settle = Math.max(now, Math.min(first, this.input.t0) - 0.05);
    for (const name of PARAM_NAMES) {
      const b = this.port.params(inc)[name];
      b.reset(settle, name === 'xf' ? 0 : NEUTRAL[name]);
    }
    for (const [key, points] of Object.entries(score.lanes) as [
      ParamKey,
      Score['lanes'][ParamKey],
    ][]) {
      if (!points) continue;
      const param = this.param(key);
      this.touched.add(key);
      for (const pt of points) param.ramp(pt.ramp, this.clock.timeAt(pt.beat), pt.value);
    }
    // the decks' maps
    if (this.modes.out !== 'resample') this.port.mode(out, this.modes.out);
    this.port.mode(inc, this.modes.in);
    const t0 = this.input.t0;
    if (this.beatmatch) {
      const outKnots = this.master.knots('A', sr, 0, score.aStop + 1);
      this.port.map(out, this.frame(t0), outKnots);
      this.port.map(
        inc,
        this.frame(t0),
        this.master.knots('B', sr, 0, score.beats + 4 * SETTLE_BARS),
        true,
      );
    } else {
      const tb = this.clock.timeAt(score.bStart);
      this.port.map(inc, this.frame(tb), freeKnots(tb, this.input.plan.in.start, sr), true);
    }
    this.port.stop(inc, Infinity);
    this.port.stop(out, this.frame(this.clock.timeAt(score.aStop) + 0.02));
    this.startedAt = Math.min(first, t0);
    this.endAt = this.clock.timeAt(score.beats);
    this.emit({ type: 'phase', phase: 'counting' });
  }

  /** Where the transition is now. */
  state(): TransitionState {
    const now = this.port.now();
    let phase: Phase = this.phaseOverride ?? 'counting';
    if (!this.phaseOverride) {
      if (now >= this.endAt) phase = 'done';
      else if (now >= this.input.t0) phase = 'mixing';
    }
    const beat = this.clock.beatAt(now);
    const bars = Math.max(1, this.score.beats / 4);
    const mixing = phase === 'mixing' || phase === 'yours';
    let rates: TransitionState['rates'] = null;
    if (this.beatmatch) {
      const r = this.clock.ratesAt(Math.max(0, Math.min(this.score.beats, beat)));
      rates = { out: r.a, in: r.b };
    }
    return {
      phase,
      style: this.style,
      label: STYLE_WORDS[this.style],
      bar: mixing ? Math.min(bars, Math.floor(Math.max(0, beat) / 4) + 1) : null,
      bars: this.style === 'crossfade' ? 0 : bars,
      secondsLeft:
        phase === 'counting' ? Math.max(0, this.input.t0 - now) : Math.max(0, this.endAt - now),
      beatmatch: this.beatmatch,
      marker: this.score.marker,
      modes: { ...this.modes },
      rates,
      fallback: this.input.plan.fallback?.reason ?? null,
    };
  }

  /** The next whole beat at least LOOKAHEAD from now, and its time. */
  private nextBeat(): { phi: number; t: number } {
    const now = this.port.now() + LOOKAHEAD;
    const phi = Math.ceil(this.clock.beatAt(now) - 1e-6);
    return { phi, t: this.clock.timeAt(phi) };
  }

  private holdAll(t: number): void {
    for (const deck of [this.input.from, this.input.to]) {
      const params = this.port.params(deck);
      for (const name of PARAM_NAMES) params[name].hold(t);
    }
  }

  /** Every control from its held value to `target` over [t, t + seconds]. */
  private moveTo(
    target: Readonly<Partial<Record<ParamKey, number>>>,
    t: number,
    seconds: number,
  ): void {
    for (const [key, value] of Object.entries(target) as [ParamKey, number][]) {
      const name = key.split('.')[1] as ParamName;
      const param = this.param(key);
      param.hold(t);
      param.ramp(rampFor(name), t + seconds, value);
    }
  }

  /** Cancel before it starts; once it has started, the same as back(). */
  cancel(): void {
    const now = this.port.now() + LOOKAHEAD;
    if (now >= this.startedAt) {
      this.back();
      return;
    }
    const sr = this.port.sampleRate;
    for (const key of this.touched) {
      const name = key.split('.')[1] as ParamName;
      const role = key.split('.')[0];
      this.param(key).reset(now, role === 'B' && name === 'xf' ? 0 : NEUTRAL[name]);
    }
    for (const name of PARAM_NAMES) {
      this.port.params(this.input.to)[name].reset(now, name === 'xf' ? 0 : NEUTRAL[name]);
    }
    // the outgoing deck plays on at its own speed; the incoming one never starts
    const t0 = this.input.t0;
    this.port.map(this.input.from, this.frame(t0), freeKnots(t0, this.clock.posA(0), sr));
    this.port.stop(this.input.from, Infinity);
    this.port.stop(this.input.to, this.frame(now));
    this.setPhase('cancelled');
  }

  private setPhase(phase: Phase): void {
    this.phaseOverride = phase;
    this.emit({ type: 'phase', phase });
  }

  /**
   * Finish the handover over `bars` bars (one by default) from the next beat:
   * every control to where the mix ends; the two decks stay on the beat at
   * the tempo they're at, then the incoming one returns to its own tempo.
   */
  finishNow(bars = 1): void {
    if (this.port.now() >= this.endAt && !this.phaseOverride) return;
    const sr = this.port.sampleRate;
    const { phi, t } = this.nextBeat();
    const period = this.clock.periodAt(phi);
    const seconds = Math.max(1, bars) * 4 * period;
    this.moveTo(FINISHED, t, seconds);
    if (this.beatmatch) {
      const hold = this.rebuild({ kind: 'hold', period }, phi);
      const end = phi + Math.max(1, bars) * 4;
      this.port.map(this.input.from, this.frame(t), hold.knots('A', sr, phi, end + 1));
      const lead = hold.knots('B', sr, phi, end);
      const last = lead[lead.length - 1];
      const settle = glideKnots(
        hold.timeAt(end),
        last.p,
        hold.ratesAt(end).b,
        1,
        SETTLE_BARS * 4 * period,
        sr,
      );
      this.port.map(this.input.to, this.frame(t), lead.slice(0, -1).concat(settle));
    } else if (this.port.now() < this.input.t0) {
      // not started yet: the incoming deck starts on that beat
      this.port.map(this.input.to, this.frame(t), freeKnots(t, this.input.plan.in.start, sr), true);
    }
    this.port.stop(this.input.from, this.frame(t + seconds) + 1024);
    this.endAt = t + seconds;
    this.setPhase('done');
  }

  /**
   * Back to the outgoing track over one bar from the next beat (26d's "Back
   * to Night Ferry"): its controls to where they were, the incoming deck
   * out; then the outgoing deck returns to its own tempo.
   */
  back(): void {
    const sr = this.port.sampleRate;
    const { phi, t } = this.nextBeat();
    const period = this.clock.periodAt(phi);
    const seconds = 4 * period;
    this.moveTo(WENT_BACK, t, seconds);
    if (this.beatmatch && this.port.now() + LOOKAHEAD >= this.input.t0) {
      const hold = this.rebuild({ kind: 'hold', period }, phi);
      const end = phi + 4;
      const lead = hold.knots('A', sr, phi, end);
      const last = lead[lead.length - 1];
      const settle = glideKnots(
        hold.timeAt(end),
        last.p,
        hold.ratesAt(end).a,
        1,
        SETTLE_BARS * 4 * period,
        sr,
      );
      this.port.map(this.input.from, this.frame(t), lead.slice(0, -1).concat(settle));
      this.port.map(this.input.to, this.frame(t), hold.knots('B', sr, phi, end + 1));
    } else if (this.port.now() + LOOKAHEAD < this.input.t0) {
      this.port.map(
        this.input.from,
        this.frame(this.input.t0),
        freeKnots(this.input.t0, this.clock.posA(0), sr),
      );
    }
    this.port.stop(this.input.from, Infinity);
    this.port.stop(this.input.to, this.frame(t + seconds) + 1024);
    this.endAt = t + seconds;
    this.setPhase('back');
  }

  /**
   * Take over (26j): every control stops where it is, now; the decks stay
   * on the beat, at the tempo they're at.
   */
  takeover(): void {
    const sr = this.port.sampleRate;
    const t = this.port.now() + LOOKAHEAD;
    this.holdAll(t);
    if (this.beatmatch) {
      const phi = this.clock.beatAt(t);
      const hold = this.rebuild({ kind: 'hold', period: this.clock.periodAt(phi) }, phi);
      this.port.map(this.input.from, this.frame(t), hold.knots('A', sr, phi, phi + 256));
      this.port.map(this.input.to, this.frame(t), hold.knots('B', sr, phi, phi + 256));
    }
    this.port.stop(this.input.from, Infinity);
    this.setPhase('yours');
  }

  /** Hand back after a takeover: it finishes from where the controls are, over what's left (at least a bar). */
  handBack(): void {
    const left = Math.max(0, this.score.beats - this.clock.beatAt(this.port.now()));
    this.finishNow(Math.max(1, Math.ceil(left / 4)));
  }

  /** The mix was cut off (252): finish with a plain crossfade over `seconds` from now. */
  crossfadeNow(seconds = INTERRUPTED_CROSSFADE_S, reason = 'interrupted'): void {
    const sr = this.port.sampleRate;
    const t = this.port.now() + LOOKAHEAD;
    this.moveTo(FINISHED, t, seconds);
    const inc = this.port.current(this.input.to);
    const p = positionAt(inc, this.frame(t), sr);
    if (p === null) {
      this.port.map(this.input.to, this.frame(t), freeKnots(t, this.input.plan.in.start, sr), true);
    } else if (this.beatmatch) {
      const rate = this.clock.ratesAt(
        Math.min(this.score.beats, Math.max(0, this.clock.beatAt(t))),
      ).b;
      this.port.map(this.input.to, this.frame(t), glideKnots(t, p, rate, 1, 4, sr));
    }
    this.port.stop(this.input.from, this.frame(t + seconds) + 1024);
    this.endAt = t + seconds;
    this.setPhase('done');
    this.emit({ type: 'crossfaded', reason });
  }

  /** What to do about an interruption (lifecycle.ts). */
  onLifecycle(e: LifecycleEvent): void {
    const now = this.port.now();
    const st = this.state();
    if (st.phase === 'cancelled' || st.phase === 'back' || st.phase === 'done') return;
    if (e.kind === 'interrupted') {
      this.emit({ type: 'interrupted', reason: e.reason });
      if (now < this.startedAt - LOOKAHEAD) {
        // not started: no beat-matched mix on a page that may stop
        this.cancel();
        return;
      }
      if (e.reason === 'hidden') {
        // a phone about to lock: done in a bar, before the sound stops
        this.finishNow(1);
        return;
      }
      this.interruptedMix = true;
      this.phaseOverride = 'interrupted';
    } else if (this.interruptedMix) {
      this.interruptedMix = false;
      this.phaseOverride = null;
      this.crossfadeNow(INTERRUPTED_CROSSFADE_S, e.reason);
    }
  }

  private rebuild(tempo: Tempo, phi: number): MasterClock {
    const clock = new MasterClock({
      ...this.master.spec,
      t0: this.clock.timeAt(phi),
      tempo,
      from: phi,
    });
    this.clock = new SplicedClock(this.clock, clock, phi);
    return clock;
  }
}
