/**
 * DJ mode's lanes (37b–37e): lane A from the player's track, the beat map
 * from its grid, the analysing and no-grid states, empty B with and without
 * Browse, and lane B as the drag's `dj` target (37c's drop line, 37d's amber
 * reasons, a drop loading B cued).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DragItem } from '@/features/dnd/dnd-model';

import { getTarget, pointerDown, resetDndForTests } from '@/features/dnd/dnd-engine';
import { HttpResponse, http, server } from '@/test/msw';

import { DjModeStore } from './dj-mode-store';
import { apiGrid } from './dj-mode.fixtures';
import { DjStage, LANE_B_TARGET } from './dj-stage';

const FERRY = {
  id: '2',
  title: 'Night Ferry',
  artist: 'Tidewater',
  is_library: true,
  filename: '/m/2.flac',
};
const audio = { currentTime: 121, duration: 286 };
let grids: Record<string, unknown>;

function makeStore(
  say: (w: string) => void = () => undefined,
  { peaksFail = false }: { peaksFail?: boolean } = {},
): DjModeStore {
  return new DjModeStore({
    fetch: async (url: string, init?: RequestInit) => {
      let m = /\/peaks$/.exec(url);
      if (m && peaksFail) return new Response('{}', { status: 500 });
      if (m) return new Response(JSON.stringify({ peaks: [0.2, 0.9, 0.4, 0.6], duration_s: 286 }));
      m = /\/api\/library\/dj\/grid\/([^/]+)$/.exec(url);
      if (m) {
        const g = grids[decodeURIComponent(m[1]!)];
        return g
          ? new Response(JSON.stringify({ success: true, grid: g }))
          : new Response('{}', { status: 404 });
      }
      if (url.endsWith('/api/library/dj/tracks')) {
        const id = (JSON.parse(init?.body as string) as { track_ids: string[] }).track_ids[0]!;
        return new Response(
          JSON.stringify({
            tracks: { [id]: id === '2' ? { bpm: 124, key: '8A' } : { bpm: 126, key: '8A' } },
          }),
        );
      }
      return new Response('{}', { status: 404 });
    },
    analyse: () => undefined,
    phone: () => false,
    say,
  });
}

beforeEach(() => {
  grids = { '2': apiGrid({ track_id: '2' }), '8': apiGrid({ track_id: '8', bars: 128 }) };
  (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
    state: () => ({ track: FERRY, kind: 'library' }),
    audio: () => audio,
  };
  server.use(
    http.post('*/api/library/dj/progress', () =>
      HttpResponse.json({
        success: true,
        tracks: { '2': { state: 'working', step: 'grid', percent: 60 } },
        sweep: {
          running: false,
          held: false,
          analyze: true,
          id: null,
          total: 0,
          done: 0,
          percent: null,
          waiting: null,
          in_line: 0,
          yours: 0,
          current: null,
        },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  resetDndForTests();
  delete (window as unknown as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
});

async function on(store: DjModeStore) {
  render(<DjStage store={store} />);
  await act(async () => {
    store.setOn(true);
    await new Promise((r) => setTimeout(r, 10));
  });
}

describe('lane A (37b)', () => {
  it('draws nothing while DJ mode is off', () => {
    const { container } = render(<DjStage store={makeStore()} />);
    expect(container.innerHTML).toBe('');
  });

  it('is the player’s track: a named group, its data, the peaks, the sections, the beat map and its line', async () => {
    const store = makeStore();
    await on(store);
    // the line is the group's description, not part of its name (review M3)
    const a = screen.getByRole('group', {
      name: 'Deck A, Night Ferry, playing',
      description: 'bar 61 of 142 · drop in 0:40 · mix-out from bar 121 (4:01)',
    });
    expect(a).toHaveAttribute('tabindex', '0');
    expect(a).toHaveTextContent('A · playing · the player’s track');
    expect(a).toHaveTextContent('Night Ferry · Tidewater');
    expect(a.querySelector('abbr')).toHaveTextContent('8A');
    expect(a).toHaveTextContent('· 124.0');
    expect(a.querySelectorAll('rect')).toHaveLength(4);
    expect(a.querySelector('[data-dj-sections]')).toHaveTextContent('intromainbreakdowndropoutro');
    const map = screen.getByRole('img', { name: /^Beat map: 142 bars/ });
    expect(map.querySelectorAll('[data-phrase]')).toHaveLength(18);
    expect(map.querySelectorAll('[data-region]')).toHaveLength(2);
    const line = a.querySelector('[data-dj-line="a"]')!;
    // not a live region: it would talk every phrase (review M3)
    expect(line).not.toHaveAttribute('aria-live');
    expect(a.querySelector('[aria-live]')).toBeNull();
    expect(line).toHaveTextContent('bar 61 of 142 · drop in 0:40 · mix-out from bar 121 (4:01)');
    // the playhead and the elapsed time follow the player's element
    // (3b: --played is on the lane, so the zoom layer and the beat map read it too)
    expect((a as HTMLElement).style.getPropertyValue('--played')).toBe(String(121 / 286));
    expect(a.querySelector('[data-dj-time="a"]')).toHaveTextContent('2:01');
  });

  it('the line you see keeps up every second (review M2), without a render or a live region', async () => {
    const store = makeStore();
    await on(store);
    const line = () => document.querySelector('[data-dj-line="a"]')!.textContent;
    audio.currentTime = 123.2; // the same phrase, a bar on: the words still move
    await act(async () => new Promise((r) => setTimeout(r, 60)));
    expect(line()).toBe('bar 62 of 142 · drop in 0:37 · mix-out from bar 121 (4:01)');
    audio.currentTime = 131; // bar 66
    await act(async () => new Promise((r) => setTimeout(r, 60)));
    expect(line()).toBe('bar 66 of 142 · drop in 0:30 · mix-out from bar 121 (4:01)');
    audio.currentTime = 121;
  });

  it('says the mix-out once when it’s reached while playing, not every phrase (M3), once per track (N4)', async () => {
    const said: string[] = [];
    const store = makeStore((w) => said.push(w));
    await on(store);
    said.length = 0;
    // crossed, a seek back, crossed again: said the first time only
    for (const t of [200, 239, 241, 245, 262, 200, 243, 280]) {
      audio.currentTime = t;
      await act(async () => new Promise((r) => setTimeout(r, 40)));
    }
    expect(said).toEqual(['Night Ferry: mix-out reached']);
    audio.currentTime = 121;
  });

  it('the element’s length arriving later draws the map as soon as it’s known (review N2)', async () => {
    const store = makeStore(undefined, { peaksFail: true });
    audio.duration = Number.NaN;
    try {
      await on(store);
      expect(screen.queryByRole('img', { name: /^Beat map/ })).toBeNull();
      // the metadata loads; nothing in the lane re-renders on its own
      audio.duration = 286;
      await act(async () => new Promise((r) => setTimeout(r, 60)));
      expect(screen.getByRole('img', { name: /^Beat map/ })).toBeInTheDocument();
    } finally {
      audio.duration = 286;
    }
  });

  it('peaks that fail and a track with no length: the player’s element gives the length (review L7)', async () => {
    const store = makeStore(undefined, { peaksFail: true });
    await on(store);
    expect(store.snapshot().a?.duration).toBeNull();
    expect(screen.getByRole('img', { name: /^Beat map/ })).toBeInTheDocument();
    expect(document.querySelector('[data-dj-line="a"]')).toHaveTextContent('bar 61 of 142');
  });

  it('a long file analysed in part: the ticks run on to its end, marked, and the line says so (review L6)', async () => {
    grids['2'] = apiGrid({
      track_id: '2',
      bars: 60,
      truncated: true,
      analysed_s: 121,
      mix_out: null,
    });
    const store = makeStore();
    await on(store);
    const map = screen.getByRole('img', {
      name: /the first 2:01 analysed, the grid carried on after it/,
    });
    expect(map.querySelectorAll('[data-phrase]').length).toBe(18);
    const beyond = map.querySelector<HTMLElement>('[data-dj-beyond]')!;
    expect(beyond.style.left).toBe(`${(121 / 286) * 100}%`);
    expect(document.querySelector('[data-dj-line="a"]')).toHaveTextContent(
      'past the analysed part (the first 2:01)',
    );
  });

  it('opened on a track without its grid: the waveform at once, Brief A’s bar and line, no map yet (37e)', async () => {
    grids['2'] = { track_id: '2', analyzed: false, reason: 'not_analyzed' };
    const store = makeStore();
    await on(store);
    const a = document.querySelector('[data-dj-lane="a"]')!;
    expect(a.querySelectorAll('rect')).toHaveLength(4);
    expect(a.querySelector('[data-dj-beat-map]')).toBeNull();
    await waitFor(() =>
      expect(a.querySelector('[data-analysis-line]')).toHaveTextContent(
        'Analysing Night Ferry · beat grid (5 of 6) · a few seconds',
      ),
    );
    expect(a).toHaveTextContent('the waveform is here now; the beat map arrives with the grid');
  });

  it('no steady beat: the reason where the map would be', async () => {
    grids['2'] = { track_id: '2', analyzed: false, reason: 'no_beat' };
    const store = makeStore();
    await on(store);
    expect(document.querySelector('[data-dj-lane-state="no-grid"]')).toHaveTextContent(
      'Night Ferry has no steady beat: Sync is off, blend by ear',
    );
  });
});

describe('lane B (37b, 37d)', () => {
  it('empty: dashed, "Drag a track here", and no Browse until step 3 registers it', async () => {
    const store = makeStore();
    await on(store);
    const b = screen.getByRole('group', { name: 'Deck B, empty: drag a track here' });
    expect(b).toHaveTextContent('Drag a track here');
    expect(b).toHaveTextContent(
      'It plays at Night Ferry’s tempo, on its beat, when you bring it in.',
    );
    expect(screen.queryByRole('button', { name: 'Browse…' })).toBeNull();
    expect(b).toHaveAttribute('tabindex', '0');
    const browse = vi.fn();
    act(() => store.setBrowseOpener(browse));
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    expect(browse).toHaveBeenCalledTimes(1);
    expect(b).toHaveTextContent('or press B');
    // Browse takes the lane's place in the focus order (37p)
    expect(b).toHaveAttribute('tabindex', '-1');
  });

  it('loaded: cued, shown with its waveform and data, not played', async () => {
    const store = makeStore();
    await on(store);
    await act(async () => {
      store.loadB({ id: '8', title: 'Harbour Lights', artist: 'Tidewater', inLibrary: true });
      await new Promise((r) => setTimeout(r, 10));
    });
    const b = screen.getByRole('group', {
      name: 'Deck B, Harbour Lights, cued',
      description: 'cued at bar 1 of 128 · mix-out from bar 121',
    });
    expect(b).toHaveTextContent('B · cued');
    expect(b).toHaveTextContent('0:01 · 4:46');
    expect(b.querySelector('[data-dj-line="b"]')).toHaveTextContent('cued at bar 1 of 128');
  });

  it('no grid: the reason, Browse another… (with Browse) and Remove', async () => {
    grids['8'] = { track_id: '8', analyzed: false, reason: 'no_beat' };
    const store = makeStore();
    store.setBrowseOpener(() => undefined);
    await on(store);
    await act(async () => {
      store.loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(document.querySelector('[data-dj-lane="b"]')).toHaveTextContent(
      'Harbour Lights has no steady beat: Sync is off, blend by ear',
    );
    expect(screen.getByRole('button', { name: 'Browse another…' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(store.snapshot().b).toBeNull();
    // the focus stays in the lane, not on the page (review L3)
    await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(document.activeElement).toBe(document.querySelector('[data-dj-lane="b"]'));
  });
});

describe('lane B is the `dj` drop target (37c, 37d; 436)', () => {
  const harbour: DragItem = {
    id: '8',
    title: 'Harbour Lights',
    key: '8A',
    bpm: 126,
    inLibrary: true,
    queue: { duration: 288 },
  };
  const drag = (items: DragItem[]) => ({
    items,
    source: { kind: 'tracks' as const, listId: 'tracks', indexes: [0] },
    via: 'mouse' as const,
  });

  it('one target of kind dj, not a list, saying its own reasons', async () => {
    const store = makeStore();
    await on(store);
    const t = getTarget(LANE_B_TARGET)!;
    expect(t.kind).toBe('dj');
    expect('rows' in t).toBe(false);
    expect(t.inlineReason).toBe(true);
    expect(t.accepts(drag([harbour]))).toEqual({ ok: true });
    expect(t.accepts(drag([{ ...harbour, id: '2', title: 'Night Ferry' }]))).toEqual({
      ok: false,
      reason: 'That’s the track that’s playing',
    });
    expect(t.accepts(drag([{ ...harbour, title: 'Low Tide', away: 'Music' }])).ok).toBe(false);
    expect(t.accepts(drag([{ ...harbour, inLibrary: false }])).ok).toBe(false);
  });

  it('a drop loads it into lane B, cued; its Undo empties the lane again', async () => {
    const store = makeStore();
    await on(store);
    const result = await act(async () => getTarget(LANE_B_TARGET)!.drop(drag([harbour]), null));
    expect(result?.words).toBe('Harbour Lights loaded as B, cued');
    expect(store.snapshot().b?.track.id).toBe('8');
    act(() => void result?.undo?.());
    expect(store.snapshot().b).toBeNull();
  });

  it('a drop says it once (its toast), and an Undo that can’t work says why (review L8)', async () => {
    const said: string[] = [];
    const store = makeStore((w) => said.push(w));
    await on(store);
    said.length = 0;
    const first = await act(async () => getTarget(LANE_B_TARGET)!.drop(drag([harbour]), null));
    expect(said).toEqual([]);
    const second = await act(async () =>
      getTarget(LANE_B_TARGET)!.drop(drag([{ ...harbour, id: '9', title: 'Low Orbit' }]), null),
    );
    // the player moved on to Harbour Lights: putting it back in B can't work
    (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
      state: () => ({ track: { ...FERRY, id: '8', title: 'Harbour Lights' }, kind: 'library' }),
      audio: () => audio,
    };
    expect(() => second!.undo!()).toThrow('Can’t undo: Harbour Lights is playing now');
    act(() => void store.back());
    expect(() => first!.undo!()).toThrow('Can’t undo: DJ mode is off');
  });

  it('gone with DJ mode: no lane, no target', async () => {
    const store = makeStore();
    await on(store);
    act(() => void store.back());
    expect(getTarget(LANE_B_TARGET)).toBeUndefined();
  });

  function liftOver(item: DragItem, laneB: HTMLElement) {
    document.body.insertAdjacentHTML('beforeend', '<span id="grip"></span>');
    document.elementFromPoint = (() => laneB) as typeof document.elementFromPoint;
    act(() => {
      pointerDown(
        { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 5, clientY: 5 },
        document.getElementById('grip')!,
        () => ({ items: [item], source: { kind: 'tracks', listId: 'tracks', indexes: [0] } }),
      );
      // the first move lifts it (4px with the button held); the next finds the lane
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 40 }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, clientX: 60, clientY: 60 }),
      );
    });
  }

  it('a row over the lane: accent frame, "Drop to load …" and the step it would make (37c)', async () => {
    const store = makeStore();
    await on(store);
    const b = document.querySelector<HTMLElement>('[data-dj-lane="b"]')!;
    liftOver(harbour, b);
    await waitFor(() => expect(b).toHaveAttribute('data-drag', 'over'));
    expect(b.querySelector('[data-dj-drop-line]')).toHaveTextContent('Drop to load Harbour Lights');
    await waitFor(() => expect(b).toHaveTextContent('Same key · +1.6% · has its beat grid'));
    // letting go loads it
    await act(async () => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 1, clientX: 40, clientY: 40 }),
      );
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(store.snapshot().b?.track.title).toBe('Harbour Lights');
  });

  it('a drop it won’t take: amber, the reason in the drop line, and letting go does nothing (37d)', async () => {
    const store = makeStore();
    await on(store);
    const b = document.querySelector<HTMLElement>('[data-dj-lane="b"]')!;
    liftOver({ ...harbour, id: '2', title: 'Night Ferry' }, b);
    await waitFor(() => expect(b).toHaveAttribute('data-drag', 'invalid'));
    expect(b.querySelector('[data-dj-drop-line]')).toHaveTextContent(
      'That’s the track that’s playing',
    );
    // the lane says it, so no amber note floats over it too
    expect(document.querySelector('[data-dnd-note]')).toBeNull();
    await act(async () => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 1, clientX: 40, clientY: 40 }),
      );
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(store.snapshot().b).toBeNull();
  });
});
