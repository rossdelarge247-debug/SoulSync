/**
 * Auto-mix in real playback (stage C): the controller between the player's
 * element and the two-deck engine, run against a fake player and the real
 * executor on fake decks (engine/testing.ts), with the clock in the test's
 * hands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeckData } from '@/features/engine/engine';
import type { ApiGrid } from '@/features/engine/grid';

import { Transition, type TransitionInput } from '@/features/engine/executor';
import { BeatGrid } from '@/features/engine/grid';
import { FakePort } from '@/features/engine/testing';

import type { AutomixPrefs } from './prefs';

import {
  AutomixController,
  LEAD_BARS,
  PRELOAD_S,
  choiceOf,
  mixNowPlan,
  mixable,
  playedAsMix,
  type EngineLike,
  type PlayerPort,
  type PlayerSnapshotLike,
  type QueueTrack,
} from './controller';
import { AUTO_CHOICE, type PairPlan } from './plans';

const SR = 48000;
const GA = new BeatGrid({ period: 60 / 124, firstBeat: 0.5 });
const GB = new BeatGrid({ period: 60 / 126, firstBeat: 0.2 });
const OUT = GA.barTime(80);

function apiGrid(id: string, g: BeatGrid, rg: number): ApiGrid {
  const phrases = [];
  for (let bar = 0; bar < 140; bar += 8) phrases.push({ bar, time: g.barTime(bar), level: 8 });
  return {
    track_id: id,
    analyzed: true,
    bpm: 60 / g.period,
    grid: {
      kind: 'constant',
      first_beat: g.firstBeat,
      period: g.period,
      beats: null,
      confidence: 0.9,
    },
    downbeats: { first: g.firstBeat, beat_index: 0 },
    phrases,
    loudness: { replaygain_db: rg, level_db: -9, source: 'replaygain' },
    analysed_s: 300,
  };
}

function okPlan(over: Partial<PairPlan> = {}): PairPlan {
  return {
    status: 'ok',
    style: 'long_blend',
    label: 'Long blend',
    bars: 32,
    beatmatch: true,
    why: '8A → 9A, +2 BPM: the keys mix and the tempo is close',
    pair: '8A → 9A, +2 BPM',
    tempo: { relation: 'same', rate: 124 / 126, speed_change_ok: true, from_bpm: 124, to_bpm: 126 },
    key: { from: '8A', to: '9A', relation: 'up' },
    out: { start: OUT, bar: 80, end: GA.barTime(112), end_bar: 112 },
    in: { start: GB.barTime(0), bar: 0 },
    length_s: 61.9,
    styles: [],
    ...over,
  };
}

function deck(offset: number, seconds: number): DeckData {
  const n = Math.round(seconds * 1000);
  return {
    channels: [new Float32Array(n), new Float32Array(n)],
    mono4: new Float32Array(Math.floor(n / 4)),
    sampleRate: 1000,
    offset,
    duration: seconds,
  };
}

class FakeAudio extends EventTarget {
  private t = 0;
  duration = 300;
  paused = false;
  muted = false;
  volume = 0.7;
  playbackRate = 1;
  ended = false;
  get currentTime() {
    return this.t;
  }
  set currentTime(v: number) {
    this.t = v;
    this.dispatchEvent(new Event('seeking'));
    this.dispatchEvent(new Event('seeked'));
  }
  /** time passing, no seek */
  advance(to: number) {
    this.t = to;
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  async play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  }
}

function fakeGain() {
  return {
    value: 0,
    calls: [] as string[],
    cancelScheduledValues(t: number) {
      this.calls.push(`cancel@${t.toFixed(3)}`);
    },
    setValueAtTime(v: number, t: number) {
      this.calls.push(`set ${v}@${t.toFixed(3)}`);
    },
    linearRampToValueAtTime(v: number, t: number) {
      this.value = v;
      this.calls.push(`ramp ${v}@${t.toFixed(3)}`);
    },
  };
}

class FakeEngine implements EngineLike {
  readonly port = new FakePort(SR);
  readonly sampleRate = SR;
  readonly gain = fakeGain();
  readonly graph = { master: { gain: this.gain } as unknown as GainNode };
  readonly loaded: string[] = [];
  readonly unloaded: string[] = [];
  readonly plays: { deck: string; at: number; from: number }[] = [];
  readonly inputs: TransitionInput[] = [];
  paused: boolean[] = [];
  last: Transition | null = null;
  state = 'running';
  readonly context = {
    sampleRate: SR,
    get currentTime() {
      return engine.port.time;
    },
    get state() {
      return engine.state;
    },
    suspend: vi.fn(async () => {
      engine.state = 'suspended';
    }),
    resume: vi.fn(async () => {
      engine.state = 'running';
    }),
  } as unknown as BaseAudioContext;
  load(d: 'A' | 'B') {
    this.loaded.push(d);
  }
  unload(d: 'A' | 'B') {
    this.unloaded.push(d);
    this.port.maps[d] = [];
  }
  play(d: 'A' | 'B', at: number, from: number, rate = 1) {
    this.plays.push({ deck: d, at, from });
    this.port.stop(d, Infinity);
    this.port.map(d, at * SR, [{ f: at * SR, p: from, r: rate }], true);
  }
  stop(d: 'A' | 'B', f: number) {
    this.port.stop(d, f);
  }
  position(d: 'A' | 'B', at = this.port.time) {
    return this.port.position(d, at);
  }
  current(d: 'A' | 'B') {
    return this.port.current(d);
  }
  report() {
    return null;
  }
  mix(input: TransitionInput) {
    this.inputs.push(input);
    const t = new Transition(input, this.port);
    t.start();
    this.last = t;
    return t;
  }
  setPaused(on: boolean) {
    this.paused.push(on);
  }
}

