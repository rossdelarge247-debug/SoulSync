/** Browse's logic (37f; 418, 435): the chips' query, closest first, the step's words. */
import { describe, expect, it } from 'vitest';

import {
  browseQuery,
  closestFirst,
  countLine,
  DEFAULT_CHIPS,
  keyWords,
  lengthWords,
  mixKeys,
  nearWords,
  readinessWords,
  rowFromApi,
  stepWords,
  tempoWords,
  type BrowseRow,
} from './dj-browse.logic';

const FERRY = { id: '2', title: 'Night Ferry', bpm: 124, key: '8A' };

function row(over: Partial<BrowseRow>): BrowseRow {
  return {
    id: 'x',
    title: 'X',
    artist: 'Marram',
    image: null,
    durationS: 288,
    key: '8A',
    keyUncertain: false,
    bpm: 124,
    gridReady: true,
    ...over,
  };
}

describe('the chips (418)', () => {
  it('near and keys are on by default; starred and recently played off', () => {
    expect(DEFAULT_CHIPS).toEqual({ near: true, keys: true, starred: false, recent: false });
  });

  it('their words: "117–131, and 62 or 248" and "8A · 7A · 9A · 8B"', () => {
    expect(nearWords(124)).toBe('117–131, and 62 or 248');
    expect(mixKeys('8A')).toEqual(['8A', '7A', '9A', '8B']);
    expect(mixKeys('1B')).toEqual(['1B', '12B', '2B', '1A']);
    expect(mixKeys(null)).toEqual([]);
  });

  it('the default query: closest first around A, ±6% with half and double time, keys that mix, A left out', () => {
    const q = browseQuery(FERRY, DEFAULT_CHIPS, '');
    expect(Object.fromEntries(q)).toEqual({
      sort: 'closest',
      limit: '50',
      near: '124',
      near_key: '8A',
      tempo: 'near',
      key: '8A:mix',
      exclude: '2',
    });
  });

  it('each chip off or on, and the search', () => {
    const q = browseQuery(
      FERRY,
      { near: false, keys: false, starred: true, recent: true },
      '  tide ',
    );
    expect(q.get('tempo')).toBeNull();
    expect(q.get('key')).toBeNull();
    expect(q.get('starred')).toBe('1');
    expect(q.get('recent')).toBe('1');
    expect(q.get('q')).toBe('tide');
    // "closest" still means near A
    expect(q.get('near')).toBe('124');
  });

  it('A without a BPM or key: no tempo or key filter to ask for', () => {
    const q = browseQuery({ id: '2', title: 'x', bpm: null, key: null }, DEFAULT_CHIPS, '');
    expect(q.get('tempo')).toBeNull();
    expect(q.get('key')).toBeNull();
    expect(q.get('near')).toBeNull();
  });
});

describe('closest first (37f): the tempo gap, then the key step', () => {
  it('sorts by gap, then steps, then title', () => {
    const rows = [
      row({ id: 'sand', title: 'Sand Script', bpm: 128, key: '7A' }),
      row({ id: 'low', title: 'Low Tide', bpm: 62, key: '8B' }),
      row({ id: 'harbour', title: 'Harbour Lights', bpm: 126, key: '8A' }),
      row({ id: 'copper', title: 'Copper Sky', bpm: 124, key: '8A' }),
      row({ id: 'static', title: 'Static Bloom', bpm: 123, key: '9A' }),
      row({ id: 'none', title: 'No data', bpm: null, key: null }),
    ];
    expect(closestFirst(FERRY, rows).map((r) => r.id)).toEqual([
      'copper',
      'low',
      'static',
      'harbour',
      'sand',
      'none',
    ]);
  });
});

describe('the step in words (37f)', () => {
  it('the board’s rows', () => {
    expect(stepWords(FERRY, { bpm: 126, key: '8A' })).toBe('+1.6%');
    expect(stepWords(FERRY, { bpm: 124, key: '8A' })).toBe('same');
    expect(stepWords(FERRY, { bpm: 123, key: '9A' })).toBe('−0.8% · +1 on the wheel');
    expect(stepWords(FERRY, { bpm: 62, key: '8B' })).toBe('half time · relative');
    expect(stepWords(FERRY, { bpm: 128, key: '7A' })).toBe('+3.2% · −1 on the wheel');
  });

  it('double time, a gap after halving, far keys, nothing known', () => {
    expect(tempoWords(124, 248)).toBe('double time');
    expect(tempoWords(124, 63)).toBe('half time +1.6%');
    expect(keyWords('8A', '11A')).toBe('3 steps on the wheel');
    expect(keyWords('8A', '8A')).toBe('');
    expect(stepWords({ ...FERRY, bpm: null, key: null }, { bpm: 126, key: '8A' })).toBe('');
  });
});

describe('a row', () => {
  it('from the route: milliseconds to seconds, the DJ data, the grid', () => {
    const r = rowFromApi({
      id: 8,
      title: 'Harbour Lights',
      artist_name: 'Marram',
      duration_ms: 288_000,
      grid_ready: true,
      dj: { bpm: 126, key: '8A', key_uncertain: true },
    });
    expect(r).toMatchObject({
      id: '8',
      durationS: 288,
      bpm: 126,
      key: '8A',
      keyUncertain: true,
      gridReady: true,
    });
    expect(lengthWords(r.durationS)).toBe('4:48');
    expect(lengthWords(null)).toBe('–');
  });

  it('readiness and "a version of A"', () => {
    expect(readinessWords(row({ gridReady: true }), FERRY)).toBe('has its grid');
    expect(readinessWords(row({ gridReady: false }), FERRY)).toBe(
      'not analysed yet · loads, then analyses',
    );
    expect(readinessWords(row({ title: 'Night Ferry (Dub)' }), FERRY)).toBe(
      'has its grid · a version of A',
    );
  });

  it('the count line', () => {
    expect(countLine(38, false)).toBe('38 tracks fit · the smallest tempo and key step first');
    expect(countLine(1, false)).toBe('1 track fits · the smallest tempo and key step first');
    expect(countLine(0, false)).toBe('Nothing fits these chips');
    expect(countLine(0, true)).toBe('Nothing matches');
  });
});
