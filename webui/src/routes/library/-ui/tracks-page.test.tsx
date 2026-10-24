import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { resetMixesForTests } from '@/features/dj/mixes-store';
import { resetDriveStatus } from '@/features/drives/drive-status';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

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
      else if (u.pathname.endsWith('/api/library/dj/status')) body = STATUS;
      else if (u.pathname.endsWith('/api/library/dj/mixes/1')) body = MIXES;
      else if (u.pathname.endsWith('/api/library/dj/traktor/export')) {
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
  resetMixesForTests();
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

  it('says how far the analysis has got, with Stop', async () => {
    renderPage();
    await screen.findByText('BPM, key and energy: 2 of 3 tracks done');
    // 153: the 120px bar counts what's done
    const bar = screen.getByRole('progressbar', { name: 'BPM, key and energy worked out' });
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuemax')).toBe('3');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(
        requested.some((r) => r.url.endsWith('/api/library/dj/stop') && r.method === 'POST'),
      ).toBe(true),
    );
  });

  it('opens Mixes well with… from the "…" menu as the docked panel', async () => {
    renderPage();
    await screen.findByText('Static Bloom');
    fireEvent.click(screen.getByRole('button', { name: 'More for Static Bloom' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mixes well with…' }));
    const aside = await screen.findByRole('complementary', {
      name: 'Mixes well with Static Bloom',
    });
    await within(aside).findByText('Low Tide');
    expect(within(aside).getByText('+1 on the wheel · +1.6%')).toBeTruthy();
    expect(within(aside).getByText('Same key · half time')).toBeTruthy();
    expect(within(aside).getByText('Saltmarsh · 124 BPM · A minor')).toBeTruthy();
    expect(within(aside).getByText('2 tracks mix with it')).toBeTruthy();
    fireEvent.click(within(aside).getByRole('button', { name: 'Play Low Tide next' }));
    expect(window.playNext).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '5',
        title: 'Low Tide',
        file_path: '/m/5.flac',
        duration: 276,
      }),
    );
    expect(within(aside).getByRole('button', { name: 'Add Low Tide to a playlist' })).toBeTruthy();
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
  });

  it('puts Mixes well with… second in the "…" menu (154)', async () => {
    renderPage();
    const row = (await screen.findByText('Static Bloom')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'More for Static Bloom' }));
    await screen.findByRole('menuitem', { name: 'Mixes well with…' });
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Play next',
      'Mixes well with…',
      'Add to playlist…',
      'Open artist',
      'Open album',
    ]);
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
});