let engine: FakeEngine;

interface Harness {
  ctl: AutomixController;
  el: FakeAudio;
  st: PlayerSnapshotLike;
  prefs: AutomixPrefs;
  player: PlayerPort & {
    playIndex: ReturnType<typeof vi.fn>;
    crossfadeInto: ReturnType<typeof vi.fn>;
    insertNext: ReturnType<typeof vi.fn>;
    moveNext: ReturnType<typeof vi.fn>;
  };
  plan: ReturnType<typeof vi.fn>;
  window: ReturnType<typeof vi.fn>;
  grids: ReturnType<typeof vi.fn>;
}

function track(id: string, title: string, extra: Partial<QueueTrack> = {}): QueueTrack {
  return { id, title, artist: 'Tidewater', file_path: `/m/${id}.flac`, is_library: true, ...extra };
}

function harness(
  opts: {
    plan?: PairPlan;
    prefs?: Partial<AutomixPrefs>;
    support?: string;
  } = {},
): Harness {
  engine = new FakeEngine();
  engine.port.time = 10;
  const el = new FakeAudio();
  const queue = [track('1', 'Night Ferry'), track('2', 'Static Bloom'), track('3', 'Brass Tide')];
  const st: PlayerSnapshotLike = {
    track: queue[0],
    kind: 'library',
    playing: true,
    queue,
    index: 0,
    shuffle: false,
    repeat: 'off',
    volume: 70,
    muted: false,
    crossfadeSeconds: 6,
  };
  const prefs: AutomixPrefs = { between: 'dj', auto: true, lean: 'auto', ...opts.prefs };
  const player = {
    state: () => st,
    audio: () => el as unknown as HTMLAudioElement,
    playIndex: vi.fn(async () => ({ status: 'played' })),
    crossfadeInto: vi.fn(() => true),
    insertNext: vi.fn((t: QueueTrack) => {
      queue.splice(st.index + 1, 0, t);
      return st.index + 1;
    }),
    // as the player's npMoveNext: a row from above takes the playing row's place
    moveNext: vi.fn((i: number) => {
      const [t] = queue.splice(i, 1);
      if (i < st.index) st.index -= 1;
      queue.splice(st.index + 1, 0, t);
      return queue.indexOf(t);
    }),
    renderQueue: vi.fn(),
  };
  const plan = vi.fn(async () => opts.plan ?? okPlan());
  // the incoming track is 2 dB louder (a more negative ReplayGain)
  const grids = vi.fn(async () => ({ '1': apiGrid('1', GA, -8), '2': apiGrid('2', GB, -10) }));
  const window = vi.fn(async (_ctx: unknown, id: string, start: number, dur: number) =>
    deck(start, Math.min(dur, 5)),
  );
  const ctl = new AutomixController(player, {
    plan,
    grids,
    window,
    engine: async () => engine,
    prefs: () => prefs,
    support: () => opts.support ?? null,
  });
  return { ctl, el, st, prefs, player, plan, grids, window };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
};

/** to `seconds` before the mix's start, with the context's clock moving alongside */
async function at(h: Harness, trackSeconds: number) {
  const moved = trackSeconds - h.el.currentTime;
  h.el.advance(trackSeconds);
  engine.port.time += Math.max(0, moved);
  h.ctl.poke();
  await flush();
  // the controller ticks every 120 ms: once more, with what just came in
  h.ctl.poke();
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the pair that’s next', () => {
  it('with DJ mix off nothing is planned, loaded or taken over', async () => {
    const h = harness({ prefs: { between: 'off' } });
    await at(h, OUT - 2);
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.window).not.toHaveBeenCalled();
    expect(h.ctl.getView().dj).toBe(false);
    expect(h.ctl.ownsAdvance()).toBe(false);
  });

  it('plans the pair with its chip and says when it starts (249: "in 2:58")', async () => {
    const h = harness();
    await at(h, 100);
    expect(h.plan).toHaveBeenCalledWith('1', '2', AUTO_CHOICE, 'auto');
    const v = h.ctl.getView();
    expect(v.dj).toBe(true);
    expect(v.pair?.toTitle).toBe('Static Bloom');
    expect(v.inSeconds).toBeCloseTo(OUT - 100, 3);
    expect(v.outStart).toBeCloseTo(OUT, 6);
    // more than 16 bars away: no countdown yet
    expect(v.barsToGo).toBeNull();
  });

  it('a podcast, a stream, shuffle or repeat one: no pair', async () => {
    for (const change of [
      (h: Harness) => (h.st.kind = 'podcast'),
      (h: Harness) => (h.st.shuffle = true),
      (h: Harness) => (h.st.repeat = 'one'),
      (h: Harness) => (h.st.queue[1] = { ...h.st.queue[1], file_path: '' }),
    ]) {
      const h = harness();
      change(h);
      await at(h, 100);
      expect(h.plan).not.toHaveBeenCalled();
    }
  });
});

