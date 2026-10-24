import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AudioTap } from './visuals-audio';
import type { PresetEntry } from './visuals.types';

import { clearPresetMemory } from './visuals-api';
import {
  PREVIEW_BACK_MS,
  PREVIEW_DELAY_MS,
  SILENT_DIRECT_MS,
  VisualsController,
} from './visuals-controller';

const entry = (key: string, name: string, author: string | null): PresetEntry => ({
  key,
  name,
  author,
  full_name: author ? `${author} - ${name}` : name,
  size: 3000,
  source: key.startsWith('own-') ? 'own' : 'bundled',
});

const PRESETS = [
  entry('md-0000000000000001', 'Angel Rails', 'Hapax'),
  entry('md-0000000000000002', 'Crosshair', 'Orrery'),
  entry('md-0000000000000003', 'Hive Logic', 'Flux'),
  entry('own-000000000000000a', 'Mine', 'Ross'),
];

interface Harness {
  c: VisualsController;
  calls: string[];
  loads: { preset: unknown; blend: number }[];
  overlay: HTMLElement;
  setSilent(v: boolean): void;
  fail: Set<string>;
  favFails: { on: boolean };
  radio: { state: () => unknown; play: ReturnType<typeof vi.fn> } | null;
  npv2: Record<string, unknown>;
}

function harness(
  opts: {
    webgl2?: boolean;
    reduce?: boolean;
    radio?: boolean;
    index?: (url: string) => Record<string, unknown>;
  } = {},
): Harness {
  const calls: string[] = [];
  const loads: { preset: unknown; blend: number }[] = [];
  const fail = new Set<string>();
  const favFails = { on: false };
  let silent = false;
  document.body.innerHTML =
    '<div id="np-modal-overlay" class="hidden"><div class="np-modal"></div></div>';
  const overlay = document.getElementById('np-modal-overlay')!;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.startsWith('/api/visuals/presets?'))
      return new Response(
        JSON.stringify({
          success: true,
          family: 'milkdrop',
          total: PRESETS.length,
          count: PRESETS.length,
          presets: PRESETS,
          authors: [],
          own: { configured: true, count: 1, problem: null },
          ...(opts.index ? opts.index(url) : {}),
        }),
        { status: 200 },
      );
    if (url.startsWith('/api/visuals/favourites?'))
      return new Response(JSON.stringify({ success: true, keys: ['md-0000000000000003'] }));
    if (url.startsWith('/api/visuals/favourites/')) {
      if (favFails.on)
        return new Response(JSON.stringify({ success: false }), {
          status: 500,
        });
      return new Response(JSON.stringify({ success: true, favourite: init?.method === 'PUT' }));
    }
    const m = /\/api\/visuals\/presets\/(.+)$/.exec(url);
    if (m) {
      const key = decodeURIComponent(m[1]!);
      if (fail.has(key)) return new Response('{}', { status: 404 });
      if (key.startsWith('own-'))
        return new Response('[preset00]\nzoom=1', {
          headers: { 'X-Preset-Format': 'milk' },
        });
      return new Response(JSON.stringify({ name: key, baseVals: {}, shapes: [], waves: [] }));
    }
    return new Response('{}', { status: 404 });
  });
  const tap: AudioTap = {
    time: (out) => out.fill(silent ? 128 : 200),
    freq: (out) => out.fill(silent ? 0 : 120),
    sampleRate: () => 48000,
    silent: () => silent,
  };
  const npv2: Record<string, unknown> = {
    themeList: () => [
      { id: 'aurora', name: 'Aurora', blurb: '' },
      { id: 'barscope', name: 'Barscope', blurb: '' },
      { id: 'none', name: 'Off', blurb: '' },
    ],
    getTheme: () => (npv2.theme as string) ?? 'aurora',
    setTheme: (id: string) => {
      npv2.theme = id;
      calls.push(`theme ${id}`);
    },
    setVizAutocycle: (v: string) => calls.push(`autocycle ${v}`),
    getReduceMotion: () => Boolean(opts.reduce),
    wakeVisuals: () => undefined,
  };
  (window as unknown as { npV2: unknown }).npV2 = npv2;
  let radio: Harness['radio'] = null;
  if (opts.radio) {
    radio = {
      state: () => ({
        status: 'playing',
        mode: 'direct',
        station: { id: 'nts1', name: 'NTS 1' },
        stream: { id: 'hq' },
      }),
      play: vi.fn(async () => undefined),
    };
  }
  (window as unknown as { SoulSyncRadio: unknown }).SoulSyncRadio = radio ?? undefined;
  const c = new VisualsController({
    win: window,
    fetch: fetchImpl as unknown as (u: string, i?: RequestInit) => Promise<Response>,
    tap,
    webgl2: () => opts.webgl2 ?? true,
    raf: () => 0,
    cancelRaf: () => undefined,
    loadEngine: async () => ({
      createMilkdropEngine: () => ({
        load: (preset: Record<string, unknown>, blend: number) => {
          if ((preset as { name?: string }).name === 'md-0000000000000002')
            throw new Error('bad shader');
          loads.push({ preset, blend });
        },
        resize: () => undefined,
        frame: () => undefined,
      }),
    }),
    loadConverter: async () => ({
      convertMilk: async (text: string) => ({
        converted: text,
        baseVals: {},
        shapes: [],
        waves: [],
      }),
    }),
  });
  c.attach({
    overlay,
    gl: document.createElement('canvas'),
    canvas2d: document.createElement('canvas'),
  });
  return {
    c,
    calls,
    loads,
    overlay,
    setSilent: (v) => (silent = v),
    fail,
    favFails,
    radio,
    npv2,
  };
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearPresetMemory();
});

