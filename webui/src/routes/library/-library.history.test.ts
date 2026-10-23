/**
 * Listening history's words (13a, 13b). The clock is fixed in each test; the
 * suite runs in America/Los_Angeles (vitest.setup.ts), so 14:02 UTC is 07:02.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HISTORY_RANGE_KEY,
  clockTime,
  dayHead,
  emptyTitle,
  groupByDay,
  historyMeta,
  lengthWords,
  readRememberedRange,
  rememberRange,
  sourcePhrase,
  sourcesPhrase,
  spokenParts,
  widerRange,
} from './-library.history';

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('the source phrase', () => {
  it('says where a play happened only when it was not SYNCHRO.S', () => {
    expect(sourcePhrase({ server_source: 'soulsync_web', player_name: null, heard_on: null })).toBe(
      '',
    );
    expect(
      sourcePhrase({ server_source: 'plex', player_name: 'Living room', heard_on: null }),
    ).toBe('on Plex, Living room');
    expect(sourcePhrase({ server_source: 'jellyfin', player_name: null, heard_on: null })).toBe(
      'on Jellyfin',
    );
    expect(sourcePhrase({ server_source: 'lastfm', player_name: null, heard_on: null })).toBe(
      'from Last.fm',
    );
    expect(
      sourcePhrase({ server_source: 'soulsync_web', player_name: null, heard_on: 'FIP Jazz' }),
    ).toBe('heard on FIP Jazz');
  });

  it('names the sources of a range', () => {
    expect(sourcesPhrase(['soulsync_web', 'plex'])).toBe("from SYNCHRO.S's player and Plex");
    expect(sourcesPhrase(['plex', 'lastfm', 'soulsync_web'])).toBe(
      "from Plex, Last.fm and SYNCHRO.S's player",
    );
    expect(sourcesPhrase([])).toBe('');
  });
});

describe('the meta line', () => {
  it('reads like 13a for music and 13b for the spoken kinds', () => {
    expect(
      historyMeta({
        kind: 'music',
        range: '7d',
        total: 412,
        filtered: false,
        sources: ['soulsync_web', 'plex'],
      }),
    ).toBe("412 plays in the last 7 days · from SYNCHRO.S's player and Plex · yours only");
    expect(historyMeta({ kind: 'podcast', range: '7d', total: 6, filtered: false })).toBe(
      '6 episodes in the last 7 days · kept apart from Stats',
    );
    expect(
      historyMeta({ kind: 'music', range: 'today', total: 1, filtered: true, sources: ['plex'] }),
    ).toBe('1 play matches today · from Plex · yours only');
    expect(
      historyMeta({ kind: 'music', range: 'all', total: 2, filtered: false, sharedWith: 2 }),
    ).toBe("2 plays in all · shared with 2 profiles that don't keep their own");
  });
});

describe('times and days', () => {
  it('shows the browser clock and day heads', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T20:00:00Z'));
    expect(clockTime('2026-10-23 14:02:00')).toBe('07:02');
    const now = new Date();
    expect(dayHead('2026-10-23', now)).toBe('Today · Friday 23 October');
    expect(dayHead('2026-10-22', now)).toBe('Yesterday · Thursday 22 October');
    expect(dayHead('2026-10-22', now, true)).toBe('Yesterday');
    expect(dayHead('2026-10-20', now, true)).toBe('Tuesday 20 October');
    expect(dayHead('2025-12-31', now)).toBe('Wednesday 31 December 2025');
  });

  it('groups plays by day in order', () => {
    const groups = groupByDay([
      { day: '2026-10-23', played_at: 'a' },
      { day: '2026-10-23', played_at: 'b' },
      { day: '2026-10-22', played_at: 'c' },
    ]);
    expect(groups.map((g) => [g.day, g.items.length])).toEqual([
      ['2026-10-23', 2],
      ['2026-10-22', 1],
    ]);
  });

  it('writes lengths as the queue does', () => {
    expect(lengthWords(276)).toBe('4:36');
    expect(lengthWords(3730)).toBe('1:02:10');
    expect(lengthWords(null)).toBe('');
  });
});

describe('the range', () => {
  it('defaults to 7 days and is remembered', () => {
    expect(readRememberedRange()).toBe('7d');
    rememberRange('30d');
    expect(localStorage.getItem(HISTORY_RANGE_KEY)).toBe('30d');
    expect(readRememberedRange()).toBe('30d');
    localStorage.setItem(HISTORY_RANGE_KEY, 'forever');
    expect(readRememberedRange()).toBe('7d');
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readRememberedRange()).toBe('7d');
    expect(() => rememberRange('today')).not.toThrow();
  });

  it('offers a wider range when empty', () => {
    expect(emptyTitle('music', '7d', false)).toBe('Nothing played in the last 7 days');
    expect(emptyTitle('podcast', 'all', false)).toBe('No episodes played yet');
    expect(emptyTitle('music', '7d', true)).toBe('Nothing you played matches');
    expect(widerRange('7d')).toBe('30d');
    expect(widerRange('today')).toBe('7d');
    expect(widerRange('all')).toBeNull();
  });
});

describe('spoken rows', () => {
  it('splits the progress so it can be coloured, and says sample for audiobooks', () => {
    expect(
      spokenParts({
        play_id: 1,
        kind: 'podcast',
        media_id: 'g',
        title: 'Episode 48',
        subtitle: 'Quiet Rooms',
        played_at: '',
        duration_s: 1800,
        position_s: 420,
      }),
    ).toEqual({ lead: 'Quiet Rooms', progress: '23 min left', resumable: true });
    expect(
      spokenParts({
        play_id: 2,
        kind: 'audiobook',
        media_id: 'b',
        title: 'Tide Lines',
        subtitle: 'A. Author',
        played_at: '',
        finished: true,
      }),
    ).toEqual({ lead: 'A. Author · sample', progress: 'Finished', resumable: false });
  });
});