describe('loading and taking over', () => {
  it('fetches both windows, one after the other, only within 45 s of the mix', async () => {
    const h = harness();
    await at(h, OUT - PRELOAD_S - 5);
    expect(h.window).not.toHaveBeenCalled();
    await at(h, OUT - PRELOAD_S + 1);
    expect(h.window.mock.calls.map((c) => c[1])).toEqual(['1', '2']);
    expect(h.ctl.getView().stage).toBe('ready');
  });

  it('two bars before the mix the decks take over where the element is, and mix on the phrase', async () => {
    const h = harness();
    await at(h, OUT - 40);
    const lead = Math.max(3, LEAD_BARS * 4 * GA.period);
    await at(h, OUT - lead + 0.2);
    expect(engine.loaded).toEqual(['A', 'B']);
    const play = engine.plays[0];
    expect(play.deck).toBe('A');
    // started 0.12 s ahead on the context's clock, where the element will be then
    expect(play.at).toBeCloseTo(engine.port.time + 0.12, 6);
    expect(play.from).toBeCloseTo(OUT - lead + 0.2 + 0.12, 6);
    const input = engine.inputs[0];
    expect(input.from).toBe('A');
    expect(input.to).toBe('B');
    // the outgoing deck reaches out.start at t0
    expect(input.t0 - play.at).toBeCloseTo(OUT - play.from, 6);
    expect(input.trimDb).toBeCloseTo(-2, 6);
    expect(h.ctl.ownsAdvance()).toBe(true);
    expect(h.ctl.getView().stage).toBe('counting');
    // the element fades out under deck A, then goes on muted
    await vi.advanceTimersByTimeAsync(400);
    expect(h.el.muted).toBe(true);
    expect(h.el.volume).toBeCloseTo(0.7, 6);
    expect(h.el.paused).toBe(false);
  });

  it('windows that didn’t come in time: the mix is missed and the track plays on (no crossfade)', async () => {
    const h = harness();
    h.window.mockImplementation(() => new Promise(() => undefined));
    await at(h, OUT - 40);
    await at(h, OUT - 0.1);
    expect(engine.plays).toHaveLength(0);
    expect(h.ctl.crossfade(h.st.queue[0], h.st.queue[1])).toBeNull();
    expect(h.player.crossfadeInto).not.toHaveBeenCalled();
    expect(h.player.playIndex).not.toHaveBeenCalled();
  });
});

async function intoTheMix(h: Harness) {
  await at(h, OUT - 40);
  const lead = Math.max(3, LEAD_BARS * 4 * GA.period);
  await at(h, OUT - lead + 0.2);
  await vi.advanceTimersByTimeAsync(400);
  const t0 = engine.inputs[0].t0;
  engine.port.time = t0 + 2;
  h.el.advance(OUT + 2);
  h.ctl.poke();
  await flush();
  return t0;
}

describe('a page that can’t run the decks (plain http on another address)', () => {
  it('nothing loads, Mix now isn’t offered, saying why, and the pair plays on', async () => {
    const why = 'Auto mix needs SYNCHRO.S on https';
    const h = harness({ support: why });
    await at(h, OUT - 30);
    expect(h.window).not.toHaveBeenCalled();
    const v = h.ctl.getView();
    expect(v.unsupported).toBe(why);
    expect(v.canMixNow).toBe(false);
    expect(v.mixNowWhy).toBe(why);
    expect(h.ctl.crossfade(h.st.queue[0], h.st.queue[1])).toBeNull();
    await at(h, 299);
    expect(h.player.crossfadeInto).not.toHaveBeenCalled();
    expect(h.player.playIndex).not.toHaveBeenCalled();
  });
});

