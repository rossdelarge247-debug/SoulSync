import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { refreshPrefs } from '@/features/automix/prefs';
import { saveTransitionToDraft } from '@/features/automix/set-play';
import { analysisStore, resetAnalysisRequests } from '@/features/dj/analysis.api';
import { resetMixForTests } from '@/features/mix/mix-store';
import { readDraft, resetDraftsForTests, writeDraft } from '@/features/sets/draft-store';
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
/** the profile's working set (`/api/sets/working`) */
let workingSet: { id: number; name: string } | null = null;
/** the set's rows on the stand-in server when something else changed them */
let serverRows: typeof SAVED_ROWS | null = null;
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
  workingSet = null;
  serverRows = null;
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
      if (path === '/api/sets/working' && method === 'PUT') {
        const id = (body as { set_id: number | null }).set_id;
        workingSet = id ? { id, name: 'Sunday Set' } : null;
        answer = {
          success: true,
          working: workingSet ? { ...workingSet, kind: 'hand', revision: 3 } : null,
        };
      } else if (path === '/api/sets/working')
        answer = {
          success: true,
          working: workingSet ? { ...workingSet, kind: 'hand', revision: 3 } : null,
        };
      else if (path === '/api/sets' && method === 'GET')
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
          ...view(serverRows ?? SAVED_ROWS),
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
          rows: view(serverRows ?? SAVED_ROWS).rows,
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
  resetMixForTests();
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
    const save = screen.getByRole('button', { name: 'Save as a set' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
  });

  it('opens a saved set with its steps; Lock and Swap save it', async () => {
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    await waitFor(() =>
      expect(document.querySelector('[data-set-editor] p')!.textContent).toBe(
        '3 tracks · 18 min · 118–120 BPM · 2 smooth steps · Hide 1 not in your library',
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

    fireEvent.click(screen.getByRole('button', { name: 'Save as a set' }));
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

describe('a set’s page beyond 22c (28e, 28g)', () => {
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
    // the chip names Auto's pick once the pair is planned (26i); Auto mix is
    // off here, which its name says (the line is said once, at the list's head)
    const chip = await screen.findByRole('button', {
      name: /^How Lowtide Hymn goes into Foghorn Study: Long blend · 32 bars, auto/,
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
        name: /^How Lowtide Hymn goes into Foghorn Study: Bass swap · 32 bars, your choice/,
      }),
    ).toBeTruthy();
    await waitFor(() => expect(calls('/api/sets/7', 'PUT').length).toBe(1), { timeout: 2000 });
    const put = calls('/api/sets/7', 'PUT')[0].body as { tracks: { transition: unknown }[] };
    expect(put.tracks[0].transition).toEqual({ style: 'bass_swap', bars: 32 });
  });

  it('with Auto mix off a set keeps its chips, dimmed, said once above the list (320, UX-21, UX-29)', async () => {
    localStorage.setItem('soulsync-between-tracks', 'off');
    refreshPrefs();
    // a browser that can run the decks (jsdom has no AudioWorklet)
    vi.stubGlobal('AudioWorkletNode', class {});
    try {
      renderPage('/library?view=sets&set=7');
      await screen.findByDisplayValue('Sunday Set');
      const chip = await screen.findByRole('button', {
        name: 'How Lowtide Hymn goes into Foghorn Study: Long blend · 32 bars, auto (Auto mix is off: plays straight on). Change it',
      });
      const wrap = chip.parentElement!;
      expect(wrap).toHaveAttribute('data-dimmed');
      // who chose it, on screen (UX-29), and no line of what plays instead
      expect(wrap.querySelector('[data-chip-who]')?.textContent).toBe('auto');
      expect(wrap).not.toHaveTextContent(/Auto mix is off|Play as a mix/);
      // said once, above the list (320)
      expect(screen.getAllByText(/Auto mix is off: tracks play straight on/)).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Turn it on' })).toBeTruthy();
      localStorage.setItem('soulsync-between-tracks', 'dj');
      act(() => refreshPrefs());
      await waitFor(() => expect(wrap).not.toHaveAttribute('data-dimmed'));
      expect(wrap.querySelector('[data-chip-who]')?.textContent).toBe('auto');
      expect(screen.queryByText(/Auto mix is off/)).toBeNull();
      // 28e, 319: a saved set plays with its chips, Play as a mix before Export
      const play = screen.getByRole('button', { name: 'Play as a mix' });
      const exp = screen.getByRole('button', { name: 'Export to Traktor…' });
      expect(play.compareDocumentPosition(exp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
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
      // "Analyse all 1": the one being analysed isn't asked for again (review L11)
      within(line as HTMLElement).getByRole('button', { name: /^Analyse (all 1|mine)$/ }),
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
      'Add to set…',
      'Add to playlist…',
      'Move up',
      'Move down',
      'Move…',
      'Remove from set',
    ]);
  });
});

describe("[review M2] 319: a chip saved to the draft from Up next survives the draft's next edit", () => {
  it("the editor takes the draft's new transitions in before it writes again", async () => {
    const base = { artist: 'Tidewater', state: 'owned' as const, want: 'yours' as const };
    writeDraft(2, {
      name: 'Draft',
      kind: 'hand',
      rows: [
        { ...base, track_id: '1', title: 'Night Ferry' },
        { ...base, track_id: '2', title: 'Static Bloom' },
      ],
    });
    renderPage('/library?view=sets&set=draft');
    await screen.findByText('Draft · not saved');
    const name = await screen.findByDisplayValue('Draft');
    // Up next, with the draft played as a mix: "Save it to Draft too?" → Save
    act(() => saveTransitionToDraft(2, '1', '2', { style: 'echo_out', bars: 4 }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // then an edit here
    fireEvent.change(name, { target: { value: 'Draft two' } });
    await waitFor(() => expect(readDraft(2)?.name).toBe('Draft two'));
    expect(readDraft(2)?.rows[0].transition).toEqual({ style: 'echo_out', bars: 4 });
  });
});

describe("Brief C's set header (33c), Your sets (33e) and Brief D's rows (34b)", () => {
  it('33c: Play is the primary, then Play as a mix, Export; the working-set toggle and its tag', async () => {
    workingSet = { id: 7, name: 'Sunday Set' };
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    const head = document.querySelector<HTMLElement>('[data-set-head]')!;
    expect(head.tagName).toBe('DIV'); // UX-28: not a second banner
    const buttons = within(head)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim());
    const at = buttons.indexOf('Play');
    expect(buttons.slice(at, at + 3)).toEqual(['Play', 'Play as a mix', 'Export to Traktor…']);
    expect(within(head).getByRole('button', { name: 'Play' })).toHaveAttribute(
      'data-variant',
      'primary',
    );
    const toggle = await within(head).findByRole('button', { name: 'My working set' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(within(head).getByText('Working set')).toHaveAttribute('data-set-tag', 'working');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(calls('/api/sets/working', 'PUT').map((c) => c.body)).toEqual([{ set_id: null }]),
    );
    expect(
      await within(head).findByRole('button', { name: 'Make this my working set' }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('262: the head\'s "…" is Open its playlist · Duplicate · Make this my working set · Remove this set…', async () => {
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    fireEvent.click(screen.getByRole('button', { name: 'More for Sunday Set' }));
    await screen.findByRole('menuitem', { name: 'Duplicate' });
    expect(
      screen
        .getAllByRole('menuitem')
        .map((m) => m.textContent)
        .filter((t) => !t?.startsWith('Analyse these')),
    ).toEqual(['Open its playlist', 'Duplicate', 'Make this my working set', 'Remove this set…']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(calls('/api/sets', 'POST')).toHaveLength(1));
    expect((calls('/api/sets', 'POST')[0].body as { name: string }).name).toBe('Sunday Set (copy)');
  });

  it('267: Remove this set… is a confirm on the dialog frame: Keep keeps it, Remove removes it', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    fireEvent.click(screen.getByRole('button', { name: 'More for Sunday Set' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove this set…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Sunday Set?' });
    expect(within(dialog).getByText('Its playlist stays.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls('/api/sets/7', 'DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'More for Sunday Set' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove this set…' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(calls('/api/sets/7', 'DELETE')).toHaveLength(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('[gauntlet M2] removing the working set has every place read the working set again', async () => {
    const { MIX_SET_CHANGED } = await import('@/features/sets/sets.api');
    workingSet = { id: 7, name: 'Sunday Set' };
    const changed = vi.fn();
    window.addEventListener(MIX_SET_CHANGED, changed);
    try {
      renderPage('/library?view=sets&set=7');
      await screen.findByDisplayValue('Sunday Set');
      await waitFor(() => expect(calls('/api/sets/working', 'GET').length).toBeGreaterThan(0));
      const before = calls('/api/sets/working', 'GET').length;
      fireEvent.click(screen.getByRole('button', { name: 'More for Sunday Set' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove this set…' }));
      // the server lets go of it as the set goes
      workingSet = null;
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
      );
      await waitFor(() => expect(calls('/api/sets/7', 'DELETE')).toHaveLength(1));
      await waitFor(() => expect(changed).toHaveBeenCalled());
      await waitFor(() => expect(calls('/api/sets/working', 'GET').length).toBeGreaterThan(before));
    } finally {
      window.removeEventListener(MIX_SET_CHANGED, changed);
    }
  });

  it('[gauntlet M2] removing a set from Your sets does the same', async () => {
    const { MIX_SET_CHANGED } = await import('@/features/sets/sets.api');
    workingSet = { id: 7, name: 'Sunday Set' };
    const changed = vi.fn();
    window.addEventListener(MIX_SET_CHANGED, changed);
    try {
      renderPage();
      const row = (await screen.findByText('Sunday Set')).closest('[data-set-list-row], li')!;
      fireEvent.click(within(row as HTMLElement).getByRole('button', { name: /^More for/ }));
      fireEvent.click(await screen.findByRole('menuitem', { name: /^Remove/ }));
      workingSet = null;
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
      );
      await waitFor(() => expect(calls('/api/sets/7', 'DELETE')).toHaveLength(1));
      await waitFor(() => expect(changed).toHaveBeenCalled());
    } finally {
      window.removeEventListener(MIX_SET_CHANGED, changed);
    }
  });

  it('33c, 34b: the playing row is a green ▶ with "Playing · 3 of 3"; a row\'s Play plays the set from it', async () => {
    const playTrackList = vi.fn(async () => ({ status: 'played' }));
    const w = window as unknown as Record<string, unknown>;
    w.playTrackList = playTrackList;
    // their files are here, so the set has a queue to play
    for (const id of ['1', '2', '3']) LIBRARY[id].file_path = `/m/${id}.flac` as never;
    w.SoulSyncPlayer = {
      state: () => ({
        track: { id: '3', title: 'Undertow' },
        queue: [
          { id: '1', from_set: { id: 7, name: 'Sunday Set', row: 0 } },
          { id: '3', from_set: { id: 7, name: 'Sunday Set', row: 3 } },
        ],
        index: 1,
      }),
      audio: () => null,
      renderQueue: () => {},
    };
    try {
      renderPage('/library?view=sets&set=7');
      await screen.findByDisplayValue('Sunday Set');
      expect(await screen.findByText('Playing · 3 of 3')).toHaveAttribute(
        'data-set-tag',
        'playing',
      );
      const undertow = document.querySelector<HTMLElement>('[data-set-row="3"]')!;
      expect(undertow).toHaveAttribute('data-playing', 'true');
      expect(within(undertow).getByRole('img', { name: 'Playing, #3' })).toBeTruthy();
      const foghorn = document.querySelector<HTMLElement>('[data-set-row="1"]')!;
      fireEvent.click(within(foghorn).getByRole('button', { name: 'Play Foghorn Study' }));
      await waitFor(() => expect(playTrackList).toHaveBeenCalledTimes(1));
      const [queue, name, options] = playTrackList.mock.calls[0] as unknown as [
        { id: string; from_set?: { row: number }; mix_set?: unknown }[],
        string,
        { startIndex: number },
      ];
      expect(name).toBe('Sunday Set');
      expect(queue.map((t) => t.id)).toEqual(['1', '2', '3']);
      expect(queue.every((t) => t.from_set && !t.mix_set)).toBe(true);
      expect(options.startIndex).toBe(1);
    } finally {
      delete w.playTrackList;
      delete w.SoulSyncPlayer;
      for (const id of ['1', '2', '3']) LIBRARY[id].file_path = null;
    }
  });

  it('[gauntlet M3] the playing row follows its track when a row above it goes', async () => {
    const w = window as unknown as Record<string, unknown>;
    w.SoulSyncPlayer = {
      state: () => ({
        track: { id: '3', title: 'Undertow' },
        queue: [{ id: '3', from_set: { id: 7, name: 'Sunday Set', row: 3 } }],
        index: 0,
      }),
      audio: () => null,
      renderQueue: () => {},
    };
    try {
      renderPage('/library?view=sets&set=7');
      await screen.findByDisplayValue('Sunday Set');
      expect(await screen.findByText('Playing · 3 of 3')).toBeTruthy();
      const foghorn = document.querySelector<HTMLElement>('[data-set-row="1"]')!;
      fireEvent.click(within(foghorn).getByRole('button', { name: 'More for Foghorn Study' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from set' }));
      // Undertow is the third row now (index 2), and still the playing one
      expect(await screen.findByText('Playing · 2 of 2')).toBeTruthy();
      const undertow = document.querySelector<HTMLElement>('[data-set-row="2"]')!;
      expect(within(undertow).getByText('Undertow')).toBeTruthy();
      expect(undertow).toHaveAttribute('data-playing', 'true');
      expect(document.querySelectorAll('[data-set-row][data-playing="true"]')).toHaveLength(1);
    } finally {
      delete w.SoulSyncPlayer;
    }
  });

  it('263: lines not in your library fold away on the head and come back', async () => {
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    expect(await screen.findByText('Gravity Well')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide 1 not in your library' }));
    expect(screen.queryByText('Gravity Well')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 not in your library' }));
    expect(screen.getByText('Gravity Well')).toBeTruthy();
  });

  it('33e: Your sets tags the working set and has its toggle; the others make it so', async () => {
    renderPage();
    const row = (await screen.findByText('Sunday Set')).closest('li')!;
    const make = await within(row).findByRole('button', { name: 'Make this my working set' });
    fireEvent.click(make);
    await waitFor(() =>
      expect(calls('/api/sets/working', 'PUT').map((c) => c.body)).toEqual([{ set_id: 7 }]),
    );
    expect(await within(row).findByRole('button', { name: 'Working set' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(row).getByText('Working set', { selector: '[data-set-tag]' })).toBeTruthy();
  });

  it("266: Suggest a set's reason is one meta line under the tab pair", async () => {
    renderPage();
    const reason = await screen.findByText(/Set suggestions come with the next step of Sets/);
    const tabs = screen.getByRole('tablist', { name: 'Ways to start a set' });
    expect(reason.parentElement).toBe(tabs.parentElement);
    expect(tabs.nextElementSibling).toBe(reason);
  });
});

describe('the UX review on a set (UX-8, UX-19, UX-27, UX-30)', () => {
  it('UX-8, UX-27: Remove from set says so once with Undo, and Undo puts it back', async () => {
    const toasts: [string, unknown][] = [];
    window.showToast = vi.fn((m: string, _t?: string, _c?: unknown, opts?: unknown) => {
      toasts.push([m, opts]);
    }) as never;
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    const row = document.querySelector<HTMLElement>('[data-set-row="1"]')!;
    fireEvent.click(within(row).getByRole('button', { name: 'More for Foghorn Study' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from set' }));
    await waitFor(() => expect(screen.queryByText('Foghorn Study')).toBeNull());
    const [words, opts] = toasts.find(([m]) => m.startsWith('Removed'))!;
    expect(words).toBe('Removed Foghorn Study from Sunday Set');
    // the toast's own live region says it (once); Undo stays up 10 s
    expect(opts).toMatchObject({ ms: 10_000, action: { label: 'Undo' } });
    expect(document.querySelector('[data-set-announce]')).not.toHaveTextContent(words);
    act(() => (opts as { action: { run: () => void } }).action.run());
    expect(await screen.findByText('Foghorn Study')).toBeTruthy();
    expect(document.querySelector('[data-set-announce]')).toHaveTextContent(`Undone: ${words}`);
  });

  it('[gauntlet H1] Undo after a newer server copy keeps the row added since, and saves from its revision', async () => {
    const { MIX_SET_CHANGED } = await import('@/features/sets/sets.api');
    const toasts: [string, unknown][] = [];
    window.showToast = vi.fn((m: string, _t?: string, _c?: unknown, opts?: unknown) => {
      toasts.push([m, opts]);
    }) as never;
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    const row = document.querySelector<HTMLElement>('[data-set-row="1"]')!;
    fireEvent.click(within(row).getByRole('button', { name: 'More for Foghorn Study' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from set' }));
    // the remove autosaves (revision 4)
    await waitFor(() => expect(calls('/api/sets/7', 'PUT').length).toBe(1), { timeout: 2000 });
    await screen.findByText('Saved');
    // then the Mix tab adds Kelp Garden on the server (revision 5)
    serverRows = [
      SAVED_ROWS[0],
      SAVED_ROWS[2],
      SAVED_ROWS[3],
      { track_id: '6', artist: 'Pale Harbour', title: 'Kelp Garden', state: 'owned' },
    ];
    serverRevision = 5;
    act(() => {
      window.dispatchEvent(new CustomEvent(MIX_SET_CHANGED, { detail: { id: 7 } }));
    });
    expect(await screen.findByText('Kelp Garden')).toBeTruthy();
    // Undo the remove: Foghorn Study goes back after Lowtide Hymn, Kelp Garden stays
    const [, opts] = toasts.find(([m]) => m.startsWith('Removed'))!;
    act(() => (opts as { action: { run: () => void } }).action.run());
    await waitFor(() => expect(calls('/api/sets/7', 'PUT').length).toBe(2), { timeout: 2000 });
    const put = calls('/api/sets/7', 'PUT')[1].body as {
      base_revision: number;
      tracks: { title: string }[];
    };
    expect(put.base_revision).toBe(5);
    expect(put.tracks.map((t) => t.title)).toEqual([
      'Lowtide Hymn',
      'Foghorn Study',
      'Gravity Well',
      'Undertow',
      'Kelp Garden',
    ]);
  });

  it('[re-review Low a] leaving the set page takes its Undo down; a late Undo says so and saves nothing', async () => {
    const toasts: [string, unknown][] = [];
    window.showToast = vi.fn((m: string, _t?: string, _c?: unknown, opts?: unknown) => {
      toasts.push([m, opts]);
    }) as never;
    const dismissToast = vi.fn(() => true);
    window.dismissToast = dismissToast;
    try {
      renderPage('/library?view=sets&set=7');
      await screen.findByDisplayValue('Sunday Set');
      const row = document.querySelector<HTMLElement>('[data-set-row="1"]')!;
      fireEvent.click(within(row).getByRole('button', { name: 'More for Foghorn Study' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from set' }));
      await waitFor(() => expect(calls('/api/sets/7', 'PUT').length).toBe(1), { timeout: 2000 });
      const [, opts] = toasts.find(([m]) => m.startsWith('Removed'))!;
      expect(opts).toMatchObject({ key: 'set-undo' });
      // back to Sets: the page goes, and its toast with it
      fireEvent.click(screen.getByRole('button', { name: 'Sets' }));
      await screen.findByRole('heading', { level: 1, name: 'Sets' });
      expect(dismissToast).toHaveBeenCalledWith('set-undo');
      act(() => (opts as { action: { run: () => void } }).action.run());
      expect(toasts.at(-1)?.[0]).toBe("Can't undo here: open the set to change it");
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(calls('/api/sets/7', 'PUT')).toHaveLength(1);
    } finally {
      delete window.dismissToast;
    }
  });

  it('[gauntlet H1] Undo of a move whose row has gone says so and changes nothing', async () => {
    const { MIX_SET_CHANGED } = await import('@/features/sets/sets.api');
    const toasts: [string, unknown][] = [];
    window.showToast = vi.fn((m: string, _t?: string, _c?: unknown, opts?: unknown) => {
      toasts.push([m, opts]);
    }) as never;
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    const row = document.querySelector<HTMLElement>('[data-set-row="3"]')!;
    fireEvent.click(within(row).getByRole('button', { name: 'More for Undertow' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'To the top' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }));
    await waitFor(() => expect(calls('/api/sets/7', 'PUT').length).toBe(1), { timeout: 2000 });
    await screen.findByText('Saved');
    // somewhere else, Undertow is taken out of the set
    serverRows = [SAVED_ROWS[0], SAVED_ROWS[1], SAVED_ROWS[2]];
    serverRevision = 5;
    act(() => {
      window.dispatchEvent(new CustomEvent(MIX_SET_CHANGED, { detail: { id: 7 } }));
    });
    await waitFor(() => expect(screen.queryByText('Undertow')).toBeNull());
    const [, opts] = toasts.find(([m]) => m.startsWith('Undertow moved'))!;
    act(() => (opts as { action: { run: () => void } }).action.run());
    expect(document.querySelector('[data-set-announce]')).toHaveTextContent(
      "Can't undo: that track isn't in the set any more",
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(calls('/api/sets/7', 'PUT')).toHaveLength(1);
  });

  it('UX-30, UX-27: Move… lists places by neighbour and says where it went', async () => {
    renderPage('/library?view=sets&set=7');
    await screen.findByDisplayValue('Sunday Set');
    const row = document.querySelector<HTMLElement>('[data-set-row="3"]')!;
    fireEvent.click(within(row).getByRole('button', { name: 'More for Undertow' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move…' }));
    const dialog = await screen.findByRole('dialog');
    const places = within(dialog)
      .getAllByRole('radio')
      .map((r) => r.closest('label')!.textContent);
    expect(places).toEqual([
      'To the top',
      'After Lowtide Hymn',
      'After Foghorn Study',
      'After Gravity Wellits place now',
    ]);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'To the top' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }));
    // said once, by the toast's live region, with Undo
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith(
        'Undertow moved to 1 of 4',
        'success',
        null,
        expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
      ),
    );
  });

  it('UX-19: a new set is "Set from Tuesday 27 Oct" everywhere, and an empty draft says where to add', async () => {
    const { newSetName } = await import('@/features/sets/sets.format');
    expect(newSetName(new Date(2026, 9, 27))).toBe('Set from Tuesday 27 Oct');
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New empty set' }));
    expect(
      await screen.findByText(/a draft stays in this browser until you save it as a set/),
    ).toBeTruthy();
    expect(screen.queryByText(/Add to set…, or below/)).toBeNull();
  });
});