/** microtasks and due timers, under fake timers */
const tick = async () => {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
};

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('the families and the index', () => {
  it('the preset list is fetched only when MilkDrop is first opened, never on page load', async () => {
    const h = harness();
    h.c.setOpen(true);
    h.c.togglePanel(true);
    await flush();
    expect(h.calls.some((c) => c.includes('/api/visuals/presets'))).toBe(false);
    h.c.setFamily('milkdrop');
    await flush();
    expect(h.calls.filter((c) => c.includes('/api/visuals/presets?')).length).toBe(1);
    h.c.setFamily('synchros');
    h.c.setFamily('milkdrop');
    await flush();
    expect(h.calls.filter((c) => c.includes('/api/visuals/presets?')).length).toBe(1);
    h.c.dispose();
  });

  it('who paints is written on the overlay for the legacy engine', async () => {
    const h = harness();
    h.c.setOpen(true);
    expect(h.overlay.dataset.visualsEngine).toBe('synchros');
    h.c.setFamily('classic');
    expect(h.overlay.dataset.visualsEngine).toBe('classic');
    h.c.setFamily('milkdrop');
    expect(h.overlay.dataset.visualsEngine).toBe('milkdrop');
    h.c.dispose();
  });

  it('the family is remembered per browser', () => {
    const h = harness();
    h.c.setFamily('classic');
    h.c.dispose();
    const again = harness();
    expect(again.c.snapshot().family).toBe('classic');
    again.c.dispose();
  });

  it('MilkDrop starts on a preset and credits it; favourites come with the list', async () => {
    const h = harness();
    h.c.setFamily('milkdrop');
    h.c.setOpen(true);
    await flush();
    const s = h.c.snapshot();
    expect(s.presetKey).toBe(PRESETS[0]!.key);
    expect(h.loads).toHaveLength(1);
    expect([...s.favourites]).toEqual(['md-0000000000000003']);
    expect(s.header).toEqual({
      name: 'Angel Rails',
      meta: 'by Hapax · MilkDrop',
    });
    expect(s.credit?.line).toBe('by Hapax · MilkDrop · 1 of 4 · where you left it');
    h.c.dispose();
  });
});

