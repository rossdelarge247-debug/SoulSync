/**
 * Lyrics step 1's pure part (27a–27g): reading LRC and Enhanced LRC, the
 * line at a moment, the sweep (real and estimated, 27d), the source line
 * (27g), the nudge kept per track.
 */
import { describe, expect, it } from 'vitest';

import {
  clampOffset,
  lineAt,
  offsetSpoken,
  offsetWords,
  OFFSETS_MAX,
  parseLrc,
  parseLyrics,
  plainProgress,
  putOffset,
  readOffsets,
  sideSize,
  sourceLine,
  stepSize,
  syllables,
  trackKey,
  wordFills,
} from './lyrics.logic';

const LRC = `[ti:Night Ferry]
[00:01.00] Under a slack-water sky
[00:04.50]Hold the lantern low and wade on down
[00:10.00][01:10.00]Where the reeds forget the shore
[00:14.00]`;

const ENHANCED = `[00:04.50]<00:04.50>Hold <00:05.00>the <00:05.30>lantern <00:06.10>low
[00:08.00]<00:08.00>and <00:08.40>wade`;

describe('reading LRC', () => {
  it('lines with their starts, sorted; a repeated line once per stamp; tags dropped', () => {
    const lines = parseLrc(LRC);
    expect(lines.map((l) => [l.time, l.text])).toEqual([
      [1, 'Under a slack-water sky'],
      [4.5, 'Hold the lantern low and wade on down'],
      [10, 'Where the reeds forget the shore'],
      [14, ''],
      [70, 'Where the reeds forget the shore'],
    ]);
    // each line ends where the next starts; the last holds a while
    expect(lines[0]!.end).toBe(4.5);
    expect(lines[4]!.end).toBeGreaterThan(70);
    expect(lines.every((l) => !l.real)).toBe(true);
  });

  it('Enhanced LRC’s word times, each word ending where the next starts', () => {
    const [first] = parseLrc(ENHANCED);
    expect(first!.real).toBe(true);
    expect(first!.text).toBe('Hold the lantern low');
    expect(first!.words.map((w) => [w.text, w.start, w.end])).toEqual([
      ['Hold', 4.5, 5],
      ['the', 5, 5.3],
      ['lantern', 5.3, 6.1],
      // the last word holds until the next line (or 3 s at most)
      ['low', 6.1, 8],
    ]);
  });

  it('[offset:] moves every time sooner (milliseconds, positive is earlier)', () => {
    const [line] = parseLrc('[offset:+500]\n[00:02.00]<00:02.00>A <00:02.50>B');
    expect(line!.time).toBe(1.5);
    expect(line!.words.map((w) => w.start)).toEqual([1.5, 2]);
  });

  it('what to show: timed to the word, to the line, plain, or nothing', () => {
    expect(parseLyrics({ synced: ENHANCED, plain: null })!.timing).toBe('word');
    expect(parseLyrics({ synced: LRC, plain: 'x' })!.timing).toBe('line');
    const plain = parseLyrics({ synced: null, plain: 'One\n\n\nTwo\n' })!;
    expect(plain.timing).toBe('plain');
    expect(plain.plain).toEqual(['One', '', 'Two']);
    // a sidecar .lrc with no stamps is plain text
    expect(parseLyrics({ synced: 'Just words\nMore', plain: null })!.timing).toBe('plain');
    expect(parseLyrics({ synced: '[00:01.00]', plain: '  ' })).toBeNull();
    expect(parseLyrics(null)).toBeNull();
  });
});

