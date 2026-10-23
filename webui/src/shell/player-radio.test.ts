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

function mount(st: RadioSessionState, fetchOverride?: typeof fetch) {
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
  const fetchImpl = fetchOverride ?? vi.fn(async () => new Response('{}', { status: 404 }));
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
    // the source phrase says who named it (HANDOFF 58)
    expect(slot.textContent).toMatch(/from the stream’s names · \d+ s ago/);
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
    const scanBtn = slot.querySelector<HTMLElement>('[data-player-radio-scan]')!;
    expect(scanBtn.getAttribute('aria-disabled')).toBe('true');
    expect(scanBtn.dataset.busy).toBe('listening');
    // the scan takes the track's place: its title over the 220px bar, and the action slot empties
    const block = slot.querySelector('.ss-player-radio-now')!;
    expect(block.querySelector('.ss-player-title')!.textContent).toBe(
      'Capturing 10 seconds · 6 s left',
    );
    expect(block.querySelector<HTMLElement>('.ss-player-radio-now-bar > span')!.style.width).toBe(
      '40%',
    );
    expect(slot.querySelector('[data-player-radio-add]')).toBeNull();
    expect(document.getElementById('ss-player-live')!.textContent).toMatch(
      /Listening to the station/,
    );
    // identifying: who is asked, and a spinner on the control
    st.scan = {
      ...st.scan!,
      phase: 'identifying',
      trying: 'audd',
      trying_label: 'AudD',
      asked: ['acoustid', 'audd'],
    };
    chrome!.draw();
    expect(slot.querySelector('.ss-player-radio-now')!.textContent).toBe(
      'Identifying…Asking AudD · AcoustID had no match',
    );
    expect(slot.querySelector('[data-player-radio-scan] .ss-player-radio-spinner')).not.toBeNull();
    expect(slot.querySelector('[data-player-radio-scan]')!.textContent).toBe('Identifying…');
    chrome!.dispose();
  });

  it('the answer sits in the track block with its source phrase, its own Add, and "Scan again"; no Done', async () => {
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
    const slot = document.querySelector('[data-player-action-slot]')!;
    expect(slot.textContent).toContain('Low Tide');
    expect(slot.textContent).toMatch(
      /Kelp · Shore · found by ACRCloud · Scan now · \d+ (s|min|h) ago/,
    );
    expect(slot.querySelector('[data-player-radio-scan]')!.textContent).toBe('Scan again');
    // the sheet's card says who found it at the start of its line
    expect(document.querySelector('[data-player-radio-panel]')!.textContent).toContain(
      'Found by ACRCloud · Scan now',
    );
    slot.querySelector<HTMLElement>('[data-player-radio-scan-add]')!.click();
    await Promise.resolve();
    expect(api.addScanToWanted).toHaveBeenCalled();
    // no Done anywhere, nor a second tag
    expect(document.body.textContent).not.toMatch(/\bDone\b/);
    expect(document.querySelector('[data-player-radio-scan-dismiss]')).toBeNull();
    expect(slot.querySelectorAll('.ss-player-tag')).toHaveLength(0);
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
    expect(
      document.querySelector('[data-player-action-slot] .ss-player-radio-now')!.textContent,
    ).toBe('Couldn’t identify thisDJ mixes and talk often can’t be');
    r.chrome!.dispose();
    r = mount(
      state({
        scan: {
          ...base,
          state: 'failed',
          reason: 'AudD refused the key. An admin can check it in Settings → Radio.',
          asked: ['audd'],
          provider_error: { provider: 'audd', label: 'AudD', kind: 'bad_key', message: 'x' },
        },
      }),
    );
    const block = document.querySelector('[data-player-action-slot] .ss-player-radio-now')!;
    expect(block.querySelector('.ss-player-title')!.textContent).toBe('Scan didn’t work');
    const meta = block.querySelector<HTMLElement>('.ss-player-meta')!;
    expect(meta.textContent).toBe('AudD refused the key · an admin can fix it in Settings → Radio');
    expect(meta.dataset.tone).toBe('danger');
    expect(
      document.querySelector('[data-player-action-slot] [data-player-radio-scan]')!.textContent,
    ).toBe('Scan again');
    r.chrome!.dispose();
  });
});