describe('picking, stepping and the keys', () => {
  it('a pick fetches the preset by key, blends it in, and goes into Recent', async () => {
    const h = harness();
    h.c.setFamily('milkdrop');
    h.c.setOpen(true);
    await flush();
    h.c.pick(PRESETS[2]!.key);
    await flush();
    const s = h.c.snapshot();
    expect(s.presetKey).toBe(PRESETS[2]!.key);
    expect(s.recent[0]).toBe(PRESETS[2]!.key);
    expect(h.loads.at(-1)!.blend).toBe(2);
    expect(s.credit?.name).toBe('Hive Logic');
    expect(s.credit?.line).toContain('you picked it');
    expect(JSON.parse(localStorage.getItem('soulsync-visuals-recent')!)[0]).toBe(PRESETS[2]!.key);
    // Blend off: a cut
    h.c.setBlend(false);
    h.c.pick(PRESETS[0]!.key);
    await flush();
    expect(h.loads.at(-1)!.blend).toBe(0);
    h.c.dispose();
  });

  it('your own presets are converted in the browser', async () => {
    const h = harness();
    h.c.setFamily('milkdrop');
    h.c.setOpen(true);
    await flush();
    h.c.pick('own-000000000000000a');
    await flush();
    expect((h.loads.at(-1)!.preset as { converted: string }).converted).toContain('[preset00]');
    h.c.dispose();
  });

  it('V, Shift+V and R step through MilkDrop; L stars the playing preset', async () => {
    const h = harness();
    h.c.setFamily('milkdrop');
    h.c.setOpen(true);
    await flush();
    h.c.key('next');
    await flush();
    // Crosshair won't load, so it's skipped next time
    expect(h.c.snapshot().failure?.name).toBe('Crosshair');
    h.c.dismissFailure();
    h.c.key('next');
    await flush();
    expect(h.c.snapshot().presetKey).toBe(PRESETS[2]!.key);
    h.c.key('previous');
    await flush();
    expect(h.c.snapshot().presetKey).toBe(PRESETS[0]!.key);
    h.c.key('random');
    await flush();
    expect(h.c.snapshot().presetKey).not.toBe(PRESETS[0]!.key);
    const playing = h.c.snapshot().presetKey!;
    h.c.key('favourite');
    await flush();
    expect(h.c.snapshot().favourites.has(playing)).toBe(!['md-0000000000000003'].includes(playing));
    expect(
      h.calls.some(
        (c) => c.startsWith('PUT /api/visuals/favourites/milkdrop/') || c.startsWith('DELETE'),
      ),
    ).toBe(true);
    h.c.dispose();
  });

  it('in the SYNCHRO.S family V picks the next tile, quietly; in Classic it swaps Bars and Scope', () => {
    const h = harness();
    h.c.setOpen(true);
    h.c.key('next');
    expect(h.calls).toContain('theme barscope');
    expect(h.c.snapshot().credit?.name).toBe('Barscope');
    h.c.setFamily('classic');
    expect(h.c.snapshot().classicMode).toBe('bars');
    h.c.key('next');
    expect(h.c.snapshot().classicMode).toBe('scope');
    expect(h.c.snapshot().header.name).toBe('Scope');
    h.c.key('favourite'); // no stars outside MilkDrop
    expect(h.calls.some((c) => c.includes('favourites/'))).toBe(false);
    h.c.dispose();
  });

  it('a favourite that doesn’t save goes back', async () => {
    const h = harness();
    h.c.setFamily('milkdrop');
    h.c.setOpen(true);
    await flush();
    h.favFails.on = true;
    await h.c.toggleFavourite(PRESETS[0]!.key);
    expect(h.c.snapshot().favourites.has(PRESETS[0]!.key)).toBe(false);
    h.c.dispose();
  });
});

describe('the states (10d)', () => {
  it('won’t load: the last preset stays, the card names both, and auto-cycle skips it', async () => {
    const h = harness();
    h.c.setFamily('milkdrop');
    h.c.setOpen(true);
    await flush();
    h.fail.add(PRESETS[2]!.key);
    h.c.pick(PRESETS[2]!.key);
    await flush();
    const s = h.c.snapshot();
    expect(s.presetKey).toBe(PRESETS[0]!.key);
    expect(s.failure).toEqual({
      key: PRESETS[2]!.key,
      name: 'Hive Logic',
      backName: 'Angel Rails',
    });
    expect(s.failed.has(PRESETS[2]!.key)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('soulsync-visuals-failed')!)).toContain(
      PRESETS[2]!.key,
    );
    // Try it again: it loads now
    h.fail.delete(PRESETS[2]!.key);
    h.c.retryFailure();
    await flush();
    expect(h.c.snapshot().presetKey).toBe(PRESETS[2]!.key);
    expect(h.c.snapshot().failed.has(PRESETS[2]!.key)).toBe(false);
    h.c.dispose();
  });

  it('loading: the credit says so while the last preset keeps running', async () => {
    const h = harness();
    h.c.setFamily('milkdrop');
    h.c.setOpen(true);
    await flush();
    h.c.pick(PRESETS[2]!.key);
    const s = h.c.snapshot();
    expect(s.loadingKey).toBe(PRESETS[2]!.key);
    expect(s.presetKey).toBe(PRESETS[0]!.key);
    expect(s.credit?.loading).toBe(true);
    expect(s.credit?.name).toBe('Loading Hive Logic…');
    await flush();
    expect(h.c.snapshot().credit?.loading).toBe(false);
    h.c.dispose();
  });

  it('no WebGL 2: MilkDrop leaves the stage to the SYNCHRO.S visuals', () => {
    const h = harness({ webgl2: false });
    h.c.setFamily('milkdrop');
    h.c.setOpen(true);
    expect(h.c.snapshot().engine).toBe('synchros');
    expect(h.overlay.dataset.visualsEngine).toBe('synchros');
    h.c.dispose();
  });

  it('Reduce visual effects opens the overlay still; "Play visuals this time" lasts the session', () => {
    const h = harness({ reduce: true });
    h.c.setOpen(true);
    expect(h.c.snapshot().still).toBe('setting');
    expect(h.overlay.dataset.visualsEngine).toBe('still');
    h.c.playVisualsThisTime();
    expect(h.c.snapshot().still).toBeNull();
    h.c.setOpen(false);
    h.c.setOpen(true);
    expect(h.c.snapshot().still).toBeNull();
    expect(sessionStorage.getItem('soulsync-visuals-play-anyway')).toBe('1');
    h.c.dispose();
  });

  it('a direct station the analyser can’t hear shows the card; Play through SYNCHRO.S asks for the relay', async () => {
    vi.useFakeTimers();
    const h = harness({ radio: true });
    h.setSilent(true);
    h.c.setOpen(true);
    vi.advanceTimersByTime(SILENT_DIRECT_MS + 2000);
    expect(h.c.snapshot().radioDirect).toEqual({ station: 'NTS 1' });
    await h.c.playThroughSynchros();
    expect(h.radio!.play).toHaveBeenCalledWith(
      'nts1',
      expect.objectContaining({ forceRelay: true, streamId: 'hq' }),
    );
    expect(h.c.snapshot().radioDirect).toBeNull();
    h.c.dispose();
  });

  it('a direct station that can be heard shows no card', () => {
    vi.useFakeTimers();
    const h = harness({ radio: true });
    h.setSilent(false);
    h.c.setOpen(true);
    vi.advanceTimersByTime(SILENT_DIRECT_MS + 2000);
    expect(h.c.snapshot().radioDirect).toBeNull();
    h.c.dispose();
  });
});

