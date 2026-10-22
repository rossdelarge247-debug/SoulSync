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
    expect(slot.querySelectorAll('button')).toHaveLength(1);
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
    expect(slot.querySelector('button')).toBeNull();
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
