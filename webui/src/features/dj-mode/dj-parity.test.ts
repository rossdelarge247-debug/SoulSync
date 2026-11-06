/**
 * DJ mode step 5 (Traktor/CDJ parity) on the fake engine and element:
 *
 * - M6: before Play B, deck A's channel, the crossfader and the echo act on
 *   the playing track through the element strip (live), and its Headphones;
 * - M4/M5: the playing track's level and tone are the same on the element
 *   and on deck A at every switch (Play B, Back, Hand over, Undo): the strip
 *   and deck A carry the same values, and the element and the decks'
 *   master cross over as one;
 * - Hand over: B's channel flat over the bar, the element strip flat at full
 *   while the player takes B, deck A silent for the Undo;
 * - M7: Play B while B plays in the headphones takes B from where it is;
 * - S6: Auto-gain's trim on B, flat at Hand over;
 * - S1/M2: Tempo to a hundredth, A's speed in the view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParamName } from '@/features/engine/score';

import { KILL_DB } from '@/features/engine/score';

import type { HandoffLike, SessionDeps } from './dj-mix-session';

import { AHEAD_S, FADE_S } from './dj-mix-session';
import { laneA, laneB, rig, type Rig } from './dj-mix.fixtures';
import { volumeGain, xfGains } from './dj-mixer.logic';

let r: Rig;

/** A player that takes B (Hand over) and A back (Undo), as dj-handover.test.ts's. */
function playerDeps(): Partial<SessionDeps> {
  const q = {
    queue: [
      { id: '2', title: 'Night Ferry', file_path: '/m/2.flac' },
      { id: '5', title: 'Static Bloom', file_path: '/m/5.flac' },
    ] as { id: string; title: string; file_path?: string }[],
    index: 0,
  };
  return {
    player: {
      audio: () => r.el as never,
      state: () => ({ ...r.player, index: q.index, queue: q.queue }),
      seek: () => undefined,
      insertNext: (t) => {
        q.queue.splice(q.index + 1, 0, t as never);
        return q.index + 1;
      },
      moveNext: (i) => i,
      remove: (i) => {
        q.queue.splice(i, 1);
      },
      playIndex: async (index, options) => {
        const handoff: HandoffLike | null = options.handoff ?? null;
        r.el.pause();
        r.el.dispatchEvent(new Event('emptied'));
        r.el.dispatchEvent(new Event('loadstart'));
        await new Promise((res) => setTimeout(res, 200));
        q.index = index;
        if (handoff) r.el.currentTime = handoff.currentTime + 0.15;
        r.el.paused = false;
        r.el.ended = false;
        handoff?.pause();
        return { status: 'played' };
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  r = rig(vi, playerDeps());
});

afterEach(() => {
  r.session.dispose();
  vi.useRealTimers();
});

const HARBOUR = { id: '8', title: 'Harbour Lights', file_path: '/m/8.flac' };

async function cued(over: Parameters<typeof laneB>[0] = {}): Promise<void> {
  r.session.setLanes(laneA(), laneB({ queue: HARBOUR, ...over }));
  await r.advance(0.01);
  expect(r.session.snapshot().phase).toBe('ready');
}

const CHANNEL: ParamName[] = ['trim', 'volume', 'xf', 'low', 'mid', 'high', 'hp', 'lp', 'echoSend'];

/** The element strip and deck A carry the same channel at t. */
function sameChannel(t = r.engine.port.time): void {
  for (const name of CHANNEL)
    expect(r.engine.elementValue(name, t)).toBeCloseTo(r.engine.value(`A.${name}`, t), 6);
}

/**
 * The playing track's level as the room hears it at t (the same channel on
 * both ways, so the channel's gain is common): the element's volume (0 when
 * muted) through the strip, plus deck A through the decks' master.
 */
function trackLevel(t = r.engine.port.time): number {
  const el = r.el.muted || r.el.paused ? 0 : r.el.volume;
  const strip = r.engine.elementValue('volume', t) * r.engine.elementValue('xf', t);
  const deckOn = (r.engine.port.stops.A ?? Infinity) / 48000 > t && r.engine.port.maps.A.length > 0;
  const deck = deckOn
    ? r.engine.master.browser.valueAt(t) * r.engine.value('A.volume', t) * r.engine.value('A.xf', t)
    : 0;
  return el * strip + deck;
}

describe('M6: deck A’s channel acts on the playing track before Play B', () => {
  it('the element plays through the strip, which takes deck A’s values as they move', async () => {
    await cued();
    const v = r.session.snapshot();
    expect(v.elementLive).toBe(true);
    expect(v.aOnDeck).toBe(false);
    r.session.setDeck('A', 'volume', 80);
    r.session.setKill('A', 'low', true);
    r.session.setDeck('A', 'filter', -40);
    r.session.setCentre('xf', 30);
    r.session.setCentre('echoSend', 50);
    await r.advance(0.05);
    expect(r.engine.elementValue('volume')).toBeCloseTo(volumeGain(80), 6);
    expect(r.engine.elementValue('low')).toBe(KILL_DB);
    expect(r.engine.elementValue('lp')).toBeLessThan(5000);
    expect(r.engine.elementValue('xf')).toBeCloseTo(xfGains(30).A, 6);
    expect(r.engine.elementValue('echoSend')).toBeCloseTo(0.5, 6);
    // deck A (not playing yet) carries the same values, ready for Play B
    sameChannel();
    // deck A doesn't play before Play B: the element is the playing track
    expect(r.engine.port.maps.A).toEqual([]);
  });

  it('the crossfader at B before Play B is heard at once (a DJM’s), not first at Play B', async () => {
    await cued();
    r.session.setCentre('xf', 100);
    await r.advance(0.05);
    expect(r.engine.elementValue('xf')).toBe(0);
    expect(trackLevel()).toBe(0);
  });

  it('deck A’s Headphones hear the playing track before Play B', async () => {
    await cued();
    r.session.setPhones('A', true);
    expect(r.engine.elementCue.gain.value).toBe(1);
    r.session.setPhones('A', false);
    expect(r.engine.elementCue.gain.value).toBe(0);
  });
});

describe('M4/M5: no step in level or tone at Play B, Back, Hand over or Undo', () => {
  it('Play B with the channel moved first: the same level before, through and after the cross-over', async () => {
    await cued();
    r.session.setDeck('A', 'volume', 70);
    r.session.setKill('A', 'low', true);
    r.session.setCentre('xf', 40);
    await r.advance(0.05);
    const before = trackLevel();
    expect(before).toBeGreaterThan(0.2);
    r.session.playB();
    // the cross-over (the element's six steps against the master's ramp)
    let low = Infinity;
    let high = 0;
    for (let i = 0; i < 40; i++) {
      await r.advance(0.005);
      sameChannel();
      const l = trackLevel();
      low = Math.min(low, l);
      high = Math.max(high, l);
    }
    await r.advance(0.3);
    expect(r.session.snapshot().aOnDeck).toBe(true);
    expect(r.el.muted).toBe(true);
    // after: deck A alone, at the level the element had
    expect(trackLevel()).toBeCloseTo(before, 3);
    // through it, never a dead moment and never a jump (the element's steps
    // against a ramp: within 3 dB at the worst instant, as auto-mix's)
    expect(low / before).toBeGreaterThan(0.7);
    expect(high / before).toBeLessThan(1.42);
  });

  it('Back: A on its element again at the level it had on its deck, the channel as it was', async () => {
    await cued();
    r.session.setDeck('A', 'mid', -8);
    r.session.playB();
    await r.advance(3);
    expect(r.session.snapshot().phase).toBe('playing');
    const before = trackLevel();
    r.session.backOverBar(null);
    await r.advance(3);
    expect(r.session.snapshot().aOnDeck).toBe(false);
    expect(r.el.muted).toBe(false);
    expect(trackLevel()).toBeCloseTo(before, 3);
    expect(r.engine.elementValue('mid')).toBe(-8);
  });

  it('Hand over: B’s channel flat over the bar; the strip flat at full as the player takes B; deck A silent for the Undo', async () => {
    await cued();
    r.session.setDeck('B', 'low', -12);
    r.session.setDeck('B', 'volume', 60);
    r.session.setDeck('A', 'high', -10);
    r.session.playB();
    await r.advance(3);
    r.session.setCentre('xf', 50);
    expect(r.session.handOver('press')).toBe(true);
    // over the bar B's channel goes flat (it plays as it will on the player)
    await r.advance(1);
    expect(r.engine.elementValue('high')).toBe(0);
    expect(r.engine.elementValue('xf')).toBe(1);
    await r.advance(1.5);
    expect(r.engine.value('B.low')).toBeCloseTo(0, 6);
    expect(r.engine.value('B.volume')).toBeCloseTo(1, 6);
    expect(r.engine.value('B.trim')).toBeCloseTo(1, 6);
    await r.advance(1);
    const v = r.session.snapshot();
    expect(v.handed?.undo).toBe(true);
    expect(v.aOnDeck).toBe(false);
    // the crossfader on A's side as the lanes swap; the element (B now) heard, flat
    expect(v.values.xf).toBe(0);
    expect(r.engine.elementValue('xf')).toBe(1);
    expect(r.engine.elementValue('volume')).toBe(1);
    expect(r.el.muted).toBe(false);
    // deck A runs on silent for the Undo
    expect(r.engine.value('A.xf')).toBe(0);
    expect(r.engine.value('A.echoSend')).toBe(0);
    // a control moved now still leaves deck A silent
    r.session.setDeck('A', 'volume', 90);
    await r.advance(0.05);
    expect(r.engine.value('A.xf')).toBe(0);
  });

  it('Undo: deck A heard again, flat as the element is, then the player takes A', async () => {
    await cued();
    r.session.setDeck('A', 'low', -20);
    r.session.playB();
    await r.advance(3);
    r.session.handOver('press');
    await r.advance(3.5);
    expect(r.session.snapshot().handed?.undo).toBe(true);
    // the undo deck took the new (flat) channel while it ran silent
    expect(r.engine.value('A.low')).toBe(0);
    void r.session.undoHandOver();
    await r.advance(FADE_S + 0.02);
    expect(r.engine.value('A.xf')).toBeCloseTo(1, 6);
    sameChannel();
  });
});

describe('M7: Play B while B plays in the headphones', () => {
  it('with Sync, B carries on from where it is and glides onto A’s beat: no restart from its cue', async () => {
    await cued();
    r.session.previewB(true);
    await r.advance(1.3);
    const t = r.engine.port.time;
    const pB = r.engine.position('B', t)!;
    expect(pB).toBeGreaterThan(1.5);
    const jumps = r.engine.port.jumps.filter((j) => j.deck === 'B').length;
    r.session.playB();
    expect(r.session.snapshot().phase).toBe('starting');
    // no jump of B's map (a restart would be one), and B's place runs on
    expect(r.engine.port.jumps.filter((j) => j.deck === 'B').length).toBe(jumps);
    const soon = r.engine.position('B', t + 0.05)!;
    expect(soon).toBeGreaterThan(pB);
    expect(soon - pB).toBeLessThan(0.15);
    // the room doesn't hear B until A's bar
    expect(r.engine.value('B.xf', t + AHEAD_S + 0.05)).toBe(0);
    await r.advance(3);
    const v = r.session.snapshot();
    expect(v.phase).toBe('playing');
    expect(v.rateB).not.toBeNull();
    // locked: B's beats on A's from here (A at 120, B at 125 slowed 4%)
    const now = r.engine.port.time;
    const a = laneA().grid!;
    const b = laneB().grid!;
    const fa = a.beatAt(r.engine.position('A', now)!) % 1;
    const fb = b.beatAt(r.engine.position('B', now)!) % 1;
    const d = Math.abs(fa - fb);
    expect(Math.min(d, 1 - d)).toBeLessThan(0.02);
    expect(r.engine.port.rate('B', now)).toBeCloseTo(0.96, 2);
  });

  it('without Sync, B carries on at its own speed and comes in on A’s next beat', async () => {
    await cued();
    r.session.setSync(false);
    r.session.previewB(true);
    await r.advance(1);
    const t = r.engine.port.time;
    const pB = r.engine.position('B', t)!;
    r.session.playB();
    await r.advance(2);
    expect(r.session.snapshot().phase).toBe('playing');
    expect(r.session.snapshot().rateB).toBeNull();
    const now = r.engine.port.time;
    expect(r.engine.position('B', now)! - pB).toBeCloseTo(now - t, 2);
  });
});

describe('S6: Auto-gain', () => {
  it('B’s trim matches A’s analysed loudness (A untouched); off is 0 dB; Hand over takes it back to 0', async () => {
    r.session.setLanes(
      laneA({ loudness: { replaygain_db: null, level_db: -9 } }),
      laneB({ queue: HARBOUR, loudness: { replaygain_db: null, level_db: -13 } }),
    );
    await r.advance(0.05);
    expect(r.session.snapshot().gain).toEqual({ A: 0, B: 4 });
    expect(r.engine.value('B.trim')).toBeCloseTo(Math.pow(10, 4 / 20), 6);
    expect(r.engine.value('A.trim')).toBe(1);
    r.session.setAutoGain(false);
    await r.advance(0.05);
    expect(r.engine.value('B.trim')).toBeCloseTo(1, 6);
    r.session.setAutoGain(true);
    r.session.playB();
    await r.advance(3);
    r.session.handOver('press');
    await r.advance(2.2);
    expect(r.engine.value('B.trim')).toBeCloseTo(1, 6);
  });
});

describe('S1 and M2: Tempo to a hundredth, A’s speed in the view', () => {
  it('a 0.02% move is kept, and A’s rate shows once A is on its deck', async () => {
    await cued();
    r.session.playB();
    await r.advance(3);
    expect(r.session.snapshot().rateA).toBe(1);
    r.session.setTempo('A', 1.26);
    expect(r.session.snapshot().values.A.tempo).toBe(1.26);
    expect(r.session.snapshot().rateA).toBeCloseTo(1.0126, 6);
    r.session.setTempo('B', -0.02);
    expect(r.session.snapshot().values.B.tempo).toBe(-0.02);
  });
});

describe('review H1 and L3: the playing track at full after every release, wherever the crossfader was', () => {
  /** The element as the room hears it after a release: its volume through the strip, flat at A only. */
  function fullOnElement(): void {
    expect(r.el.muted).toBe(false);
    expect(r.engine.elementValue('xf')).toBeCloseTo(1, 6);
    expect(r.engine.elementValue('volume')).toBeCloseTo(1, 6);
    expect(trackLevel()).toBeCloseTo(r.el.volume, 6);
    expect(trackLevel()).toBeCloseTo(0.7, 6);
  }

  async function blendAt(xf: number): Promise<void> {
    await cued();
    r.session.playB();
    await r.advance(3);
    expect(r.session.snapshot().phase).toBe('playing');
    r.session.setCentre('xf', xf);
    await r.advance(0.05);
  }

  for (const xf of [100, 50]) {
    it(`Back with the fader at ${xf}`, async () => {
      await blendAt(xf);
      r.session.backOverBar(null);
      await r.advance(3);
      expect(r.session.snapshot().aOnDeck).toBe(false);
      fullOnElement();
    });

    it(`Next (another track) with the fader at ${xf}`, async () => {
      await blendAt(xf);
      r.session.setLanes(laneA({ id: '5', title: 'Static Bloom' }), laneB({ queue: HARBOUR }));
      await r.advance(0.1);
      expect(r.session.snapshot().aOnDeck).toBe(false);
      fullOnElement();
    });

    it(`a hard stop (a seek) with the fader at ${xf} (L3)`, async () => {
      await blendAt(xf);
      r.el.currentTime = 30;
      await r.advance(0.2);
      expect(r.session.snapshot().aOnDeck).toBe(false);
      expect(r.session.snapshot().values.xf).toBe(0);
      fullOnElement();
    });

    it(`B’s window running out with the fader at ${xf}`, async () => {
      r.session.dispose();
      r = rig(vi, {
        ...playerDeps(),
        fetchWindow: async (_c, id, start, dur) => ({
          channels: [],
          mono4: new Float32Array(0),
          sampleRate: 48000,
          offset: start,
          duration: id === '8' ? 6 : dur,
        }),
      });
      await blendAt(xf);
      await r.advance(5);
      expect(r.session.snapshot().aOnDeck).toBe(false);
      fullOnElement();
    });
  }

  it('B on its own (the fader at B) ending: the player’s next track at full', async () => {
    await cued();
    r.el.paused = true;
    r.el.ended = true;
    r.session.playB();
    await r.advance(0.5);
    expect(r.session.snapshot()).toMatchObject({ solo: true, phase: 'playing' });
    expect(r.engine.elementValue('xf')).toBe(0);
    // the player plays again (another track): B goes out over a bar
    r.el.paused = false;
    r.el.ended = false;
    r.el.dispatchEvent(new Event('play'));
    await r.advance(0.1);
    fullOnElement();
  });
});

describe('review L1: Play B from the preview catches up within 8% of Sync’s speed', () => {
  it('a B half a beat off A takes a later bar rather than a warble', async () => {
    await cued();
    r.session.previewB(true);
    // B a little way in: its beat phase against A's is wherever it is
    await r.advance(1.13);
    const t = r.engine.port.time;
    r.session.playB();
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      await r.advance(0.02);
      const now = r.engine.port.time;
      if (now < t + AHEAD_S + 0.03) continue;
      worst = Math.max(worst, Math.abs(r.engine.port.rate('B', now) / 0.96 - 1));
    }
    expect(r.session.snapshot().phase).toBe('playing');
    expect(worst).toBeLessThan(0.081);
  });
});
