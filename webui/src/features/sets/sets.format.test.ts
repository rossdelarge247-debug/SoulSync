import { describe, expect, it } from 'vitest';

import {
  SHAPES,
  dateWords,
  downMissing,
  haveLine,
  metaLine,
  metaLineShort,
  moveRow,
  ownLine,
  ownRest,
  resultMeta,
  rowsFromMatch,
  safeSourceLink,
  searchedLine,
  sourceLine,
  unsavedWords,
  wantLabel,
  whenWords,
} from './sets.format';

const SUMMARY = {
  tracks: 16,
  seconds: 91 * 60,
  bpm_min: 118,
  bpm_max: 127,
  smooth: 14,
  jumps: 1,
  unknown: 0,
  locked: 3,
};

describe('Sets words', () => {
  it('says the meta line as 22c and 22d draw it', () => {
    expect(metaLine(SUMMARY)).toBe(
      '16 tracks · 91 min · 118–127 BPM · 14 smooth steps, 1 jump · 3 locked',
    );
    expect(metaLineShort(SUMMARY)).toBe('16 tracks · 91 min · 14 smooth, 1 jump · 3 locked');
    expect(metaLine({ ...SUMMARY, smooth: 13, unknown: 1, locked: 0 })).toBe(
      '16 tracks · 91 min · 118–127 BPM · 13 smooth steps, 1 jump, 1 not known yet',
    );
    expect(metaLine({ ...SUMMARY, seconds: 124 * 60 })).toContain('2 h 4 min');
  });

  it('counts a match without the IDs (22f)', () => {
    const c = { owned: 14, version: 3, missing: 5, ids: 1, of: 22 };
    expect(ownLine(c)).toBe('You own 14 of 22');
    expect(ownRest(c)).toBe('3 more in another version · 5 missing');
  });

  it('names versions both ways', () => {
    expect(wantLabel('Dub')).toBe('Want the Dub');
    expect(wantLabel('Saltmarsh Remix')).toBe('Want the remix');
    expect(haveLine('the original')).toBe('You have the Original Mix');
    expect(haveLine('Radio Edit')).toBe('You have the Radio Edit');
  });

  it('says where a tracklist came from, quietly', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(sourceLine('mixesdb', '2026-10-10T10:00:00Z', now)).toBe(
      'Tracklist from MixesDB · edited 2 weeks ago',
    );
    expect(
      resultMeta({
        source: 'mixesdb',
        id: 'x',
        title: 't',
        date: '2019-05-12',
        tracks: 22,
        kind: 'mix',
      }),
    ).toBe('12 May 2019 · 22 tracks · MixesDB');
    expect(
      resultMeta({
        source: 'musicbrainz',
        id: 'x',
        title: 't',
        date: '2020-01-01',
        tracks: 24,
        kind: 'cd',
      }),
    ).toBe('Mix CD, 2020 · 24 tracks · MusicBrainz');
    expect(dateWords('2019-05')).toBe('May 2019');
    expect(whenWords(now / 1000 - 86400, now)).toBe('yesterday');
  });

  it('says which sources were asked and what a down one leaves out (22r)', () => {
    expect(
      searchedLine({
        mixesdb: { state: 'ok' },
        musicbrainz: { state: 'down' },
        discogs: { state: 'off', why: 'token' },
      }),
    ).toBe('Searched MixesDB and MusicBrainz.');
    expect(downMissing(['mixesdb'])).toBe(
      'so radio and club mixes are missing below. Mix CDs are here.',
    );
  });

  it('keeps a match as set rows, with each version choice', () => {
    const rows = rowsFromMatch(
      [
        {
          artist: 'A',
          title: 'B (Dub)',
          at: '09:30',
          mbid: null,
          note: '',
          state: 'version',
          track: { id: '5' } as never,
          confidence: 0.8,
          matched_by: 'title',
          have: 'the original',
          want_version: 'Dub',
        },
        {
          artist: 'V',
          title: 'G',
          at: '',
          mbid: null,
          note: '',
          state: 'missing',
          track: null,
          confidence: 0,
          matched_by: null,
        },
      ],
      { 0: true },
    );
    expect(rows[0]).toMatchObject({
      track_id: '5',
      state: 'version',
      want: 'wanted',
      version: 'Dub',
      at: '09:30',
    });
    expect(rows[1]).toMatchObject({ track_id: null, state: 'missing', want: 'yours' });
  });

  it('keeps locked rows in their places (Lock holds)', () => {
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    const rows = [
      { id: 'a', locked: false },
      { id: 'L', locked: true },
      { id: 'b', locked: false },
      { id: 'c', locked: false },
      { id: 'M', locked: true },
      { id: 'd', locked: false },
    ];
    // a locked row doesn't move at all
    expect(moveRow(rows, 1, 3)).toBe(rows);
    // moving others never shifts a locked one
    expect(ids(moveRow(rows, 0, 5))).toEqual(['b', 'L', 'c', 'd', 'M', 'a']);
    expect(ids(moveRow(rows, 5, 0))).toEqual(['d', 'L', 'a', 'b', 'M', 'c']);
    expect(ids(moveRow(rows, 2, 3))).toEqual(['a', 'L', 'c', 'b', 'M', 'd']);
    // a drop on a locked row's place lands on the nearest free place
    expect(ids(moveRow(rows, 0, 1))).toEqual(['a', 'L', 'b', 'c', 'M', 'd']);
    expect(ids(moveRow(rows, 0, 4))).toEqual(['b', 'L', 'c', 'a', 'M', 'd']);
    expect(ids(moveRow(rows, 5, 4))).toEqual(['a', 'L', 'b', 'c', 'M', 'd']);
    expect(ids(moveRow(rows, 5, 1))).toEqual(['a', 'L', 'd', 'b', 'M', 'c']);
  });

  it('only links to a source’s own pages', () => {
    expect(safeSourceLink('https://www.mixesdb.com/w/2019_-_x')).toBe(
      'https://www.mixesdb.com/w/2019_-_x',
    );
    expect(safeSourceLink('https://musicbrainz.org/release/abc')).toBe(
      'https://musicbrainz.org/release/abc',
    );
    expect(safeSourceLink('javascript:alert(1)')).toBeNull();
    expect(safeSourceLink('https://www.mixesdb.com.evil.example/w/x')).toBeNull();
    expect(safeSourceLink('https://evil.example/?https://www.discogs.com/release/1')).toBeNull();
    expect(safeSourceLink(null)).toBeNull();
  });

  it('moves a row, and the six shapes stay in 1–10', () => {
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    const plain = (...names: string[]) => names.map((id) => ({ id, locked: false }));
    expect(ids(moveRow(plain('a', 'b', 'c', 'd'), 0, 2))).toEqual(['b', 'c', 'a', 'd']);
    expect(ids(moveRow(plain('a', 'b', 'c'), 2, 0))).toEqual(['c', 'a', 'b']);
    expect(ids(moveRow(plain('a', 'b'), 5, 0))).toEqual(['a', 'b']);
    for (const shape of Object.values(SHAPES))
      for (let t = 0; t <= 1; t += 0.05) {
        expect(shape.at(t)).toBeGreaterThanOrEqual(1);
        expect(shape.at(t)).toBeLessThanOrEqual(10);
      }
  });
});

