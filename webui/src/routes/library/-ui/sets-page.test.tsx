import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { resetMixesForTests } from '@/features/dj/mixes-store';
import { resetDraftsForTests } from '@/features/sets/draft-store';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

/**
 * Library → Sets (Sets 1: 22a's planner without the AI, 22c–22e's set,
 * 22f–22i's famous mix and paste, 22r–22s's sources down) through the real
 * router and a stand-in server.
 */

function dj(bpm: number, key: string, energy: number) {
  return {
    bpm,
    bpm_source: 'tag',
    key,
    key_name: 'Am',
    key_long: 'A minor',
    key_source: 'tag',
    key_confidence: null,
    key_uncertain: false,
    energy,
    analyzed: true,
  };
}

function track(id: string, title: string, artist: string, info = dj(120, '7A', 4)) {
  return {
    id,
    title,
    artist_name: artist,
    album_title: `${artist} EP`,
    artist_id: '1',
    album_id: '10',
    duration_ms: 360000,
    file_path: null,
    bitrate: 900,
    image_url: null,
    dj: info,
  };
}

const LIBRARY: Record<string, ReturnType<typeof track>> = {
  '1': track('1', 'Lowtide Hymn', 'Saltmarsh', dj(118, '6A', 3)),
  '2': track('2', 'Foghorn Study', 'Pale Harbour', dj(119, '7A', 3)),
  '3': track('3', 'Undertow', 'Tidewater', dj(120, '7A', 4)),
  '6': track('6', 'Kelp Garden', 'Pale Harbour', dj(120, '7A', 4)),
};

type Row = { track_id: string | null; title: string | null; locked?: boolean };

function view(rows: Row[]) {
  const out = rows.map((r) => ({ ...r, track: r.track_id ? (LIBRARY[r.track_id] ?? null) : null }));
  // like the server: the step from each playing row to the next playing one
  const steps = out.map((r, i) => {
    const next = out.slice(i + 1).find((n) => n.track);
    return r.track && next?.track
      ? {
          kind: 'smooth',
          reason: `${r.track.dj.key} → ${next.track.dj.key}, +1 BPM`,
          steps: 1,
          bpm_diff: 1,
        }
      : null;
  });
  const playing = out.filter((r) => r.track).length;
  return {
    success: true,
    rows: out,
    steps,
    summary: {
      tracks: playing,
      seconds: playing * 360,
      bpm_min: 118,
      bpm_max: 120,
      smooth: steps.filter(Boolean).length,
      jumps: 0,
      unknown: 0,
      locked: rows.filter((r) => r.locked).length,
    },
  };
}

const SAVED_ROWS = [
  { track_id: '1', artist: 'Saltmarsh', title: 'Lowtide Hymn', state: 'owned' },
  { track_id: '2', artist: 'Pale Harbour', title: 'Foghorn Study', state: 'owned' },
  { track_id: null, artist: 'Vela Sund', title: 'Gravity Well', state: 'missing' },
  { track_id: '3', artist: 'Tidewater', title: 'Undertow', state: 'owned' },
];

const MATCH_ROWS = [
  {
    artist: 'Pale Harbour',
    title: 'Foghorn Study',
    at: '00:00',
    mbid: null,
    note: '',
    state: 'owned',
    track: LIBRARY['2'],
    confidence: 1,
    matched_by: 'title',
  },
  {
    artist: 'Mareld',
    title: 'Signal Fire (Dub)',
    at: '09:30',
    mbid: null,
    note: '',
    state: 'version',
    track: LIBRARY['3'],
    confidence: 0.8,
    matched_by: 'title',
    have: 'the original',
    want_version: 'Dub',
  },
  {
    artist: 'Vela Sund',
    title: 'Gravity Well',
    at: '18:40',
    mbid: null,
    note: '',
    state: 'missing',
    track: null,
    confidence: 0,
    matched_by: null,
  },
  {
    artist: 'ID',
    title: 'ID',
    at: '23:15',
    mbid: null,
    note: '',
    state: 'id',
    track: null,
    confidence: 0,
    matched_by: null,
  },
];

let sent: { path: string; method: string; body: unknown }[] = [];
let mixesdbDown = false;

