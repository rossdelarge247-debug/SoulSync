import { describe, expect, it } from 'vitest';

import type { AudiobookItem } from '../audiobooks/-audiobooks.types';

import {
  artistResults,
  authorResults,
  followNote,
  kindFromFilter,
  labelResults,
  lookbackWords,
  podcastResults,
  sourceName,
} from './-wanted.follow';

const book = (title: string, author: string, extra: Partial<AudiobookItem> = {}) =>
  ({
    asin: title,
    title,
    subtitle: '',
    authors: [{ name: author, asin: null }],
    narrators: [],
    author_names: [author],
    narrator_names: [],
    series: [],
    release_date: '2020-01-01',
    cover_url: '',
    owned: false,
    ...extra,
  }) as unknown as AudiobookItem;

describe('the four kinds', () => {
  it('each names its source, and the Kind filter opens on its kind', () => {
    expect(sourceName('artist')).toBe('Deezer');
    expect(sourceName('artist', 'musicbrainz')).toBe('MusicBrainz');
    expect(sourceName('label')).toBe('MusicBrainz');
    expect(sourceName('podcast')).toBe('Apple Podcasts');
    expect(sourceName('author')).toBe('Audible · Apple');
    expect(
      ['all', 'artists', 'labels', 'podcasts', 'authors'].map((k) => kindFromFilter(k as never)),
    ).toEqual(['artist', 'artist', 'label', 'podcast', 'author']);
  });
});

describe('results', () => {
  it('artists are round, and one followed already is marked', () => {
    const rows = artistResults(
      [
        { id: '1', name: 'Pale Harbour', extra: '12k fans' },
        { id: '2', name: 'Halide' },
      ],
      new Set(['pale harbour']),
    );
    expect(rows.map((r) => [r.name, r.meta, r.round, r.following])).toEqual([
      ['Pale Harbour', '12k fans', true, true],
      ['Halide', '', true, false],
    ]);
  });

  it('labels are square with their type and area, followed by id or by the search', () => {
    const rows = labelResults(
      [
        { id: 'a', name: 'Hessle Audio', type: 'original production', area: 'UK' },
        { id: 'b', name: 'Quiet Rooms', type: 'imprint', is_watching: true },
        { id: '', name: 'No id' },
      ],
      new Set(['a']),
    );
    expect(rows.map((r) => [r.name, r.meta, r.round, r.following, r.initials])).toEqual([
      ['Hessle Audio', 'Original production · UK', false, true, 'HA'],
      ['Quiet Rooms', 'Imprint', false, true, 'QR'],
    ]);
  });

  it('podcasts are square, by their author with their episode count', () => {
    const rows = podcastResults(
      [
        {
          title: 'Quiet Rooms Radio',
          author: 'The Quiet Rooms',
          description: '',
          feed_url: 'f1',
          explicit: false,
          categories: [],
          episode_count: 48,
        },
      ],
      new Set(['f2']),
    );
    expect(rows[0]).toMatchObject({
      name: 'Quiet Rooms Radio',
      meta: 'by The Quiet Rooms · 48 episodes',
      round: false,
      following: false,
    });
  });

  it('authors are the books grouped by their first author, the name match first', () => {
    const rows = authorResults(
      [
        book('Piranesi', 'Susanna Clarke', { owned: true, release_date: '2020-09-15' }),
        book('Jonathan Strange', 'Susanna Clarke', { release_date: '2004-09-08' }),
        book('A Clarke Companion', 'Someone Else'),
        book('The Dispossessed', 'Ursula K. Le Guin'),
        book('Lathe of Heaven', 'Ursula K. Le Guin'),
        book('Earthsea', 'Ursula K. Le Guin'),
      ],
      new Set(['ursula k. le guin']),
      'clarke',
    );
    expect(rows.map((r) => [r.name, r.meta, r.have, r.following])).toEqual([
      ['Susanna Clarke', '2 audiobooks · latest Piranesi', 'You have 1', false],
      ['Ursula K. Le Guin', '3 audiobooks · latest The Dispossessed', 'You have none', true],
      ['Someone Else', '1 audiobook · latest A Clarke Companion', 'You have none', false],
    ]);
  });
});

describe('the meta line', () => {
  it('says when it is checked and what happens to what is already out', () => {
    expect(followNote('artist', 'every 24 hours', { lookback: '30' })).toBe(
      'Checked every 24 hours with your other follows. The first check adds what came out in the last 30 days; after that, only new releases go to Wanted.',
    );
    expect(followNote('podcast', 'every hour', { episodes: 42 })).toBe(
      'Checked every hour with your other follows. The 42 episodes already out stay where they are; open the podcast to download any of them.',
    );
    expect(followNote('label', '')).toMatch(/^Not checked on a schedule right now/);
    expect(followNote('author', 'every 7 days')).toContain('Only books that come out from today');
    expect(lookbackWords('all')).toBe('The first check adds everything they’ve released');
  });
});
