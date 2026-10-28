/**
 * "Add to mix set…" (28a, 28b, 28g): the picker lists your sets with where
 * the track would land, says when it's in one already (Add again), offers
 * "Add 4 / Add all 6" for many, leaves missing files out and says so, makes
 * a new set in place, and ends with a toast whose Open it goes to the set.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAnalysisRequests } from '@/features/dj/analysis.api';

import { AddToMixSetHost, closeAddToMixSet, openAddToMixSet } from './add-to-mix-set';
import { pickerLine } from './sets.format';

type Body = Record<string, unknown>;
let posted: { path: string; body: Body }[] = [];
/** analyse on demand's own requests, kept apart from the sets' */
let analysed: Body[] = [];
let toast: ReturnType<typeof vi.fn>;
let workingId: number | null = null;

const NOW = Date.now() / 1000;
const SETS = [
  {
    id: 7,
    name: 'Sunday Set',
    kind: 'hand',
    updated_at: NOW,
    next: 25,
    rows: 24,
    holds: { '4': [4] },
  },
  {
    id: 8,
    name: 'Deep and warm, building to peak',
    kind: 'suggested',
    updated_at: NOW,
    next: 17,
    rows: 16,
    holds: {},
  },
];

let analyseAnswer: Record<string, unknown> = {};

