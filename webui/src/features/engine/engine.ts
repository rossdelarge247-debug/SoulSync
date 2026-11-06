/**
 * The two-deck engine (auto-mix stage B; BACKLOG "Auto-mix: beat-matched
 * transitions in Up next"; HANDOFF "Dev, auto-mix stage B of 27 October").
 *
 * It's only used to mix: plain playback, radio, podcasts and the player's
 * own crossfade never touch it. It plays on the player's AudioContext and
 * into its analyser, so the visualisers see the mix as they see the player
 * (or on a context of its own, into the speakers).
 *
 * - Decks: one AudioWorkletNode (worklet/deck-processor.js) plays both from
 *   decoded windows of the tracks (GET /api/library/dj/window), along
 *   position maps the main thread sends; graph.ts has each deck's chain.
 * - Transitions: executor.ts runs a stage A plan on them.
 * - Interruptions: lifecycle.ts watches; the running transition decides.
 * - Headphones: outputs.ts.
 */

import type { AutomatedParam } from './automation';
import type { DeckId, ParamName } from './score';

import { flatten, positionAt, spliceKnots, type Knot } from './clock';
import { Transition, type DeckPort, type TransitionInput } from './executor';
import { buildGraph, LIMIT_DELAY_S, type EngineGraph } from './graph';
import { LifecycleWatch, type LifecycleEvent } from './lifecycle';
import { fold, loopAt, shiftKnots, withLoop, wraps, type LoopSpan } from './loops';

export const PROCESSOR = 'soulsync-decks';

/** One deck's window, ready for the worklet. */
export interface DeckData {
  channels: Float32Array[];
  /** a quarter-rate mono copy, for the stretch's search */
  mono4: Float32Array;
  sampleRate: number;
  /** the window's first sample's place in the track (seconds) */
  offset: number;
  duration: number;
}

/**
 * Copy a decoded window into the worklet's form (once a load; the copies
 * are handed over, not cloned).
 */
export function prepareDeck(
  source: {
    numberOfChannels: number;
    sampleRate: number;
    length: number;
    getChannelData(c: number): Float32Array;
  },
  offset: number,
): DeckData {
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, source.numberOfChannels); c++)
    channels.push(source.getChannelData(c).slice());
  const n = source.length;
  const mono4 = new Float32Array(Math.floor(n / 4));
  const right = channels[1] ?? channels[0];
  for (let i = 0; i < mono4.length; i++) {
    const k = i * 4;
    mono4[i] =
      (channels[0][k] +
        channels[0][k + 1] +
        channels[0][k + 2] +
        channels[0][k + 3] +
        right[k] +
        right[k + 1] +
        right[k + 2] +
        right[k + 3]) /
      8;
  }
  return {
    channels,
    mono4,
    sampleRate: source.sampleRate,
    offset,
    duration: n / source.sampleRate,
  };
}

export interface DeckReport {
  p: number | null;
  playing: boolean;
  ended: boolean;
}

export interface EngineOptions {
  context: BaseAudioContext;
  /** the worklet module's URL (or path, under Node in tests) */
  workletUrl: string;
  /** where the mix goes: the player's chain (its EQ, else its analyser); else the destination */
  tap?: AudioNode | null;
  /**
   * DJ mode (step 5, M4–M6): the player's element plays through the
   * engine's element strip while the engine lives. `source` is its
   * MediaElementSource and `sourceOut` the gain it reaches the player's own
   * chain through: the two are crossfaded (no edge of the player's graph is
   * cut), and given back when the engine goes.
   */
  element?: { source: AudioNode; sourceOut: GainNode } | null;
  /** how often the worklet reports positions (frames) */
  reportFrames?: number;
  limiter?: boolean;
  /** a hidden page interrupts a mix (a phone) */
  phone?: boolean;
  /** watch for interruptions (default: when the context is a live AudioContext) */
  watch?: boolean;
  doc?: Document | null;
  win?: Window | null;
}

