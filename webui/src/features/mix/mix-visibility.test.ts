/**
 * Settings → Library → DJ's "Show the Mix tab" (off by default while Ross
 * rethinks mixing): the setting's round trip (the page shell, Settings'
 * save, the DJ status) and each way into the Mix tab outside the tray, off
 * and on. The tray, the phone sheet, Visuals and the keys are in
 * mix-tab.test.tsx ("hidden: …").
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnalysisLineEntry } from '@/features/dj/analysis.api';

import { whyWords } from '@/features/dj/analysis.format';
import { djStatusQueryOptions } from '@/features/dj/dj.api';
import { trackMenu } from '@/features/dj/track-menu';
import { REASONS } from '@/features/dnd/dnd-model';
import { setRefusal } from '@/features/dnd/send-to';
import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';

import {
  MODE_STORAGE_KEY,
  followTrack,
  getMixState,
  resetMixForTests,
  setDrawer,
  setTrayMode,
} from './mix-store';
import {
  MIX_TAB_ATTRIBUTE,
  MIX_TAB_CHANGED_EVENT,
  mixTabReadMark,
  mixTabShown,
  noteMixTabSetting,
  resetMixTabForTests,
} from './mix-visibility';
import { openMixWith } from './open-mix';

const w = window as unknown as Record<string, unknown>;
const TRACK = { id: '4', title: 'Copper Sky' };
const fromSettings = (shown: unknown) =>
  window.dispatchEvent(new CustomEvent(MIX_TAB_CHANGED_EVENT, { detail: { shown } }));

beforeEach(() => {
  resetMixTabForTests();
  resetMixForTests();
});
afterEach(() => {
  resetMixTabForTests();
  resetMixForTests();
  delete w.SoulSyncPlayer;
  delete w.SoulSyncPlayerChrome;
});

describe('the setting', () => {
  it('is off by default: nothing from the page shell means hidden', () => {
    expect(w.SOULSYNC_MIX_TAB).toBeUndefined();
    expect(mixTabShown()).toBe(false);
  });

  it('starts from what the page shell rendered (window.SOULSYNC_MIX_TAB); only true shows it', () => {
    resetMixTabForTests(true);
    expect(mixTabShown()).toBe(true);
    for (const odd of ['true', 1, null, {}]) {
      resetMixTabForTests(odd);
      expect(mixTabShown()).toBe(false);
    }
  });

  it("follows Settings' save (static/settings.js's event), and ignores anything not a boolean", () => {
    fromSettings(true);
    expect(mixTabShown()).toBe(true);
    expect(w.SOULSYNC_MIX_TAB).toBe(true);
    fromSettings('false');
    expect(mixTabShown()).toBe(true);
    fromSettings(false);
    expect(mixTabShown()).toBe(false);
    expect(w.SOULSYNC_MIX_TAB).toBe(false);
  });

  it("follows the server's settings from the DJ status (another device changed it)", async () => {
    let shown = true;
    server.use(
      http.get('/api/library/dj/status', () =>
        HttpResponse.json({
          success: true,
          settings: {
            analyze: true,
            write_tags: false,
            overwrite_tags: false,
            show_mix_tab: shown,
          },
          counts: { tracks: 0, analyzed: 0, failed: 0, unreachable: 0, pending: 0 },
          job: null,
          held: false,
          can_start: true,
          can_stop: true,
        }),
      ),
    );
    const qc = createTestQueryClient();
    await qc.fetchQuery(djStatusQueryOptions());
    expect(mixTabShown()).toBe(true);
    shown = false;
    await qc.fetchQuery({ ...djStatusQueryOptions(), staleTime: 0 });
    expect(mixTabShown()).toBe(false);
  });

  it('an older server without the field leaves it as it is', () => {
    noteMixTabSetting(undefined);
    expect(mixTabShown()).toBe(false);
    noteMixTabSetting(true);
    noteMixTabSetting(undefined);
    expect(mixTabShown()).toBe(true);
  });
});

describe('"Mixes well with…" in the track menus (track-menu.ts)', () => {
  const keys = () => trackMenu(TRACK, { playNext: { onSelect: vi.fn() } }).map((e) => e.key);
  const phoneKeys = () =>
    trackMenu(TRACK, { phone: true, playNext: { onSelect: vi.fn() } }).map((e) => e.key);

  it('is left out while the Mix tab is hidden, on a desktop and on a phone', () => {
    expect(keys()).toEqual(['next', 'mixset']);
    expect(phoneKeys()).toEqual(['next', 'mixset']);
  });

  it('is there, third, with the Mix tab shown', () => {
    noteMixTabSetting(true);
    expect(keys()).toEqual(['next', 'mixes', 'mixset']);
    expect(phoneKeys()).toEqual(['next', 'mixes', 'mixset']);
  });
});

describe('opening Mix (open-mix.ts, mix-store.ts)', () => {
  it('hidden: "Mixes well with…" from a stale menu neither opens the tray nor plays, and says why', () => {
    const expand = vi.fn();
    const play = vi.fn();
    const toast = vi.fn();
    w.showToast = toast;
    w.SoulSyncPlayerChrome = { expand, isExpanded: () => false };
    w.SoulSyncPlayer = { state: () => ({ track: { id: '1', title: 'Night Ferry' } }) };
    openMixWith(TRACK, { play });
    w.SoulSyncPlayer = { state: () => ({ track: null }) };
    openMixWith(TRACK, { play });
    expect(expand).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(getMixState().mode).toBe('now');
    expect(getMixState().chain).toEqual([]);
    expect(toast).toHaveBeenCalledWith(
      'The Mix tab is turned off in Settings → Library → DJ.',
      'info',
    );
    delete w.showToast;
  });

  it('shown: it opens the tray in Mix following the track', () => {
    noteMixTabSetting(true);
    const expand = vi.fn();
    w.SoulSyncPlayerChrome = { expand, isExpanded: () => false };
    w.SoulSyncPlayer = { state: () => ({ track: { title: 'Station' }, kind: 'radio' }) };
    openMixWith(TRACK, { play: vi.fn() });
    expect(expand).toHaveBeenCalledTimes(1);
    expect(getMixState().mode).toBe('mix');
  });

  it('hidden: nothing switches the tray to Mix, and followTrack remembers nothing', () => {
    setTrayMode('mix');
    followTrack(TRACK);
    expect(getMixState().mode).toBe('now');
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBeNull();
    setTrayMode('now');
    expect(getMixState().mode).toBe('now');
  });

  it('a remembered Mix reads as Now playing while hidden, and comes back with the setting', () => {
    window.localStorage.setItem(MODE_STORAGE_KEY, 'mix');
    expect(getMixState().mode).toBe('now');
    noteMixTabSetting(true);
    expect(getMixState().mode).toBe('mix');
  });

  it("a tray in Mix (or Visuals' drawer) falls back to Now playing when it's turned off", () => {
    noteMixTabSetting(true);
    followTrack(TRACK);
    setDrawer(true);
    expect(getMixState()).toMatchObject({ mode: 'mix', drawer: true });
    noteMixTabSetting(false);
    expect(getMixState()).toMatchObject({ mode: 'now', drawer: false, chain: [] });
    // the browser still remembers Mix, for when the tab is back
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBe('mix');
  });
});

describe("Send to… the working set (step 4's dnd) with none", () => {
  it("doesn't point at the Mix tab while it's hidden", () => {
    expect(setRefusal(null)).toBe(REASONS.noSetHidden);
    expect(REASONS.noSetHidden).not.toContain('Mix tab');
    noteMixTabSetting(true);
    expect(setRefusal(null)).toBe(REASONS.noSet);
  });
});

describe('Now playing while hidden keeps the remembered Mix (review L5)', () => {
  it("setTrayMode('now') doesn't write over the remembered mode", () => {
    window.localStorage.setItem(MODE_STORAGE_KEY, 'mix');
    setTrayMode('now');
    expect(getMixState().mode).toBe('now');
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBe('mix');
    noteMixTabSetting(true);
    expect(getMixState().mode).toBe('mix');
  });
});

describe('a DJ status read from before a save (review L2)', () => {
  it("can't undo Settings' newer value", () => {
    const startedAt = mixTabReadMark();
    fromSettings(true);
    // the read that started before the save comes back with the old value
    noteMixTabSetting(false, startedAt);
    expect(mixTabShown()).toBe(true);
    // a read that starts after it is taken
    noteMixTabSetting(false, mixTabReadMark());
    expect(mixTabShown()).toBe(false);
  });

  it('through the status query too', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    server.use(
      http.get('/api/library/dj/status', async () => {
        await gate;
        return HttpResponse.json({
          success: true,
          settings: {
            analyze: true,
            write_tags: false,
            overwrite_tags: false,
            show_mix_tab: false,
          },
          counts: { tracks: 0, analyzed: 0, failed: 0, unreachable: 0, pending: 0 },
          job: null,
          held: false,
          can_start: true,
          can_stop: true,
        });
      }),
    );
    const read = createTestQueryClient().fetchQuery(djStatusQueryOptions());
    fromSettings(true);
    release();
    await read;
    expect(mixTabShown()).toBe(true);
  });
});

describe('the ? shortcuts list (review M1)', () => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
  const css = readFileSync(resolve(process.cwd(), 'static/player.css'), 'utf8');
  const rows = () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const grid = doc.querySelector('#np-v2-shorts-overlay .ss-player-shortcuts-grid')!;
    const words = (sel: string) =>
      [...grid.querySelectorAll(sel)].map(
        (r) => `${r.querySelector('kbd')!.textContent}: ${r.querySelector('dt')!.textContent}`,
      );
    return { mixOnly: words('[data-mix-only]'), offOnly: words('[data-mix-off-only]') };
  };

  it("marks the Mix tab's M, N and A rows, and has plain M and N rows for without it", () => {
    const { mixOnly, offOnly } = rows();
    expect(mixOnly.map((r) => r.split(':')[0])).toEqual(['M', 'N', 'A']);
    expect(offOnly).toEqual(['M: Mute', 'N: Next track']);
  });

  it('CSS shows one set or the other by html[data-mix-tab]', () => {
    expect(css).toContain('html:not([data-mix-tab]) [data-mix-only],');
    expect(css).toContain('html[data-mix-tab] [data-mix-off-only] { display: none !important; }');
  });

  it('html[data-mix-tab] follows the setting, from first paint', () => {
    expect(html).toContain(
      "if (window.SOULSYNC_MIX_TAB === true) document.documentElement.setAttribute('data-mix-tab', '');",
    );
    expect(document.documentElement.hasAttribute(MIX_TAB_ATTRIBUTE)).toBe(false);
    fromSettings(true);
    expect(document.documentElement.hasAttribute(MIX_TAB_ATTRIBUTE)).toBe(true);
    fromSettings(false);
    expect(document.documentElement.hasAttribute(MIX_TAB_ATTRIBUTE)).toBe(false);
  });
});

describe('words that named the Mix tab (review L4)', () => {
  const e = (over: Partial<AnalysisLineEntry>): AnalysisLineEntry => ({
    track_id: '1',
    title: 'Static Bloom',
    artist: 'Saltmarsh',
    position: 1,
    source: 'mix',
    by: 'you',
    set_name: null,
    front: true,
    ...over,
  });

  it("an ask from the Mix tab says the player while it's hidden", () => {
    expect(whyWords(e({}))).toBe('the player');
    expect(whyWords(e({ by: 'Mira K.' }))).toBe("Mira's player");
    noteMixTabSetting(true);
    expect(whyWords(e({}))).toBe('the Mix tab');
    expect(whyWords(e({ by: 'Mira K.' }))).toBe("Mira's Mix tab");
  });
});
