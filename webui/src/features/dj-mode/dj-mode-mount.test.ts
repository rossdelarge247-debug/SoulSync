import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountDjMode, resetDjModeMount } from './dj-mode-mount';
import { djModeStore, resetDjModeStore } from './dj-mode-store';

const HTML = `
  <div id="np-modal-overlay" class="hidden"><div class="np-modal">
    <div id="np-v2-visuals-header">
      <div class="ss-visuals-head-left">
        <button id="np-v2-visuals-exit"></button>
        <div id="np-v2-visuals-dj-head" hidden>
          <button id="np-v2-visuals-dj-back">Back to the player</button>
          <p id="np-v2-visuals-dj-line"></p>
        </div>
      </div>
      <div id="np-v2-visuals-theme-switch">
        <button id="np-v2-visuals-theme-prev"></button><button id="np-v2-visuals-theme-next"></button>
      </div>
      <button id="np-v2-visuals-lyrics-btn" title="Lyrics (T)">Lyrics</button>
      <button id="np-v2-visuals-dj-btn" aria-pressed="false" hidden>DJ mode</button>
      <button id="np-v2-visuals-dj-close" hidden></button>
    </div>
  </div></div>
  <div id="ss-player-bar">
    <span id="ss-player-dj-line" hidden><span id="ss-player-dj-text"></span><button id="ss-player-dj-open">Open</button></span>
  </div>`;

const FERRY = { id: '2', title: 'Night Ferry', is_library: true, filename: '/m/2.flac' };

let track: Record<string, unknown> | null;
let kind: string;
let toasts: string[];
let said: string[];

function player(t: Record<string, unknown> | null, k = 'library') {
  track = t;
  kind = k;
  window.dispatchEvent(new CustomEvent('ss:player', { detail: { reason: 'track' } }));
}

const $ = (id: string) => document.getElementById(id)!;
const overlay = () => $('np-modal-overlay');
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = HTML;
  document.documentElement.removeAttribute('data-player');
  track = null;
  kind = 'library';
  toasts = [];
  said = [];
  const w = window as unknown as Record<string, unknown>;
  w.SoulSyncPlayer = { state: () => ({ track, kind }) };
  w.showToast = (m: string) => toasts.push(m);
  w.npV2 = {
    openVisuals: vi.fn(() => overlay().classList.remove('hidden')),
    wakeVisuals: vi.fn(),
  };
  resetDjModeStore();
  resetDjModeMount();
  // no server here: the lanes' reads answer nothing
  djModeStore({
    fetch: async () => new Response('{}', { status: 404 }),
    analyse: () => undefined,
    analysis: {
      watch: () => () => undefined,
      entry: () => undefined,
      subscribe: () => () => undefined,
    },
    say: (w: string) => said.push(w),
    phone: () => false,
  });
  mountDjMode(window);
});

afterEach(() => {
  const w = window as unknown as Record<string, unknown>;
  delete w.SoulSyncPlayer;
  delete w.SoulSyncDj;
  delete w.showToast;
  delete w.npV2;
  document.documentElement.removeAttribute('data-dj-mode');
  resetDjModeStore();
  resetDjModeMount();
});

