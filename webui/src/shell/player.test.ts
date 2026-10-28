/**
 * The player's chrome (board 6a) against the real markup from index.html,
 * over a fake engine: collapsed by default and remembered, aria-expanded on
 * every toggle, Escape, the source kinds, the waveform slider, what it fetches,
 * the phone sheet, and that every feature of the old player kept a control.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractFunction } from '../test/vanilla-extract';
import { bootPlayer, type PlayerChrome, type PlayerEngine, type PlayerSnapshot } from './player';
import { PLAYER_STATE_KEY } from './player-state';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
let parsed: Document | null = null;

function mount() {
  parsed ??= new DOMParser().parseFromString(html, 'text/html');
  const take = (sel: string) => document.importNode(parsed!.querySelector(sel)!, true);
  document.body.replaceChildren(
    take('#audio-player'),
    take('#media-player'),
    take('[data-player-scrim]'),
    take('#np-modal-overlay'),
  );
}

function snapshot(over: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    track: { id: 42, title: 'Halcyon', artist: 'Orbital', album: 'Brown Album' },
    kind: 'library',
    playing: true,
    buffering: false,
    loading: { active: false, text: '', progress: 0 },
    queue: [{ id: 41 }, { id: 42 }, { id: 43 }, { id: 44 }],
    index: 1,
    canPrevious: true,
    canNext: true,
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
    sleepSteps: [0, 15, 30, 60, 'track'],
    lyrics: { synced: false, lines: 0, loading: false, status: '' },
    reportable: true,
    playlistTrack: null,
    ...over,
  };
}

function fakeAudio(duration = 200, currentTime = 50) {
  return Object.assign(new EventTarget(), { duration, currentTime }) as unknown as HTMLAudioElement;
}

function fakeEngine(state: PlayerSnapshot, audio = fakeAudio()) {
  const engine = {
    current: state,
    state: () => engine.current,
    audio: () => audio,
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
  return engine;
}

type FakeEngine = ReturnType<typeof fakeEngine>;

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let chrome: PlayerChrome | null = null;
let fetchImpl: ReturnType<typeof vi.fn>;

function boot(engine: FakeEngine) {
  chrome = bootPlayer({ engine: engine as unknown as PlayerEngine, fetchImpl: fetchImpl as never });
  return chrome!;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const press = (key: string, target: EventTarget = document) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

beforeEach(() => {
  mount();
  localStorage.clear();
  fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith('/details')) {
      return respond(200, {
        format: 'FLAC',
        bitrate_kbps: 2304,
        bit_depth: 24,
        sample_rate: 96000,
        path_label: 'Library',
        album: 'Brown Album',
        year: 1993,
        track_number: 3,
        album_track_count: 11,
        quality: { at_target: true, target_name: 'Lossless' },
      });
    }
    if (url.endsWith('/peaks')) return respond(200, { peaks: [0.2, 0.9, 0.4], duration_s: 200 });
    if (url.startsWith('/api/player/recent')) return respond(200, { items: [] });
    return respond(404, {});
  });
});

afterEach(() => {
  chrome?.destroy();
  chrome = null;
  delete (window as { matchMedia?: unknown }).matchMedia;
  document.documentElement.removeAttribute('data-player');
});

describe('collapsed or expanded', () => {
  it('starts as the bar and every toggle says so', () => {
    boot(fakeEngine(snapshot()));
    expect(document.documentElement.dataset.player).toBe('bar');
    expect($('#ss-player-tray').hidden).toBe(true);
    const toggles = document.querySelectorAll('[data-player-toggle], [data-player-upnext]');
    expect(toggles.length).toBeGreaterThanOrEqual(3);
    for (const t of toggles) {
      expect(t.getAttribute('aria-expanded')).toBe('false');
      expect(t.getAttribute('aria-controls')).toBe('ss-player-tray');
    }
  });

  it('Expand opens the tray, is remembered per browser, and Collapse goes back', () => {
    const engine = fakeEngine(snapshot());
    boot(engine);
    $('.ss-player-bar [data-player-toggle].ss-player-ghost').click();
    expect(document.documentElement.dataset.player).toBe('tray');
    expect($('#ss-player-tray').hidden).toBe(false);
    expect(localStorage.getItem(PLAYER_STATE_KEY)).toBe('1');
    expect(engine.setExpanded).toHaveBeenLastCalledWith(true);
    for (const t of document.querySelectorAll('[data-player-toggle]'))
      expect(t.getAttribute('aria-expanded')).toBe('true');
    // focus lands on the tray's labelled Collapse
    expect(document.activeElement?.classList.contains('ss-player-collapse')).toBe(true);
    expect(document.activeElement?.textContent).toMatch(/Collapse/);

    $<HTMLButtonElement>('.ss-player-collapse').click();
    expect(document.documentElement.dataset.player).toBe('bar');
    expect(localStorage.getItem(PLAYER_STATE_KEY)).toBeNull();
  });

  it('a remembered tray comes back expanded on the next visit', () => {
    localStorage.setItem(PLAYER_STATE_KEY, '1');
    boot(fakeEngine(snapshot()));
    expect(document.documentElement.dataset.player).toBe('tray');
    expect($('#ss-player-tray').hidden).toBe(false);
  });

  it('Escape collapses the tray', () => {
    localStorage.setItem(PLAYER_STATE_KEY, '1');
    boot(fakeEngine(snapshot()));
    press('Escape');
    expect(document.documentElement.dataset.player).toBe('bar');
  });

  it('Escape closes an open menu before it touches the tray', () => {
    localStorage.setItem(PLAYER_STATE_KEY, '1');
    boot(fakeEngine(snapshot()));
    $('[data-player-more]').click();
    expect($('#ss-player-menu').hidden).toBe(false);
    press('Escape');
    expect($('#ss-player-menu').hidden).toBe(true);
    expect(document.documentElement.dataset.player).toBe('tray');
  });

  it('with nothing playing the player is gone, but the remembered state is kept', () => {
    localStorage.setItem(PLAYER_STATE_KEY, '1');
    boot(fakeEngine(snapshot({ track: null, kind: null, queue: [], index: -1 })));
    expect(document.documentElement.hasAttribute('data-player')).toBe(false);
    expect($('#ss-player-tray').hidden).toBe(true);
    expect(localStorage.getItem(PLAYER_STATE_KEY)).toBe('1');
  });

  it('the old globals open and close it', () => {
    boot(fakeEngine(snapshot()));
    expect(window.SoulSyncPlayerChrome).toBe(chrome);
    window.SoulSyncPlayerChrome!.expand();
    expect(chrome!.isExpanded()).toBe(true);
    window.SoulSyncPlayerChrome!.collapse();
    expect(chrome!.isExpanded()).toBe(false);
  });
});

describe('source kinds', () => {
  const visible = (sel: string) => !$(sel).hidden;

  it('a library track: Previous / Next, times, a waveform, no speed button', async () => {
    boot(fakeEngine(snapshot()));
    const bar = '.ss-player-bar ';
    expect($('#media-player').dataset.source).toBe('library');
    expect(visible(bar + '[data-player-action="previous"]')).toBe(true);
    expect(visible(bar + '[data-player-action="next"]')).toBe(true);
    expect(visible(bar + '[data-player-action="back"]')).toBe(false);
    expect(visible(bar + '[data-player-action="speed"]')).toBe(false);
    expect(visible(bar + '[data-player-wave]')).toBe(true);
    expect(visible(bar + '[data-player-live]')).toBe(false);
    expect(visible(bar + '[data-player-meter]')).toBe(false);
    expect($(bar + '[data-player-total]').textContent).toBe('3:20');
  });

  it('a podcast: −15 s / +30 s, the speed button, chapter ticks, nothing fetched from the library', async () => {
    const engine = fakeEngine(
      snapshot({
        kind: 'podcast',
        track: {
          title: 'Episode 12',
          artist: 'The Show',
          kind: 'podcast',
          media_id: 'guid-12',
          chapters: [
            { start: 0, title: 'Intro' },
            { start: 100, title: 'Interview' },
          ],
        },
        queue: [{ title: 'Episode 12' }],
        index: 0,
      }),
    );
    boot(engine);
    const bar = '.ss-player-bar ';
    expect($('#media-player').dataset.source).toBe('podcast');
    expect(visible(bar + '[data-player-action="previous"]')).toBe(false);
    expect(visible(bar + '[data-player-action="back"]')).toBe(true);
    expect(visible(bar + '[data-player-action="forward"]')).toBe(true);
    expect(visible(bar + '[data-player-action="speed"]')).toBe(true);
    expect($(bar + '[data-player-action="speed"]').textContent).toBe('1×');
    const ticks = document.querySelectorAll<HTMLElement>(bar + '.ss-player-wave-tick');
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.style.left).toBe('50%');
    expect(ticks[0]!.title).toBe('Interview');
    $(bar + '[data-player-action="back"]').click();
    $(bar + '[data-player-action="forward"]').click();
    expect(engine.skip).toHaveBeenNthCalledWith(1, -15);
    expect(engine.skip).toHaveBeenNthCalledWith(2, 30);
    // the mini bar's one action is +30 s
    expect($('[data-player-action="mini"]').getAttribute('aria-label')).toBe('Forward 30 seconds');
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('radio (the seam): a Live tag instead of times, a level meter instead of the waveform', () => {
    boot(
      fakeEngine(
        snapshot({
          kind: 'radio',
          track: { title: 'Station', kind: 'radio' },
          queue: [],
          index: -1,
        }),
      ),
    );
    const bar = '.ss-player-bar ';
    expect(visible(bar + '[data-player-live]')).toBe(true);
    expect(visible(bar + '[data-player-elapsed]')).toBe(false);
    expect(visible(bar + '[data-player-total]')).toBe(false);
    expect(visible(bar + '[data-player-wave]')).toBe(false);
    expect(visible(bar + '[data-player-meter]')).toBe(true);
    expect(visible(bar + '[data-player-action="previous"]')).toBe(false);
    // the action slot only shows once the radio build puts its action in it
    expect(visible(bar + '[data-player-action-slot]')).toBe(false);
  });
});

describe('the waveform slider', () => {
  it('is a labelled slider with values, moved by the keyboard', () => {
    const engine = fakeEngine(snapshot());
    boot(engine);
    const wave = $('.ss-player-bar [data-player-wave]');
    expect(wave.getAttribute('role')).toBe('slider');
    expect(wave.getAttribute('aria-label')).toBe('Position');
    expect(wave.getAttribute('aria-valuemax')).toBe('200');
    expect(wave.getAttribute('aria-valuenow')).toBe('50');
    expect(wave.getAttribute('aria-valuetext')).toBe('50 seconds of 3 minutes 20 seconds');
    wave.focus();
    press('ArrowRight', wave);
    expect(engine.seek).toHaveBeenLastCalledWith(55);
    expect(wave.getAttribute('aria-valuenow')).toBe('55');
    press('Home', wave);
    expect(engine.seek).toHaveBeenLastCalledWith(0);
    press('PageUp', wave);
    expect(engine.seek).toHaveBeenLastCalledWith(80);
  });

  it("the running time doesn't rewrite a focused slider's values", () => {
    const audio = fakeAudio(200, 50);
    boot(fakeEngine(snapshot(), audio));
    const wave = $('.ss-player-bar [data-player-wave]');
    wave.focus();
    (audio as unknown as { currentTime: number }).currentTime = 51;
    audio.dispatchEvent(new Event('timeupdate'));
    expect(wave.getAttribute('aria-valuenow')).toBe('50');
    // the visible clock still moves
    expect($('.ss-player-bar [data-player-elapsed]').textContent).toBe('0:51');
  });

  it('draws the peaks the server worked out, and asks again while they are pending', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      fetchImpl.mockImplementation(async (url: string) => {
        if (url.endsWith('/peaks')) {
          calls += 1;
          return calls === 1
            ? respond(202, { success: true, pending: true })
            : respond(200, { peaks: [0.5, 1], duration_s: 200 });
        }
        return respond(404, {});
      });
      boot(fakeEngine(snapshot()));
      expect(fetchImpl).toHaveBeenCalledWith('/api/library/tracks/42/peaks');
      await vi.advanceTimersByTimeAsync(0);
      expect($('.ss-player-bar [data-player-wave]').dataset.empty).toBe('true');
      await vi.advanceTimersByTimeAsync(1600);
      expect(calls).toBe(2);
      expect($('.ss-player-bar [data-player-wave]').dataset.empty).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what the tray reads from the server', () => {
  it('the readout: format, bit depth / sample rate, bitrate, where it plays from', async () => {
    boot(fakeEngine(snapshot()));
    await flush();
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith('/api/library/tracks/42/details');
    expect($('[data-player-format]').textContent).toBe('FLAC 24/96 · 2,304 kbps');
    expect($('[data-player-path]').textContent).toBe('Library → This device');
    expect($('[data-player-album-line]').textContent).toBe('Brown Album · 1993 · track 3 of 11');
    expect($('[data-player-quality]').textContent).toBe('At your target');
    expect($('.ss-player-bar [data-player-meta]').textContent).toBe('Orbital · FLAC 24/96');
  });

  it('Recent reads the listening history when its tab is chosen', async () => {
    fetchImpl.mockImplementation(async (url: string) =>
      url.startsWith('/api/player/recent')
        ? respond(200, {
            items: [
              {
                track_id: '7',
                title: 'Belfast',
                artist: 'Orbital',
                format: 'FLAC',
                played_at: null,
              },
            ],
          })
        : respond(404, {}),
    );
    boot(fakeEngine(snapshot()));
    window.dispatchEvent(new CustomEvent('ss:player-view', { detail: { view: 'history' } }));
    await flush();
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith('/api/player/recent?limit=20');
    expect($('[data-player-recent-list]').textContent).toContain('Belfast');
  });

  it('Recent shows every kind: an episode plays again from where you left it (HANDOFF 46)', async () => {
    fetchImpl.mockImplementation(async (url: string) =>
      url.startsWith('/api/player/recent')
        ? respond(200, {
            items: [
              {
                kind: 'podcast',
                media_id: 'guid-12',
                title: 'Episode 12',
                subtitle: 'Quiet Rooms',
                src: 'https://cdn.example/ep12.mp3',
                duration_s: 1800,
                position_s: 420,
                played_at: null,
              },
              {
                kind: 'music',
                track_id: '7',
                title: 'Belfast',
                artist: 'Orbital',
                played_at: null,
              },
            ],
          })
        : respond(404, {}),
    );
    const engine = Object.assign(fakeEngine(snapshot()), { playMedia: vi.fn(async () => ({})) });
    boot(engine);
    window.dispatchEvent(new CustomEvent('ss:player-view', { detail: { view: 'history' } }));
    await flush();
    await flush();
    const rows = document.querySelectorAll('[data-player-recent-list] .ss-player-recent-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Podcast · Quiet Rooms · 23 min left');
    expect(rows[1].textContent).toContain('Belfast');
    rows[0].querySelector<HTMLButtonElement>('.ss-player-recent-play')!.click();
    expect(engine.playMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'podcast',
        id: 'guid-12',
        src: 'https://cdn.example/ep12.mp3',
      }),
    );
  });

  it('the Output button stays hidden when the browser has nowhere else to send the sound', () => {
    boot(fakeEngine(snapshot()));
    for (const b of document.querySelectorAll<HTMLElement>('[data-player-output]'))
      expect(b.hidden).toBe(true);
  });
});

describe('the phone (≤768px)', () => {
  function phone() {
    const listeners: (() => void)[] = [];
    (window as { matchMedia?: unknown }).matchMedia = () => ({
      matches: true,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => undefined,
    });
  }

  it('the mini bar opens the sheet as a dialog; Escape closes it and focus goes back', () => {
    phone();
    boot(fakeEngine(snapshot()));
    const open = $('[data-player-sheet-open]');
    open.focus();
    open.click();
    expect(document.documentElement.hasAttribute('data-player-sheet')).toBe(true);
    expect($('#ss-player-tray').hidden).toBe(false);
    expect($('#ss-player-tray').getAttribute('role')).toBe('dialog');
    expect(open.getAttribute('aria-expanded')).toBe('true');
    press('Escape');
    expect(document.documentElement.hasAttribute('data-player-sheet')).toBe(false);
    expect($('#ss-player-tray').hidden).toBe(true);
    expect(document.activeElement).toBe(open);
  });

  it("the sheet isn't remembered: a desktop tray choice doesn't open it", () => {
    localStorage.setItem(PLAYER_STATE_KEY, '1');
    phone();
    boot(fakeEngine(snapshot()));
    expect(document.documentElement.hasAttribute('data-player-sheet')).toBe(false);
    expect($('#ss-player-tray').hidden).toBe(true);
  });
});

/**
 * Where each old feature went (docs/design/HANDOFF.md, "the player (6a)"):
 * every control of media-player.js and media-player-v2.js has a home in the
 * new markup, by the id or hook the engines drive.
 */
