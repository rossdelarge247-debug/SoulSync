/**
 * Step 4b on the decks: B's own Play before the blend (into the headphones,
 * the speakers silent), where it's parked, the hand on the platter (a
 * stopped deck scrubbed, a playing one nudged), and ← → nudges.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NUDGE } from './dj-mix-session';
import { laneA, laneB, rig, type Rig } from './dj-mix.fixtures';

let r: Rig;

beforeEach(() => {
  vi.useFakeTimers();
  r = rig(vi);
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

const master = () => r.engine.master.browser.valueAt(r.engine.port.time);

describe('B’s own Play before the blend (the headphones only)', () => {
  it('plays from its cue at its own tempo; the speakers stay silent; paused, it’s parked where it is', async () => {
    await cued();
    expect(r.session.previewB(true)).toBe(true);
    const t = r.engine.port.time + 0.03;
    expect(r.engine.position('B', t)).toBeCloseTo(0.5, 3);
    expect(r.engine.port.rate('B', t + 0.5)).toBeCloseTo(1, 4);
    expect(r.session.snapshot()).toMatchObject({ phase: 'ready', previewB: true, aOnDeck: false });
    expect(r.session.deckPlaying('B')).toBe(true);
    // the decks' master is down (A is on the player) and the fader at A: the room hears nothing of B
    expect(master()).toBe(0);
    expect(r.engine.value('B.xf')).toBe(0);
    await r.advance(2);
    expect(r.session.previewB(false)).toBe(true);
    const parked = r.session.snapshot().parkB!;
    expect(parked).toBeCloseTo(2.53, 1);
    expect(r.session.positionB()).toBe(parked);
    // Play again carries on from there
    r.session.previewB(true);
    expect(r.engine.position('B', r.engine.port.time + 0.03)).toBeCloseTo(parked, 3);
  });

  it('Play B is still the synced start: from the cue point, on A’s next bar', async () => {
    await cued();
    r.session.previewB(true);
    await r.advance(3);
    r.session.playB();
    expect(r.session.snapshot()).toMatchObject({ phase: 'starting', previewB: false, parkB: null });
    expect(r.engine.port.maps.B[0]!.p).toBeCloseTo(0.5, 2);
  });

  it('parked by CUE (a seek of B’s transport): inside its window only', async () => {
    await cued();
    r.session.parkB(40);
    expect(r.session.snapshot().parkB).toBe(40);
    r.session.parkB(-5);
    expect(r.session.snapshot().parkB).toBeCloseTo(0.05, 3);
  });

  it('nothing before B is on its deck, or once A is', async () => {
    expect(r.session.previewB(true)).toBe(false);
    await cued();
    r.session.playB();
    await r.advance(3);
    expect(r.session.previewB(true)).toBe(false);
  });
});

describe('the hand on the platter', () => {
  it('a stopped B scrubbed: it moves only as the hand does, and stays where it’s let go', async () => {
    await cued();
    expect(r.session.grab('B')).toBeNull();
    expect(r.engine.port.modes.B).toBe('resample');
    expect(r.session.snapshot().hand).toBe('B');
    // held still: it doesn't move
    await r.advance(0.3);
    expect(r.engine.position('B')).toBeCloseTo(0.5, 2);
    // moved 2 s on, the deck follows (faster than its speed, then still)
    r.session.moveHand('B', 2);
    await r.advance(0.15);
    expect(r.engine.port.rate('B', r.engine.port.time)).toBeGreaterThan(1.5);
    await r.advance(1);
    expect(r.engine.position('B')).toBeCloseTo(2.5, 1);
    expect(Math.abs(r.engine.port.rate('B', r.engine.port.time))).toBeLessThan(0.2);
    // and back, the other way
    r.session.moveHand('B', 1);
    await r.advance(0.1);
    expect(r.engine.port.rate('B', r.engine.port.time)).toBeLessThan(0);
    await r.advance(1);
    r.session.letGo('B');
    expect(r.session.snapshot().parkB).toBeCloseTo(1.5, 1);
    expect(r.session.snapshot().hand).toBeNull();
    expect(r.engine.port.stops.B / 48000).toBeLessThan(r.engine.port.time + 0.1);
  });

  it('a playing B nudged: faster with the hand, back to its speed when let go, the offset kept', async () => {
    await cued();
    r.session.playB();
    await r.advance(3);
    const t0 = r.engine.port.time;
    const p0 = r.engine.position('B')!;
    const base = r.engine.port.rate('B', t0);
    expect(r.session.grab('B')).toBeNull();
    r.session.moveHand('B', 0.25);
    await r.advance(0.1);
    expect(r.engine.port.rate('B', r.engine.port.time)).toBeGreaterThan(base * 1.5);
    await r.advance(0.9);
    r.session.letGo('B');
    const t1 = r.engine.port.time + 0.5;
    expect(r.engine.port.rate('B', t1)).toBeCloseTo(base, 3);
    // where it'd have been at its speed, plus the hand's quarter second
    expect(r.engine.position('B', t1)).toBeCloseTo(p0 + base * (t1 - t0) + 0.25, 1);
    expect(r.session.snapshot().phase).toBe('playing');
  });

  it('A only once it’s on its deck; never while the context is paused', async () => {
    await cued();
    expect(r.session.grab('A')).toBe(
      'A is the player’s: nudge and scrub it once it’s on its deck (Play B)',
    );
    r.session.playB();
    await r.advance(3);
    expect(r.session.grab('A')).toBeNull();
    r.session.letGo('A');
    r.engine.state = 'suspended';
    expect(r.session.grab('B')).toBe('Paused: play to move the decks');
  });

  it('end() lets go of the hand', async () => {
    await cued();
    r.session.grab('B');
    r.session.end();
    expect(r.session.snapshot().hand).toBeNull();
  });
});

describe('← → nudges', () => {
  it('a playing deck 4% faster or slower while held, back to its speed where it is', async () => {
    await cued();
    r.session.playB();
    await r.advance(3);
    const base = r.engine.port.rate('A', r.engine.port.time);
    expect(r.session.nudge('A', 1)).toBe(true);
    expect(r.engine.port.rate('A', r.engine.port.time + 0.2)).toBeCloseTo(base * (1 + NUDGE), 4);
    await r.advance(0.5);
    r.session.nudge('A', 0);
    expect(r.engine.port.rate('A', r.engine.port.time + 0.2)).toBeCloseTo(base, 4);
    const bBase = r.engine.port.rate('B', r.engine.port.time);
    r.session.nudge('B', -1);
    r.session.nudge('B', -1);
    expect(r.engine.port.rate('B', r.engine.port.time + 0.2)).toBeCloseTo(bBase * (1 - NUDGE), 3);
    r.session.nudge('B', 0);
    expect(r.engine.port.rate('B', r.engine.port.time + 0.2)).toBeCloseTo(bBase, 3);
  });

  it('a stopped deck isn’t nudged (the key stays the player’s)', async () => {
    await cued();
    expect(r.session.nudge('B', 1)).toBe(false);
    expect(r.session.nudge('A', 1)).toBe(false);
  });
});

describe('review round 1 (step 4b)', () => {
  it('M-3: a scrub held on B, then Play B: the blend has B, and the late let-go does nothing', async () => {
    await cued();
    expect(r.session.grab('B')).toBeNull();
    r.session.moveHand('B', 1);
    await r.advance(0.2);
    r.session.playB();
    expect(r.session.snapshot().hand).toBeNull();
    await r.advance(3);
    expect(r.session.snapshot().phase).toBe('playing');
    const before = r.engine.port.rate('B', r.engine.port.time);
    r.session.letGo('B');
    await r.advance(0.5);
    expect(r.engine.port.stops.B).toBe(Infinity);
    expect(r.engine.port.rate('B', r.engine.port.time)).toBeCloseTo(before, 2);
  });

  it('M-3: a hand on B during Hand over gives way to the glide', async () => {
    r.session.setLanes(
      laneA(),
      laneB({ queue: { id: '8', title: 'Harbour Lights', file_path: '/m/8.flac' } }),
    );
    await r.advance(0.01);
    r.session.playB();
    await r.advance(3);
    r.session.grab('B');
    r.session.moveHand('B', 0.5);
    await r.advance(0.1);
    const t = r.engine.port.time + 0.03;
    // the player here can't take B (no playIndex): the glide is what's checked
    (r.session as unknown as { d: { player: Record<string, unknown> } }).d.player.playIndex =
      async () => ({ status: 'superseded' });
    (r.session as unknown as { d: { player: Record<string, unknown> } }).d.player.insertNext = () =>
      1;
    expect(r.session.handOver()).toBe(true);
    expect(r.session.snapshot().hand).toBeNull();
    await r.advance(0.5);
    // B on its glide towards its own speed, not rewritten by the hand's timer
    expect(r.engine.port.rate('B', t + 2.01)).toBeCloseTo(1, 3);
  });

  it('L-1: lane A changing while B plays in the headphones stops B', async () => {
    await cued();
    r.session.previewB(true);
    await r.advance(0.5);
    r.session.setLanes(laneA({ id: '5', title: 'Static Bloom' }), laneB());
    expect(r.session.snapshot().previewB).toBe(false);
    expect(r.engine.port.stops.B / 48000).toBeLessThan(r.engine.port.time + 0.05);
  });

  it('L-2: a nudge on B held by Sync is locked again at the moved phase', async () => {
    await cued();
    r.session.playB();
    await r.advance(3);
    expect(r.session.snapshot().rateB).not.toBeNull();
    r.session.nudge('B', 1);
    await r.advance(0.3);
    r.session.nudge('B', 0);
    // still Sync's lock (its rate), not a constant left by the nudge
    expect(r.session.snapshot().rateB).not.toBeNull();
    expect(r.engine.port.rate('B', r.engine.port.time + 0.5)).toBeCloseTo(0.96, 2);
    r.session.grab('B');
    r.session.moveHand('B', 0.1);
    await r.advance(0.3);
    r.session.letGo('B');
    expect(r.session.snapshot().rateB).not.toBeNull();
    expect(r.engine.port.rate('B', r.engine.port.time + 0.5)).toBeCloseTo(0.96, 2);
  });
});