describe('the toggle (37a)', () => {
  it('is drawn only for a library track, and not at all otherwise', () => {
    expect($('np-v2-visuals-dj-btn').hidden).toBe(true);
    player(FERRY);
    expect($('np-v2-visuals-dj-btn').hidden).toBe(false);
    player({ title: 'NTS 1', is_library: false, kind: 'radio' }, 'radio');
    expect($('np-v2-visuals-dj-btn').hidden).toBe(true);
    player(null);
    expect($('np-v2-visuals-dj-btn').hidden).toBe(true);
  });

  it('on: pressed with its green dot, Back and the line shown, the visual’s ‹ › and Lyrics wait', async () => {
    player(FERRY);
    overlay().classList.remove('hidden');
    await tick();
    $('np-v2-visuals-dj-btn').click();
    expect($('np-v2-visuals-dj-btn').getAttribute('aria-pressed')).toBe('true');
    expect(overlay().hasAttribute('data-dj-mode')).toBe(true);
    expect(document.documentElement.hasAttribute('data-dj-mode')).toBe(true);
    expect($('np-v2-visuals-dj-head').hidden).toBe(false);
    expect($('np-v2-visuals-dj-close').hidden).toBe(false);
    expect($('np-v2-visuals-dj-line').textContent).toBe(
      'Night Ferry on the speakers · drop a second track',
    );
    expect(($('np-v2-visuals-theme-next') as HTMLButtonElement).disabled).toBe(true);
    const lyrics = $('np-v2-visuals-lyrics-btn');
    expect(lyrics.getAttribute('aria-disabled')).toBe('true');
    expect(lyrics.title).toBe('Lyrics come back when DJ mode is off');
    // a click on Lyrics says so instead of turning the layer on
    const layer = vi.fn();
    lyrics.addEventListener('click', layer);
    lyrics.click();
    expect(layer).not.toHaveBeenCalled();
    expect(toasts).toEqual(['Lyrics come back when DJ mode is off']);
    // Back: everything as it was, the focus on DJ mode
    $('np-v2-visuals-dj-back').click();
    expect(overlay().hasAttribute('data-dj-mode')).toBe(false);
    expect($('np-v2-visuals-dj-head').hidden).toBe(true);
    expect(($('np-v2-visuals-theme-next') as HTMLButtonElement).disabled).toBe(false);
    expect(lyrics.hasAttribute('aria-disabled')).toBe(false);
    expect(lyrics.title).toBe('Lyrics (T)');
    expect(document.activeElement).toBe($('np-v2-visuals-dj-btn'));
    lyrics.click();
    expect(layer).toHaveBeenCalledTimes(1);
  });

  it('closing the overlay keeps DJ mode on (step 4, 37j); its keys wait for the overlay', async () => {
    player(FERRY);
    overlay().classList.remove('hidden');
    await tick();
    window.SoulSyncDj!.key('D');
    expect(window.SoulSyncDj!.on()).toBe(true);
    overlay().classList.add('hidden');
    await tick();
    expect(window.SoulSyncDj!.on()).toBe(true);
    // with the overlay closed B and H are nobody's
    expect(window.SoulSyncDj!.key('B')).toBe(false);
    expect(window.SoulSyncDj!.key('H')).toBe(false);
  });
});

describe('focus when it turns itself off (review L4)', () => {
  it('its button gone with it, the overlay’s close takes the focus', async () => {
    player(FERRY);
    overlay().classList.remove('hidden');
    await tick();
    window.SoulSyncDj!.key('D');
    await tick();
    expect(document.activeElement).toBe($('np-v2-visuals-dj-back'));
    // radio starts: DJ mode isn't offered, so it turns off and its button hides
    player({ title: 'NTS 1', is_library: false, kind: 'radio' }, 'radio');
    expect(window.SoulSyncDj!.on()).toBe(false);
    expect($('np-v2-visuals-dj-btn').hidden).toBe(true);
    await tick();
    expect(document.activeElement).toBe($('np-v2-visuals-exit'));
  });
});

