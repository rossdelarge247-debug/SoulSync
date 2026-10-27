/**
 * The Mix tab (Mix tab.dc.html, 29a–29d) as the shell shows it: the Now
 * playing · Mix switch in the record, the tray's three columns, the working
 * set (Add, "✓ Added · #7", start one), Add after the playing track while
 * the set plays, More like this, Suggest from, Vibe's states, the states of
 * 29d, the keys (A, N, M), the Visuals drawer and the phone's Mix · Set.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { analysisStore, resetAnalysisRequests } from '@/features/dj/analysis.api';
import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';

import { MixTabHost } from './mix-host';
import { MODE_STORAGE_KEY, getMixState, resetMixForTests, setTrayMode } from './mix-store';

vi.mock('@/platform/shell/route-controllers', () => ({
  useProfile: () => ({ profileId: 1 }),
}));

function dj(bpm: number | null, key: string | null, energy: number | null, extra = {}) {
  return {
    bpm,
    bpm_source: 'tag',
    key,
    key_name: key ? 'Am' : null,
    key_long: key ? 'A minor' : null,
    key_source: key ? 'tag' : null,
    key_confidence: null,
    key_uncertain: false,
    energy,
    analyzed: Boolean(key),
    ...extra,
  };
}

function track(id: string, title: string, artist: string, info: ReturnType<typeof dj> | null) {
  return {
    id,
    title,
    artist_name: artist,
    album_title: `${artist} EP`,
    artist_id: '1',
    album_id: '10',
    duration_ms: 362000,
    file_path: `/m/${id}.flac`,
    bitrate: 900,
    image_url: null,
    dj: info,
  };
}

const FERRY = track('1', 'Night Ferry', 'Tidewater', dj(124, '8A', 6));
const BLOOM = track('5', 'Static Bloom', 'Saltmarsh', dj(126, '9A', 7));
const UNDERTOW = track('6', 'Undertow', 'Tidewater', dj(124, '8A', 4));
const COPPER = track('4', 'Copper Sky', 'Ines Varga', dj(120, '8B', 5));

function match(t: ReturnType<typeof track>, reason: string, short: string, starred = false) {
  return {
    ...t,
    key_relation: 'same',
    bpm_relation: 'same',
    bpm_diff_pct: 1.6,
    reason,
    reason_short: short,
    starred,
    signals: {
      starred,
      played: null,
      energy_delta: 1,
      style: 0,
      shared_genres: [],
      same_artist: false,
    },
  };
}

const MATCHES = [
  match(BLOOM, 'One step on the wheel · +1.6% BPM · energy ↑1', 'step · +1.6% · ↑1', true),
  match(UNDERTOW, 'Same key · same BPM · energy ↓2', 'same key · ↓2'),
];

interface World {
  playing: Record<string, unknown> | null;
  kind: string;
  queue: { id: string }[];
  index: number;
  working: { id: number; name: string } | null;
  rows: ReturnType<typeof viewRow>[];
  mixes: Record<string, unknown>;
  ai: { can_use: boolean; reason: string | null };
  asked: string[];
  setAts: string[];
  added: unknown[];
  started: unknown[];
  vibes: number;
  /** analyse on demand: what was asked for, and each track's progress */
  analysed: unknown[];
  progress: Record<string, unknown>;
}

function viewRow(t: ReturnType<typeof track>, transition: unknown = null) {
  return {
    track_id: t.id,
    artist: t.artist_name,
    title: t.title,
    at: null,
    state: 'owned',
    want: 'yours',
    version: null,
    locked: false,
    note: null,
    transition: transition ?? { style: 'auto', bars: null },
    mbid: null,
    raw: null,
    track: t,
  };
}

let world: World;

function answer(seed: ReturnType<typeof track>, matches = MATCHES, extra = {}) {
  return {
    success: true,
    track: seed,
    matches,
    total: matches.length,
    reason: matches.length ? null : 'none',
    within: 6,
    ranked: 'mix',
    wide: false,
    set: null,
    ...extra,
  };
}