describe('while it mixes', () => {
  it('the view counts bars, and the lanes span the window', async () => {
    const h = harness();
    await intoTheMix(h);
    const v = h.ctl.getView();
    expect(v.stage).toBe('mixing');
    expect(v.transition?.bar).toBe(2);
    expect(v.transition?.bars).toBe(32);
    expect(v.lanes?.beats).toBe(128);
    expect(v.lanes?.a.levels.length).toBe(v.lanes?.b.levels.length);
    expect(v.incomingBpm?.bpm).toBeGreaterThan(123);
  });

  it('Pause pauses both: the context is suspended as the listener’s, and Play resumes it', async () => {
    const h = harness();
    await intoTheMix(h);
    h.el.pause();
    expect(engine.paused).toEqual([true]);
    expect((engine.context as unknown as { suspend: () => void }).suspend).toHaveBeenCalled();
    await h.el.play();
    await flush();
    expect(engine.paused).toEqual([true, false]);
  });

  it('a seek during the mix finishes it over one bar', async () => {
    const h = harness();
    await intoTheMix(h);
    const spy = vi.spyOn(engine.last!, 'finishNow');
    h.el.currentTime = 20;
    expect(spy).toHaveBeenCalledWith(1);
  });

  it('Next during the mix cuts to the incoming track where it is', async () => {
    const h = harness();
    await intoTheMix(h);
    expect(h.ctl.next()).toBe(true);
    await flush();
    expect(h.player.playIndex).toHaveBeenCalledTimes(1);
    const [index, options] = h.player.playIndex.mock.calls[0] as [
      number,
      { handoff: { currentTime: number }; automix: boolean },
    ];
    expect(index).toBe(1);
    expect(options.automix).toBe(true);
    expect(options.handoff.currentTime).toBeCloseTo(engine.position('B')!, 6);
  });

  it('when it’s over and the incoming deck is at its own speed, the player takes it from there', async () => {
    const h = harness();
    const t0 = await intoTheMix(h);
    // past the window and the settle
    engine.port.time = t0 + 32 * 4 * GA.period + 1;
    h.ctl.poke();
    await flush();
    expect(h.player.playIndex).toHaveBeenCalledTimes(1);
    const options = h.player.playIndex.mock.calls[0][1] as {
      handoff: { currentTime: number; pause: () => void };
    };
    const where = options.handoff.currentTime;
    expect(where).toBeGreaterThan(GB.barTime(32));
    expect(h.el.muted).toBe(false);
    // the player joined: its hand-off stops the deck and the decks let go
    options.handoff.pause();
    await vi.advanceTimersByTimeAsync(300);
    expect(engine.unloaded).toEqual(expect.arrayContaining(['A', 'B']));
    expect(h.ctl.ownsAdvance()).toBe(false);
    expect(h.ctl.getView().stage).toBe('idle');
  });

  it('the incoming track removed from Up next mid-mix is put back after the playing one', async () => {
    const h = harness();
    const t0 = await intoTheMix(h);
    h.st.queue.splice(1, 1);
    engine.port.time = t0 + 32 * 4 * GA.period + 1;
    h.ctl.poke();
    await flush();
    expect(h.player.insertNext).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }));
    expect(h.player.playIndex.mock.calls[0][0]).toBe(1);
  });

  it('Finish now and Back reach the executor; Back only while it’s offered', async () => {
    const h = harness();
    await intoTheMix(h);
    const t = engine.last!;
    const back = vi.spyOn(t, 'back');
    const finish = vi.spyOn(t, 'finishNow');
    h.ctl.back();
    expect(back).toHaveBeenCalledTimes(1);
    h.ctl.finishNow();
    expect(finish).not.toHaveBeenCalled(); // it's going back now
  });
});

describe('the countdown', () => {
  async function counting(h: Harness) {
    await at(h, OUT - 40);
    const lead = Math.max(3, LEAD_BARS * 4 * GA.period);
    await at(h, OUT - lead + 0.2);
    await vi.advanceTimersByTimeAsync(400);
  }

  it('Cancel: the element is the player again where it is, and this pair isn’t mixed', async () => {
    const h = harness();
    await counting(h);
    h.ctl.cancel();
    h.ctl.poke();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.el.muted).toBe(false);
    expect(h.ctl.ownsAdvance()).toBe(false);
    expect(engine.unloaded).toEqual(expect.arrayContaining(['A', 'B']));
    // it plays out, as without DJ mix: no crossfade either
    expect(h.ctl.crossfade(h.st.queue[0], h.st.queue[1])).toBeNull();
    await at(h, OUT + 1);
    expect(engine.plays).toHaveLength(1);
  });

  it('a seek cancels it, and the mix can come again once the track is back before it', async () => {
    const h = harness();
    await counting(h);
    h.el.currentTime = 60;
    h.ctl.poke();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.el.muted).toBe(false);
    expect(h.ctl.ownsAdvance()).toBe(false);
    await at(h, OUT - 30);
    expect(h.window.mock.calls.length).toBe(4);
  });

  it('the next track changed under it: cancelled', async () => {
    const h = harness();
    await counting(h);
    h.st.queue.splice(1, 1, track('9', 'Sand Script'));
    h.ctl.poke();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.ctl.ownsAdvance()).toBe(false);
    expect(h.el.muted).toBe(false);
  });

  it('Next during the countdown lets the decks go and the player skips as always', async () => {
    const h = harness();
    await counting(h);
    expect(h.ctl.next()).toBe(false);
    expect(h.ctl.ownsAdvance()).toBe(false);
    expect(h.el.muted).toBe(false);
    expect(h.player.playIndex).not.toHaveBeenCalled();
  });

  it('any other load (a row, Previous) lets the decks go at once', async () => {
    const h = harness();
    await counting(h);
    h.ctl.beforeLoad(2, {});
    expect(h.ctl.ownsAdvance()).toBe(false);
    expect(h.el.muted).toBe(false);
    // its own hand-back passes through
    h.ctl.beforeLoad(1, { automix: true });
  });
});

