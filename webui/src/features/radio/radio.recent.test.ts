/**
 * Stations on the server, per profile (HANDOFF 142, 163; board 16b): the
 * browser's copy is the first paint, merged with the server's list when it
 * answers. Times are fixed numbers, never the real clock.
 */
import { describe, expect, it } from 'vitest';

import type { Station } from './radio.types';

import { stationRowLine, streamChoice } from './radio.format';
import {
  keepRecentStations,
  mergeRecent,
  readRecentStations,
  RECENT_AFTER_MS,
  RECENT_STATIONS_KEY,
  RECENT_STATIONS_MAX,
  rememberStation,
  serverRecent,
  type RecentStation,
} from './radio.recent';
import { scanReadySentence } from './radio.scan';

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

const row = (id: string, played_at?: number, over: Partial<RecentStation> = {}): RecentStation => ({
  id,
  name: id.toUpperCase(),
  logo_url: '',
  genre: 'Eclectic',
  kind_label: '',
  city: 'London',
  country: '',
  source: 'built_in',
  added_by: null,
  ...(played_at === undefined ? {} : { played_at }),
  ...over,
});

describe('mergeRecent', () => {
  it('orders both lists by when each was last played, once per station', () => {
    const local = [row('nts-1', 500), row('kexp', 100)];
    const server = [row('fip-jazz', 400), row('kexp', 300)];
    expect(mergeRecent(local, server).map((s) => [s.id, s.played_at])).toEqual([
      ['nts-1', 500],
      ['fip-jazz', 400],
      ['kexp', 300],
    ]);
  });

  it('takes the server’s words for a station both have, and the later time', () => {
    const local = [row('link-1', 900, { name: 'Old name', source: 'your_link' })];
    const server = [row('link-1', 200, { name: 'Lowlands Radio', source: 'your_link' })];
    const [one] = mergeRecent(local, server);
    expect(one).toMatchObject({ name: 'Lowlands Radio', played_at: 900 });
  });

  it('puts rows with no time (an older copy) after the timed ones, in their order', () => {
    const local = [row('a'), row('b')];
    const server = [row('c', 10)];
    expect(mergeRecent(local, server).map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps the newest eight', () => {
    const server = Array.from({ length: 20 }, (_, i) => row(`s${i}`, 1000 - i));
    const merged = mergeRecent([], server);
    expect(merged).toHaveLength(RECENT_STATIONS_MAX);
    expect(merged[0]!.id).toBe('s0');
  });
});

describe('the server’s list in the browser', () => {
  it('reads the server’s stations as rows and skips anything malformed', () => {
    const station = { ...row('kexp', 42), quality: {}, streams: [], favourite: true } as unknown;
    expect(serverRecent([station, { id: 3 }, null, 'x'])).toEqual([row('kexp', 42)]);
    expect(serverRecent({ nope: true })).toEqual([]);
  });

  it('keeps the merged list as the next first paint, under the same key', () => {
    const store = memory();
    keepRecentStations(store, [row('kexp', 1), row('nts-1', 2)]);
    expect(JSON.parse(store.getItem(RECENT_STATIONS_KEY)!).map((s: RecentStation) => s.id)).toEqual(
      ['kexp', 'nts-1'],
    );
    expect(readRecentStations(store).map((s) => s.played_at)).toEqual([1, 2]);
  });

  it('stamps a station played in this browser with the time it started', () => {
    const store = memory();
    const [first] = rememberStation(store, row('nts-1') as unknown as Station, 1_700_000_000_500);
    expect(first!.played_at).toBe(1_700_000_000);
  });

  it('counts a station after 30 seconds, as the server does', () => {
    expect(RECENT_AFTER_MS).toBe(30_000);
  });
});

describe('the tray’s words (16a, 16b)', () => {
  it('names the playing stream with its path, the others by quality', () => {
    const aac = {
      codec: 'AAC',
      bitrate_kbps: 256,
      lossless: false,
      label: 'AAC 256 kbps (best offered)',
    };
    expect(streamChoice(aac, 'relay')).toBe('AAC 256 · relayed');
    expect(streamChoice(aac, 'direct')).toBe('AAC 256 · direct');
    expect(streamChoice({ codec: 'MP3', bitrate_kbps: 128, lossless: false }, null)).toBe(
      'MP3 128',
    );
    expect(streamChoice({ codec: 'FLAC', bitrate_kbps: 1000, lossless: true }, null)).toBe('FLAC');
    expect(streamChoice({ label: 'Opus (best offered)' }, null)).toBe('Opus');
  });

  it('says "Your link" alone on a link’s row', () => {
    const link = { ...row('link-1'), source: 'your_link', added_by: 'ross' } as unknown as Station;
    expect(stationRowLine(link)).toBe('Your link');
    expect(stationRowLine({ ...row('nts-1') } as unknown as Station)).toBe('Eclectic · London');
  });

  it('has the ready sentence naming the services in order', () => {
    expect(scanReadySentence(['acoustid', 'audd'])).toBe(
      'Not the track you hear? Scan now listens for 10 seconds and asks AcoustID, then AudD.',
    );
  });
});
