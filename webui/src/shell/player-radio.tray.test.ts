/**
 * Radio in the expanded player (Ross, 2026-10-23): the bar expands into 6a's
 * tray while a station plays, with radio's record, deck and list; the same
 * toggle, Collapse and Escape as music; Heard today / Recent stations; the
 * "…" menu (so Visuals is in reach); the Visuals header; the station logo's
 * letters when its image fails; the meter's bars counted from its width.
 * Against the real markup from index.html.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  HeardItem,
  RadioSessionApi,
  RadioSessionState,
  Station,
} from '@/features/radio/radio.types';

import { RECENT_STATIONS_KEY } from '@/features/radio/radio.recent';

import { bootPlayer, type PlayerChrome, type PlayerEngine, type PlayerSnapshot } from './player';
import { bootRadioChrome, fillLogo } from './player-radio';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
let parsed: Document | null = null;

function mountMarkup() {
  parsed ??= new DOMParser().parseFromString(html, 'text/html');
  const take = (sel: string) => document.importNode(parsed!.querySelector(sel)!, true);
  document.body.replaceChildren(
    take('#audio-player'),
    take('#media-player'),
    take('[data-player-scrim]'),
    take('#np-modal-overlay'),
  );
}

function station(over: Partial<Station> = {}): Station {
  return {
    id: 'nts-1',
    name: 'NTS 1',
    kind: 'eclectic',
    kind_label: 'Eclectic tastemakers',
    genre: 'Eclectic',
    city: 'London',
    country: '',
    logo_url: '/api/radio/stations/nts-1/logo?v=1',
    homepage: '',
    description: '',
    source: 'built_in',
    favourite: false,
    auto_add: false,
    has_now_playing: true,
    has_tracklists: true,
    quality: { codec: 'AAC', bitrate_kbps: 256, lossless: false, label: 'AAC 256 kbps' },
    tags: [],
    sends_titles: null,
    added_by: null,
    streams: [
      { id: 'a', codec: 'AAC', bitrate_kbps: 256, lossless: false, label: 'AAC 256 kbps' },
      { id: 'm', codec: 'MP3', bitrate_kbps: 128, lossless: false, label: 'MP3 128 kbps' },
    ],
    ...over,
  };
}

/** Built when a test runs, so its times are the test's own. */
function radioState(over: Partial<RadioSessionState> = {}): RadioSessionState {
  const now = Date.now() / 1000;
  return {
    status: 'playing',
    station: station(),
    sessionId: 's1',
    mode: 'relay',
    stream: {
      id: 'a',
      label: 'AAC 256 kbps (best offered)',
      codec: 'AAC',
      bitrate_kbps: 256,
      lossless: false,
    },
    nowPlaying: {
      station_id: 'nts-1',
      state: 'identified',
      track: { artist: 'Pale Harbour', title: 'Harbour Light', release: 'Lantern', art_url: null },
      source: 'station_feed',
      identified_at: now - 40,
      started_at: null,
      reason: null,
      library: { in_library: true, below_target: false, track_id: 't1' },
      on_wanted: false,
      previous_title: null,
      now,
      playing: true,
      heard_id: 1,
    },
    error: null,
    skew: 0,
    adding: false,
    ...over,
  };
}

function heardItems(): HeardItem[] {
  const t = Math.floor(Date.now() / 1000);
  const base = {
    station_id: 'nts-1',
    station_name: 'NTS 1',
    source: 'station_feed' as const,
    added_at: null,
    added_by_auto_add: false,
    duration_s: null,
    reason: null,
    below_target: null,
    track_id: null,
  };
  return [
    {
      ...base,
      id: 1,
      heard_at: t - 60,
      artist: 'Pale Harbour',
      title: 'Harbour Light',
      release: 'Lantern',
      state: 'in_library',
    },
    {
      ...base,
      id: 3,
      heard_at: t - 120,
      artist: 'Tidewater',
      title: 'Night Ferry (Dub)',
      release: null,
      state: 'not_added',
    },
  ];
}

