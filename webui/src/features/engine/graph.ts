/**
 * The engine's Web Audio graph (auto-mix stage B; 21e's decks, 26j):
 *
 *   decks worklet ─ out 0 ─▶ A: trim ▸ isolator ▸ high-pass ▸ low-pass ▸ volume ▸ crossfader ─┐
 *                 └ out 1 ─▶ B: (the same)                                                  ├▶ master ─┐
 *   each deck's low-pass ─▶ echo send ▸ delay ⟲ (tone high-pass ▸ damping low-pass ▸ feedback) ▸ return ┘        │
 *   each deck's low-pass ─▶ cue send ─▶ cue bus (headphones, outputs.ts)                                        │
 *   (DJ mode) the player's element ─▶ E: the same chain, its own params ─────────────────────────────▶ mix ◀─┘ ▸ limiter ▸ out
 *
 * `out` goes to the player's chain when there is one (its first EQ band, or
 * its analyser: the visualisers see the mix, as they see the player), else
 * to the destination.
 *
 * **The EQ is an isolator** (Brief F step 5, M3; Traktor's and the DJM's
 * full-kill EQs): the signal is split in three by Linkwitz-Riley crossovers
 * at 200 Hz and 2.5 kHz (8th order, 48 dB an octave: each side is a
 * 4th-order Butterworth squared, so the bands sum back to an all-pass and
 * the three at 0 dB are flat), each band has its own gain, and they're
 * summed. The low band also goes through the high crossover's all-pass so
 * all three arrive in phase. A band's param is in dB (−26 … +6 on the knob,
 * as before): its gain is 10^(dB/20) down to −26 dB, then falls to nothing
 * at KILL_DB (−40 dB), which is a true kill (the band's gain is 0). The dB
 * to gain curve is a WaveShaper driven by a ConstantSource, so automation
 * (auto-mix's bass swaps, a knob's ramp) stays a straight line in dB.
 *
 * The echo returns past the volume and the crossfader ("trails"), so an
 * echo out rings on after its deck is cut.
 *
 * **The element strip (DJ mode, step 5 M4–M6):** with `element`, a third
 * chain like the decks' (`E`, with its own params) that the player's element
 * plays through while DJ mode has the decks: deck A's channel and the
 * crossfader act on the playing track before Play B, and the element and
 * deck A sound the same at every switch. It bypasses `master` (the element
 * has the player's volume already) and joins the decks at the limiter.
 */

import { AutomatedParam, type ParamLike } from './automation';
import { KILL_DB, NEUTRAL, PARAM_NAMES, type DeckId, type ParamKey, type ParamName } from './score';

export interface DeckChain {
  input: AudioNode;
  cueSend: GainNode;
  /** after the deck's volume fader (its meter's tap, step 5) */
  postFader: AudioNode;
  nodes: AudioNode[];
}

/** The element's strip (DJ mode): its input, gain 0 until the element is routed through it. */
export interface ElementChain extends DeckChain {
  input: GainNode;
  params: Record<ParamName, AutomatedParam>;
}

/** Level taps for the meters (made on the first ask, so auto-mix never has them). */
export interface GraphMeters {
  A: AnalyserNode;
  B: AnalyserNode;
  /** what goes out (past the limiter) */
  out: AnalyserNode;
  /** the mix before the limiter: over 0 dBFS there is a clip the limiter caught */
  pre: AnalyserNode;
}

export interface EngineGraph {
  decks: Record<DeckId, DeckChain>;
  params: Record<ParamKey, AutomatedParam>;
  master: GainNode;
  /** the limiter's input: the decks' master and the element strip meet here */
  mix: GainNode;
  limiter: DynamicsCompressorNode | null;
  out: GainNode;
  cueBus: GainNode;
  /** DJ mode's element strip, when asked for */
  element: ElementChain | null;
  /** the meters' analysers (made now, kept) */
  meters(): GraphMeters;
  /** `out` to another node (the player's chain changed, step 5) */
  retap(target: AudioNode | null): void;
  dispose(): void;
}

const MAX_ECHO_S = 2;
const LIMIT_DB = -1;
const LIMIT_RATIO = 20;

/** The isolator's crossovers (Hz): Linkwitz-Riley, 8th order (M3). */
export const XO_LOW_HZ = 200;
export const XO_HIGH_HZ = 2500;
/** A 4th-order Butterworth as two biquads' Qs (1 / (2 cos θ), θ = π/8, 3π/8). */
export const BW4_Q: readonly [number, number] = [
  1 / (2 * Math.cos(Math.PI / 8)),
  1 / (2 * Math.cos((3 * Math.PI) / 8)),
];
/** Down to this a band's gain is 10^(dB/20); below it, it falls to nothing at KILL_DB. */
export const EQ_FLOOR_DB = -26;
/** The dB span the gain curve covers (±64 dB). */
const DB_SPAN = 64;
const CURVE_POINTS = 4097;

