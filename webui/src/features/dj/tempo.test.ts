import { describe, expect, it, vi } from 'vitest';

import { bpmTitle } from './dj.format';
import { tempoWords } from './tempo';
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
});
