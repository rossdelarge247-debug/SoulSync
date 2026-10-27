/**
 * Measured, not assumed: the engine and its worklet rendered in a real
 * OfflineAudioContext (node-web-audio-api, a Rust implementation of the Web
 * Audio API, BSD-3-Clause, a dev dependency only), two synthetic tracks with
 * known beats, a blend run from a plan, and every beat of the overlap timed
 * in each deck's output. The incoming grid is given wrong on purpose (3 ms
 * late and its period 0.04% long, so 24 ms out by the end of 16 bars): the
 * correction from the audio (refine.ts) has to take it out.
 *
 * The figures printed are HANDOFF's ("Dev, auto-mix stage B of 27 October").
 */

import { AudioWorkletNode as NodeWorkletNode, OfflineAudioContext } from 'node-web-audio-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PlacedPlan } from './executor';

import { Engine, prepareDeck } from './engine';
import { BeatGrid } from './grid';
import { correction, onsets } from './refine';
import { WORKLET_PATH } from './worklet/run-worklet';

const SR = 48000;
const g = globalThis as unknown as { AudioWorkletNode?: unknown };
const saved = g.AudioWorkletNode;

beforeAll(() => {
  g.AudioWorkletNode = NodeWorkletNode;
});
afterAll(() => {
  g.AudioWorkletNode = saved;
});

/** A track of kicks (a 55 Hz thump with a sharp attack) on every beat from `first`. */
function track(bpm: number, seconds: number, first: number, beats?: number[]) {
  const n = Math.round(seconds * SR);
  const left = new Float32Array(n);
  const period = 60 / bpm;
  const times: number[] = beats ?? [];
  if (!beats) for (let t = first; t < seconds - 0.2; t += period) times.push(t);
  for (const t of times) {
    if (t >= seconds - 0.2) break;
    const at = Math.round(t * SR);
    for (let j = 0; j < 0.15 * SR && at + j < n; j++) {
      const u = j / SR;
      left[at + j] +=
        0.7 * Math.exp(-u / 0.06) * Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-u / 0.015)) * u);
    }
  }
  return { left, right: left.slice(), period, first };
}

function asBuffer(t: { left: Float32Array; right: Float32Array }) {
  return {
    numberOfChannels: 2,
    sampleRate: SR,
    length: t.left.length,
    getChannelData: (c: number) => (c === 0 ? t.left : t.right),
  };
}

/** Where the kick that starts nearest `t` (±60 ms) begins: the first sample over a fifth of its peak. */
function attackNear(x: Float32Array, t: number): number | null {
  const a = Math.max(0, Math.round((t - 0.06) * SR));
  const b = Math.min(x.length, Math.round((t + 0.06) * SR));
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak < 0.05) return null;
  for (let i = a; i < b; i++) if (Math.abs(x[i]) > 0.2 * peak) return i / SR;
  return null;
}

interface Measured {
  median: number;
  max: number;
  beats: number;
  mixRms: number;
  renderMs: number;
}

async function run(
  inBpm: number,
  opts: { fixGrid: boolean; bars?: number; drift?: number },
): Promise<Measured> {
  const outBpm = 124;
  const A = track(outBpm, 95, 0.5);
  let B = track(inBpm, 50, 0.2);
  // the incoming grid, wrong: 3 ms late and its period 0.04% long
  let gridB = new BeatGrid({ period: B.period * 1.0004, firstBeat: B.first + 0.003 });
  if (opts.drift) {
    // a drummer: the tempo moves from inBpm to inBpm + drift over the track,
    // and the grid lists every beat (stage A's drifting grid)
    const beats: number[] = [];
    let t = 0.2;
    for (let i = 0; i < 110; i++) {
      beats.push(t);
      t += 60 / (inBpm + (opts.drift * i) / 110);
    }
    B = track(inBpm, 50, 0.2, beats);
    gridB = new BeatGrid({ kind: 'beats', period: 60 / inBpm, firstBeat: 0.2, beats });
  }
  const gridA = new BeatGrid({ period: A.period, firstBeat: A.first });
  const bars = opts.bars ?? 16;
  const outBar = 24;
  const outStart = gridA.barTime(outBar);
  const plan: PlacedPlan = {
    status: 'ok',
    style: 'long_blend',
    bars,
    beatmatch: true,
    tempo: {
      relation: 'same',
      rate: outBpm / inBpm,
      speed_change_ok: Math.abs(inBpm / outBpm - 1) <= 0.03,
    },
    out: { start: outStart, bar: outBar },
    in: { start: gridB.barTime(0), bar: 0 },
  };
  const preroll = 4 * 4 * A.period;
  const aFrom = outStart - preroll;
  const t0 = 0.25 + preroll;
  const length = Math.ceil((t0 + bars * 4 * A.period + 3) * SR);
  const ctx = new OfflineAudioContext({ numberOfChannels: 3, length, sampleRate: SR });
  const merger = ctx.createChannelMerger(3);
  merger.connect(ctx.destination);
  const tap = ctx.createGain();
  tap.connect(merger, 0, 2);
  const engine = await Engine.create({
    context: ctx as unknown as BaseAudioContext,
    workletUrl: WORKLET_PATH,
    tap: tap as unknown as AudioNode,
    watch: false,
  });
  // each deck as the worklet plays it, before its chain
  engine.node.connect(merger as unknown as AudioNode, 0, 0);
  engine.node.connect(merger as unknown as AudioNode, 1, 1);
  const deckA = prepareDeck(asBuffer(A), 0);
  const deckB = prepareDeck(asBuffer(B), 0);
  const aBeat0 = gridA.barBeat(outBar);
  const fix = opts.fixGrid
    ? correction(
        onsets(deckA, gridA, aBeat0 - 2, aBeat0 + bars * 4 + 2),
        onsets(deckB, gridB, -2, bars * 4 + 2),
        { from: 0, to: bars * 4 },
        (phi) => aBeat0 + phi,
        (phi) => phi,
      )
    : undefined;
  engine.load('A', deckA);
  engine.load('B', deckB);
  engine.play('A', 0.25, aFrom);
  const tr = engine.mix({ plan, from: 'A', to: 'B', gridA, gridB, t0, correction: fix });
  await engine.sync();
  const started = performance.now();
  const rendered = await ctx.startRendering();
  const renderMs = performance.now() - started;
  const outA = rendered.getChannelData(0);
  const outB = rendered.getChannelData(1);
  const mix = rendered.getChannelData(2);
  const errors: number[] = [];
  for (let phi = 0; phi <= bars * 4; phi++) {
    const t = tr.beatClock.timeAt(phi);
    const a = attackNear(outA, t);
    const b = attackNear(outB, t);
    if (a !== null && b !== null) errors.push(Math.abs(b - a));
  }
  errors.sort((x, y) => x - y);
  let e = 0;
  const from = Math.round(t0 * SR);
  const to = Math.round(tr.beatClock.timeAt(bars * 4) * SR);
  for (let i = from; i < to; i++) e += mix[i] * mix[i];
  engine.dispose();
  return {
    median: errors[errors.length >> 1],
    max: errors[errors.length - 1],
    beats: errors.length,
    mixRms: Math.sqrt(e / (to - from)),
    renderMs,
  };
}