describe('the sheet’s auto-add confirm, in place (9c)', () => {
  const NUMBERS = {
    success: true,
    enabled: false,
    identified_yesterday: 61,
    already_have: 19,
    would_add: 42,
    would_add_without_limit: 42,
    daily_limit: 50,
    added_today: 0,
    can_download: true,
    has_now_playing: true,
  };

  function server(numbers: Record<string, unknown> = NUMBERS, putStatus = 200) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/auto-add') && method === 'GET')
        return new Response(JSON.stringify(numbers), { status: 200 });
      if (url.endsWith('/auto-add') && method === 'PUT')
        return new Response(
          JSON.stringify(
            putStatus === 200
              ? { ...numbers, enabled: true }
              : {
                  success: false,
                  error: 'no_download_rights',
                  message: 'Turning on auto-add needs download rights.',
                },
          ),
          { status: putStatus },
        );
      return new Response('{}', { status: 404 });
    });
    return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
  }

  const panel = () => document.querySelector<HTMLElement>('[data-player-radio-panel]')!;
  const sw = () => panel().querySelector<HTMLElement>('[role="switch"]');

  beforeEach(() => {
    window.showToast = vi.fn();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    window.showToast = undefined;
  });

  it('switching on swaps the switch row for the question and the three numbers', async () => {
    const { calls, fetchImpl } = server();
    const { chrome } = mount(state(), fetchImpl);
    sw()!.click();
    const card = await vi.waitFor(() => {
      const found = panel().querySelector<HTMLElement>('[role="group"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(sw()).toBeNull();
    expect(card.getAttribute('aria-labelledby')).toBeTruthy();
    expect(card.textContent).toContain(`Add everything NTS 1 ${EVIL} plays to Wanted?`);
    expect(card.textContent).toContain(
      'Skips what you have or already want, at your quality target. Stops at 50 a day. Shows in Activity.',
    );
    await vi.waitFor(() =>
      expect(
        [...card.ownerDocument.querySelectorAll('.ss-player-radio-tile')].map((t) => t.textContent),
      ).toEqual(['Identified yesterday61', 'You already have19', 'Would be added42']),
    );
    const buttons = [...panel().querySelectorAll('.ss-player-radio-confirm button')].map(
      (b) => b.textContent,
    );
    expect(buttons).toEqual([`Turn on auto-add for NTS 1 ${EVIL}`, 'Not now']);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    chrome!.dispose();
  });

  it('Turn on puts auto-add on and brings the switch back, on', async () => {
    const { calls, fetchImpl } = server();
    const { chrome } = mount(state(), fetchImpl);
    sw()!.click();
    const yes = await vi.waitFor(() => {
      const b = panel().querySelector<HTMLElement>('[data-player-radio-auto-confirm]');
      expect(b?.getAttribute('aria-disabled')).toBeNull();
      return b!;
    });
    yes.click();
    await vi.waitFor(() => expect(sw()?.getAttribute('aria-checked')).toBe('true'));
    expect(calls).toContainEqual({
      method: 'PUT',
      url: expect.stringMatching(/\/api\/radio\/stations\/nts-1\/auto-add$/),
      body: { enabled: true },
    });
    expect(window.showToast).toHaveBeenCalledWith(`Auto-add is on for NTS 1 ${EVIL}.`, 'success');
    chrome!.dispose();
  });

  it('Not now puts the switch row back, off, and turns nothing on', async () => {
    const { calls, fetchImpl } = server();
    const { chrome } = mount(state(), fetchImpl);
    sw()!.click();
    const no = await vi.waitFor(() => {
      const b = panel().querySelector<HTMLElement>('[data-player-radio-auto-cancel]');
      expect(b).not.toBeNull();
      return b!;
    });
    no.click();
    expect(sw()?.getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(sw());
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    chrome!.dispose();
  });

  it('a refusal stays in the card, in words', async () => {
    const { fetchImpl } = server(NUMBERS, 403);
    const { chrome } = mount(state(), fetchImpl);
    sw()!.click();
    const yes = await vi.waitFor(() => {
      const b = panel().querySelector<HTMLElement>('[data-player-radio-auto-confirm]');
      expect(b?.getAttribute('aria-disabled')).toBeNull();
      return b!;
    });
    yes.click();
    await vi.waitFor(() =>
      expect(panel().querySelector('.ss-player-radio-confirm-error')?.textContent).toBe(
        'Turning on auto-add needs download rights.',
      ),
    );
    chrome!.dispose();
  });

  it('a profile without download rights is told so, with Not now only', async () => {
    const { fetchImpl } = server({ ...NUMBERS, can_download: false });
    const { chrome } = mount(state(), fetchImpl);
    sw()!.click();
    await vi.waitFor(() =>
      expect(panel().textContent).toContain(
        'Auto-add needs download rights, so it can’t be turned on for your profile.',
      ),
    );
    expect(panel().querySelector('[data-player-radio-auto-confirm]')).toBeNull();
    chrome!.dispose();
  });

  it('turning off stays immediate, with no card', async () => {
    const st = state();
    st.station!.auto_add = true;
    const { calls, fetchImpl } = server();
    const { chrome } = mount(st, fetchImpl);
    expect(sw()?.getAttribute('aria-checked')).toBe('true');
    sw()!.click();
    await vi.waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        url: expect.stringMatching(/auto-add$/),
        body: { enabled: false },
      }),
    );
    await vi.waitFor(() => expect(sw()?.getAttribute('aria-checked')).toBe('false'));
    expect(panel().querySelector('.ss-player-radio-confirm')).toBeNull();
    chrome!.dispose();
  });
});