function snapshot(): PlayerSnapshot {
  return {
    track: {
      title: 'NTS 1',
      artist: 'AAC 256 kbps · Radio',
      kind: 'radio',
      image_url: '/api/radio/stations/nts-1/logo?v=1',
    },
    kind: 'radio',
    playing: true,
    buffering: false,
    loading: { active: false, text: '', progress: 0 },
    queue: [],
    index: -1,
    canPrevious: false,
    canNext: false,
    shuffle: false,
    repeat: 'off',
    radio: false,
    autoDownload: false,
    crossfade: false,
    context: '',
    volume: 70,
    muted: false,
    sleep: 0,
    sleepEndsAt: 0,
    sleepSteps: [0, 15, 30, 45, 60, 90, 120, 'track'],
    lyrics: { synced: false, lines: 0, loading: false, status: '' },
    reportable: false,
    playlistTrack: null,
  };
}

function engine() {
  const audio = Object.assign(new EventTarget(), { duration: Infinity, currentTime: 75 });
  return {
    state: () => snapshot(),
    audio: () => audio as unknown as HTMLAudioElement,
    outputTargets: () => ({ elements: [], context: null }),
    analyser: () => null,
    toggle: vi.fn(),
    stop: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    seek: vi.fn(),
    skip: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    toggleShuffle: vi.fn(),
    cycleRepeat: vi.fn(),
    playIndex: vi.fn(async () => undefined),
    setCrossfade: vi.fn(),
    setSleep: vi.fn(),
    playNext: vi.fn(),
    setExpanded: vi.fn(),
  };
}

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let player: PlayerChrome | null = null;
let radioChrome: { dispose(): void; draw(): void } | null = null;
let api: RadioSessionApi & {
  play: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
};
let fetchImpl: ReturnType<typeof vi.fn>;
let st: RadioSessionState;
let eng: ReturnType<typeof engine>;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const tray = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(`[data-player-radio-tray] ${sel}`)!;
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const press = (key: string, target: EventTarget = document) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

function boot() {
  const win = window as Window & { SoulSyncRadio?: RadioSessionApi };
  api = {
    state: () => st,
    play: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    retry: vi.fn(),
    addToWanted: vi.fn(async () => true),
    refresh: vi.fn(async () => undefined),
  };
  win.SoulSyncRadio = api;
  // the engine sets the player's data-source; the radio chrome reads it
  eng = engine();
  player = bootPlayer({
    engine: eng as unknown as PlayerEngine,
    fetchImpl: fetchImpl as never,
  });
  radioChrome = bootRadioChrome({
    radio: () => api,
    analyser: () => null,
    fetchImpl: fetchImpl as never,
  });
}

beforeEach(() => {
  mountMarkup();
  localStorage.clear();
  st = radioState();
  window.showToast = vi.fn();
  fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/radio/heard?'))
      return respond(200, {
        success: true,
        items: heardItems(),
        days: 1,
        keep_days: 90,
        counts: {},
      });
    if (url.includes('/want') && init?.method === 'POST')
      return respond(200, { success: true, message: '', skipped: false });
    if (url.includes('/auto-add'))
      return respond(200, {
        enabled: false,
        identified_yesterday: 140,
        already_have: 31,
        would_add: 50,
        would_add_without_limit: 109,
        daily_limit: 50,
        added_today: 0,
        can_download: true,
        has_now_playing: true,
      });
    if (url.includes('/api/radio/stations/'))
      return respond(200, {
        success: true,
        station: station(),
        heard_today: { identified: 2, not_identified: 0 },
      });
    return respond(404, {});
  });
});

afterEach(() => {
  radioChrome?.dispose();
  player?.destroy();
  radioChrome = null;
  player = null;
  delete (window as Window & { SoulSyncRadio?: unknown }).SoulSyncRadio;
  delete (window as Window & { npV2?: unknown }).npV2;
  window.showToast = undefined;
  document.body.replaceChildren();
});