describe('Mix now', () => {
  it('moves the mix to the next phrase that leaves time for the windows', () => {
    const plan = okPlan();
    const moved = mixNowPlan(plan, GA, apiGrid('1', GA, -8).phrases, 30, 300)!;
    expect(moved.out.bar).toBe(24);
    expect(moved.out.start).toBeCloseTo(GA.barTime(24), 6);
    expect(moved.bars).toBe(32);
    expect(moved.in).toEqual(plan.in);
  });

  it('shortens the mix to what the track has left, and gives up under two bars', () => {
    const plan = okPlan();
    const g = GA;
    const end = g.barTime(130);
    const moved = mixNowPlan(plan, g, apiGrid('1', g, -8).phrases, g.barTime(110), end)!;
    expect(moved.out.bar).toBe(120);
    expect(moved.bars).toBe(8);
    expect(mixNowPlan(plan, g, [], g.barTime(129), g.barTime(130) + 0.5)).toBeNull();
  });

  it('X counts down from the next phrase and loads at once', async () => {
    const h = harness({ prefs: { auto: false } });
    await at(h, 30);
    expect(h.window).not.toHaveBeenCalled();
    expect(h.ctl.key('X')).toBe(true);
    await flush();
    expect(h.window).toHaveBeenCalledTimes(2);
    const v = h.ctl.getView();
    expect(v.manual).toBe(true);
    expect(v.outStart).toBeCloseTo(GA.barTime(24), 6);
    expect(v.barsToGo).toBeGreaterThan(0);
  });

  it('a cut plan cuts now; a pair that plays on has nothing to mix (never a crossfade)', async () => {
    const h = harness({ plan: cutPlan() });
    await at(h, 30);
    expect(h.ctl.mixNow()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.player.playIndex).toHaveBeenCalledWith(1, { automix: true });
    const on = harness({ plan: playOnPlan() });
    await at(on, 30);
    expect(on.ctl.mixNow()).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(on.player.playIndex).not.toHaveBeenCalled();
    expect(on.player.crossfadeInto).not.toHaveBeenCalled();
  });

  it('isn’t offered with DJ mix off, nor while paused', async () => {
    const h = harness({ prefs: { between: 'off' } });
    await at(h, 30);
    expect(h.ctl.key('X')).toBe(false);
    const h2 = harness();
    h2.el.paused = true;
    await at(h2, 30);
    expect(h2.ctl.getView().canMixNow).toBe(false);
    expect(h2.ctl.getView().mixNowWhy).toBe('Play first');
  });
});

