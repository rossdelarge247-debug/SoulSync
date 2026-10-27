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
import { buildGraph, type EngineGraph } from './graph';
import { LifecycleWatch, type LifecycleEvent } from './lifecycle';

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
  /** where the mix goes: the player's analyser; else the destination */
  tap?: AudioNode | null;
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
/** the worklet module, loaded once a context */
const MODULES = new WeakMap<BaseAudioContext, Promise<void>>();

export class Engine implements DeckPort {
  readonly context: BaseAudioContext;
  readonly node: AudioWorkletNode;
  readonly graph: EngineGraph;
  readonly sampleRate: number;
  private readonly maps: Record<DeckId, Knot[]> = { A: [], B: [] };
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
    this.graph = buildGraph(opts.context, { tap: opts.tap ?? null, limiter: opts.limiter });
    this.node.connect(this.graph.decks.A.input, 0);
    this.node.connect(this.graph.decks.B.input, 1);
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

  /** Load the worklet (once a context) and build the engine. */
  static async create(opts: EngineOptions): Promise<Engine> {
    let loading = MODULES.get(opts.context);
    if (!loading) {
      loading = opts.context.audioWorklet.addModule(opts.workletUrl);
      MODULES.set(opts.context, loading);
      loading.catch(() => MODULES.delete(opts.context));
    }
    await loading;
    return new Engine(opts);
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

  /** Where a deck is in its track (seconds) at a context time, from the map sent. */
  position(deck: DeckId, at = this.context.currentTime): number | null {
    return positionAt(this.maps[deck], at * this.sampleRate, this.sampleRate);
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

  dispose(): void {
    this.watch?.stop();
    for (const id of IDS) this.node.port.postMessage({ type: 'unload', deck: IDS.indexOf(id) });
    try {
      this.node.disconnect();
    } catch {
      /* already gone */
    }
    this.graph.dispose();
  }
}