const ms = (s: number) => `${(s * 1000).toFixed(2)} ms`;

describe('beat sync, rendered (OfflineAudioContext)', () => {
  it('holds a 1.6% tempo gap (a plain speed change) within a millisecond, the grid corrected from the audio', async () => {
    const m = await run(126, { fixGrid: true });
    console.info(
      `sync, 124 → 126 BPM, resample: median ${ms(m.median)}, worst ${ms(m.max)} over ${m.beats} beats (render ${m.renderMs.toFixed(0)} ms)`,
    );
    expect(m.beats).toBeGreaterThanOrEqual(60);
    expect(m.median).toBeLessThan(0.001);
    expect(m.max).toBeLessThan(0.002);
    // the analyser tap gets the mix
    expect(m.mixRms).toBeGreaterThan(0.01);
  }, 120000);

  it('holds a 5.6% gap (the stretch) within a few milliseconds', async () => {
    const m = await run(131, { fixGrid: true });
    console.info(
      `sync, 124 → 131 BPM, stretch: median ${ms(m.median)}, worst ${ms(m.max)} over ${m.beats} beats (render ${m.renderMs.toFixed(0)} ms)`,
    );
    expect(m.beats).toBeGreaterThanOrEqual(60);
    expect(m.median).toBeLessThan(0.002);
    expect(m.max).toBeLessThan(0.003);
  }, 120000);

  it('follows a drifting tempo (a drummer: 125 → 128 BPM) beat for beat', async () => {
    const m = await run(125, { fixGrid: true, drift: 3 });
    console.info(
      `sync, 124 → a drifting 125-128 BPM: median ${ms(m.median)}, worst ${ms(m.max)} over ${m.beats} beats`,
    );
    expect(m.beats).toBeGreaterThanOrEqual(60);
    expect(m.max).toBeLessThan(0.002);
  }, 120000);

  it('without the correction the wrong grid drifts (what the correction is for)', async () => {
    const m = await run(126, { fixGrid: false });
    console.info(
      `sync, 124 → 126 BPM, the wrong grid uncorrected: median ${ms(m.median)}, worst ${ms(m.max)}`,
    );
    expect(m.max).toBeGreaterThan(0.012);
  }, 120000);
});

describe('the engine’s level (the limiter’s makeup gain taken back)', () => {
  it('plays a deck below the limit at exactly its own level, and holds a hot one under 0 dBFS', async () => {
    const level = async (amp: number) => {
      const n = 2 * SR;
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: n, sampleRate: SR });
      const tap = ctx.createGain();
      tap.connect(ctx.destination);
      const engine = await Engine.create({
        context: ctx as unknown as BaseAudioContext,
        workletUrl: WORKLET_PATH,
        tap: tap as unknown as AudioNode,
        watch: false,
      });
      const left = new Float32Array(3 * SR);
      for (let i = 0; i < left.length; i++) left[i] = amp * Math.sin((2 * Math.PI * 440 * i) / SR);
      engine.load('A', prepareDeck(asBuffer({ left, right: left.slice() }), 0));
      engine.play('A', 0, 0);
      await engine.sync();
      const out = (await ctx.startRendering()).getChannelData(0);
      let e = 0;
      let peak = 0;
      for (let i = SR; i < n; i++) {
        e += out[i] * out[i];
        peak = Math.max(peak, Math.abs(out[i]));
      }
      engine.dispose();
      return { db: 20 * Math.log10(Math.sqrt(e / SR) / (amp / Math.SQRT2)), peak };
    };
    const quiet = await level(0.1);
    console.info(`level, a -20 dBFS deck through the engine: ${quiet.db.toFixed(3)} dB`);
    expect(Math.abs(quiet.db)).toBeLessThan(0.05);
    const hot = await level(1.6); // two full decks summed
    expect(hot.peak).toBeLessThan(1.0);
  }, 120000);
});