describe('nothing of the old player was dropped', () => {
  const homes: [string, string][] = [
    [
      'play / pause, previous, next',
      '[data-player-action="toggle"], [data-player-action="previous"], [data-player-action="next"]',
    ],
    ['seek', '[data-player-wave][role="slider"]'],
    ['volume and mute', '[data-player-volume], [data-player-action="mute"]'],
    ['shuffle and repeat', '[data-player-action="shuffle"], [data-player-action="repeat"]'],
    ['the queue: reorder, remove, clear', '#np-queue-list, #np-queue-clear'],
    ['clear played', '#np-queue-clear-played'],
    ['Shuffle your library (radio mode)', '#np-radio-btn'],
    ['download missing queue tracks', '#np-autodownload-btn'],
    ['sleep timer (on the record, 9d)', '[data-player-sleep], #ss-player-sleep-menu'],
    ['speed', '[data-player-menu="speed"], #np-v2-speed-select'],
    ['lyrics', '#np-lyrics-panel'],
    ['track details and copy', '#np-v2-details-panel'],
    ['history (now Recent)', '#np-v2-history-panel'],
    ['EQ', '#np-v2-eq-btn'],
    ['A-B loop', '#np-v2-ab-btn, #np-v2-ab-indicator'],
    ['visuals (the old theater)', '#np-modal-overlay #np-v2-bg, [data-player-menu="visuals"]'],
    ['player settings', '#np-v2-settings-panel'],
    ['keyboard shortcuts list', '#np-v2-shorts-btn'],
    ['add to playlist (on the record, 9d)', '[data-player-record="playlist"]'],
    ['report a problem', '[data-player-menu="report"]'],
    ['stop', '[data-player-menu="stop"]'],
    ['go to artist / album', '[data-player-artist], [data-player-album]'],
    ['album art (the palette and the vinyl read it)', '#np-album-art'],
    ['loading progress', '#loading-animation'],
  ];

  it.each(homes)('%s', (_name, sel) => {
    parsed ??= new DOMParser().parseFromString(html, 'text/html');
    for (const one of sel.split(', '))
      expect(parsed.querySelector(one), `${one} is missing`).not.toBeNull();
  });
});

