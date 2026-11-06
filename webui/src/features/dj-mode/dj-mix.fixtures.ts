/** Test doubles for DJ mode's decks (the tests and nothing else import it). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import type { DeckData } from '@/features/engine/engine';
import type { DeckId, ParamName } from '@/features/engine/score';

import { AutomatedParam } from '@/features/engine/automation';
import { BeatGrid } from '@/features/engine/grid';
import { fold, loopAt, shiftKnots, withLoop, wraps, type LoopSpan } from '@/features/engine/loops';
import { NEUTRAL, PARAM_NAMES } from '@/features/engine/score';
import { FakeParam, FakePort } from '@/features/engine/testing';

import type { EngineLike, MixLane, SessionDeps } from './dj-mix-session';

import { DjMixSession } from './dj-mix-session';

/** The engine on FakePort: maps, stops, modes and params as a browser would keep them. */
export class FakeEngine {
  readonly port = new FakePort(48000);
  readonly sampleRate = 48000;
  readonly loads: { deck: DeckId; offset: number; duration: number }[] = [];
  readonly unloads: DeckId[] = [];
  readonly paused: boolean[] = [];
  readonly master = new FakeParam(1);
  suspended = 0;
  resumed = 0;
  disposed = 0;
  /** the context's state ('running', 'suspended', …); resume() makes it running */
  state = 'running';
  readonly node = { onprocessorerror: null as ((e: Event) => void) | null };
  private readonly lifecycle = new Set<
    (e: { kind: 'interrupted' | 'resumed'; reason: string }) => void
  >();
  readonly context = {
    sampleRate: 48000,
    get currentTime(): number {
      return 0;
    },
    suspend: async () => {
      this.suspended += 1;
      this.state = 'suspended';
    },
    resume: async () => {
      this.resumed += 1;
      this.state = 'running';
    },
  } as unknown as BaseAudioContext;
  /** each deck's cue send (the headphones), as a value the test reads */
  readonly cueSends = {
    A: {
      gain: {
        value: 0,
        setTargetAtTime(v: number) {
          this.value = v;
        },
      },
    },
    B: {
      gain: {
        value: 0,
        setTargetAtTime(v: number) {
          this.value = v;
        },
      },
    },
  };
  /** the element strip's cue send (deck A's Headphones on the element, step 5) */
  readonly elementCue = {
    gain: {
      value: 0,
      setTargetAtTime(v: number) {
        this.value = v;
      },
    },
  };
  readonly graph = {
    master: { gain: this.master as unknown as AudioParam },
    decks: {
      A: { cueSend: this.cueSends.A },
      B: { cueSend: this.cueSends.B },
    } as unknown as Record<DeckId, { cueSend: { gain: AudioParam } }>,
    element: { cueSend: this.elementCue } as unknown as { cueSend: { gain: AudioParam } },
  };
  /** the element strip (step 5): the player's element plays through it while the engine lives */
  routed = true;
  readonly elementFakes = {} as Record<ParamName, FakeParam>;
  private readonly elementAuto = {} as Record<ParamName, AutomatedParam>;
  elementParams(): Record<ParamName, AutomatedParam> | null {
    return this.routed ? this.elementAuto : null;
  }
  /** an element strip param's value as the browser would play it at t */
  elementValue(name: ParamName, t = this.port.time): number {
    return this.elementFakes[name].browser.valueAt(t);
  }

  constructor() {
    for (const name of PARAM_NAMES) {
      this.elementFakes[name] = new FakeParam(NEUTRAL[name]);
      this.elementAuto[name] = new AutomatedParam(
        this.elementFakes[name],
        `E.${name}`,
        NEUTRAL[name],
      );
    }
    const port = this.port;
    Object.defineProperty(this.context, 'currentTime', { get: () => port.time });
    Object.defineProperty(this.context, 'state', { get: () => this.state });
  }

  onLifecycle(fn: (e: { kind: 'interrupted' | 'resumed'; reason: string }) => void) {
    this.lifecycle.add(fn);
    return () => this.lifecycle.delete(fn);
  }
  /** what lifecycle.ts would say */
  interrupt(reason: string) {
    for (const fn of this.lifecycle) fn({ kind: 'interrupted', reason });
  }
  get listening() {
    return this.lifecycle.size;
  }
  dispose() {
    this.disposed += 1;
  }

