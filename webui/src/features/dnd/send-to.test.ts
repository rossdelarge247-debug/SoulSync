/**
 * Brief B's drops onto other surfaces (32b, 32c): a set that isn't open
 * (the sidebar's, Your sets'), the working set (after the playing track
 * while it plays, 293), Up next (a place, Play next), the draft; each with
 * its toast's words and an Undo that takes exactly what went in out again,
 * through the routes that exist (no new route).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAnalysisRequests } from '@/features/dj/analysis.api';
import { readDraft, writeDraft } from '@/features/sets/draft-store';

import type { DragItem } from './dnd-model';

import {
  indexesOfNumbers,
  sendToDraft,
  sendToSet,
  sendToUpNext,
  sendToWorkingSet,
  setRefusal,
  setSendToContext,
  undoServerAdd,
} from './send-to';

type Body = Record<string, unknown>;
let calls: { path: string; method: string; body: Body }[] = [];
let serverRows: {
  track_id: string | null;
  title: string;
  locked?: boolean;
  transition?: { style: string; bars: number | null } | null;
}[] = [];
let revision = 5;
let analysed: Body[] = [];
let addAnswer: Body = {};

const item = (id: string): DragItem => ({
  id,
  title: `Track ${id}`,
  queue: { id, title: `Track ${id}`, file_path: `/${id}` },
});

beforeEach(() => {
  calls = [];
  analysed = [];
  resetAnalysisRequests();
  revision = 5;
  serverRows = [
    { track_id: '1', title: 'One' },
    { track_id: '2', title: 'Two', locked: true },
    { track_id: '3', title: 'Three' },
  ];
  addAnswer = {};
  window.showToast = vi.fn() as never;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
      const raw =
        input instanceof Request ? await input.text() : (init?.body as string | undefined);
      const body = raw ? (JSON.parse(raw) as Body) : {};
      const path = new URL(url, 'http://x').pathname.replace(/^.*\/api\//, '');
      calls.push({ path, method, body });
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (path === 'library/dj/analyse') {
        analysed.push(body);
        return json({ success: true, tracks: {}, queued: 1, position: 2, working: null });
      }
      if (path === 'library/dj/progress') return json({ success: true, tracks: {} });
      if (path === 'sets/4/tracks')
        return json({
          success: true,
          id: 4,
          name: 'Warm-up',
          added: [{ track_id: '9', number: 4 }],
          already: [],
          left_out: [],
          revision: 6,
          playlist_state: null,
          placed: 'end',
          ...addAnswer,
        });
      if (path === 'sets/4' && method === 'GET')
        return json({
          success: true,
          set: { id: 4, name: 'Warm-up', revision },
          rows: serverRows.map((r) => ({ ...r, artist: null, state: 'owned', track: null })),
          steps: [],
          summary: {},
        });
      if (path === 'sets/4' && method === 'PUT') {
        if (body.base_revision !== revision)
          return json({ success: false, stale: true, revision }, 409);
        revision += 1;
        return json({ success: true, id: 4, revision, playlist_state: null });
      }
      if (path === 'sets/working/start')
        return json({ success: true, id: 12, tracks: 1, working: null });
      if (path === 'sets/12' && method === 'DELETE') return json({ success: true, deleted: 12 });
      return json({ success: true });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  setSendToContext({ working: null, after: null, upNextLast: null });
  delete (window as unknown as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
  delete window.ssAnalysisToastWords;
});

describe('a set that isn’t open (the sidebar, Your sets)', () => {
  it('appends with the existing route, a duplicate going in again, and says where (32b)', async () => {
    const done = await sendToSet({ id: 4, name: 'Warm-up', kind: 'hand' }, [item('9')]);
    const add = calls.find((c) => c.path === 'sets/4/tracks')!;
    expect(add.body).toEqual({ track_ids: ['9'], again: true });
    // queued for its analysis like step 1's triggers, and said once
    expect(analysed[0]).toMatchObject({ track_ids: ['9'], source: 'set', set_id: 4 });
    expect(done?.words).toBe('Added Track 9 to Warm-up · #4 · analysing, 2nd in line');
  });

  it('refuses a famous mix in 32b’s words', async () => {
    expect(setRefusal({ kind: 'famous' })).toBe(
      "A famous mix can't be changed · Save a copy to edit it",
    );
    await expect(
      sendToSet({ id: 4, name: 'Boiler Room', kind: 'famous' }, [item('9')]),
    ).rejects.toThrow("A famous mix can't be changed");
    expect(calls.some((c) => c.path === 'sets/4/tracks')).toBe(false);
  });

  it('says why nothing went in (a file gone missing meanwhile)', async () => {
    addAnswer = { added: [], left_out: [{ id: '9', reason: 'file_missing' }] };
    expect(await sendToSet({ id: 4, name: 'Warm-up', kind: 'hand' }, [item('9')])).toBeNull();
    expect(window.showToast).toHaveBeenCalledWith("Can't be lifted: its file is missing", 'info');
  });

  it('undoes by taking the added rows out from the revision just read (no new route)', async () => {
    serverRows.push({ track_id: '9', title: 'Nine' });
    await undoServerAdd(4, [{ track_id: '9', number: 4 }]);
    const put = calls.find((c) => c.path === 'sets/4' && c.method === 'PUT')!;
    expect(put.body.base_revision).toBe(5);
    expect((put.body.tracks as { track_id: string }[]).map((r) => r.track_id)).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('tries once more when the set moved on between the read and the save', async () => {
    serverRows.push({ track_id: '9', title: 'Nine' });
    let first = true;
    const real = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
        if (method === 'PUT' && first) {
          first = false;
          revision += 1;
        }
        return real(input, init);
      }),
    );
    await undoServerAdd(4, [{ track_id: '9', number: 4 }]);
    expect(revision).toBe(7);
  });

  it('says it can’t when the rows have gone', async () => {
    await expect(undoServerAdd(4, [{ track_id: '9', number: 4 }])).rejects.toThrow(
      "Can't undo: those tracks aren't in the set any more",
    );
  });

  it('[review M1] gives back the joins an add after the playing track reset to Auto', async () => {
    // after the add: 1 → 9 → 2 → 3; 1's long blend was reset (and 3's cut, since changed)
    serverRows = [
      { track_id: '1', title: 'One', transition: { style: 'auto', bars: 16 } },
      { track_id: '9', title: 'Nine', transition: { style: 'auto', bars: null } },
      { track_id: '2', title: 'Two' },
      { track_id: '3', title: 'Three' },
    ];
    await undoServerAdd(
      4,
      [{ track_id: '9', number: 2 }],
      [
        { track_id: '1', number: 1, transition: { style: 'long_blend', bars: 32 } },
        // changed by the person since (not the Auto the add left): theirs, kept
        { track_id: '3', number: 4, transition: { style: 'cut', bars: null } },
      ],
    );
    const put = calls.find((c) => c.path === 'sets/4' && c.method === 'PUT')!;
    const rows = put.body.tracks as { track_id: string; transition: unknown }[];
    expect(rows.map((r) => r.track_id)).toEqual(['1', '2', '3']);
    expect(rows[0].transition).toEqual({ style: 'long_blend', bars: 32 });
    expect(rows[2].transition ?? null).toBeNull();
  });

  it('[review L-b] a set holding a track twice gets each copy’s own join back', async () => {
    serverRows = [
      { track_id: '1', title: 'One', transition: { style: 'auto', bars: 16 } },
      { track_id: '9', title: 'Nine' },
      { track_id: '2', title: 'Two' },
      { track_id: '1', title: 'One again', transition: { style: 'auto', bars: 16 } },
      { track_id: '3', title: 'Three' },
    ];
    await undoServerAdd(
      4,
      [{ track_id: '9', number: 2 }],
      [
        { track_id: '1', number: 1, transition: { style: 'long_blend', bars: 32 } },
        { track_id: '1', number: 4, transition: { style: 'cut', bars: null } },
      ],
    );
    const put = calls.find((c) => c.path === 'sets/4' && c.method === 'PUT')!;
    const rows = put.body.tracks as { track_id: string; transition: unknown }[];
    expect(rows.map((r) => r.track_id)).toEqual(['1', '2', '1', '3']);
    expect(rows[0].transition).toEqual({ style: 'long_blend', bars: 32 });
    expect(rows[2].transition).toEqual({ style: 'cut', bars: null });
  });

  it('passes the add’s reset joins to its Undo', async () => {
    addAnswer = {
      added: [{ track_id: '9', number: 2 }],
      reset: [{ track_id: '1', number: 1, transition: { style: 'long_blend', bars: 32 } }],
    };
    const done = await sendToSet({ id: 4, name: 'Warm-up', kind: 'hand' }, [item('9')], {
      after: { track_id: '1', number: 1 },
    });
    serverRows = [
      { track_id: '1', title: 'One', transition: { style: 'auto', bars: 16 } },
      { track_id: '9', title: 'Nine' },
      { track_id: '2', title: 'Two', locked: true },
      { track_id: '3', title: 'Three' },
    ];
    await done?.undo?.();
    const put = calls.find((c) => c.path === 'sets/4' && c.method === 'PUT')!;
    const rows = put.body.tracks as { track_id: string; transition: unknown }[];
    expect(rows[0].transition).toEqual({ style: 'long_blend', bars: 32 });
  });

  it('[review L4] says it can’t when a numbered row holds another track now, never guessing', async () => {
    // #4 was the added 9; the person moved rows since, so #4 is their own 3
    serverRows = [
      { track_id: '1', title: 'One' },
      { track_id: '9', title: 'Nine' },
      { track_id: '2', title: 'Two' },
      { track_id: '3', title: 'Three' },
      { track_id: '9', title: 'Nine, their own' },
    ];
    await expect(
      undoServerAdd(4, [
        { track_id: '9', number: 2 },
        { track_id: '9', number: 4 },
      ]),
    ).rejects.toThrow("Can't undo: the set has changed since");
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(indexesOfNumbers(serverRows, [{ track_id: '9', number: 4 }])).toEqual([]);
  });

  it('finds the added rows by their numbers, past rows without a track', () => {
    expect(
      indexesOfNumbers(
        [{ track_id: '1' }, { track_id: null }, { track_id: '9' }, { track_id: '9' }],
        [{ track_id: '9', number: 3 }],
      ),
    ).toEqual([3]);
  });
});

describe('the working set', () => {
  it('goes in after the playing track while the set plays (293)', async () => {
    setSendToContext({
      working: { id: 4, name: 'Warm-up', kind: 'hand', next: 9 },
      after: { track_id: '2', number: 2, title: 'Two' },
    });
    await sendToWorkingSet([item('9')]);
    expect(calls.find((c) => c.path === 'sets/4/tracks')!.body).toEqual({
      track_ids: ['9'],
      again: true,
      after: { track_id: '2', number: 2 },
    });
  });

  it('starts one when there’s none, and Undo removes it', async () => {
    const done = await sendToWorkingSet([item('9')]);
    expect(calls.find((c) => c.path === 'sets/working/start')!.body).toMatchObject({
      track_ids: ['9'],
    });
    expect(done?.words).toMatch(/^Started Set from .* with Track 9/);
    await done?.undo?.();
    expect(calls.some((c) => c.path === 'sets/12' && c.method === 'DELETE')).toBe(true);
  });
});

describe('Up next (static/media-player.js)', () => {
  function fakePlayer(queue: Record<string, unknown>[], index: number) {
    const p = {
      queue,
      index,
      state: () => ({ queue: p.queue, index: p.index, track: null }),
      insertAt: vi.fn((at: number, tracks: Record<string, unknown>[]) => {
        const rows = tracks.map((t) => ({ ...t }));
        p.queue.splice(at, 0, ...rows);
        return rows;
      }),
      removeTracks: vi.fn((rows: Record<string, unknown>[]) => {
        let n = 0;
        for (const r of rows) {
          const i = p.queue.indexOf(r);
          if (i >= 0) {
            p.queue.splice(i, 1);
            n += 1;
          }
        }
        return n;
      }),
    };
    (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = p;
    return p;
  }

  it('Play next goes straight after the playing row; Undo takes exactly it out', async () => {
    const p = fakePlayer([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 0);
    const done = await sendToUpNext([item('9')], 'next');
    expect(p.insertAt).toHaveBeenCalledWith(1, [expect.objectContaining({ id: '9' })]);
    expect(done?.words).toBe('Playing next: Track 9');
    await done?.undo?.();
    expect(p.queue.map((q) => q.id)).toEqual(['a', 'b', 'c']);
  });

  it('[review M3] while a mix holds the incoming track, Play next goes straight after it', async () => {
    const p = fakePlayer([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 0);
    (window as unknown as { SoulSyncAutomix: unknown }).SoulSyncAutomix = {
      view: () => ({ stage: 'mixing', barsToGo: null }),
    };
    try {
      const done = await sendToUpNext([item('9')], 'next');
      expect(p.insertAt).toHaveBeenCalledWith(2, [expect.objectContaining({ id: '9' })]);
      expect(done?.words).toBe('Added Track 9 to Up next · #3 · after the incoming track');
    } finally {
      delete (window as unknown as { SoulSyncAutomix?: unknown }).SoulSyncAutomix;
    }
  });

  it('[review L-c] an Undo that couldn’t take every row out says what stayed', async () => {
    const p = fakePlayer([{ id: 'a' }, { id: 'b' }], 0);
    const done = await sendToUpNext([item('8'), item('9')], 2);
    // the player keeps one (the incoming track a mix holds now)
    p.removeTracks.mockImplementationOnce(() => 1);
    await expect(Promise.resolve().then(() => done?.undo?.())).rejects.toThrow(
      'Took 1 of 2 out · one is playing or mixing in now, so it stays',
    );
  });

  it('a place says its number, with the analysis line while Auto mix is on', async () => {
    fakePlayer([{ id: 'a' }, { id: 'b' }], 0);
    window.ssAnalysisToastWords = async () => 'analysing, 3rd in line';
    const done = await sendToUpNext([item('9')], 2);
    expect(done?.words).toBe('Added Track 9 to Up next · #3 · analysing, 3rd in line');
  });
});

describe('the draft in this browser', () => {
  it('appends to it, and Undo takes them back out', () => {
    writeDraft(2, {
      name: 'Set from Tuesday',
      kind: 'hand',
      rows: [{ track_id: '1', artist: null, title: 'One', state: 'owned' }],
    });
    const done = sendToDraft(2, [item('9')]);
    expect(done?.words).toBe('Added Track 9 to Set from Tuesday · #2');
    expect(readDraft(2)?.rows.map((r) => r.track_id)).toEqual(['1', '9']);
    void done?.undo?.();
    expect(readDraft(2)?.rows.map((r) => r.track_id)).toEqual(['1']);
  });
});