describe('the tray in radio mode', () => {
  it('expands like music while a station plays: same toggle, same state, the radio columns', async () => {
    boot();
    expect(document.documentElement.getAttribute('data-player')).toBe('bar');
    expect($('#media-player').dataset.source).toBe('radio');
    $('.ss-player-bar .ss-player-ghost[data-player-toggle]').click();
    await flush();
    expect(document.documentElement.getAttribute('data-player')).toBe('tray');
    expect($('#ss-player-tray').hidden).toBe(false);
    for (const t of document.querySelectorAll('[data-player-toggle]'))
      expect(t.getAttribute('aria-expanded')).toBe('true');
    // the focus lands on the Collapse that shows: radio's list's
    expect(document.activeElement).toBe(tray('.ss-player-collapse'));
  });

  it('opens from the bar’s left button too (it no longer goes to the station page)', async () => {
    boot();
    $('.ss-player-bar .ss-player-now').click();
    await flush();
    expect(document.documentElement.getAttribute('data-player')).toBe('tray');
    expect($('.ss-player-bar .ss-player-now').getAttribute('aria-label')).toBe(
      'NTS 1, live. Expand the player',
    );
  });

  it('collapses with Collapse and with Escape, back to the bar, focus on Expand', async () => {
    boot();
    player!.expand();
    tray('.ss-player-collapse').click();
    expect(document.documentElement.getAttribute('data-player')).toBe('bar');
    expect(document.activeElement).toBe($('.ss-player-bar .ss-player-ghost[data-player-toggle]'));
    player!.expand();
    tray('[data-player-rtray-tab="heard"]').focus();
    press('Escape');
    expect(document.documentElement.getAttribute('data-player')).toBe('bar');
  });

  it('draws the record: the logo’s letters, Now playing with its source, the artist, the readout', async () => {
    boot();
    player!.expand();
    radioChrome!.draw();
    expect(tray('[data-player-rtray-letters]').textContent).toBe('NTS');
    expect(tray('[data-player-rtray-label]').textContent).toBe('Now playing · from the station');
    expect(tray('[data-player-rtray-title]').textContent).toBe('Harbour Light');
    const artist = tray<HTMLAnchorElement>('[data-player-rtray-artist]');
    expect(artist.hidden).toBe(false);
    expect(artist.textContent).toBe('Pale Harbour');
    expect(artist.getAttribute('href')).toContain('/search?q=Pale+Harbour&type=artists');
    expect(tray('[data-player-rtray-line]').textContent).toMatch(/^Lantern · \d+ s ago$/);
    expect(tray('[data-player-rtray-stream]').textContent).toBe('AAC 256 kbps · relayed');
    expect(tray('[data-player-rtray-path]').textContent).toBe('NTS 1 → This device');
    expect(tray('[data-player-rtray-action]').textContent).toBe('In your library');
    st = radioState({ mode: 'direct' });
    radioChrome!.draw();
    expect(tray('[data-player-rtray-stream]').textContent).toBe('AAC 256 kbps · direct');
  });

  it('draws the deck: the meter, Live and the time listened, Stop, the stream picker, Scan now', () => {
    boot();
    player!.expand();
    radioChrome!.draw();
    expect(tray('[data-player-meter]').hidden).toBe(false);
    expect(tray('[data-player-rtray-listened]').textContent).toBe('0:00');
    (engine().audio() as unknown as EventTarget).dispatchEvent(new Event('timeupdate'));
    expect(tray('.ss-player-live-tag').textContent).toContain('Live');
    expect(tray('[data-player-radio-stop]')).toBeTruthy();
    const select = tray<HTMLSelectElement>('[data-player-rtray-streams]');
    expect(select.hidden).toBe(false);
    // 16a: the one playing in the readout's short words, the rest as their quality
    expect([...select.options].map((o) => o.textContent)).toEqual(['AAC 256 · relayed', 'MP3 128']);
    select.value = 'm';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(api.play).toHaveBeenCalledWith('nts-1', expect.objectContaining({ streamId: 'm' }));
    expect(tray('[data-player-radio-scan]').textContent).toContain('Scan now');
    // one stream: no picker
    st = radioState({ station: station({ streams: [] }) });
    radioChrome!.draw();
    expect(select.hidden).toBe(true);
  });

  it('stops from the deck', async () => {
    boot();
    player!.expand();
    tray('[data-player-radio-stop]').click();
    await flush();
    expect(api.stop).toHaveBeenCalled();
  });
});