describe('what isn’t saved (the “changed somewhere else” Notice)', () => {
  const row = (id: string, title: string) => ({
    track_id: id,
    artist: 'x',
    title,
    state: 'owned' as const,
  });
  it('names what was added, removed and renamed', () => {
    expect(
      unsavedWords({
        savedRows: [row('1', 'Copper Sky'), row('2', 'Undertow')],
        rows: [row('1', 'Copper Sky'), row('3', 'Night Ferry')],
        savedName: 'Sunday',
        name: 'Later',
      }),
    ).toBe('Not saved here: Night Ferry added, Undertow removed, the name “Later”.');
  });

  it('keeps a long list short: the first five, then how many more (L-B)', () => {
    const many = Array.from({ length: 40 }, (_v, i) => row(String(i + 10), `Track ${i + 1}`));
    const words = unsavedWords({ savedRows: [], rows: many, savedName: 's', name: 's' });
    expect(words).toBe(
      'Not saved here: Track 1 added, Track 2 added, Track 3 added, Track 4 added, Track 5 added, …and 35 more.',
    );
    expect(words.length).toBeLessThan(140);
  });

  it('order, notes or styles only', () => {
    expect(
      unsavedWords({
        savedRows: [row('1', 'A'), row('2', 'B')],
        rows: [row('2', 'B'), row('1', 'A')],
        savedName: 's',
        name: 's',
      }),
    ).toBe('Not saved here: your changes to the order, notes or styles.');
  });
});
