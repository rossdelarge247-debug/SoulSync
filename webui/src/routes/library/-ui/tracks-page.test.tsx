import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { analysisStore, resetAnalysisRequests } from '@/features/dj/analysis.api';
import { resetDriveStatus } from '@/features/drives/drive-status';
import { getMixState, resetMixForTests } from '@/features/mix/mix-store';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

const addToPlaylist = vi.hoisted(() => vi.fn());
vi.mock('@/features/playlists/add-to-playlist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/playlists/add-to-playlist')>()),
  openAddToPlaylist: addToPlaylist,
}));

/**
 * Library → Tracks (the DJ data, BACKLOG "DJ area" stage 1) through the real
 * router: the URL's BPM range, key and sort drive the browse request, rows
 * show BPM, key and energy, the analysis line offers Stop, and "Mixes well
 * with…" opens the shell's docked panel with Play next and Add to playlist.
 */

function dj(bpm: number, key: string, name: string, long: string, energy: number) {
  return {
    bpm,
    bpm_source: 'analysis',
    key,
    key_name: name,
    key_long: long,
    key_source: 'analysis',
    key_confidence: 0.8,
    key_uncertain: false,
    energy,
    analyzed: true,
  };
}

function track(id: string, title: string, info: ReturnType<typeof dj> | null) {
  return {
    id,
    title,
    artist_name: 'Saltmarsh',
    album_title: 'Lantern',
    artist_id: '1',
    album_id: '10',
    duration_ms: 276000,
    file_path: `/m/${id}.flac`,
    bitrate: 900,
    image_url: null,
    dj: info,
  };
}

const BROWSE = {
  success: true,
  tracks: [
    track('1', 'Static Bloom', dj(124, '8A', 'Am', 'A minor', 7)),
    track('2', 'Night Ferry', dj(126, '9A', 'Em', 'E minor', 6)),
    track('3', 'Not yet', null),
    track('4', 'Two-hour mix', {
      bpm: null,
      bpm_source: null,
      key: null,
      key_name: null,
      key_long: null,
      key_source: null,
      key_confidence: null,
      key_uncertain: false,
      energy: null,
      analyzed: false,
      skipped: 'too long to analyse',
    } as unknown as ReturnType<typeof dj>),
  ],
  total: 4,
  page: 1,
  limit: 50,
  has_more: false,
  sort: 'bpm',
  keys: ['8A', '7A', '9A', '8B'],
};

const STATUS = {
  success: true,
  settings: { analyze: true, write_tags: false, overwrite_tags: false },
  counts: { tracks: 3, analyzed: 2, failed: 0, unreachable: 0, pending: 1 },
  job: {
    id: 4,
    status: 'running',
    total: 1,
    done: 0,
    failed: 0,
    unreachable: 0,
    tags_written: 0,
    started_at: 1,
    waiting: null,
    recent: true,
  },
  held: false,
  can_start: true,
  can_stop: true,
};

const MIXES = {
  success: true,
  track: track('1', 'Static Bloom', dj(124, '8A', 'Am', 'A minor', 7)),
  matches: [
    {
      ...track('2', 'Night Ferry', dj(126, '9A', 'Em', 'E minor', 6)),
      key_relation: 'up',
      bpm_relation: 'same',
      bpm_diff_pct: 1.6,
    },
    {
      ...track('5', 'Low Tide', dj(62, '8A', 'Am', 'A minor', 3)),
      key_relation: 'same',
      bpm_relation: 'half',
      bpm_diff_pct: 0,
    },
  ],
  total: 2,
  reason: null,
};

let requested: { url: string; method: string }[] = [];
let exported: unknown[] = [];
let driveAway = false;
/** analyse on demand: what was asked for, and the progress route's tracks */
let analysed: unknown[] = [];
let progressTracks: Record<string, unknown> = {};
let progressSweep: Record<string, unknown> = { running: false };
let statusBody: Record<string, unknown> = {};

