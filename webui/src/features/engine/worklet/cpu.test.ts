/**
 * What the decks cost on the audio thread: both decks playing music-like
 * audio for ten seconds, timed through the worklet's own process(), in
 * Node's V8 (Chrome's engine). The figures printed are HANDOFF's; the bound
 * asserted is loose so a busy CI runner doesn't fail it.
 */

import { describe, expect, it } from 'vitest';

import { loadMessage, WorkletRunner } from './run-worklet';

const SR = 48000;

function music(seconds: number, seed: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const t = i / SR;
    const beat = (t * 2.07) % 1;
    out[i] =
      0.3 * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-beat * 8) +
      0.15 * Math.sin(2 * Math.PI * 330 * t + Math.sin(t)) +
      0.05 * (s / 2 ** 32 - 0.5);
  }
  return out;
}

function cost(mode: 'resample' | 'stretch', rate: number): number {
  const w = new WorkletRunner(SR);
  for (const deck of [0, 1]) {
    const src = music(30, deck + 1);
    w.send(loadMessage(deck, src, src.slice(), SR));
    w.send({ type: 'mode', deck, mode });
    w.send({ type: 'map', deck, from: 0, knots: Float64Array.from([0, 1, deck === 0 ? 1 : rate]) });
  }
  w.time(400); // warm up the JIT
  const blocks = Math.round((10 * SR) / 128);
  const ms = w.time(blocks);
  return ms / 10000; // share of real time (10 s)
}

describe('the decks on the audio thread', () => {
  it('cost a few percent of one core, both decks playing', () => {
    const resample = cost('resample', 1.016);
    const stretch = cost('stretch', 1.056);
    const pct = (x: number) => `${(x * 100).toFixed(2)}% of one core`;
    console.info(
      `cpu, both decks: resample ${pct(resample)} (${((resample * 128 * 1e6) / SR).toFixed(1)} µs a 128-frame block), ` +
        `stretch ${pct(stretch)} (${((stretch * 128 * 1e6) / SR).toFixed(1)} µs a block)`,
    );
    expect(resample).toBeLessThan(0.25);
    expect(stretch).toBeLessThan(0.25);
  });
});
