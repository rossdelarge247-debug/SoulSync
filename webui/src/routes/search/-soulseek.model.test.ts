import { describe, expect, it } from 'vitest';

import type { QualityRule } from '@/features/quality/quality.model';

import type { BasicAlbum, BasicTrack } from './-basic.types';
import type { Consequence, FileOwnership } from './-soulseek.model';

import {
  checkRowsFor,
  consequenceFor,
  countFiles,
  countUsers,
  DEFAULT_SOULSEEK_FILTERS,
  dropOwned,
  fileSize,
  groupKey,
  groupResults,
  meetsTargetResult,
  missingOnly,
  normalizeName,
  ownershipKey,
  primaryKey,
  rowActions,
  rowMeta,
  slotLine,
  targetFilterLabel,
} from './-soulseek.model';

const FLAC_BAR: QualityRule[] = [
  { format: 'flac', bit_depth: 24, min_sample_rate: 96000 },
  { format: 'flac', bit_depth: 16 },
];

function track(over: Partial<BasicTrack> = {}): BasicTrack {
  return {
    result_type: 'track',
    username: 'slackwater88',
    filename: 'Music/Pale Harbour - Tidewater/01 - Pale Harbour - Harbour Light.flac',
    size: 32_000_000,
    bitrate: 1000,
    duration: 240_000,
    quality: 'flac',
    free_upload_slots: 1,
    upload_speed: 1_200_000,
    queue_length: 0,
    sample_rate: 44100,
    bit_depth: 16,
    artist: 'Pale Harbour',
    title: 'Harbour Light',
    album: 'Pale Harbour - Tidewater',
    track_number: 1,
    quality_score: 0.8,
    ...over,
  };
}

const TITLES = ['Harbour Light', 'Slack Water', 'Lantern Room'];

function folder(over: Partial<BasicAlbum> = {}, trackOver: Partial<BasicTrack> = {}): BasicAlbum {
  const user = over.username ?? 'harbourmaster';
  const tracks = TITLES.map((title, i) =>
    track({
      username: user,
      title,
      track_number: i + 1,
      filename: `Music/Tidewater/${i + 1} ${title}.flac`,
      ...trackOver,
    }),
  );
  return {
    result_type: 'album',
    username: user,
    album_path: 'Music/Pale Harbour - Tidewater (2026) [FLAC 24-96]',
    album_title: 'Tidewater',
    artist: 'Pale Harbour',
    track_count: tracks.length,
    total_size: 1_500_000_000,
    tracks,
    dominant_quality: 'flac',
    year: '2026',
    free_upload_slots: 1,
    upload_speed: 3_100_000,
    queue_length: 0,
    quality_score: 0.9,
    ...over,
  };
}

function owned(map: Record<string, FileOwnership | null>): Map<string, FileOwnership | null> {
  return new Map(Object.entries(map).map(([title, v]) => [ownershipKey(title, 'Pale Harbour'), v]));
}

