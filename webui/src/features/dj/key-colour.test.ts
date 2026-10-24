import { describe, expect, it } from 'vitest';

import { camelotParts, keyColours, keyHue, keyLongName, mixKeys } from './key-colour';

/**
 * The key colours (hand-off "Added 2026-10-24", HANDOFF 151): a Camelot key
 * n takes the hue h = (n − 8) × 30°; A and B share a hue.
 */
describe('keyHue', () => {
  it('puts 8A and 8B at 0° and turns 30° a step round the wheel', () => {
    expect(keyHue('8A')).toBe(0);
    expect(keyHue('8B')).toBe(0);
    expect(keyHue('9A')).toBe(30);
    expect(keyHue('10B')).toBe(60);
    expect(keyHue('12A')).toBe(120);
  });

  it('wraps below 8 into 0–330', () => {
    expect(keyHue('7A')).toBe(330);
    expect(keyHue('1A')).toBe(150);
    expect(keyHue('1B')).toBe(150);
    expect(keyHue('5B')).toBe(270);
  });

  it('gives every number its own hue, shared by A and B', () => {
    const hues = Array.from({ length: 12 }, (_v, i) => keyHue(`${i + 1}A`));
    expect(new Set(hues).size).toBe(12);
    for (let n = 1; n <= 12; n += 1) expect(keyHue(`${n}A`)).toBe(keyHue(`${n}B`));
  });

  it('has no hue for anything that isn’t a Camelot code', () => {
    expect(keyHue(null)).toBeNull();
    expect(keyHue('')).toBeNull();
    expect(keyHue('Am')).toBeNull();
    expect(keyHue('13A')).toBeNull();
    expect(keyHue('0B')).toBeNull();
  });

  it('reads lower case and spaces', () => {
    expect(camelotParts(' 11b ')).toEqual({ number: 11, letter: 'B' });
  });
});

describe('keyColours', () => {
  it('is the hand-off’s chip fill and text', () => {
    expect(keyColours(30)).toMatchObject({
      fill: 'oklch(0.7 0.12 30 / 0.16)',
      text: 'oklch(0.86 0.1 30)',
    });
  });
});

describe('mixKeys', () => {
  it('lists the key, −1, +1 and the relative, in the count line’s order', () => {
    expect(mixKeys('8A').map((k) => k.code)).toEqual(['8A', '7A', '9A', '8B']);
    expect(mixKeys('8B').map((k) => k.code)).toEqual(['8B', '7B', '9B', '8A']);
    expect(mixKeys('8A').map((k) => k.relation)).toEqual(['same', 'down', 'up', 'relative']);
  });

  it('goes round the wheel past 12 and below 1', () => {
    expect(mixKeys('12A').map((k) => k.code)).toEqual(['12A', '11A', '1A', '12B']);
    expect(mixKeys('1B').map((k) => k.code)).toEqual(['1B', '12B', '2B', '1A']);
  });

  it('is nothing for no key', () => {
    expect(mixKeys(null)).toEqual([]);
  });
});

describe('keyLongName', () => {
  it('names the tag form in words', () => {
    expect(keyLongName('Am')).toBe('A minor');
    expect(keyLongName('F#')).toBe('F♯ major');
    expect(keyLongName('Ebm')).toBe('E♭ minor');
    expect(keyLongName('B')).toBe('B major');
  });
});
