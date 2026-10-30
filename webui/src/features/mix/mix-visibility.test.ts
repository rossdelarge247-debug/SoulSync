/**
 * Settings → Library → DJ's "Show the Mix tab" (off by default while Ross
 * rethinks mixing): the setting's round trip (the page shell, Settings'
 * save, the DJ status) and each way into the Mix tab outside the tray, off
 * and on. The tray, the phone sheet, Visuals and the keys are in
 * mix-tab.test.tsx ("hidden: …").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  MIX_TAB_CHANGED_EVENT,
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
  it('hidden: "Mixes well with…" from a stale menu neither opens the tray nor plays', () => {
    const expand = vi.fn();
    const play = vi.fn();
    w.SoulSyncPlayerChrome = { expand, isExpanded: () => false };
    w.SoulSyncPlayer = { state: () => ({ track: { id: '1', title: 'Night Ferry' } }) };
    openMixWith(TRACK, { play });
    w.SoulSyncPlayer = { state: () => ({ track: null }) };
    openMixWith(TRACK, { play });
    expect(expand).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(getMixState().mode).toBe('now');
    expect(getMixState().chain).toEqual([]);
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
