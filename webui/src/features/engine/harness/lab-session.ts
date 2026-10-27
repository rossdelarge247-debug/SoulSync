/**
 * The auto-mix lab (stage B's dev harness): two library tracks played
 * through a chosen style from a real plan, so Dev and Ross can hear the
 * engine before stage C puts it in Up next. Admins only, and only in a
 * development build or with `?lab=1` (routes/$.tsx, `/automix-lab`).
 *
 * It plays on the player's audio graph when there is one (the visualisers
 * and the output device follow), pausing the player first.
 */

import type { Transition } from '../executor';
import type { Plan } from '../loader';

import { Engine, type DeckData } from '../engine';
import { BeatGrid, gridFromApi, relativeTrimDb, type ApiGrid } from '../grid';
import { looksLikePhone } from '../lifecycle';
import { correction, onsets } from '../refine';
import { DEFAULT_BARS, needsBeatmatch, type Style } from '../score';

export interface LabRequest {
  from: string;
  to: string;
  style: string;
  bars?: number;
  /** bars of the outgoing track before the mix starts */
  prerollBars: number;
  keyLock: boolean;
  /** line the beats up from the audio too (refine.ts) */
  correct: boolean;
}

export interface LabDeps {
  fetchPlan(from: string, to: string, style: string, bars?: number): Promise<Plan>;
  fetchGrids(ids: string[]): Promise<Record<string, ApiGrid>>;
  fetchWindow(ctx: BaseAudioContext, id: string, start: number, dur: number): Promise<DeckData>;
  /** the context and the analyser to play into (the player's) */
  graph(): { context: AudioContext; analyser: AudioNode | null };
  workletUrl: string;
  /** pause the player (it would play over the mix) */
  pausePlayer(): void;
}

export interface Windows {
  a: { start: number; dur: number };
  b: { start: number; dur: number };
  /** where the outgoing deck starts playing (track seconds) */
  aFrom: number;
  /** the outgoing mix point (track seconds) */
  outStart: number;
}

/** The server's cap on a window (seconds). */
const MAX = 180;

/** The stretches of the two tracks a transition needs, with room to finish or go back. */
export function windowsFor(
  plan: Plan,
  gridA: BeatGrid | null,
  gridB: BeatGrid | null,
  prerollBars: number,
): Windows {
  const style = (plan.status === 'crossfade' ? 'crossfade' : plan.style) as Style;
  const beatmatch =
    plan.status === 'ok' && needsBeatmatch(style) && gridA !== null && gridB !== null;
  const bars = plan.bars ?? DEFAULT_BARS[style] ?? 0;
  const clamp = (start: number, end: number) => {
    const s = Math.max(0, start);
    return { start: s, dur: Math.max(1, Math.min(MAX, end - s)) };
  };
  if (beatmatch && gridA && gridB && plan.out.bar != null && plan.in.bar != null) {
    const outStart = gridA.barTime(plan.out.bar);
    const aFrom = Math.max(0, gridA.barTime(plan.out.bar - prerollBars));
    const a = clamp(aFrom - 0.5, gridA.barTime(plan.out.bar + bars + 16) + 1);
    const perMaster = { same: 1, half: 0.5, double: 2 }[plan.tempo?.relation ?? 'same'];
    const b0 = gridB.barBeat(plan.in.bar);
    const inStart = gridB.timeAt(b0);
    const b = clamp(inStart - 0.5, gridB.timeAt(b0 + (bars * 4 + 16 + 64) * perMaster) + 2);
    return { a, b, aFrom, outStart };
  }
  const outStart = plan.out.start ?? 0;
  const beat = gridA ? gridA.periodAt(gridA.beatAt(outStart)) : 0.5;
  const preroll = gridA ? prerollBars * 4 * beat : 15;
  const aFrom = Math.max(0, outStart - preroll);
  const length = style === 'crossfade' ? (plan.length_s ?? 6) : bars * 4 * beat;
  return {
    a: clamp(aFrom - 0.5, outStart + length + 8),
    b: clamp(plan.in.start - 0.5, plan.in.start + 60),
    aFrom,
    outStart,
  };
}

