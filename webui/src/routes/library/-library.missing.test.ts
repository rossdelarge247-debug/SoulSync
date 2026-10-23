import { describe, expect, it } from 'vitest';

import { aboutHowLong, missingHeader, type MissingReleasesJob } from './-library.missing';

/** Look for releases you don't have (68, 15e): the header's line and the confirm's tile. */

const JOB: MissingReleasesJob = {
  id: 1,
  status: 'running',
  total: 212,
  done: 40,
  started_at: 1,
  recent: true,
};
const NOW = 1_800_000_000_000;

describe('the Artists header (15e)', () => {
  it('runs, waits for Spotify with its time left, then says what it found', () => {
    expect(missingHeader(JOB, NOW)).toEqual({
      text: "Looking for releases you don't have: 40 of 212",
      action: 'stop',
    });
    expect(missingHeader({ ...JOB, waiting_until: NOW / 1000 + 540 }, NOW)).toEqual({
      text: "Looking for releases you don't have: 40 of 212, waiting for Spotify's pause, 9 min left",
      action: 'stop',
    });
    const done = { ...JOB, status: 'done' as const, done: 212 };
    expect(missingHeader({ ...done, found_releases: 61, found_artists: 18 }, NOW)).toEqual({
      text: "The last look found 61 releases you don't have, by 18 artists",
      action: 'show',
    });
    expect(missingHeader({ ...done, found_releases: 0 }, NOW)).toEqual({
      text: 'The last look found nothing new for 212 artists',
      action: null,
    });
    expect(
      missingHeader({ ...JOB, status: 'stopped', found_releases: 3, found_artists: 1 }, NOW),
    ).toEqual({
      text: "The last look stopped after 40 of 212 artists and found 3 releases you don't have, by 1 artist",
      action: 'show',
    });
    expect(missingHeader({ ...JOB, status: 'failed' }, NOW)?.action).toBeNull();
    expect(missingHeader({ ...JOB, recent: false }, NOW)).toBeNull();
    expect(missingHeader(null, NOW)).toBeNull();
  });
});

describe('About how long (15e)', () => {
  it('counts one artist a second, rounded up to minutes', () => {
    expect(aboutHowLong(212)).toBe('4 min');
    expect(aboutHowLong(30)).toBe('1 min');
    expect(aboutHowLong(60)).toBe('1 min');
    expect(aboutHowLong(61)).toBe('2 min');
    expect(aboutHowLong(3600)).toBe('1 h');
    expect(aboutHowLong(4000)).toBe('1 h 7 min');
  });
});
