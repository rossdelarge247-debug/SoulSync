/** The lanes' waveform at every zoom (step 4b): the levels, their pyramid, the drawing, the server's, the smooth clock. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cachedLevels,
  clearLevelsCache,
  coarseLevels,
  drawWave,
  levelOver,
  levelsFrom,
  loadLevels,
  SmoothClock,
} from './dj-levels';

afterEach(() => clearLevelsCache());

describe('the levels', () => {
  it('a pyramid of maxima: any span costs a couple of reads, and gives its loudest', () => {
    const values = Array.from({ length: 1000 }, () => 10);
    values[503] = 255;
    const src = levelsFrom(values, 0.01, 255);
    expect(src.duration).toBeCloseTo(10);
    expect(src.pyramid[0]!.length).toBe(1000);
    expect(src.pyramid.at(-1)!.length).toBe(1);
    expect(levelOver(src, 5.0, 5.1)).toBeCloseTo(1);
    expect(levelOver(src, 4.0, 5.0)).toBeCloseTo(10 / 255, 4);
    // the whole track and a single level both find the spike
    expect(levelOver(src, 0, 10)).toBeCloseTo(1);
    expect(levelOver(src, 5.03, 5.031)).toBeCloseTo(1);
    // outside the track: nothing
    expect(levelOver(src, -2, -1)).toBe(0);
    expect(levelOver(src, 11, 12)).toBe(0);
  });

  it('the 200 peaks as a source until the fine levels come', () => {
    const src = coarseLevels([0.5, 1], 4)!;
    expect(src.step).toBe(2);
    expect(levelOver(src, 2.5, 3)).toBe(1);
    expect(coarseLevels([], 4)).toBeNull();
  });
});

describe('drawing', () => {
  it('a bar a pixel column, the played part at full strength, nothing past the track', () => {
    const rects: [number, number][] = [];
    const alphas: number[] = [];
    const ctx = {
      clearRect: vi.fn(),
      fillRect: (x: number, _y: number, _w: number, h: number) => rects.push([x, h]),
      set fillStyle(_v: string) {},
      set globalAlpha(v: number) {
        alphas.push(v);
      },
    } as unknown as CanvasRenderingContext2D;
    const values = [0, 0, 255, 0, 0, 0, 0, 0, 0, 0];
    const src = levelsFrom(values, 0.1, 255);
    // a 1 s view over 10 columns from -0.5 s: the first five are before the track
    drawWave(ctx, 10, 100, src, -0.5, 0.5, 0.3, { colour: '#fff', restAlpha: 0.5 });
    expect(rects.map(([x]) => x)).toEqual([5, 6, 7, 8, 9]);
    // the spike (0.2–0.3 s) at full height, the rest a hairline
    expect(rects.find(([x]) => x === 7)![1]).toBeCloseTo(96);
    expect(rects.find(([x]) => x === 9)![1]).toBe(1);
    // played (before 0.3 s) at 1, then the rest at 0.5, then back to 1 after
    expect(alphas).toEqual([1, 0.5, 1]);
  });
});

describe('the server’s levels', () => {
  it('asked again while they’re worked out, decoded and kept per track', async () => {
    const answers = [
      new Response('{"state":"pending"}', { status: 202 }),
      new Response(JSON.stringify({ state: 'ready', step: 0.01, levels: btoa('\x00\xff\x80') })),
    ];
    const f = vi.fn(async () => answers.shift()!);
    const v = await loadLevels(
      '8',
      '/api/library/dj/levels/8',
      f,
      () => 1,
      async () => undefined,
    );
    expect(f).toHaveBeenCalledTimes(2);
    const got = Array.from(v!.pyramid[0]!);
    expect(got[0]).toBe(0);
    expect(got[1]).toBe(1);
    expect(got[2]).toBeCloseTo(128 / 255, 5);
    expect(cachedLevels('8')).toBe(v);
    // asked again: the cache
    expect(await loadLevels('8', '/x', f, () => 1)).toBe(v);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a refusal, a failure or too long a wait: none', async () => {
    expect(
      await loadLevels(
        '1',
        '/x',
        async () => new Response('{}', { status: 404 }),
        () => 1,
      ),
    ).toBeNull();
    expect(
      await loadLevels(
        '2',
        '/x',
        async () => new Response('{"state":"failed","reason":"unreadable"}'),
        () => 1,
      ),
    ).toBeNull();
    expect(
      await loadLevels(
        '3',
        '/x',
        async () => new Response('{}', { status: 202 }),
        () => null,
      ),
    ).toBeNull();
  });
});

describe('the element’s time, smooth', () => {
  it('carried on between its steps while it plays, never more than a quarter second', () => {
    const c = new SmoothClock();
    const el = { currentTime: 10, paused: false, playbackRate: 1 };
    expect(c.read(el, 1000)).toBe(10);
    expect(c.read(el, 1100)).toBeCloseTo(10.1);
    expect(c.read(el, 2000)).toBeCloseTo(10.25);
    el.currentTime = 10.3;
    expect(c.read(el, 2010)).toBe(10.3);
    el.paused = true;
    expect(c.read(el, 2500)).toBe(10.3);
  });
});
