import { afterEach, describe, expect, it } from 'vitest';

import type { FoundItem, WantedItem, WantedTrack } from './-wanted.types';

import {
  VIEW_STORAGE_KEY,
  circleSize,
  nebulaArtists,
  nebulaColumns,
  panelItemMeta,
  readStoredView,
  removeAllLabel,
  searchAllLabel,
  storeView,
  stuckItem,
  stuckSentence,
  wantOthersLabel,
} from './-wanted.nebula';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const sql = (msAgo: number) => new Date(NOW - msAgo).toISOString().slice(0, 19).replace('T', ' ');

function track(id: string, tries: number, lastTriedAgo = 0, error = ''): WantedTrack {
  return {
    id,
    title: id,
    artist: '',
    album: '',
    albumType: 'album',
    albumTotal: 11,
    image: '',
    addedAt: sql(7 * 86_400_000),
    tries,
    lastTried: lastTriedAgo ? sql(lastTriedAgo) : '',
    lastError: error,
    sourceType: 'manual',
    sourceInfo: null,
    qualityProfileId: 1,
  };
}

function item(
  title: string,
  artist: string,
  o: { tries?: number; error?: string; tracks?: number; image?: string; ago?: number } = {},
): WantedItem {
  const tries = o.tries ?? 0;
  const tracks = Array.from({ length: o.tracks ?? 1 }, (_, i) =>
    track(`${title}-${i}`, tries, o.ago ?? 2 * 3_600_000, o.error ?? ''),
  );
  return {
    key: `release:${artist}:${title}`,
    kind: tracks.length > 1 ? 'album' : 'track',
    title,
    artist,
    album: title,
    image: o.image ?? '',
    tracks,
    trackIds: tracks.map((t) => t.id),
    albumTotal: 11,
    addedAt: sql(7 * 86_400_000),
    tries,
    lastError: o.error ?? '',
    sourceType: 'manual',
    sourceInfo: null,
    qualityProfileId: 1,
    status: tries >= 3 ? 'not-found' : 'searching',
  };
}

function found(title: string, artist: string): FoundItem {
  return {
    key: `found:${title}`,
    id: title,
    title,
    artist,
    album: title,
    quality: 'FLAC',
    image: '',
    foundAt: sql(3_600_000),
  };
}

afterEach(() => window.localStorage.removeItem(VIEW_STORAGE_KEY));

describe('nebulaArtists', () => {
  it('groups by artist whatever the case, busiest first, filed under the worst', () => {
    const artists = nebulaArtists(
      [
        item('Lantern', 'Saltmarsh', { tries: 14, tracks: 11 }),
        item('Ferry Songs', 'saltmarsh', { tries: 1 }),
        item('Tidewater', 'Pale Harbour'),
        item('Halide One', 'Halide'),
        item('Halide Two', 'Halide'),
        item('Halide Three', 'Halide'),
      ],
      [found('Static Bloom', 'Birch & Wire'), found('Low', 'Saltmarsh')],
    );
    expect(artists.map((a) => [a.name, a.group, a.count])).toEqual([
      ['Halide', 'searching', 3],
      ['Saltmarsh', 'not-found', 2],
      ['Birch & Wire', 'found', 1],
      ['Pale Harbour', 'searching', 1],
    ]);
    // a found-only artist counts what was found
    expect(artists.find((a) => a.name === 'Birch & Wire')!.found).toHaveLength(1);
  });

  it('the find filter narrows the artists by title, artist or album', () => {
    const artists = nebulaArtists(
      [item('Lantern', 'Saltmarsh'), item('Tidewater', 'Pale Harbour')],
      [],
      'tide',
    );
    expect(artists.map((a) => a.name)).toEqual(['Pale Harbour']);
  });
});

