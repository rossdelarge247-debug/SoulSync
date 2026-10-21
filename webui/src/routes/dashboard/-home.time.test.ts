import { describe, expect, it } from 'vitest';

import {
  formatCount,
  latestTimeLabel,
  nextSearchPhrase,
  nextSearchShort,
  plural,
} from './-home.time';

// Local time (the suite runs in America/Los_Angeles): 21 Oct 2026, 19:30.
const NOW = new Date(2026, 9, 21, 19, 30).getTime();
const at = (day: number, hh: number, mm = 0) => new Date(2026, 9, day, hh, mm).getTime() / 1000;

describe('nextSearchPhrase', () => {
  it('says it relatively while it is close', () => {
    expect(nextSearchPhrase(at(21, 19, 30), NOW)).toBe('due now');
    expect(nextSearchPhrase(at(21, 19, 10), NOW)).toBe('due now');
    expect(nextSearchPhrase(at(21, 19, 31), NOW)).toBe('due now');
    expect(nextSearchPhrase(at(21, 19, 32), NOW)).toBe('in 2 minutes');
    expect(nextSearchPhrase(at(21, 20, 10), NOW)).toBe('in 40 minutes');
    expect(nextSearchPhrase(at(21, 20, 30), NOW)).toBe('in about an hour');
    expect(nextSearchPhrase(at(21, 21, 30), NOW)).toBe('in about 2 hours');
  });

  it('gives a clock time further out, "tonight" for the small hours', () => {
    expect(nextSearchPhrase(at(22, 2), NOW)).toBe('tonight at 02:00');
    expect(nextSearchPhrase(at(22, 6), NOW)).toBe('tomorrow at 06:00');
    expect(nextSearchPhrase(at(24, 6), NOW)).toBe('on Saturday at 06:00');
    expect(nextSearchPhrase(at(30, 6), NOW)).toBe('on 30 October at 06:00');
    // the morning: later today is "today", the small hours are tomorrow
    const morning = new Date(2026, 9, 21, 8, 0).getTime();
    expect(nextSearchPhrase(at(21, 21), morning)).toBe('today at 21:00');
    expect(nextSearchPhrase(at(22, 2), morning)).toBe('tomorrow at 02:00');
  });

  it('has a short form for the phone heading', () => {
    expect(nextSearchShort(at(21, 20, 10), NOW)).toBe('in 40 min');
    expect(nextSearchShort(at(21, 21, 30), NOW)).toBe('in 2 h');
    expect(nextSearchShort(at(23, 21, 30), NOW)).toBe('on Fri');
  });
});

describe('latestTimeLabel', () => {
  it('is a clock time today, then Yesterday, a weekday, a date', () => {
    expect(latestTimeLabel(at(21, 14, 2), NOW)).toBe('14:02');
    expect(latestTimeLabel(at(20, 9, 15), NOW)).toBe('Yesterday');
    expect(latestTimeLabel(at(17, 9, 15), NOW)).toBe('Sat');
    expect(latestTimeLabel(at(10, 9, 15), NOW)).toBe('10 Oct');
  });
});

describe('numbers', () => {
  it('groups thousands and says one or many', () => {
    expect(formatCount(4512)).toBe('4,512');
    expect(plural(1, 'track')).toBe('1 track');
    expect(plural(1140, 'track')).toBe('1,140 tracks');
  });
});