describe('no crossfade (Ross, 27 October)', () => {
  it('the player is never asked to crossfade, whatever the plan or the setting', async () => {
    for (const plan of [okPlan(), cutPlan(), playOnPlan(), serverWaiting()]) {
      const h = harness({ plan });
      await at(h, 100);
      expect(h.ctl.crossfade(h.st.queue[0], h.st.queue[1])).toBeNull();
      expect(h.ctl.mixNow()).toBeTypeOf('boolean');
      await at(h, 299);
      await vi.advanceTimersByTimeAsync(1000);
      // the port has no crossfade any more; the spy stays as a tripwire
      expect(h.player.crossfadeInto).not.toHaveBeenCalled();
    }
    const off = harness({ prefs: { between: 'off' } });
    await at(off, 100);
    expect(off.ctl.crossfade(off.st.queue[0], off.st.queue[1])).toBeNull();
    expect(off.plan).not.toHaveBeenCalled();
  });

  it('a cut plan ends the outgoing track on its bar and starts the next, no decks', async () => {
    const h = harness({ plan: cutPlan(250) });
    await at(h, 200);
    expect(h.player.playIndex).not.toHaveBeenCalled();
    expect(h.ctl.getView().stage).toBe('cut');
    await at(h, 249);
    await vi.advanceTimersByTimeAsync(900);
    expect(h.player.playIndex).not.toHaveBeenCalled();
    h.el.advance(250);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.player.playIndex).toHaveBeenCalledTimes(1);
    expect(h.player.playIndex).toHaveBeenCalledWith(1, { automix: true });
    expect(engine.plays).toHaveLength(0);
    expect(h.window).not.toHaveBeenCalled();
  });

  it('[review L2] a pause while a cut is set: no cut while paused, set again once it plays on', async () => {
    const h = harness({ plan: cutPlan(250) });
    await at(h, 249);
    h.el.pause();
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.player.playIndex).not.toHaveBeenCalled();
    await h.el.play();
    await at(h, 249.9);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.player.playIndex).toHaveBeenCalledTimes(1);
    expect(h.player.playIndex).toHaveBeenCalledWith(1, { automix: true });
  });

  it('[review L2] the wait for a cut is in the track’s seconds at its playback rate', async () => {
    const h = harness({ plan: cutPlan(250) });
    h.el.playbackRate = 2;
    await at(h, 249);
    // a second of the track at double speed is half a second of the clock
    await vi.advanceTimersByTimeAsync(400);
    expect(h.player.playIndex).not.toHaveBeenCalled();
    h.el.advance(250);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.player.playIndex).toHaveBeenCalledTimes(1);
    // slower: it doesn't fire early, and a timer that finds the track short
    // of its bar sets it again
    const slow = harness({ plan: cutPlan(250) });
    slow.el.playbackRate = 0.5;
    await at(slow, 249);
    await vi.advanceTimersByTimeAsync(1500);
    expect(slow.player.playIndex).not.toHaveBeenCalled();
    slow.el.advance(250);
    await vi.advanceTimersByTimeAsync(600);
    expect(slow.player.playIndex).toHaveBeenCalledTimes(1);
  });

  it('with Mix automatically off a cut waits for Mix now', async () => {
    const manual = harness({ plan: cutPlan(250), prefs: { auto: false } });
    await at(manual, 249.5);
    manual.el.advance(251);
    await vi.advanceTimersByTimeAsync(1000);
    expect(manual.player.playIndex).not.toHaveBeenCalled();
  });

  it('a pair that plays on: nothing happens, the track plays to its end', async () => {
    const h = harness({ plan: playOnPlan() });
    for (const t of [100, 250, OUT, 299]) await at(h, t);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.player.playIndex).not.toHaveBeenCalled();
    expect(h.player.crossfadeInto).not.toHaveBeenCalled();
    expect(h.window).not.toHaveBeenCalled();
    expect(h.ctl.ownsAdvance()).toBe(false);
  });
});

describe('the chips’ choices', () => {
  it('Up next’s choice, else the set’s, else Auto; a set played as a mix is DJ mix', () => {
    const set = {
      id: 3,
      name: 'Sunday Set',
      row: 0,
      transition: { style: 'cut' as const, bars: null },
    };
    expect(choiceOf(track('1', 'a'))).toEqual(AUTO_CHOICE);
    expect(choiceOf(track('1', 'a', { mix_set: set }))).toEqual({ style: 'cut', bars: null });
    expect(
      choiceOf(track('1', 'a', { mix_set: set, automix: { style: 'echo_out', bars: 4 } })),
    ).toEqual({ style: 'echo_out', bars: 4 });
    expect(
      playedAsMix(
        track('1', 'a', { mix_set: set }),
        track('2', 'b', { mix_set: { ...set, row: 2 } }),
      ),
    ).toBe(true);
    expect(playedAsMix(track('1', 'a', { mix_set: set }), track('2', 'b'))).toBe(false);
    expect(mixable(track('1', 'a', { kind: 'podcast' }))).toBe(false);
    expect(mixable(track('1', 'a', { media_src: 'x' }))).toBe(false);
  });

  it('a set played as a mix mixes whatever the setting (28e)', async () => {
    const h = harness({ prefs: { between: 'off' } });
    const set = { id: 3, name: 'Sunday Set', row: 0, transition: null };
    h.st.queue[0].mix_set = set;
    h.st.queue[1].mix_set = { ...set, row: 1 };
    await at(h, 100);
    expect(h.plan).toHaveBeenCalled();
    expect(h.ctl.getView().dj).toBe(true);
  });
});

// ── after the gauntlet review ──────────────────────────────────────────────

async function takenOver(h: Harness) {
  await at(h, OUT - 40);
  const lead = Math.max(3, LEAD_BARS * 4 * GA.period);
  await at(h, OUT - lead + 0.2);
  expect(h.ctl.ownsAdvance()).toBe(true);
}

