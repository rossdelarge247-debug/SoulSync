/**
 * The deck controls in the page (3b: 37g, 37h, 37m, 37s, 37r): six vertical
 * faders a deck with Tempo and its range menu (B's "set by Sync"), the lane
 * strip (Headphones, cues 1–4, Key lock), the zoom pill, cue placing on the
 * waveform and Esc clearing a pick, the lane keys, the Monitor block and the
 * one-output fallback.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutputDevice } from '@/shell/player-output';

import type { OutputState } from './dj-outputs';

import { rig, type Rig } from './dj-mix.fixtures';
import { DjModeStage } from './dj-mode-stage';
import { DjModeStore } from './dj-mode-store';
import { apiGrid } from './dj-mode.fixtures';
import { DjOutputs } from './dj-outputs-host';

let outputs: DjOutputs;
let devices: OutputDevice[];
let cuesPut: unknown[];
/** A's grid can't be had (M4) */
let noGridA = false;
/** what the page's player was told (A's transport, step 4b) */
let playerCalls: string[] = [];
/** the server refuses the cues' save (L1) */
let refuseCues = false;

function makeOutputs(): DjOutputs {
  return new DjOutputs(
    {
      enumerate: async () =>
        devices.map(
          (d) =>
            ({
              deviceId: d.id,
              label: d.label,
              kind: 'audiooutput',
              groupId: d.id,
            }) as MediaDeviceInfo,
        ),
      onDeviceChange: () => () => undefined,
      canDevice: true,
      speakersId: () => 'b1',
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
    fetch: async (url: string, init?: RequestInit) => {
      if (url.endsWith('/peaks'))
        return new Response(JSON.stringify({ peaks: [0.2, 0.9], duration_s: 286 }));
      const m = /\/api\/library\/dj\/grid\/([^/]+)$/.exec(url);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        if (id === '2' && noGridA) return new Response('{}', { status: 404 });
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
      if (/\/api\/library\/dj\/cues\//.test(url)) {
        if (init?.method === 'PUT') {
          cuesPut.push(JSON.parse(init.body as string));
          return new Response('{}', { status: refuseCues ? 400 : 200 });
        }
        return new Response(
          JSON.stringify({ cues: url.endsWith('/8') ? [{ slot: 2, bar: 4, seconds: 8.18 }] : [] }),
        );
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
  devices = [
    { id: 'b1', label: 'Built-in Output' },
    { id: 's2', label: 'Scarlett 2i2' },
  ];
  cuesPut = [];
  noGridA = false;
  refuseCues = false;
  said = [];
  reduce = false;
  window.matchMedia = ((q: string) => ({
    matches: q.includes('reduced-motion') ? reduce : false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  r = rig(vi, { say: (w) => store.announce(w) });
  playerCalls = [];
  (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
    state: () => ({ track: FERRY, kind: 'library', volume: 70 }),
    audio: () => r.el,
    toggle: () => {
      playerCalls.push(r.el.paused ? 'play' : 'pause');
      r.el.paused = !r.el.paused;
    },
    seek: (t: number) => {
      playerCalls.push(`seek ${t}`);
      r.el.currentTime = t;
    },
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

async function withB(): Promise<void> {
  render(<DjModeStage store={store} session={r.session} outputs={outputs} />);
  await flush();
  act(() => {
    store.loadB({ id: '8', title: 'Harbour Lights', artist: 'Marram', image: null, duration: 288 });
  });
  await flush(50);
}

describe('the decks as vertical faders (37g)', () => {
  it('six a deck, Volume · Hi · Mid · Low · Filter · Tempo, vertical, KILL under the value', async () => {
    await withB();
    const deck = screen.getByRole('group', { name: 'Deck A' });
    expect(deck.dataset.layout).toBe('faders');
    const sliders = within(deck).getAllByRole('slider');
    expect(sliders.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Deck A Volume',
      'Deck A Hi',
      'Deck A Mid',
      'Deck A Low',
      'Deck A Filter',
      'Deck A Tempo',
    ]);
    for (const s of sliders) expect(s).toHaveAttribute('aria-orientation', 'vertical');
    const low = deck.querySelector('[data-control="low"]')!;
    const kids = [...low.children].map((c) => c.tagName);
    expect(kids.slice(-2)).toEqual(['OUTPUT', 'BUTTON']);
  });

  it('Tempo: its range menu (±6/8/10/16 with BPM spans at A’s tempo); A’s waits for its deck', async () => {
    await withB();
    const a = screen.getByRole('slider', { name: 'Deck A Tempo' });
    expect(a).toBeDisabled();
    expect(a.closest('[data-control]')!.getAttribute('title')).toMatch(/once A is on its deck/);
    fireEvent.click(screen.getByRole('button', { name: 'Deck B tempo range, ±8%' }));
    const menu = screen.getByRole('menu', { name: 'Deck B tempo range' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual([
      '±6%112.8–127.2 BPM',
      '±8%110.4–129.6 BPM',
      '±10%108.0–132.0 BPM',
      '±16%100.8–139.2 BPM',
    ]);
    expect(items[1]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(items[3]!);
    expect(screen.queryByRole('menu')).toBeNull();
    const b = screen.getByRole('slider', { name: 'Deck B Tempo' });
    expect(b).toHaveAttribute('max', '16');
  });

  it('the overlay’s Esc closes Tempo’s menu (and DJ outputs) before anything else', async () => {
    await withB();
    fireEvent.click(screen.getByRole('button', { name: 'Deck B tempo range, ±8%' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    act(() => {
      expect(store.escape()).toBe(true);
    });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(store.snapshot().on).toBe(true);
  });

  it('B’s Tempo reads "set by Sync"; moving it turns Sync off', async () => {
    await withB();
    const b = screen.getByRole('slider', { name: 'Deck B Tempo' });
    const box = b.closest('[data-control]') as HTMLElement;
    expect(box.dataset.tone).toBe('sync');
    expect(box.title).toBe('Set by Sync · moving it turns Sync off');
    expect(b).toHaveAttribute('aria-valuetext', '−4.0%');
    fireEvent.change(b, { target: { value: '1.5' } });
    expect(screen.getByRole('button', { name: 'Sync' })).toHaveAttribute('aria-pressed', 'false');
    expect(b).toHaveAttribute('aria-valuetext', '+1.5%');
    // double-click (or Backspace): back to 0
    fireEvent.keyDown(b, { key: 'Backspace' });
    expect(b).toHaveAttribute('aria-valuetext', '0.0%');
  });
});

describe('the lane strip, cues and zoom (37g, 37s)', () => {
  it('each lane: Headphones (B on from the start), cues 1–4 with B’s stored one, Key lock on', async () => {
    await withB();
    const stripB = document.querySelector<HTMLElement>('[data-dj-strip="b"]')!;
    expect(within(stripB).getByRole('button', { name: /In the headphones/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(stripB).getByRole('button', { name: 'Cue 2, bar 5' })).toHaveTextContent('2 · 5');
    expect(within(stripB).getByRole('button', { name: 'Cue 1, empty' })).toHaveTextContent('1');
    expect(within(stripB).getByRole('button', { name: /Key lock/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // the strip comes after the lane's line (focus: lane → its strip → the next lane)
    const laneB = document.querySelector('[data-dj-lane="b"]')!;
    expect(laneB.lastElementChild).toContainElement(stripB);
  });

  it('pick a cue, click the waveform: placed on the beat and saved; Esc clears the pick before Back', async () => {
    await withB();
    fireEvent.click(document.querySelector('[data-dj-strip="b"] [data-dj-cue="3"]')!);
    expect(store.snapshot().pick.b).toBe(3);
    expect(said.at(-1)).toBe('Cue 3 on deck B picked: click the waveform to place it');
    const wave = document.querySelector<HTMLElement>('[data-dj-wave="b"]')!;
    wave.getBoundingClientRect = () =>
      ({
        left: 0,
        width: 286,
        top: 0,
        height: 50,
        right: 286,
        bottom: 50,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    fireEvent.pointerMove(wave, { clientX: 100 });
    expect(wave.textContent).toMatch(/Cue 3 · bar \d+ · click to place/);
    fireEvent.click(wave, { clientX: 100 });
    const cue = store.snapshot().b!.cues[2]!;
    expect(cue.slot).toBe(3);
    // on B's beat (0.5 + n × 0.48)
    expect(
      Math.abs((cue.seconds - 0.5) / 0.48 - Math.round((cue.seconds - 0.5) / 0.48)),
    ).toBeLessThan(1e-6);
    await flush(700);
    expect(cuesPut.at(-1)).toEqual({ cues: [store.snapshot().b!.cues[1], cue] });
    expect(store.escape()).toBe(true);
    expect(store.snapshot().pick.b).toBeNull();
    expect(store.snapshot().on).toBe(true);
  });

  it('a refused save keeps the cues placed and says so once (L1)', async () => {
    refuseCues = true;
    await withB();
    for (const slot of [1, 3]) {
      act(() => {
        store.pressCue('b', slot);
        store.placeCue('b', 20 + slot);
      });
      await flush(700);
    }
    expect(cuesPut).toHaveLength(2);
    expect(
      store
        .snapshot()
        .b!.cues.filter(Boolean)
        .map((c) => c!.slot),
    ).toEqual([1, 2, 3]);
    expect(said.filter((w) => w.startsWith('The cues couldn’t be saved'))).toEqual([
      'The cues couldn’t be saved: they’re kept here until the page is closed',
    ]);
  });

  it('a set cue pressed on cued B moves where Play B starts', async () => {
    await withB();
    fireEvent.click(document.querySelector('[data-dj-strip="b"] [data-dj-cue="2"]')!);
    expect(store.snapshot().b!.cue).toBeCloseTo(8.18, 2);
    expect(said.at(-1)).toBe('Deck B to cue 2, bar 5');
  });

  it('the zoom pill: five levels, the lane drawn zoomed, Z back to whole', async () => {
    await withB();
    const pill = document.querySelector<HTMLElement>('[data-dj-zoom="b"]')!;
    expect(pill).toHaveTextContent('whole track');
    const plus = within(pill).getByRole('button', { name: 'Zoom in deck B' });
    fireEvent.click(plus);
    fireEvent.click(plus);
    expect(pill).toHaveTextContent('16 bars');
    expect(said.at(-1)).toBe('Deck B: 16 bars');
    const laneB = document.querySelector('[data-dj-lane="b"]')!;
    expect(laneB.querySelector('[data-zoomed]')).not.toBeNull();
    expect(laneB.querySelector('[data-dj-outline]')).not.toBeNull();
    // the window line hides while zoomed
    expect(laneB.querySelector('[data-dj-window]')).toBeNull();
    (laneB as HTMLElement).focus();
    act(() => {
      expect(store.laneKey('Z', 'b')).toBe(true);
    });
    expect(pill).toHaveTextContent('whole track');
  });
});

describe('lane A without a grid (M4)', () => {
  it('zoom falls back to 2 s a bar, and a cue is placed and drawn without the beat map', async () => {
    store.dispose();
    noGridA = true;
    store = makeStore();
    outputs = makeOutputs();
    store.setOn(true);
    await withB();
    expect(store.snapshot().a!.phase).toBe('no_grid');
    const laneA = document.querySelector<HTMLElement>('[data-dj-lane="a"]')!;
    act(() => {
      store.zoom('a', 1);
    });
    const body = laneA.querySelector<HTMLElement>('[data-zoomed]')!;
    // 64 bars at 2 s a bar is 128 s of the 286: the layer is 286/128 lanes wide
    expect(Number(body.style.getPropertyValue('--zoom-scale'))).toBeCloseTo(286 / 128, 3);
    act(() => {
      store.zoom('a', -1);
    });
    fireEvent.click(laneA.querySelector('[data-dj-strip="a"] [data-dj-cue="1"]')!);
    const wave = laneA.querySelector<HTMLElement>('[data-dj-wave="a"]')!;
    wave.getBoundingClientRect = () =>
      ({
        left: 0,
        width: 286,
        top: 0,
        height: 50,
        right: 286,
        bottom: 50,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    fireEvent.click(wave, { clientX: 60 });
    const cue = store.snapshot().a!.cues[0]!;
    expect(cue).toEqual({ slot: 1, bar: null, seconds: 60 });
    expect(laneA.querySelector('[data-dj-beat-map]')).toBeNull();
    const band = laneA.querySelector('[data-dj-cue-band]')!;
    expect(band.querySelector('[data-dj-cue-disc="1"]')).not.toBeNull();
  });
});

describe('the lane keys (37p): only with a lane focused, or B loaded', () => {
  it('M and L on B when nothing is focused; Z and − + need a focused lane', async () => {
    await withB();
    act(() => undefined);
    expect(store.laneKey('M', null)).toBe(true);
    expect(r.session.snapshot().decks.B.phones).toBe(false);
    expect(store.laneKey('L', 'a')).toBe(true);
    expect(r.session.snapshot().decks.A.keyLock).toBe(false);
    expect(store.laneKey('Z', null)).toBe(false);
    expect(store.laneKey('+', 'a')).toBe(true);
    expect(store.snapshot().zoom.a).toBe(64);
    store.removeB();
    // no B and nothing focused: M is the player's Mute again
    expect(store.laneKey('M', null)).toBe(false);
  });
});

describe('the Monitor block and the outputs (37g, 37r)', () => {
  it('two outputs: the device line, Outputs…, Cue mix and Cue volume as real sliders', async () => {
    await withB();
    await flush(50);
    const m = document.querySelector<HTMLElement>('[data-dj-monitor]')!;
    expect(m).toHaveTextContent('Scarlett 2i2 · speakers on Built-in Output');
    const mix = within(m).getByRole('slider', { name: 'Cue mix' });
    expect(mix).toHaveAttribute('aria-valuetext', 'Cue only · B alone');
    fireEvent.change(mix, { target: { value: '50' } });
    expect(mix).toHaveAttribute('aria-valuetext', 'Half cue, half speakers');
    expect(within(m).getByRole('slider', { name: 'Cue volume' })).toHaveAttribute(
      'aria-valuetext',
      '−6 dB',
    );
    fireEvent.click(within(m).getByRole('button', { name: 'Outputs…' }));
    const dialog = screen.getByRole('dialog', { name: 'DJ outputs' });
    expect(within(dialog).getByRole('combobox')).toHaveValue('s2');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'DJ outputs' })).toBeNull();
  });

  it('one output: no Monitor block; Headphones dimmed with why', async () => {
    devices = [{ id: 'b1', label: 'Built-in Output' }];
    await withB();
    await flush(50);
    expect(document.querySelector('[data-dj-monitor]')).toBeNull();
    const phones = document.querySelector<HTMLElement>(
      '[data-dj-strip="b"] button[aria-keyshortcuts="M"]',
    )!;
    expect(phones.dataset.unavailable).toBe('');
    expect(phones.title).toMatch(/No headphones output · Outputs…/);
  });
});

describe('the transport (step 4b): Play/Pause and CUE a deck, a CDJ’s', () => {
  it('each lane has Play and CUE before Headphones', async () => {
    await withB();
    // A is playing on the player; B is cued
    for (const [d, play] of [
      ['a', 'pause'],
      ['b', 'play'],
    ] as const) {
      const strip = document.querySelector<HTMLElement>(`[data-dj-strip="${d}"]`)!;
      const buttons = within(strip).getAllByRole('button');
      expect(buttons[0]).toHaveAttribute('aria-label', `Deck ${d.toUpperCase()} ${play}`);
      expect(buttons[1]).toHaveAccessibleName(`Deck ${d.toUpperCase()} cue`);
      expect(buttons[2]).toHaveAttribute('aria-keyshortcuts', 'M');
    }
  });

  it('A on the player: CUE stopped sets the cue point on the beat (kept as slot 0); held at it plays, let go goes back', async () => {
    await withB();
    r.el.paused = true;
    r.el.currentTime = 33.1;
    const cue = screen.getByRole('button', { name: 'Deck A cue' });
    fireEvent.pointerDown(cue, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(cue, { pointerId: 1 });
    const a = store.snapshot().a!;
    // on A's beat (the grid's beats at 0.5 s from its first downbeat)
    expect(a.main?.slot).toBe(0);
    expect(a.cue).toBe(a.main!.seconds);
    expect(said.at(-1)).toMatch(/^Deck A cue at bar /);
    await flush(700);
    expect((cuesPut.at(-1) as { cues: { slot: number }[] }).cues[0]!.slot).toBe(0);
    // held at the cue point: the player plays from it; let go: back to it, paused
    r.el.currentTime = a.cue;
    playerCalls.length = 0;
    fireEvent.pointerDown(cue, { button: 0, pointerId: 1 });
    expect(playerCalls).toEqual([`seek ${a.cue}`, 'play']);
    fireEvent.pointerUp(cue, { pointerId: 1 });
    expect(playerCalls.slice(2)).toEqual(['pause', `seek ${a.cue}`]);
  });

  it('B before the blend: Play plays it into the headphones only; Play B is still the synced start', async () => {
    await withB();
    act(() => {
      expect(store.transport('b', 'play')).toBe(true);
    });
    expect(r.session.snapshot().previewB).toBe(true);
    expect(said.at(-1)).toBe('Deck B playing in the headphones');
    expect(r.engine.master.browser.valueAt(r.engine.port.time)).toBe(0);
    await flush(1000);
    act(() => {
      store.transport('b', 'play');
    });
    expect(r.session.snapshot().previewB).toBe(false);
    act(() => {
      store.playB();
    });
    expect(r.session.snapshot().phase).toBe('starting');
  });

  it('A’s CUE waits while A is on its deck; its Play is the player’s (pauses both)', async () => {
    await withB();
    act(() => {
      store.playB();
    });
    await flush(3000);
    act(() => {
      store.transport('a', 'cueDown');
    });
    expect(said.at(-1)).toBe(
      'A’s CUE waits while it’s on its deck · cues 1–4 jump, Back ends the blend',
    );
  });

  it('a press and drag on the waveform is the hand, not a cue placed; a click still places', async () => {
    await withB();
    fireEvent.click(document.querySelector('[data-dj-strip="b"] [data-dj-cue="3"]')!);
    const wave = document.querySelector<HTMLElement>('[data-dj-wave="b"]')!;
    wave.getBoundingClientRect = () =>
      ({
        left: 0,
        width: 288,
        top: 0,
        height: 50,
        right: 288,
        bottom: 50,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    fireEvent.pointerDown(wave, { button: 0, pointerId: 7, clientX: 100 });
    fireEvent.pointerMove(wave, { pointerId: 7, clientX: 140 });
    expect(r.session.snapshot().hand).toBe('B');
    fireEvent.pointerUp(wave, { pointerId: 7, clientX: 140 });
    fireEvent.click(wave, { clientX: 140 });
    expect(store.snapshot().b!.cues[2]).toBeNull();
    expect(r.session.snapshot().hand).toBeNull();
    // B moved back by the hand: dragged right is back (40 px of 288 s over 288 px)
    expect(r.session.snapshot().parkB).not.toBeNull();
    // a click alone places the picked cue
    fireEvent.click(wave, { clientX: 100 });
    expect(store.snapshot().b!.cues[2]?.slot).toBe(3);
  });

  it('the lane keys: C (held) and G on the focused lane; ← → nudge only a playing deck', async () => {
    await withB();
    const laneB = document.querySelector<HTMLElement>('[data-dj-lane="b"]')!;
    act(() => {
      fireEvent.keyDown(laneB, { key: 'g' });
    });
    expect(r.session.snapshot().previewB).toBe(true);
    act(() => {
      fireEvent.keyDown(laneB, { key: 'c' });
    });
    expect(r.session.snapshot().previewB).toBe(false);
    expect(said.at(-1)).toBe('Deck B back to its cue, stopped');
    act(() => {
      fireEvent.keyUp(laneB, { key: 'c' });
    });
    // B stopped: the arrow is the player's
    const e = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    laneB.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
