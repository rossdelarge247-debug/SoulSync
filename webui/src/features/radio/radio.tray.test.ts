/**
 * The expanded player's radio words (Ross, 2026-10-23): the readout, Heard
 * today's rows, the station's possessive, the Visuals header, our own logo
 * route only, and the stations played in this browser.
 */

import { describe, expect, it } from 'vitest';

import type { HeardItem, RadioSessionState, Station } from './radio.types';

import {
  heardFold,
  heardRowView,
  heardToday,
  stationPossessive,
  streamReadout,
} from './radio.format';
import {
  readRecentStations,
  RECENT_STATIONS_KEY,
  RECENT_STATIONS_MAX,
  recentAsStation,
  rememberStation,
} from './radio.recent';
import { ownLogo, radioVisualsHeader } from './radio.scan';

const K = `${RECENT_STATIONS_KEY}:1`;

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

const quality = { codec: 'AAC', bitrate_kbps: 256, lossless: false, label: 'AAC 256 kbps' };

function item(over: Partial<HeardItem>): HeardItem {
  return {
    id: 1,
    heard_at: 0,
    station_id: 'nts-1',
    station_name: 'NTS 1',
    artist: 'Pale Harbour',
    title: 'Harbour Light',
    release: 'Lantern',
    source: 'station_feed',
    state: 'not_added',
    added_at: null,
    added_by_auto_add: false,
    duration_s: null,
    reason: null,
    below_target: null,
    track_id: null,
    ...over,
  };
}

describe('streamReadout', () => {
  it('names the stream and the path', () => {
    const stream = {
      label: 'AAC 256 kbps (best offered)',
      codec: 'AAC',
      bitrate_kbps: 256,
      lossless: false,
    };
    expect(streamReadout(stream, null, 'relay')).toBe('AAC 256 kbps · relayed');
    expect(streamReadout(stream, null, 'direct')).toBe('AAC 256 kbps · direct');
    expect(
      streamReadout({ codec: 'FLAC', bitrate_kbps: 1000, lossless: true }, null, 'relay'),
    ).toBe('FLAC · relayed');
    expect(streamReadout(null, { quality }, null)).toBe('AAC 256 kbps');
    expect(streamReadout(null, null, null)).toBe('—');
  });
});

describe('Heard today', () => {
  it('keeps today’s rows, newest first', () => {
    const now = new Date(2026, 9, 23, 15, 0).getTime();
    const s = (h: number) => new Date(2026, 9, 23, h, 0).getTime() / 1000;
    const rows = heardToday(
      [
        item({ id: 1, heard_at: s(10) }),
        item({ id: 2, heard_at: s(14) }),
        item({ id: 3, heard_at: new Date(2026, 9, 22, 23).getTime() / 1000 }),
      ],
      now,
    );
    expect(rows.map((r) => r.id)).toEqual([2, 1]);
  });

  it('gives each row its one action, or its state in words', () => {
    expect(heardRowView(item({ state: 'not_added' }))).toMatchObject({
      title: 'Harbour Light',
      line: 'Pale Harbour · Lantern · from the station',
      action: 'add',
      status: null,
    });
    expect(heardRowView(item({ state: 'in_library', below_target: true })).action).toBe('upgrade');
    expect(heardRowView(item({ state: 'in_library' })).status).toEqual({
      label: 'In your library',
      tone: 'success',
    });
    expect(heardRowView(item({ state: 'on_wanted' })).status?.tone).toBe('info');
    const unnamed = heardRowView(item({ state: 'not_identified', title: null, duration_s: 480 }));
    expect(unnamed).toMatchObject({
      title: 'Not identified',
      line: 'About 8 minutes · probably a mix or talk',
      action: null,
    });
  });
});

describe('stationPossessive', () => {
  it('uses the whole name', () => {
    expect(stationPossessive('NTS 1')).toBe('NTS 1’s');
    expect(stationPossessive('Radio Paradise · Main Mix')).toBe('Radio Paradise · Main Mix’s');
    expect(stationPossessive('Worldwide Sounds')).toBe('Worldwide Sounds’');
  });
});

