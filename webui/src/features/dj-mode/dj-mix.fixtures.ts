/** Test doubles for DJ mode's decks (the tests and nothing else import it). */
import type { DeckData } from '@/features/engine/engine';
import type { DeckId } from '@/features/engine/score';

import { BeatGrid } from '@/features/engine/grid';
import { FakeParam, FakePort } from '@/features/engine/testing';

import type { EngineLike, MixLane, SessionDeps } from './dj-mix-session';

import { DjMixSession } from './dj-mix-session';

/** The engine on FakePort: maps, stops, modes and params as a browser would keep them. */
export class FakeEngine {
  readonly port = new FakePort(48000);
  readonly sampleRate = 48000;
  readonly loads: { deck: DeckId; offset: number; duration: number }[] = [];
  readonly unloads: DeckId[] = [];
  readonly paused: boolean[] = [];
  readonly master = new FakeParam(1);
  suspended = 0;
  resumed = 0;
  readonly context = {
    sampleRate: 48000,
    get currentTime(): number {
      return 0;
    },
    suspend: async () => {
      this.suspended += 1;
    },
    resume: async () => {
      this.resumed += 1;
    },
  } as unknown as BaseAudioContext;
  readonly graph = { master: { gain: this.master as unknown as AudioParam } };

  constructor() {
    const port = this.port;
    Object.defineProperty(this.context, 'currentTime', { get: () => port.time });
  }

  params(deck: DeckId) {
    return this.port.params(deck);
  }
  load(deck: DeckId, data: DeckData) {
    this.loads.push({ deck, offset: data.offset, duration: data.duration });
  }
  unload(deck: DeckId) {
    this.unloads.push(deck);
  }
  play(deck: DeckId, at: number, from: number, rate = 1) {
    this.port.stop(deck, Infinity);
    this.port.map(
      deck,
      at * this.sampleRate,
      [{ f: at * this.sampleRate, p: from, r: rate }],
      true,
    );
  }
  map(...a: Parameters<FakePort['map']>) {
    this.port.map(...a);
  }
  current(deck: DeckId) {
    return this.port.current(deck);
  }
  stop(deck: DeckId, at: number) {
    this.port.stop(deck, at);
  }
  mode(deck: DeckId, m: 'resample' | 'stretch') {
    this.port.mode(deck, m);
  }
  position(deck: DeckId, at = this.port.time) {
    return this.port.position(deck, at);
  }
  setPaused(on: boolean) {
    this.paused.push(on);
  }
  /** A param's value as the browser would play it at t. */
  value(key: `${DeckId}.${string}`, t = this.port.time): number {
    const [deck, name] = key.split('.') as [DeckId, never];
    return this.port.value(deck, name, t);
  }
}

/** The player's `<audio>` element, as far as the decks use it. */
export class FakeAudio extends EventTarget {
  currentTime = 121;
  duration = 286;
  paused = false;
  ended = false;
  muted = false;
  volume = 0.7;
  playbackRate = 1;
}

/** 120 BPM: a beat every 0.5 s, a bar every 2 s, the first downbeat at 1 s. */
export function gridA(): BeatGrid {
  return new BeatGrid({ period: 0.5, firstBeat: 1 });
}

/** 125 BPM (0.48 s a beat), the first downbeat at 0.5 s: Sync slows it 4%. */
export function gridB(): BeatGrid {
  return new BeatGrid({ period: 0.48, firstBeat: 0.5 });
}

export function laneA(over: Partial<MixLane> = {}): MixLane {
  return { id: '2', title: 'Night Ferry', grid: gridA(), bpm: 120, cue: 0, duration: 286, ...over };
}

export function laneB(over: Partial<MixLane> = {}): MixLane {
  return {
    id: '8',
    title: 'Harbour Lights',
    grid: gridB(),
    bpm: 125,
    cue: 0.5,
    duration: 288,
    ...over,
  };
}

export interface Rig {
  session: DjMixSession;
  engine: FakeEngine;
  el: FakeAudio;
  said: string[];
  windows: { id: string; start: number; dur: number }[];
  player: { volume: number; muted: boolean };
  /** move the clock (context and timers) on */
  advance(seconds: number): Promise<void>;
}

/** A session on fakes; the test uses vi.useFakeTimers() (the session's timers are the window's). */
export function rig(
  vi: { advanceTimersByTimeAsync(ms: number): Promise<unknown> },
  over: Partial<SessionDeps> = {},
): Rig {
  const engine = new FakeEngine();
  const el = new FakeAudio();
  const said: string[] = [];
  const windows: Rig['windows'] = [];
  const player = { volume: 70, muted: false };
  const session = new DjMixSession({
    player: {
      audio: () => el as unknown as HTMLAudioElement,
      state: () => player,
    },
    engine: async () => engine as unknown as EngineLike,
    fetchWindow: async (_ctx, id, start, dur) => {
      windows.push({ id, start, dur });
      return {
        channels: [],
        mono4: new Float32Array(0),
        sampleRate: 48000,
        offset: start,
        duration: dur,
      };
    },
    say: (w) => said.push(w),
    ...over,
  });
  return {
    session,
    engine,
    el,
    said,
    windows,
    player,
    async advance(seconds: number) {
      const steps = Math.max(1, Math.ceil(seconds / 0.01));
      for (let i = 0; i < steps; i++) {
        const dt = seconds / steps;
        engine.port.time += dt;
        el.currentTime += el.paused ? 0 : dt;
        await vi.advanceTimersByTimeAsync(dt * 1000);
      }
    },
  };
}