describe('[gauntlet H1] the element is never left muted', () => {
  it.each([0, 50, 150])(
    'a row clicked %i ms after the decks take over: the element unmuted at its level, no deck audio',
    async (ms) => {
      const h = harness();
      await takenOver(h);
      await vi.advanceTimersByTimeAsync(ms);
      h.ctl.beforeLoad(2, {});
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.el.muted).toBe(false);
      expect(h.el.volume).toBeCloseTo(0.7, 6);
      expect(engine.unloaded).toEqual(expect.arrayContaining(['A', 'B']));
      expect(engine.gain.value).toBe(0);
      expect(h.ctl.ownsAdvance()).toBe(false);
    },
  );

  it.each([0, 50, 150])('Next %i ms after the takeover: the same', async (ms) => {
    const h = harness();
    await takenOver(h);
    await vi.advanceTimersByTimeAsync(ms);
    expect(h.ctl.next()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.el.muted).toBe(false);
    expect(h.el.volume).toBeCloseTo(0.7, 6);
  });

  it('mix() throwing leaves the element unmuted at its level, and the decks empty', async () => {
    const h = harness();
    engine.mix = () => {
      throw new Error('no worklet');
    };
    await at(h, OUT - 40);
    const lead = Math.max(3, LEAD_BARS * 4 * GA.period);
    await at(h, OUT - lead + 0.2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.el.muted).toBe(false);
    expect(h.el.volume).toBeCloseTo(0.7, 6);
    expect(engine.unloaded).toEqual(expect.arrayContaining(['A', 'B']));
    expect(h.ctl.ownsAdvance()).toBe(false);
    // and it plays on to its end (no crossfade)
    expect(h.ctl.crossfade(h.st.queue[0], h.st.queue[1])).toBeNull();
  });

  it('the last line: muted with no mix held, the next play unmutes it', async () => {
    const h = harness();
    await at(h, 100);
    h.el.muted = true;
    await h.el.play();
    expect(h.el.muted).toBe(false);
  });
});

describe('[gauntlet H2] audio that doesn’t go through the queue stops the decks', () => {
  async function mixing(h: Harness) {
    await takenOver(h);
    await vi.advanceTimersByTimeAsync(400);
    const t0 = engine.inputs[0].t0;
    engine.port.time = t0 + 2;
    h.ctl.poke();
    await flush();
    expect(h.ctl.getView().stage).toBe('mixing');
    return t0;
  }

  it('a station started mid-mix (the loaders’ stop hook): decks gone, element unmuted, the station never replaced', async () => {
    const h = harness();
    const t0 = await mixing(h);
    h.ctl.otherAudio();
    h.st.track = { id: null, title: 'Radio Paradise', kind: 'radio' };
    h.st.kind = 'radio';
    expect(h.el.muted).toBe(false);
    expect(h.ctl.ownsAdvance()).toBe(false);
    engine.port.time = t0 + 32 * 4 * GA.period + 5;
    h.ctl.poke();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.player.playIndex).not.toHaveBeenCalled();
    expect(engine.unloaded).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('the same without the hook: the playing track isn’t the outgoing one any more', async () => {
    const h = harness();
    const t0 = await mixing(h);
    h.st.track = { id: null, title: 'Radio Paradise', kind: 'radio' };
    h.st.kind = 'radio';
    h.ctl.poke();
    expect(h.el.muted).toBe(false);
    engine.port.time = t0 + 32 * 4 * GA.period + 5;
    h.ctl.poke();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.player.playIndex).not.toHaveBeenCalled();
  });

  it('…or the element loading something no one said', async () => {
    const h = harness();
    await mixing(h);
    h.el.dispatchEvent(new Event('loadstart'));
    expect(h.ctl.ownsAdvance()).toBe(false);
    expect(h.el.muted).toBe(false);
  });

  it('its own hand-back isn’t stopped by the loaders’ hook', async () => {
    const h = harness();
    const t0 = await mixing(h);
    h.player.playIndex.mockImplementation(async () => {
      h.ctl.otherAudio(); // stopStream inside playQueueItem
      return { status: 'played' };
    });
    engine.port.time = t0 + 32 * 4 * GA.period + 1;
    h.ctl.poke();
    await flush();
    expect(h.player.playIndex).toHaveBeenCalledTimes(1);
    expect(engine.unloaded).toEqual([]);
  });
});

describe('[gauntlet M1] the incoming track goes straight after the playing one', () => {
  async function finished(h: Harness, edit: () => void) {
    await takenOver(h);
    await vi.advanceTimersByTimeAsync(400);
    const t0 = engine.inputs[0].t0;
    edit();
    engine.port.time = t0 + 32 * 4 * GA.period + 1;
    h.ctl.poke();
    await flush();
  }

  it('moved down the queue mid-mix: moved back, no row skipped', async () => {
    const h = harness();
    await finished(h, () => {
      const [b] = h.st.queue.splice(1, 1);
      h.st.queue.push(b);
    });
    expect(h.player.moveNext).toHaveBeenCalledWith(2);
    expect(h.player.playIndex.mock.calls[0][0]).toBe(1);
    expect(h.st.queue.map((t) => t.id)).toEqual(['1', '2', '3']);
  });

  it('removed and added again (a new row, the same track): no duplicate', async () => {
    const h = harness();
    await finished(h, () => {
      h.st.queue.splice(1, 1);
      h.st.queue.splice(2, 0, track('2', 'Static Bloom'));
    });
    expect(h.player.insertNext).not.toHaveBeenCalled();
    expect(h.st.queue.map((t) => t.id)).toEqual(['1', '2', '3']);
    expect(h.player.playIndex.mock.calls[0][0]).toBe(1);
  });

  it('removed altogether: put back once, straight after', async () => {
    const h = harness();
    await finished(h, () => void h.st.queue.splice(1, 1));
    expect(h.player.insertNext).toHaveBeenCalledTimes(1);
    expect(h.st.queue.map((t) => t.id)).toEqual(['1', '2', '3']);
    expect(h.player.playIndex.mock.calls[0][0]).toBe(1);
  });
});

