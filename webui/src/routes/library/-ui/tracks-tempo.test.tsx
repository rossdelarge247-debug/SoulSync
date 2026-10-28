import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { resetMixesForTests } from '@/features/dj/mixes-store';
import { resetDriveStatus } from '@/features/drives/drive-status';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

/**
 * Library → Tracks' Double BPM / Halve BPM (HANDOFF "Dev, drum and bass BPM
 * (half-time) fix of 27 October"): from a row's "…" and the selection's "…",
 * through the real router, the request to /api/library/dj/bpm, the toast,
 * the rows read again, and the BPM's title saying where it came from.
 */

function dj(bpm: number | null, source: string, extra: Record<string, unknown> = {}) {
  return {
    bpm,
    bpm_source: source,
    key: '8A',
    key_name: 'Am',
    key_long: 'A minor',
    key_source: 'tag',
    key_confidence: null,
    key_uncertain: false,
    energy: 7,
    analyzed: true,
    ...extra,
  };
}

function track(id: string, title: string, info: ReturnType<typeof dj> | null) {
  return {
    id,
    title,
    artist_name: 'Tidewater',
    album_title: 'Night Ferry EP',
    artist_id: '1',
    album_id: '10',
    duration_ms: 300000,
    file_path: `/m/${id}.flac`,
    bitrate: 900,
    image_url: null,
    dj: info,
  };
}

let browse = {
  success: true,
  tracks: [] as ReturnType<typeof track>[],
  total: 0,
  page: 1,
  limit: 50,
  has_more: false,
  sort: 'bpm',
};
let posted: unknown[] = [];
let answer: Record<string, unknown> = {};
let browses = 0;

beforeEach(() => {
  window.SoulSyncWebShellBridge = createShellBridge();
  window.showToast = vi.fn();
  posted = [];
  browses = 0;
  browse = {
    ...browse,
    tracks: [
      track('1', 'Night Ferry', dj(87, 'analysis')),
      track('2', 'Low Tide', dj(174, 'grid', { bpm_tag: 87 })),
      track('3', 'Elsewhere', dj(172, 'override')),
      track('4', 'Not yet', null),
    ],
    total: 4,
  };
  answer = { success: true, changed: { '1': 174 }, skipped: {}, tracks: {} };
  resetDriveStatus();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const u = new URL(url, 'http://x');
      let body: unknown = { success: true };
      if (u.pathname.endsWith('/api/library/dj/browse')) {
        browses += 1;
        body = browse;
      } else if (u.pathname.endsWith('/api/library/dj/status'))
        body = {
          success: true,
          settings: { analyze: true, write_tags: false, overwrite_tags: false },
          counts: { tracks: 4, analyzed: 3, failed: 0, unreachable: 0, pending: 1 },
          job: null,
          held: false,
          can_start: false,
          can_stop: false,
        };
      else if (u.pathname.endsWith('/api/stars/count'))
        body = { success: true, count: 0, missing: 0 };
      else if (u.pathname.endsWith('/api/stars/status')) body = { success: true, tracks: {} };
      else if (u.pathname.endsWith('/api/drives/status'))
        body = { success: true, library_away: false, away: [], folders: {}, can_check: false };
      else if (u.pathname.endsWith('/api/library/dj/bpm')) {
        const raw = input instanceof Request ? await input.text() : (init?.body as string);
        posted.push(JSON.parse(raw));
        body = answer;
      }
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
});

function renderPage() {
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: ['/library?view=tracks'] });
  const router = createAppRouter({ history, queryClient });
  return render(<AppRouterProvider router={router} queryClient={queryClient} />);
}

async function openRowMenu(title: string) {
  const row = (await screen.findByText(title)).closest('li')!;
  fireEvent.click(within(row).getByRole('button', { name: `More for ${title}` }));
  await screen.findByRole('menuitem', { name: 'Add to playlist…' });
  return row;
}

