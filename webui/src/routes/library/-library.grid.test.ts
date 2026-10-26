import { describe, expect, it } from 'vitest';

import type { LibraryRelease } from './-library.types';

import {
  EMPTY_SELECTION,
  addedSentence,
  isChecked,
  matchesSelectAll,
  releaseHref,
  releaseMeta,
  releaseTag,
  selectAll,
  selectionBody,
  selectionCount,
  selectionTracks,
  toggleRelease,
} from './-library.grid';
import { pick, resolveLibrarySearch, librarySearchSchema, ALBUM_SHOWS } from './-library.types';

function release(over: Partial<LibraryRelease> & { id: string }): LibraryRelease {
  return {
    kind: 'library',
    album_id: 1,
    title: 'Night Ferry',
    artist_id: '1',
    artist_name: 'Pale Harbour',
    year: 2023,
    art_url: null,
    genres: ['Ambient'],
    album_type: 'album',
    tracks_total: 12,
    tracks_owned: 12,
    below_target: 0,
    format: 'FLAC 24/96',
    state: 'owned',
    wanted: null,
    added_at: null,
    source: null,
    source_id: null,
    ...over,
  };
}

const missing = (id: string, over: Partial<LibraryRelease> = {}) =>
  release({
    id,
    kind: 'missing',
    album_id: null,
    state: 'missing',
    tracks_owned: 0,
    format: null,
    tracks_total: 9,
    ...over,
  });

describe('a tile', () => {
  it('meta: format for an album you have whole, tracks otherwise', () => {
    expect(releaseMeta(release({ id: 'a' }))).toBe('Pale Harbour · 2023 · FLAC 24/96');
    expect(releaseMeta(release({ id: 'a', state: 'partial', tracks_owned: 11 }))).toBe(
      'Pale Harbour · 2023 · 12 tracks',
    );
    expect(releaseMeta(missing('m', { year: null, tracks_total: 1 }))).toBe(
      'Pale Harbour · 1 track',
    );
  });

  it('tags only for a state that is not "you have it"', () => {
    expect(releaseTag(release({ id: 'a' }))).toBeNull();
    expect(releaseTag(release({ id: 'a', state: 'below_target', below_target: 3 }))).toEqual({
      tone: 'warning',
      label: 'Below quality target',
    });
    expect(releaseTag(release({ id: 'a', state: 'partial', tracks_owned: 11 }))).toEqual({
      tone: 'info',
      label: '11 of 12 found',
    });
    expect(releaseTag(missing('m', { wanted: { status: 'not_found', tracks: 9 } }))?.label).toBe(
      'Wanted · not found',
    );
    expect(releaseTag(missing('m', { wanted: { status: 'searching', tracks: 9 } }))?.label).toBe(
      'Wanted · searching',
    );
    expect(releaseTag(missing('m'))).toEqual({ tone: 'neutral', label: 'Not in your library' });
  });

  it('opens the Artist page, at the album when you have it', () => {
    expect(releaseHref(release({ id: 'a', album_id: 7 }))).toBe('/artist-detail/library/1?album=7');
    expect(releaseHref(missing('m'))).toBe('/artist-detail/library/1');
    expect(releaseHref(missing('m', { artist_id: null }))).toBeNull();
  });
});