beforeEach(() => {
  posted = [];
  analysed = [];
  analyseAnswer = {};
  resetAnalysisRequests();
  workingId = null;
  toast = vi.fn();
  window.showToast = toast as never;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const raw =
        input instanceof Request ? await input.text() : (init?.body as string | undefined);
      const body = raw ? (JSON.parse(raw) as Body) : {};
      const path = new URL(url, 'http://x').pathname.replace(/^.*\/api\//, '');
      if (path === 'library/dj/analyse' || path === 'library/dj/progress') {
        if (path === 'library/dj/analyse') analysed.push(body);
        return new Response(
          JSON.stringify({
            success: true,
            tracks: {},
            sweep: null,
            asked: 0,
            queued: 0,
            already_queued: 0,
            already_done: 0,
            cant: 0,
            over_limit: 0,
            limit: 200,
            yours: 0,
            started: false,
            ...analyseAnswer,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      posted.push({ path, body });
      let answer: unknown = { success: true };
      if (path === 'sets/holding') {
        const ids = body.track_ids as string[];
        answer = {
          success: true,
          sets: SETS.map((s) => ({
            ...s,
            holds: Object.fromEntries(Object.entries(s.holds).filter(([k]) => ids.includes(k))),
          })),
        };
      } else if (path === 'sets/7/tracks' || path === 'sets/8/tracks') {
        const ids = body.track_ids as string[];
        const id = Number(path.split('/')[1]);
        const add = body.again ? ids : ids.filter((i) => i !== '4' || id !== 7);
        answer = {
          success: true,
          id,
          name: SETS.find((s) => s.id === id)!.name,
          added: add.map((t, k) => ({ track_id: t, number: 25 + k })),
          already: [],
          left_out: [],
          revision: 3,
          playlist_state: null,
        };
      } else if (path === 'sets') answer = { success: true, id: 12, playlist_id: 3 };
      else if (path === 'sets/working')
        answer = { success: true, working: workingId ? { id: workingId, name: 'x' } : null };
      return new Response(JSON.stringify(answer), { status: 200 });
    }),
  );
});

afterEach(() => {
  act(() => closeAddToMixSet());
  vi.unstubAllGlobals();
  delete window.SoulSyncStars;
  delete window.showToast;
});

const one = { id: '9', title: 'Harbour Light', artist: 'Kestrel Row' };

describe('the picker’s words', () => {
  it('says where it lands, or that it’s there', () => {
    expect(pickerLine({ count: 1, next: 25, held: [[]], when: 'edited today' }).line).toBe(
      'adds as #25 · edited today',
    );
    expect(pickerLine({ count: 1, next: 25, held: [[4]] }).line).toBe('In it already · #4');
    expect(pickerLine({ count: 6, next: 17, held: [[], [], [], [], [], []] }).line).toBe(
      'adds as #17–22',
    );
    expect(pickerLine({ count: 6, next: 25, held: [[2], [3], [], [], [], []] }).line).toBe(
      '2 of them are in it already: adds 4, as #25–28',
    );
  });
});

describe('Add to mix set…', () => {
  it('adds one track and says where, with Open it', async () => {
    render(<AddToMixSetHost />);
    act(() => openAddToMixSet(one));
    const dialog = await screen.findByRole('dialog', { name: 'Add Harbour Light to…' });
    expect(within(dialog).getByRole('searchbox', { name: 'Find a mix set' })).toHaveFocus();
    expect(within(dialog).getByText('Recent')).toBeTruthy();
    expect(await within(dialog).findByText('adds as #25 · edited today')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /Sunday Set/ }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(posted.at(-1)).toEqual({
      path: 'sets/7/tracks',
      body: { track_ids: ['9'], again: false },
    });
    const [words, kind, , opts] = toast.mock.calls[0];
    expect(words).toBe('Added Harbour Light to Sunday Set · #25');
    expect(kind).toBe('success');
    expect(opts.action.label).toBe('Open it');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a track in it already: the row says so, Add again adds it again (28a, 28g)', async () => {
    render(<AddToMixSetHost />);
    act(() => openAddToMixSet({ id: '4', title: 'Copper Sky', artist: 'Ines Varga' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Copper Sky to…' });
    expect(await within(dialog).findByText('In it already · #4 · edited today')).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Add Copper Sky to Sunday Set again' }),
    );
    await waitFor(() => expect(posted.at(-1)?.path).toBe('sets/7/tracks'));
    expect(posted.at(-1)?.body).toEqual({ track_ids: ['4'], again: true });
    // analyse on demand: a track added to a set jumps the analysis queue, for that set
    await waitFor(() =>
      expect(analysed).toEqual([{ track_ids: ['4'], reason: 'auto', source: 'set', set_id: 7 }]),
    );
  });

  it('Brief A: the Added toast says once where it is in the analysis line (31d)', async () => {
    analyseAnswer = { queued: 1, position: 2, working: false };
    render(<AddToMixSetHost />);
    act(() => openAddToMixSet(one));
    const dialog = await screen.findByRole('dialog', { name: 'Add Harbour Light to…' });
    fireEvent.click(await within(dialog).findByRole('button', { name: /Sunday Set/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0]).toBe(
      'Added Harbour Light to Sunday Set · #25 · analysing, 2nd in line',
    );
  });

  it('many: the choice opens in place, and a missing file is left out and said (28b)', async () => {
    render(<AddToMixSetHost />);
    act(() =>
      openAddToMixSet([
        { id: '4', title: 'Copper Sky', artist: 'x' },
        { id: '5', title: 'Signal Fire', artist: 'x', fileMissing: true },
        { id: '6', title: 'Kelp Garden', artist: 'x' },
      ]),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Add 2 tracks to…' });
    expect(
      within(dialog).getByText("1 isn't on this computer (File missing) and is left out."),
    ).toBeTruthy();
    const sunday = await within(dialog).findByRole('button', { name: /Sunday Set/ });
    expect(sunday.textContent).toContain('1 of them is in it already: adds 1, as #25');
    fireEvent.click(sunday);
    expect(sunday).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add all 2' }));
    await waitFor(() => expect(posted.at(-1)?.path).toBe('sets/7/tracks'));
    expect(posted.at(-1)?.body).toEqual({ track_ids: ['4', '6'], again: true });
    await waitFor(() =>
      expect(toast.mock.calls[0][0]).toBe('Added 2 tracks to Sunday Set · #25–26'),
    );
  });

  it('New mix set… is named in place, then made with the track in it', async () => {
    render(<AddToMixSetHost />);
    act(() => openAddToMixSet(one));
    const dialog = await screen.findByRole('dialog', { name: 'Add Harbour Light to…' });
    fireEvent.click(within(dialog).getByRole('button', { name: /New mix set/ }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: "The new mix set's name" }), {
      target: { value: 'Warm-up' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make it' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const made = posted.find((p) => p.path === 'sets')!;
    expect(made.body).toMatchObject({ name: 'Warm-up', kind: 'hand' });
    expect((made.body.tracks as Body[])[0]).toMatchObject({ track_id: '9', state: 'owned' });
    expect(toast.mock.calls[0][0]).toBe('Added Harbour Light to Warm-up · #1');
  });

  it('search finds any of your sets', async () => {
    render(<AddToMixSetHost />);
    act(() => openAddToMixSet(one));
    const dialog = await screen.findByRole('dialog', { name: 'Add Harbour Light to…' });
    await within(dialog).findByText(/Sunday Set/);
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'deep' } });
    expect(within(dialog).queryByText('Sunday Set')).toBeNull();
    expect(within(dialog).getByText('Deep and warm, building to peak')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(within(dialog).getByText('No mix set matches “zzz”.')).toBeTruthy();
  });

  it('puts the Mix tab’s working set first, tagged (29a)', async () => {
    workingId = 8;
    render(<AddToMixSetHost />);
    act(() => openAddToMixSet(one));
    const dialog = await screen.findByRole('dialog', { name: 'Add Harbour Light to…' });
    const list = await within(dialog).findByRole('list', { name: 'Your mix sets' });
    await waitFor(() =>
      expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent(
        'Deep and warm, building to peak Working set',
      ),
    );
    expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent('Sunday Set');
  });
});