describe('the record (HANDOFF 47, board 9d)', () => {
  it('has the quality line, then the star, Add to playlist, Sleep timer and "…" at the right end', () => {
    window.openAddToPlaylist = vi.fn() as never;
    boot(fakeEngine(snapshot({ playlistTrack: { id: '42', title: 'Halcyon' } })));
    const row = $('.ss-player-record-controls');
    const order = [...row.children].map((el) => el.getAttribute('aria-label') ?? el.className);
    expect(order).toEqual([
      // 28c: the star's slot (player-star.ts fills it)
      'ss-player-star-slot',
      'Add to playlist',
      'Sleep timer, off',
      'ss-player-spacer',
      'More for Halcyon',
    ]);
    expect($('[data-player-record="playlist"]').hidden).toBe(false);
    // the tag and Open album share the line above, without the "…"
    expect($('.ss-player-record-tags [data-player-more]')).toBeNull();
    expect($('.ss-player-record-tags [data-player-album]')).not.toBeNull();
    delete (window as { openAddToPlaylist?: unknown }).openAddToPlaylist;
  });

  it('hides Add to playlist when the track can’t go on one', () => {
    boot(fakeEngine(snapshot({ playlistTrack: null })));
    expect($('[data-player-record="playlist"]').hidden).toBe(true);
  });

  it('Add to playlist opens the playlist picker at the button', () => {
    const open = vi.fn();
    window.openAddToPlaylist = open as never;
    boot(fakeEngine(snapshot({ playlistTrack: { id: '42', title: 'Halcyon' } })));
    $('[data-player-record="playlist"]').click();
    expect(open).toHaveBeenCalledWith(
      { id: '42', title: 'Halcyon' },
      $('[data-player-record="playlist"]'),
    );
    delete (window as { openAddToPlaylist?: unknown }).openAddToPlaylist;
  });

  it('Sleep timer is an icon while off, and shows the time left, selected, while it runs', () => {
    const engine = fakeEngine(snapshot());
    boot(engine);
    const sleep = $('[data-player-sleep]');
    const left = $('[data-player-sleep-left]');
    expect(sleep.getAttribute('aria-pressed')).toBe('false');
    expect(left.hidden).toBe(true);
    engine.current = snapshot({ sleep: 30, sleepEndsAt: Date.now() + 23 * 60000 - 1000 });
    window.dispatchEvent(new CustomEvent('ss:player', { detail: { reason: 'sleep' } }));
    expect(sleep.getAttribute('aria-pressed')).toBe('true');
    expect(left.hidden).toBe(false);
    expect(left.textContent).toBe('23 min');
    expect(sleep.getAttribute('aria-label')).toBe('Sleep timer, 23 minutes left');
    engine.current = snapshot({ sleep: 'track' });
    window.dispatchEvent(new CustomEvent('ss:player', { detail: { reason: 'sleep' } }));
    expect(left.textContent).toBe('End of track');
  });

  it('Sleep timer opens its choices and sets one', () => {
    const engine = fakeEngine(snapshot());
    boot(engine);
    const sleep = $('[data-player-sleep]');
    sleep.click();
    const menu = $('#ss-player-sleep-menu');
    expect(menu.hidden).toBe(false);
    expect(sleep.getAttribute('aria-expanded')).toBe('true');
    const choices = [...menu.querySelectorAll('[role="radio"]')].map((b) => b.textContent);
    expect(choices).toEqual([
      'Off',
      '15 minutes',
      '30 minutes',
      '1 hour',
      'At the end of this track',
    ]);
    (menu.querySelector('[data-value="30"]') as HTMLElement).click();
    expect(engine.setSleep).toHaveBeenCalledWith(30);
    expect(menu.hidden).toBe(true);
    expect(sleep.getAttribute('aria-expanded')).toBe('false');
  });

  it('groups the "…" under Playback, Show and Queue, then Player settings and Report a problem', () => {
    boot(fakeEngine(snapshot()));
    $('[data-player-more]').click();
    const menu = $('#ss-player-menu');
    const lines = [...menu.children]
      .filter((el) => !(el as HTMLElement).hidden && !el.classList.contains('ss-player-choices'))
      .map((el) =>
        el.classList.contains('ss-player-menu-rule')
          ? '—'
          : el.tagName === 'P'
            ? `# ${el.textContent}`
            : (el.firstChild?.textContent ?? '').trim(),
      );
    expect(lines).toEqual([
      '# Playback',
      'Speed',
      'Equalizer',
      'A–B loop',
      'Add similar tracks when the queue ends',
      '# Show',
      'Lyrics',
      'Track details',
      'Visuals',
      'Keyboard shortcuts',
      '# Queue',
      'Clear played tracks',
      'Download missing queue tracks',
      'Stop and clear the queue',
      '—',
      'Player settings',
      'Report a problem',
    ]);
    // nothing promoted to the record is left in the menu
    expect(menu.textContent).not.toContain('Sleep timer');
    expect(menu.textContent).not.toContain('Add to playlist');
  });

  it('shows values in meta on the right and keys as kbd', () => {
    const engine = fakeEngine(snapshot({ crossfade: true, crossfadeSeconds: 4, radio: false }));
    window.npV2 = { getSpeed: () => 1, getEq: () => ({ on: true, preset: 'Flat' }) };
    boot(engine);
    $('[data-player-more]').click();
    const state = (sel: string) => $(sel).textContent;
    expect(state('[data-player-speed-state]')).toBe('1.0×');
    expect(state('[data-player-eq-state]')).toBe('Flat');
    expect(state('[data-player-radio-state]')).toBe('Off');
    expect($('[data-player-menu="visuals"] kbd').textContent).toBe('F');
    expect($('#np-v2-shorts-btn kbd').textContent).toBe('?');
    engine.current = snapshot({ crossfade: false, radio: true });
    window.npV2 = { getSpeed: () => 1.25, getEq: () => ({ on: false, preset: 'Bass' }) };
    window.dispatchEvent(new CustomEvent('ss:player', { detail: { reason: 'state' } }));
    // no Crossfade in the "…" (Ross, 27 October: Between tracks is Off or Auto mix)
    expect(document.querySelector('[data-player-menu="crossfade"]')).toBeNull();
    expect(state('[data-player-speed-state]')).toBe('1.25×');
    expect(state('[data-player-eq-state]')).toBe('Off');
    expect(state('[data-player-radio-state]')).toBe('On');
    delete window.npV2;
  });

  it('Equalizer says what its click did, through the legacy handler that stops the click', async () => {
    // the REAL wiring from static/media-player-v2.js: its click handlers call
    // stopPropagation, which is what hid EQ's clicks from the menu
    const v2 = readFileSync(resolve(process.cwd(), 'static/media-player-v2.js'), 'utf8');
    const NPV2 = { eq: { on: false, preset: 'Flat' }, speed: 1 };
    const setEqOn = vi.fn((on: boolean) => {
      NPV2.eq.on = on;
    });
    const stubs = new Proxy({ NPV2, npv2SetEqOn: setEqOn } as Record<string, unknown>, {
      has: (_t, k) => typeof k === 'string' && /^(npv2|NPV2)/.test(k),
      get: (t, k) => (typeof k === 'string' && k in t ? t[k] : () => '6'),
    });
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const wire = new Function(
      'stubs',
      `with (stubs) { ${extractFunction('npv2WireTransport', v2)}\nreturn npv2WireTransport; }`,
    )(stubs) as () => void;
    window.npV2 = { getSpeed: () => 1, getEq: () => ({ ...NPV2.eq }) };
    boot(fakeEngine(snapshot()));
    wire();
    await flush();
    $('[data-player-more]').click();
    await flush();
    const eq = $('#np-v2-eq-btn');
    const value = () => $('[data-player-eq-state]').textContent;
    expect(value()).toBe('Off');
    eq.click();
    expect(setEqOn).toHaveBeenCalledWith(true);
    await flush();
    expect(value()).toBe('Flat');
    expect($('#ss-player-menu').hidden).toBe(false);
    eq.click();
    await flush();
    expect(setEqOn).toHaveBeenLastCalledWith(false);
    expect(value()).toBe('Off');
    delete window.npV2;
  });
});