describe('[gauntlet L3] the tick runs only while there is something to watch', () => {
  it('no interval with DJ mix off; one with it on', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const off = harness({ prefs: { between: 'off' } });
    off.ctl.start();
    expect(spy).not.toHaveBeenCalledWith(expect.any(Function), 120);
    off.ctl.stop();
    const on = harness();
    on.ctl.start();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 120);
    on.ctl.stop();
  });
});

// the planner's own shapes (core/dj/planner.py): a waiting plan has no
// places at all, a crossfade's outgoing start can be null
function serverWaiting(over: Partial<PairPlan> = {}): PairPlan {
  const { out: _o, in: _i, ...rest } = okPlan();
  return {
    ...rest,
    status: 'waiting',
    style: null,
    bars: null,
    length_s: undefined,
    waiting_for: 'to',
    reason: 'analyzing',
    why: 'Waiting for the analysis',
    ...over,
  };
}

// no crossfade (core/dj/planner.py): a cut on the bar with no grid going
// out, or play on
function cutPlan(start = 250): PairPlan {
  const { out: _o, in: _i, ...rest } = okPlan();
  return {
    ...rest,
    status: 'cut',
    style: 'cut',
    bars: null,
    beatmatch: false,
    fallback: { kind: 'cut', code: 'no_beat', reason: 'Night Ferry has no steady beat' },
    out: { start, bar: null, end: start },
    in: { start: 0, bar: null },
    length_s: 0,
  };
}

function playOnPlan(): PairPlan {
  const { out: _o, in: _i, ...rest } = okPlan();
  return {
    ...rest,
    status: 'play_on',
    style: null,
    bars: null,
    beatmatch: false,
    length_s: 0,
    fallback: { kind: 'play_on', code: 'no_beat', reason: 'Night Ferry has no steady beat' },
  };
}

describe('[gauntlet lab] every plan status, as the server sends it', () => {
  it('waiting (no out, no in): planned, ticked to the end, Mix now and the view never throw', async () => {
    const h = harness({ plan: serverWaiting() });
    for (const t of [10, 100, 250, OUT - 20, OUT - 2, OUT + 5, 295]) {
      await at(h, t);
      expect(() => h.ctl.getView()).not.toThrow();
    }
    expect(h.ctl.getView().stage).not.toBe('mixing');
    expect(h.ctl.ownsAdvance()).toBe(false);
    expect(() => h.ctl.key('X')).not.toThrow();
    expect(h.ctl.crossfade(h.st.queue[0], h.st.queue[1])).toBeNull();
    expect(h.window).not.toHaveBeenCalled();
    expect(h.el.muted).toBe(false);
  });

  it('cut and play_on (no decks): ticked to the end, Mix now and the view never throw', async () => {
    for (const plan of [cutPlan(250), playOnPlan()]) {
      const h = harness({ plan });
      for (const t of [100, 250, 295]) {
        await at(h, t);
        expect(() => h.ctl.getView()).not.toThrow();
      }
      expect(h.ctl.ownsAdvance()).toBe(false);
      expect(h.window).not.toHaveBeenCalled();
    }
  });

  it('Mix now on a plan with no places: nothing moved', () => {
    expect(mixNowPlan(serverWaiting(), GA, [], 30, 300)).toBeNull();
  });
});

describe('analyse on demand: a waiting pair', () => {
  it('is planned again, afresh, once a track it waits for is analysed', async () => {
    const h = harness({ plan: serverWaiting() });
    await at(h, 100);
    expect(h.plan).toHaveBeenCalledTimes(1);
    expect(h.ctl.getView().plan?.status).toBe('waiting');
    h.plan.mockImplementation(async () => okPlan());
    h.ctl.replanWaiting();
    await flush();
    expect(h.plan).toHaveBeenCalledTimes(2);
    expect(h.plan).toHaveBeenLastCalledWith('1', '2', AUTO_CHOICE, 'auto', true);
    expect(h.ctl.getView().plan?.status).toBe('ok');
    // a pair already planned isn't asked again
    h.ctl.replanWaiting();
    await flush();
    expect(h.plan).toHaveBeenCalledTimes(2);
  });
});
