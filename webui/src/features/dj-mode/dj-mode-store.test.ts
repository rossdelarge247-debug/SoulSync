import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnalysisEntry } from '@/features/dj/analysis.api';

import { DjModeStore, laneTrackFromItem, peaksDelay } from './dj-mode-store';
import { apiGrid } from './dj-mode.fixtures';

type Track = Record<string, unknown> | null;

interface Fake {
  store: DjModeStore;
  calls: string[];
  grids: Record<string, unknown>;
  peaks: Record<string, { status?: number; peaks?: number[] | null; duration_s?: number }>;
  entries: Map<string, AnalysisEntry>;
  emit(): void;
  watching: string[];
  said: string[];
  analysed: string[][];
  play(t: Track, kind?: string): void;
  phone: { on: boolean };
  away: { on: boolean };
}

const FERRY = {
  id: '2',
  title: 'Night Ferry',
  artist: 'Tidewater',
  is_library: true,
  filename: '/music/2.flac',
  image_url: '/art/2.jpg',
};

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function fake(): Fake {
  const calls: string[] = [];
  const grids: Fake['grids'] = {
    '2': apiGrid({ track_id: '2' }),
    '8': apiGrid({ track_id: '8', bars: 128 }),
  };
  const peaks: Fake['peaks'] = {
    '2': { peaks: [0.2, 0.8, 0.5], duration_s: 286 },
    '8': { peaks: [0.4, 0.4], duration_s: 260 },
  };
  const entries = new Map<string, AnalysisEntry>();
  const subs = new Set<() => void>();
  const watching: string[] = [];
  const said: string[] = [];
  const analysed: string[][] = [];
  const phone = { on: false };
  const away = { on: false };
  let track: Track = FERRY;
  let kind = 'library';
  (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
    state: () => ({ track, kind }),
  };
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    let m = /\/api\/library\/tracks\/([^/]+)\/peaks$/.exec(url);
    if (m) {
      const p = peaks[decodeURIComponent(m[1]!)];
      if (!p) return new Response('{}', { status: 404 });
      if (p.status === 202) return new Response('{"pending":true}', { status: 202 });
      return new Response(JSON.stringify({ peaks: p.peaks, duration_s: p.duration_s }));
    }
    m = /\/api\/library\/dj\/grid\/([^/]+)$/.exec(url);
    if (m) {
      const g = grids[decodeURIComponent(m[1]!)];
      if (!g) return new Response('{"success":false}', { status: 404 });
      return new Response(JSON.stringify({ success: true, grid: g }));
    }
    if (url.endsWith('/api/library/dj/tracks')) {
      const ids = (JSON.parse(init?.body as string) as { track_ids: string[] }).track_ids;
      const tracks: Record<string, unknown> = {};
      for (const id of ids)
        tracks[id] =
          id === '2' ? { bpm: 124, key: '8A', key_uncertain: false } : { bpm: 126, key: '8A' };
      return new Response(JSON.stringify({ success: true, tracks }));
    }
    return new Response('{}', { status: 404 });
  });
  const store = new DjModeStore({
    win: window,
    fetch: fetchImpl as unknown as (u: string, i?: RequestInit) => Promise<Response>,
    analyse: (ids) => analysed.push(ids),
    analysis: {
      watch: (ids) => {
        watching.push(...ids);
        return () => {
          for (const id of ids) watching.splice(watching.indexOf(id), 1);
        };
      },
      entry: (id) => entries.get(id),
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    },
    phone: () => phone.on,
    libraryAway: () => away.on,
    say: (w) => said.push(w),
  });
  return {
    store,
    calls,
    grids,
    peaks,
    entries,
    emit: () => subs.forEach((fn) => fn()),
    watching,
    said,
    analysed,
    play: (t, k = 'library') => {
      track = t;
      kind = k;
    },
    phone,
    away,
  };
}

