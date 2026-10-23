import { describe, expect, it } from 'vitest';

import type { NowPlaying, Station } from './radio.types';

import {
  agoWords,
  barMeta,
  cardSubline,
  durationWords,
  heardTag,
  logoText,
  nowLines,
  playerAction,
  possessive,
  qualityText,
  sourcePhrase,
  sourceWords,
} from './radio.format';

const station = (over: Partial<Station> = {}): Station => ({
  id: 'nts-1',
  name: 'NTS 1',
  kind: 'eclectic',
  kind_label: 'Eclectic tastemakers',
  genre: 'Eclectic',
  city: 'London',
  country: 'United Kingdom',
  logo_url: '',
  homepage: 'https://www.nts.live/',
  description: '',
  source: 'built_in',
  favourite: false,
  auto_add: false,
  has_now_playing: true,
  has_tracklists: true,
  quality: { codec: 'AAC', bitrate_kbps: 256, lossless: false, label: 'AAC 256 kbps' },
  tags: [],
  sends_titles: null,
  added_by: null,
  streams: [],
  ...over,
});

const np = (over: Partial<NowPlaying> = {}): NowPlaying => ({
  station_id: 'nts-1',
  state: 'identified',
  track: { artist: 'Pale Harbour', title: 'Harbour Light', release: 'Lantern', art_url: null },
  source: 'station_feed',
  identified_at: 1000,
  started_at: 1000,
  reason: null,
  library: { in_library: false, below_target: null, track_id: null },
  on_wanted: false,
  previous_title: null,
  now: 1040,
  playing: true,
  heard_id: 7,
  ...over,
});

describe('radio words', () => {
  it('says how long ago', () => {
    expect(agoWords(12)).toBe('12 s ago');
    expect(agoWords(180)).toBe('3 min ago');
    expect(agoWords(7200)).toBe('2 h ago');
    expect(durationWords(480)).toBe('about 8 minutes');
  });

  it('names the source as the boards do', () => {
    expect(sourceWords('station_feed')).toBe('From the station');
    expect(sourceWords('stream_titles')).toBe('From the stream’s names');
    expect(sourceWords('scan_audd')).toBe('Found by AudD · Scan now');
    expect(sourcePhrase('fingerprint')).toBe('fingerprint');
    // AudD listening on its own: no "Scan now"; a press keeps it
    expect(sourcePhrase('audd')).toBe('found by AudD');
    expect(sourceWords('audd')).toBe('Found by AudD');
    expect(sourcePhrase('scan_audd')).toBe('found by AudD · Scan now');
    expect(sourcePhrase('scan_acrcloud')).toBe('found by ACRCloud · Scan now');
    expect(possessive('Radio Paradise · Main Mix')).toBe('Radio Paradise’s');
  });

  it('writes the card lines and quality', () => {
    expect(cardSubline(station())).toBe('Eclectic · London');
    expect(cardSubline(station({ source: 'your_link', added_by: 'ross' }))).toBe(
      'Your link · added by ross',
    );
    expect(qualityText(station())).toBe('AAC 256 kbps');
    expect(
      qualityText(
        station({ quality: { codec: 'FLAC', bitrate_kbps: 1000, lossless: true, label: '' } }),
      ),
    ).toBe('FLAC');
    expect(logoText('NTS 1')).toBe('NTS');
    expect(logoText('Radio Paradise · Main Mix')).toBe('RP');
    expect(logoText('dublab')).toBe('du');
    expect(barMeta({ label: 'AAC 256 kbps (best offered)' }, station())).toBe(
      'AAC 256 kbps · Radio',
    );
  });

  it('tags Heard rows by state, below target first', () => {
    expect(heardTag({ state: 'in_library', below_target: true })).toEqual({
      label: 'Below quality target',
      tone: 'warning',
    });
    expect(heardTag({ state: 'on_wanted', below_target: null }).label).toBe(
      'On Wanted · Searching',
    );
    expect(heardTag({ state: 'cant_match', below_target: null }).label).toBe('Can’t be matched');
  });

  it('works out the player lines and its one action', () => {
    // the source phrase tells who named it (HANDOFF 58)
    expect(nowLines(np(), 0).line).toMatch(
      /^Pale Harbour · Lantern · from the station · \d+ (s|min|h) ago$/,
    );
    expect(nowLines({ ...np(), source: 'scan_audd' }, 0).line).toContain(
      'found by AudD · Scan now',
    );
    expect(nowLines(np({ state: 'listening', track: null }), 0).title).toBe('Listening…');
    expect(nowLines(np({ state: 'not_identified', track: null }), 0).title).toBe('Not identified');
    expect(playerAction(np())).toBe('add');
    expect(playerAction(np({ heard_id: null }))).toBe('adding_disabled');
    expect(
      playerAction(np({ library: { in_library: true, below_target: false, track_id: '1' } })),
    ).toBe('in_library');
    expect(playerAction(np({ on_wanted: true }))).toBe('on_wanted');
    expect(playerAction(np({ state: 'listening', track: null }))).toBeNull();
  });
});
