/** The cue model (3b, 37g; 439, 445): placing on the beat, following the grid, the words, the store. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BeatGrid } from '@/features/engine/grid';

import {
  barWords,
  cueAt,
  cueButtonName,
  cueButtonText,
  cueSeconds,
  cueSetOf,
  CueStore,
  cueWords,
  emptyCues,
  MAX_BAR,
  MIN_BAR,
  placeLabel,
  SAVE_DELAY_MS,
  withCue,
  withoutCue,
} from './dj-cues';

/** 120 BPM, the first downbeat at 1 s: a bar every 2 s. */
const grid = () => new BeatGrid({ period: 0.5, firstBeat: 1 });

describe('placing a cue', () => {
  it('lands on the nearest beat, its bar to the beat', () => {
    expect(cueAt(2, 33.1, grid(), 300)).toEqual({ slot: 2, bar: 16, seconds: 33 });
    expect(cueAt(3, 33.6, grid(), 300)).toEqual({ slot: 3, bar: 16.25, seconds: 33.5 });
    // without a grid: the time itself
    expect(cueAt(1, 12.3456, null, 300)).toEqual({ slot: 1, bar: null, seconds: 12.346 });
    // inside the track
    expect(cueAt(1, 400, null, 300).seconds).toBe(300);
    expect(cueAt(1, -3, null, 300).seconds).toBe(0);
  });

  it('a bar the server can’t keep (L1): the cue keeps its seconds, with no bar', () => {
    // the first downbeat at 1,201 s: a cue at 1 s is 600 bars before it, still kept
    const late = new BeatGrid({ period: 0.5, firstBeat: 1201 });
    expect(cueAt(1, 1, late, 3000).bar).toBe(-600);
    // at 4,001 s it's 2,000 bars before: past the bound, so its seconds only
    const later = new BeatGrid({ period: 0.5, firstBeat: 4001 });
    expect(cueAt(1, 1, later, 6000)).toEqual({ slot: 1, bar: null, seconds: 1 });
    expect(MIN_BAR).toBe(-1000);
    expect(MAX_BAR).toBe(10000);
  });

  it('follows the grid: a re-analysis that moves it moves the cue', () => {
    const cue = cueAt(4, 33, grid(), 300);
    const moved = new BeatGrid({ period: 0.5, firstBeat: 1.5 });
    expect(cueSeconds(cue, moved)).toBeCloseTo(33.5);
    expect(cueSeconds({ slot: 1, bar: null, seconds: 9 }, moved)).toBe(9);
  });

  it('a set of four: placed, moved, taken off; the route’s list read', () => {
    let set = emptyCues();
    set = withCue(set, { slot: 3, bar: 4, seconds: 9 });
    expect(set.map((c) => c?.slot ?? null)).toEqual([null, null, 3, null]);
    set = withCue(set, { slot: 3, bar: 8, seconds: 17 });
    expect(set[2]!.bar).toBe(8);
    expect(withoutCue(set, 3)).toEqual(emptyCues());
    expect(
      cueSetOf([
        { slot: 4, bar: 1, seconds: 3 },
        { slot: 9, bar: 1, seconds: 3 },
        { slot: 1, bar: null, seconds: -1 },
      ]).map((c) => c?.slot ?? null),
    ).toEqual([null, null, null, 4]);
  });
});

describe('the words (37g, 37p)', () => {
  it('the button, its name, the pointer’s label and the announcements', () => {
    const cue = { slot: 2, bar: 16, seconds: 33 };
    expect(cueButtonText(2, cue)).toBe('2 · 17');
    expect(cueButtonText(3, null)).toBe('3');
    expect(cueButtonText(1, { slot: 1, bar: null, seconds: 75 })).toBe('1 · 1:15');
    expect(barWords({ slot: 1, bar: 16.5, seconds: 0 })).toBe('17.3');
    expect(cueButtonName(2, cue, false)).toBe('Cue 2, bar 17');
    expect(cueButtonName(4, null, true)).toBe(
      'Cue 4, empty, picked: click the waveform to place it',
    );
    expect(placeLabel(4, grid(), 159)).toBe('Cue 4 · bar 80 · click to place');
    expect(cueWords('placed', 'B', cue)).toBe('Cue 2 on deck B at bar 17');
    expect(cueWords('jumped', 'A', cue)).toBe('Deck A to cue 2, bar 17');
    expect(cueWords('picked', 'A', { slot: 3 })).toBe(
      'Cue 3 on deck A picked: click the waveform to place it',
    );
  });
});

describe('the store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads a track’s cues; a refusal reads as none known', async () => {
    const f = vi.fn(async (url: string) =>
      url.endsWith('/9')
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify({ cues: [{ slot: 2, bar: 16, seconds: 33 }] })),
    );
    const store = new CueStore(f);
    expect((await store.load('2'))![1]).toEqual({ slot: 2, bar: 16, seconds: 33 });
    expect(await store.load('9')).toBeNull();
  });

  it('a run of moves is one save, the last; flush sends what’s waiting', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init?.body as string) });
      return new Response('{}');
    });
    const store = new CueStore(f);
    store.save('2', withCue(emptyCues(), { slot: 1, bar: 0, seconds: 1 }));
    store.save('2', withCue(emptyCues(), { slot: 1, bar: 4, seconds: 9 }));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(calls).toEqual([
      {
        url: expect.stringMatching(/\/api\/library\/dj\/cues\/2$/),
        body: { cues: [{ slot: 1, bar: 4, seconds: 9 }] },
      },
    ]);
    store.save('3', emptyCues());
    store.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toEqual({ url: expect.stringMatching(/cues\/3$/), body: { cues: [] } });
  });

  it('a save that fails says so', async () => {
    const onFail = vi.fn();
    const store = new CueStore(async () => new Response('{}', { status: 500 }));
    store.save('2', emptyCues(), onFail);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(onFail).toHaveBeenCalledTimes(1);
  });
});
