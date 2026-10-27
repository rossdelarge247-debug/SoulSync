/**
 * The auto-mix lab (stage B's dev harness): two library tracks played
 * through a chosen style from a real plan, so Dev and Ross can hear the
 * engine before stage C puts it in Up next. Admins only, and only in a
 * development build or with `?lab=1` (routes/$.tsx, `/automix-lab`).
 *
 * It plays on the player's audio graph when there is one (the visualisers
 * and the output device follow), pausing the player first.
 */

import type { Plan } from '../loader';

import { Engine, type DeckData } from '../engine';
import { isPlaced, type Transition } from '../executor';
import { gridFromApi, relativeTrimDb, type ApiGrid, type BeatGrid } from '../grid';

type BeatGridLike = Pick<BeatGrid, 'beatAt' | 'period'>;
import { looksLikePhone } from '../lifecycle';
import { correction, onsets } from '../refine';
import { windowsFor, type Windows } from '../windows';
import { MAX_SAMPLES, type RunRecord, type RunSample } from './mix-report';

export { windowsFor, type Windows };

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
  /** the two tracks' titles, for the words */
  titles?: { from?: string; to?: string };
}

const WAITING_REASONS: Record<string, string> = {
  analyzing: 'being analysed',
  not_analyzed: 'not analysed yet',
};

/**
 * What a `waiting` plan is waiting for, in words: "Waiting for Night
 * Ferry's beat grid · being analysed".
 */
export function waitingWords(
  plan: Pick<Plan, 'waiting_for' | 'reason'>,
  titles: { from?: string; to?: string } = {},
): string {
  const which = plan.waiting_for === 'from' || plan.waiting_for === 'to' ? plan.waiting_for : null;
  const fallback =
    which === 'from' ? 'the outgoing track' : which === 'to' ? 'the incoming track' : 'a track';
  const name = (which && titles[which]) || fallback;
  const reason = WAITING_REASONS[plan.reason ?? ''] ?? 'not analysed yet';
  return `Waiting for ${name}'s beat grid · ${reason}`;
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
  /** what the engine did in the last run, for the mix report (mix-report.ts) */
  run: RunRecord | null = null;
  private onChange: () => void;
  private sampler: ReturnType<typeof setInterval> | null = null;
  private beatMap: {
    a0: number;
    b0: number;
    per: number;
    gridA: BeatGridLike;
    gridB: BeatGridLike;
  } | null = null;

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
      if (!isPlaced(plan)) {
        this.say('error', waitingWords(plan, r.titles));
        return;
      }
      this.grids = await this.deps.fetchGrids([r.from, r.to]);
      const gridA = gridFromApi(this.grids[r.from]);
      const gridB = gridFromApi(this.grids[r.to]);
      const w = windowsFor(plan, gridA, gridB, r.prerollBars);
      this.windows = w;
      this.say('loading', 'Loading both tracks…');
      const engine = await this.ensureEngine();
      // asked for together, fetched one after the other (the loader's line:
      // the server decodes one window a profile)
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
      // what the report keeps: the correction every 4 beats, then a sample
      // of the decks four times a second while it plays
      let corrections: { beat: number; ms: number }[] | null = null;
      this.beatMap = null;
      if (gridA && gridB && plan.out.bar != null && plan.in.bar != null && plan.bars) {
        const per = { same: 1, half: 0.5, double: 2 }[plan.tempo?.relation ?? 'same'];
        this.beatMap = {
          a0: gridA.barBeat(plan.out.bar),
          b0: gridB.barBeat(plan.in.bar),
          per,
          gridA,
          gridB,
        };
        if (fix) {
          corrections = [];
          for (let beat = 0; beat <= plan.bars * 4; beat += 4)
            corrections.push({ beat, ms: Math.round(fix(beat) * 100000) / 100 });
        }
      }
      this.run = {
        started_at: startAt,
        t0,
        sample_rate: engine.context.sampleRate,
        windows: { a: { ...w.a }, b: { ...w.b }, aFrom: w.aFrom, outStart: w.outStart },
        key_lock: r.keyLock,
        correction: corrections,
        samples: [],
        end: null,
      };
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
      this.startSampling();
    } catch (e) {
      this.say('error', e instanceof Error ? e.message : String(e));
    }
  }

  /** One look at the decks now (four a second while the mix plays). */
  sample(): RunSample | null {
    const engine = this.engine;
    const run = this.run;
    if (!engine || !run) return null;
    const st = this.transition?.state() ?? null;
    const now = engine.context.currentTime;
    const posA = engine.position('A', now);
    const posB = engine.position('B', now);
    const repA = engine.report('A')?.report.p ?? null;
    const repB = engine.report('B')?.report.p ?? null;
    const ms = (x: number | null, y: number | null) =>
      x != null && y != null ? Math.round((x - y) * 100000) / 100 : null;
    let beatDriftMs: number | null = null;
    const m = this.beatMap;
    if (m && st?.beatmatch && posA != null && posB != null && now >= run.t0) {
      // both decks on one count of master beats: the incoming deck's beat
      // less the outgoing one's, as time on the outgoing grid
      const phiA = m.gridA.beatAt(posA) - m.a0;
      const phiB = (m.gridB.beatAt(posB) - m.b0) / m.per;
      beatDriftMs = Math.round((phiB - phiA) * m.gridA.period * 100000) / 100;
    }
    const sample: RunSample = {
      t: Math.round(now * 1000) / 1000,
      phase: st?.phase ?? null,
      bar: st?.bar ?? null,
      rates: st?.rates ?? null,
      modes: st?.modes ?? null,
      pos: { a: posA, b: posB },
      reported: { a: repA, b: repB },
      reportDriftMs: { a: ms(repA, posA), b: ms(repB, posB) },
      beatDriftMs,
    };
    if (run.samples.length < MAX_SAMPLES) run.samples.push(sample);
    if (st && (st.phase === 'done' || st.phase === 'cancelled') && !run.end)
      run.end = { phase: st.phase, at: sample.t };
    return sample;
  }

  private startSampling(): void {
    this.stopSampling();
    if (typeof setInterval !== 'function') return;
    this.sampler = setInterval(() => {
      const s = this.sample();
      if (!s || this.run?.end) this.stopSampling();
    }, 250);
  }

  private stopSampling(): void {
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
  }

  stop(): void {
    this.stopSampling();
    this.engine?.dispose();
    this.engine = null;
    this.transition = null;
    this.say('stopped', '');
  }
}
