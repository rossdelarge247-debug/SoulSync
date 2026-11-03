/**
 * Hand over in the page (step 4: 37i, 37p): the button waits for B to play,
 * then B becomes the player's track; lane A shows it, lane B empties with
 * the notice and its Undo (10 s), the focus goes to lane B's Browse; Undo
 * puts A back with B cued in its lane again.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutputState } from './dj-outputs';

import { rig, type Rig } from './dj-mix.fixtures';
import { DjModeStage } from './dj-mode-stage';
import { DjModeStore } from './dj-mode-store';
import { apiGrid } from './dj-mode.fixtures';
import { DjOutputs } from './dj-outputs-host';

const FERRY = {
  id: '2',
  title: 'Night Ferry',
  artist: 'Tidewater',
  is_library: true,
  filename: '/m/2.flac',
};
const HARBOUR = {
  id: '8',
  title: 'Harbour Lights',
  artist: 'Marram',
  is_library: true,
  filename: '/m/8.flac',
};

let r: Rig;
let store: DjModeStore;
let outputs: DjOutputs;
let said: string[];
let current: Record<string, unknown>;
let queue: Record<string, unknown>[];
let index: number;

function makeStore(): DjModeStore {
  return new DjModeStore({
    fetch: async (url: string) => {
      if (url.endsWith('/peaks'))
        return new Response(JSON.stringify({ peaks: [0.2, 0.9], duration_s: 286 }));
      const m = /\/api\/library\/dj\/grid\/([^/]+)$/.exec(url);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        const g =
          id === '2'
            ? apiGrid({ track_id: '2' })
            : apiGrid({
                track_id: id,
                bpm: 125,
                grid: {
                  kind: 'constant',
                  first_beat: 0.5,
                  period: 0.48,
                  beats: null,
                  confidence: 0.9,
                  confident: true,
                },
                downbeats: { first: 0.5, beat_index: 0, beats_per_bar: 4, meter: '4/4' },
                mix_in: { start_bar: 0, end_bar: 16, start: 0.5, end: 31 },
              });
        return new Response(JSON.stringify({ success: true, grid: g }));
      }
      // B's player record (a Browse row doesn't carry it)
      if (url.endsWith('/api/library/dj/track/8'))
        return new Response(
          JSON.stringify({
            success: true,
            track: {
              id: '8',
              title: 'Harbour Lights',
              artist_name: 'Marram',
              album_title: 'Shore',
              file_path: '/m/8.flac',
              duration_ms: 288000,
              file_missing: false,
            },
          }),
        );
      if (/\/api\/library\/dj\/cues\//.test(url)) return new Response(JSON.stringify({ cues: [] }));
      return new Response('{}', { status: 404 });
    },
    analyse: () => undefined,
    phone: () => false,
    say: (w) => said.push(w),
  });
}

function makeOutputs(): DjOutputs {
  return new DjOutputs(
    {
      enumerate: async () => [],
      onDeviceChange: () => () => undefined,
      canDevice: false,
      speakersId: () => '',
      storage: null,
      tap: () => ({}) as AudioNode,
      makeRouter: () => ({
        route: async (_s: OutputState) => true,
        set: () => undefined,
        dispose: () => undefined,
        isMuted: false,
      }),
    },
    r.session,
    (w) => store.announce(w),
  );
}

async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await r.advance(ms / 1000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  said = [];
  current = FERRY;
  queue = [
    { ...FERRY, file_path: '/m/2.flac' },
    { id: '5', title: 'Static Bloom' },
  ];
  index = 0;
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  r = rig(vi, {
    say: (w) => store.announce(w),
    player: {
      audio: () => r.el as never,
      state: () => ({ ...r.player, index, queue }),
      insertNext: (t) => {
        queue.splice(index + 1, 0, t);
        return index + 1;
      },
      playIndex: async (i, options) => {
        r.el.pause();
        // the player says what it plays at once (setTrackInfo), then loads it
        current = i === 0 ? FERRY : HARBOUR;
        index = i;
        store.refresh();
        await new Promise((res) => setTimeout(res, 150));
        if (options.handoff) r.el.currentTime = options.handoff.currentTime + 0.15;
        r.el.paused = false;
        options.handoff?.pause();
        return { status: 'played' };
      },
      remove: (i) => {
        queue.splice(i, 1);
      },
    },
  });
  (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
    state: () => ({ track: current, kind: 'library', volume: 70 }),
    audio: () => r.el,
  };
  store = makeStore();
  outputs = makeOutputs();
  store.setOn(true);
  said.length = 0;
});

afterEach(() => {
  cleanup();
  r.session.dispose();
  store.dispose();
  vi.useRealTimers();
  delete (window as unknown as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
});

async function playing(): Promise<void> {
  render(<DjModeStage store={store} session={r.session} outputs={outputs} />);
  await flush();
  act(() => {
    store.loadB({ id: '8', title: 'Harbour Lights', artist: 'Marram', image: null, duration: 288 });
  });
  await flush(50);
  act(() => {
    store.playB();
  });
  await flush(3000);
}

describe('Hand over in the page (37i)', () => {
  it('enabled once B plays; H and the button hand over; the lanes follow; the notice and its Undo; focus to Browse', async () => {
    await playing();
    const btn = screen.getByRole('button', { name: 'Hand over to B' });
    expect(btn).toHaveAttribute('aria-disabled', 'false');
    expect(btn.title).toBe('Hand over: Harbour Lights becomes the player’s track (H)');
    act(() => {
      expect(store.handOver()).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'Handing over…' })).toBeTruthy();
    expect(store.snapshot().mix.phase).toBe('handing');
    // Esc mid-hand-over isn't Back
    act(() => {
      expect(store.escape()).toBe(true);
    });
    expect(store.snapshot().on).toBe(true);
    await flush(2500);
    // lane A is Harbour Lights now, lane B empty with the notice
    expect(store.snapshot().a?.track.id).toBe('8');
    expect(store.snapshot().b).toBeNull();
    const notice = document.querySelector<HTMLElement>('[data-dj-handed]')!;
    expect(notice).toHaveTextContent(
      'Harbour Lights is the player’s track now, at its own tempo. Up next follows it.',
    );
    expect(document.activeElement).toBe(document.querySelector('[data-dj-browse-b]'));
    expect(said).toContain('Handed over to Harbour Lights');
    expect(queue.map((t) => t.id)).toEqual(['2', '8', '5']);
    // Undo: A back, B cued in its lane again, B's row out of the queue
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await flush(400);
    expect(current).toBe(FERRY);
    expect(store.snapshot().a?.track.id).toBe('2');
    expect(store.snapshot().b?.track.id).toBe('8');
    expect(queue.map((t) => t.id)).toEqual(['2', '5']);
    expect(said.at(-1)).toBe('Undone: Night Ferry is back · Harbour Lights cued');
    expect(document.querySelector('[data-dj-handed]')).toBeNull();
  });

  it('the notice goes after 10 s, with its Undo', async () => {
    await playing();
    act(() => {
      store.handOver();
    });
    await flush(2500);
    expect(document.querySelector('[data-dj-handed]')).not.toBeNull();
    await flush(10_500);
    expect(document.querySelector('[data-dj-handed]')).toBeNull();
    expect(await store.undoHandOver()).toBe(false);
  });
});
