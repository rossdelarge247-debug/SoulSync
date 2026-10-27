import { describe, expect, it } from 'vitest';

import { MasterClock, flatten, glideKnots, positionAt, spliceKnots, type ClockSpec } from './clock';
import { BeatGrid } from './grid';

const SR = 48000;

function grid(bpm: number, first = 0.1, down = 0) {
  return new BeatGrid({ period: 60 / bpm, firstBeat: first, downbeatIndex: down });
}

function spec(over: Partial<ClockSpec> = {}): ClockSpec {
  const a = grid(124, 0.5);
  const b = grid(126, 0.2);
  return {
    t0: 10,
    beats: 128,
    a: { grid: a, beat0: a.barBeat(80) },
    b: { grid: b, beat0: b.barBeat(0), perMaster: 1 },
    tempo: { kind: 'morph' },
    ...over,
  };
}

describe('the master clock', () => {
  it('puts the incoming downbeat on the outgoing phrase and every beat after on its beat', () => {
    const c = new MasterClock(spec());
    expect(c.timeAt(0)).toBe(10);
    expect(c.posA(0)).toBeCloseTo(0.5 + 320 * (60 / 124), 9);
    expect(c.posB(0)).toBeCloseTo(0.2, 9);
    for (let phi = 0; phi <= 128; phi += 4) {
      expect(c.posA(phi)).toBeCloseTo(grid(124, 0.5).timeAt(320 + phi), 9);
      expect(c.posB(phi)).toBeCloseTo(grid(126, 0.2).timeAt(phi), 9);
    }
  });

  it('moves the tempo from the outgoing track to the incoming one', () => {
    const c = new MasterClock(spec());
    const start = c.ratesAt(0);
    const end = c.ratesAt(128);
    expect(start.a).toBeCloseTo(1, 4);
    // the incoming track is faster: it plays slower to match, then the
    // outgoing one speeds up to the incoming tempo
    expect(start.b).toBeCloseTo(124 / 126, 4);
    expect(end.b).toBeCloseTo(1, 4);
    expect(end.a).toBeCloseTo(126 / 124, 4);
    // gently: no step anywhere
    let prev = c.periodAt(0);
    for (let phi = 0.25; phi <= 140; phi += 0.25) {
      const p = c.periodAt(phi);
      expect(Math.abs(p - prev)).toBeLessThan(1e-4);
      prev = p;
    }
  });

  it('reads back: beatAt undoes timeAt, also before the window', () => {
    const c = new MasterClock(spec());
    for (const phi of [-8, -0.5, 0, 3.3, 64, 127.9, 150])
      expect(c.beatAt(c.timeAt(phi))).toBeCloseTo(phi, 6);
  });

  it('plays the outgoing deck at its own speed before the window', () => {
    const c = new MasterClock(spec());
    expect(c.timeAt(-4)).toBeCloseTo(10 - 4 * (60 / 124), 9);
  });

  it('follows a drifting track beat for beat', () => {
    const beats: number[] = [];
    let t = 0.3;
    for (let i = 0; i < 400; i++) {
      beats.push(t);
      t += 60 / (122 + (5 * i) / 400);
    }
    const b = new BeatGrid({ kind: 'beats', period: 60 / 124, firstBeat: 0.3, beats });
    const c = new MasterClock(spec({ b: { grid: b, beat0: 16, perMaster: 1 } }));
    for (let phi = 0; phi <= 128; phi += 1) expect(c.posB(phi)).toBeCloseTo(beats[16 + phi], 9);
  });

  it('counts half time: one incoming beat to two outgoing', () => {
    const b = grid(63);
    const c = new MasterClock(spec({ b: { grid: b, beat0: 0, perMaster: 0.5 } }));
    expect(c.posB(8)).toBeCloseTo(b.timeAt(4), 9);
    expect(c.ratesAt(128).b).toBeCloseTo(1, 4);
  });

  it('holds a tempo', () => {
    const c = new MasterClock(spec({ tempo: { kind: 'hold', period: 0.5 }, from: 20, t0: 50 }));
    expect(c.timeAt(24)).toBeCloseTo(52, 9);
    expect(c.timeAt(20)).toBe(50);
  });

  it('applies a correction to the incoming deck only', () => {
    const c = new MasterClock(spec({ correction: () => -0.003 }));
    expect(c.posB(4)).toBeCloseTo(grid(126, 0.2).timeAt(4) - 0.003, 9);
    expect(c.posA(4)).toBeCloseTo(grid(124, 0.5).timeAt(324), 9);
  });
});

describe('position maps', () => {
  it('gives the decks their places at each beat, to the microsecond', () => {
    const c = new MasterClock(spec());
    const kb = c.knots('B', SR, 0, 144);
    const ka = c.knots('A', SR, 0, 132);
    for (let phi = 0; phi <= 128; phi += 0.5) {
      const f = c.timeAt(phi) * SR;
      expect(positionAt(kb, f, SR)).toBeCloseTo(c.posB(phi), 6);
      expect(positionAt(ka, f, SR)).toBeCloseTo(c.posA(phi), 6);
    }
    expect(kb.at(-1)?.r).toBeCloseTo(1, 4);
  });

  it('flattens as the worklet reads them', () => {
    expect(
      Array.from(
        flatten([
          { f: 1, p: 2, r: 3 },
          { f: 4, p: 5, r: 6 },
        ]),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('splices a new map in from a frame, as the worklet does', () => {
    const old = [
      { f: 0, p: 0, r: 1 },
      { f: 100, p: 1, r: 1 },
      { f: 200, p: 2, r: 1 },
    ];
    expect(spliceKnots(old, 150, [{ f: 150, p: 9, r: 2 }])).toEqual([
      old[0],
      old[1],
      { f: 150, p: 9, r: 2 },
    ]);
    expect(positionAt([], 5, SR)).toBeNull();
    expect(positionAt(old, -1, SR)).toBeNull();
  });

  it('glides a deck back to its own speed without a break', () => {
    const k = glideKnots(20, 100, 1.04, 1, 8, SR);
    const at = (t: number) => positionAt(k, t * SR, SR) as number;
    expect(at(20)).toBe(100);
    // the speed moves smoothly from 1.04 to 1
    expect((at(20.01) - at(20)) / 0.01).toBeCloseTo(1.04, 3);
    expect((at(28.01) - at(28)) / 0.01).toBeCloseTo(1, 6);
    expect(at(28)).toBeCloseTo(100 + 8 * 1.02, 6);
    let worst = 0;
    for (let t = 20.001; t < 30; t += 0.001)
      worst = Math.max(worst, Math.abs(at(t) - at(t - 0.001) - 0.00102));
    expect(worst).toBeLessThan(0.00003);
  });
});
