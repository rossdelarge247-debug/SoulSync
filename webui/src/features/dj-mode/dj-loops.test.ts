/**
 * DJ mode step 6 on the fake engine: loops (auto, In/Out, Reloop, ½ ×2, out
 * and on), beatjump, Quantize on the jumps and cues (S7: B's hot cues at
 * once and in phase), and what a loop does at Play B, Back, Hand over and a
 * stop. The worklet's own looping is measured in engine/loops.offline.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionDeps } from './dj-mix-session';

import { beatWords } from './dj-mix-session';
import { gridA, gridB, laneA, laneB, rig, type Rig } from './dj-mix.fixtures';

let r: Rig;
let seeks: number[];

function deps(): Partial<SessionDeps> {
  seeks = [];
  return {
    player: {
      audio: () => r.el as never,
      state: () => r.player,
      seek: (t) => {
        seeks.push(t);
        r.el.currentTime = t;
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  r = rig(vi, deps());
});

afterEach(() => {
  r.session.dispose();
  vi.useRealTimers();
});

async function cued(): Promise<void> {
  r.session.setLanes(laneA(), laneB());
  await r.advance(0.01);
  expect(r.session.snapshot().phase).toBe('ready');
}

async function playing(): Promise<void> {
  await cued();
  r.session.playB();
  await r.advance(3);
  expect(r.session.snapshot().phase).toBe('playing');
}

const posB = (dt = 0) => r.engine.position('B', r.engine.port.time + dt)!;
const posA = (dt = 0) => r.engine.position('A', r.engine.port.time + dt)!;
const frac = (x: number) => x - Math.floor(x);

describe('auto loop', () => {
  it('B loops 4 beats from its nearest beat (Quantize), and keeps looping, on A’s beat', async () => {
    await playing();
    expect(r.session.autoLoop('B')).toBe(true);
    const l = r.session.snapshot().loops.B!;
    expect(l).toMatchObject({ active: true, beats: 4 });
    const g = gridB();
    // on a beat, 4 beats long
    expect(frac(g.beatAt(l.start) + 1e-9)).toBeLessThan(1e-6);
    expect(g.beatAt(l.end) - g.beatAt(l.start)).toBeCloseTo(4, 6);
    expect(r.said.at(-1)).toBe('Deck B loop 4 beats');
    // many loops later it's still inside it, and on A's beat
    await r.advance(9);
    const p = posB();
    expect(p).toBeGreaterThanOrEqual(l.start - 1e-6);
    expect(p).toBeLessThan(l.end);
    const d = Math.abs(frac(gridA().beatAt(posA())) - frac(g.beatAt(p)));
    expect(Math.min(d, 1 - d)).toBeLessThan(0.01);
  });

  it('out of the loop it plays on from where it is: no jump', async () => {
    await playing();
    r.session.autoLoop('B');
    await r.advance(5.3);
    const before = posB(0.03);
    expect(r.session.exitLoop('B')).toBe(true);
    expect(posB(0.03)).toBeCloseTo(before, 6);
    expect(r.engine.loopAt('B', r.engine.port.time + 0.05)).toBeNull();
    await r.advance(4);
    // past the old loop's end now
    expect(posB()).toBeGreaterThan(r.session.snapshot().loops.B!.end);
    expect(r.session.snapshot().loops.B!.active).toBe(false);
  });

  it('½ and ×2 resize a loop from its start; 1/32 is the smallest, 32 the largest', async () => {
    await playing();
    r.session.autoLoop('B');
    r.session.resizeLoop('B', 0.5);
    let l = r.session.snapshot().loops.B!;
    expect(l.beats).toBe(2);
    expect(gridB().beatAt(l.end) - gridB().beatAt(l.start)).toBeCloseTo(2, 6);
    for (let i = 0; i < 9; i++) r.session.resizeLoop('B', 0.5);
    expect(r.session.snapshot().loopSize.B).toBe(1 / 32);
    for (let i = 0; i < 12; i++) r.session.resizeLoop('B', 2);
    l = r.session.snapshot().loops.B!;
    expect(l.beats).toBe(32);
    expect(beatWords(1 / 8)).toBe('1/8 beat');
  });

  it('In, then Out: loops from In at once; Reloop takes it back to its start', async () => {
    await playing();
    expect(r.session.loopOutHere('B')).toBe(false);
    expect(r.said.at(-1)).toBe('Set deck B’s loop in first (I)');
    r.session.loopInHere('B');
    const inAt = r.session.snapshot().loopIn.B!;
    await r.advance(1.5);
    expect(r.session.loopOutHere('B')).toBe(true);
    const l = r.session.snapshot().loops.B!;
    expect(l.start).toBe(inAt);
    await r.advance(0.2);
    expect(posB()).toBeLessThan(l.end);
    r.session.exitLoop('B');
    await r.advance(2);
    expect(r.session.reloop('B')).toBe(true);
    expect(posB(0.03)).toBeCloseTo(l.start, 2);
    expect(r.session.snapshot().loops.B!.active).toBe(true);
  });
});

describe('beatjump', () => {
  it('on the grid, the beat’s phase kept (B stays on A’s beat); a loop moves with it', async () => {
    await playing();
    const g = gridB();
    const was = g.beatAt(posB(0.03));
    expect(r.session.beatjump('B', 1)).toBe(true);
    expect(g.beatAt(posB(0.03))).toBeCloseTo(was + 4, 4);
    r.session.setJumpSize('B', 16);
    r.session.beatjump('B', 1);
    expect(g.beatAt(posB(0.03))).toBeCloseTo(was + 4 + 16, 4);
    r.session.setJumpSize('B', 1);
    r.session.beatjump('B', -1);
    expect(g.beatAt(posB(0.03))).toBeCloseTo(was + 4 + 16 - 1, 4);
    // before the deck's window: said, nothing moves
    r.session.setJumpSize('B', 32);
    expect(r.session.beatjump('B', -1)).toBe(false);
    expect(r.said.at(-1)).toBe('That jump is outside deck B’s 3 minutes');
    // looping: by the loop, and the loop with it
    r.session.autoLoop('B');
    const l = r.session.snapshot().loops.B!;
    r.session.beatjump('B', 1);
    const m = r.session.snapshot().loops.B!;
    expect(g.beatAt(m.start) - g.beatAt(l.start)).toBeCloseTo(4, 4);
    expect(m.active).toBe(true);
    const p = posB(0.03);
    expect(p).toBeGreaterThanOrEqual(m.start - 1e-6);
    expect(p).toBeLessThan(m.end);
  });

  it('A before Play B: the player’s seek, by A’s grid', async () => {
    await cued();
    const t = r.el.currentTime;
    expect(r.session.beatjump('A', 1)).toBe(true);
    expect(seeks.at(-1)).toBeCloseTo(gridA().timeAt(gridA().beatAt(t) + 4), 6);
  });

  it('without a grid: by its BPM, and it says so', async () => {
    r.session.setLanes(laneA(), laneB({ grid: null, bpm: 120 }));
    await r.advance(0.01);
    r.session.previewB(true);
    await r.advance(0.5);
    const was = posB(0.03);
    r.session.beatjump('B', 1);
    expect(posB(0.03)).toBeCloseTo(was + 2, 3);
    expect(r.said.at(-1)).toBe('Deck B on 4 beats: no beat grid, by its BPM');
  });
});

describe('Quantize (S7: B’s hot cues at once, in phase)', () => {
  it('B in the headphones: a cue jumps at once, in phase; with Quantize off, exactly there', async () => {
    await cued();
    r.session.previewB(true);
    await r.advance(1.13);
    const g = gridB();
    const was = frac(g.beatAt(posB(0.03)));
    expect(r.session.jump('B', 31.1)).toBe('jumped');
    const now = g.beatAt(posB(0.03));
    expect(Math.round(now - frac(now))).toBe(Math.round(g.beatAt(31.1)));
    expect(frac(now)).toBeCloseTo(was, 3);
    r.session.setQuantize(false);
    r.session.jump('B', 31.1);
    expect(posB(0.03)).toBeCloseTo(31.1, 4);
  });

  it('loops without Quantize start where the deck is', async () => {
    await playing();
    r.session.setQuantize(false);
    const p = posB(0.03);
    r.session.autoLoop('B');
    expect(r.session.snapshot().loops.B!.start).toBeCloseTo(p, 4);
  });
});

describe('loops and the blend’s paths', () => {
  it('A loops only on its deck; there the muted element is kept where A is', async () => {
    await cued();
    expect(r.session.autoLoop('A')).toBe(false);
    expect(r.said.at(-1)).toMatch(/^A loops once it’s on its deck \(Play B\)/);
    r.session.playB();
    await r.advance(3);
    expect(r.session.autoLoop('A')).toBe(true);
    await r.advance(6);
    const l = r.session.snapshot().loops.A!;
    expect(posA()).toBeLessThan(l.end);
    // the element (running on at A's speed) is put back by the watch once it's past the loop
    expect(r.el.currentTime).toBeGreaterThan(l.start - 0.8);
    expect(r.el.currentTime).toBeLessThan(l.end + 0.8);
    expect(r.session.snapshot().phase).toBe('playing');
  });

  it('Hand over with B looping: the loop ends at the press and B plays on from there (the player can’t loop)', async () => {
    r.session.dispose();
    r = rig(vi, {
      ...deps(),
      player: {
        audio: () => r.el as never,
        state: () => ({
          ...r.player,
          index: 0,
          queue: [{ id: '2', title: 'Night Ferry', file_path: '/m/2.flac' }],
        }),
        insertNext: () => 1,
        playIndex: async () => ({ status: 'busy' }),
      },
    });
    r.session.setLanes(
      laneA(),
      laneB({ queue: { id: '8', title: 'Harbour Lights', file_path: '/m/8.flac' } }),
    );
    await r.advance(0.01);
    r.session.playB();
    await r.advance(3);
    r.session.autoLoop('B');
    await r.advance(2.7);
    const p = posB(0.03);
    expect(r.session.handOver('press')).toBe(true);
    expect(r.said).toContain(
      'Harbour Lights’s loop ends: the player can’t loop, it plays on from here',
    );
    expect(r.session.snapshot().loops.B!.active).toBe(false);
    expect(posB(0.03)).toBeCloseTo(p, 4);
  });

  it('Back with A looping: A’s loop ends at the press, A goes back to the player from where it is', async () => {
    await playing();
    r.session.autoLoop('A');
    await r.advance(3);
    r.session.backOverBar(null);
    expect(r.session.snapshot().loops.A!.active).toBe(false);
    expect(r.said).toContain('Night Ferry’s loop ends: back on the player it plays on');
    await r.advance(3);
    expect(r.session.snapshot().aOnDeck).toBe(false);
    expect(r.el.muted).toBe(false);
  });

  it('a hard stop and DJ mode off end every loop', async () => {
    await playing();
    r.session.autoLoop('B');
    r.session.end();
    expect(r.session.snapshot().loops.B?.active ?? false).toBe(false);
  });
});

describe('the phase meter’s reading', () => {
  it('beats apart, wrapped to half a beat either way, in words', async () => {
    const { phaseOffset, phaseWords } = await import('./dj-sync');
    const a = gridA();
    const b = gridB();
    // A on a beat, B a tenth of a beat past one: B ahead
    expect(phaseOffset(b, b.timeAt(10.1), a, a.timeAt(20))).toBeCloseTo(0.1, 6);
    expect(phaseOffset(a, a.timeAt(20), b, b.timeAt(10.1))).toBeCloseTo(-0.1, 6);
    expect(phaseOffset(b, b.timeAt(10.9), a, a.timeAt(20))).toBeCloseTo(-0.1, 6);
    expect(phaseWords(0.1, 0.5)).toBe('50 ms ahead of');
    expect(phaseWords(-0.06, 0.5)).toBe('30 ms behind');
    expect(phaseWords(0.004, 0.5)).toBe('in phase with');
  });
});

describe('review round 1 (step 6)', () => {
  function handingDeps(): Partial<SessionDeps> {
    seeks = [];
    return {
      player: {
        audio: () => r.el as never,
        state: () => ({
          ...r.player,
          index: 0,
          queue: [{ id: '2', title: 'Night Ferry', file_path: '/m/2.flac' }],
        }),
        seek: (t) => {
          seeks.push(t);
          r.el.currentTime = t;
        },
        insertNext: () => 1,
        playIndex: async () => ({ status: 'played' }),
      },
    };
  }

  it('M2: A looping its outro never runs out; out of the loop its end comes as before (a Hand over)', async () => {
    r.session.dispose();
    r = rig(vi, handingDeps());
    r.session.setLanes(
      laneA(),
      laneB({ queue: { id: '8', title: 'Harbour Lights', file_path: '/m/8.flac' } }),
    );
    await r.advance(0.01);
    r.session.playB();
    await r.advance(3);
    expect(r.session.jump('A', 270)).toBe('jumped');
    r.session.setLoopSize('A', 32);
    expect(r.session.autoLoop('A')).toBe(true);
    const l = r.session.snapshot().loops.A!;
    // kept inside the track (review L1)
    expect(l.end).toBeLessThanOrEqual(286);
    await r.advance(40);
    expect(r.session.snapshot().phase).toBe('playing');
    expect(r.session.snapshot().loops.A!.active).toBe(true);
    expect(posA()).toBeLessThan(l.end);
    r.session.exitLoop('A');
    await r.advance(18);
    expect(r.said.some((w) => w.includes('handed over to Harbour Lights'))).toBe(true);
  });

  it('M2: B looping in the blend near its 3 minutes isn’t taken back by the window’s end', async () => {
    await playing();
    r.session.jump('B', 170);
    r.session.setLoopSize('B', 8);
    expect(r.session.autoLoop('B')).toBe(true);
    await r.advance(20);
    expect(r.session.snapshot().phase).toBe('playing');
  });

  it('L1: a loop past B’s window is cut short, and refused when nothing fits', async () => {
    await cued();
    r.session.parkB(179.0);
    r.session.setLoopSize('B', 8);
    expect(r.session.autoLoop('B')).toBe(true);
    expect(r.session.snapshot().loops.B!.end).toBeLessThanOrEqual(179.75 + 1e-9);
    r.session.exitLoop('B');
    r.session.setQuantize(false);
    r.session.parkB(179.9);
    expect(r.session.autoLoop('B')).toBe(false);
    expect(r.said.at(-1)).toBe('No room for a loop here: deck B’s 3 minutes end');
  });

  it('L2: B on its own looping, then Back: B goes out from where it is (unwound, no jump)', async () => {
    await cued();
    r.el.paused = true;
    r.el.ended = true;
    r.session.playB();
    await r.advance(0.5);
    expect(r.session.snapshot().solo).toBe(true);
    r.session.autoLoop('B');
    await r.advance(5.3);
    const before = posB(0.03);
    r.session.backOverBar(null);
    expect(posB(0.03)).toBeCloseTo(before, 4);
    expect(r.session.snapshot().loops.B!.active).toBe(false);
  });

  it('L3: while A loops the element is put back about once a loop, not every quarter second', async () => {
    await playing();
    let n = 0;
    r.el.addEventListener('seeking', () => (n += 1));
    r.session.autoLoop('A');
    await r.advance(10);
    // a 4-beat loop is 2 s: about five
    expect(n).toBeLessThanOrEqual(6);
    expect(n).toBeGreaterThanOrEqual(3);
    // out of it, the element is where A is heard
    r.session.exitLoop('A');
    expect(Math.abs(r.el.currentTime - posA())).toBeLessThan(0.05);
  });

  it('L4: the phase meter compares a double-time pair in the slower deck’s beats', async () => {
    const { phaseOffset } = await import('./dj-sync');
    const a = gridA();
    const b = gridB();
    // B at double time (2 B beats an A beat): B half a beat past one is a quarter of A's
    expect(phaseOffset(b, b.timeAt(20.5), a, a.timeAt(10), 2)).toBeCloseTo(0.25, 6);
    expect(phaseOffset(a, a.timeAt(10), b, b.timeAt(20.5), 0.5)).toBeCloseTo(-0.25, 6);
  });
});