describe('grouping by folder', () => {
  it('puts copies of the same folder from different users in one row, best copy first', () => {
    const slow = folder({
      username: 'nightowl',
      quality_score: 0.5,
      album_path: 'x/Pale Harbour - Tidewater (2026) [FLAC]',
    });
    const fast = folder({ username: 'harbourmaster', quality_score: 0.9 });
    const groups = groupResults(
      [slow, fast],
      { ...DEFAULT_SOULSEEK_FILTERS, quality: 'any' },
      'pale harbour',
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('folder');
    expect(groups[0].best.username).toBe('harbourmaster');
    expect(groups[0].copies.map((c) => c.username)).toEqual(['harbourmaster', 'nightowl']);
  });

  it('ignores case, punctuation and bracketed tags in a folder name', () => {
    expect(normalizeName('Tidewater (2026) [FLAC 24-96]')).toBe(normalizeName('tidewater'));
    expect(groupKey(folder({ album_title: 'Tidewater [FLAC]' }))).toBe(groupKey(folder()));
  });

  it('keeps a lone file as its own row', () => {
    const groups = groupResults(
      [track(), folder()],
      { ...DEFAULT_SOULSEEK_FILTERS, quality: 'any' },
      'q',
      [],
    );
    expect(groups.map((g) => g.kind).sort()).toEqual(['file', 'folder']);
  });

  it('counts files inside folders, and users once each', () => {
    const results = [folder(), folder({ username: 'nightowl' }), track()];
    expect(countFiles(results)).toBe(7);
    expect(countUsers(results)).toBe(3);
  });
});

describe('the filters', () => {
  const mp3 = folder(
    { username: 'vinylrips', dominant_quality: 'mp3' },
    { quality: 'mp3', bitrate: 320, bit_depth: null, sample_rate: null },
  );
  const flac = folder();

  it('shows only copies at your target by default', () => {
    expect(DEFAULT_SOULSEEK_FILTERS.quality).toBe('target');
    const groups = groupResults([mp3, flac], DEFAULT_SOULSEEK_FILTERS, 'q', FLAC_BAR);
    expect(groups).toHaveLength(1);
    expect(groups[0].best.username).toBe('harbourmaster');
    expect(groups[0].copies).toHaveLength(1);
  });

  it('shows every copy with Any quality', () => {
    const groups = groupResults(
      [mp3, flac],
      { ...DEFAULT_SOULSEEK_FILTERS, quality: 'any' },
      'q',
      FLAC_BAR,
    );
    expect(groups[0].copies).toHaveLength(2);
  });

  it('keeps folders only with Whole albums', () => {
    const groups = groupResults(
      [track(), flac],
      { ...DEFAULT_SOULSEEK_FILTERS, quality: 'any', albumsOnly: true },
      'q',
      [],
    );
    expect(groups.map((g) => g.kind)).toEqual(['folder']);
  });

  it('keeps today’s format filter', () => {
    const groups = groupResults(
      [mp3, track()],
      { ...DEFAULT_SOULSEEK_FILTERS, quality: 'any', format: 'mp3' },
      'q',
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].best.username).toBe('vinylrips');
  });

  it('judges a folder against the target by every one of its files', () => {
    expect(meetsTargetResult(flac, FLAC_BAR)).toBe(true);
    const mixed = folder({}, {});
    mixed.tracks[1] = { ...mixed.tracks[1], quality: 'mp3', bitrate: 320, bit_depth: null };
    expect(meetsTargetResult(mixed, FLAC_BAR)).toBe(false);
    // no target known: everything counts
    expect(meetsTargetResult(mixed, [])).toBe(true);
  });

  it('drops rows you have every file of with Not in my library, but keeps an upgrade', () => {
    const groups = groupResults(
      [folder(), track()],
      { ...DEFAULT_SOULSEEK_FILTERS, quality: 'any' },
      'q',
      [],
    );
    const consequences = new Map<string, Consequence>([
      [groups[0].key, { kind: 'owned', text: '', missing: [] }],
      [groups[1].key, { kind: 'upgrade', text: '', missing: [] }],
    ]);
    expect(dropOwned(groups, consequences)).toEqual([groups[1]]);
  });

  it('names the target in the filter, short like the board', () => {
    expect(targetFilterLabel('FLAC or better')).toBe('At your target (FLAC+)');
    expect(targetFilterLabel('Any lossless')).toBe('At your target (Any lossless)');
    expect(targetFilterLabel(null)).toBe('At your target');
  });
});

describe('the consequence line', () => {
  it('waits for the library check before saying anything', () => {
    expect(consequenceFor(folder(), new Map(), FLAC_BAR)).toMatchObject({
      kind: 'pending',
      text: '',
    });
  });

  it('says nothing when the check failed for these files', () => {
    const map = owned({ 'Harbour Light': null, 'Slack Water': null, 'Lantern Room': null });
    expect(consequenceFor(folder(), map, FLAC_BAR)).toMatchObject({ kind: 'unknown', text: '' });
  });

  it('finds the track you’re missing from an album you have', () => {
    const map = owned({
      'Harbour Light': { in_library: false },
      'Slack Water': { in_library: true, file_path: '/m/a.flac', bitrate: 1000 },
      'Lantern Room': { in_library: true, file_path: '/m/b.flac', bitrate: 1000 },
    });
    const c = consequenceFor(folder(), map, FLAC_BAR);
    expect(c.kind).toBe('missing');
    expect(c.text).toBe("has the 1 track you're missing");
    expect(c.missing.map((t) => t.title)).toEqual(['Harbour Light']);
  });

  it('says a file is on your Wanted list, and a folder how many of its tracks are', () => {
    const map = owned({ 'Harbour Light': { in_library: false, in_wishlist: true } });
    expect(consequenceFor(track(), map, FLAC_BAR)).toMatchObject({
      kind: 'wanted',
      text: 'on your Wanted list',
    });
    const none = owned({
      'Harbour Light': { in_wishlist: true },
      'Slack Water': { in_wishlist: true },
      'Lantern Room': {},
    });
    expect(consequenceFor(folder(), none, FLAC_BAR).text).toBe('has 2 tracks on your Wanted list');
  });

  it('names the gap in an album you have most of, even when the gap is on Wanted', () => {
    const map = owned({
      'Harbour Light': { in_wishlist: true },
      'Slack Water': { in_library: true, file_path: '/m/a.flac' },
      'Lantern Room': { in_library: true, file_path: '/m/b.flac' },
    });
    expect(consequenceFor(folder(), map, FLAC_BAR)).toMatchObject({
      kind: 'missing',
      text: "has the 1 track you're missing",
    });
  });

  it('names the copy it upgrades', () => {
    const map = owned({
      'Harbour Light': { in_library: true, file_path: '/m/a.mp3', bitrate: 320 },
      'Slack Water': { in_library: true, file_path: '/m/b.mp3', bitrate: 320 },
      'Lantern Room': { in_library: true, file_path: '/m/c.mp3', bitrate: 320 },
    });
    expect(consequenceFor(folder(), map, FLAC_BAR)).toMatchObject({
      kind: 'upgrade',
      text: 'upgrades your MP3 320 copy',
    });
  });

  it('is plain when you already have it at your target', () => {
    const map = owned({
      'Harbour Light': { in_library: true, file_path: '/m/a.flac', bitrate: 1000 },
      'Slack Water': { in_library: true, file_path: '/m/b.flac', bitrate: 1000 },
      'Lantern Room': { in_library: true, file_path: '/m/c.flac', bitrate: 1000 },
    });
    expect(consequenceFor(folder(), map, FLAC_BAR)).toMatchObject({
      kind: 'owned',
      text: 'you have all 3 tracks',
    });
  });

  it('says when none of it is yours', () => {
    const map = owned({ 'Harbour Light': {}, 'Slack Water': {}, 'Lantern Room': {} });
    expect(consequenceFor(folder(), map, FLAC_BAR)).toMatchObject({
      kind: 'new',
      text: 'not in your library',
    });
  });

  it('asks the library about a folder’s files with the folder’s artist', () => {
    const rows = checkRowsFor(folder({}, { artist: null }));
    expect(rows[0]).toMatchObject({ name: 'Harbour Light', artist: 'Pale Harbour' });
  });
});

