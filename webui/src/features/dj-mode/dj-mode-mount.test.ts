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
  </div></div>`;

const FERRY = { id: '2', title: 'Night Ferry', is_library: true, filename: '/m/2.flac' };

let track: Record<string, unknown> | null;
let kind: string;
let toasts: string[];

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
    say: () => undefined,
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

  it('closing the overlay turns it off (nothing is blending in step 2)', async () => {
    player(FERRY);
    overlay().classList.remove('hidden');
    await tick();
    window.SoulSyncDj!.key('D');
    expect(window.SoulSyncDj!.on()).toBe(true);
    overlay().classList.add('hidden');
    await tick();
    expect(window.SoulSyncDj!.on()).toBe(false);
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
