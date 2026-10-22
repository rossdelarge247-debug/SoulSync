import { describe, expect, it } from 'vitest';

import {
  checkRow,
  consequenceText,
  filterCandidates,
  isAlreadyMirrored,
  ownershipCounts,
  readLink,
  rowMeta,
  shortConsequence,
  shortMeta,
} from './mirror.model';

const tracks = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }];

describe('what a playlist adds', () => {
  it('counts the tracks you have, the ones already wanted and the rest', () => {
    const counts = ownershipCounts(tracks, {
      tracks: [
        { in_library: true },
        { in_wishlist: true },
        {},
        { in_library: true, in_wishlist: true },
      ],
    });
    expect(counts).toEqual({ total: 4, have: 2, wanted: 1, toAdd: 1 });
  });

  it('reads the artist from any of the services’ shapes', () => {
    expect(checkRow({ name: 'x', artists: [{ name: 'Pale Harbour' }] })).toEqual({
      name: 'x',
      artist: 'Pale Harbour',
    });
    expect(checkRow({ title: 'x', artist: 'Pale Harbour' })).toEqual({
      name: 'x',
      artist: 'Pale Harbour',
    });
    expect(checkRow({ name: 'x', artist_name: 'Pale Harbour' })).toEqual({
      name: 'x',
      artist: 'Pale Harbour',
    });
    expect(checkRow({ name: 'x', artists: ['Pale Harbour'] })).toEqual({
      name: 'x',
      artist: 'Pale Harbour',
    });
  });

  it('knows a mirror you already have by source and id', () => {
    const rows = [{ id: 1, source: 'spotify', source_playlist_id: 'p1' }];
    expect(isAlreadyMirrored(rows, { source: 'spotify', id: 'p1' })).toBe(true);
    expect(isAlreadyMirrored(rows, { source: 'deezer', id: 'p1' })).toBe(false);
    expect(isAlreadyMirrored(undefined, { source: 'spotify', id: 'p1' })).toBe(false);
  });
});

describe('the consequence line', () => {
  const base = { keepInSync: true, targetName: 'FLAC or better' };

  it('names the count, the target and when it starts', () => {
    expect(
      consequenceText({ ...base, counts: { total: 48, have: 31, wanted: 0, toAdd: 17 } }),
    ).toBe(
      '17 tracks will be added to Wanted at FLAC or better, your quality target, and SoulSync starts looking for them now.',
    );
    expect(consequenceText({ ...base, counts: { total: 3, have: 1, wanted: 1, toAdd: 1 } })).toBe(
      '1 track will be added to Wanted at FLAC or better, your quality target, and SoulSync starts looking for it now. 1 more track is on Wanted already.',
    );
  });

  it('says when there is nothing to add', () => {
    expect(consequenceText({ ...base, counts: { total: 3, have: 3, wanted: 0, toAdd: 0 } })).toBe(
      'You already have every track. SoulSync keeps checking for new ones every 24 hours.',
    );
    expect(consequenceText({ ...base, counts: { total: 3, have: 1, wanted: 2, toAdd: 0 } })).toBe(
      'Nothing new goes to Wanted. 2 more tracks are on Wanted already.',
    );
    expect(consequenceText({ ...base, counts: { total: 0, have: 0, wanted: 0, toAdd: 0 } })).toBe(
      'This playlist has no tracks yet. SoulSync checks it again every 24 hours.',
    );
  });

  it('says it is still checking, and what happens with sync off', () => {
    expect(consequenceText({ ...base, counts: null })).toBe(
      'Checking which of its tracks you already have…',
    );
    expect(consequenceText({ ...base, keepInSync: false, counts: null })).toBe(
      'Saved to Mirrored playlists only. Nothing goes to Wanted until you run it from there.',
    );
  });

  it('has a shorter phone line', () => {
    expect(shortConsequence({ total: 48, have: 31, wanted: 0, toAdd: 17 }, true, 'FLAC')).toBe(
      '17 tracks will be added to Wanted at FLAC.',
    );
    expect(shortConsequence(null, false, 'FLAC')).toBe('Saved to Mirrored playlists only.');
  });
});

describe('rows and links', () => {
  const candidate = {
    source: 'spotify' as const,
    id: 'p1',
    name: 'Coastal evenings',
    owner: 'Ross',
    trackCount: 48,
  };

  it('describes a row', () => {
    expect(rowMeta(candidate)).toBe('by Ross · 48 tracks');
    expect(shortMeta(candidate, { total: 48, have: 31, wanted: 0, toAdd: 17 })).toBe(
      '48 tracks · you have 31',
    );
    expect(filterCandidates([candidate], 'ross')).toHaveLength(1);
    expect(filterCandidates([candidate], 'jazz')).toHaveLength(0);
  });

  it('reads Spotify and Deezer playlist links, and refuses the rest with a reason', () => {
    expect(
      readLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', true),
    ).toMatchObject({
      ok: true,
      candidate: { source: 'spotify', id: '37i9dQZF1DXcBWIGoYBM5M' },
    });
    expect(readLink('https://www.deezer.com/playlist/1234567', false)).toMatchObject({
      ok: true,
      candidate: { source: 'deezer', id: '1234567' },
    });
    const noSpotify = readLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', false);
    expect(noSpotify.ok).toBe(false);
    const album = readLink('https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv', true);
    expect(album).toEqual({
      ok: false,
      message: 'That is a Spotify album link. Paste a playlist link to mirror it.',
    });
    expect(readLink('not a link', true).ok).toBe(false);
  });
});