function serve() {
  server.use(
    http.get('/api/library/dj/mixes/:id', ({ params, request }) => {
      const url = new URL(request.url);
      world.asked.push(
        `${String(params.id)}${url.searchParams.get('wide') ? ':wide' : ''}${
          url.searchParams.get('set_id') ? `:set${url.searchParams.get('set_id')}` : ''
        }`,
      );
      if (url.searchParams.get('set_at')) world.setAts.push(url.searchParams.get('set_at')!);
      const key = `${String(params.id)}${url.searchParams.get('wide') ? ':wide' : ''}`;
      const found = world.mixes[key] ?? world.mixes[String(params.id)];
      if (!found)
        return HttpResponse.json(
          { success: false, error: "That track isn't in your library" },
          { status: 404 },
        );
      return HttpResponse.json(found);
    }),
    http.post('/api/library/dj/mixes/:id/vibe', () => {
      world.vibes += 1;
      return HttpResponse.json({
        ...answer(FERRY, [MATCHES[1], MATCHES[0]]),
        vibe: { line: 'Darker and slower first.' },
      });
    }),
    http.post('/api/library/dj/tracks', () =>
      HttpResponse.json({ success: true, tracks: { '1': FERRY.dj } }),
    ),
    http.get('/api/library/dj/status', () =>
      HttpResponse.json({
        success: true,
        settings: { analyze: true, write_tags: false, overwrite_tags: false },
        counts: { tracks: 100, analyzed: 88, failed: 0, unreachable: 0, pending: 12 },
        job: null,
        held: false,
        can_start: true,
        can_stop: true,
      }),
    ),
    http.post('/api/library/dj/start', async ({ request }) => {
      world.started.push(await request.json());
      return HttpResponse.json({ success: true, job: null }, { status: 202 });
    }),
    http.post('/api/library/dj/analyse', async ({ request }) => {
      world.analysed.push(await request.json());
      return HttpResponse.json(
        {
          success: true,
          asked: 1,
          queued: 1,
          already_queued: 0,
          already_done: 0,
          cant: 0,
          over_limit: 0,
          limit: 200,
          yours: 1,
          started: true,
        },
        { status: 202 },
      );
    }),
    http.post('/api/library/dj/progress', async ({ request }) => {
      const ids = ((await request.json()) as { track_ids: string[] }).track_ids;
      const tracks: Record<string, unknown> = {};
      for (const id of ids) if (world.progress[id]) tracks[id] = world.progress[id];
      return HttpResponse.json({
        success: true,
        tracks,
        sweep: { running: false, held: false, analyze: true, in_line: 0, yours: 0, current: null },
      });
    }),
    http.get('/api/ai/status', () =>
      HttpResponse.json({ success: true, configured: true, ...world.ai }),
    ),
    http.get('/api/sets/working', () =>
      HttpResponse.json({
        success: true,
        working: world.working
          ? { ...world.working, kind: 'hand', revision: 2, updated_at: 1 }
          : null,
      }),
    ),
    http.get('/api/sets', () =>
      HttpResponse.json({
        success: true,
        sets: world.working
          ? [
              {
                id: world.working.id,
                name: world.working.name,
                tracks: world.rows.length,
                seconds: 2280,
                energy: [],
              },
            ]
          : [],
      }),
    ),
    http.get('/api/sets/:id', () => {
      const steps = world.rows.map((_r, i) =>
        i < world.rows.length - 1
          ? { kind: 'smooth', reason: '8B → 8A, +4 BPM · relative minor', steps: 1, bpm_diff: 4 }
          : null,
      );
      return HttpResponse.json({
        success: true,
        set: { id: world.working?.id, name: world.working?.name, revision: 2 },
        rows: world.rows,
        steps,
        summary: { tracks: world.rows.length, seconds: 2280 },
      });
    }),
    http.post('/api/sets/view', () =>
      HttpResponse.json({
        success: true,
        rows: [],
        steps: [
          { kind: 'smooth', reason: '8B → 8A, +4 BPM · relative minor', steps: 1, bpm_diff: 4 },
          null,
        ],
        summary: {},
      }),
    ),
    http.post('/api/sets/:id/tracks', async ({ request }) => {
      const body = (await request.json()) as { track_ids: string[] };
      world.added.push(body);
      return HttpResponse.json({
        success: true,
        id: world.working?.id,
        name: world.working?.name,
        added: body.track_ids.map((t, k) => ({ track_id: t, number: 7 + k })),
        already: [],
        left_out: [],
        revision: 3,
        playlist_state: null,
        placed: 'end',
      });
    }),
    http.post('/api/sets/working/start', async ({ request }) => {
      world.started.push(await request.json());
      return HttpResponse.json(
        { success: true, id: 9, working: { id: 9, name: 'Set from', kind: 'hand', revision: 0 } },
        { status: 201 },
      );
    }),
    http.post('/api/stars/status', async ({ request }) => {
      const body = (await request.json()) as { track_ids?: string[] };
      const tracks: Record<string, { starred: boolean; can_star: boolean }> = {};
      for (const id of body.track_ids ?? []) tracks[id] = { starred: id === '5', can_star: true };
      return HttpResponse.json({ success: true, tracks, songs: [] });
    }),
  );
}

