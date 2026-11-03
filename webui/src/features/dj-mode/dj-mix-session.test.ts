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
import { constantWindow, laneA, laneB, rig, WorkletEngine, type Rig } from './dj-mix.fixtures';
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
    // Key lock is on by default (440): B is time-stretched, the same samples at its own speed
    expect(r.engine.port.modes.B).toBe('stretch');
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
    const autoHold = vi.fn();
    r.session.dispose();
    r = rig(vi, { autoHold });
    await cued();
    r.el.paused = true;
    expect(r.session.playB()).toBe(false);
    expect(r.said).toEqual(['Play Night Ferry first: B comes in on its beat']);
    r.el.paused = false;
    r.session.playB();
    expect(autoHold).toHaveBeenCalledTimes(1);
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
    // B's whole map is replaced from frame 0 (review H3): its first knot is the restart
    const first = r.engine.port.maps.B[0]!;
    expect(first.f / 48000).toBeGreaterThan(r.engine.port.time);
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

  it('on again: B lands on its nearest bar at A’s next bar and stays locked (review L7)', async () => {
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
    // at that knot B is on one of its bars (0.5 + n × 1.92), not just a beat
    const bars = (locked.p - 0.5) / 1.92;
    expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-6);
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

describe('review round 1', () => {
  it('H1: auto-mix is held while A is on DJ mode’s deck, and let go after', async () => {
    const autoHold = vi.fn();
    r.session.dispose();
    r = rig(vi, { autoHold });
    await cued();
    expect(autoHold).not.toHaveBeenCalled();
    r.session.playB();
    expect(autoHold.mock.calls).toEqual([[true]]);
    await r.advance(2.5);
    r.session.backOverBar(() => undefined);
    await r.advance(2.3);
    // held throughout (said again while A is on its deck, re-review N3), let go once at the end
    const calls = autoHold.mock.calls.map(([on]) => on);
    expect(calls.at(-1)).toBe(false);
    expect(calls.slice(0, -1).every((on) => on === true)).toBe(true);
    expect(calls.filter((on) => on === false)).toHaveLength(1);
  });

  it('H2: the context stopping under the decks is the hard stop at once', async () => {
    await cued();
    r.session.playB();
    await r.advance(1);
    expect(r.el.muted).toBe(true);
    r.engine.interrupt('interrupted');
    expect(r.el.muted).toBe(false);
    expect(r.el.volume).toBeCloseTo(0.7);
    expect(r.session.snapshot().aOnDeck).toBe(false);
    expect(r.said.at(-1)).toBe(
      'The decks stopped (interrupted): Night Ferry is back on the player',
    );
  });

  it('H2: a worklet error ends the blend and lets the engine go', async () => {
    await cued();
    r.session.playB();
    await r.advance(1);
    r.engine.node.onprocessorerror!(new Event('processorerror'));
    expect(r.el.muted).toBe(false);
    expect(r.engine.disposed).toBe(1);
    expect(r.engine.listening).toBe(0);
    expect(r.said.at(-1)).toBe('The decks failed: the blend stopped');
  });

  it('H2: Play B on a suspended context resumes it first, or says it can’t', async () => {
    await cued();
    r.engine.state = 'suspended';
    expect(r.session.playB()).toBe(true);
    expect(r.engine.port.maps.A).toEqual([]);
    await r.advance(0.01);
    expect(r.engine.resumed).toBe(1);
    expect(r.session.snapshot().aOnDeck).toBe(true);
    r.session.end();
    await r.advance(0.3);
    r.session.setLanes(laneA(), laneB());
    await r.advance(0.01);
    r.engine.state = 'suspended';
    const resume = r.engine.context as unknown as { resume: () => Promise<void> };
    resume.resume = async () => undefined; // the browser won't
    r.session.playB();
    await r.advance(0.01);
    expect(r.session.snapshot().aOnDeck).toBe(false);
    expect(r.said.at(-1)).toBe('The browser has stopped the audio: press Play B again');
  });

  it('H3 (on the real worklet): B is silent from a pause until it comes back in on the bar', async () => {
    r.session.dispose();
    r = rig(vi, {}, { worklet: true });
    const w = r.engine as WorkletEngine;
    await cued();
    r.session.playB();
    await r.advance(1.5);
    expect(w.peaks().B).toBe(0); // before A's next bar
    await r.advance(2);
    expect(w.peaks().B).toBeGreaterThan(0.4); // B in
    r.session.pauseB();
    await r.advance(0.1);
    w.peaks();
    await r.advance(2);
    expect(w.peaks().B).toBe(0); // paused
    r.session.playB();
    const Tb = r.engine.port.maps.B[0]!.f / 48000;
    await r.advance(Tb - r.engine.port.time - 0.01);
    // between the press and the bar: nothing of the old place, no click
    expect(w.peaks().B).toBe(0);
    await r.advance(0.5);
    expect(w.peaks().B).toBeGreaterThan(0.4);
  });

  it('H3 (on the real worklet): Play B again after a seek starts silent until its bar', async () => {
    r.session.dispose();
    r = rig(vi, {}, { worklet: true });
    const w = r.engine as WorkletEngine;
    await cued();
    r.session.playB();
    await r.advance(3);
    r.el.dispatchEvent(new Event('seeking')); // the hard stop
    await r.advance(0.2);
    expect(r.session.snapshot().phase).toBe('ready');
    w.peaks();
    r.session.playB();
    // A's window is fetched again first (review M3), then the decks start
    await r.advance(0.01);
    expect(r.session.snapshot().aOnDeck).toBe(true);
    const Tb = r.engine.port.maps.B[0]!.f / 48000;
    expect(Tb).toBeGreaterThan(r.engine.port.time);
    await r.advance(Tb - r.engine.port.time - 0.01);
    expect(w.peaks().B).toBe(0);
    await r.advance(0.5);
    expect(w.peaks().B).toBeGreaterThan(0.4);
  });

  it('M1: a new B while B is paused stops the decks and cues the new one', async () => {
    await cued();
    r.session.playB();
    await r.advance(3);
    r.session.pauseB();
    r.session.setLanes(laneA(), laneB({ id: '9', title: 'Copper Sky', cue: 4 }));
    expect(r.el.muted).toBe(false);
    expect(r.session.snapshot().aOnDeck).toBe(false);
    await r.advance(0.01);
    expect(r.windows.at(-2)).toEqual({ id: '9', start: 3.5, dur: 180 });
    expect(r.session.snapshot().phase).toBe('ready');
  });

  it('M2: Sync changed while B is starting starts it again on the same bar', async () => {
    await cued();
    r.session.playB();
    const Tb = r.engine.port.maps.B[0]!.f;
    expect(r.engine.port.maps.B[0]!.r).toBeCloseTo(0.96);
    expect(r.session.setSync(false)).toBe(true);
    expect(r.engine.port.maps.B).toEqual([{ f: Tb, p: 0.5, r: 1 }]);
    expect(r.engine.port.modes.B).toBe('stretch');
    await r.advance(2.2);
    // said once, as it is now
    expect(r.said.filter((w) => w.includes('playing'))).toEqual([
      'Harbour Lights playing: blend by ear',
    ]);
  });

  it('M3: at Play B, A’s window is fetched again unless it holds two minutes of A', async () => {
    r.session.setLanes(laneA({ duration: 600 }), laneB());
    await r.advance(0.01);
    r.el.currentTime = 230; // the player jumped: 70 s of A's window left
    const before = r.windows.length;
    r.session.playB();
    await r.advance(0.01);
    expect(r.windows.length).toBe(before + 1);
    expect(r.windows.at(-1)!.start).toBeGreaterThan(229);
    expect(r.session.snapshot().aOnDeck).toBe(true);
  });

  it('M4: when B goes the engine is disposed; a new B makes it again', async () => {
    const engine = vi.fn(async () => r.engine as never);
    r.session.dispose();
    r = rig(vi, {});
    r.session.dispose();
    const made = rig(vi, { engine });
    r = made;
    await cued();
    expect(r.engine.listening).toBe(1);
    r.session.setLanes(laneA(), null);
    await r.advance(0.3);
    expect(r.engine.disposed).toBe(1);
    expect(r.engine.listening).toBe(0);
    r.session.setLanes(laneA(), laneB());
    await r.advance(0.01);
    expect(engine).toHaveBeenCalledTimes(2);
  });

  it('M5: a failure while taking over is the hard stop, not a half-made blend', async () => {
    await cued();
    const map = r.engine.map.bind(r.engine);
    r.engine.map = () => {
      throw new Error('boom');
    };
    r.session.playB();
    r.engine.map = map;
    expect(r.el.muted).toBe(false);
    expect(r.session.snapshot().aOnDeck).toBe(false);
    expect(r.said.at(-1)).toBe('The blend stopped: the decks couldn’t start');
  });

  it('L1: the fader starts back with a bar and a margin left (a late timer still fits)', async () => {
    r.session.dispose();
    r = rig(vi, {
      fetchWindow: async (_c, id, start, dur) => ({
        channels: [],
        mono4: new Float32Array(0),
        sampleRate: 48000,
        offset: start,
        duration: id === '8' ? 8 : dur,
      }),
    });
    await cued();
    r.session.playB();
    while (r.session.snapshot().phase !== 'backing') await r.advance(0.05);
    const left = (8 - r.engine.position('B')!) / 0.96;
    // one bar of A is 2 s: a second and more to spare
    expect(left).toBeGreaterThan(3);
  });

  it('L2: a lane changing aborts the windows still on their way', async () => {
    const signals: AbortSignal[] = [];
    r.session.dispose();
    r = rig(vi, {
      fetchWindow: (_c, _id, start, dur, signal) => {
        signals.push(signal!);
        return new Promise((res) => setTimeout(() => res(constantWindow(start, dur, 0.1)), 500));
      },
    });
    r.session.setLanes(laneA(), laneB());
    await r.advance(0.01);
    r.session.setLanes(laneA(), laneB({ id: '9', title: 'Copper Sky' }));
    expect(signals[0]!.aborted).toBe(true);
    r.session.end();
    expect(signals.at(-1)!.aborted).toBe(true);
  });
});

describe('review round 2', () => {
  it('N1: B’s grid landing mid-blend doesn’t stop it; B plays on by ear until Sync is pressed', async () => {
    r.session.setLanes(laneA(), laneB({ grid: null, cue: 0, analysing: true }));
    await r.advance(0.01);
    r.session.playB();
    await r.advance(3);
    expect(r.session.snapshot().phase).toBe('playing');
    expect(r.session.snapshot().rateB).toBeNull();
    const map = r.engine.port.maps.B;
    // the grid lands, and with it the cue moves to the mix-in
    r.session.setLanes(laneA(), laneB({ cue: 4.34 }));
    expect(r.session.snapshot()).toMatchObject({
      phase: 'playing',
      aOnDeck: true,
      sync: false,
      syncable: true,
    });
    expect(r.el.muted).toBe(true);
    expect(r.engine.port.maps.B).toBe(map);
    expect(r.said.at(-1)).toBe('Harbour Lights has its beat grid now: Sync locks it to the beat');
    // a press locks it onto A's beat
    r.session.setSync(true);
    expect(r.session.snapshot().rateB).toBeCloseTo(0.96, 3);
    // after the blend B is cued again at its new mix-in
    r.session.backOverBar(null);
    await r.advance(2.5);
    expect(r.windows.some((w) => w.id === '8' && Math.abs(w.start - 3.84) < 1e-6)).toBe(true);
  });

  it('R1: B’s cue moved mid-blend, then A ends: B’s window comes from the new mix-in next time', async () => {
    r.session.setLanes(laneA(), laneB({ grid: null, cue: 0, analysing: true }));
    await r.advance(0.01);
    r.session.playB();
    await r.advance(3);
    // the grid lands mid-blend and the cue moves to the mix-in
    r.session.setLanes(laneA(), laneB({ cue: 4.34 }));
    r.el.ended = true;
    r.el.dispatchEvent(new Event('ended'));
    expect(r.session.snapshot().aOnDeck).toBe(false);
    r.windows.length = 0;
    // the next A arrives with the same B
    r.el.ended = false;
    r.session.setLanes(laneA({ id: '5', title: 'Next One' }), laneB({ cue: 4.34 }));
    await r.advance(0.5);
    expect(r.windows.some((w) => w.id === '8' && Math.abs(w.start - 3.84) < 1e-6)).toBe(true);
  });

  it('N2: a blend ended while paused says nothing false and stops once', async () => {
    await cued();
    r.session.playB();
    await r.advance(1);
    r.el.paused = true;
    r.el.dispatchEvent(new Event('pause'));
    expect(r.engine.state).toBe('suspended');
    r.said.length = 0;
    r.session.end();
    await r.advance(0.05);
    expect(r.said).toEqual([]);
    expect(r.engine.resumed).toBe(1);
    expect(r.engine.paused).toEqual([true, false]);
  });

  it('N3: the hold is said again while A is on its deck, so an auto-mix made mid-blend hears it', async () => {
    const autoHold = vi.fn();
    r.session.dispose();
    r = rig(vi, { autoHold });
    await cued();
    r.session.playB();
    await r.advance(1);
    expect(autoHold.mock.calls.length).toBeGreaterThan(2);
    expect(autoHold.mock.calls.every(([on]) => on === true)).toBe(true);
  });

  it('N4: while B waits A’s window keeps two minutes ahead, so Play B doesn’t wait on a fetch', async () => {
    r.session.setLanes(laneA({ duration: 600 }), laneB());
    await r.advance(0.01);
    r.el.currentTime = 186; // 114.5 s of A's window left: under two minutes
    await r.advance(2.1);
    const fetched = r.windows.length;
    expect(r.windows.at(-1)!.start).toBeGreaterThan(185);
    r.session.playB();
    expect(r.session.snapshot().aOnDeck).toBe(true);
    expect(r.windows.length).toBe(fetched);
  });
});

describe('3b: Tempo, Key lock, Headphones, cue jumps (438–443)', () => {
  it('A’s tempo on its deck: deck A and the element under it at the new speed, B kept on A’s beat', async () => {
    await cued();
    r.session.playB();
    await r.advance(3);
    const t = r.engine.port.time + 0.03;
    const posA = r.engine.position('A', t)!;
    r.session.setDeck('A', 'tempo', 2);
    expect(r.engine.port.rate('A', t + 0.5)).toBeCloseTo(1.02, 4);
    // no jump: where A was, it is
    expect(r.engine.position('A', t)).toBeCloseTo(posA, 4);
    expect(r.el.playbackRate).toBeCloseTo(1.02);
    // Key lock on: time-stretched, the key held
    expect(r.engine.port.modes.A).toBe('stretch');
    // B follows: 0.96 × 1.02
    expect(r.engine.port.rate('B', t + 0.6)).toBeCloseTo(0.96 * 1.02, 3);
    // back on its element A is at its own tempo (413), and its fader at 0
    r.session.backOverBar(null);
    await r.advance(2.5);
    expect(r.el.playbackRate).toBe(1);
    expect(r.session.snapshot().values.A.tempo).toBe(0);
  });

  it('M1: an element whose rate is snapped to a speed preset: A’s place is deck A’s, and Back puts the element there', async () => {
    // the element as the player's speed control used to leave it: 1.05 snapped to 1
    let rate = 1;
    Object.defineProperty(r.el, 'playbackRate', {
      configurable: true,
      get: () => rate,
      set: (v: number) => {
        const presets = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
        rate = presets.reduce((b, p) => (Math.abs(p - v) < Math.abs(b - v) ? p : b), presets[0]!);
      },
    });
    await cued();
    r.session.playB();
    await r.advance(3);
    r.session.setDeck('A', 'tempo', 5);
    await r.advance(10);
    // the element ran at 1×, deck A at 1.05×: half a second apart
    const deckA = r.engine.position('A')!;
    expect(Math.abs(r.el.currentTime - deckA)).toBeGreaterThan(0.4);
    // lane A, the cues and zoom read deck A itself
    expect(r.session.positionA()).toBeCloseTo(deckA, 6);
    // Back: the element put where deck A is before it's heard again, and
    // that's the session's own seek, not a person's (no hard stop)
    const seeks: { el: number; deck: number }[] = [];
    r.el.addEventListener('seeking', () =>
      seeks.push({ el: r.el.currentTime, deck: r.engine.position('A')! }),
    );
    r.session.backOverBar(null);
    await r.advance(2.5);
    expect(seeks).toHaveLength(1);
    expect(seeks[0]!.el).toBeCloseTo(seeks[0]!.deck, 3);
    expect(r.said.some((w) => w.includes('moved'))).toBe(false);
    expect(r.el.muted).toBe(false);
    expect(r.session.snapshot().aOnDeck).toBe(false);
    expect(r.session.positionA()).toBeNull();
    expect(rate).toBe(1);
  });

  it('M1: a person’s seek mid-blend still hard-stops, and the element isn’t put back', async () => {
    await cued();
    r.session.playB();
    await r.advance(3);
    r.session.setDeck('A', 'tempo', 5);
    await r.advance(5);
    r.el.currentTime = 40;
    expect(r.session.snapshot().aOnDeck).toBe(false);
    expect(r.el.currentTime).toBe(40);
    expect(r.el.muted).toBe(false);
  });

  it('L2: while B is starting both Tempos wait (nothing moves, Sync stays on)', async () => {
    await cued();
    r.session.playB();
    expect(r.session.snapshot().phase).toBe('starting');
    r.session.setDeck('B', 'tempo', 2);
    r.session.setDeck('A', 'tempo', 2);
    expect(r.session.snapshot().sync).toBe(true);
    expect(r.session.snapshot().values.A.tempo).toBe(0);
    expect(r.session.snapshot().values.B.tempo).toBe(0);
    expect(r.said.some((w) => w.startsWith('Sync off'))).toBe(false);
  });

  it('L3: A stays time-stretched once it has left its speed, through Tempo 0', async () => {
    await cued();
    r.session.playB();
    await r.advance(3);
    expect(r.engine.port.modes.A).toBe('resample');
    r.session.setDeck('A', 'tempo', 1);
    expect(r.engine.port.modes.A).toBe('stretch');
    r.session.setDeck('A', 'tempo', 0);
    expect(r.engine.port.modes.A).toBe('stretch');
    r.session.setDeck('A', 'tempo', -1);
    expect(r.engine.port.modes.A).toBe('stretch');
  });

  it('B’s tempo is set by Sync; moving it turns Sync off and moves B on its own', async () => {
    await cued();
    r.session.playB();
    await r.advance(3);
    r.session.setDeck('B', 'tempo', -1.6);
    expect(r.session.snapshot().sync).toBe(false);
    expect(r.said.at(-1)).toBe('Sync off: Harbour Lights at −1.6%');
    const t = r.engine.port.time + 0.5;
    expect(r.engine.port.rate('B', t)).toBeCloseTo(0.984, 4);
    expect(r.session.snapshot().rateB).toBeNull();
  });

  it('the range clamps Tempo (±6/8/10/16) and says so', async () => {
    await cued();
    r.session.setDeck('B', 'tempo', 12);
    expect(r.session.snapshot().values.B.tempo).toBe(8);
    r.session.setRange('B', 16);
    r.session.setDeck('B', 'tempo', 12);
    expect(r.session.snapshot().values.B.tempo).toBe(12);
    r.session.setRange('B', 6);
    expect(r.session.snapshot().values.B.tempo).toBe(6);
    expect(r.said).toContain('Deck B tempo range ±6%');
  });

  it('Key lock off is varispeed (the engine’s resample): the pitch moves with the tempo', async () => {
    await cued();
    r.session.setKeyLock('B', false);
    r.session.playB();
    expect(r.engine.port.modes.B).toBe('resample');
    r.session.setKeyLock('B', true);
    expect(r.engine.port.modes.B).toBe('stretch');
    expect(r.said.slice(-2)).toEqual([
      'Deck B key lock off: the pitch moves with the tempo',
      'Deck B key lock on',
    ]);
  });

  it('Headphones: each deck’s cue send; B in them from the start (443)', async () => {
    await cued();
    expect(r.engine.cueSends.B.gain.value).toBe(1);
    expect(r.engine.cueSends.A.gain.value).toBe(0);
    r.session.setPhones('A', true);
    r.session.setPhones('B', false);
    expect(r.engine.cueSends.A.gain.value).toBe(1);
    expect(r.engine.cueSends.B.gain.value).toBe(0);
    expect(r.said.slice(-2)).toEqual(['Deck A in the headphones', 'Deck B out of the headphones']);
  });

  it('a cue on A while A is on its element is the player’s own seek', async () => {
    const seek = vi.fn();
    r.session.dispose();
    r = rig(vi, {
      player: { audio: () => r.el as never, state: () => r.player, seek },
    });
    await cued();
    expect(r.session.jump('A', 60)).toBe('seek');
    expect(seek).toHaveBeenCalledWith(60);
  });

  it('a cue on A on its deck jumps deck A and the element together: not a seek that ends the blend', async () => {
    await cued();
    r.session.playB();
    await r.advance(3);
    expect(r.session.jump('A', 150)).toBe('jumped');
    await r.advance(0.05);
    expect(r.session.snapshot()).toMatchObject({ aOnDeck: true, phase: 'playing' });
    expect(r.el.currentTime).toBeCloseTo(150.05, 1);
    expect(r.engine.position('A')).toBeCloseTo(150.05, 1);
    expect(r.el.muted).toBe(true);
    // outside A's window: said, nothing moves
    expect(r.session.jump('A', 10)).toBe('outside');
  });

  it('a cue on B: cued, Play B starts there (the store moves the cue); playing, B comes in from it on the bar', async () => {
    await cued();
    expect(r.session.jump('B', 33)).toBe('cue');
    r.session.playB();
    await r.advance(3);
    expect(r.session.jump('B', 9.14)).toBe('jumped');
    expect(r.engine.port.maps.B[0]!.p).toBeCloseTo(9.14, 2);
    expect(r.session.jump('B', 500)).toBe('outside');
  });
});

describe('3b on the real worklet: a tempo move carries on where it is', () => {
  it('deck A keeps sounding through a tempo change (no gap), B too', async () => {
    r.session.dispose();
    r = rig(vi, {}, { worklet: true });
    const w = r.engine as WorkletEngine;
    await cued();
    r.session.playB();
    await r.advance(3);
    w.peaks();
    r.session.setDeck('A', 'tempo', 4);
    for (let i = 0; i < 10; i++) {
      await r.advance(0.05);
      const p = w.peaks();
      expect(p.A).toBeGreaterThan(0.4);
      expect(p.B).toBeGreaterThan(0.4);
    }
  });
});
