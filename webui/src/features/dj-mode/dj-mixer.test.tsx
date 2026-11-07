/**
 * The mixer (37g, 37h) in the page: it slides up once B has a track (in
 * place with Reduce motion), every control a real range input with its value
 * and aria-valuetext, the focus order, the keys (⇧ arrows, K, ⇧P), Play B,
 * Sync and Hand over, Back and Esc mid-blend through the store, and the
 * header's line and lane B following the mix.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KILL_DB } from '@/features/engine/score';

import { laneA, rig, type Rig } from './dj-mix.fixtures';
import { DjModeStage } from './dj-mode-stage';
import { DjModeStore } from './dj-mode-store';
import { apiGrid } from './dj-mode.fixtures';
import { headerLine } from './dj-mode.logic';
import { DjPrefsStore } from './dj-prefs';

const FERRY = {
  id: '2',
  title: 'Night Ferry',
  artist: 'Tidewater',
  is_library: true,
  filename: '/m/2.flac',
};
let r: Rig;
let said: string[];
let store: DjModeStore;
let reduce = false;

function makeStore(): DjModeStore {
  return new DjModeStore({
    prefs: new DjPrefsStore(null),
    fetch: async (url: string, init?: RequestInit) => {
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
      if (url.endsWith('/api/library/dj/tracks')) {
        const id = (JSON.parse(init?.body as string) as { track_ids: string[] }).track_ids[0]!;
        return new Response(
          JSON.stringify({
            tracks: { [id]: id === '2' ? { bpm: 120, key: '8A' } : { bpm: 125, key: '8A' } },
          }),
        );
      }
      return new Response('{}', { status: 404 });
    },
    analyse: () => undefined,
    phone: () => false,
    say: (w) => said.push(w),
  });
}

async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await r.advance(ms / 1000);
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  said = [];
  reduce = false;
  window.matchMedia = ((q: string) => ({
    matches: q.includes('reduced-motion') ? reduce : false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  r = rig(vi, { say: (w) => store.announce(w) });
  (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
    state: () => ({ track: FERRY, kind: 'library', volume: 70 }),
    audio: () => r.el,
  };
  store = makeStore();
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

async function withB(): Promise<void> {
  render(<DjModeStage store={store} session={r.session} />);
  await flush();
  act(() => {
    store.loadB({ id: '8', title: 'Harbour Lights', artist: 'Marram', image: null, duration: 288 });
  });
  await flush(50);
}

describe('the mixer (37g)', () => {
  it('isn’t there until B has a track, then slides up (200 ms)', async () => {
    render(<DjModeStage store={store} session={r.session} />);
    await flush();
    expect(document.querySelector('[data-dj-mixer]')).toBeNull();
    act(() => {
      store.loadB({
        id: '8',
        title: 'Harbour Lights',
        artist: 'Marram',
        image: null,
        duration: 288,
      });
    });
    await flush(50);
    const mixer = document.querySelector<HTMLElement>('[data-dj-mixer]')!;
    expect(mixer).not.toBeNull();
    expect(mixer.dataset.motion).toBe('slide');
    expect(mixer.dataset.phase).toBe('ready');
  });

  it('with Reduce motion it simply appears', async () => {
    reduce = true;
    await withB();
    expect(document.querySelector<HTMLElement>('[data-dj-mixer]')!.dataset.motion).toBe('reduce');
  });

  it('every control is a range input with its value in words; nothing says AUTO', async () => {
    await withB();
    const sliders = screen.getAllByRole('slider');
    expect(sliders.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Crossfader',
      'Echo · Send A',
      'Time',
      'Feedback',
      'Deck A Volume',
      'Deck A Hi',
      'Deck A Mid',
      'Deck A Low',
      'Deck A Filter',
      'Deck A Tempo',
      'Deck B Volume',
      'Deck B Hi',
      'Deck B Mid',
      'Deck B Low',
      'Deck B Filter',
      'Deck B Tempo',
    ]);
    for (const s of sliders) {
      expect(s.tagName).toBe('INPUT');
      expect((s as HTMLInputElement).type).toBe('range');
      expect(s.getAttribute('aria-valuetext')).toBeTruthy();
    }
    expect(screen.getByRole('slider', { name: 'Crossfader' })).toHaveAttribute(
      'aria-valuetext',
      'A only',
    );
    expect(screen.getByRole('slider', { name: 'Time' })).toHaveAttribute('aria-valuetext', '3/8');
    expect(document.querySelector('[data-dj-mixer]')!.textContent).not.toMatch(/AUTO/);
  });

  it('the focus order: Play B → Sync → Quantize → Hand over → crossfader → echo → deck A → deck B', async () => {
    await withB();
    const mixer = document.querySelector('[data-dj-mixer]')!;
    const order = [...mixer.querySelectorAll<HTMLElement>('button, input')].map(
      (el) => el.getAttribute('aria-label') ?? el.textContent!.trim(),
    );
    expect(order.slice(0, 8)).toEqual([
      'Play B',
      'Sync',
      'Quantize',
      'Hand over to B',
      'Crossfader',
      'Echo · Send A',
      'Time',
      'Feedback',
    ]);
    expect(order.indexOf('Deck A Volume')).toBeLessThan(order.indexOf('Deck B Volume'));
    expect(order).toContain('Kill deck A Low');
  });

  it('moving a control moves the engine; K kills the focused band; ⇧ arrows are 10%', async () => {
    await withB();
    const low = screen.getByRole('slider', { name: 'Deck A Low' });
    fireEvent.change(low, { target: { value: '-6' } });
    await flush();
    expect(r.engine.value('A.low')).toBeCloseTo(-6);
    expect(low).toHaveAttribute('aria-valuetext', '−6 dB');
    fireEvent.keyDown(low, { key: 'k' });
    await flush();
    expect(r.engine.value('A.low')).toBeCloseTo(KILL_DB);
    expect(low).toHaveAttribute('aria-valuetext', 'kill');
    expect(screen.getByRole('button', { name: 'Kill deck A Low' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(said).toContain('Deck A Low killed');
    const xf = screen.getByRole('slider', { name: 'Crossfader' });
    fireEvent.keyDown(xf, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(xf, { key: 'ArrowRight', shiftKey: true });
    await flush();
    expect(xf).toHaveAttribute('aria-valuetext', 'B 20% · A 80%');
    expect(r.engine.value('B.xf')).toBeCloseTo(Math.sin((0.2 * Math.PI) / 2), 4);
    const filter = screen.getByRole('slider', { name: 'Deck B Filter' });
    fireEvent.change(filter, { target: { value: '-50' } });
    await flush();
    expect(r.engine.value('B.lp')).toBeLessThan(5000);
    const send = screen.getByRole('slider', { name: 'Echo · Send A' });
    fireEvent.change(send, { target: { value: '40' } });
    await flush();
    expect(r.engine.value('A.echoSend')).toBeCloseTo(0.4);
  });

  it('Hand over waits for B to play, and says why when pressed (step 4)', async () => {
    await withB();
    const btn = screen.getByRole('button', { name: 'Hand over to B' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('aria-keyshortcuts', 'H');
    expect(btn.getAttribute('title')).toMatch(/^Hand over once .* is playing \(Play B\)$/);
    fireEvent.click(btn);
    expect(said.at(-1)).toMatch(/^Hand over once .* is playing \(Play B\)$/);
  });

  it('Sync is on by default; pressed off and on, it says so once each', async () => {
    await withB();
    const sync = screen.getByRole('button', { name: 'Sync' });
    expect(sync).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(sync);
    expect(sync).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(sync);
    expect(said.filter((w) => w.startsWith('Sync'))).toEqual(['Sync off', 'Sync on']);
  });
});

describe('Play B and the blend (37g, 37h)', () => {
  it('Play B (and ⇧P) starts B on A’s next bar; the header, lane B and the button follow', async () => {
    await withB();
    expect(document.getElementById('np-v2-visuals-dj-line')).toBeNull();
    expect(
      headerLine({
        a: 'Night Ferry',
        aPhase: 'ready',
        b: 'Harbour Lights',
        bPhase: 'ready',
        browse: true,
        mix: store.snapshot().mix.phase,
      }),
    ).toBe('Harbour Lights cued · Play B, then move the fader');
    expect(screen.getByText('B · cued · plays on A’s next bar')).toBeTruthy();
    // ⇧P from a slider
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Crossfader' }), {
      key: 'P',
      shiftKey: true,
    });
    expect(store.snapshot().mix.phase).toBe('starting');
    expect(store.blending()).toBe(true);
    // review L5: a second press before B comes in doesn't pause it
    expect(store.playB()).toBe(true);
    expect(store.snapshot().mix.phase).toBe('starting');
    expect(screen.getByRole('button', { name: /Pause B|Play B/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await flush(2500);
    expect(store.snapshot().mix.phase).toBe('playing');
    expect(screen.getByRole('button', { name: /Pause B/ })).toBeTruthy();
    expect(screen.getByText('B · playing · on A’s beat')).toBeTruthy();
    expect(screen.getByRole('group', { name: /Deck B, Harbour Lights, playing/ })).toBeTruthy();
    // 37g: B's tempo as Sync plays it
    expect(document.querySelector('[data-deck="b"] [class*="bpm"]')!.textContent).toMatch(
      /120\.00 \(−4\.00%\)/,
    );
    expect(said).toContain('Harbour Lights playing, on Night Ferry’s beat');
  });

  it('the thin cyan line over B is its 3-minute window from its mix-in (424, 434)', async () => {
    await withB();
    // drawn at whole track (zoomed, the time left counts to it, S4)
    act(() => store.zoom('b', 'whole'));
    const line = document.querySelector<HTMLElement>('[data-dj-window]')!;
    expect(line).not.toBeNull();
    expect(Number.parseFloat(line.style.left)).toBeCloseTo(0, 1);
    expect(Number.parseFloat(line.style.width)).toBeCloseTo((180 / 286) * 100, 1);
  });

  it('Esc mid-blend only says how to end it; Back brings A back over a bar, then DJ mode is off', async () => {
    await withB();
    act(() => {
      store.playB();
    });
    await flush(2500);
    said.length = 0;
    expect(store.escape()).toBe(true);
    expect(said).toEqual(['Blending · Back ends it over a bar']);
    expect(store.snapshot().on).toBe(true);
    // B can't be swapped or Browsed for under a blend
    expect(
      store.loadB({ id: '9', title: 'Copper Sky', artist: '', image: null, duration: 300 }),
    ).toBe(false);
    act(() => {
      store.back();
    });
    expect(store.snapshot().mix.phase).toBe('backing');
    expect(store.snapshot().on).toBe(true);
    await flush(2200);
    expect(store.snapshot().on).toBe(false);
    expect(r.el.muted).toBe(false);
    expect(said).toEqual([
      'Blending · Back ends it over a bar',
      'Bringing Night Ferry back over a bar',
      'DJ mode off',
    ]);
  });

  it('Esc with B cued is Back at once; closing the overlay mid-blend keeps the blend going (37j)', async () => {
    await withB();
    expect(store.escape()).toBe(true);
    expect(store.snapshot().on).toBe(false);
    cleanup();
    store.setOn(true);
    await withB();
    act(() => {
      store.playB();
    });
    await flush(1000);
    expect(r.el.muted).toBe(true);
    act(() => {
      store.setOpen(true);
      store.setOpen(false);
    });
    expect(store.snapshot().on).toBe(true);
    expect(r.session.blending).toBe(true);
    expect(r.el.muted).toBe(true);
    // D mid-blend doesn't turn it off (37p): Back ends a blend, over a bar
    act(() => {
      expect(store.toggle()).toBe(true);
    });
    expect(store.snapshot().on).toBe(true);
    expect(said.at(-1)).toBe('Blending · Back ends it over a bar');
  });

  it('A moves onto its deck and back without the player’s position moving', async () => {
    await withB();
    const before = r.el.currentTime;
    act(() => {
      store.playB();
    });
    await flush(3000);
    act(() => {
      store.back();
    });
    await flush(2300);
    // the element ran on in time: only the clock moved it, nothing sought it
    expect(r.el.currentTime).toBeCloseTo(before + 5.3, 1);
    expect(r.engine.port.maps.A[0]!.p).toBeCloseTo(before + 0.12, 1);
    expect(laneA().id).toBe('2');
  });
});