const playNext = vi.fn();
const toasts: string[] = [];

function shell(): void {
  document.body.innerHTML = `
    <section class="ss-player" id="media-player">
      <div class="ss-player-tray" id="ss-player-tray">
        <div class="ss-player-record"><div class="ss-player-modes" data-player-modes="music"></div><p>Record</p></div>
        <div class="ss-player-record ss-player-rtray-record"><div class="ss-player-modes" data-player-modes="radio"></div></div>
        <div class="ss-player-mix" data-player-mix hidden></div>
      </div>
    </section>
    <div id="np-modal-overlay" class="hidden">
      <div class="np-modal">
        <button id="np-v2-visuals-mix-btn" hidden><span>Mix</span></button>
        <button id="np-v2-visuals-panel-btn">Visuals</button>
      </div>
    </div>`;
  const w = window as unknown as Record<string, unknown>;
  w.SoulSyncPlayer = {
    state: () => ({
      track: world.playing,
      kind: world.kind,
      queue: world.queue,
      index: world.index,
    }),
    audio: () => null,
  };
  w.playNext = playNext;
  w.showToast = (m: string) => toasts.push(m);
}

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MixTabHost />
    </QueryClientProvider>,
    { container: host },
  );
}

function player() {
  act(() => {
    window.dispatchEvent(new CustomEvent('ss:player', { detail: { reason: 'track' } }));
  });
}

beforeEach(() => {
  resetMixForTests();
  playNext.mockReset();
  toasts.length = 0;
  world = {
    playing: { id: '1', title: 'Night Ferry', artist: 'Tidewater', image_url: null },
    kind: 'library',
    queue: [{ id: '1' }],
    index: 0,
    working: { id: 3, name: 'Sunday Set' },
    rows: [viewRow(COPPER), viewRow(UNDERTOW)],
    mixes: {
      '1': answer(FERRY),
      '5': answer(BLOOM, [MATCHES[1]]),
      '6': answer(UNDERTOW, [MATCHES[0]]),
    },
    ai: { can_use: false, reason: 'not_configured' },
    asked: [],
    setAts: [],
    added: [],
    started: [],
    vibes: 0,
    analysed: [],
    progress: {},
  };
  resetAnalysisRequests();
  analysisStore.reset();
  serve();
  shell();
});

afterEach(() => {
  cleanup();
  const w = window as unknown as Record<string, unknown>;
  delete w.SoulSyncPlayer;
  delete w.SoulSyncRadio;
  delete w.playNext;
  delete w.showToast;
  document.documentElement.removeAttribute('data-mix-available');
});

const root = () => document.getElementById('media-player')!;
const mixSlot = () => document.querySelector<HTMLElement>('[data-player-mix]')!;

async function openMix() {
  mount();
  const tab = await within(
    document.querySelector<HTMLElement>('[data-player-modes="music"]')!,
  ).findByRole('tab', { name: 'Mix' });
  fireEvent.click(tab);
  await waitFor(() => expect(root().dataset.trayMode).toBe('mix'));
  return within(mixSlot());
}