describe('the line and the sweep (27d)', () => {
  const lines = parseLrc(LRC);

  it('the line playing at a moment', () => {
    expect(lineAt(lines, 0.5)).toBe(-1);
    expect(lineAt(lines, 1)).toBe(0);
    expect(lineAt(lines, 9.99)).toBe(1);
    expect(lineAt(lines, 500)).toBe(4);
    expect(lineAt([], 3)).toBe(-1);
  });

  it('real word times fill each word across its own time', () => {
    const [line] = parseLrc(ENHANCED);
    expect(wordFills(line!, 4.4)).toEqual([0, 0, 0, 0]);
    expect(wordFills(line!, 4.75)).toEqual([0.5, 0, 0, 0]);
    const held = wordFills(line!, 7.05);
    expect(held.slice(0, 3)).toEqual([1, 1, 1]);
    expect(held[3]).toBeCloseTo(0.5, 5);
  });

  it('the estimate spreads the line’s time across its syllables, at an even pace', () => {
    const line = lines[1]!; // 4.5 → 10, 9 syllables: capped at 0.42 s a syllable
    const start = wordFills(line, 4.5);
    expect(start.every((f) => f === 0)).toBe(true);
    const done = wordFills(line, 9.9);
    expect(done.every((f) => f === 1)).toBe(true);
    const mid = wordFills(line, 4.5 + 0.42 * 2.5);
    // "Hold" and "the" sung, "lantern" (two syllables) a quarter in
    expect(mid[0]).toBe(1);
    expect(mid[1]).toBe(1);
    expect(mid[2]).toBeCloseTo(0.25, 5);
    expect(mid[3]).toBe(0);
  });

  it('syllables are rough but never zero', () => {
    expect(syllables('lantern')).toBe(2);
    expect(syllables('wade')).toBe(1);
    expect(syllables('slack-water')).toBe(3);
    expect(syllables('—')).toBe(1);
  });

  it('plain lyrics scroll with the track’s progress', () => {
    expect(plainProgress(45, 90)).toBe(0.5);
    expect(plainProgress(100, 90)).toBe(1);
    expect(plainProgress(10, 0)).toBe(0);
  });
});

describe('the pill (27a, 27g)', () => {
  it('the source line names where the words came from and how they’re timed', () => {
    expect(sourceLine('lrclib', null, 'word')).toBe('LRCLIB · timed to the word');
    expect(sourceLine('lrclib', null, 'line')).toBe('LRCLIB · timed to the line');
    expect(sourceLine('lrclib', null, 'plain')).toBe(
      'LRCLIB · not timed: scrolling with the track',
    );
    expect(sourceLine('sidecar', 'Static Bloom.flac', 'word')).toBe(
      'From Static Bloom.lrc beside the track · timed to the word',
    );
    expect(sourceLine('sidecar', 'Static Bloom.flac', 'plain')).toBe(
      'From Static Bloom.txt beside the track · not timed: scrolling with the track',
    );
    expect(sourceLine('sidecar', null, 'line')).toBe(
      'From a file beside the track · timed to the line',
    );
  });

  it('the nudge in 0.1 s steps, in words and spoken', () => {
    expect(offsetWords(0.3)).toBe('+0.3 s');
    expect(offsetWords(-0.2)).toBe('−0.2 s');
    expect(offsetWords(0)).toBe('0.0 s');
    expect(offsetSpoken(0.3)).toBe('0.3 seconds earlier');
    expect(offsetSpoken(-1)).toBe('1.0 seconds later');
    expect(clampOffset(0.1 + 0.2)).toBe(0.3);
    expect(clampOffset(99)).toBe(10);
    expect(clampOffset(Number.NaN)).toBe(0);
  });

  it('A− and A+ step 36 · 44 · 56 and stay at the ends; the lines either side scale', () => {
    expect(stepSize(44, 1)).toBe(56);
    expect(stepSize(56, 1)).toBe(56);
    expect(stepSize(36, -1)).toBe(36);
    expect(stepSize(13, 1)).toBe(56);
    expect(sideSize(44)).toBe(24);
    expect(sideSize(56)).toBe(31);
  });
});

describe('kept per track', () => {
  it('a library track by its id, anything else by title, artist and album', () => {
    expect(trackKey({ id: 7, title: 'A' }, 'library')).toBe('lib:7');
    expect(trackKey({ title: 'Night Ferry', artist: 'Tidewater', album: 'L' }, 'stream')).toBe(
      't:night ferry|tidewater|l',
    );
    expect(trackKey({ title: '' }, 'stream')).toBeNull();
    expect(trackKey(null, 'library')).toBeNull();
  });

  it('a zero nudge isn’t kept; the oldest go past the cap; junk reads as nothing', () => {
    let m = putOffset({}, 'a', 0.3);
    m = putOffset(m, 'b', 0);
    expect(m).toEqual({ a: 0.3 });
    expect(putOffset(m, 'a', 0)).toEqual({});
    let big: Record<string, number> = {};
    for (let i = 0; i < OFFSETS_MAX + 3; i++) big = putOffset(big, `k${i}`, 0.1);
    expect(Object.keys(big)).toHaveLength(OFFSETS_MAX);
    expect(big.k0).toBeUndefined();
    expect(readOffsets('{"a":0.25,"b":"x","c":40}')).toEqual({ a: 0.3, c: 10 });
    expect(readOffsets('[1]')).toEqual({});
    expect(readOffsets('nope')).toEqual({});
  });
});