describe('the keys (37p)', () => {
  it('D in the overlay turns it on and off; not offered, the key is the page’s', async () => {
    overlay().classList.remove('hidden');
    await tick();
    expect(window.SoulSyncDj!.key('D')).toBe(false);
    player(FERRY);
    expect(window.SoulSyncDj!.key('D')).toBe(true);
    expect(window.SoulSyncDj!.on()).toBe(true);
    expect(window.SoulSyncDj!.key('D')).toBe(true);
    expect(window.SoulSyncDj!.on()).toBe(false);
  });

  it('D from the tray opens the Visuals in DJ mode; from anywhere else it’s the page’s', () => {
    player(FERRY);
    const v2 = (window as unknown as { npV2: { openVisuals: ReturnType<typeof vi.fn> } }).npV2;
    expect(window.SoulSyncDj!.key('D')).toBe(false);
    expect(v2.openVisuals).not.toHaveBeenCalled();
    document.documentElement.setAttribute('data-player', 'tray');
    expect(window.SoulSyncDj!.key('D')).toBe(true);
    expect(v2.openVisuals).toHaveBeenCalledTimes(1);
    expect(window.SoulSyncDj!.on()).toBe(true);
  });

  it('B is Browse once step 3 adds it; T waits for Lyrics; Esc is Back while on', async () => {
    player(FERRY);
    overlay().classList.remove('hidden');
    await tick();
    expect(window.SoulSyncDj!.key('B')).toBe(false);
    expect(window.SoulSyncDj!.key('T')).toBe(false);
    expect(window.SoulSyncDj!.escape()).toBe(false);
    window.SoulSyncDj!.key('D');
    expect(window.SoulSyncDj!.key('B')).toBe(false);
    const browse = vi.fn();
    window.SoulSyncDj!.store.setBrowseOpener(browse);
    expect(window.SoulSyncDj!.key('B')).toBe(true);
    expect(browse).toHaveBeenCalledTimes(1);
    expect($('np-v2-visuals-dj-line').textContent).toBe(
      'Night Ferry on the speakers · drop or Browse a second track',
    );
    expect(window.SoulSyncDj!.key('T')).toBe(true);
    expect(toasts).toEqual(['Lyrics come back when DJ mode is off']);
    expect(window.SoulSyncDj!.escape()).toBe(true);
    expect(window.SoulSyncDj!.on()).toBe(false);
    window.SoulSyncDj!.store.setBrowseOpener(null);
  });

  it('⇧P is Play B with B loaded; mid-blend Esc says how to end it and Back takes a bar', async () => {
    player(FERRY);
    overlay().classList.remove('hidden');
    await tick();
    expect(window.SoulSyncDj!.key('⇧P')).toBe(false);
    window.SoulSyncDj!.key('D');
    const store = window.SoulSyncDj!.store;
    let blending = false;
    const backOverBar = vi.fn();
    const playB = vi.fn(() => {
      blending = true;
      return true;
    });
    store.setMixer({
      blending: () => blending,
      backOverBar,
      end: vi.fn(),
      playB,
      positionB: () => null,
    });
    // no B: the key is the player's (Previous)
    expect(window.SoulSyncDj!.key('⇧P')).toBe(false);
    store.loadB({ id: '8', title: 'Harbour Lights', artist: 'Marram', image: null, duration: 288 });
    expect(window.SoulSyncDj!.key('⇧P')).toBe(true);
    expect(playB).toHaveBeenCalledTimes(1);
    // review H4: with B loaded ⇧P is DJ mode's even when Play B can't act
    // (getting ready, A paused, a second press): never Previous
    playB.mockImplementationOnce(() => false);
    expect(window.SoulSyncDj!.key('⇧P')).toBe(true);
    playB.mockImplementationOnce(() => {
      throw new Error('not now');
    });
    expect(window.SoulSyncDj!.key('⇧P')).toBe(true);
    store.setMix({ phase: 'playing', window: null, rateB: 0.98, sync: true });
    await tick();
    expect($('np-v2-visuals-dj-line').textContent).toBe('Blending · Back ends it over a bar');
    expect(window.SoulSyncDj!.escape()).toBe(true);
    expect(window.SoulSyncDj!.on()).toBe(true);
    // said once, politely
    expect(said.at(-1)).toBe('Blending · Back ends it over a bar');
    // B (Browse) under a blend says why, and a drop can't replace B
    expect(window.SoulSyncDj!.key('B')).toBe(true);
    expect(
      store.loadB({ id: '9', title: 'Copper Sky', artist: '', image: null, duration: 300 }),
    ).toBe(false);
    // the Back button: the fader to A over a bar, then off
    $('np-v2-visuals-dj-back').click();
    expect(backOverBar).toHaveBeenCalledTimes(1);
    expect(window.SoulSyncDj!.on()).toBe(true);
    blending = false;
    backOverBar.mock.calls[0]![0]();
    expect(window.SoulSyncDj!.on()).toBe(false);
    store.setMixer(null);
  });

  it('a phone never offers it (417)', () => {
    resetDjModeStore();
    resetDjModeMount();
    document.body.innerHTML = HTML;
    djModeStore({
      fetch: async () => new Response('{}', { status: 404 }),
      analyse: () => undefined,
      analysis: {
        watch: () => () => undefined,
        entry: () => undefined,
        subscribe: () => () => undefined,
      },
      say: () => undefined,
      phone: () => true,
    });
    mountDjMode(window);
    player(FERRY);
    expect($('np-v2-visuals-dj-btn').hidden).toBe(true);
    overlay().classList.remove('hidden');
    expect(window.SoulSyncDj!.key('D')).toBe(false);
  });
});