/** A band's gain (linear) for its param's value in dB: exact to EQ_FLOOR_DB, 0 at KILL_DB. */
export function bandGain(db: number): number {
  if (!Number.isFinite(db) || db <= KILL_DB) return 0;
  if (db >= EQ_FLOOR_DB) return Math.pow(10, Math.min(DB_SPAN, db) / 20);
  const u = (db - KILL_DB) / (EQ_FLOOR_DB - KILL_DB);
  return Math.pow(10, EQ_FLOOR_DB / 20) * u * u;
}

let curve: Float32Array | null = null;
/** The WaveShaper's curve: input x in −1…1 is x·DB_SPAN dB. */
export function bandCurve(): Float32Array {
  if (curve) return curve;
  curve = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = (2 * i) / (CURVE_POINTS - 1) - 1;
    curve[i] = bandGain(x * DB_SPAN);
  }
  return curve;
}

/**
 * The makeup gain (dB) a DynamicsCompressorNode with a hard knee adds by
 * itself (the Web Audio spec: the inverse of the curve's gain at 0 dBFS,
 * to the power 0.6). Measured in an OfflineAudioContext to match.
 */
export function makeupDb(thresholdDb: number, ratio: number): number {
  return -0.6 * thresholdDb * (1 - 1 / ratio);
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, hz: number, q: number) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = q;
  return f;
}

/**
 * Four biquads in a row: a Linkwitz-Riley 8th-order side (`lowpass` or
 * `highpass`). Web Audio reads a low- or high-pass's Q in dB (an
 * all-pass's as it is), so the Butterworth Qs go in as 20·log10(Q).
 */
function lr8(ctx: BaseAudioContext, type: 'lowpass' | 'highpass', hz: number): BiquadFilterNode[] {
  return [BW4_Q[0], BW4_Q[1], BW4_Q[0], BW4_Q[1]].map((q) =>
    biquad(ctx, type, hz, 20 * Math.log10(q)),
  );
}

function chainUp(nodes: AudioNode[]): void {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i]!.connect(nodes[i + 1]!);
}

/**
 * The isolator: `input` split at 200 Hz and 2.5 kHz into three bands, each
 * with its gain (dB params, through the gain curve), summed into `output`.
 */
function isolator(ctx: BaseAudioContext, input: AudioNode) {
  const nodes: AudioNode[] = [];
  const sources: ConstantSourceNode[] = [];
  const output = ctx.createGain();
  const band = (from: AudioNode, path: AudioNode[]) => {
    const g = ctx.createGain();
    g.gain.value = 0;
    chainUp([from, ...path, g, output]);
    // the band's dB, as a param, through the curve to its gain
    const db = ctx.createConstantSource();
    db.offset.value = 0;
    const scale = ctx.createGain();
    scale.gain.value = 1 / DB_SPAN;
    const shaper = ctx.createWaveShaper();
    shaper.curve = bandCurve() as Float32Array<ArrayBuffer>;
    shaper.oversample = 'none';
    db.connect(scale).connect(shaper).connect(g.gain);
    db.start();
    sources.push(db);
    nodes.push(...path, g, db, scale, shaper);
    return db.offset;
  };
  const low = band(input, [
    ...lr8(ctx, 'lowpass', XO_LOW_HZ),
    // the high crossover's all-pass: the low band in phase with the other two
    biquad(ctx, 'allpass', XO_HIGH_HZ, BW4_Q[0]),
    biquad(ctx, 'allpass', XO_HIGH_HZ, BW4_Q[1]),
  ]);
  const rest = lr8(ctx, 'highpass', XO_LOW_HZ);
  chainUp([input, ...rest]);
  nodes.push(...rest);
  const after = rest[rest.length - 1]!;
  const mid = band(after, lr8(ctx, 'lowpass', XO_HIGH_HZ));
  const high = band(after, lr8(ctx, 'highpass', XO_HIGH_HZ));
  nodes.push(output);
  return { output, low, mid, high, nodes, sources };
}