describe('music’s record follows radio’s 16a (181)', () => {
  const css = readFileSync(resolve(process.cwd(), 'static/player.css'), 'utf8');

  it('no box round the readout, a borderless “…”, as radio’s record', () => {
    boot(fakeEngine(snapshot({ playlistTrack: { id: '42', title: 'Halcyon' } })));
    const music = $('.ss-player-record:not(.ss-player-rtray-record)');
    expect(music.querySelector('.ss-player-readout')!.classList).toContain(
      'ss-player-readout--plain',
    );
    const more = music.querySelector('[data-player-more]')!;
    expect(more.classList).not.toContain('ss-player-btn--outline');
    expect(more.classList).toContain('ss-player-record-more');
    // the record's other two controls keep their outline
    expect(music.querySelector('[data-player-record="playlist"]')!.classList).toContain(
      'ss-player-btn--outline',
    );
  });

  it('the borderless “…” and the accent artist are one rule for both records', () => {
    expect(css).toMatch(
      /\.ss-player-rtray-more,\s*\.ss-player-record-more\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/,
    );
    expect(css).toContain(
      '.ss-player-record a.ss-player-record-artist { color: rgb(var(--ss-accent-light-rgb)); font-weight: 500; }',
    );
    expect(css).not.toContain('.ss-player-rtray-record a.ss-player-record-artist {');
  });
});