describe('the list: Heard today / Recent stations', () => {
  it('lists today’s Heard with Add on what isn’t in your library, and adds it', async () => {
    boot();
    player!.expand();
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/api/radio/heard?station_id=nts-1&days=1'),
      expect.anything(),
    );
    expect(tray('[data-player-rtray-heard-count]').textContent).toBe('2');
    const rows = document.querySelectorAll('[data-player-radio-tray] .ss-player-rtray-row-heard');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('In your library');
    const add = rows[1]!.querySelector<HTMLButtonElement>('[data-player-rtray-want]')!;
    expect(add.getAttribute('aria-label')).toBe('Add Night Ferry (Dub) by Tidewater to Wanted');
    add.click();
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/api/radio/heard/3/want'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(window.showToast).toHaveBeenCalledWith('Added Night Ferry (Dub) to Wanted.', 'success');
    expect(api.refresh).toHaveBeenCalled();
    expect(tray('[data-player-rtray-foot] a').textContent).toBe('All of it on NTS 1’s page');
    expect(tray('[data-player-rtray-foot] a').getAttribute('href')).toContain(
      '/radio/station/nts-1',
    );
  });

  it('counts identified tracks and folds the rest into one line at the end (143)', async () => {
    const orig = fetchImpl.getMockImplementation() as (
      url: string,
      init?: RequestInit,
    ) => Promise<Response>;
    const t = Math.floor(Date.now() / 1000);
    const unnamed = (id: number): HeardItem => ({
      ...heardItems()[0]!,
      id,
      heard_at: t - 30 * id,
      artist: null,
      title: null,
      release: null,
      duration_s: 600,
      state: 'not_identified',
    });
    fetchImpl.mockImplementation(async (url: string, init?: RequestInit) =>
      url.includes('/api/radio/heard?')
        ? respond(200, {
            success: true,
            items: [...heardItems(), unnamed(5), unnamed(6), unnamed(7)],
            days: 1,
            keep_days: 90,
            counts: {},
          })
        : orig(url, init),
    );
    boot();
    player!.expand();
    await flush();
    expect(tray('[data-player-rtray-heard-count]').textContent).toBe('2');
    expect(tray('[data-player-rtray-tab="heard"]').getAttribute('aria-label')).toBe(
      'Heard today, 2 identified',
    );
    expect(
      document.querySelectorAll('[data-player-radio-tray] .ss-player-rtray-row-heard'),
    ).toHaveLength(2);
    const rest = tray('[data-player-rtray-heard-rest]');
    expect(rest.hidden).toBe(false);
    expect(rest.textContent).toBe('3 more weren’t identified · talk or a mix');
    // the line follows the list, outside it
    expect(tray('[data-player-rtray-heard-list]').contains(rest)).toBe(false);
  });

  it('shows auto-add on Heard today only (146)', async () => {
    boot();
    player!.expand();
    await flush();
    const auto = tray('[data-player-rtray-auto]');
    expect(auto.hidden).toBe(false);
    tray('[data-player-rtray-tab="recent"]').click();
    expect(auto.hidden).toBe(true);
    tray('[data-player-rtray-tab="heard"]').click();
    expect(auto.hidden).toBe(false);
  });

  it('switches to Recent stations (the arrow keys too) and plays one from it', async () => {
    localStorage.setItem(
      RECENT_STATIONS_KEY,
      JSON.stringify([
        { id: 'fip-jazz', name: 'FIP Jazz', logo_url: '', genre: 'Jazz', city: 'Paris' },
        { id: 'nts-1', name: 'NTS 1', logo_url: '', genre: 'Eclectic', city: 'London' },
      ]),
    );
    boot();
    player!.expand();
    await flush();
    const heardTab = tray('[data-player-rtray-tab="heard"]');
    const recentTab = tray('[data-player-rtray-tab="recent"]');
    heardTab.focus();
    press('ArrowRight', heardTab);
    expect(recentTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(recentTab);
    expect(tray('[data-player-rtray-panel="recent"]').classList.contains('hidden')).toBe(false);
    expect(tray('[data-player-rtray-panel="heard"]').classList.contains('hidden')).toBe(true);
    // playing NTS 1 went to the front; it's the Playing row, FIP Jazz has Play
    const rows = [
      ...document.querySelectorAll('[data-player-radio-tray] .ss-player-rtray-row-station'),
    ];
    expect(rows.map((r) => r.querySelector('.ss-player-rtray-title')!.textContent)).toEqual([
      'NTS 1',
      'FIP Jazz',
    ]);
    expect(rows[0]!.getAttribute('aria-current')).toBe('true');
    expect(rows[0]!.textContent).toContain('Playing');
    const play = rows[1]!.querySelector<HTMLButtonElement>('[data-player-rtray-play]')!;
    expect(play.getAttribute('aria-label')).toBe('Play FIP Jazz');
    play.click();
    await flush();
    expect(api.play).toHaveBeenCalledWith(
      'fip-jazz',
      expect.objectContaining({ station: expect.objectContaining({ name: 'FIP Jazz' }) }),
    );
    expect(tray('[data-player-rtray-foot] a').textContent).toBe('All stations on the Radio page');
    recentTab.click();
    tray('[data-player-rtray-tab="heard"]').click();
    expect(heardTab.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the auto-add switch under the list, with 9c’s confirm in place', async () => {
    boot();
    player!.expand();
    await flush();
    const sw = tray('[data-player-radio-auto]');
    expect(sw.getAttribute('role')).toBe('switch');
    sw.click();
    await flush();
    const card = tray('.ss-player-radio-confirm');
    expect(card.textContent).toContain('Add everything NTS 1 plays to Wanted?');
    expect(card.getAttribute('aria-labelledby')).toBe('ss-player-rtray-confirm-title');
    expect(document.querySelectorAll('#ss-player-rtray-confirm-title')).toHaveLength(1);
    tray('[data-player-radio-auto-cancel]').click();
    await flush();
    expect(tray('[data-player-radio-auto]')).toBeTruthy();
  });
});

describe('the "…" menu and Visuals while a station plays', () => {
  it('opens the menu from the radio record; Visuals (F) opens the overlay', () => {
    const openVisuals = vi.fn();
    (window as Window & { npV2?: unknown }).npV2 = { openVisuals };
    boot();
    player!.expand();
    const more = tray('[data-player-more]');
    expect(more.getAttribute('aria-label')).toBe('More for NTS 1');
    more.click();
    const menu = $('#ss-player-menu');
    expect(menu.hidden).toBe(false);
    expect(menu.getAttribute('aria-label')).toBe('More for this station');
    const visuals = menu.querySelector<HTMLElement>('[data-player-menu="visuals"]')!;
    expect(visuals.hidden).toBe(false);
    expect(visuals.getAttribute('aria-disabled')).toBeNull();
    expect(visuals.getAttribute('aria-keyshortcuts')).toBe('F');
    // a live stream has no speed, loop, crossfade, lyrics, details or queue
    for (const sel of [
      '[data-player-menu="crossfade"]',
      '[data-player-menu="speed"]',
      '#np-v2-ab-btn',
      '[data-player-menu="lyrics"]',
      '[data-player-menu="details"]',
      '[data-player-menu="stop"]',
      '#np-queue-clear-played',
    ])
      expect(menu.querySelector<HTMLElement>(sel)!.hidden).toBe(true);
    expect(menu.querySelector<HTMLElement>('#np-v2-eq-btn')!.hidden).toBe(false);
    visuals.click();
    expect(openVisuals).toHaveBeenCalled();
    expect(menu.hidden).toBe(true);
  });

  it('names the identified track and the station in the Visuals header', () => {
    boot();
    expect($('#np-v2-visuals-title').textContent).toBe('Harbour Light');
    expect($('#np-v2-visuals-artist').textContent).toBe('Pale Harbour · NTS 1');
    st = radioState({ nowPlaying: null });
    radioChrome!.draw();
    expect($('#np-v2-visuals-title').textContent).toBe('NTS 1');
    expect($('#np-v2-visuals-artist').textContent).toBe('Live · Listening…');
  });

  it('gives the Visuals transport Live, the time listened and Stop for a station (145)', () => {
    boot();
    const overlay = $('#np-modal-overlay');
    const live = overlay.querySelector<HTMLElement>('[data-player-visuals-live]')!;
    expect(live.hidden).toBe(false);
    expect(live.textContent).toMatch(/Live\s*1:15 listened/);
    expect(overlay.querySelector<HTMLElement>('.ss-visuals-progress')!.hidden).toBe(true);
    expect(
      overlay.querySelector<HTMLElement>('.ss-visuals-buttons [data-player-action="toggle"]')!
        .hidden,
    ).toBe(true);
    for (const a of ['previous', 'next'])
      expect(overlay.querySelector<HTMLElement>(`[data-player-action="${a}"]`)!.hidden).toBe(true);
    const stop = overlay.querySelector<HTMLButtonElement>('[data-player-action="radio-stop"]')!;
    expect(stop.hidden).toBe(false);
    expect(stop.textContent!.trim()).toBe('Stop');
    expect(stop.getAttribute('aria-keyshortcuts')).toBe('Space');
    stop.click();
    expect(api.stop).toHaveBeenCalled();
  });

  it('offers Visuals in the phone sheet', () => {
    const openVisuals = vi.fn();
    (window as Window & { npV2?: unknown }).npV2 = { openVisuals };
    boot();
    const row = $('[data-player-radio-panel] [data-player-radio-visuals]');
    expect(row.textContent).toContain('Visuals');
    row.click();
    expect(openVisuals).toHaveBeenCalled();
  });
});

describe('the station logo (Ross, 2026-10-23)', () => {
  it('keeps the letters and hides the image when the logo fails, however often it redraws', () => {
    boot();
    player!.expand();
    radioChrome!.draw();
    const img = tray<HTMLImageElement>('[data-player-rtray-logo]');
    expect(img.hidden).toBe(false);
    img.dispatchEvent(new Event('error'));
    expect(img.hidden).toBe(true);
    radioChrome!.draw();
    expect(img.hidden).toBe(true);
    expect(tray('[data-player-rtray-letters]').textContent).toBe('NTS');
    // the bar's art: hidden after an error even when the player redraws
    const bar = $<HTMLImageElement>('.ss-player-bar [data-player-art]');
    expect(bar.hidden).toBe(false);
    bar.onerror?.(new Event('error'));
    expect(bar.hidden).toBe(true);
    window.dispatchEvent(new CustomEvent('ss:player'));
    expect(bar.hidden).toBe(true);
    const letters = $('.ss-player-bar [data-player-art-letters]');
    expect(letters.hidden).toBe(false);
    expect(letters.textContent).toBe('NTS');
  });

  it('draws only our own logo route, and the letters with no logo at all', () => {
    const tile = document.createElement('span');
    fillLogo(tile, { name: 'Evil FM', logo_url: 'https://evil.example.com/x.png' });
    expect(tile.querySelector('img')).toBeNull();
    expect(tile.textContent).toBe('EF');
    const own = document.createElement('span');
    fillLogo(own, { name: 'KEXP', logo_url: '/api/radio/stations/kexp/logo?v=1' });
    const img = own.querySelector('img')!;
    expect(img.getAttribute('src')).toContain('/api/radio/stations/kexp/logo');
    img.dispatchEvent(new Event('error'));
    expect(img.hidden).toBe(true);
    expect(own.textContent).toBe('KEXP');
  });
});

describe('the meter fills its width', () => {
  it('counts its bars from the width the ResizeObserver reports', () => {
    const observers: { cb: ResizeObserverCallback; els: Element[] }[] = [];
    const RO = vi.fn(function (this: unknown, cb: ResizeObserverCallback) {
      const entry = { cb, els: [] as Element[] };
      observers.push(entry);
      return {
        observe: (el: Element) => entry.els.push(el),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      };
    });
    vi.stubGlobal('ResizeObserver', RO);
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    try {
      boot();
      const meter = $('.ss-player-bar [data-player-meter]');
      const deck = tray('[data-player-meter]');
      const o = observers.find((x) => x.els.includes(meter))!;
      o.cb(
        [
          { target: meter, contentRect: { width: 598 } },
          { target: deck, contentRect: { width: 688 } },
        ] as unknown as ResizeObserverEntry[],
        {} as ResizeObserver,
      );
      // the bar: a bar every 6px; the deck: every 8px
      expect(meter.childElementCount).toBe(100);
      expect(deck.childElementCount).toBe(86);
      expect(meter.style.getPropertyValue('--meter-bar')).toBe('4px');
      o.cb(
        [{ target: meter, contentRect: { width: 120 } }] as unknown as ResizeObserverEntry[],
        {} as ResizeObserver,
      );
      expect(meter.childElementCount).toBe(20);
    } finally {
      raf.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe('phase B1: the tray as drawn (16a–16e)', () => {
  it('names the second tab "Stations" beside 6a’s labelled Collapse (141)', () => {
    boot();
    player!.expand();
    expect(tray('[data-player-rtray-tab="recent"]').textContent).toBe('Stations');
    const collapse = tray('.ss-player-collapse');
    const music = $('#ss-player-tray > .ss-player-list .ss-player-collapse');
    // the music list's button: the word, then the chevron; no title standing in for it
    expect(collapse.textContent!.trim()).toBe('Collapse');
    expect(collapse.className).toBe(music.className);
    expect(collapse.hasAttribute('title')).toBe(false);
    expect(collapse.querySelector('svg')).toBeTruthy();
  });

  it('says the station’s kind and quality under its name in the bar (16d)', () => {
    boot();
    window.dispatchEvent(new CustomEvent('ss:player', { detail: { reason: 'track' } }));
    expect($('.ss-player-bar [data-player-meta]').textContent).toBe('Eclectic · AAC 256');
  });

  it('puts the action, the Sleep timer and "…" in the record’s row (147)', () => {
    boot();
    player!.expand();
    radioChrome!.draw();
    const row = tray('.ss-player-rtray-controls');
    const kids = [...row.children].map((c) =>
      (c as HTMLElement).dataset.playerRtrayAction !== undefined
        ? 'action'
        : (c as HTMLElement).dataset.playerSleep !== undefined
          ? 'sleep'
          : (c as HTMLElement).dataset.playerMore !== undefined
            ? 'more'
            : c.className,
    );
    expect(kids).toEqual(['action', 'sleep', 'more']);
    expect(row.querySelector('[data-player-sleep]')!.getAttribute('aria-label')).toBe(
      'Sleep timer, off',
    );
  });

  it('offers a station Off and 15 to 60 minutes, and sets one', () => {
    boot();
    player!.expand();
    tray('[data-player-sleep]').click();
    const menu = $('#ss-player-sleep-menu');
    expect(menu.hidden).toBe(false);
    const labels = [...menu.querySelectorAll('[role="menuitemradio"], [role="radio"]')].map((b) =>
      b.textContent!.trim(),
    );
    expect(labels).toEqual(['Off', '15 minutes', '30 minutes', '45 minutes', '1 hour']);
    expect(menu.textContent).not.toContain('end of this track');
    const thirty = [
      ...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="radio"]'),
    ].find((b) => b.textContent!.includes('30'))!;
    thirty.click();
    expect(eng.setSleep).toHaveBeenCalledWith(30);
  });

  it('says the ready sentence under the row, and the scan’s card in its place (144)', async () => {
    st = radioState();
    st.nowPlaying!.scan = {
      available: true,
      reason: null,
      services: ['acoustid', 'audd'],
    } as never;
    boot();
    player!.expand();
    radioChrome!.draw();
    const words = tray('[data-player-rtray-scanwords]');
    expect(words.hidden).toBe(false);
    expect(words.dataset.kind).toBe('line');
    expect(words.textContent).toBe(
      'Not the track you hear? Scan now listens for 10 seconds and asks AcoustID, then AudD.',
    );
    st = { ...st, scanError: 'AudD refused the key · an admin can fix it in Settings → Radio' };
    radioChrome!.draw();
    expect(words.dataset.kind).toBe('card');
    expect(words.querySelector('.ss-player-rtray-scantitle')!.textContent).toBe('Scan didn’t work');
    const line = words.querySelector<HTMLElement>('.ss-player-rtray-scanline')!;
    expect(line.dataset.tone).toBe('danger');
    expect(words.textContent).not.toContain('Not the track you hear?');
  });

  it('heads the "…" menu "More for this station", with Show stepping aside (16b)', () => {
    boot();
    player!.expand();
    tray('[data-player-more]').click();
    const menu = $('#ss-player-menu');
    expect(menu.querySelector('[data-player-menu-head]')!.textContent).toBe(
      'More for this station',
    );
    expect(menu.querySelector<HTMLElement>('[data-player-menu-show]')!.hidden).toBe(true);
  });

  it('says "Your link" alone on a link’s row', async () => {
    localStorage.setItem(
      RECENT_STATIONS_KEY,
      JSON.stringify([
        { id: 'link-1', name: 'Lowlands Radio', source: 'your_link', added_by: 'ross' },
      ]),
    );
    boot();
    player!.expand();
    await flush();
    tray('[data-player-rtray-tab="recent"]').click();
    const rows = [
      ...document.querySelectorAll('[data-player-radio-tray] .ss-player-rtray-row-station'),
    ];
    const link = rows.find((r) => r.textContent!.includes('Lowlands Radio'))!;
    expect(link.querySelector('.ss-player-rtray-meta')!.textContent).toBe('Your link');
  });
});

describe('Stations from the server, per profile (142, 163)', () => {
  const kexp = {
    ...station({ id: 'kexp', name: 'KEXP', city: 'Seattle', logo_url: '' }),
    played_at: 1_700_000_500,
  };

  function withRecent(stations: unknown[], posted: string[] = []) {
    const orig = fetchImpl.getMockImplementation() as (
      url: string,
      init?: RequestInit,
    ) => Promise<Response>;
    fetchImpl.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/radio/recent') && init?.method === 'POST') {
        posted.push(init.body as string);
        return respond(200, { success: true, station_id: 'nts-1' });
      }
      if (url.includes('/api/radio/recent')) return respond(200, { success: true, stations });
      return orig(url, init);
    });
    return posted;
  }

  it('paints this browser’s list first, then merges the server’s and keeps it', async () => {
    localStorage.setItem(
      RECENT_STATIONS_KEY,
      JSON.stringify([{ id: 'fip-jazz', name: 'FIP Jazz', played_at: 1_700_000_100 }]),
    );
    withRecent([kexp]);
    boot();
    player!.expand();
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/api/radio/recent'),
      expect.anything(),
    );
    tray('[data-player-rtray-tab="recent"]').click();
    const names = [
      ...document.querySelectorAll('[data-player-radio-tray] .ss-player-rtray-row-station'),
    ].map((r) => r.querySelector('.ss-player-rtray-title')!.textContent);
    // NTS 1 is playing (just now), KEXP from the server, FIP Jazz from this browser
    expect(names).toEqual(['NTS 1', 'KEXP', 'FIP Jazz']);
    const kept = JSON.parse(localStorage.getItem(RECENT_STATIONS_KEY)!) as { id: string }[];
    expect(kept.map((s) => s.id)).toEqual(['nts-1', 'kexp', 'fip-jazz']);
  });

  it('keeps this browser’s list when the server doesn’t answer', async () => {
    localStorage.setItem(
      RECENT_STATIONS_KEY,
      JSON.stringify([{ id: 'fip-jazz', name: 'FIP Jazz' }]),
    );
    boot();
    player!.expand();
    await flush();
    tray('[data-player-rtray-tab="recent"]').click();
    expect(
      document.querySelectorAll('[data-player-radio-tray] .ss-player-rtray-row-station'),
    ).toHaveLength(2);
  });

  it('counts the station once it has played 30 s, once per session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const posted = withRecent([]);
      boot();
      await vi.advanceTimersByTimeAsync(29_000);
      expect(posted).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(posted).toEqual([JSON.stringify({ session_id: 's1' })]);
      radioChrome!.draw();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(posted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('doesn’t count a station stopped before 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const posted = withRecent([]);
      boot();
      await vi.advanceTimersByTimeAsync(10_000);
      st = { ...st, status: 'idle', sessionId: null } as RadioSessionState;
      window.dispatchEvent(new CustomEvent('ss:player', { detail: { reason: 'state' } }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
