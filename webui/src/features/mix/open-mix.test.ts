import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { getMixState, resetMixForTests } from './mix-store';
import { resetMixTabForTests } from './mix-visibility';
import { openMixWith } from './open-mix';

// the Mix tab and its ways in are shown here (Settings → Library → DJ's
// "Show the Mix tab"); mix-visibility.test.tsx covers them hidden
beforeEach(() => resetMixTabForTests(true));
afterEach(() => resetMixTabForTests());

/** gauntlet review M1: "Mixes well with…" never stops a station, an episode or a book */

const w = window as unknown as Record<string, unknown>;
let expand: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetMixForTests();
  expand = vi.fn();
  w.SoulSyncPlayerChrome = { expand, isExpanded: () => false };
});
afterEach(() => {
  delete w.SoulSyncPlayer;
  delete w.SoulSyncPlayerChrome;
});

it.each(['radio', 'podcast', 'audiobook'])(
  'with a %s playing it opens Mix following the track, without playing it',
  (kind) => {
    w.SoulSyncPlayer = { state: () => ({ track: { title: 'Station' }, kind, playing: true }) };
    const play = vi.fn();
    openMixWith({ id: '4', title: 'Copper Sky' }, { play });
    expect(play).not.toHaveBeenCalled();
    expect(expand).toHaveBeenCalledTimes(1);
    expect(getMixState().mode).toBe('mix');
    expect(getMixState().chain).toEqual([{ id: '4', title: 'Copper Sky' }]);
  },
);

it('with nothing in the player at all it plays the track (as before)', () => {
  w.SoulSyncPlayer = { state: () => ({ track: null, playing: false }) };
  const play = vi.fn();
  openMixWith({ id: '4', title: 'Copper Sky' }, { play });
  expect(play).toHaveBeenCalledTimes(1);
});
