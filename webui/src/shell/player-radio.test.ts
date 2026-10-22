import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RadioSessionApi, RadioSessionState } from '@/features/radio/radio.types';

import { bootRadioChrome, radioMiniLines } from './player-radio';

const EVIL = '<img src=x onerror="window.__pwned=1">';

function state(over: Partial<RadioSessionState> = {}): RadioSessionState {
  return {
    status: 'playing',
    station: {
      id: 'nts-1',
      name: `NTS 1 ${EVIL}`,
      kind: 'eclectic',
      kind_label: 'Eclectic tastemakers',
      genre: 'Eclectic',
      city: 'London',
      country: '',
      logo_url: '',
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
      streams: [],
    },
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
      track: {
        artist: `Tidewater ${EVIL}`,
        title: 'Night Ferry (Dub)',
        release: null,
        art_url: null,
      },
      source: 'stream_titles',
      identified_at: Date.now() / 1000 - 12,
      started_at: null,
      reason: null,
      library: { in_library: false, below_target: null, track_id: null },
      on_wanted: false,
      previous_title: null,
      now: Date.now() / 1000,
      playing: true,
      heard_id: 9,
    },
    error: null,
    skew: 0,
    adding: false,
    ...over,
  };
}

function mount(st: RadioSessionState) {
  document.body.innerHTML = `
    <section id="media-player" class="ss-player" data-source="radio">
      <div class="ss-player-bar">
        <button data-player-toggle class="ss-player-now"></button>
        <div class="ss-player-centre"><div data-player-meter></div><div data-player-action-slot hidden></div></div>
        <div class="ss-player-side"><a data-player-station href="/radio">Station</a>
          <button data-player-radio-stop>Stop</button></div>
      </div>
      <div class="ss-player-mini"><div data-player-mini-slot></div></div>
      <div id="ss-player-tray"><button data-player-sheet-close>Close</button><div data-player-radio-panel></div></div>
    </section>`;
  const api: RadioSessionApi = {
    state: () => st,
    play: vi.fn(),
    stop: vi.fn(async () => undefined),
    retry: vi.fn(),
    addToWanted: vi.fn(async () => true),
    refresh: vi.fn(),
  };
  const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 }));
  const chrome = bootRadioChrome({
    radio: () => api,
    analyser: () => null,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { api, chrome };
}

describe('the player’s radio mode', () => {
  beforeEach(() => {
    window.showToast = vi.fn();
    (window as unknown as { __pwned?: number }).__pwned = undefined;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    window.showToast = undefined;
  });

  it('shows the identified track and ONE primary action in the bar', () => {
    const { chrome } = mount(state());
    const slot = document.querySelector('[data-player-action-slot]')!;
    expect(slot.textContent).toContain('Night Ferry (Dub)');
    expect(slot.textContent).toMatch(/identified \d+ s ago/);
    // ONE action; Scan now sits beside it
    expect(slot.querySelectorAll('button:not([data-player-radio-scan])')).toHaveLength(1);
    expect(slot.querySelector('button')!.textContent).toBe('Add to Wanted');
    chrome!.dispose();
  });

  it('puts station and track text in as text, never markup', () => {
    const { chrome } = mount(state());
    expect(document.querySelector('#media-player img')).toBeNull();
    // the words arrive as text (an attribute may quote them; that's still text)
    expect(document.querySelector('[data-player-action-slot]')!.textContent).toContain(
      '<img src=x',
    );
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    chrome!.dispose();
  });

  it('shows the In your library tag instead of Add', () => {
    const st = state();
    st.nowPlaying!.library = { in_library: true, below_target: false, track_id: '1' };
    const { chrome } = mount(st);
    const slot = document.querySelector('[data-player-action-slot]')!;
    expect(slot.querySelector('button:not([data-player-radio-scan])')).toBeNull();
    expect(slot.textContent).toContain('In your library');
    chrome!.dispose();
  });

  it('Add and Stop call the session', async () => {
    const { api, chrome } = mount(state());
    (document.querySelector('[data-player-action-slot] button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(api.addToWanted).toHaveBeenCalled());
    (
      document.querySelector('.ss-player-side [data-player-radio-stop]') as HTMLButtonElement
    ).click();
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalled());
    chrome!.dispose();
  });

  it('draws the phone sheet: card, Add, the auto-add switch and the Heard link', () => {
    const { chrome } = mount(state());
    const panel = document.querySelector('[data-player-radio-panel]')!;
    expect(panel.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    expect(panel.textContent).toContain('Auto-add what NTS 1');
    expect(panel.textContent).toContain('Heard on NTS 1');
    expect(panel.querySelector('[data-player-radio-add]')?.textContent).toBe('Add to Wanted');
    chrome!.dispose();
  });

  it('writes the mini bar’s two lines', () => {
    const lines = radioMiniLines(state());
    expect(lines?.title).toBe(`Night Ferry (Dub) · Tidewater ${EVIL}`);
    expect(lines?.meta).toMatch(/· Live · not in your library$/);
    expect(radioMiniLines(state({ nowPlaying: null }))?.meta).toMatch(/listening…$/);
  });
});

describe('Scan now in the player', () => {
  it('the phone’s mini bar says when a scan listens and what it found', () => {
    const listening = state({ scanStarting: true });
    expect(radioMiniLines(listening)!.meta).toMatch(/scanning…$/);
    const found = state({
      scan: {
        scan_id: 'sc1',
        station_id: 'nts-1',
        state: 'identified',
        phase: 'identifying',
        trying: null,
        trying_label: null,
        progress: 1,
        capture_seconds: 10,
        seconds_left: 0,
        track: { artist: 'Kelp', title: 'Low Tide', release: null },
        source: 'scan_acrcloud',
        source_label: 'ACRCloud',
        heard_id: 3,
        library: null,
        on_wanted: false,
        reason: null,
        provider_error: null,
        asked: [],
        started_at: 1,
        finished_at: 2,
        now: 3,
      },
    });
    expect(radioMiniLines(found)).toEqual({
      title: 'Low Tide · Kelp',
      meta: expect.stringMatching(/found by ACRCloud$/),
    });
  });

  beforeEach(() => {
    window.showToast = vi.fn();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    window.showToast = undefined;
  });

  it('puts Scan now beside the bar’s action and in the sheet, and calls the session', async () => {
    const { api, chrome } = mount(state());
    api.scanNow = vi.fn(async () => undefined);
    const bar = document.querySelector<HTMLElement>(
      '[data-player-action-slot] [data-player-radio-scan]',
    )!;
    expect(bar.textContent).toBe('Scan now');
    expect(bar.getAttribute('aria-disabled')).toBeNull();
    expect(
      document.querySelector('[data-player-radio-panel] [data-player-radio-scan]'),
    ).not.toBeNull();
    bar.click();
    await Promise.resolve();
    expect(api.scanNow).toHaveBeenCalledTimes(1);
    chrome!.dispose();
  });

  it('is disabled with the reason when no service is set up', async () => {
    const st = state();
    st.nowPlaying!.scan = {
      available: false,
      reason: 'No identification service is set up.',
      services: [],
    };
    const { api, chrome } = mount(st);
    api.scanNow = vi.fn(async () => undefined);
    const bar = document.querySelector<HTMLElement>(
      '[data-player-action-slot] [data-player-radio-scan]',
    )!;
    expect(bar.getAttribute('aria-disabled')).toBe('true');
    expect(bar.title).toBe('No identification service is set up.');
    expect(document.querySelector('[data-player-radio-panel]')!.textContent).toContain(
      'No identification service is set up.',
    );
    bar.click();
    await Promise.resolve();
    expect(api.scanNow).not.toHaveBeenCalled();
    chrome!.dispose();
  });

  it('shows Listening… with the seconds left, announced in the live region', () => {
    const st = state();
    const { chrome } = mount(st);
    const live = document.createElement('span');
    live.id = 'ss-player-live';
    document.body.append(live);
    st.scan = {
      scan_id: 'sc1',
      station_id: 'nts-1',
      state: 'listening',
      phase: 'capturing',
      trying: null,
      trying_label: null,
      progress: 0.4,
      capture_seconds: 10,
      seconds_left: 6,
      track: null,
      source: null,
      source_label: null,
      heard_id: null,
      library: null,
      on_wanted: false,
      reason: null,
      provider_error: null,
      asked: [],
      started_at: 1,
      finished_at: null,
      now: 2,
    };
    chrome!.draw();
    const slot = document.querySelector('[data-player-action-slot]')!;
    expect(slot.textContent).toContain('Listening…');
    expect(slot.textContent).toContain('Capturing 10 seconds · 6 s left');
    expect(slot.querySelector('[data-player-radio-scan]')!.getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(document.getElementById('ss-player-live')!.textContent).toMatch(
      /Listening to the station/,
    );
    chrome!.dispose();
  });

  it('shows what the scan found with its own Add, and Done in the sheet', async () => {
    const st = state({
      scan: {
        scan_id: 'sc1',
        station_id: 'nts-1',
        state: 'identified',
        phase: 'identifying',
        trying: null,
        trying_label: null,
        progress: 1,
        capture_seconds: 10,
        seconds_left: 0,
        track: { artist: 'Kelp', title: 'Low Tide', release: 'Shore' },
        source: 'scan_acrcloud',
        source_label: 'ACRCloud',
        heard_id: 31,
        library: { in_library: false, below_target: null, track_id: null },
        on_wanted: false,
        reason: null,
        provider_error: null,
        asked: ['acoustid', 'acrcloud'],
        started_at: 1,
        finished_at: 3,
        now: 4,
      },
    });
    const { api, chrome } = mount(st);
    api.addScanToWanted = vi.fn(async () => true);
    api.dismissScan = vi.fn();
    const slot = document.querySelector('[data-player-action-slot]')!;
    expect(slot.textContent).toContain('Low Tide');
    expect(slot.textContent).toContain('Kelp · found by ACRCloud');
    slot.querySelector<HTMLElement>('[data-player-radio-scan-add]')!.click();
    await Promise.resolve();
    expect(api.addScanToWanted).toHaveBeenCalled();
    document.querySelector<HTMLElement>('[data-player-radio-scan-dismiss]')!.click();
    await Promise.resolve();
    expect(api.dismissScan).toHaveBeenCalled();
    chrome!.dispose();
  });

  it('says Not found calmly and a failure in plain words', () => {
    const base = {
      scan_id: 'sc1',
      station_id: 'nts-1',
      phase: 'identifying' as const,
      trying: null,
      trying_label: null,
      progress: 1,
      capture_seconds: 10,
      seconds_left: 0,
      track: null,
      source: null,
      source_label: null,
      heard_id: null,
      library: null,
      on_wanted: false,
      provider_error: null,
      asked: [],
      started_at: 1,
      finished_at: 3,
      now: 4,
    };
    let r = mount(
      state({
        scan: {
          ...base,
          state: 'not_found',
          reason: 'Couldn’t identify this — DJ mixes and talk often can’t be.',
        },
      }),
    );
    expect(document.querySelector('[data-player-radio-panel]')!.textContent).toContain(
      'DJ mixes and talk',
    );
    r.chrome!.dispose();
    r = mount(
      state({
        scan: {
          ...base,
          state: 'failed',
          reason: 'AudD says this account has no requests left for now.',
        },
      }),
    );
    expect(document.querySelector('[data-player-action-slot]')!.textContent).toContain(
      'no requests left',
    );
    r.chrome!.dispose();
  });
});