describe('the Visuals row and the visuals’ transport (10a, 10d)', () => {
  it('with nothing playing the row is disabled-neutral: "Play something first", no F', () => {
    const openVisuals = vi.fn();
    window.npV2 = { getSpeed: () => 1, getEq: () => ({ on: false, preset: 'Flat' }), openVisuals };
    const engine = fakeEngine(snapshot());
    boot(engine);
    $('[data-player-more]').click();
    const row = $('[data-player-menu="visuals"]');
    expect(row).not.toHaveAttribute('aria-disabled');
    expect($('[data-player-visuals-state]').hidden).toBe(true);
    engine.current = snapshot({ track: null });
    window.dispatchEvent(new CustomEvent('ss:player', { detail: { reason: 'state' } }));
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect($('[data-player-visuals-state]').hidden).toBe(false);
    expect($('[data-player-visuals-state]').textContent).toBe('Play something first');
    expect((row.querySelector('kbd') as HTMLElement).hidden).toBe(true);
    row.click();
    expect(openVisuals).not.toHaveBeenCalled();
    delete window.npV2;
  });

  it('the visuals’ transport has the times, the waveform and a volume that works', () => {
    const engine = fakeEngine(snapshot({ volume: 40 }));
    boot(engine);
    const overlay = $('#np-modal-overlay');
    expect(overlay.querySelector('[data-player-wave]')).not.toBeNull();
    expect(overlay.querySelector('[data-player-elapsed]')).not.toBeNull();
    const vol = overlay.querySelector<HTMLInputElement>('[data-player-volume]')!;
    expect(vol.value).toBe('40');
    vol.value = '55';
    vol.dispatchEvent(new Event('input'));
    expect(engine.setVolume).toHaveBeenCalledWith(55);
  });
});

describe('radio in the bar (HANDOFF 49)', () => {
  it('puts Live beside the station’s name and keeps the meter in the centre', () => {
    boot(
      fakeEngine(
        snapshot({ kind: 'radio', track: { title: 'NTS 1', kind: 'radio' }, queue: [], index: -1 }),
      ),
    );
    const live = $('.ss-player-bar [data-player-live]');
    expect(live.hidden).toBe(false);
    expect(
      live.closest('.ss-player-title-row')?.querySelector('[data-player-title]')?.textContent,
    ).toBe('NTS 1');
    expect($('.ss-player-centre [data-player-live]')).toBeNull();
    expect($('.ss-player-centre [data-player-meter]').hidden).toBe(false);
  });
});