const IDS: readonly DeckId[] = ['A', 'B'];
/** The element's crossfade onto (and off) the element strip (seconds). */
export const ROUTE_S = 0.03;
/**
 * Which engine has each element's source on its strip: a let-go's late
 * cut gives the source back to the player only if no newer engine has
 * taken it since (review M1: else the element was heard twice).
 */
const OWNERS = new WeakMap<AudioNode, Engine>();
/** the worklet module, loaded once a context */
const MODULES = new WeakMap<BaseAudioContext, Promise<void>>();

export class Engine implements DeckPort {
  readonly context: BaseAudioContext;
  readonly node: AudioWorkletNode;
  readonly graph: EngineGraph;
  readonly sampleRate: number;
  private readonly maps: Record<DeckId, Knot[]> = { A: [], B: [] };
  /** each deck's loops (engine/loops.ts), as the worklet has them */
  private loopSpans: Record<DeckId, LoopSpan[]> = { A: [], B: [] };
  private readonly loaded: Record<DeckId, DeckData | null> = { A: null, B: null };
  private readonly reports: Record<DeckId, { frame: number; report: DeckReport } | null> = {
    A: null,
    B: null,
  };
  private transition: Transition | null = null;
  private watch: LifecycleWatch | null = null;
  private readonly listeners = new Set<(e: LifecycleEvent) => void>();

