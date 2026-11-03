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
  /** what the next asks answer (a promise per ask; none: nothing to wait for) */
  answers: (Promise<unknown> | undefined)[];
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

function fake(extra: { now?: () => number } = {}): Fake {
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
  const answers: (Promise<unknown> | undefined)[] = [];
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
    analyse: (ids) => {
      analysed.push(ids);
      return answers.shift();
    },
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
    ...extra,
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
    answers,
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
      // 3b: the person's cue points on the track
      'GET /api/library/dj/cues/2',
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

  it('closing the overlay keeps it on (37j); the player moving to radio turns it off; the phone turning too', async () => {
    f.store.setOpen(true);
    f.store.setOn(true);
    f.store.setOpen(false);
    expect(f.store.snapshot().on).toBe(true);
    f.store.setOpen(true);
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

  it('a load is said once; a caller that says it itself (a drop’s toast) keeps it quiet (review M3)', () => {
    const f = fake();
    f.store.setOn(true);
    f.said.length = 0;
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    expect(f.said).toEqual(['Harbour Lights loaded as B, cued']);
    f.store.loadB({ id: '9', title: 'Low Orbit', inLibrary: true }, { announce: false });
    expect(f.said).toEqual(['Harbour Lights loaded as B, cued']);
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
      queue: null,
    });
    // a drag that carries the player's queue record: Hand over plays it (414)
    const q = { title: 'Q', file_path: '/m/8.flac' };
    expect(laneTrackFromItem({ id: '8', title: 'Q', queue: q }).queue).toBe(q);
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
    // ready is said once, by Brief A's line ("… is ready to mix"), not here too (review L2)
    expect(f.said.filter((w) => /analysed|ready/.test(w))).toEqual([]);
  });

  it('analysed with no grid to blend on: said once, with the reason', async () => {
    const f = fake();
    f.grids['2'] = { track_id: '2', analyzed: false, reason: 'not_analyzed' };
    f.store.setOn(true);
    await flush();
    f.grids['2'] = { track_id: '2', analyzed: false, reason: 'no_beat' };
    f.entries.set('2', { state: 'done', ready: false, beat: 'no_beat' });
    f.emit();
    await flush();
    expect(f.store.snapshot().a).toMatchObject({ phase: 'no_grid', reason: 'no_beat' });
    expect(f.said.at(-1)).toBe('Night Ferry has no steady beat: Sync is off, blend by ear');
  });

  it('a track loaded again while DJ mode is on isn’t asked twice (M1); off clears it (N1)', async () => {
    const f = fake();
    f.grids['8'] = { track_id: '8', analyzed: false, reason: 'not_analyzed' };
    f.store.setOn(true);
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    await flush();
    f.store.removeB();
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    await flush();
    expect(f.analysed).toEqual([['8']]);
    expect(f.store.snapshot().b?.phase).toBe('analysing');
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

  it('a failed lookup isn’t kept; answers are forgotten on Back and after a minute (review L5)', async () => {
    let now = 1_000;
    const f = fake({ now: () => now });
    delete f.grids['8'];
    const known = vi.fn();
    expect(f.store.readinessOf('8', known)).toBeNull();
    await flush();
    expect(known).toHaveBeenCalledTimes(1);
    // the read failed: the next look asks again, and this time it answers
    f.grids['8'] = apiGrid({ track_id: '8' });
    expect(f.store.readinessOf('8', known)).toBeNull();
    await flush();
    expect(f.store.readinessOf('8', known)).toBe(true);
    // a minute on, the grid may have changed: asked again
    f.grids['8'] = { track_id: '8', analyzed: false, reason: 'no_beat' };
    now += 61_000;
    expect(f.store.readinessOf('8', known)).toBeNull();
    await flush();
    expect(f.store.readinessOf('8', known)).toBe(false);
    // Back forgets them all
    f.store.setOn(true);
    f.store.back();
    f.grids['8'] = apiGrid({ track_id: '8' });
    expect(f.store.readinessOf('8', known)).toBeNull();
  });
});

describe('a phone on its side (review L9, N3)', () => {
  // a window with these media features; a query matches when every part of it does
  const win = (features: string[]) =>
    ({
      matchMedia: (q: string) => ({
        matches: q.split(' and ').every((part) => features.includes(part)),
      }),
    }) as unknown as Window;

  it('isn’t offered DJ mode either', async () => {
    const { isPhone } = await import('./dj-mode-store');
    expect(isPhone(win([]))).toBe(false);
    expect(isPhone(win(['(max-width: 768px)']))).toBe(true);
    expect(
      isPhone(win(['(orientation: landscape)', '(max-height: 500px)', '(pointer: coarse)'])),
    ).toBe(true);
  });

  it('a short desktop window (about 500px tall, a mouse) still offers it (N3)', async () => {
    const { isPhone } = await import('./dj-mode-store');
    expect(
      isPhone(win(['(orientation: landscape)', '(max-height: 500px)', '(pointer: fine)'])),
    ).toBe(false);
  });
});

describe('an ask that failed is tried again (review N1)', () => {
  const notYet = { track_id: '8', analyzed: false, reason: 'not_analyzed' };

  async function loadAgain(f: Fake) {
    f.store.removeB();
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    await flush();
  }

  it('a rejected ask, or one turned away (null: 409 held), is asked again on the next load', async () => {
    const f = fake();
    f.grids['8'] = notYet;
    f.store.setOn(true);
    f.answers.push(Promise.reject(new Error('network')));
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    await flush();
    expect(f.analysed).toEqual([['8']]);
    f.answers.push(Promise.resolve(null));
    await loadAgain(f);
    expect(f.analysed).toEqual([['8'], ['8']]);
    // answered: not asked again this session
    f.answers.push(Promise.resolve({ asked: 1, queued: 1 }));
    await loadAgain(f);
    await loadAgain(f);
    expect(f.analysed).toEqual([['8'], ['8'], ['8']]);
    // DJ mode off and on: asked again
    f.store.setOn(false);
    f.store.setOn(true);
    await loadAgain(f);
    expect(f.analysed).toEqual([['8'], ['8'], ['8'], ['8']]);
  });
});

/* ── the review's probes (3d51f799): a grid read still on its way ───── */

function pending(track: { id: string }) {
  let t: Record<string, unknown> = {
    ...track,
    title: 'T' + track.id,
    is_library: true,
    filename: '/x.flac',
  };
  (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
    state: () => ({ track: t, kind: 'library' }),
  };
  const watching: string[] = [];
  const subs = new Set<() => void>();
  const entries = new Map<string, AnalysisEntry>();
  const gridCalls: string[] = [];
  const resolvers: ((r: Response) => void)[] = [];
  const store = new DjModeStore({
    win: window,
    fetch: (async (url: string) => {
      if (url.includes('/dj/grid/')) {
        gridCalls.push(url);
        return new Promise<Response>((res) => resolvers.push(res));
      }
      return new Response('{}');
    }) as unknown as (u: string) => Promise<Response>,
    analyse: () => undefined,
    analysis: {
      watch: (ids) => {
        watching.push(...ids);
        return () => ids.forEach((id) => watching.splice(watching.indexOf(id), 1));
      },
      entry: (id) => entries.get(id),
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    },
    phone: () => false,
    say: () => undefined,
  });
  const answer = (body: unknown) => resolvers.shift()!(new Response(JSON.stringify(body)));
  return {
    store,
    watching,
    subs,
    entries,
    gridCalls,
    answer,
    resolvers,
    setTrack: (x: Record<string, unknown>) => {
      t = { ...t, ...x };
    },
  };
}
const NOT_YET = (id: string) => ({
  grid: { track_id: id, analyzed: false, reason: 'not_analyzed' },
});

describe('a grid read on its way (review L1 and the test gaps)', () => {
  it('Back mid-analysis releases the watch and the listener', async () => {
    const f = pending({ id: '1' });
    f.store.setOn(true);
    f.answer(NOT_YET('1'));
    await flush();
    expect(f.watching).toEqual(['1']);
    expect(f.subs.size).toBe(1);
    f.store.back();
    expect(f.watching).toEqual([]);
    expect(f.subs.size).toBe(0);
  });

  it('DJ mode off mid-analysis releases them too', async () => {
    const f = pending({ id: '1' });
    f.store.setOpen(true);
    f.store.setOn(true);
    f.answer(NOT_YET('1'));
    await flush();
    f.store.setOn(false);
    expect(f.watching).toEqual([]);
    expect(f.subs.size).toBe(0);
  });

  it('polls before the grid answers ask for it once (L1)', async () => {
    const f = pending({ id: '1' });
    f.store.setOn(true);
    f.answer(NOT_YET('1'));
    await flush();
    f.entries.set('1', { state: 'done', ready: true });
    f.subs.forEach((fn) => fn());
    f.subs.forEach((fn) => fn());
    f.subs.forEach((fn) => fn());
    expect(f.gridCalls.length).toBe(2);
    // it answers: ready, and nothing more is asked
    f.answer({ grid: apiGrid({ track_id: '1' }) });
    await flush();
    expect(f.store.snapshot().a?.phase).toBe('ready');
    expect(f.subs.size).toBe(0);
  });

  it('a track change mid-analysis: the old watch is released, the old answer ignored', async () => {
    const f = pending({ id: '1' });
    f.store.setOn(true);
    const old = f.resolvers.shift()!;
    f.setTrack({ id: '2', title: 'T2' });
    f.store.refresh();
    old(new Response(JSON.stringify(NOT_YET('1'))));
    await flush();
    expect(f.watching).toEqual([]);
    expect(f.store.snapshot().a?.track.id).toBe('2');
    expect(f.store.snapshot().a?.phase).toBe('loading');
  });

  it('the failed path: a grid read that fails says it couldn’t be read, and watches nothing', async () => {
    const f = pending({ id: '1' });
    f.store.setOn(true);
    f.resolvers.shift()!(new Response('{}', { status: 500 }));
    await flush();
    expect(f.store.snapshot().a).toMatchObject({ phase: 'no_grid', reason: 'error' });
    expect(f.watching).toEqual([]);
    expect(f.subs.size).toBe(0);
  });
});

describe('the ends and changes, in words (step 4, 37j)', () => {
  let f: Fake;
  let el: EventTarget;
  beforeEach(() => {
    vi.useFakeTimers();
    f = fake();
    el = new EventTarget();
    (window as unknown as { SoulSyncPlayer: { audio?: () => EventTarget } }).SoulSyncPlayer.audio =
      () => el;
  });
  afterEach(() => vi.useRealTimers());

  it('Next with B loaded: the new A is playing, B still cued', () => {
    f.store.setOn(true);
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    f.said.length = 0;
    f.play({ ...FERRY, id: '5', title: 'Copper Sky' });
    f.store.refresh();
    expect(f.store.snapshot().b?.track.id).toBe('8');
    expect(f.said).toEqual(['Copper Sky is playing · Harbour Lights still cued']);
  });

  it('A ended into Up next: said so, B still cued', () => {
    f.store.setOn(true);
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    f.said.length = 0;
    el.dispatchEvent(new Event('ended'));
    f.play({ ...FERRY, id: '5', title: 'Static Bloom' });
    f.store.refresh();
    expect(f.said).toEqual([
      'Night Ferry ended · Static Bloom is playing · Harbour Lights still cued',
    ]);
  });

  it('A ended with nothing in Up next: the player stops, Play B carries on', () => {
    f.store.setOn(true);
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    f.said.length = 0;
    el.dispatchEvent(new Event('ended'));
    vi.advanceTimersByTime(500);
    expect(f.said).toEqual(['Night Ferry ended · nothing in Up next · Play B to carry on']);
  });

  it('with DJ mode off the element isn’t watched', () => {
    f.store.setOn(true);
    f.store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    f.store.setOn(false);
    f.said.length = 0;
    el.dispatchEvent(new Event('ended'));
    vi.advanceTimersByTime(500);
    expect(f.said).toEqual([]);
  });

  it('B as a Browse row: its player record is fetched for Hand over', async () => {
    f.store.setOn(true);
    f.store.loadB({
      id: '8',
      title: 'Harbour Lights',
      artist: 'Marram',
      image: null,
      duration: 288,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(f.calls).toContain('GET /api/library/dj/track/8');
  });
});