const DRIVE = {
  success: true,
  checked_at: 0,
  interval: 30,
  library_away: true,
  away: ['library'],
  folders: {
    library: {
      role: 'library',
      label: 'Library',
      connected: false,
      last_seen: 1792000000,
      drive: 'Music HD',
    },
  },
  can_check: true,
  boot_id: 'b',
};

beforeEach(() => {
  window.SoulSyncWebShellBridge = createShellBridge();
  window.showLibraryDownloadsSection = vi.fn();
  window.showToast = vi.fn();
  window.playNext = vi.fn();
  requested = [];
  exported = [];
  analysed = [];
  progressTracks = {};
  progressSweep = { running: false };
  statusBody = STATUS;
  resetAnalysisRequests();
  analysisStore.reset();
  driveAway = false;
  resetDriveStatus();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (input instanceof Request ? input.method : init?.method) || 'GET';
      requested.push({ url, method });
      const u = new URL(url, 'http://x');
      let body: unknown = { success: true };
      if (u.pathname.endsWith('/api/library/dj/browse')) body = BROWSE;
      else if (u.pathname.endsWith('/api/library/dj/status')) body = statusBody;
      else if (u.pathname.endsWith('/api/library/dj/mixes/1')) body = MIXES;
      else if (u.pathname.endsWith('/api/stars/count'))
        body = { success: true, count: 48, missing: 1 };
      else if (u.pathname.endsWith('/api/stars/status')) body = { success: true, tracks: {} };
      else if (u.pathname.endsWith('/api/library/dj/progress'))
        body = { success: true, tracks: progressTracks, sweep: progressSweep };
      else if (u.pathname.endsWith('/api/library/dj/analyse')) {
        const raw = input instanceof Request ? await input.text() : (init?.body as string);
        analysed.push(JSON.parse(raw));
        body = {
          success: true,
          asked: 2,
          queued: 1,
          already_queued: 0,
          already_done: 1,
          cant: 0,
          over_limit: 0,
          limit: 200,
          yours: 1,
          started: true,
        };
      } else if (u.pathname.endsWith('/api/library/dj/traktor/export')) {
        const raw = input instanceof Request ? await input.text() : (init?.body as string);
        const sent: unknown = JSON.parse(raw);
        exported.push(sent);
        body = {
          success: true,
          name: 'SYNCHRO.S tracks',
          filename: 'SYNCHRO.S tracks.nml',
          counts: { tracks: 2, found: 2, left_out: 0 },
          example_path: '/Users/ross/SoulSync/music/Saltmarsh/Lantern/01.flac',
          mac_path: '/Users/ross/SoulSync/music',
          library_folder: '/app/Transfer',
          left_out: [],
          reasons: {},
          keys: 2,
          can_edit: true,
          folder: { state: 'unset', shown: null, can_save: false },
        };
      } else if (u.pathname.endsWith('/api/drives/status'))
        body = driveAway ? DRIVE : { ...DRIVE, library_away: false, away: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  delete window.SoulSyncStars;
  resetMixForTests();
  vi.unstubAllGlobals();
  delete window.SoulSyncWebShellBridge;
  delete window.showLibraryDownloadsSection;
  delete window.playNext;
});

function renderPage(entry = '/library?view=tracks') {
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: [entry] });
  const router = createAppRouter({ history, queryClient });
  return { router, ...render(<AppRouterProvider router={router} queryClient={queryClient} />) };
}

const browseParams = () =>
  new URL(requested.filter((r) => r.url.includes('/api/library/dj/browse')).at(-1)!.url, 'http://x')
    .searchParams;