  private constructor(opts: EngineOptions) {
    this.context = opts.context;
    this.sampleRate = opts.context.sampleRate;
    this.node = new AudioWorkletNode(opts.context, PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 2,
      outputChannelCount: [2, 2],
    });
    this.graph = buildGraph(opts.context, {
      tap: opts.tap ?? null,
      limiter: opts.limiter,
      element: Boolean(opts.element),
    });
    this.node.connect(this.graph.decks.A.input, 0);
    this.node.connect(this.graph.decks.B.input, 1);
    if (opts.element && this.graph.element) this.routeElement(opts.element);
    try {
      this.start(opts);
    } catch (e) {
      // anything after the routing failed: the element back on the player's own chain (review L2)
      this.unroute(true);
      try {
        this.node.disconnect();
        this.graph.dispose();
      } catch {
        /* a closed context */
      }
      throw e;
    }
  }

  private start(opts: EngineOptions): void {
    this.node.port.onmessage = (e: MessageEvent) => this.receive(e.data);
    this.node.port.postMessage({ type: 'report', every: opts.reportFrames ?? 4096 });
    const live =
      typeof (opts.context as AudioContext).resume === 'function' &&
      !('startRendering' in opts.context);
    if (opts.watch ?? live) {
      this.watch = new LifecycleWatch(
        {
          context: opts.context,
          doc: opts.doc ?? (typeof document === 'object' ? document : null),
          win: opts.win ?? (typeof window === 'object' ? window : null),
          phone: opts.phone,
        },
        (e) => {
          this.transition?.onLifecycle(e);
          for (const fn of this.listeners) fn(e);
        },
      );
      this.watch.start();
    }
  }

  /**
   * The limiter's lookahead on this browser (seconds): the decks are heard
   * that much after the element (Chromium's is 6 ms, others differ), so
   * deck A starts that far on and the joins read the decks that far back.
   */
  lookahead = LIMIT_DELAY_S;

  /** Load the worklet (once a context) and build the engine. */
  static async create(opts: EngineOptions): Promise<Engine> {
    let loading = MODULES.get(opts.context);
    if (!loading) {
      loading = opts.context.audioWorklet.addModule(opts.workletUrl);
      MODULES.set(opts.context, loading);
      loading.catch(() => MODULES.delete(opts.context));
    }
    await loading;
    // measured first: the element is routed in the constructor
    const look = opts.element ? await measureLookahead(opts.context.sampleRate) : LIMIT_DELAY_S;
    const engine = new Engine(opts);
    engine.lookahead = look;
    return engine;
  }

  private pings = new Map<number, () => void>();
  private pingId = 0;

  /** Resolves once the worklet has every message sent before it. */
  sync(): Promise<void> {
    const id = ++this.pingId;
    return new Promise((resolve) => {
      this.pings.set(id, resolve);
      this.node.port.postMessage({ type: 'ping', id });
    });
  }

  private receive(msg: unknown): void {
    const m = msg as { type?: string; frame?: number; decks?: DeckReport[]; id?: number };
    if (m?.type === 'pong' && typeof m.id === 'number') {
      this.pings.get(m.id)?.();
      this.pings.delete(m.id);
      return;
    }
    if (m?.type === 'pos' && Array.isArray(m.decks)) {
      IDS.forEach((id, i) => {
        const r = m.decks?.[i];
        if (r) this.reports[id] = { frame: m.frame ?? 0, report: r };
      });
    }
  }

  onLifecycle(fn: (e: LifecycleEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** What's stopping Web Audio now (lifecycle.ts), or null. */
  get interrupted(): string | null {
    return this.watch?.interrupted ?? null;
  }

  /** The listener paused or played (lifecycle.ts setPaused): not an interruption. */
  setPaused(on: boolean): void {
    this.watch?.setPaused(on);
  }

  // -- DeckPort --

  now(): number {
    return this.context.currentTime;
  }

  current(deck: DeckId): Knot[] {
    return this.maps[deck];
  }

  map(deck: DeckId, from: number, knots: Knot[], jump = false): void {
    this.maps[deck] = spliceKnots(this.maps[deck], from, knots);
    const flat = flatten(knots);
    this.node.port.postMessage({ type: 'map', deck: IDS.indexOf(deck), from, knots: flat, jump }, [
      flat.buffer,
    ]);
  }

  stop(deck: DeckId, atFrame: number): void {
    this.node.port.postMessage({ type: 'stop', deck: IDS.indexOf(deck), at: atFrame });
  }

  mode(deck: DeckId, mode: 'resample' | 'stretch'): void {
    this.node.port.postMessage({ type: 'mode', deck: IDS.indexOf(deck), mode });
  }

  params(deck: DeckId): Record<ParamName, AutomatedParam> {
    const out = {} as Record<ParamName, AutomatedParam>;
    for (const [key, param] of Object.entries(this.graph.params)) {
      const [d, name] = key.split('.') as [DeckId, ParamName];
      if (d === deck) out[name] = param;
    }
    return out;
  }

  // -- decks --

  /** Hand a window to a deck (its old one, and its map, go). */
  load(deck: DeckId, data: DeckData): void {
    this.loaded[deck] = data;
    this.maps[deck] = [];
    this.loopSpans[deck] = [];
    const transfer = [...data.channels.map((c) => c.buffer), data.mono4.buffer] as ArrayBuffer[];
    this.node.port.postMessage(
      {
        type: 'load',
        deck: IDS.indexOf(deck),
        channels: data.channels,
        mono4: data.mono4,
        rate: data.sampleRate,
        offset: data.offset,
      },
      transfer,
    );
  }

  /** Let a deck's window go (its memory with it); the deck is silent. */
  unload(deck: DeckId): void {
    this.loaded[deck] = null;
    this.maps[deck] = [];
    this.loopSpans[deck] = [];
    this.reports[deck] = null;
    this.node.port.postMessage({ type: 'unload', deck: IDS.indexOf(deck) });
  }

  /** The window a deck holds (its samples were handed to the worklet: only the shape is left). */
  window(deck: DeckId): { offset: number; duration: number } | null {
    const d = this.loaded[deck];
    return d ? { offset: d.offset, duration: d.duration } : null;
  }

  /** Play a deck from track second `from` at context time `at`, at `rate`. */
  play(deck: DeckId, at: number, from: number, rate = 1): void {
    this.stop(deck, Infinity);
    this.map(deck, at * this.sampleRate, [{ f: at * this.sampleRate, p: from, r: rate }], true);
  }

  /** Where a deck is in its track (seconds) at a context time, from the map sent (folded into a loop). */
  position(deck: DeckId, at = this.context.currentTime): number | null {
    const f = at * this.sampleRate;
    const p = positionAt(this.maps[deck], f, this.sampleRate);
    return p === null ? null : fold(p, this.loopSpans[deck], f);
  }

  // -- loops (DJ mode step 6; loops.ts) --

  /** From frame `atFrame` the deck loops over `region` (track seconds); null ends the loop there. */
  loop(deck: DeckId, region: { start: number; end: number } | null, atFrame: number): void {
    this.loopSpans[deck] = withLoop(this.loopSpans[deck], atFrame, region);
    this.node.port.postMessage({
      type: 'loop',
      deck: IDS.indexOf(deck),
      at: atFrame,
      start: region ? region.start : null,
      end: region ? region.end : null,
    });
  }

  /**
   * Leave the loop at frame `atFrame` and play on from where it is: the map
   * moved back by the loops it ran, then the loop ended there.
   */
  endLoop(deck: DeckId, atFrame: number): void {
    const spans = this.loopSpans[deck];
    const l = loopAt(spans, atFrame);
    if (!l) return;
    const raw = positionAt(this.maps[deck], atFrame, this.sampleRate);
    const k = raw === null ? 0 : wraps(raw, spans, atFrame);
    if (k > 0) {
      const shifted = shiftKnots(this.maps[deck], atFrame, k * (l.end - l.start), this.sampleRate);
      if (shifted.length) this.map(deck, atFrame, shifted);
    }
    this.loop(deck, null, atFrame);
  }

  /**
   * Move a deck by `delta` track seconds from frame `atFrame` (a beatjump, a
   * hot cue in phase, a reloop): the map's shape kept (Sync's lock with it),
   * from where the deck is heard (folded into its loop).
   */
  shift(deck: DeckId, atFrame: number, delta: number): void {
    const knots = this.maps[deck];
    const raw = positionAt(knots, atFrame, this.sampleRate);
    if (raw === null) return;
    const folded = fold(raw, this.loopSpans[deck], atFrame);
    const next = shiftKnots(knots, atFrame, raw - folded - delta, this.sampleRate);
    if (next.length) this.map(deck, atFrame, next, true);
  }

  /** The loop in force on a deck at a context time, or null. */
  loopAt(deck: DeckId, at = this.context.currentTime): { start: number; end: number } | null {
    const l = loopAt(this.loopSpans[deck], at * this.sampleRate);
    return l ? { start: l.start, end: l.end } : null;
  }

  /** The worklet's last report for a deck. */
  report(deck: DeckId): { frame: number; report: DeckReport } | null {
    return this.reports[deck];
  }

  // -- transitions --

  /** Schedule a transition (one at a time; a new one replaces the old one's hold). */
  mix(input: TransitionInput): Transition {
    const t = new Transition(input, this);
    this.transition = t;
    t.start();
    return t;
  }

  get running(): Transition | null {
    return this.transition;
  }

  // -- DJ mode's element strip (step 5) --

  private routed: { source: AudioNode; sourceOut: GainNode } | null = null;

  /** The element's sound onto the element strip: a crossfade, nothing cut. */
  private routeElement(el: { source: AudioNode; sourceOut: GainNode }): void {
    const strip = this.graph.element!;
    try {
      el.source.connect(strip.input);
      const t = this.context.currentTime;
      fade(strip.input.gain, 0, 1, t, ROUTE_S);
      fade(el.sourceOut.gain, el.sourceOut.gain.value, 0, t, ROUTE_S);
      this.routed = el;
      OWNERS.set(el.source, this);
    } catch {
      // the player's graph as it was: never silent
      this.unroute(true);
    }
  }

  /** The element strip's params while the element plays through it (deck A's channel on the element), else null. */
  elementParams(): Record<ParamName, AutomatedParam> | null {
    return this.routed && this.graph.element ? this.graph.element.params : null;
  }

  /** The element given back to the player's own chain (at once with `now`). */
  private unroute(now = false): void {
    const el = this.routed;
    const strip = this.graph.element;
    this.routed = null;
    if (!el) return;
    const t = this.context.currentTime;
    try {
      if (now) {
        el.sourceOut.gain.cancelScheduledValues(0);
        el.sourceOut.gain.value = 1;
      } else fade(el.sourceOut.gain, el.sourceOut.gain.value, 1, t, ROUTE_S);
      if (strip) fade(strip.input.gain, strip.input.gain.value, 0, t, ROUTE_S);
    } catch {
      /* a closed context */
    }
    const cut = () => {
      try {
        if (strip) el.source.disconnect(strip.input);
      } catch {
        /* already gone */
      }
      // a newer engine has the source on its strip now: its routing stands
      if (OWNERS.get(el.source) !== this) return;
      OWNERS.delete(el.source);
      try {
        // whatever the context did meanwhile (a suspended one hasn't run the ramp)
        el.sourceOut.gain.cancelScheduledValues(0);
        el.sourceOut.gain.value = 1;
      } catch {
        /* a closed context */
      }
    };
    if (now) cut();
    else this.later(cut);
  }

  private later(fn: () => void): void {
    const ms = (ROUTE_S + 0.05) * 1000;
    if (typeof setTimeout === 'function') setTimeout(fn, ms);
    else fn();
  }

  /** The mix to another node (the player's chain changed: its EQ was made, step 5 M4). */
  retap(tap: AudioNode | null): void {
    this.graph.retap(tap);
  }

  dispose(): void {
    this.watch?.stop();
    for (const id of IDS) this.node.port.postMessage({ type: 'unload', deck: IDS.indexOf(id) });
    try {
      this.node.disconnect();
    } catch {
      /* already gone */
    }
    if (this.routed) {
      // the element back on the player's own chain first, then the graph goes
      this.unroute();
      this.later(() => this.graph.dispose());
    } else this.graph.dispose();
  }
}

/** A gain from `from` to `to` over `seconds` from `at`, whatever was scheduled. */
function fade(param: AudioParam, from: number, to: number, at: number, seconds: number): void {
  param.cancelScheduledValues(at);
  param.setValueAtTime(from, at);
  param.linearRampToValueAtTime(to, at + seconds);
}

const LOOKAHEADS = new Map<number, Promise<number>>();

/**
 * How long this browser's DynamicsCompressorNode delays its signal, at a
 * sample rate (an impulse through one, offline, once a rate); Chromium's
 * 6 ms when it can't be measured.
 */
export function measureLookahead(sampleRate: number): Promise<number> {
  let known = LOOKAHEADS.get(sampleRate);
  if (known) return known;
  known = (async () => {
    try {
      const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext })
        .OfflineAudioContext;
      if (!Offline) return LIMIT_DELAY_S;
      const n = 2048;
      const ctx = new Offline(1, n, sampleRate);
      const buf = ctx.createBuffer(1, n, sampleRate);
      buf.getChannelData(0)[64] = 0.1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = 0;
      comp.knee.value = 0;
      comp.ratio.value = 20;
      src.connect(comp).connect(ctx.destination);
      src.start();
      const out = (await ctx.startRendering()).getChannelData(0);
      for (let i = 0; i < n; i++) if (Math.abs(out[i]!) > 1e-4) return (i - 64) / sampleRate;
      return LIMIT_DELAY_S;
    } catch {
      return LIMIT_DELAY_S;
    }
  })();
  LOOKAHEADS.set(sampleRate, known);
  return known;
}