describe('the frame-rate guard', () => {
  it('drops Quality one step, says so, and Put it back restores it', async () => {
    const h = harness();
    h.c.setFamily('milkdrop');
    h.c.setOpen(true);
    await flush();
    for (let t = 0; t <= 7000; t += 1000 / 12) h.c.debugGuardFrame(t);
    let s = h.c.snapshot();
    expect(s.quality).toBe('half');
    expect(s.credit?.guard).toEqual({ from: 'full', to: 'half' });
    expect(s.credit?.name).toBe('Quality dropped to Half');
    // once per preset
    for (let t = 7000; t <= 20000; t += 1000 / 12) h.c.debugGuardFrame(t);
    expect(h.c.snapshot().quality).toBe('half');
    h.c.restoreQuality();
    s = h.c.snapshot();
    expect(s.quality).toBe('full');
    expect(localStorage.getItem('soulsync-visuals-quality')).toBe('full');
    expect(h.c.debugState().guardArmed).toBe(false);
    h.c.dispose();
  });
});

describe('auto-cycle (Off by default)', () => {
  it('is Off until someone picks it, and the choice is shared with the SYNCHRO.S visuals', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.c.setFamily('milkdrop');
    h.c.setOpen(true);
    await vi.runOnlyPendingTimersAsync();
    expect(h.c.snapshot().autocycle).toBe('off');
    const before = h.c.snapshot().presetKey;
    vi.advanceTimersByTime(60_000);
    expect(h.c.snapshot().presetKey).toBe(before);
    h.c.setAutocycle('30');
    expect(h.calls).toContain('autocycle 30');
    h.c.dispose();
  });

  it('every 30 s moves on, skipping presets that won’t load', async () => {
    const h = harness();
    let now = 1_000_000;
    (h.c as unknown as { now: () => number }).now = () => now;
    h.c.setFamily('milkdrop');
    h.c.setOpen(true);
    await flush();
    h.c.setAutocycle('30');
    (h.c as unknown as { s: { failed: Set<string> } }).s.failed = new Set([PRESETS[1]!.key]);
    now += 31_000;
    (h.c as unknown as { cycleTick: () => void }).cycleTick();
    await flush();
    expect(h.c.snapshot().presetKey).toBe(PRESETS[2]!.key);
    expect(h.c.snapshot().credit?.line).toContain('every 30 s');
    h.c.dispose();
  });

  it('on track change moves to the next preset', async () => {
    const h = harness();
    h.c.setFamily('milkdrop');
    h.c.setOpen(true);
    await flush();
    h.c.setAutocycle('track');
    window.dispatchEvent(new CustomEvent('ss:player', { detail: { reason: 'track' } }));
    await flush();
    expect(h.c.snapshot().failure?.name).toBe('Crosshair');
    h.c.dispose();
  });
});

