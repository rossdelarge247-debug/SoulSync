import { describe, expect, it } from 'vitest';

import { countBusyWorkers, heroNumbers } from './-dash.hello';

describe('heroNumbers', () => {
  it('omits what it does not know instead of showing zeros', () => {
    // Fresh boot: no db stats yet → no numbers, never "0 tracks".
    expect(heroNumbers(null)).toEqual([]);
    expect(heroNumbers({ tracks: 0, albums: 0, artists: 0 })).toEqual([]);
    expect(heroNumbers({ tracks: null, albums: 12 })).toEqual([
      { id: 'albums', value: (12).toLocaleString(), label: 'Albums' },
    ]);
  });

  it('formats the library in tracks, albums, artists order', () => {
    const numbers = heroNumbers({ tracks: 308778, albums: 70061, artists: 5550 });
    expect(numbers.map((n) => n.id)).toEqual(['tracks', 'albums', 'artists']);
    expect(numbers.map((n) => n.value)).toEqual([
      (308778).toLocaleString(),
      (70061).toLocaleString(),
      (5550).toLocaleString(),
    ]);
  });
});

describe('countBusyWorkers', () => {
  it("counts only the 'active' stateClass — running-and-not-paused", () => {
    expect(
      countBusyWorkers({
        musicbrainz: { stateClass: 'active' },
        deezer: { stateClass: 'active' },
        lastfm: { stateClass: 'paused' },
        genius: { stateClass: 'complete' },
        repair: { stateClass: null },
      }),
    ).toBe(2);
    expect(countBusyWorkers({})).toBe(0);
  });
});