describe('the player bar’s one line with the Visuals closed (step 4, 37o)', () => {
  const line = () => $('ss-player-dj-line');
  const text = () => $('ss-player-dj-text').textContent;

  it('none with DJ mode off, ever; with it on and B loaded, one line, its Open opens the Visuals', async () => {
    player(FERRY);
    await tick();
    expect(line().hidden).toBe(true);
    overlay().classList.remove('hidden');
    await tick();
    window.SoulSyncDj!.key('D');
    // B loaded, the overlay still open: nothing in the bar
    djModeStore().loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    expect(line().hidden).toBe(true);
    overlay().classList.add('hidden');
    await tick();
    expect(line().hidden).toBe(false);
    expect(text()).toBe('DJ mode · Harbour Lights cued');
    djModeStore().setMix({ phase: 'playing', window: null, rateB: null, sync: true });
    expect(text()).toBe('DJ mode · blending into Harbour Lights');
    $('ss-player-dj-open').click();
    expect(overlay().classList.contains('hidden')).toBe(false);
    await tick();
    expect(line().hidden).toBe(true);
  });

  it('gone with Hand over (B empties) and with Back', async () => {
    player(FERRY);
    overlay().classList.remove('hidden');
    await tick();
    window.SoulSyncDj!.key('D');
    djModeStore().loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    overlay().classList.add('hidden');
    await tick();
    expect(line().hidden).toBe(false);
    // the player takes B: lane A is B's track, lane B empties
    player({ ...FERRY, id: '8', title: 'Harbour Lights' });
    await tick();
    expect(line().hidden).toBe(true);
    djModeStore().setOn(false);
    expect(line().hidden).toBe(true);
  });
});

describe('H and the advance (step 4, 37p, 37j)', () => {
  it('H is Hand over in the overlay with B loaded; else nobody’s', async () => {
    player(FERRY);
    overlay().classList.remove('hidden');
    await tick();
    expect(window.SoulSyncDj!.key('H')).toBe(false);
    window.SoulSyncDj!.key('D');
    expect(window.SoulSyncDj!.key('H')).toBe(false);
    djModeStore().loadB({ id: '8', title: 'Harbour Lights', inLibrary: true });
    const handOver = vi.fn(() => true);
    djModeStore().setMixer({
      blending: () => true,
      backOverBar: () => undefined,
      end: () => undefined,
      playB: () => true,
      positionB: () => null,
      handOver,
      handOverWhy: () => null,
      ownsAdvance: () => true,
    });
    expect(window.SoulSyncDj!.key('H')).toBe(true);
    expect(handOver).toHaveBeenCalledTimes(1);
    expect(window.SoulSyncDj!.ownsAdvance()).toBe(true);
    // DJ mode mid-blend: D doesn't turn it off
    window.SoulSyncDj!.key('D');
    expect(window.SoulSyncDj!.on()).toBe(true);
    expect(said.at(-1)).toBe('Blending · Back ends it over a bar');
  });
});
