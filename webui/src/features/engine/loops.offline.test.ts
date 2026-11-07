/**
 * Measured, not assumed (DJ mode step 6): a deck's loop on the real
 * worklet in an OfflineAudioContext (node-web-audio-api, as
 * sync.offline.test.ts). The figures printed are HANDOFF's ("Dev, loops and
 * quantize (step 6)").
 *
 * - The loop's length is exact to the sample at the deck's speed (a click
 *   in the track comes round every length × rate⁻¹ seconds), at its own
 *   speed and stretched by Sync's kind of rate (resampled).
 * - No click at the wrap: a sine that doesn't fit the loop a whole number
 *   of times steps no further from one sample to the next than it does
 *   anywhere else, in resample and in stretch (key lock).
 * - Leaving the loop plays on from where it is (no jump), and the main
 *   thread's position (the session's) is the worklet's.
 */
import { AudioWorkletNode as NodeWorkletNode, OfflineAudioContext } from 'node-web-audio-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Engine, prepareDeck } from './engine';
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

function track(seconds: number, fill: (t: number, i: number) => number) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = fill(i / SR, i);
  return { numberOfChannels: 1, sampleRate: SR, length: n, getChannelData: () => x };
}

async function render(
  data: ReturnType<typeof track>,
  seconds: number,
  setup: (e: Engine) => void,
): Promise<{ x: Float32Array; engine: Engine }> {
  const ctx = new OfflineAudioContext(1, Math.round(seconds * SR), SR);
  // the deck as the worklet plays it (before its chain: the EQ's phase isn't the loop's)
  const tap = ctx.createGain();
  const engine = await Engine.create({
    context: ctx as unknown as BaseAudioContext,
    workletUrl: WORKLET_PATH,
    tap: tap as unknown as AudioNode,
    limiter: false,
    watch: false,
  });
  engine.node.connect(ctx.destination as unknown as AudioNode, 0);
  engine.load('A', prepareDeck(data, 0));
  setup(engine);
  await engine.sync();
  return { x: (await ctx.startRendering()).getChannelData(0), engine };
}

/** Where each click is (frames, interpolated a little from the three samples around its peak). */
function clicks(x: Float32Array, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(1, from); i < x.length - 1; i++) {
    if (x[i]! > 0.5 && x[i]! >= x[i - 1]! && x[i]! > x[i + 1]!) {
      const a = x[i - 1]!;
      const b = x[i]!;
      const c = x[i + 1]!;
      out.push(i + (0.5 * (a - c)) / (a - 2 * b + c));
      i += 100;
    }
  }
  return out;
}

/** The largest sample-to-sample step in [a, b). */
function maxStep(x: Float32Array, a: number, b: number): number {
  let m = 0;
  for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
  return m;
}

describe('a deck’s loop, measured (step 6)', () => {
  for (const rate of [1, 1.037]) {
    it(`its length is exact to the sample at ${rate === 1 ? 'its own speed' : 'a speed of 1.037'}`, async () => {
      // a click at 2.1 s in the track, inside a loop from 2.0 s, 0.5 s long (a beat at 120)
      const data = track(6, (_t, i) => (i === Math.round(2.1 * SR) ? 1 : 0));
      const { x } = await render(data, 3, (e) => {
        e.play('A', 0.1, 1.5, rate);
        e.loop('A', { start: 2, end: 2.5 }, 0.2 * SR);
      });
      const at = clicks(x, 0);
      const period = (0.5 * SR) / rate;
      const gaps = at.slice(1).map((v, i) => v - at[i]!);
      console.info(
        `loop of 0.5 s at ${rate}: ${at.length} clicks, gaps ${gaps.map((g) => g.toFixed(2)).join(' ')} frames (exact: ${period.toFixed(2)})`,
      );
      expect(at.length).toBeGreaterThanOrEqual(4);
      for (const gap of gaps) expect(Math.abs(gap - period)).toBeLessThan(0.5);
    }, 60_000);
  }

  for (const mode of ['resample', 'stretch'] as const) {
    it(`no click at the wrap (${mode})`, async () => {
      // 997 Hz doesn't fit 0.5 s a whole number of times: a bare wrap would step
      const hz = 997;
      const data = track(8, (t) => 0.5 * Math.sin(2 * Math.PI * hz * t));
      const { x } = await render(data, 3, (e) => {
        e.mode('A', mode);
        e.play('A', 0.1, 1.5, 1);
        e.loop('A', { start: 2, end: 2.5 }, 0.2 * SR);
      });
      const smooth = 2 * Math.PI * (hz / SR) * 0.5;
      // the wraps: at 0.1 + (2.5 − 1.5) = 1.1 s, then every 0.5 s
      let worst = 0;
      for (const w of [1.1, 1.6, 2.1, 2.6]) {
        const at = Math.round(w * SR);
        worst = Math.max(worst, maxStep(x, at - 400, at + 400));
      }
      const elsewhere = maxStep(x, Math.round(0.5 * SR), Math.round(0.9 * SR));
      console.info(
        `wrap (${mode}): largest step ${worst.toFixed(4)} at the wraps, ${elsewhere.toFixed(4)} elsewhere (a sine's own ${smooth.toFixed(4)}; a bare wrap could step up to 1.0)`,
      );
      expect(worst).toBeLessThan(1.5 * smooth);
    }, 60_000);
  }

  it('leaving the loop plays on from where it is, and the position is the worklet’s', async () => {
    const hz = 997;
    const data = track(8, (t) => 0.5 * Math.sin(2 * Math.PI * hz * t));
    const { x, engine } = await render(data, 3, (e) => {
      e.play('A', 0.1, 1.5, 1);
      e.loop('A', { start: 2, end: 2.5 }, 0.2 * SR);
      // out at 1.83 s: 1.73 s played from 1.5, so 3.23 run, folded to 2.23
      e.endLoop('A', Math.round(1.83 * SR));
    });
    expect(engine.position('A', 1.83)).toBeCloseTo(2.23, 4);
    expect(engine.position('A', 2.5)).toBeCloseTo(2.9, 4);
    const at = Math.round(1.83 * SR);
    const step = maxStep(x, at - 400, at + 400);
    expect(step).toBeLessThan(1.5 * 2 * Math.PI * (hz / SR) * 0.5);
    // after it the output is the track from 2.23 on: compare a stretch of samples
    const from = Math.round(2.0 * SR);
    let err = 0;
    for (let i = from; i < from + 2000; i++) {
      const t = 2.23 + (i - at) / SR;
      err = Math.max(err, Math.abs(x[i]! - 0.5 * Math.sin(2 * Math.PI * hz * t)));
    }
    expect(err).toBeLessThan(1e-3);
  }, 60_000);
});