describe('nebulaColumns', () => {
  it('three columns, left to right as the Show filters run, counting things not artists', () => {
    const columns = nebulaColumns(
      [
        item('Lantern', 'Saltmarsh', { tries: 14 }),
        item('Ferry Songs', 'Saltmarsh', { tries: 1 }),
        item('Tidewater', 'Pale Harbour'),
      ],
      [found('Static Bloom', 'Birch & Wire')],
    );
    expect(columns.map((c) => [c.label, c.count, c.artists.map((a) => a.name)])).toEqual([
      ['Searching', 2, ['Pale Harbour']],
      ['Not found yet', 1, ['Saltmarsh']],
      ['Found this week', 1, ['Birch & Wire']],
    ]);
    expect(columns.map((c) => c.tone)).toEqual(['info', 'neutral', 'success']);
  });
});

describe('circleSize', () => {
  it('96 for five or more, 72 for two to four, 56 for one', () => {
    expect([1, 2, 4, 5, 40].map(circleSize)).toEqual([56, 72, 72, 96, 96]);
  });
});

describe('stuckSentence', () => {
  it('the tries, which thing, what went wrong and when, in one sentence', () => {
    const [artist] = nebulaArtists(
      [
        item('Lantern', 'Saltmarsh', { tries: 14, error: 'User went offline', ago: 2 * 3_600_000 }),
        item('Ferry Songs', 'Saltmarsh', { tries: 1 }),
      ],
      [],
    );
    expect(stuckSentence(artist, NOW)).toBe(
      '14 tries with Lantern: user went offline. Last try 2 hours ago.',
    );
    expect(stuckItem(artist)?.title).toBe('Lantern');
  });

  it('says a match was never found when the tries left no reason, and leaves out "with" for one thing', () => {
    const [artist] = nebulaArtists([item('Lantern', 'Saltmarsh', { tries: 5 })], []);
    expect(stuckSentence(artist, NOW)).toBe(
      '5 tries: none of your sources had a match. Last try 2 hours ago.',
    );
  });

  it('reads a rejection the way the list does', () => {
    const [artist] = nebulaArtists(
      [
        item('Lantern', 'Saltmarsh', {
          tries: 3,
          error: "AcoustID verification failed: mismatch: 'Xtal' by 'Aphex Twin'",
        }),
      ],
      [],
    );
    expect(stuckSentence(artist, NOW)).toContain('the wrong song came back ("Xtal" by Aphex Twin)');
  });

  it('nothing stuck, no box', () => {
    const [artist] = nebulaArtists([item('Tidewater', 'Pale Harbour', { tries: 1 })], []);
    expect(stuckSentence(artist, NOW)).toBeNull();
    expect(stuckItem(artist)).toBeNull();
  });
});

describe('words', () => {
  it('the panel row meta: kind, tracks, quality, when it was added', () => {
    expect(panelItemMeta(item('Lantern', 'Saltmarsh', { tracks: 11 }), 'FLAC or better', NOW)).toBe(
      'Album · 11 tracks · FLAC or better · added 1 week ago',
    );
  });

  it('the action and link labels count what they act on', () => {
    expect([1, 2, 3].map(searchAllLabel)).toEqual([
      'Search now',
      'Search now for both',
      'Search now for all 3',
    ]);
    expect([1, 2, 5].map(removeAllLabel)).toEqual([
      'Remove from Wanted',
      'Remove both from Wanted',
      'Remove all 5 from Wanted',
    ]);
    expect(wantOthersLabel(1)).toBe('Want the 1 other release you’re missing');
    expect(wantOthersLabel(4)).toBe('Want the 4 other releases you’re missing');
  });
});

describe('the remembered view', () => {
  it('is the list until the nebula is picked, then the nebula', () => {
    expect(readStoredView()).toBe('list');
    storeView('nebula');
    expect(window.localStorage.getItem(VIEW_STORAGE_KEY)).toBe('nebula');
    expect(readStoredView()).toBe('nebula');
    storeView('list');
    expect(readStoredView()).toBe('list');
  });
});