  params(deck: DeckId) {
    return this.port.params(deck);
  }
  load(deck: DeckId, data: DeckData) {
    this.spans[deck] = [];
    this.loads.push({ deck, offset: data.offset, duration: data.duration });
  }
  unload(deck: DeckId) {
    this.spans[deck] = [];
    this.unloads.push(deck);
  }
  play(deck: DeckId, at: number, from: number, rate = 1) {
    this.port.stop(deck, Infinity);
    this.port.map(
      deck,
      at * this.sampleRate,
      [{ f: at * this.sampleRate, p: from, r: rate }],
      true,
    );
  }
  map(...a: Parameters<FakePort['map']>) {
    this.port.map(...a);
  }
  current(deck: DeckId) {
    return this.port.current(deck);
  }
  stop(deck: DeckId, at: number) {
    this.port.stop(deck, at);
  }
  mode(deck: DeckId, m: 'resample' | 'stretch') {
    this.port.mode(deck, m);
  }
  position(deck: DeckId, at = this.port.time) {
    const p = this.port.position(deck, at);
    return p === null ? null : fold(p, this.spans[deck], at * this.sampleRate);
  }
  /** each deck's loops, as the engine keeps them (loops.ts) */
  spans: Record<DeckId, LoopSpan[]> = { A: [], B: [] };
  loop(deck: DeckId, region: { start: number; end: number } | null, atFrame: number) {
    this.spans[deck] = withLoop(this.spans[deck], atFrame, region);
  }
  endLoop(deck: DeckId, atFrame: number) {
    const l = loopAt(this.spans[deck], atFrame);
    if (!l) return;
    const raw = this.port.position(deck, atFrame / this.sampleRate);
    const k = raw === null ? 0 : wraps(raw, this.spans[deck], atFrame);
    if (k > 0)
      this.map(
        deck,
        atFrame,
        shiftKnots(this.port.current(deck), atFrame, k * (l.end - l.start), this.sampleRate),
      );
    this.loop(deck, null, atFrame);
  }
  loopAt(deck: DeckId, at = this.port.time) {
    const l = loopAt(this.spans[deck], at * this.sampleRate);
    return l ? { start: l.start, end: l.end } : null;
  }
  shift(deck: DeckId, atFrame: number, delta: number) {
    const raw = this.port.position(deck, atFrame / this.sampleRate);
    if (raw === null) return;
    const folded = fold(raw, this.spans[deck], atFrame);
    const next = shiftKnots(
      this.port.current(deck),
      atFrame,
      raw - folded - delta,
      this.sampleRate,
    );
    if (next.length) this.map(deck, atFrame, next, true);
  }
  /** as lifecycle.ts: a suspended context no longer paused by the listener is an interruption */
  setPaused(on: boolean) {
    this.paused.push(on);
    if (!on && this.state === 'suspended') this.interrupt('suspended');
  }
  /** A param's value as the browser would play it at t. */
  value(key: `${DeckId}.${string}`, t = this.port.time): number {
    const [deck, name] = key.split('.') as [DeckId, never];
    return this.port.value(deck, name, t);
  }
}

/** The player's `<audio>` element, as far as the decks use it. */
export class FakeAudio extends EventTarget {
  private t = 121;
  get currentTime(): number {
    return this.t;
  }
  /** a seek (the session's own, for a cue): the element says so, as a browser does */
  set currentTime(v: number) {
    const jumped = Math.abs(v - this.t) > 0.05;
    this.t = v;
    if (jumped) this.dispatchEvent(new Event('seeking'));
  }
  duration = 286;
  paused = false;
  ended = false;
  muted = false;
  volume = 0.7;
  playbackRate = 1;
  /** as the element does: paused, and it says so */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
}

/** 120 BPM: a beat every 0.5 s, a bar every 2 s, the first downbeat at 1 s. */
export function gridA(): BeatGrid {
  return new BeatGrid({ period: 0.5, firstBeat: 1 });
}

/** 125 BPM (0.48 s a beat), the first downbeat at 0.5 s: Sync slows it 4%. */
export function gridB(): BeatGrid {
  return new BeatGrid({ period: 0.48, firstBeat: 0.5 });
}

export function laneA(over: Partial<MixLane> = {}): MixLane {
  return { id: '2', title: 'Night Ferry', grid: gridA(), bpm: 120, cue: 0, duration: 286, ...over };
}

export function laneB(over: Partial<MixLane> = {}): MixLane {
  return {
    id: '8',
    title: 'Harbour Lights',
    grid: gridB(),
    bpm: 125,
    cue: 0.5,
    duration: 288,
    ...over,
  };
}

export interface Rig {
  session: DjMixSession;
  engine: FakeEngine;
  el: FakeAudio;
  said: string[];
  windows: { id: string; start: number; dur: number }[];
  player: { volume: number; muted: boolean };
  /** move the clock (context and timers) on */
  advance(seconds: number): Promise<void>;
}

/** A session on fakes; the test uses vi.useFakeTimers() (the session's timers are the window's). */
export function rig(
  vi: { advanceTimersByTimeAsync(ms: number): Promise<unknown> },
  over: Partial<SessionDeps> = {},
  { worklet = false }: { worklet?: boolean } = {},
): Rig {
  const engine = worklet ? new WorkletEngine() : new FakeEngine();
  const el = new FakeAudio();
  const said: string[] = [];
  const windows: Rig['windows'] = [];
  const player = { volume: 70, muted: false };
  const session = new DjMixSession({
    player: {
      audio: () => el as unknown as HTMLAudioElement,
      state: () => player,
    },
    engine: async () => engine as unknown as EngineLike,
    fetchWindow: async (_ctx, id, start, dur) => {
      windows.push({ id, start, dur });
      if (worklet) return constantWindow(start, dur);
      return {
        channels: [],
        mono4: new Float32Array(0),
        sampleRate: 48000,
        offset: start,
        duration: dur,
      };
    },
    say: (w) => said.push(w),
    ...over,
  });
  return {
    session,
    engine,
    el,
    said,
    windows,
    player,
    async advance(seconds: number) {
      const steps = Math.max(1, Math.ceil(seconds / 0.01));
      for (let i = 0; i < steps; i++) {
        const dt = seconds / steps;
        engine.port.time += dt;
        if (engine instanceof WorkletEngine) engine.renderTo(engine.port.time);
        el.currentTime += el.paused ? 0 : dt;
        await vi.advanceTimersByTimeAsync(dt * 1000);
      }
    },
  };
}