describe('Library → Tracks', () => {
  it('lists tracks with BPM, key and energy, sorted by BPM', async () => {
    renderPage();
    await screen.findByText('Static Bloom');
    expect(screen.getByRole('heading', { level: 1, name: 'Tracks' })).toBeTruthy();
    const row = screen.getByText('Static Bloom').closest('li')!;
    expect(within(row).getByText('124')).toBeTruthy();
    expect(within(row).getByText('8A').getAttribute('title')).toBe(
      'A minor (Am), worked out by SYNCHRO.S',
    );
    expect(within(row).getByText('7')).toBeTruthy();
    const unknown = screen.getByText('Not yet').closest('li')!;
    expect(within(unknown).getAllByText('–')).toHaveLength(3);
    expect(browseParams().get('sort')).toBe('bpm');
    expect(screen.getByText('4 of 4 tracks')).toBeTruthy();
    // a track left out says why
    const long = screen.getByText('Two-hour mix').closest('li')!;
    expect(within(long).getByText(/Too long to analyse/)).toBeTruthy();
  });

  it("sends the URL's BPM range and key", async () => {
    renderPage('/library?view=tracks&bpm=120-128&key=8A:mix&sort=energy');
    await screen.findByText('Static Bloom');
    const params = browseParams();
    expect(params.get('bpm_min')).toBe('120');
    expect(params.get('bpm_max')).toBe('128');
    expect(params.get('key')).toBe('8A:mix');
    expect(params.get('sort')).toBe('energy');
    expect((screen.getByLabelText('Lowest BPM') as HTMLInputElement).value).toBe('120');
    expect((screen.getByLabelText('Key') as HTMLSelectElement).value).toBe('8A');
    expect(
      screen.getByRole('button', { name: 'And keys that mix' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('picks a key from the select', async () => {
    const { router } = renderPage();
    await screen.findByText('Static Bloom');
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: '11A' } });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ key: '11A' }));
    await waitFor(() => expect(browseParams().get('key')).toBe('11A'));
  });

  it("Brief A (31c): the page's line names the track and its step, and how much is ready to mix", async () => {
    // a grid worked out but not ready to mix (no steady beat) isn't counted
    statusBody = { ...STATUS, grids: { done: 2, ready: 1, no_beat: 0, pending: 1 } };
    progressSweep = {
      running: true,
      held: false,
      analyze: true,
      id: 4,
      total: 3,
      done: 1,
      percent: 33,
      waiting: null,
      in_line: 0,
      yours: 0,
      left: 1,
      current: { step: 'key', percent: 35, asked_for: false, track_id: '3', title: 'Canopy' },
    };
    renderPage();
    const words = await screen.findByText('Analysing Canopy · key (3 of 6) · 1 of 3 ready to mix');
    const line = words.closest('[data-analysis-line]')!;
    // the bar fills by step, 3 of 6; Stop lives in the topbar's popover now
    expect(line.querySelector('[data-step="3"]')).not.toBeNull();
    expect(within(line as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('[review M2] a whole-library sweep polls the page slowly; its own rows working, fast', async () => {
    progressSweep = {
      running: true,
      held: false,
      analyze: true,
      id: 4,
      total: 4980,
      done: 10,
      percent: 0,
      waiting: null,
      in_line: 0,
      yours: 0,
      left: 4970,
      current: { step: 'key', percent: 35, asked_for: false, track_id: '99', title: 'Elsewhere' },
    };
    progressTracks = { '1': { state: 'done' }, '2': { state: 'done' } };
    renderPage();
    await screen.findByText(/Analysing Elsewhere/);
    await waitFor(() => expect(analysisStore.delay).toBe(20_000));
    // one of the page's rows is being analysed: the page follows it fast
    progressTracks = { '1': { state: 'working', step: 'read', percent: 5 } };
    analysisStore.pollSoon();
    await waitFor(() => expect(analysisStore.delay).toBe(1_500));
  });

  it('idle: Analyse all (an admin’s) starts a sweep over what isn’t ready', async () => {
    statusBody = {
      ...STATUS,
      grids: { done: 1, no_beat: 0, pending: 1 },
      job: { ...STATUS.job, status: 'done', recent: true },
    };
    progressSweep = {
      running: false,
      held: false,
      analyze: true,
      in_line: 0,
      yours: 0,
      next_in: 1500,
      current: null,
    };
    renderPage();
    const words = await screen.findByText(
      'Analysis idle · next sweep in about 25 min · 1 of 3 ready to mix',
    );
    const line = words.closest('[data-analysis-line]') as HTMLElement;
    fireEvent.click(within(line).getByRole('button', { name: 'Analyse all' }));
    await waitFor(() =>
      expect(
        requested.some((r) => r.url.endsWith('/api/library/dj/start') && r.method === 'POST'),
      ).toBe(true),
    );
  });

  it('opens Mixes well with… from the "…" as the tray in Mix, following that track (33a, 329)', async () => {
    const expand = vi.fn();
    const w = window as unknown as Record<string, unknown>;
    w.SoulSyncPlayer = {
      state: () => ({ track: { id: '9', title: 'Night Ferry' }, queue: [], index: -1 }),
      audio: () => null,
      renderQueue: () => {},
    };
    w.SoulSyncPlayerChrome = { expand, isExpanded: () => false };
    try {
      renderPage();
      await screen.findByText('Static Bloom');
      fireEvent.click(screen.getByRole('button', { name: 'More for Static Bloom' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Mixes well with…' }));
      // no docked panel any more: the tray opens in Mix, following Static Bloom
      expect(screen.queryByRole('complementary')).toBeNull();
      expect(expand).toHaveBeenCalledTimes(1);
      expect(getMixState().mode).toBe('mix');
      expect(getMixState().chain).toEqual([{ id: '1', title: 'Static Bloom' }]);
    } finally {
      delete w.SoulSyncPlayer;
      delete w.SoulSyncPlayerChrome;
    }
  });

  it('Brief D (34a): Play is the visible button, Play next beside it, ⇧-click plays next', async () => {
    const insertNext = vi.fn(() => 2);
    const playIndex = vi.fn();
    const w = window as unknown as Record<string, unknown>;
    w.SoulSyncPlayer = {
      state: () => ({ track: { id: '9' }, queue: [], index: -1 }),
      audio: () => null,
      renderQueue: () => {},
      insertNext,
      playIndex,
    };
    try {
      renderPage();
      const row = (await screen.findByText('Static Bloom')).closest('li')!;
      const play = within(row).getByRole('button', { name: 'Play Static Bloom' });
      const next = within(row).getByRole('button', { name: 'Play Static Bloom next' });
      expect(next.getAttribute('data-kind')).toBe('next');
      fireEvent.click(play);
      expect(insertNext).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
      expect(playIndex).toHaveBeenCalledWith(2);
      fireEvent.click(play, { shiftKey: true });
      expect(window.playNext).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
      // a double-click on the row plays
      insertNext.mockClear();
      fireEvent.doubleClick(within(row).getByText('Static Bloom'));
      expect(insertNext).toHaveBeenCalledTimes(1);
    } finally {
      delete w.SoulSyncPlayer;
    }
  });

  it('draws keys as chips in their hue and energy as a ten-step bar (17a)', async () => {
    renderPage();
    const row = (await screen.findByText('Static Bloom')).closest('li')!;
    const key = within(row).getByText('8A');
    expect(key.getAttribute('data-key-hue')).toBe('0');
    expect(key.className).toMatch(/keyChip/);
    expect(row.querySelectorAll('[data-lit="true"]')).toHaveLength(7);
    const next = screen.getByText('Night Ferry').closest('li')!;
    expect(within(next).getByText('9A').getAttribute('data-key-hue')).toBe('30');
  });

  it('says what the filter covers, with Clear filters (HANDOFF 168)', async () => {
    const { router } = renderPage('/library?view=tracks&bpm=120-128&key=8A:mix');
    await screen.findByText('Static Bloom');
    await screen.findByText(/^4 tracks at 120–128 BPM in 8A, 7A, 9A or 8B/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('key'));
  });

  it("keeps the list when the library's drive is away, with the Notice above it", async () => {
    driveAway = true;
    renderPage();
    await screen.findByText('Static Bloom');
    await screen.findByText('Your library’s drive isn’t connected');
    expect(screen.getByRole('heading', { level: 1, name: 'Tracks' })).toBeTruthy();
    // 123: Play waits for the drive, disabled-neutral and described by the reason
    const play = screen.getByRole('button', { name: 'Play Static Bloom next' });
    expect(play.getAttribute('aria-disabled')).toBe('true');
    expect(play).not.toBeDisabled();
    const reason = document.getElementById(play.getAttribute('aria-describedby')!)!;
    expect(reason.textContent).toBe('Music HD isn’t connected');
    fireEvent.click(play);
    expect(window.playNext).not.toHaveBeenCalled();
    // 172 (23a): the "…" menu's Play next says why on a second line
    const row = play.closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'More for Static Bloom' }));
    const next = await screen.findByRole('menuitem', { name: 'Play next' });
    expect(next.getAttribute('aria-disabled')).toBe('true');
    expect(next).toHaveAccessibleDescription('Music HD isn’t connected');
    expect(next.textContent).toBe('Play nextMusic HD isn’t connected');
  });

  it('keeps 24a’s one order in the "…" menu: Add to set… fourth (154, 28a)', async () => {
    renderPage();
    const row = (await screen.findByText('Static Bloom')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'More for Static Bloom' }));
    await screen.findByRole('menuitem', { name: 'Mixes well with…' });
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Play next',
      'Add to Up next',
      'Mixes well with…',
      'Add to set…',
      'Add to playlist…',
      'Double BPM',
      'Halve BPM',
      'Open artist',
      'Open album',
    ]);
  });

  it('Starred is a filter chip with its count (24a, 28a)', async () => {
    const { router } = renderPage();
    await screen.findByText('Static Bloom');
    const chip = await screen.findByRole('button', { name: /Starred/ });
    await waitFor(() => expect(chip.textContent).toBe('Starred48'));
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(browseParams().get('starred')).toBeNull();
    fireEvent.click(chip);
    await waitFor(() => expect(browseParams().get('starred')).toBe('1'));
    expect(router.state.location.search).toMatchObject({ view: 'tracks', starred: '1' });
    expect(screen.getByRole('button', { name: /Starred/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a row’s star: starred rows show it, others on hover; none without a file (28a)', async () => {
    BROWSE.tracks[0] = { ...BROWSE.tracks[0], starred: true } as (typeof BROWSE.tracks)[number];
    BROWSE.tracks[1] = { ...BROWSE.tracks[1], starred: false } as (typeof BROWSE.tracks)[number];
    try {
      renderPage();
      const row = (await screen.findByText('Static Bloom')).closest('li')!;
      expect(row).toHaveAttribute('data-star-row', '1');
      const star = await within(row).findByRole('button', { name: 'Unstar Static Bloom' });
      expect(star).toHaveAttribute('data-star', 'on');
      const other = screen.getByText('Night Ferry').closest('li')!;
      expect(within(other).getByRole('button', { name: 'Star Night Ferry' })).toHaveAttribute(
        'data-star',
        'off',
      );
    } finally {
      delete (BROWSE.tracks[0] as { starred?: boolean }).starred;
      delete (BROWSE.tracks[1] as { starred?: boolean }).starred;
    }
  });

  it('selects tracks and exports them to Traktor from the selection bar (21a)', async () => {
    renderPage();
    await screen.findByText('Static Bloom');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected tracks' });
    expect(within(bar).getByText('0 tracks selected')).toBeTruthy();
    const exportButton = within(bar).getByRole('button', { name: 'Export to Traktor…' });
    expect(exportButton).toHaveAttribute('aria-disabled', 'true');
    expect(exportButton.getAttribute('data-variant')).toBe('secondary');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Static Bloom' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Night Ferry' }));
    expect(within(bar).getByText('2 tracks selected')).toBeTruthy();
    expect(screen.getByText('Static Bloom').closest('li')!.dataset.selected).toBe('true');
    fireEvent.click(within(bar).getByRole('button', { name: 'Export to Traktor…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export 2 tracks to Traktor?' });
    await within(dialog).findByRole('button', { name: 'Export 2 tracks' });
    expect(exported[0]).toEqual({ action: 'preview', source: 'tracks', track_ids: ['1', '2'] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(within(bar).getByRole('button', { name: 'Select all 4 shown' }));
    expect(within(bar).getByText('4 tracks selected')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('toolbar', { name: 'Selected tracks' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Select Static Bloom' })).toBeNull();
  });

  it('the selection’s “…” holds Star all, Add to playlist…, Start a set from these and Clear the selection (28b, 232)', async () => {
    addToPlaylist.mockClear();
    renderPage();
    await screen.findByText('Static Bloom');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected tracks' });
    fireEvent.click(within(bar).getByRole('button', { name: 'More actions for the selection' }));
    await screen.findByRole('menuitem', { name: 'Add to playlist…' });
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Star all',
      'Add to playlist…',
      'Double BPM',
      'Halve BPM',
      'Start a set from these',
      'Analyse theseTick tracks to select them',
      'Clear the selection',
    ]);
    // nothing picked: they all wait
    for (const name of [
      'Star all',
      'Add to playlist…',
      'Start a set from these',
      'Clear the selection',
    ]) {
      expect(screen.getByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true');
    }
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Static Bloom' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Night Ferry' }));
    fireEvent.click(within(bar).getByRole('button', { name: 'More actions for the selection' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add to playlist…' }));
    expect(addToPlaylist).toHaveBeenCalledTimes(1);
    expect(
      (addToPlaylist.mock.calls[0]![0] as Array<{ track_name: string }>).map((t) => t.track_name),
    ).toEqual(['Static Bloom', 'Night Ferry']);
    expect(addToPlaylist.mock.calls[0]![0][0]).toMatchObject({
      artist_name: 'Saltmarsh',
      album_name: 'Lantern',
      duration_ms: 276000,
    });
  });
  it('analyse on demand: a row in line shows its step, and the selection can Analyse these', async () => {
    progressTracks = {
      '3': { state: 'working', step: 'grid', percent: 60 },
      '2': { state: 'queued', position: 1240, asked_for: false },
    };
    renderPage();
    await screen.findByText('Static Bloom');
    // the row's marker (31c): the bar and the step while it's analysed
    const row = (await screen.findByText('Analysing · beat grid (5 of 6)')).closest('li')!;
    expect(within(row).getByText('Not yet')).toBeTruthy();
    expect(row.querySelector('[data-analysis-marker] [data-step="5"]')).not.toBeNull();
    // the sweep's own order isn't shown as a place: the row says what it has (HANDOFF 334)
    expect(screen.queryByText(/1,240th/)).toBeNull();
    const queued = screen.getByText('Night Ferry').closest('li')!;
    expect(within(queued).getByText('Not analysed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Static Bloom' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Not yet' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected tracks' });
    fireEvent.click(within(bar).getByRole('button', { name: 'More actions for the selection' }));
    const item = await screen.findByRole('menuitem', { name: 'Analyse these' });
    expect(item.textContent).toContain('2 tracks · ones already done are skipped');
    fireEvent.click(item);
    await waitFor(() =>
      expect(analysed).toEqual([{ track_ids: ['1', '3'], reason: 'asked', source: 'asked' }]),
    );
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith(
        '1 track will be analysed next. 1 track already done is skipped.',
        'success',
      ),
    );
  });

  it('Start a set from these opens a draft with the picked tracks, in the order picked', async () => {
    window.localStorage.clear();
    const { router } = renderPage();
    await screen.findByText('Static Bloom');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected tracks' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Night Ferry' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Static Bloom' }));
    fireEvent.click(within(bar).getByRole('button', { name: 'More actions for the selection' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Start a set from these' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ view: 'sets', set: 'draft' }),
    );
    const stored = Object.keys(window.localStorage)
      .filter((k) => k.startsWith('soulsync.sets.draft.'))
      .map(
        (k) => JSON.parse(window.localStorage.getItem(k)!) as { rows: Array<{ title: string }> },
      );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.rows.map((r) => r.title)).toEqual(['Night Ferry', 'Static Bloom']);
  });
});