describe('the Visuals header for a station', () => {
  const station = {
    id: 'nts-1',
    name: 'NTS 1',
    logo_url: '/api/radio/stations/nts-1/logo?v=1',
  } as Station;
  const base = (np: RadioSessionState['nowPlaying']) => ({
    station,
    nowPlaying: np,
    scan: null,
    skew: 0,
  });

  it('names the identified track over "artist · station"', () => {
    const np = {
      station_id: 'nts-1',
      state: 'identified' as const,
      track: { artist: 'Pale Harbour', title: 'Harbour Light', release: null, art_url: null },
      source: 'station_feed' as const,
      identified_at: 100,
      started_at: null,
      reason: null,
      library: null,
      on_wanted: false,
      previous_title: null,
      now: 110,
      playing: true,
    };
    expect(radioVisualsHeader(base(np))).toEqual({
      title: 'Harbour Light',
      line: 'Pale Harbour · NTS 1',
      art: '/api/radio/stations/nts-1/logo?v=1',
    });
    expect(
      radioVisualsHeader(
        base({ ...np, track: { ...np.track, art_url: 'https://img.example/a.jpg' } }),
      )?.art,
    ).toBe('https://img.example/a.jpg');
    expect(
      radioVisualsHeader(
        base({ ...np, track: { ...np.track, art_url: 'http://img.example/a.jpg' } }),
      )?.art,
    ).toBe('/api/radio/stations/nts-1/logo?v=1');
  });

  it('names the station while nothing is identified, and nothing without a station', () => {
    expect(radioVisualsHeader(base(null))).toEqual({
      title: 'NTS 1',
      line: 'Live · Listening…',
      art: '/api/radio/stations/nts-1/logo?v=1',
    });
    expect(radioVisualsHeader({ station: null, nowPlaying: null, scan: null, skew: 0 })).toBeNull();
  });

  it('takes only our own logo route', () => {
    expect(ownLogo('/api/radio/stations/kexp/logo?v=2')).toBe('/api/radio/stations/kexp/logo?v=2');
    expect(ownLogo('https://evil.example.com/x.png')).toBeNull();
    expect(ownLogo('/api/radio/stations/../x')).toBeNull();
    expect(ownLogo('')).toBeNull();
  });
});

describe('Recent stations (kept in this browser)', () => {
  const nts = {
    id: 'nts-1',
    name: 'NTS 1',
    logo_url: '',
    genre: 'Eclectic',
    kind_label: '',
    city: 'London',
    country: '',
    source: 'built_in',
    added_by: null,
    quality,
  } as unknown as Station;

  it('puts the newest first, once, and keeps eight', () => {
    const store = memory();
    for (let i = 0; i < 10; i++) rememberStation(store, K, { ...nts, id: `s${i}`, name: `S ${i}` });
    rememberStation(store, K, { ...nts, id: 's3', name: 'S 3' });
    const list = readRecentStations(store, K);
    expect(list).toHaveLength(RECENT_STATIONS_MAX);
    expect(list[0]!.id).toBe('s3');
    expect(list.filter((s) => s.id === 's3')).toHaveLength(1);
    expect(list.map((s) => s.id)).not.toContain('s0');
  });

  it('keeps only what a row and play() need', () => {
    const store = memory();
    rememberStation(store, K, nts);
    const raw = JSON.parse(store.getItem(K)!)[0];
    expect(Object.keys(raw).sort()).toEqual([
      'added_by',
      'city',
      'country',
      'genre',
      'id',
      'kind_label',
      'logo_url',
      'name',
      'played_at',
      'source',
    ]);
    expect(recentAsStation(readRecentStations(store, K)[0]!)).toMatchObject({
      id: 'nts-1',
      name: 'NTS 1',
      streams: [],
    });
  });

  it('reads nothing (not an error) from bad or missing storage', () => {
    const store = memory();
    store.setItem(K, '{nope');
    expect(readRecentStations(store, K)).toEqual([]);
    store.setItem(K, JSON.stringify([{ id: 1 }, { id: 'x', name: '' }, 'z']));
    expect(readRecentStations(store, K)).toEqual([]);
    expect(readRecentStations(null, K)).toEqual([]);
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    // a private window: this page still has it
    expect(rememberStation(throwing, K, nts).map((s) => s.id)).toEqual(['nts-1']);
  });
});

describe('heardFold (143)', () => {
  const item = (state: HeardItem['state'], title: string | null) => ({ state, title });
  it('keeps the identified rows and counts them; the rest are one line', () => {
    const f = heardFold([
      item('in_library', 'Harbour Light'),
      item('not_identified', null),
      item('not_added', 'Night Ferry'),
      item('not_identified', null),
      item('not_identified', null),
    ]);
    expect(f.count).toBe(2);
    expect(f.rows.map((r) => r.title)).toEqual(['Harbour Light', 'Night Ferry']);
    expect(f.rest).toBe('3 more weren’t identified · talk or a mix');
  });
  it('says one, none identified, and nothing to fold', () => {
    expect(heardFold([item('in_library', 'A'), item('not_identified', null)]).rest).toBe(
      '1 more wasn’t identified · talk or a mix',
    );
    expect(heardFold([item('not_identified', null), item('not_identified', null)]).rest).toBe(
      '2 weren’t identified · talk or a mix',
    );
    expect(heardFold([item('in_library', 'A')]).rest).toBe('');
  });
});