describe('the tray in Mix (29a)', () => {
  it('puts Now playing · Mix in the record and remembers the mode per browser', async () => {
    const mix = await openMix();
    expect(document.documentElement.hasAttribute('data-mix-available')).toBe(true);
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBe('mix');
    expect(mixSlot().hidden).toBe(false);
    expect(await mix.findByRole('region', { name: 'Mixes well with' })).toBeInTheDocument();
    expect(mix.getByRole('region', { name: 'The working set' })).toBeInTheDocument();
    // this track: key chip, BPM, the ten-step meter, the star
    expect(mix.getByText('A minor')).toBeInTheDocument();
    expect(mix.getByText('124 BPM')).toBeInTheDocument();
    expect(await mix.findByText('Energy 6 of 10')).toBeInTheDocument();
    expect(mix.getByRole('meter', { name: 'Energy' })).toHaveAttribute('aria-valuenow', '6');
    fireEvent.click(mix.getByRole('tab', { name: 'Now playing' }));
    expect(root().dataset.trayMode).toBeUndefined();
    expect(mixSlot().hidden).toBe(true);
  });

  it('lists the top matches with their reasons, Play next and More like this', async () => {
    const mix = await openMix();
    const list = await mix.findByRole('list', { name: 'Tracks that mix well with Night Ferry' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Static Bloom · Saltmarsh');
    expect(rows[0]).toHaveTextContent('One step on the wheel · +1.6% BPM · energy ↑1');
    expect(within(rows[0]).getByRole('img', { name: 'starred' })).toBeInTheDocument();
    // the working set's tracks are asked to be left out
    expect(world.asked).toContain('1:set3');
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Play Static Bloom next' }));
    expect(playNext).toHaveBeenCalledWith(
      expect.objectContaining({ id: '5', title: 'Static Bloom' }),
    );
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'More like Static Bloom' }));
    expect(
      await mix.findByRole('list', { name: 'Tracks that mix well with Static Bloom' }),
    ).toBeInTheDocument();
    fireEvent.click(mix.getByRole('button', { name: 'Back to Night Ferry' }));
    expect(
      await mix.findByRole('list', { name: 'Tracks that mix well with Night Ferry' }),
    ).toBeInTheDocument();
    expect(mix.getByText(/starred first among equals/)).toBeInTheDocument();
  });

  it('suggests from the end of the set', async () => {
    const mix = await openMix();
    await mix.findByRole('list', { name: 'Tracks that mix well with Night Ferry' });
    fireEvent.click(mix.getByRole('radio', { name: 'End of set' }));
    expect(
      await mix.findByRole('list', { name: 'Tracks that mix well with Undertow' }),
    ).toBeInTheDocument();
    expect(getMixState().from).toBe('end');
  });

  it('adds the playing track to the working set, then says "✓ Added · #7"', async () => {
    const mix = await openMix();
    // the strip: the set's last tracks, then the playing one, and the join
    expect(await mix.findByText('now')).toBeInTheDocument();
    expect(
      await mix.findByText(
        (_t, el) =>
          el?.tagName === 'P' &&
          /Night Ferry would follow Undertow: Smooth · 8B → 8A, \+4 BPM/.test(el.textContent ?? ''),
      ),
    ).toBeInTheDocument();
    const add = mix.getByRole('button', { name: 'Add Night Ferry to Sunday Set' });
    fireEvent.click(add);
    expect(await mix.findByRole('button', { name: '✓ Added · #7' })).toBeInTheDocument();
    expect(world.added).toEqual([{ track_ids: ['1'], again: false }]);
  });

  it('with no working set: the card, and A starts "Set from …" with the track', async () => {
    world.working = null;
    const mix = await openMix();
    expect(await mix.findByText('Start a mix set to collect tracks')).toBeInTheDocument();
    expect(
      mix.getByRole('button', { name: 'Add Night Ferry to a new mix set' }),
    ).toBeInTheDocument();
    let acted = false;
    act(() => {
      acted = window.SoulSyncMix!.key('A');
    });
    expect(acted).toBe(true);
    await waitFor(() => expect(world.started).toHaveLength(1));
    expect(world.started[0]).toEqual({
      name: expect.stringMatching(/^Set from \w+day \d+ \w{3}$/),
      track_ids: ['1'],
    });
  });
});

