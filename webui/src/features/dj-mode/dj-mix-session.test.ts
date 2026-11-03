/**
 * DJ mode's decks (step 3: 37g, 37h; 413, 416, 421, 424, 432–434) on a fake
 * engine: B cued from its mix-in, Play B on A's next bar with A moved onto
 * its deck under the element (whose position is never touched), the hand
 * controls on the engine's params, Sync on and off, Back over a bar, the
 * hard stops, the windows' ends, and one announcement per change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KILL_DB } from '@/features/engine/score';

import { AHEAD_S, FADE_S } from './dj-mix-session';
import { laneA, laneB, rig, type Rig } from './dj-mix.fixtures';
import { xfGains } from './dj-mixer.logic';

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

describe('cued (37g)', () => {
  it('B’s window is its 3 minutes from its mix-in (434); A’s is from where the player is', async () => {
    await cued();
    expect(r.windows[0]).toEqual({ id: '8', start: 0, dur: 180 });
    expect(r.windows[1]!.id).toBe('2');
    expect(r.windows[1]!.start).toBeCloseTo(120.5, 1);
    expect(r.engine.loads.map((l) => l.deck)).toEqual(['B', 'A']);
    expect(r.session.snapshot().window).toEqual({ start: 0, end: 180 });
    // nothing plays: the master is shut and the element is untouched
    expect(r.engine.port.maps.A).toEqual([]);
    expect(r.el.muted).toBe(false);
  });

  it('Sync is on by default and can work with both grids; without one it says why', async () => {
    await cued();
    expect(r.session.snapshot()).toMatchObject({ sync: true, syncable: true, syncWhy: null });
    r.session.setLanes(laneA(), laneB({ grid: null }));
    expect(r.session.snapshot().syncable).toBe(false);
    expect(r.session.snapshot().syncWhy).toBe(
      'Harbour Lights has no beat grid: Sync is off, blend by ear',
    );
    r.session.setLanes(laneA(), laneB({ bpm: 160 }));
    expect(r.session.snapshot().syncWhy).toMatch(/too far apart in tempo/);
  });

  it('420: a grid that lands after its analysis turns Sync on and says so once', async () => {
    r.session.setLanes(laneA(), laneB({ grid: null, analysing: true }));
    await r.advance(0.01);
    expect(r.said).toEqual([]);
    r.session.setLanes(laneA(), laneB());
    expect(r.session.snapshot().syncable).toBe(true);
    expect(r.said).toEqual(['Sync on: Harbour Lights will play at Night Ferry’s tempo']);
    r.session.setLanes(laneA(), laneB());
    expect(r.said).toHaveLength(1);
  });

  it('a failed window says so once and Play B tries again', async () => {
    let fail = true;
    r.session.dispose();
    r = rig(vi, {
      fetchWindow: async (_c, _id, start, dur) => {
        if (fail) throw new Error('The server is busy');
        return {
          channels: [],
          mono4: new Float32Array(0),
          sampleRate: 48000,
          offset: start,
          duration: dur,
        };
      },
    });
    r.session.setLanes(laneA(), laneB());
    await r.advance(0.01);
    expect(r.session.snapshot().phase).toBe('failed');
    expect(r.said).toEqual(['Couldn’t get Harbour Lights ready: The server is busy']);
    fail = false;
    expect(r.session.playB()).toBe(false);
    await r.advance(0.01);
    expect(r.session.snapshot().phase).toBe('ready');
  });

  it('a page that can’t run the decks (plain http elsewhere) says why; the lanes stay', async () => {
    r.session.dispose();
    r = rig(vi, { support: () => 'Play B needs SYNCHRO.S on https' });
    r.session.setLanes(laneA(), laneB());
    await r.advance(0.01);
    expect(r.session.snapshot()).toMatchObject({
      phase: 'failed',
      error: 'Play B needs SYNCHRO.S on https',
    });
    expect(r.windows).toEqual([]);
    expect(r.session.playB()).toBe(false);
    await r.advance(0.01);
    // said as it's found, and again when Play B is pressed
    expect(r.said).toEqual(['Play B needs SYNCHRO.S on https', 'Play B needs SYNCHRO.S on https']);
    expect(r.windows).toEqual([]);
  });

  it('A’s window follows the player while B waits', async () => {
    r.session.setLanes(laneA({ duration: 600 }), laneB());
    await r.advance(0.01);
    const before = r.windows.length;
    r.el.currentTime = 260; // A's window (120.5–300.5) has less than a minute left
    await r.advance(2.1);
    expect(r.windows.length).toBe(before + 1);
    expect(r.windows.at(-1)!.start).toBeGreaterThan(259);
  });
});

describe('Play B (421, 432)', () => {
  it('A moves onto deck A at the element’s position, without moving the element', async () => {
    await cued();
    const t0 = r.engine.port.time;
    const at = r.el.currentTime;
    expect(r.session.playB()).toBe(true);
    const T = t0 + AHEAD_S;
    const a = r.engine.port.maps.A[0]!;
    expect(a.f / 48000).toBeCloseTo(T, 9);
    expect(a.p).toBeCloseTo(at + AHEAD_S, 9);
    expect(a.r).toBe(1);
    expect(r.engine.port.modes.A).toBe('resample');
    // the decks fade in as the element fades out, then it plays on muted
    expect(r.engine.master.browser.valueAt(T)).toBe(0);
    expect(r.engine.master.browser.valueAt(T + FADE_S)).toBeCloseTo(0.7);
    await r.advance(AHEAD_S + FADE_S + 0.05);
    expect(r.el.muted).toBe(true);
    expect(r.el.volume).toBeCloseTo(0.7);
    // the player's position, its scrobble and Media Session are the element's: it ran on
    expect(r.el.currentTime).toBeCloseTo(at + AHEAD_S + FADE_S + 0.05, 1);
    expect(r.session.snapshot().aOnDeck).toBe(true);
  });

  it('B starts at its cue on A’s next bar, stretched onto A’s beats (Sync)', async () => {
    await cued();
    const t0 = r.engine.port.time;
    const at = r.el.currentTime;
    r.session.playB();
    const T = t0 + AHEAD_S;
    // A at about 121.1 at T: its next bar (2 s bars from 1 s) starts at 123
    const Tb = T + (123 - (at + AHEAD_S));
    const first = r.engine.port.maps.B[0]!;
    expect(first.f / 48000).toBeCloseTo(Tb, 6);
    expect(first.p).toBeCloseTo(0.5, 6);
    expect(first.r).toBeCloseTo(0.96, 6);
    expect(r.engine.port.modes.B).toBe('stretch');
    // locked beat for beat: 8 beats of A later, B is 8 of its own beats on
    expect(r.engine.position('B', Tb + 4)).toBeCloseTo(0.5 + 8 * 0.48, 6);
    expect(r.session.snapshot().phase).toBe('starting');
    await r.advance(Tb - t0 + 0.02);
    expect(r.session.snapshot().phase).toBe('playing');
    expect(r.said).toEqual(['Harbour Lights playing, on Night Ferry’s beat']);
  });

  it('without Sync B starts at its own tempo on A’s next bar; without A’s grid at once', async () => {
    await cued();
    r.session.setSync(false);
    r.session.playB();
    const b = r.engine.port.maps.B[0]!;
    expect(b.r).toBe(1);
    expect(r.engine.port.modes.B).toBe('resample');
    r.session.end();
    await r.advance(0.3);
    r.session.setLanes(laneA({ grid: null }), laneB());
    await r.advance(0.01);
    const t0 = r.engine.port.time;
    expect(r.session.snapshot().phase).toBe('ready');
    expect(r.session.playB()).toBe(true);
    // 432: A moves onto its deck the same way without a grid
    expect(r.engine.port.maps.A.at(-1)!.p).toBeCloseTo(r.el.currentTime + AHEAD_S, 6);
    expect(r.engine.port.maps.B.at(-1)!.f / 48000).toBeCloseTo(t0 + AHEAD_S + 0.25, 6);
  });

  it('asks for A to play first, and auto-mix lets go', async () => {
    const autoStop = vi.fn();
    r.session.dispose();
    r = rig(vi, { autoStop });
    await cued();
    r.el.paused = true;
    expect(r.session.playB()).toBe(false);
    expect(r.said).toEqual(['Play Night Ferry first: B comes in on its beat']);
    r.el.paused = false;
    r.session.playB();
    expect(autoStop).toHaveBeenCalledTimes(1);
  });

  it('Pause B stops B where it is, and Play B carries on from its next bar on A’s next bar', async () => {
    await cued();
    r.session.playB();
    await r.advance(4);
    expect(r.session.pauseB()).toBe(true);
    const at = r.session.positionB()!;
    expect(r.engine.port.stops.B).toBeLessThan(Infinity);
    expect(r.session.snapshot().phase).toBe('paused');
    r.session.playB();
    const jump = r.engine.port.jumps.filter((j) => j.deck === 'B').at(-1)!;
    const first = r.engine.port.maps.B.find((k) => k.f === jump.from)!;
    // B's next bar after where it paused (0.5 + n × 1.92)
    const bars = (first.p - 0.5) / 1.92;
    expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-6);
    expect(first.p).toBeGreaterThanOrEqual(at - 1e-6);
  });
});

describe('the controls on the engine (37g, 37h)', () => {
  it('EQ, a kill, the filter, the crossfader and the echo set the engine’s params', async () => {
    await cued();
    const s = r.session;
    s.setDeck('A', 'high', -3);
    s.setKill('A', 'low', true);
    s.setDeck('A', 'filter', 50);
    s.setCentre('xf', 62);
    s.setCentre('echoSend', 40);
    s.setCentre('echoFeedback', 35);
    s.setDeck('B', 'mid', -2);
    await r.advance(0.05);
    const v = (k: `${'A' | 'B'}.${string}`) => r.engine.value(k);
    expect(v('A.high')).toBeCloseTo(-3);
    expect(v('A.low')).toBe(KILL_DB);
    expect(v('A.hp')).toBeGreaterThan(200);
    expect(v('A.lp')).toBe(20000);
    expect(v('A.xf')).toBeCloseTo(xfGains(62).A, 4);
    expect(v('B.xf')).toBeCloseTo(xfGains(62).B, 4);
    expect(v('A.echoSend')).toBeCloseTo(0.4);
    expect(v('B.echoSend')).toBe(0);
    expect(v('A.echoFeedback')).toBeCloseTo(0.35);
    // 3/8 of A's beat (0.5 s)
    expect(v('A.echoTime')).toBeCloseTo(0.1875);
    expect(v('B.mid')).toBeCloseTo(-2);
    // a kill and its release are announced, once each
    s.setKill('A', 'low', true);
    s.setKill('A', 'low', false);
    expect(r.said).toEqual(['Deck A Low killed', 'Deck A Low back']);
    await r.advance(0.05);
    expect(v('A.low')).toBe(0);
  });

  it('a change ramps over 20 ms: nothing jumps', async () => {
    await cued();
    const t = r.engine.port.time;
    r.session.setCentre('xf', 100);
    expect(r.engine.value('A.xf', t)).toBeCloseTo(1);
    expect(r.engine.value('A.xf', t + 0.01)).toBeGreaterThan(0.3);
    expect(r.engine.value('A.xf', t + 0.02)).toBeCloseTo(0, 5);
  });
});

describe('Sync mid-blend (433)', () => {
  it('off: B glides back to its own tempo over one bar, no jump', async () => {
    await cued();
    r.session.playB();
    await r.advance(3);
    const t = r.engine.port.time + 0.03;
    const before = r.engine.position('B', t)!;
    r.session.setSync(false);
    expect(r.engine.position('B', t)).toBeCloseTo(before, 4);
    expect(r.engine.port.rate('B', t + 0.01)).toBeCloseTo(0.96, 2);
    expect(r.engine.port.rate('B', t + 2.1)).toBeCloseTo(1, 4);
    expect(r.said.at(-1)).toBe('Sync off: Harbour Lights back to its own tempo over a bar');
    expect(r.session.snapshot().rateB).toBeNull();
  });

  it('on again: B lands on one of A’s beats at A’s next bar and stays locked', async () => {
    await cued();
    r.session.setSync(false);
    r.session.playB();
    await r.advance(3.3);
    r.session.setSync(true);
    const knots = r.engine.port.maps.B;
    const locked =
      knots[
        knots.length > 2 ? knots.findIndex((k, i) => i > 0 && Math.abs(k.r - 0.96) < 1e-6) : 1
      ]!;
    // at that knot B is on one of its beats (0.5 + n × 0.48)
    const beats = (locked.p - 0.5) / 0.48;
    expect(Math.abs(beats - Math.round(beats))).toBeLessThan(1e-6);
    expect(r.session.snapshot().rateB).toBeCloseTo(0.96, 4);
  });
});

describe('Back (413)', () => {
  it('mid-blend the fader goes to A over one bar, then A is back on its element', async () => {
    await cued();
    r.session.setCentre('xf', 70);
    r.session.playB();
    await r.advance(2.5);
    const done = vi.fn();
    const t = r.engine.port.time + 0.03;
    r.session.backOverBar(done);
    expect(r.session.snapshot().phase).toBe('backing');
    // one bar of A: 2 s
    expect(r.engine.value('A.xf', t + 1)).toBeLessThan(1);
    expect(r.engine.value('A.xf', t + 2)).toBeCloseTo(1, 5);
    expect(r.engine.value('B.xf', t + 2)).toBeCloseTo(0, 5);
    expect(r.el.muted).toBe(true);
    await r.advance(2.1);
    expect(done).toHaveBeenCalledTimes(1);
    // the element unmuted and fading in, the decks fading out and stopped
    expect(r.el.muted).toBe(false);
    await r.advance(FADE_S + 0.02);
    expect(r.el.volume).toBeCloseTo(0.7);
    expect(r.engine.port.stops.A).toBeLessThan(Infinity);
    expect(r.engine.port.stops.B).toBeLessThan(Infinity);
    expect(r.session.snapshot().phase).toBe('idle');
    expect(r.said).toContain('Bringing Night Ferry back over a bar');
  });

  it('with B not started it is at once', async () => {
    await cued();
    const done = vi.fn();
    r.session.backOverBar(done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(r.session.snapshot().phase).toBe('idle');
  });
});

describe('the hard stops: never silent, never "playing" while silent', () => {
  for (const [event, words] of [
    ['seeking', 'The blend stopped: Night Ferry moved'],
    ['ended', 'Night Ferry ended: the blend stopped'],
    ['loadstart', 'The blend stopped'],
  ] as const) {
    it(`${event}: the decks out over 40 ms, the element unmuted at its level`, async () => {
      await cued();
      r.session.playB();
      await r.advance(1);
      expect(r.el.muted).toBe(true);
      if (event === 'ended') r.el.ended = true;
      r.el.dispatchEvent(new Event(event));
      expect(r.el.muted).toBe(false);
      expect(r.el.volume).toBeCloseTo(0.7);
      const t = r.engine.port.time;
      expect(r.engine.master.browser.valueAt(t + 0.05)).toBe(0);
      expect(r.engine.port.stops.A / 48000).toBeLessThan(t + 0.1);
      expect(r.session.snapshot().aOnDeck).toBe(false);
      expect(r.session.blending).toBe(false);
      expect(r.said.at(-1)).toBe(words);
    });
  }

  it('the player’s Pause pauses both (the context), Play carries on', async () => {
    await cued();
    r.session.playB();
    await r.advance(1);
    r.el.paused = true;
    r.el.dispatchEvent(new Event('pause'));
    expect(r.engine.suspended).toBe(1);
    expect(r.engine.paused).toEqual([true]);
    r.el.paused = false;
    r.el.dispatchEvent(new Event('play'));
    await r.advance(0.01);
    expect(r.engine.resumed).toBe(1);
    expect(r.engine.paused).toEqual([true, false]);
    expect(r.session.blending).toBe(true);
  });

  it('the decks follow the player’s volume', async () => {
    await cued();
    r.session.playB();
    await r.advance(0.5);
    r.player.volume = 40;
    r.el.dispatchEvent(new Event('volumechange'));
    expect(r.engine.master.browser.valueAt(r.engine.port.time + 0.06)).toBeCloseTo(0.4);
  });

  it('a bar before B’s 3 minutes run out the fader comes back to A by itself (424)', async () => {
    r.session.dispose();
    r = rig(vi, {
      fetchWindow: async (_c, id, start, dur) => ({
        channels: [],
        mono4: new Float32Array(0),
        sampleRate: 48000,
        offset: start,
        // B's window is short here: 4 s
        duration: id === '8' ? 4 : dur,
      }),
    });
    await cued();
    r.session.setCentre('xf', 100);
    r.session.playB();
    await r.advance(4);
    expect(r.session.snapshot().phase).toBe('backing');
    expect(r.said.at(-1)).toBe('The decks’ 3 minutes are up: back to Night Ferry');
    await r.advance(2.5);
    expect(r.el.muted).toBe(false);
    expect(r.session.snapshot().aOnDeck).toBe(false);
    // B stays loaded and cued for another go
    await r.advance(0.05);
    expect(r.session.snapshot().phase).toBe('ready');
  });

  it('closing (end) mid-blend is the hard stop and lets the windows go', async () => {
    await cued();
    r.session.playB();
    await r.advance(1);
    r.session.end();
    expect(r.el.muted).toBe(false);
    expect(r.el.volume).toBeCloseTo(0.7);
    await r.advance(0.3);
    expect(r.engine.unloads.sort()).toEqual(['A', 'B']);
    expect(r.session.snapshot()).toMatchObject({ phase: 'idle', aOnDeck: false, window: null });
  });
});