describe('hover preview (10a)', () => {
  it('resting 400 ms previews on the stage; leaving goes back after a second; a click keeps it', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.c.setFamily('milkdrop');
    h.c.setOpen(true);
    await tick();
    const playing = h.c.snapshot().presetKey;
    h.c.hoverRow(PRESETS[2]!.key);
    vi.advanceTimersByTime(PREVIEW_DELAY_MS - 50);
    expect(h.c.snapshot().previewKey).toBeNull();
    vi.advanceTimersByTime(60);
    expect(h.c.snapshot().previewKey).toBe(PRESETS[2]!.key);
    expect(h.c.snapshot().presetKey).toBe(playing);
    h.c.leaveRow();
    vi.advanceTimersByTime(PREVIEW_BACK_MS + 10);
    expect(h.c.snapshot().previewKey).toBeNull();
    expect(h.c.snapshot().presetKey).toBe(playing);
    h.c.hoverRow(PRESETS[2]!.key);
    vi.advanceTimersByTime(PREVIEW_DELAY_MS + 10);
    h.c.pick(PRESETS[2]!.key);
    await tick();
    expect(h.c.snapshot().presetKey).toBe(PRESETS[2]!.key);
    expect(h.c.snapshot().previewKey).toBeNull();
    h.c.dispose();
  });
});

describe('the credit’s key hints', () => {
  it('show the first three times, then only in "?"', () => {
    const h = harness();
    h.c.setOpen(true);
    const hints: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      h.c.key('next');
      hints.push(Boolean(h.c.snapshot().credit?.hints));
    }
    expect(hints).toEqual([true, true, true, false, false]);
    expect(localStorage.getItem('soulsync-visuals-hints')).toBe('3');
    h.c.dispose();
  });
});

describe('the curated list and Every preset (101)', () => {
  const KEPT = entry('md-00000000000000ff', 'Uncurated', 'Anon');

  it('asks for the curated set with Recent’s keys; kept presets can be named and played', async () => {
    localStorage.setItem(
      'soulsync-visuals-recent',
      JSON.stringify([KEPT.key, 'own-000000000000000a']),
    );
    const h = harness({
      index: () => ({ set: 'curated', kept: [KEPT], uncurated: 9 }),
    });
    h.c.setOpen(true);
    h.c.setFamily('milkdrop');
    await flush();
    expect(h.calls).toContain(
      `GET /api/visuals/presets?family=milkdrop&set=curated&keep=${KEPT.key}`,
    );
    const s = h.c.snapshot();
    expect(s.index.uncurated).toBe(9);
    expect(s.index.presets.some((p) => p.key === KEPT.key)).toBe(false);
    expect(h.c.entry(KEPT.key)?.name).toBe('Uncurated');
    h.c.setShow('recent');
    // opening MilkDrop played the first preset, newest first
    expect(
      h.c
        .snapshot()
        .list.map((p) => p.key)
        .slice(-2),
    ).toEqual([KEPT.key, 'own-000000000000000a']);
    h.c.dispose();
  });

  it('Every preset asks for every preset, is remembered in this browser, and turns back off', async () => {
    const h = harness({
      index: (url) => ({
        set: url.includes('set=all') ? 'all' : 'curated',
        uncurated: 2,
      }),
    });
    h.c.setOpen(true);
    h.c.setFamily('milkdrop');
    await flush();
    h.c.setEveryPreset(true);
    await flush();
    expect(h.calls).toContain('GET /api/visuals/presets?family=milkdrop&set=all');
    expect(h.c.snapshot().everyPreset).toBe(true);
    expect(h.c.snapshot().index.set).toBe('all');
    expect(localStorage.getItem('soulsync-visuals-every-preset')).toBe('1');
    h.c.dispose();
    const again = harness({
      index: (url) => ({ set: url.includes('set=all') ? 'all' : 'curated' }),
    });
    expect(again.c.snapshot().everyPreset).toBe(true);
    again.c.setEveryPreset(false);
    expect(localStorage.getItem('soulsync-visuals-every-preset')).toBeNull();
    again.c.dispose();
  });

  it('a switch while the list is on its way asks again for the right set', async () => {
    const h = harness({
      index: (url) => ({ set: url.includes('set=all') ? 'all' : 'curated' }),
    });
    h.c.setOpen(true);
    h.c.setFamily('milkdrop');
    h.c.setEveryPreset(true);
    await flush();
    await flush();
    expect(h.c.snapshot().index.set).toBe('all');
    expect(h.c.snapshot().index.status).toBe('ready');
    h.c.dispose();
  });
});