describe('the one primary', () => {
  const groups = groupResults(
    [folder(), track({ title: 'Other', filename: 'x/Other.flac', quality_score: 0.1 })],
    { ...DEFAULT_SOULSEEK_FILTERS, quality: 'any' },
    'q',
    [],
  );

  it('goes to the first row that completes something you want', () => {
    const consequences = new Map<string, Consequence>([
      [groups[0].key, { kind: 'upgrade', text: '', missing: [] }],
      [groups[1].key, { kind: 'wanted', text: '', missing: [] }],
    ]);
    expect(primaryKey(groups, consequences)).toBe(groups[1].key);
  });

  it('goes nowhere when nothing completes a want', () => {
    const consequences = new Map<string, Consequence>([
      [groups[0].key, { kind: 'upgrade', text: '', missing: [] }],
      [groups[1].key, { kind: 'new', text: '', missing: [] }],
    ]);
    expect(primaryKey(groups, consequences)).toBeNull();
  });
});

describe('row actions', () => {
  it('offers Download missing beside Download all when part of the folder is yours', () => {
    const f = folder();
    const [g] = groupResults([f], { ...DEFAULT_SOULSEEK_FILTERS, quality: 'any' }, 'q', []);
    expect(rowActions(g, { kind: 'missing', text: '', missing: [f.tracks[0]] })).toEqual({
      main: 'Download missing',
      all: true,
    });
    expect(rowActions(g, { kind: 'upgrade', text: '', missing: [] })).toEqual({
      main: 'Upgrade',
      all: false,
    });
    expect(rowActions(g, { kind: 'new', text: '', missing: f.tracks })).toEqual({
      main: 'Download',
      all: false,
    });
  });

  it('narrows a folder to the files you don’t have', () => {
    const f = folder();
    const narrowed = missingOnly(f, [f.tracks[2]]);
    expect(narrowed.tracks.map((t) => t.title)).toEqual(['Lantern Room']);
    expect(narrowed.track_count).toBe(1);
    expect(narrowed.total_size).toBe(32_000_000);
    expect(f.tracks).toHaveLength(3);
  });

  it('describes the copy and its uploader', () => {
    expect(rowMeta(folder())).toBe('Folder · 3 tracks');
    expect(rowMeta(track())).toBe('Track · in Pale Harbour - Tidewater');
    expect(slotLine(folder())).toBe('free slot · 3.1 MB/s');
    expect(slotLine(folder({ free_upload_slots: 0, queue_length: 2, upload_speed: 800_000 }))).toBe(
      'queue of 2 · 800 kB/s',
    );
    expect(fileSize(1_500_000_000)).toBe('1.4 GB');
    expect(fileSize(430_000_000)).toBe('410 MB');
    expect(fileSize(0)).toBe('—');
  });
});