beforeEach(() => {
  window.SoulSyncWebShellBridge = createShellBridge();
  window.showLibraryDownloadsSection = vi.fn();
  window.showToast = vi.fn();
  window.localStorage.clear();
  resetDraftsForTests();
  sent = [];
  mixesdbDown = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (input instanceof Request ? input.method : init?.method) || 'GET';
      const raw = input instanceof Request ? await input.text() : ((init?.body as string) ?? '');
      const body: unknown = raw ? JSON.parse(raw) : null;
      const u = new URL(url, 'http://x');
      const path = u.pathname.replace(/^.*\/api\//, '/api/');
      sent.push({ path, method, body });
      let answer: unknown = { success: true };
      let status = 200;
      if (path === '/api/sets' && method === 'GET')
        answer = {
          success: true,
          sets: [
            {
              id: 7,
              name: 'Sunday Set',
              kind: 'hand',
              status: 'saved',
              tracks: 3,
              lines: 4,
              owned: 3,
              seconds: 7440,
              energy: [3, 3, 4],
              updated_at: Date.now() / 1000,
            },
          ],
        };
      else if (path === '/api/sets' && method === 'POST')
        answer = { success: true, id: 9, playlist_id: 4 };
      else if (path === '/api/sets/7' && method === 'GET')
        answer = {
          ...view(SAVED_ROWS),
          set: {
            id: 7,
            name: 'Sunday Set',
            kind: 'hand',
            status: 'saved',
            source: null,
            source_meta: {},
            playlist_id: 4,
          },
          rows: view(SAVED_ROWS).rows,
        };
      else if (path === '/api/sets/view') answer = view((body as { tracks: Row[] }).tracks);
      else if (path === '/api/sets/swap')
        answer = {
          success: true,
          alternatives: [
            {
              track: LIBRARY['6'],
              jumps: 0,
              into: { kind: 'smooth', reason: '7A → 7A, +1 BPM · same key' },
              out_of: { kind: 'smooth', reason: '7A → 7A, same BPM · same key' },
            },
          ],
          total: 1,
          before: LIBRARY['1'],
          after: LIBRARY['3'],
        };
      else if (path === '/api/sets/famous/search')
        answer = {
          success: true,
          query: u.searchParams.get('q'),
          results: [
            {
              source: 'musicbrainz',
              id: 'mb1',
              title: 'fabric 104: Saltmarsh',
              date: '2020-01-01',
              tracks: 24,
              kind: 'cd',
            },
          ],
          saved: [],
          sources: {
            mixesdb: { state: mixesdbDown ? 'down' : 'ok' },
            musicbrainz: { state: 'ok' },
            discogs: { state: 'off', why: 'token' },
          },
        };
      else if (path === '/api/sets/famous/open')
        answer = {
          success: true,
          mix: {
            source: 'musicbrainz',
            id: 'mb1',
            title: 'fabric 104: Saltmarsh',
            date: '2020-01-01',
            kind: 'cd',
            url: 'https://musicbrainz.org/release/mb1',
          },
          rows: MATCH_ROWS,
          counts: { owned: 1, version: 1, missing: 1, ids: 1, of: 3 },
        };
      else if (path === '/api/sets/paste')
        answer = {
          success: true,
          rows: [MATCH_ROWS[0], MATCH_ROWS[2]],
          unread: [{ n: 2, raw: '02. the vocals lol', at: '', why: 'A comment, not a track' }],
          counts: { owned: 1, version: 0, missing: 1, ids: 0, of: 2 },
          lines: 3,
          cut: false,
        };
      else if (path === '/api/sets/wanted')
        answer = { success: true, added: 1, already: 0, refused: [] };
      else if (path.startsWith('/api/drives/status'))
        answer = { success: true, library_away: false, away: [], folders: {} };
      return new Response(JSON.stringify(answer), {
        status,
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
});

function renderPage(entry = '/library?view=sets') {
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: [entry] });
  const router = createAppRouter({ history, queryClient });
  return { router, ...render(<AppRouterProvider router={router} queryClient={queryClient} />) };
}

const calls = (path: string, method?: string) =>
  sent.filter((s) => s.path === path && (!method || s.method === method));

describe('Library → Sets', () => {
  it('shows the planner: Suggest a set waits with its reason, Famous mix, Your sets', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Sets' })).toBeTruthy();
    const suggest = screen.getByRole('tab', { name: 'Suggest a set' });
    expect(suggest.getAttribute('aria-disabled')).toBe('true');
    expect(
      document.getElementById(suggest.getAttribute('aria-describedby')!)!.textContent,
    ).toContain('Famous mixes and sets built by hand work now');
    const row = (await screen.findByText('Sunday Set')).closest('button')!;
    expect(within(row).getByText('3 tracks · 2 h 4 min')).toBeTruthy();
    expect(within(row).getByText('By hand')).toBeTruthy();
    expect(row.querySelector('[data-sparkline] path')).toBeTruthy();
  });

  it('starts a new empty set as a draft kept in this browser', async () => {
    const { router } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New empty set' }));
    await screen.findByText('Draft · not saved');
    expect(router.state.location.search).toMatchObject({ view: 'sets', set: 'draft' });
    expect(screen.getByText('An empty set')).toBeTruthy();
    expect(window.localStorage.getItem('soulsync.sets.draft.2')).toContain('"rows":[]');
    const save = screen.getByRole('button', { name: 'Save as mix' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
  });

  it('opens a saved set with its steps; Lock and Swap save it', async () => {
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    await waitFor(() =>
      expect(document.querySelector('[data-set-editor] p')!.textContent).toBe(
        '3 tracks · 18 min · 118–120 BPM · 2 smooth steps',
      ),
    );
    const steps = document.querySelectorAll('[data-step="smooth"]');
    expect(steps).toHaveLength(2);
    // the missing line is stepped over: Foghorn Study's step goes to Undertow
    expect(steps[1].textContent).toContain('7A → 7A, +1 BPM');
    const missing = document.querySelector('[data-set-row="2"]')!;
    expect(missing.textContent).toContain('Not in your library');
    fireEvent.click(screen.getByRole('button', { name: 'Lock Lowtide Hymn' }));
    await waitFor(() => expect(calls('/api/sets/7', 'PUT').length).toBe(1), { timeout: 2000 });
    const put = calls('/api/sets/7', 'PUT')[0].body as { tracks: { locked: boolean }[] };
    expect(put.tracks[0].locked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Swap Foghorn Study' }));
    const panel = await screen.findByRole('complementary', { name: 'Swap track 2' });
    await within(panel).findByText('Kelp Garden');
    expect(within(panel).getByText(/Between Lowtide Hymn \(6A, 118\) and Undertow/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Use Kelp Garden' }));
    await waitFor(
      () => {
        const last = calls('/api/sets/7', 'PUT').at(-1)!.body as { tracks: { track_id: string }[] };
        expect(last.tracks[1].track_id).toBe('6');
      },
      { timeout: 2000 },
    );
  });

  it('searches famous mixes, says a source is down, and matches a mix', async () => {
    mixesdbDown = true;
    renderPage('/library?view=sets&set=famous&q=saltmarsh');
    expect(await screen.findByText("MixesDB can't be reached")).toBeTruthy();
    expect(screen.getByText(/radio and club mixes are missing below/)).toBeTruthy();
    expect(screen.getByText(/Discogs isn.t searched: it needs a free token/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /fabric 104: Saltmarsh/ }));
    expect(await screen.findByText('You own 1 of 3')).toBeTruthy();
    expect(screen.getByText('1 more in another version · 1 missing')).toBeTruthy();
    expect(screen.getByText('You have the Original Mix')).toBeTruthy();
    expect(screen.getByText('Not identified in the tracklist')).toBeTruthy();
    expect(screen.getByText(/^Tracklist from MusicBrainz/)).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Want the Dub' }));
    await waitFor(() => expect(calls('/api/sets/wanted').length).toBe(1));
    expect(calls('/api/sets/wanted')[0].body).toMatchObject({
      tracks: [{ artist: 'Mareld', title: 'Signal Fire (Dub)' }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add 1 missing to Wanted' }));
    await waitFor(() => expect(calls('/api/sets/wanted').length).toBe(2));
    expect(calls('/api/sets/wanted')[1].body).toMatchObject({
      tracks: [{ artist: 'Vela Sund', title: 'Gravity Well' }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save as mix' }));
    await waitFor(() => expect(calls('/api/sets', 'POST').length).toBe(1));
    const saved = calls('/api/sets', 'POST')[0].body as {
      kind: string;
      source: string;
      tracks: { state: string; want: string }[];
    };
    expect(saved.kind).toBe('famous');
    expect(saved.source).toBe('musicbrainz');
    expect(saved.tracks.map((t) => t.state)).toEqual(['owned', 'version', 'missing', 'id']);
    expect(saved.tracks[1].want).toBe('wanted');
  });

  it('reads a pasted tracklist: unreadable lines first with why, Leave out', async () => {
    renderPage('/library?view=sets&set=paste');
    fireEvent.change(await screen.findByLabelText('The tracklist, as you copied it'), {
      target: {
        value: '01. Pale Harbour - Foghorn Study\n02. the vocals lol\n03. Vela Sund - Gravity Well',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Read the tracklist' }));
    expect(await screen.findByText("1 line couldn't be read as a track.")).toBeTruthy();
    const line = screen.getByText('02. the vocals lol').closest('li')!;
    expect(within(line).getByText('A comment, not a track')).toBeTruthy();
    expect(screen.getByText('Lines you leave out aren’t in the mix or the export.')).toBeTruthy();
    fireEvent.click(within(line).getByRole('button', { name: 'Leave out' }));
    await waitFor(() => expect(screen.queryByText('02. the vocals lol')).toBeNull());
    expect(screen.getByText('You own 1 of 2')).toBeTruthy();
  });
});
