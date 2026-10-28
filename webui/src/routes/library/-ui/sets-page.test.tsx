import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { refreshPrefs } from '@/features/automix/prefs';
import { analysisStore, resetAnalysisRequests } from '@/features/dj/analysis.api';
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

/** 28e: ids whose file has gone (File missing), and ids not analysed yet */
let GONE = new Set<string>();
let WORKING = new Set<string>();
/** analyse on demand: the progress route's tracks */
let PROGRESS: Record<string, unknown> = {};

function view(rows: Row[]) {
  const out = rows.map((r) => {
    const known = r.track_id ? (LIBRARY[r.track_id] ?? null) : null;
    if (r.track_id && GONE.has(r.track_id))
      return { ...r, track: null, unreachable: true, gone_track: known };
    if (known && r.track_id && WORKING.has(r.track_id))
      return {
        ...r,
        track: {
          ...known,
          dj: { ...known.dj, bpm: null, key: null, energy: null, analyzed: false },
        },
      };
    return { ...r, track: known };
  });
  // like the server: the step from each playing row to the next playing one
  const steps = out.map((r, i) => {
    const next = out.slice(i + 1).find((n) => n.track);
    if (!r.track || !next?.track) return null;
    return !r.track.dj.key || !next.track.dj.key
      ? { kind: 'unknown', reason: 'BPM and key not worked out yet', steps: null, bpm_diff: null }
      : {
          kind: 'smooth',
          reason: `${r.track.dj.key} → ${next.track.dj.key}, +1 BPM`,
          steps: 1,
          bpm_diff: 1,
        };
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
      smooth: steps.filter((x) => x?.kind === 'smooth').length,
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
let mixesdbBusy = false;
let playlistState: string | null = null;
/** the set's revision on the stand-in server (compare and set, like the real one) */
let serverRevision = 3;
/** hold the next PUT until released (two quick edits from one window) */
let holdNextPut: { release?: () => void } | null = null;

beforeEach(() => {
  window.SoulSyncWebShellBridge = createShellBridge();
  window.showLibraryDownloadsSection = vi.fn();
  window.showToast = vi.fn();
  window.localStorage.clear();
  resetDraftsForTests();
  sent = [];
  mixesdbDown = false;
  mixesdbBusy = false;
  playlistState = null;
  serverRevision = 3;
  holdNextPut = null;
  GONE = new Set();
  WORKING = new Set();
  PROGRESS = {};
  resetAnalysisRequests();
  analysisStore.reset();
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
            playlist_id: playlistState ? null : 4,
            playlist_state: playlistState,
            revision: serverRevision,
          },
          rows: view(SAVED_ROWS).rows,
        };
      else if (path === '/api/sets/7' && method === 'PUT') {
        const held = holdNextPut;
        if (held && !held.release) {
          await new Promise<void>((resolve) => {
            held.release = resolve;
          });
        }
        const base = (body as { base_revision?: number }).base_revision;
        if (base !== serverRevision) {
          status = 409;
          answer = {
            success: false,
            stale: true,
            revision: serverRevision,
            error: 'A newer change to this set is already saved.',
          };
        } else {
          serverRevision += 1;
          answer = { success: true, id: 7, revision: serverRevision, playlist_state: null };
        }
      } else if (path === '/api/sets/7/playlist') answer = { success: true, playlist_id: 12 };
      else if (path === '/api/sets/wanted/remove') answer = { success: true, removed: true };
      else if (path === '/api/sets/view') answer = view((body as { tracks: Row[] }).tracks);
      else if (path === '/api/library/dj/progress')
        answer = { success: true, tracks: PROGRESS, sweep: { running: false } };
      else if (path === '/api/library/dj/analyse')
        answer = {
          success: true,
          asked: 3,
          queued: 1,
          already_queued: 0,
          already_done: 2,
          cant: 0,
          over_limit: 0,
          limit: 200,
          yours: 1,
          started: true,
        };
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
            mixesdb: mixesdbBusy
              ? { state: 'limited', why: 'busy' }
              : { state: mixesdbDown ? 'down' : 'ok' },
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
      else if (path === '/api/library/dj/plan') {
        // stage A's planner, enough for 26a's picker: Auto picks a long blend
        const style = u.searchParams.get('style') || 'auto';
        const chosen = style === 'auto' ? 'long_blend' : style;
        const bars = Number(u.searchParams.get('bars')) || (chosen === 'long_blend' ? 32 : 16);
        answer = {
          success: true,
          plan: {
            status: 'ok',
            style: chosen,
            bars: chosen === 'cut' ? null : bars,
            requested: style,
            chosen_by: style === 'auto' ? 'auto' : 'you',
            why: style === 'auto' ? '6A → 7A, +1 BPM: the keys mix and the tempo is close' : null,
            pair: '6A → 7A, +1 BPM',
            key: { from: '6A', to: '7A', relation: 'up' },
            tempo: {
              relation: 'same',
              rate: 0.99,
              speed_change_ok: true,
              from_bpm: 118,
              to_bpm: 119,
            },
            out: { start: 300, bar: 140 },
            in: { start: 0.2, bar: 0 },
            styles: [
              { style: 'long_blend', label: 'Long blend', available: true, why: null },
              {
                style: 'drop_swap',
                label: 'Drop swap',
                available: false,
                why: 'no drop found in Foghorn Study',
              },
            ],
          },
        };
      } else if (path.startsWith('/api/drives/status'))
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
    // 28g: the empty set names itself and offers the ways to fill it
    expect(screen.getByRole('heading', { name: /^Nothing in .+ yet$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Suggest a set…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Start from a famous mix…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add the playing track' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(window.localStorage.getItem('soulsync.sets.draft.2')).toContain('"rows":[]');
    const save = screen.getByRole('button', { name: 'Save as mix set' });
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

  it('says when a source is busy with other searches', async () => {
    mixesdbBusy = true;
    renderPage('/library?view=sets&set=famous&q=saltmarsh');
    expect(
      await screen.findByText(
        'MixesDB is busy with other searches just now. Try again in a moment.',
      ),
    ).toBeTruthy();
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

    fireEvent.click(screen.getByRole('button', { name: 'Save as mix set' }));
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

  it('saves a rename as the name alone, from the revision it read', async () => {
    renderPage('/library?view=sets&set=7');
    const name = await screen.findByDisplayValue('Sunday Set');
    fireEvent.change(name, { target: { value: 'Sunday Session' } });
    await waitFor(() => expect(calls('/api/sets/7', 'PUT').length).toBe(1), { timeout: 2000 });
    expect(calls('/api/sets/7', 'PUT')[0].body).toEqual({
      name: 'Sunday Session',
      base_revision: 3,
    });
    await screen.findByText('Saved');
  });

  it('[gauntlet H1] a set changed somewhere else stops the saves, keeps the edits and says so', async () => {
    renderPage('/library?view=sets&set=7');
    const name = await screen.findByDisplayValue('Sunday Set');
    // another tab adds a track: the server is at 4, the page read 3. The
    // refusal's revision (4) is the one this page's save would have made:
    // it's still someone else's change, never taken for this window's own
    serverRevision = 4;
    fireEvent.change(name, { target: { value: 'Later' } });
    const notice = await screen.findByRole('alert', {}, { timeout: 2000 });
    expect(notice).toHaveAttribute('data-set-conflict');
    expect(within(notice).getByText('This set changed somewhere else')).toBeTruthy();
    expect(notice.textContent).toContain('Not saved here: the name “Later”.');
    expect(calls('/api/sets/7', 'PUT')).toHaveLength(1);
    expect(calls('/api/sets/7', 'PUT')[0].body).toEqual({ name: 'Later', base_revision: 3 });
    // later edits stay here and are never sent over the top
    fireEvent.change(name, { target: { value: 'Later still' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lock Lowtide Hymn' }));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(calls('/api/sets/7', 'PUT')).toHaveLength(1);
    expect(screen.getByDisplayValue('Later still')).toBeTruthy();
    // kept as a draft in this browser, so nothing is lost
    fireEvent.click(within(notice).getByRole('button', { name: 'Keep mine as a draft' }));
    const draft = JSON.parse(window.localStorage.getItem('soulsync.sets.draft.2')!) as {
      name: string;
      rows: { locked?: boolean }[];
    };
    expect(draft.name).toBe('Later still (my version)');
    expect(draft.rows[0].locked).toBe(true);
    // Reload it: the newest set, and saving again from its revision
    fireEvent.click(within(notice).getByRole('button', { name: 'Reload it' }));
    await waitFor(() => expect(screen.getByDisplayValue('Sunday Set')).toBeTruthy());
    expect(screen.queryByText('This set changed somewhere else')).toBeNull();
    fireEvent.change(screen.getByDisplayValue('Sunday Set'), { target: { value: 'Fresh' } });
    await waitFor(() => expect(calls('/api/sets/7', 'PUT').length).toBe(2), { timeout: 2000 });
    expect(calls('/api/sets/7', 'PUT')[1].body).toEqual({ name: 'Fresh', base_revision: 4 });
  });

  it('[gauntlet H1] two quick edits from one window both land, one save at a time', async () => {
    holdNextPut = {};
    renderPage('/library?view=sets&set=7');
    const name = await screen.findByDisplayValue('Sunday Set');
    fireEvent.change(name, { target: { value: 'Sunday Session' } });
    await waitFor(() => expect(calls('/api/sets/7', 'PUT').length).toBe(1), { timeout: 2000 });
    // the second edit while the first is still on its way: it waits for it
    fireEvent.click(screen.getByRole('button', { name: 'Lock Lowtide Hymn' }));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(calls('/api/sets/7', 'PUT')).toHaveLength(1);
    holdNextPut.release!();
    await waitFor(() => expect(calls('/api/sets/7', 'PUT').length).toBe(2), { timeout: 2000 });
    const second = calls('/api/sets/7', 'PUT')[1].body as {
      base_revision: number;
      tracks: { locked: boolean }[];
      name?: string;
    };
    expect(second.base_revision).toBe(4);
    expect(second.name).toBeUndefined();
    expect(second.tracks[0].locked).toBe(true);
    await screen.findByText('Saved');
    expect(serverRevision).toBe(5);
    expect(screen.queryByText('This set changed somewhere else')).toBeNull();
  });

  it('says once that the playlist went its own way, and makes a new one', async () => {
    playlistState = 'changed';
    renderPage('/library?view=sets&set=7');
    expect(
      await screen.findByText(
        'Its playlist was changed elsewhere, so it no longer follows this set',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make a new playlist from this set' }));
    await waitFor(() => expect(calls('/api/sets/7/playlist').length).toBe(1));
    expect(calls('/api/sets/7/playlist')[0].body).toEqual({ action: 'new' });
    await waitFor(() => expect(screen.queryByText(/no longer follows this set/)).toBeNull());
  });

  it('holds a locked row in its place', async () => {
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    await waitFor(() => expect(document.querySelectorAll('[data-step]').length).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Lock Lowtide Hymn' }));
    const first = document.querySelector('[data-set-row="0"]')!;
    expect(first.getAttribute('data-locked')).toBe('true');
    expect(first.getAttribute('draggable')).not.toBe('true');
    // the grip won't arm a locked row for dragging
    fireEvent.pointerDown(first.querySelector('[title="Locked in its place"]')!);
    expect(first.getAttribute('draggable')).not.toBe('true');
    await waitFor(() => expect(calls('/api/sets/7', 'PUT').length).toBe(1), { timeout: 2000 });
    const locked = calls('/api/sets/7', 'PUT')[0].body as {
      tracks: { track_id: string | null; locked: boolean }[];
    };
    expect(locked.tracks.map((t) => t.track_id)).toEqual(['1', '2', null, '3']);
    expect(locked.tracks[0].locked).toBe(true);
  });

  it('takes a Want the Dub back off Wanted on Use yours', async () => {
    renderPage('/library?view=sets&set=famous&q=saltmarsh');
    fireEvent.click(await screen.findByRole('button', { name: /fabric 104: Saltmarsh/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Want the Dub' }));
    await waitFor(() => expect(calls('/api/sets/wanted').length).toBe(1));
    fireEvent.click(screen.getByRole('radio', { name: 'Use yours' }));
    await waitFor(() => expect(calls('/api/sets/wanted/remove').length).toBe(1));
    expect(calls('/api/sets/wanted/remove')[0].body).toEqual({
      artist: 'Mareld',
      title: 'Signal Fire (Dub)',
      set_name: 'fabric 104: Saltmarsh',
    });
  });
});

describe('a mix set’s page beyond 22c (28e, 28g)', () => {
  it('a note per track, typed in place, saves with the set', async () => {
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    fireEvent.click(await screen.findByRole('button', { name: 'Add a note to Lowtide Hymn' }));
    const input = screen.getByRole('textbox', { name: 'A note for Lowtide Hymn' });
    fireEvent.change(input, { target: { value: '  mix out at   the breakdown ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(calls('/api/sets/7', 'PUT').length).toBe(1), { timeout: 2000 });
    const put = calls('/api/sets/7', 'PUT')[0].body as { tracks: { note: string | null }[] };
    expect(put.tracks[0].note).toBe('mix out at the breakdown');
    expect(
      screen.getByRole('button', {
        name: 'Note for Lowtide Hymn: mix out at the breakdown. Change it',
      }),
    ).toBeTruthy();
  });

  it('each known step ends with its chip; picking a style and length saves {style, bars}', async () => {
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    // the chip names Auto's pick once the pair is planned (26i)
    const chip = await screen.findByRole('button', {
      name: 'Transition from Lowtide Hymn to Foghorn Study: Long blend · 32 bars, auto. Change it',
    });
    expect(chip.closest('[data-step]')!.getAttribute('data-step')).toBe('smooth');
    fireEvent.click(chip);
    const picker = screen.getByRole('dialog', { name: 'How Lowtide Hymn goes into Foghorn Study' });
    const radios = within(picker).getAllByRole('radio').slice(0, 8);
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Auto: Long blend',
      'Long blend',
      'Short blend',
      'Bass swap',
      'Cut',
      'Echo out',
      'Filter sweep',
      'Drop swap',
    ]);
    // the pair and why, Auto naming its pick, a style the pair can't do listed with why (26a)
    expect(picker).toHaveTextContent('6A → 7A, +1 BPM: the keys mix and the tempo is close');
    expect(radios[0]).toHaveAccessibleDescription(
      'Chosen because the keys mix and the tempo is close',
    );
    expect(radios[1]).toHaveAccessibleDescription('32 bars, the EQ handed over slowly');
    expect(radios[7]).toHaveAttribute('aria-disabled', 'true');
    expect(radios[7]).toHaveAccessibleDescription('Needs a drop: none found in Foghorn Study');
    fireEvent.click(within(picker).getByRole('radio', { name: 'Bass swap' }));
    fireEvent.click(within(picker).getByRole('radio', { name: '32 bars' }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Done' }));
    expect(
      screen.getByRole('button', {
        name: 'Transition from Lowtide Hymn to Foghorn Study: Bass swap · 32 bars, your choice. Change it',
      }),
    ).toBeTruthy();
    await waitFor(() => expect(calls('/api/sets/7', 'PUT').length).toBe(1), { timeout: 2000 });
    const put = calls('/api/sets/7', 'PUT')[0].body as { tracks: { transition: unknown }[] };
    expect(put.tracks[0].transition).toEqual({ style: 'bass_swap', bars: 32 });
  });

  it('with DJ mix off a set keeps its chips, dimmed, saying what plays instead (26g, 26i)', async () => {
    localStorage.setItem('soulsync-between-tracks', 'off');
    refreshPrefs();
    try {
      renderPage('/library?view=sets&set=7');
      await screen.findByDisplayValue('Sunday Set');
      const chip = await screen.findByRole('button', {
        name: 'Transition from Lowtide Hymn to Foghorn Study: Long blend · 32 bars, auto. Change it',
      });
      const wrap = chip.parentElement!;
      expect(wrap).toHaveAttribute('data-dimmed');
      expect(wrap).toHaveTextContent(
        'Auto mix is off: plays straight on (Play as a mix plays this)',
      );
      localStorage.setItem('soulsync-between-tracks', 'dj');
      act(() => refreshPrefs());
      await waitFor(() => expect(wrap).not.toHaveAttribute('data-dimmed'));
      expect(wrap).toHaveTextContent('auto · 6A → 7A, +1 BPM');
      // 28e: a saved set plays with its chips
      expect(screen.getByRole('button', { name: 'Play as a mix' })).toBeTruthy();
    } finally {
      localStorage.removeItem('soulsync-between-tracks');
      refreshPrefs();
    }
  });

  it('a file gone missing keeps its place, number and values, at 62% with its tag (28e)', async () => {
    GONE = new Set(['2']);
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    await waitFor(() =>
      expect(document.querySelector('[data-set-editor] p')!.textContent).toContain(
        '1 file missing',
      ),
    );
    const row = document.querySelector('[data-set-row="1"]')!;
    expect(row.getAttribute('data-state')).toBe('gone');
    expect(within(row as HTMLElement).getByText('File missing')).toBeTruthy();
    expect(within(row as HTMLElement).getByText('2')).toBeTruthy(); // its number
    expect(within(row as HTMLElement).getByText('119')).toBeTruthy(); // its BPM
    expect(row.textContent).toContain('Skipped when played');
    fireEvent.click(
      within(row as HTMLElement).getByRole('button', { name: 'More for Foghorn Study' }),
    );
    const items = (await screen.findAllByRole('menuitem')).map((m) => m.textContent);
    expect(items.slice(0, 2)).toEqual(['Find it again', 'Add to Wanted']);
  });

  it('a track still being analysed says so, with dashes and no chip (28e)', async () => {
    WORKING = new Set(['2']);
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    const row = (await screen.findByText('Being worked out')).closest('li')!;
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(3);
    await waitFor(() =>
      expect(document.querySelectorAll('[data-step="unknown"]').length).toBeGreaterThan(0),
    );
    for (const step of document.querySelectorAll('[data-step="unknown"]'))
      expect(step.querySelector('button')).toBeNull();
  });

  it('analyse on demand: opening a set asks for its tracks, and a row being worked out shows its step', async () => {
    WORKING = new Set(['2']);
    PROGRESS = {
      '1': { state: 'done', ready: true, bpm_key: true },
      '2': { state: 'working', step: 'phrases', percent: 85 },
      '3': {
        state: 'waiting',
        reason: 'not_queued',
        position: null,
        asked_for: false,
        bpm_key: true,
      },
    };
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    await waitFor(() =>
      expect(sent.filter((c) => c.path === '/api/library/dj/analyse')[0]?.body).toEqual({
        track_ids: ['1', '2', '3'],
        reason: 'auto',
        source: 'set',
        set_id: 7,
      }),
    );
    // Brief A (31b): each row's marker, the bar only on the row being analysed
    const marker = await screen.findByText('Analysing · phrases and sections (6 of 6)');
    const row = marker.closest('li')!;
    expect(row.querySelector('[data-analysis-marker] [data-step="6"]')).not.toBeNull();
    expect(within(row).queryByText('Being worked out')).toBeNull();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('BPM and key')).toBeTruthy();
    // the set's line: the track being analysed and how many of its own are left
    const line = screen
      .getByText('Analysing Foghorn Study · phrases and sections (6 of 6) · 1 more in this set')
      .closest('[data-analysis-line]')!;
    expect(
      within(line as HTMLElement).getByRole('button', { name: /^Analyse (all 2|mine)$/ }),
    ).toBeTruthy();
    // the warning Notice counts what isn't ready, by kind
    expect(
      screen.getByText(
        "2 tracks aren't ready to mix: 1 is in line, 1 has BPM and key only. Play as a mix plays them straight on until they are.",
      ),
    ).toBeTruthy();
    // the set's "…": Analyse these, saying how many and that done ones are skipped
    fireEvent.click(screen.getByRole('button', { name: 'More for Sunday Set' }));
    const item = await screen.findByRole('menuitem', { name: 'Analyse these' });
    expect(item.textContent).toContain('3 tracks · ones already done are skipped');
    fireEvent.click(item);
    await waitFor(
      () => expect(sent.filter((c) => c.path === '/api/library/dj/analyse')).toHaveLength(2),
      // asks are a second apart (the server takes one a second a profile)
      { timeout: 4000 },
    );
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith(
        '1 track will be analysed next. 2 tracks already done are skipped.',
        'success',
      ),
    );
  });

  it('a set row’s "…" keeps 24a’s order, then the set’s own', async () => {
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    fireEvent.click(await screen.findByRole('button', { name: 'More for Foghorn Study' }));
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual([
      'Play next',
      'Mixes well with…',
      'Add to mix set…',
      'Add to playlist…',
      'Move up',
      'Move down',
      'Move…',
      'Remove from set',
    ]);
  });
});
