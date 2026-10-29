import { describe, expect, it, vi } from 'vitest';

import { bpmTitle } from './dj.format';
import { allShared, tempoWords } from './tempo';
import { trackMenu } from './track-menu';

describe('the words for Double BPM / Halve BPM', () => {
  it('says what changed, and why any track wasn’t', () => {
    expect(tempoWords('double', { changed: { '1': 174 }, skipped: {} })).toEqual({
      words: 'Now 174 BPM',
      tone: 'success',
    });
    expect(tempoWords('halve', { changed: { '1': 87.5, '2': 86 }, skipped: {} }).words).toBe(
      'Halved the BPM of 2 tracks',
    );
    expect(
      tempoWords('double', {
        changed: { '1': 174 },
        skipped: { '2': 'out_of_range', '3': 'no_bpm', '4': 'no_bpm' },
      }).words,
    ).toBe('Doubled the BPM of 1 track · 3 not changed: it would leave 40–300 BPM, no BPM yet');
    expect(tempoWords('reset', { changed: { '1': null, '2': null }, skipped: {} }).words).toBe(
      '2 tracks back to their measured BPM',
    );
    expect(tempoWords('reset', { changed: {}, skipped: { '1': 'not_set' } })).toEqual({
      words: 'Not changed: not set by hand',
      tone: 'error',
    });
  });

  it('says a shared track is an admin’s, and when only the first 500 were sent (review L3, L7)', () => {
    expect(tempoWords('double', { changed: { '1': 174 }, skipped: { '2': 'shared' } }).words).toBe(
      'Doubled the BPM of 1 track · 1 not changed: only an admin changes a shared track’s BPM',
    );
    const ids = Object.fromEntries(Array.from({ length: 500 }, (_v, i) => [String(i), 174]));
    expect(tempoWords('double', { changed: ids, skipped: {} }, 620).words).toBe(
      'Doubled the BPM of 500 tracks · only the first 500 of 620 picked; pick the rest and change them again',
    );
  });

  it('only says “only an admin” when every pick is known to be shared (review N5)', () => {
    const tracks = [
      { id: '1', shared: true },
      { id: '2', shared: false },
      { id: '3', shared: true },
    ];
    expect(allShared(['1', '3'], tracks)).toBe(true);
    expect(allShared(['1', '2'], tracks)).toBe(false);
    expect(allShared([], tracks)).toBe(false);
    // picked ids this page no longer has loaded (filtered since): not known
    expect(allShared(['8', '9'], tracks)).toBe(false);
    expect(allShared(['1', '9'], tracks)).toBe(false);
  });

  it('the BPM’s title names its source and the tag under it', () => {
    expect(bpmTitle({ bpm: 174.01, bpm_source: 'grid', bpm_tag: 87 })).toBe(
      '174 BPM, measured from the beats · Tagged 87',
    );
    expect(bpmTitle({ bpm: 172, bpm_source: 'override' })).toBe('172 BPM, set by hand');
    expect(bpmTitle({ bpm: 124, bpm_source: 'tag' })).toBe("124 BPM, from the file's tag");
  });
});

describe('the "…" menu', () => {
  it('only Tracks asks for Double and Halve BPM, after Add to playlist…', () => {
    const t = { id: '1', title: 'Night Ferry' };
    expect(trackMenu(t, { addToPlaylist: () => {} }).map((e) => e.key)).toEqual([
      'mixes',
      'mixset',
      'playlist',
    ]);
    const onSet = vi.fn();
    const entries = trackMenu(t, {
      addToPlaylist: () => {},
      tempo: { bpm: 87, onSet },
      artistHref: '/a',
    });
    expect(entries.map((e) => e.key)).toEqual([
      'mixes',
      'mixset',
      'playlist',
      'double',
      'halve',
      'artist',
    ]);
    entries.find((e) => e.key === 'halve')!.onSelect();
    expect(onSet).toHaveBeenCalledWith('halve');
    const slow = trackMenu(t, { tempo: { bpm: 70, onSet, overridden: true } });
    expect(slow.find((e) => e.key === 'halve')).toMatchObject({
      disabled: true,
      reason: 'It would be under 40 BPM',
    });
    expect(slow.at(-1)!.label).toBe('Use the measured BPM');
    // no BPM, or no file: nothing to double
    expect(trackMenu(t, { tempo: { bpm: null, onSet } }).some((e) => e.key === 'double')).toBe(
      false,
    );
    expect(
      trackMenu({ ...t, fileMissing: true }, { tempo: { bpm: 87, onSet } }).some(
        (e) => e.key === 'double',
      ),
    ).toBe(false);
  });

  it('offers "BPM is right" first when the grid waits only on its octave', () => {
    const t = { id: '1', title: 'Night Ferry' };
    const onSet = vi.fn();
    const entries = trackMenu(t, { tempo: { bpm: 174, onSet, unsure: true } });
    expect(
      entries.filter((e) => ['confirm', 'double', 'halve'].includes(e.key)).map((e) => e.key),
    ).toEqual(['confirm', 'double', 'halve']);
    const confirm = entries.find((e) => e.key === 'confirm')!;
    expect(confirm.label).toBe('BPM is right');
    expect(confirm.disabled).toBe(false);
    confirm.onSelect();
    expect(onSet).toHaveBeenCalledWith('confirm');
    // a member, a shared track: shown, but not theirs to set
    expect(
      trackMenu(t, { tempo: { bpm: 174, onSet, unsure: true, blocked: 'Only an admin' } }).find(
        (e) => e.key === 'confirm',
      ),
    ).toMatchObject({ disabled: true, reason: 'Only an admin' });
    expect(trackMenu(t, { tempo: { bpm: 174, onSet } }).some((e) => e.key === 'confirm')).toBe(
      false,
    );
    expect(tempoWords('confirm', { changed: { '1': 174 }, skipped: {} }).words).toBe(
      '174 BPM it is: ready to mix',
    );
  });
});