afterEach(() => {
  delete (window as unknown as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
});

describe('on and off', () => {
  let f: Fake;
  beforeEach(() => {
    f = fake();
  });

  it('turns on for a library track and lane A mirrors the player’s track', async () => {
    expect(f.store.snapshot().availability.offered).toBe(true);
    expect(f.store.setOn(true)).toBe(true);
    expect(f.said).toEqual(['DJ mode on']);
    expect(f.store.snapshot().a?.track).toMatchObject({
      id: '2',
      title: 'Night Ferry',
      image: '/art/2.jpg',
    });
    expect(f.store.snapshot().a?.phase).toBe('loading');
    await flush();
    const a = f.store.snapshot().a!;
    expect(a.peaks).toEqual([0.2, 0.8, 0.5]);
    expect(a.duration).toBe(286);
    expect(a.info).toEqual({ bpm: 124, key: '8A', keyUncertain: false });
    expect(a.phase).toBe('ready');
    expect(a.grid?.bars).toBe(142);
    // the player's own reads, scoped by the server to the caller's library; nothing touches audio
    expect(f.calls.sort()).toEqual([
      'GET /api/library/dj/grid/2',
      'GET /api/library/tracks/2/peaks',
      'POST /api/library/dj/tracks',
    ]);
  });

  it('isn’t offered, and won’t turn on, for radio, on a phone or with the drive away', () => {
    f.play({ title: 'NTS 1', is_library: false, kind: 'radio' }, 'radio');
    f.store.refresh();
    expect(f.store.snapshot().availability).toEqual({ offered: false, why: 'not_library' });
    expect(f.store.setOn(true)).toBe(false);
    expect(f.store.snapshot().on).toBe(false);
    f.play(FERRY);
    f.phone.on = true;
    expect(f.store.setOn(true)).toBe(false);
    f.phone.on = false;
    f.away.on = true;
    expect(f.store.setOn(true)).toBe(false);
    f.away.on = false;
    expect(f.store.setOn(true)).toBe(true);
  });

  it('Back turns it off at once, with nothing loaded or B not started (413)', async () => {
    f.store.setOn(true);
    await flush();
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    expect(f.store.back()).toBe(true);
    const s = f.store.snapshot();
    expect(s.on).toBe(false);
    expect(s.a).toBeNull();
    expect(s.b).toBeNull();
    expect(f.said.at(-1)).toBe('DJ mode off');
    expect(f.store.back()).toBe(false);
  });

  it('closing the overlay is Back; the player moving to radio turns it off; the phone turning too', async () => {
    f.store.setOpen(true);
    f.store.setOn(true);
    f.store.setOpen(false);
    expect(f.store.snapshot().on).toBe(false);
    f.store.setOpen(true);
    f.store.setOn(true);
    f.play({ title: 'NTS 1', is_library: false, kind: 'radio' }, 'radio');
    f.store.refresh();
    expect(f.store.snapshot().on).toBe(false);
    f.play(FERRY);
    f.store.setOn(true);
    f.phone.on = true;
    f.store.refresh();
    expect(f.store.snapshot().on).toBe(false);
  });

  it('lane A follows the player to its next track; B goes if the player moved onto it', async () => {
    f.store.setOn(true);
    await flush();
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    f.play({ ...FERRY, id: '8', title: 'Harbour Lights' });
    f.store.refresh();
    expect(f.store.snapshot().a?.track.id).toBe('8');
    expect(f.store.snapshot().b).toBeNull();
  });

  it('a refresh that changes nothing doesn’t redraw', () => {
    const fn = vi.fn();
    f.store.subscribe(fn);
    f.store.refresh();
    f.store.refresh();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('lane B', () => {
  it('loads a dropped track, cued at its mix-in, never the playing one', async () => {
    const f = fake();
    expect(f.store.loadB({ id: '8', title: 'Harbour Lights' })).toBe(false); // DJ mode off
    f.store.setOn(true);
    expect(f.store.loadB({ id: '2', title: 'Night Ferry', inLibrary: true })).toBe(false);
    expect(
      f.store.loadB({
        id: '8',
        title: 'Harbour Lights',
        artist: 'Tidewater',
        key: '8A',
        bpm: 126,
        inLibrary: true,
        queue: { image_url: '/art/8.jpg', duration: 288 },
      }),
    ).toBe(true);
    expect(f.store.snapshot().b?.info).toEqual({ key: '8A', bpm: 126, keyUncertain: false });
    await flush();
    const b = f.store.snapshot().b!;
    expect(b.track).toMatchObject({ id: '8', image: '/art/8.jpg' });
    expect(b.phase).toBe('ready');
    expect(b.cue).toBe(1);
    expect(b.duration).toBe(260);
    f.store.removeB();
    expect(f.store.snapshot().b).toBeNull();
    expect(f.said.at(-1)).toBe('Harbour Lights removed');
  });

  it('laneTrackFromItem reads the queue record the drag carries', () => {
    expect(
      laneTrackFromItem({
        id: '8',
        title: '',
        artist: null,
        queue: { title: 'Q', artist: 'R', duration: 0 },
      }),
    ).toEqual({
      id: '8',
      title: 'Q',
      artist: 'R',
      image: null,
      duration: null,
      key: null,
      bpm: null,
    });
  });

  it('Browse is there only once step 3 registers it', () => {
    const f = fake();
    f.store.setOn(true);
    expect(f.store.snapshot().browse).toBe(false);
    expect(f.store.openBrowse()).toBe(false);
    const open = vi.fn();
    f.store.setBrowseOpener(open);
    expect(f.store.snapshot().browse).toBe(true);
    expect(f.store.openBrowse()).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('analysis on open and on load (37e, 37d; 420)', () => {
  it('a track without its grid is asked for at once, shows Analysing, and draws the map when it lands', async () => {
    const f = fake();
    f.grids['2'] = { track_id: '2', analyzed: false, reason: 'not_analyzed' };
    f.store.setOn(true);
    await flush();
    let a = f.store.snapshot().a!;
    expect(a.phase).toBe('analysing');
    // the waveform is there at once
    expect(a.peaks).toEqual([0.2, 0.8, 0.5]);
    expect(f.analysed).toEqual([['2']]);
    expect(f.watching).toEqual(['2']);
    // B can be loaded meanwhile (420)
    expect(f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true })).toBe(true);
    // in line, then being worked out: still analysing
    f.entries.set('2', { state: 'working', step: 'grid', percent: 60 });
    f.emit();
    expect(f.store.snapshot().a?.phase).toBe('analysing');
    // done: the grid is read again
    f.grids['2'] = apiGrid({ track_id: '2' });
    f.entries.set('2', { state: 'done', ready: true });
    f.emit();
    await flush();
    a = f.store.snapshot().a!;
    expect(a.phase).toBe('ready');
    expect(a.grid?.bars).toBe(142);
    expect(f.watching).toEqual([]);
    expect(f.said).toContain('Night Ferry analysed');
  });

  it('a drive that’s away: Waiting, and the analysis carries on when it’s back', async () => {
    const f = fake();
    f.grids['8'] = { track_id: '8', analyzed: false, reason: 'not_analyzed' };
    f.store.setOn(true);
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    await flush();
    f.entries.set('8', { state: 'waiting', reason: 'drive_away', position: 1, asked_for: true });
    f.emit();
    expect(f.store.snapshot().b?.phase).toBe('waiting');
    f.entries.set('8', { state: 'working', step: 'tempo', percent: 10 });
    f.emit();
    expect(f.store.snapshot().b?.phase).toBe('analysing');
  });

  it('no steady beat: no grid, with the reason; an older load’s answer is dropped', async () => {
    const f = fake();
    f.grids['8'] = { track_id: '8', analyzed: false, reason: 'no_beat' };
    f.store.setOn(true);
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    f.store.removeB();
    await flush();
    expect(f.store.snapshot().b).toBeNull();
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    await flush();
    expect(f.store.snapshot().b).toMatchObject({ phase: 'no_grid', reason: 'no_beat' });
    expect(f.analysed).toEqual([]);
  });

  it('a grid that isn’t in 4/4 is no grid to blend on; a failed read says it couldn’t be read', async () => {
    const f = fake();
    f.grids['8'] = apiGrid({ track_id: '8', downbeats: { first: 1, beat_index: 0, meter: '3/4' } });
    f.store.setOn(true);
    f.store.loadB({ id: '8', title: 'Sweet Waltz', inLibrary: true });
    await flush();
    expect(f.store.snapshot().b).toMatchObject({ phase: 'no_grid', reason: 'not_4_4' });
    delete f.grids['8'];
    f.store.loadB({ id: '8', title: 'Sweet Waltz', inLibrary: true });
    await flush();
    expect(f.store.snapshot().b).toMatchObject({ phase: 'no_grid', reason: 'error' });
  });

  it('peaks still being worked out (202) are asked for again later', async () => {
    vi.useFakeTimers();
    try {
      const f = fake();
      f.peaks['2'] = { status: 202 };
      f.store.setOn(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(f.store.snapshot().a?.peaks).toBeNull();
      f.peaks['2'] = { peaks: [1], duration_s: 200 };
      await vi.advanceTimersByTimeAsync(1600);
      expect(f.store.snapshot().a?.peaks).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
    expect(peaksDelay(0)).toBe(1500);
    expect(peaksDelay(6)).toBeNull();
  });
});

describe('a drag’s drop line (37c)', () => {
  it('looks up whether the track has its grid once, and says when it knows', async () => {
    const f = fake();
    const known = vi.fn();
    expect(f.store.readinessOf('8', known)).toBeNull();
    expect(f.store.readinessOf('8', known)).toBeNull();
    await flush();
    expect(known).toHaveBeenCalledTimes(1);
    expect(f.store.readinessOf('8', known)).toBe(true);
    f.entries.set('9', { state: 'done', ready: false });
    expect(f.store.readinessOf('9', known)).toBe(false);
  });
});