describe('a selection', () => {
  const a = missing('m1');
  const b = missing('m2', { genres: ['Jazz'] });
  const wanted = missing('m3', { wanted: { status: 'searching', tracks: 9 } });
  const owned = release({ id: 'album:1' });
  const filter = { show: 'missing', genre: '', q: '' };

  it('hand picks count their tracks', () => {
    let s = toggleRelease(EMPTY_SELECTION, a);
    s = toggleRelease(s, owned);
    expect(selectionCount(s)).toBe(2);
    expect(selectionTracks(s)).toBe(21);
    expect(selectionBody(s)).toEqual({ release_ids: ['m1', 'album:1'] });
    s = toggleRelease(s, a);
    expect(isChecked(s, a)).toBe(false);
    expect(selectionCount(s)).toBe(1);
  });

  it('"Select all" takes the filter; unticking one excludes it; a wanted one never matches', () => {
    let s = selectAll(toggleRelease(EMPTY_SELECTION, a), { filter, count: 40, tracks: 300 });
    expect(isChecked(s, a) && isChecked(s, b)).toBe(true);
    expect(isChecked(s, wanted)).toBe(false);
    // a was picked by hand and matches: it isn't counted twice
    expect(selectionCount(s)).toBe(40);
    s = toggleRelease(s, b);
    expect(selectionCount(s)).toBe(39);
    expect(selectionTracks(s)).toBe(291);
    s = toggleRelease(s, owned);
    expect(selectionBody(s)).toEqual({ release_ids: ['album:1'], filter, exclude_ids: ['m2'] });
    expect(matchesSelectAll(b, { ...filter, genre: 'ambient' })).toBe(false);
    expect(matchesSelectAll(a, { ...filter, q: 'harbour' })).toBe(true);
  });
});

describe('the toast', () => {
  it('says what happened to each', () => {
    const base = {
      added: 0,
      already_wanted: 0,
      already_have: 0,
      failed: 0,
      refused: 0,
      asks_first: false,
    };
    expect(addedSentence({ ...base, added: 1, already_have: 2 })).toBe(
      'Added 1 album to Wanted · 2 you already have',
    );
    expect(addedSentence({ ...base, added: 3, asks_first: true })).toBe(
      'Asked for 3 albums; an admin approves them before anything downloads',
    );
    expect(addedSentence({ ...base, failed: 1, refused: 2 })).toBe(
      "2 past your request limit · 1 couldn't be found on a metadata service",
    );
    expect(addedSentence(base)).toBe('Nothing to add.');
  });
});

describe('the URL', () => {
  it('fills defaults when read and reads old values as new ones', () => {
    const raw = librarySearchSchema.parse({
      view: 'albums',
      sort: 'year_desc',
      genre: ' Ambient ',
      show: '',
    });
    expect(raw).toEqual({ view: 'albums', sort: 'year', genre: 'ambient' });
    expect(resolveLibrarySearch(raw)).toEqual({
      view: 'albums',
      tab: 'albums',
      kind: 'music',
      range: '',
      show: '',
      genre: 'ambient',
      sort: 'year',
      q: '',
      set: '',
      bpm: '',
      key: '',
    });
    expect(librarySearchSchema.parse({ view: 'nope', tab: 'x', q: 123 })).toEqual({ q: '123' });
    // Sets: which page of the planner; anything else is dropped
    expect(librarySearchSchema.parse({ view: 'sets', set: '7' })).toEqual({
      view: 'sets',
      set: '7',
    });
    expect(librarySearchSchema.parse({ view: 'sets', set: 'famous' })).toEqual({
      view: 'sets',
      set: 'famous',
    });
    expect(librarySearchSchema.parse({ view: 'sets', set: '../x' })).toEqual({ view: 'sets' });
    // Tracks (the DJ data): the BPM range and the key ride along as text
    expect(librarySearchSchema.parse({ view: 'tracks', bpm: '120-128', key: '8A:mix' })).toEqual({
      view: 'tracks',
      bpm: '120-128',
      key: '8A:mix',
    });
    // Listening history (13a): its kind and range, unknown values dropped
    expect(librarySearchSchema.parse({ view: 'history', kind: 'podcast', range: '30d' })).toEqual({
      view: 'history',
      kind: 'podcast',
      range: '30d',
    });
    expect(librarySearchSchema.parse({ view: 'history', kind: 'music', range: 'year' })).toEqual({
      view: 'history',
    });
    expect(pick('nope', ALBUM_SHOWS)).toBe('all');
    expect(pick('below', ALBUM_SHOWS)).toBe('below');
  });
});