function deckChain(ctx: BaseAudioContext, id: DeckId | 'E', dest: AudioNode, cueBus: AudioNode) {
  const trim = ctx.createGain();
  const iso = isolator(ctx, trim);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.Q.value = 0.9;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.9;
  const volume = ctx.createGain();
  const xf = ctx.createGain();
  // the echo
  const send = ctx.createGain();
  const delay = ctx.createDelay(MAX_ECHO_S);
  const tone = ctx.createBiquadFilter();
  tone.type = 'highpass';
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 6000;
  const feedback = ctx.createGain();
  const ret = ctx.createGain();
  // headphones
  const cueSend = ctx.createGain();
  cueSend.gain.value = 0;

  iso.output.connect(hp).connect(lp).connect(volume).connect(xf).connect(dest);
  lp.connect(send).connect(delay);
  delay.connect(tone).connect(damp).connect(feedback).connect(delay);
  delay.connect(ret).connect(dest);
  lp.connect(cueSend).connect(cueBus);

  const p = (param: AudioParam): ParamLike => param as unknown as ParamLike;
  const params: Record<ParamName, ParamLike> = {
    trim: p(trim.gain),
    volume: p(volume.gain),
    xf: p(xf.gain),
    low: p(iso.low),
    mid: p(iso.mid),
    high: p(iso.high),
    hp: p(hp.frequency),
    lp: p(lp.frequency),
    echoSend: p(send.gain),
    echoReturn: p(ret.gain),
    echoFeedback: p(feedback.gain),
    echoTone: p(tone.frequency),
    echoTime: p(delay.delayTime),
  };
  const nodes = [
    trim,
    ...iso.nodes,
    hp,
    lp,
    volume,
    xf,
    send,
    delay,
    tone,
    damp,
    feedback,
    ret,
    cueSend,
  ];
  const automated = {} as Record<ParamName, AutomatedParam>;
  for (const name of PARAM_NAMES) {
    const start = name === 'xf' && id === 'B' ? 0 : NEUTRAL[name];
    automated[name] = new AutomatedParam(params[name], `${id}.${name}`, start);
  }
  return {
    chain: { input: trim, cueSend, postFader: volume, nodes },
    params: automated,
    sources: iso.sources,
  };
}

/**
 * Build the graph on `ctx`. `tap` is where the mix goes (the player's
 * chain, which already goes on to the speakers); without one, the
 * destination. The limiter keeps two full decks under 0 dBFS. `element`:
 * DJ mode's element strip too.
 */
export function buildGraph(
  ctx: BaseAudioContext,
  opts: { tap?: AudioNode | null; limiter?: boolean; element?: boolean } = {},
): EngineGraph {
  const master = ctx.createGain();
  const mix = ctx.createGain();
  const out = ctx.createGain();
  const cueBus = ctx.createGain();
  master.connect(mix);
  let limiter: DynamicsCompressorNode | null = null;
  let unmakeup: GainNode | null = null;
  if (opts.limiter !== false) {
    limiter = ctx.createDynamicsCompressor();
    // only peaks over -1 dBFS (two full decks summed). A hard knee, so the
    // makeup gain every DynamicsCompressorNode adds (the spec's) is exactly
    // known, and taken back off: below the threshold the engine plays at
    // the player's level
    limiter.threshold.value = LIMIT_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = LIMIT_RATIO;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.2;
    unmakeup = ctx.createGain();
    unmakeup.gain.value = Math.pow(10, -makeupDb(LIMIT_DB, LIMIT_RATIO) / 20);
    mix.connect(limiter).connect(unmakeup).connect(out);
  } else {
    mix.connect(out);
  }
  let target: AudioNode = opts.tap ?? ctx.destination;
  out.connect(target);
  const a = deckChain(ctx, 'A', master, cueBus);
  const b = deckChain(ctx, 'B', master, cueBus);
  let element: ElementChain | null = null;
  let e: ReturnType<typeof deckChain> | null = null;
  if (opts.element) {
    e = deckChain(ctx, 'E', mix, cueBus);
    const input = ctx.createGain();
    input.gain.value = 0;
    input.connect(e.chain.input);
    element = { ...e.chain, input, params: e.params, nodes: [input, ...e.chain.nodes] };
  }
  const params = {} as Record<ParamKey, AutomatedParam>;
  for (const name of PARAM_NAMES) {
    params[`A.${name}`] = a.params[name];
    params[`B.${name}`] = b.params[name];
  }
  let meters: GraphMeters | null = null;
  const sources = [...a.sources, ...b.sources, ...(e?.sources ?? [])];
  return {
    decks: { A: a.chain, B: b.chain },
    params,
    master,
    mix,
    limiter,
    out,
    cueBus,
    element,
    meters() {
      if (meters) return meters;
      const analyser = () => {
        const n = ctx.createAnalyser();
        n.fftSize = 1024;
        return n;
      };
      meters = { A: analyser(), B: analyser(), out: analyser(), pre: analyser() };
      a.chain.postFader.connect(meters.A);
      // deck A's meter shows the playing track whichever way it plays
      element?.postFader.connect(meters.A);
      b.chain.postFader.connect(meters.B);
      out.connect(meters.out);
      mix.connect(meters.pre);
      return meters;
    },
    retap(next: AudioNode | null) {
      const to = next ?? ctx.destination;
      if (to === target) return;
      // the new way first: two ways for a moment beat none (a gap is a click)
      out.connect(to);
      try {
        out.disconnect(target);
      } catch {
        /* already gone */
      }
      target = to;
    },
    dispose() {
      try {
        out.disconnect(target);
      } catch {
        /* already gone */
      }
      for (const src of sources) {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      }
      const all = [
        ...a.chain.nodes,
        ...b.chain.nodes,
        ...(element?.nodes ?? []),
        master,
        mix,
        out,
        cueBus,
        limiter,
        unmakeup,
        ...(meters ? Object.values(meters) : []),
      ];
      for (const node of all) {
        try {
          node?.disconnect();
        } catch {
          /* already gone */
        }
      }
    },
  };
}