const SR = 48000;

interface Processor {
  port: { onmessage: ((e: { data: unknown }) => void) | null };
  process(i: unknown[], o: Float32Array[][]): boolean;
}

/**
 * The engine's decks on the real worklet (worklet/deck-processor.js, run in
 * a VM as the review's ghost.mjs does): every message the session sends goes
 * to the processor too, and `renderTo` renders up to the clock, keeping each
 * deck's peak since the last `peaks()`. The params (EQ, fader) are the fake
 * port's; the peaks are the decks' own outputs, before them.
 */
export class WorkletEngine extends FakeEngine {
  private readonly proc: Processor;
  private readonly scope: { currentFrame: number };
  private frame = 0;
  private peak = { A: 0, B: 0 };

  constructor() {
    super();
    const src = readFileSync(
      resolve(process.cwd(), 'src/features/engine/worklet/deck-processor.js'),
      'utf8',
    );
    let Proc: (new () => Processor) | null = null;
    class Port {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      postMessage() {}
    }
    class AudioWorkletProcessor {
      port = new Port();
    }
    const scope = {
      sampleRate: SR,
      currentFrame: 0,
      AudioWorkletProcessor,
      registerProcessor: (_n: string, c: new () => Processor) => {
        Proc = c;
      },
    };
    runInNewContext(src, scope);
    this.scope = scope;
    this.proc = new (Proc as unknown as new () => Processor)();
  }

  private send(msg: unknown) {
    this.proc.port.onmessage?.({ data: msg });
  }
  private idx(deck: DeckId) {
    return deck === 'A' ? 0 : 1;
  }

  override load(deck: DeckId, data: DeckData) {
    super.load(deck, data);
    this.send({
      type: 'load',
      deck: this.idx(deck),
      channels: data.channels,
      mono4: data.mono4,
      rate: data.sampleRate,
      offset: data.offset,
    });
  }
  override unload(deck: DeckId) {
    super.unload(deck);
    this.send({ type: 'unload', deck: this.idx(deck) });
  }
  override map(...a: Parameters<FakePort['map']>) {
    super.map(...a);
    const [deck, from, knots, jump] = a;
    const flat = new Float64Array(knots.flatMap((k) => [k.f, k.p, k.r]));
    this.send({ type: 'map', deck: this.idx(deck), from, knots: flat, jump: Boolean(jump) });
  }
  override stop(deck: DeckId, at: number) {
    super.stop(deck, at);
    this.send({ type: 'stop', deck: this.idx(deck), at });
  }
  override loop(deck: DeckId, region: { start: number; end: number } | null, atFrame: number) {
    super.loop(deck, region, atFrame);
    this.send({
      type: 'loop',
      deck: this.idx(deck),
      at: atFrame,
      start: region?.start ?? null,
      end: region?.end ?? null,
    });
  }
  override mode(deck: DeckId, m: 'resample' | 'stretch') {
    super.mode(deck, m);
    this.send({ type: 'mode', deck: this.idx(deck), mode: m });
  }

  /** Render the decks up to the clock. */
  renderTo(time: number) {
    const end = Math.floor(time * SR);
    while (this.frame + 128 <= end) {
      const out = [
        [new Float32Array(128), new Float32Array(128)],
        [new Float32Array(128), new Float32Array(128)],
      ];
      this.scope.currentFrame = this.frame;
      this.proc.process([], out);
      for (const v of out[0]![0]!) this.peak.A = Math.max(this.peak.A, Math.abs(v));
      for (const v of out[1]![0]!) this.peak.B = Math.max(this.peak.B, Math.abs(v));
      this.frame += 128;
    }
  }

  /** Each deck's peak since the last call. */
  peaks() {
    const p = { ...this.peak };
    this.peak = { A: 0, B: 0 };
    return p;
  }
}

/** A window of constant 0.5 (easy to see), at most `cap` seconds. */
export function constantWindow(start: number, dur: number, cap = 20): DeckData {
  const n = Math.round(Math.min(dur, cap) * SR);
  const ch = new Float32Array(n).fill(0.5);
  return {
    channels: [ch, ch.slice()],
    mono4: new Float32Array(Math.floor(n / 4)).fill(0.5),
    sampleRate: SR,
    offset: start,
    duration: n / SR,
  };
}