describe('while the set plays (29b)', () => {
  it('says where it is, and Add puts a match after the playing track', async () => {
    world.rows = [
      viewRow(COPPER),
      viewRow(FERRY, { style: 'long_blend', bars: 32 }),
      viewRow(BLOOM),
    ];
    world.queue = [{ id: '4' }, { id: '1' }, { id: '5' }];
    world.index = 1;
    const mix = await openMix();
    expect(await mix.findByText('Playing Sunday Set · track 2 of 3')).toBeInTheDocument();
    expect(mix.getByText('Long blend · 32 bars')).toBeInTheDocument();
    expect(mix.getByRole('button', { name: 'Night Ferry is #2 in Sunday Set' })).toBeDisabled();
    const list = await mix.findByRole('list', { name: 'Tracks that mix well with Night Ferry' });
    fireEvent.click(within(list).getAllByRole('button', { name: /^Add .* to Sunday Set$/ })[1]);
    await waitFor(() => expect(world.added).toHaveLength(1));
    // the direction is read up to where Add puts tracks (gauntlet L6)
    expect(world.setAts).toContain('2');
    expect(world.added[0]).toEqual({
      track_ids: ['6'],
      again: false,
      after: { track_id: '1', number: 2 },
    });
  });
});

describe("29d's states", () => {
  it('[review M1, M2] asks and watches only while the tab is shown, not for a track merely playing', async () => {
    world.mixes['1'] = {
      ...answer(track('1', 'Night Ferry', 'Tidewater', null), []),
      reason: 'not_analyzed',
    };
    world.progress['1'] = { state: 'queued', position: 3, asked_for: true };
    const polled: string[][] = [];
    server.use(
      http.post('/api/library/dj/progress', async ({ request }) => {
        const ids = ((await request.json()) as { track_ids: string[] }).track_ids;
        polled.push(ids);
        return HttpResponse.json({
          success: true,
          tracks: { '1': world.progress['1'] },
          sweep: { running: true, held: false, analyze: true, in_line: 1, yours: 1, current: null },
        });
      }),
    );
    const tray = document.getElementById('ss-player-tray')!;
    tray.hidden = true;
    mount();
    const pause = () =>
      act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });
    await pause();
    // the tray is shut: nothing asked, nothing watched
    expect(world.analysed).toEqual([]);
    expect(polled).toEqual([]);
    // Now playing with the tray open: still nothing
    act(() => {
      tray.hidden = false;
    });
    await pause();
    expect(world.analysed).toEqual([]);
    expect(polled).toEqual([]);
    // the Mix tab shown: asked for (automatically), and watched
    fireEvent.click(
      await within(document.querySelector<HTMLElement>('[data-player-modes="music"]')!).findByRole(
        'tab',
        { name: 'Mix' },
      ),
    );
    await waitFor(() => expect(world.analysed).toEqual([{ track_ids: ['1'], reason: 'auto' }]));
    await waitFor(() => expect(polled.flat()).toContain('1'));
    // the tray shut again: the watch stops, so the poll does
    act(() => {
      tray.hidden = true;
    });
    await waitFor(() => expect(analysisStore.scheduled).toBe(false));
    const seen = polled.length;
    await pause();
    expect(polled).toHaveLength(seen);
  });

  it('not analysed yet: asked for at once (any profile), its step shows', async () => {
    world.mixes['1'] = {
      ...answer(track('1', 'Night Ferry', 'Tidewater', null), []),
      reason: 'not_analyzed',
    };
    world.progress['1'] = { state: 'working', step: 'grid', percent: 60 };
    const mix = await openMix();
    expect(await mix.findByText('Night Ferry is being worked out')).toBeInTheDocument();
    // opening it asked for it: analyse on demand, not the admins' /start
    await waitFor(() => expect(world.analysed).toEqual([{ track_ids: ['1'], reason: 'auto' }]));
    expect(world.started).toEqual([]);
    const bars = await mix.findAllByRole('progressbar', { name: 'Analysis of Night Ferry' });
    expect(bars[0]).toHaveAttribute('aria-valuenow', '60');
    expect(mix.getAllByText('Finding the beat grid · 60%').length).toBeGreaterThan(0);
    // in line, so no "tracks ahead" and no button
    expect(mix.queryByText(/\(12 tracks ahead\)/)).toBeNull();
    expect(mix.queryByRole('button', { name: 'Analyse this one now' })).toBeNull();
  });

  it('not in any line: Analyse this one now asks again', async () => {
    world.mixes['1'] = {
      ...answer(track('1', 'Night Ferry', 'Tidewater', null), []),
      reason: 'not_analyzed',
    };
    world.progress['1'] = {
      state: 'waiting',
      reason: 'not_queued',
      position: null,
      asked_for: false,
    };
    const mix = await openMix();
    expect(await mix.findByText('Night Ferry is being worked out')).toBeInTheDocument();
    await waitFor(() => expect(world.analysed).toHaveLength(1));
    expect(mix.getByText(/\(12 tracks ahead\)/)).toBeInTheDocument();
    fireEvent.click(await mix.findByRole('button', { name: 'Analyse this one now' }));
    // asks are a second apart (the server takes one a second a profile)
    await waitFor(() => expect(world.analysed).toHaveLength(2), { timeout: 4000 });
    expect(world.analysed[1]).toEqual({ track_ids: ['1'], reason: 'asked' });
  });

  it('nothing fits: Widen the search asks for 10% and any key', async () => {
    world.mixes['1'] = answer(FERRY, []);
    world.mixes['1:wide'] = { ...answer(FERRY, [MATCHES[0]]), wide: true, within: 10 };
    const mix = await openMix();
    expect(await mix.findByText('Nothing in your library fits Night Ferry')).toBeInTheDocument();
    fireEvent.click(mix.getByRole('button', { name: 'Widen the search' }));
    expect(
      await mix.findByRole('list', { name: 'Tracks that mix well with Night Ferry' }),
    ).toBeInTheDocument();
    expect(world.asked).toContain('1:wide:set3');
  });

  it('not from your library: a preview', async () => {
    world.playing = { id: 'dz1', title: 'Gravity Well', is_preview: true };
    world.kind = 'stream';
    const mix = await openMix();
    expect(await mix.findByText('Mix works on your own tracks')).toBeInTheDocument();
    expect(mix.getByText(/This is a stream preview/)).toBeInTheDocument();
    // the keys stay the player's for a preview (gauntlet L7): M mutes, N skips
    expect(window.SoulSyncMix!.key('M')).toBe(false);
    expect(window.SoulSyncMix!.key('N')).toBe(false);
    expect(window.SoulSyncMix!.key('A')).toBe(false);
  });

  it('podcasts and books: no tab, and the keys are left to the player', async () => {
    world.kind = 'podcast';
    mount();
    await act(async () => {});
    expect(document.querySelector('[data-player-modes="music"]')!.childElementCount).toBe(0);
    expect(window.SoulSyncMix!.key('M')).toBe(false);
    expect(window.SoulSyncMix!.key('N')).toBe(false);
    expect(document.documentElement.hasAttribute('data-mix-available')).toBe(false);
  });

  it('radio with an identified library track: the tab works for it', async () => {
    world.kind = 'radio';
    (window as unknown as Record<string, unknown>).SoulSyncRadio = {
      state: () => ({
        nowPlaying: {
          state: 'identified',
          track: { title: 'Night Ferry', artist: 'Tidewater', release: null, art_url: null },
          library: { in_library: true, below_target: null, track_id: '1' },
        },
      }),
    };
    mount();
    const tab = await within(
      document.querySelector<HTMLElement>('[data-player-modes="radio"]')!,
    ).findByRole('tab', {
      name: 'Mix',
    });
    fireEvent.click(tab);
    expect(
      await within(mixSlot()).findByRole('list', { name: 'Tracks that mix well with Night Ferry' }),
    ).toBeInTheDocument();
  });
});