describe('Double BPM / Halve BPM', () => {
  it('a row’s “…” doubles its BPM, says so and reads the rows again', async () => {
    renderPage();
    await openRowMenu('Night Ferry');
    const before = browses;
    fireEvent.click(screen.getByRole('menuitem', { name: 'Double BPM' }));
    await waitFor(() => expect(posted).toEqual([{ track_ids: ['1'], action: 'double' }]));
    await waitFor(() => expect(window.showToast).toHaveBeenCalledWith('Now 174 BPM', 'success'));
    await waitFor(() => expect(browses).toBeGreaterThan(before));
  });

  it('halves too; a BPM set by hand can go back to the measured one', async () => {
    renderPage();
    await openRowMenu('Elsewhere');
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Play next',
      'Mixes well with…',
      'Add to mix set…',
      'Add to playlist…',
      'Double BPMIt would be over 300 BPM',
      'Halve BPM',
      'Use the measured BPM',
      'Open artist',
      'Open album',
    ]);
    expect(screen.getByRole('menuitem', { name: /Double BPM/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    answer = { success: true, changed: { '3': null }, skipped: {}, tracks: {} };
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use the measured BPM' }));
    await waitFor(() => expect(posted).toEqual([{ track_ids: ['3'], action: 'reset' }]));
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith('Back to the measured BPM', 'success'),
    );
  });

  it('a track without a BPM has neither', async () => {
    renderPage();
    await openRowMenu('Not yet');
    expect(screen.queryByRole('menuitem', { name: 'Double BPM' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Halve BPM' })).toBeNull();
  });

  it('the BPM’s title says where it came from, and the tag under a measured one (300)', async () => {
    renderPage();
    const low = (await screen.findByText('Low Tide')).closest('li')!;
    expect(within(low).getByTitle('174 BPM, measured from the beats · Tagged 87')).toBeTruthy();
    const mine = screen.getByText('Elsewhere').closest('li')!;
    expect(within(mine).getByTitle('172 BPM, set by hand')).toBeTruthy();
  });

  it('the selection’s “…” doubles or halves every picked track', async () => {
    renderPage();
    await screen.findByText('Night Ferry');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Night Ferry' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Not yet' }));
    answer = { success: true, changed: { '1': 174 }, skipped: { '4': 'no_bpm' }, tracks: {} };
    const bar = screen.getByRole('toolbar', { name: 'Selected tracks' });
    fireEvent.click(within(bar).getByRole('button', { name: 'More actions for the selection' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Double BPM' }));
    await waitFor(() => expect(posted).toEqual([{ track_ids: ['1', '4'], action: 'double' }]));
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith(
        'Doubled the BPM of 1 track · 1 not changed: no BPM yet',
        'success',
      ),
    );
  });

  it('a member can’t set a shared track’s BPM: both items say why (review L3)', async () => {
    window.SoulSyncWebShellBridge = createShellBridge({
      getCurrentProfileContext: vi.fn(() => ({ profileId: 2, isAdmin: false })),
    });
    browse = {
      ...browse,
      tracks: [
        { ...browse.tracks[0]!, shared: true } as (typeof browse.tracks)[number],
        browse.tracks[1]!,
      ],
    };
    renderPage();
    await openRowMenu('Night Ferry');
    for (const name of ['Double BPM', 'Halve BPM']) {
      const item = screen.getByRole('menuitem', { name: new RegExp(name) });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item.textContent).toBe(`${name}Only an admin can change a shared track’s BPM`);
    }
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    // their own library's track is theirs to set
    await openRowMenu('Low Tide');
    expect(screen.getByRole('menuitem', { name: 'Halve BPM' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('an admin sets a shared track’s BPM', async () => {
    browse = {
      ...browse,
      tracks: [{ ...browse.tracks[0]!, shared: true } as (typeof browse.tracks)[number]],
    };
    renderPage();
    await openRowMenu('Night Ferry');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Double BPM' }));
    await waitFor(() => expect(posted).toEqual([{ track_ids: ['1'], action: 'double' }]));
  });

  it('says the server’s reason when it refuses', async () => {
    answer = { success: false, error: "That track isn't in your library" };
    renderPage();
    await openRowMenu('Night Ferry');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Halve BPM' }));
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith("That track isn't in your library", 'error'),
    );
  });
});
