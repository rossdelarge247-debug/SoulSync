import { describe, expect, it } from 'vitest';

import { BeatGrid } from './grid';
import { MAX_CORRECTION_S, correction, onsets, type Onset } from './refine';

const SR = 48000;

/** Kicks (a 55 Hz thump, 120 ms) at the given times, from `offset` seconds of the track. */
function kicks(times: number[], seconds: number, offset = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (const t of times) {
    const at = Math.round((t - offset) * SR);
    for (let j = 0; j < 0.12 * SR; j++) {
      const k = at + j;
      if (k < 0 || k >= out.length) continue;
      const u = j / SR;
      out[k] +=
        0.8 * Math.exp(-u / 0.05) * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-u / 0.02)) * u);
    }
  }
  return out;
}

describe('where the kicks really are', () => {
  it('finds each attack to the millisecond, whatever the grid says', () => {
    const real = Array.from({ length: 40 }, (_, i) => 10.3 + i * 0.5);
    const x = kicks(real, 30, 5);
    // a grid 4 ms late on every beat
    const grid = new BeatGrid({ period: 0.5, firstBeat: 10.304 - 20 * 0.5 });
    const found = onsets({ channels: [x], sampleRate: SR, offset: 5 }, grid, 20, 59);
    expect(found.length).toBeGreaterThan(35);
    const errors = found.map((o) => o.error);
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    // the method's own bias is the same on both decks; the spread is what counts
    for (const e of errors) expect(Math.abs(e - mean)).toBeLessThan(0.0005);
    // the steepest rise of the low band comes about 3 ms into the attack
    expect(mean).toBeGreaterThan(0);
    expect(mean).toBeLessThan(0.004);
    expect(found[0].strength).toBeGreaterThan(4);
  });
});

describe('the correction', () => {
  const same = (phi: number) => phi;
  const strong = (beat: number, error: number): Onset => ({ beat, error, strength: 10 });

  it('moves the incoming deck by what the outgoing grid is out by, less its own', () => {
    const a = Array.from({ length: 33 }, (_, i) => strong(100 + i, 0.002));
    const b = Array.from({ length: 33 }, (_, i) => strong(i, 0.006 + 0.0001 * i));
    const fix = correction(a, b, { from: 0, to: 32 }, (phi) => 100 + phi, same);
    expect(fix(0)).toBeCloseTo(-0.004, 3);
    expect(fix(32)).toBeCloseTo(-0.0072, 3);
    expect(fix(16)).toBeCloseTo(-0.0056, 3);
  });

  it('ignores a stray onset (a median over the neighbours) and keeps within its limit', () => {
    const a = Array.from({ length: 33 }, (_, i) => strong(i, 0));
    const b = Array.from({ length: 33 }, (_, i) => strong(i, i === 12 ? 0.03 : 0.001));
    const fix = correction(a, b, { from: 0, to: 32 }, same, same);
    expect(fix(12)).toBeCloseTo(-0.001, 4);
    const far = Array.from({ length: 33 }, (_, i) => strong(i, 0.08));
    expect(correction(a, far, { from: 0, to: 32 }, same, same)(10)).toBe(-MAX_CORRECTION_S);
  });

  it('does nothing without enough clear attacks on both decks', () => {
    const a = Array.from({ length: 33 }, (_, i) => strong(i, 0));
    const weak = Array.from({ length: 33 }, (_, i) => ({ beat: i, error: 0.01, strength: 1.5 }));
    expect(correction(a, weak, { from: 0, to: 32 }, same, same)(5)).toBe(0);
    expect(correction(a.slice(0, 5), a.slice(0, 5), { from: 0, to: 32 }, same, same)(2)).toBe(0);
  });

  it('pairs half time on the beats both decks have', () => {
    const a = Array.from({ length: 65 }, (_, i) => strong(i, 0));
    const b = Array.from({ length: 33 }, (_, i) => strong(i, 0.003));
    const fix = correction(a, b, { from: 0, to: 64 }, same, (phi) => phi / 2);
    expect(fix(20)).toBeCloseTo(-0.003, 4);
  });
});