describe('Vibe', () => {
  it('is off by default, and says why it can’t be used', async () => {
    const mix = await openMix();
    const sw = await mix.findByRole('switch', { name: /Vibe/ });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(sw).toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(sw);
    expect(
      await mix.findByText('Vibe: The AI is off: an admin adds a key in Settings → AI.'),
    ).toBeInTheDocument();
    expect(world.vibes).toBe(0);
  });

  it('re-ranks for feel through the AI when switched on', async () => {
    world.ai = { can_use: true, reason: null };
    const mix = await openMix();
    await mix.findByRole('list', { name: 'Tracks that mix well with Night Ferry' });
    const sw = mix.getByRole('switch', { name: /Vibe/ });
    await waitFor(() => expect(sw).not.toHaveAttribute('aria-disabled'));
    fireEvent.click(sw);
    expect(
      await mix.findByText(
        'Ordered for feel by the AI. The AI’s note: “Darker and slower first.”'.replace('’', "'"),
      ),
    ).toBeInTheDocument();
    const rows = within(
      mix.getByRole('list', { name: 'Tracks that mix well with Night Ferry' }),
    ).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Undertow');
    expect(world.vibes).toBe(1);
  });
});

describe('the keys (24a)', () => {
  it('N plays the top match next; M switches the tray and expands it', async () => {
    const expand = vi.fn();
    (window as unknown as Record<string, unknown>).SoulSyncPlayerChrome = {
      expand,
      isExpanded: () => false,
      openSheet: vi.fn(),
    };
    mount();
    await within(document.querySelector<HTMLElement>('[data-player-modes="music"]')!).findByRole(
      'tab',
      {
        name: 'Mix',
      },
    );
    act(() => {
      expect(window.SoulSyncMix!.key('M')).toBe(true);
    });
    expect(getMixState().mode).toBe('mix');
    expect(expand).toHaveBeenCalled();
    await within(mixSlot()).findByRole('list', { name: 'Tracks that mix well with Night Ferry' });
    act(() => {
      expect(window.SoulSyncMix!.key('N')).toBe(true);
    });
    expect(playNext).toHaveBeenCalledWith(expect.objectContaining({ id: '5' }));
    delete (window as unknown as Record<string, unknown>).SoulSyncPlayerChrome;
  });
});

