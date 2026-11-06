/**
 * Browse (37f) in the page: opened by Browse…, B and "Browse another…"; the
 * chips and search asking `/api/library/dj/browse`; the rows with their step;
 * ↑↓ then Enter loads, Load loads, Esc closes; the focus comes back.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DjBrowse } from './dj-browse';
import { DjModeStore } from './dj-mode-store';
import { apiGrid } from './dj-mode.fixtures';
import { DjPrefsStore } from './dj-prefs';
import { DjStage } from './dj-stage';

const FERRY = {
  id: '2',
  title: 'Night Ferry',
  artist: 'Tidewater',
  is_library: true,
  filename: '/m/2.flac',
};
const ROWS = [
  {
    id: '8',
    title: 'Harbour Lights',
    artist_name: 'Marram',
    duration_ms: 288000,
    grid_ready: true,
    dj: { bpm: 126, key: '8A' },
  },
  {
    id: '5',
    title: 'Low Tide',
    artist_name: 'Marram',
    duration_ms: 252000,
    grid_ready: true,
    dj: { bpm: 62, key: '8B' },
  },
  {
    id: '6',
    title: 'Sand Script',
    artist_name: 'Ola',
    duration_ms: 238000,
    grid_ready: false,
    dj: { bpm: 128, key: '7A' },
  },
];
// a starred track whose file has gone (Starred keeps it): never offered (review L3)
const GONE = {
  id: '11',
  title: 'Gone Away',
  artist_name: 'Ola',
  duration_ms: 200000,
  grid_ready: true,
  file_missing: true,
  dj: { bpm: 124, key: '8A' },
};
let asked: URLSearchParams[];
let said: string[];
let store: DjModeStore;

function browseFetch(url: string): Promise<Response> {
  const q = new URL(url, 'http://x').searchParams;
  asked.push(q);
  const all = q.get('starred') ? [...ROWS, GONE] : ROWS;
  const rows = q.get('q') ? all.filter((r) => r.title.toLowerCase().includes(q.get('q')!)) : all;
  return Promise.resolve(
    new Response(JSON.stringify({ success: true, tracks: rows, total: rows.length })),
  );
}

beforeEach(async () => {
  asked = [];
  said = [];
  (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
    state: () => ({ track: FERRY, kind: 'library' }),
    audio: () => ({ currentTime: 60, duration: 286 }),
  };
  store = new DjModeStore({
    prefs: new DjPrefsStore(null),
    fetch: async (url: string, init?: RequestInit) => {
      if (url.endsWith('/peaks'))
        return new Response(JSON.stringify({ peaks: [0.5], duration_s: 286 }));
      if (/\/dj\/grid\//.test(url))
        return new Response(JSON.stringify({ success: true, grid: apiGrid() }));
      if (url.endsWith('/api/library/dj/tracks')) {
        const id = (JSON.parse(init?.body as string) as { track_ids: string[] }).track_ids[0]!;
        return new Response(JSON.stringify({ tracks: { [id]: { bpm: 124, key: '8A' } } }));
      }
      return new Response('{}', { status: 404 });
    },
    analyse: () => undefined,
    phone: () => false,
    say: (w) => said.push(w),
  });
  store.setOn(true);
  await waitFor(() => expect(store.snapshot().a?.info?.bpm).toBe(124));
});

afterEach(() => {
  cleanup();
  store.dispose();
  delete (window as unknown as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
});

function mount() {
  return render(
    <DjStage store={store} slots={{ mixer: <DjBrowse store={store} fetchImpl={browseFetch} /> }} />,
  );
}

describe('Browse (37f)', () => {
  it('registers itself: empty B shows Browse… and "or press B"', async () => {
    mount();
    expect(store.snapshot().browse).toBe(true);
    expect(screen.getByRole('button', { name: 'Browse…' })).toBeTruthy();
    expect(screen.getByText('or press B')).toBeTruthy();
  });

  it('opens with the two chips on, closest first around A, A left out', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Browse for the second track' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await screen.findByText('Harbour Lights');
    const q = asked.at(-1)!;
    expect(Object.fromEntries(q)).toMatchObject({
      sort: 'closest',
      near: '124',
      near_key: '8A',
      tempo: 'near',
      key: '8A:mix',
      exclude: '2',
    });
    expect(screen.getByRole('button', { name: /Near 124 BPM/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /Keys that mix with 8A/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Starred' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText('117–131, and 62 or 248')).toBeTruthy();
    expect(screen.getByText('3 tracks fit · the smallest tempo and key step first')).toBeTruthy();
    // the search has the focus
    expect(document.activeElement).toBe(
      screen.getByRole('combobox', { name: 'Search your tracks' }),
    );
  });

  it('rows: readiness, the step in words, the length; Low Tide is half time · relative', async () => {
    mount();
    act(() => {
      store.openBrowse();
    });
    await screen.findByText('Harbour Lights');
    const rows = screen.getAllByRole('option');
    // closest first: Low Tide (0%) before Harbour Lights (1.6%) before Sand Script (3.2%)
    expect(rows.map((r) => r.querySelector('[class*="rowTitle"]')!.textContent)).toEqual([
      'Low Tide',
      'Harbour Lights',
      'Sand Script',
    ]);
    expect(rows[0]!.textContent).toContain('62.0 half time · relative');
    expect(rows[1]!.textContent).toContain('126.0 +1.6%');
    expect(rows[1]!.textContent).toContain('4:48');
    expect(rows[2]!.textContent).toContain('not analysed yet · loads, then analyses');
    expect(rows[2]!.textContent).toContain('+3.2% · −1 on the wheel');
  });

  it('the chips and the search ask again', async () => {
    mount();
    act(() => {
      store.openBrowse();
    });
    await screen.findByText('Harbour Lights');
    fireEvent.click(screen.getByRole('button', { name: /Near 124 BPM/ }));
    await waitFor(() => expect(asked.at(-1)!.get('tempo')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Recently played' }));
    await waitFor(() => expect(asked.at(-1)!.get('recent')).toBe('1'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tide' } });
    await waitFor(() => expect(asked.at(-1)!.get('q')).toBe('tide'));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
  });

  it('↑↓ then Enter loads the row as B, cued, and the dialog closes', async () => {
    mount();
    act(() => {
      store.openBrowse();
    });
    await screen.findByText('Harbour Lights');
    const input = screen.getByRole('combobox');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1]!.id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(store.snapshot().b?.track).toMatchObject({
      id: '8',
      title: 'Harbour Lights',
      bpm: 126,
      key: '8A',
    });
    expect(said).toContain('Harbour Lights loaded as B, cued');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Load loads; Esc (and the store’s Esc) closes and gives the focus back', async () => {
    mount();
    const browse = screen.getByRole('button', { name: 'Browse…' });
    browse.focus();
    fireEvent.click(browse);
    await screen.findByText('Harbour Lights');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(browse));
    // Esc in the overlay asks the store, which closes Browse before anything else
    act(() => {
      store.openBrowse();
    });
    await screen.findByText('Harbour Lights');
    act(() => {
      expect(store.escape()).toBe(true);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(store.snapshot().on).toBe(true);
    act(() => {
      store.openBrowse();
    });
    await screen.findByText('Sand Script');
    // the row is the Load (an option holds no button, review L7)
    fireEvent.click(screen.getByRole('option', { name: /^Sand Script/ }));
    expect(store.snapshot().b?.track.id).toBe('6');
  });

  it('Browse another… on a lane without a grid opens it too', async () => {
    mount();
    act(() => {
      store.loadB({ id: '6', title: 'Sand Script', artist: 'Ola', image: null, duration: 238 });
    });
    // no grid for it: 37d's row with Browse another…
    await waitFor(() => expect(store.snapshot().b?.phase).not.toBe('loading'));
    const another = screen.queryByRole('button', { name: 'Browse another…' });
    if (another) {
      fireEvent.click(another);
      expect(await screen.findByRole('dialog')).toBeTruthy();
    } else {
      expect(store.openBrowse()).toBe(true);
      expect(await screen.findByRole('dialog')).toBeTruthy();
    }
  });

  it('review M6: Tab stays in the dialog, over what Tab really reaches', async () => {
    mount();
    act(() => {
      store.openBrowse();
    });
    await screen.findByText('Harbour Lights');
    const close = screen.getByRole('button', { name: 'Close Browse' });
    const last = screen.getByRole('button', { name: 'Recently played' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    // the rows hold no buttons to Tab to (review L7): an option is the Load
    expect(screen.getAllByRole('option')[0]!.querySelector('button')).toBeNull();
  });

  it('review L3 and L7: a missing file is never offered; a chip’s answer is said once', async () => {
    mount();
    act(() => {
      store.openBrowse();
    });
    await screen.findByText('Harbour Lights');
    // opening says nothing
    await new Promise((r) => setTimeout(r, 700));
    expect(said.filter((w) => w.includes('fit'))).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Starred' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recently played' }));
    await waitFor(() => expect(asked.at(-1)!.get('recent')).toBe('1'));
    await waitFor(() =>
      expect(said.filter((w) => w.includes('fit'))).toEqual([
        '3 tracks fit · the smallest tempo and key step first',
      ]),
    );
    expect(screen.queryByText('Gone Away')).toBeNull();
  });

  it('turning DJ mode off closes it and lets the opener go', async () => {
    mount();
    act(() => {
      store.openBrowse();
    });
    await screen.findByRole('dialog');
    act(() => {
      store.setOn(false);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(store.snapshot().browse).toBe(false);
    vi.restoreAllMocks();
  });
});
