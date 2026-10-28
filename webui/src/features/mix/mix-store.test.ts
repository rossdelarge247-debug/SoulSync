/**
 * The tray's modes (33a, 36a: DJ waits for DJ now, step 5), Vibe remembered
 * per browser (Design's 296), and "Mixes well with…" following a track
 * (33a, HANDOFF 329).
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  DJ_MODE_READY,
  MODE_STORAGE_KEY,
  VIBE_STORAGE_KEY,
  followTrack,
  getMixState,
  resetMixForTests,
  setTrayMode,
  setVibe,
} from './mix-store';

afterEach(() => resetMixForTests());

describe('the mix store', () => {
  it('keeps DJ out until DJ now is built: setTrayMode("dj") does nothing', () => {
    expect(DJ_MODE_READY).toBe(false);
    setTrayMode('mix');
    setTrayMode('dj');
    expect(getMixState().mode).toBe('mix');
    window.localStorage.setItem(MODE_STORAGE_KEY, 'dj');
    resetMixForTests();
    window.localStorage.setItem(MODE_STORAGE_KEY, 'dj');
    expect(getMixState().mode).toBe('mix');
  });

  it('296: Vibe is remembered per browser', () => {
    expect(getMixState().vibe).toBe(false);
    setVibe(true);
    expect(window.localStorage.getItem(VIBE_STORAGE_KEY)).toBe('on');
    resetMixForTests();
    window.localStorage.setItem(VIBE_STORAGE_KEY, 'on');
    expect(getMixState().vibe).toBe(true);
  });

  it('329: followTrack opens Mix on that track, and remembers Mix', () => {
    followTrack({ id: '5', title: 'Copper Sky' });
    const state = getMixState();
    expect(state.mode).toBe('mix');
    expect(state.sheetTab).toBe('mix');
    expect(state.chain).toEqual([{ id: '5', title: 'Copper Sky' }]);
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBe('mix');
  });
});