describe('Visuals: the drawer (29b)', () => {
  it('opens from the header, leaves the set out, and closes on Escape', async () => {
    setTrayMode('now');
    mount();
    const overlay = document.getElementById('np-modal-overlay')!;
    act(() => overlay.classList.remove('hidden'));
    const button = document.getElementById('np-v2-visuals-mix-btn')!;
    await waitFor(() => expect(button.hidden).toBe(false));
    fireEvent.click(button);
    const drawer = await screen.findByRole('region', { name: 'Mix' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(
      await within(drawer).findByRole('list', { name: 'Tracks that mix well with Night Ferry' }),
    ).toBeInTheDocument();
    expect(window.SoulSyncMix!.drawerOpen()).toBe(true);
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Mix' })).toBeNull());
  });
});

describe('the phone (29c)', () => {
  it('is the Mix · Set sheet', async () => {
    const mm = vi.fn((q: string) => ({
      matches: q.includes('max-width: 768px'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.stubGlobal('matchMedia', mm);
    try {
      const mix = await openMix();
      expect(await mix.findByRole('tab', { name: 'Set' })).toBeInTheDocument();
      const list = await mix.findByRole('list', { name: 'Tracks that mix well with Night Ferry' });
      expect(list).toHaveTextContent('step · +1.6% · ↑1');
      expect(
        mix.getByText('More like this is in each row’s long-press.'.replace('’', "'")),
      ).toBeInTheDocument();
      fireEvent.click(mix.getByRole('tab', { name: 'Set' }));
      expect(await mix.findByRole('list', { name: "Sunday Set's tracks" })).toBeInTheDocument();
      expect(mix.getByRole('button', { name: 'Add Night Ferry · as #3' })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it('keeps nothing when the player has no track', async () => {
  world.playing = null;
  mount();
  await act(async () => {});
  expect(document.querySelector('[data-player-modes="music"]')!.childElementCount).toBe(0);
  expect(document.querySelector('[data-mix-col]')).toBeNull();
  player();
});
