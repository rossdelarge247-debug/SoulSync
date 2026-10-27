/**
 * The engine's Web Audio graph (auto-mix stage B; 21e's decks, 26j):
 *
 *   decks worklet ─ out 0 ─▶ A: trim ▸ low ▸ mid ▸ high ▸ high-pass ▸ low-pass ▸ volume ▸ crossfader ─┐
 *                 └ out 1 ─▶ B: (the same)                                                          ├▶ master ▸ limiter ▸ out
 *   each deck's low-pass ─▶ echo send ▸ delay ⟲ (tone high-pass ▸ damping low-pass ▸ feedback) ▸ return ┘
 *   each deck's low-pass ─▶ cue send ─▶ cue bus (headphones, outputs.ts)
 *
 * `out` goes to the player's analyser when there is one (so the visualisers
 * see the mix, as they see the player), else to the destination.
 *
 * The EQ is a DJ mixer's: a low shelf at 150 Hz, a mid peak at 1 kHz and a
 * high shelf at 7 kHz, each to KILL_DB (−40 dB) and up to +6 dB. The echo
 * returns past the volume and the crossfader ("trails"), so an echo out
 * rings on after its deck is cut.
 */

import { AutomatedParam, type ParamLike } from './automation';
import { NEUTRAL, PARAM_NAMES, type DeckId, type ParamKey, type ParamName } from './score';

export interface DeckChain {
  input: AudioNode;
  cueSend: GainNode;
  nodes: AudioNode[];
}

export interface EngineGraph {
  decks: Record<DeckId, DeckChain>;
  params: Record<ParamKey, AutomatedParam>;
  master: GainNode;
  limiter: DynamicsCompressorNode | null;
  out: GainNode;
  cueBus: GainNode;
  dispose(): void;
}

const MAX_ECHO_S = 2;

function deckChain(ctx: BaseAudioContext, id: DeckId, master: AudioNode, cueBus: AudioNode) {
  const trim = ctx.createGain();
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 150;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1000;
  mid.Q.value = 0.8;
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 7000;
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

  trim
    .connect(low)
    .connect(mid)
    .connect(high)
    .connect(hp)
    .connect(lp)
    .connect(volume)
    .connect(xf)
    .connect(master);
  lp.connect(send).connect(delay);
  delay.connect(tone).connect(damp).connect(feedback).connect(delay);
  delay.connect(ret).connect(master);
  lp.connect(cueSend).connect(cueBus);

  const p = (param: AudioParam): ParamLike => param as unknown as ParamLike;
  const params: Record<ParamName, ParamLike> = {
    trim: p(trim.gain),
    volume: p(volume.gain),
    xf: p(xf.gain),
    low: p(low.gain),
    mid: p(mid.gain),
    high: p(high.gain),
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
    low,
    mid,
    high,
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
  const automated = {} as Record<ParamKey, AutomatedParam>;
  for (const name of PARAM_NAMES) {
    const start = name === 'xf' && id === 'B' ? 0 : NEUTRAL[name];
    automated[`${id}.${name}`] = new AutomatedParam(params[name], `${id}.${name}`, start);
  }
  return { chain: { input: trim, cueSend, nodes }, params: automated };
}

/**
 * Build the graph on `ctx`. `tap` is where the mix goes (the player's
 * analyser, which already goes on to the speakers); without one, the
 * destination. The limiter keeps two full decks under 0 dBFS.
 */
export function buildGraph(
  ctx: BaseAudioContext,
  opts: { tap?: AudioNode | null; limiter?: boolean } = {},
): EngineGraph {
  const master = ctx.createGain();
  const out = ctx.createGain();
  const cueBus = ctx.createGain();
  let limiter: DynamicsCompressorNode | null = null;
  if (opts.limiter !== false) {
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 2;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.2;
    master.connect(limiter).connect(out);
  } else {
    master.connect(out);
  }
  const target = opts.tap ?? ctx.destination;
  out.connect(target);
  const a = deckChain(ctx, 'A', master, cueBus);
  const b = deckChain(ctx, 'B', master, cueBus);
  return {
    decks: { A: a.chain, B: b.chain },
    params: { ...a.params, ...b.params },
    master,
    limiter,
    out,
    cueBus,
    dispose() {
      try {
        out.disconnect(target);
      } catch {
        /* already gone */
      }
      for (const node of [...a.chain.nodes, ...b.chain.nodes, master, out, cueBus, limiter]) {
        try {
          node?.disconnect();
        } catch {
          /* already gone */
        }
      }
    },
  };
}