export interface LabStatus {
  stage: 'idle' | 'loading' | 'playing' | 'stopped' | 'error';
  words: string;
}

export class LabSession {
  readonly request: LabRequest;
  readonly deps: LabDeps;
  plan: Plan | null = null;
  grids: Record<string, ApiGrid> = {};
  engine: Engine | null = null;
  transition: Transition | null = null;
  windows: Windows | null = null;
  status: LabStatus = { stage: 'idle', words: '' };
  private onChange: () => void;

  constructor(request: LabRequest, deps: LabDeps, onChange: () => void = () => {}) {
    this.request = request;
    this.deps = deps;
    this.onChange = onChange;
  }

  private say(stage: LabStatus['stage'], words: string) {
    this.status = { stage, words };
    this.onChange();
  }

  /** The plan alone (the page shows it before playing). */
  async planOnly(): Promise<Plan> {
    const r = this.request;
    this.plan = await this.deps.fetchPlan(r.from, r.to, r.style, r.bars);
    return this.plan;
  }

  /** The engine on the player's graph (made once). */
  async ensureEngine(): Promise<Engine> {
    if (this.engine) return this.engine;
    const { context, analyser } = this.deps.graph();
    if (context.state !== 'running') await context.resume().catch(() => undefined);
    this.engine = await Engine.create({
      context,
      workletUrl: this.deps.workletUrl,
      tap: analyser,
      phone: looksLikePhone(typeof navigator === 'object' ? navigator : null),
    });
    return this.engine;
  }

  /** Fetch everything, load both decks and start: the mix starts after the preroll. */
  async start(): Promise<void> {
    const r = this.request;
    try {
      this.say('loading', 'Asking for the plan…');
      const plan = await this.planOnly();
      if (plan.status === 'waiting') {
        this.say(
          'error',
          `Not analysed yet (${plan.waiting_for ?? 'a track'}): run the DJ analysis first.`,
        );
        return;
      }
      this.grids = await this.deps.fetchGrids([r.from, r.to]);
      const gridA = gridFromApi(this.grids[r.from]);
      const gridB = gridFromApi(this.grids[r.to]);
      const w = windowsFor(plan, gridA, gridB, r.prerollBars);
      this.windows = w;
      this.say('loading', 'Loading both tracks…');
      const engine = await this.ensureEngine();
      const [deckA, deckB] = await Promise.all([
        this.deps.fetchWindow(engine.context, r.from, w.a.start, w.a.dur),
        this.deps.fetchWindow(engine.context, r.to, w.b.start, w.b.dur),
      ]);
      let fix: ((phi: number) => number) | undefined;
      if (r.correct && gridA && gridB && plan.out.bar != null && plan.in.bar != null && plan.bars) {
        const a0 = gridA.barBeat(plan.out.bar);
        const b0 = gridB.barBeat(plan.in.bar);
        const per = { same: 1, half: 0.5, double: 2 }[plan.tempo?.relation ?? 'same'];
        const beats = plan.bars * 4;
        fix = correction(
          onsets(deckA, gridA, a0 - 2, a0 + beats + 2),
          onsets(deckB, gridB, b0 - 2, b0 + beats * per + 2),
          { from: 0, to: beats },
          (phi) => a0 + phi,
          (phi) => b0 + phi * per,
        );
      }
      this.deps.pausePlayer();
      engine.load('A', deckA);
      engine.load('B', deckB);
      const startAt = engine.context.currentTime + 0.4;
      engine.play('A', startAt, w.aFrom);
      const t0 = startAt + (w.outStart - w.aFrom);
      this.transition = engine.mix({
        plan,
        from: 'A',
        to: 'B',
        gridA,
        gridB,
        t0,
        trimDb: relativeTrimDb(this.grids[r.from] ?? null, this.grids[r.to] ?? null),
        correction: fix,
        keyLock: r.keyLock ? 'always' : 'auto',
      });
      this.say('playing', '');
    } catch (e) {
      this.say('error', e instanceof Error ? e.message : String(e));
    }
  }

  stop(): void {
    this.engine?.dispose();
    this.engine = null;
    this.transition = null;
    this.say('stopped', '');
  }
}
