import { describe, expect, it } from 'vitest';

import {
  CAMELOT_KEYS,
  analysisLine,
  bpmNumber,
  bpmRelationWords,
  bpmTitle,
  bpmWords,
  energyWords,
  formatBpmRange,
  isCamelot,
  keyRelationWords,
  keyTitle,
  parseBpmRange,
} from './dj.format';

describe('the DJ data in words', () => {
  it('writes BPM whole when whole', () => {
    expect(bpmNumber(124)).toBe('124');
    expect(bpmNumber(123.96)).toBe('124');
    expect(bpmNumber(123.5)).toBe('123.5');
    expect(bpmWords(87.4)).toBe('87.4 BPM');
    expect(bpmWords(null)).toBe('');
  });

  it('titles a key with its musical name, where it came from and doubt', () => {
    expect(
      keyTitle({ key_long: 'A minor', key_name: 'Am', key_source: 'tag', key_uncertain: false }),
    ).toBe("A minor (Am), from the file's tag");
    expect(
      keyTitle({
        key_long: 'F♯ major',
        key_name: 'F#',
        key_source: 'analysis',
        key_uncertain: true,
      }),
    ).toBe('F♯ major (F#), worked out by SYNCHRO.S, key uncertain');
    expect(
      keyTitle({ key_long: null, key_name: null, key_source: null, key_uncertain: false }),
    ).toBe('');
    expect(bpmTitle({ bpm: 128, bpm_source: 'enrichment' })).toBe(
      '128 BPM, from the metadata source',
    );
  });

  it('says how two tracks mix', () => {
    expect(keyRelationWords('same', '8A')).toBe('Same key');
    expect(keyRelationWords('relative', '8B')).toBe('Relative major');
    expect(keyRelationWords('relative', '8A')).toBe('Relative minor');
    expect(keyRelationWords('up', '9A')).toBe('+1 on the wheel');
    expect(keyRelationWords('down', '7A')).toBe('−1 on the wheel');
    expect(bpmRelationWords('same', 1.6)).toBe('+1.6%');
    expect(bpmRelationWords('same', -2)).toBe('−2%');
    expect(bpmRelationWords('same', 0)).toBe('same BPM');
    expect(bpmRelationWords('half', -3)).toBe('half time');
    expect(bpmRelationWords('double', 1)).toBe('double time');
    expect(energyWords(7)).toBe('Energy 7');
  });

  it('lists the whole wheel', () => {
    expect(CAMELOT_KEYS).toHaveLength(24);
    expect(CAMELOT_KEYS.find((k) => k.code === '8A')?.name).toBe('Am');
    expect(isCamelot('12B')).toBe(true);
    expect(isCamelot('13A')).toBe(false);
  });

  it("reads and writes the URL's BPM range", () => {
    expect(parseBpmRange('120-128')).toEqual({ min: 120, max: 128 });
    expect(parseBpmRange('128-120')).toEqual({ min: 120, max: 128 });
    expect(parseBpmRange('-128')).toEqual({ min: null, max: 128 });
    expect(parseBpmRange('87.5-')).toEqual({ min: 87.5, max: null });
    expect(parseBpmRange('nonsense')).toEqual({ min: null, max: null });
    expect(formatBpmRange(120, null)).toBe('120-');
    expect(formatBpmRange(null, null)).toBe('');
  });

  it('says how far the analysis has got', () => {
    const base = { settings: { analyze: true }, held: false };
    expect(
      analysisLine({
        ...base,
        counts: { tracks: 4980, analyzed: 1240, pending: 3740 },
        job: { status: 'running', total: 3740, done: 12, waiting: 'download' },
      }),
    ).toBe('Working out BPM, key and energy: 12 of 3,740, waiting while a download runs');
    expect(
      analysisLine({ ...base, counts: { tracks: 4980, analyzed: 4980, pending: 0 }, job: null }),
    ).toBe('BPM, key and energy for all 4,980 tracks');
    expect(
      analysisLine({
        ...base,
        held: true,
        counts: { tracks: 10, analyzed: 4, pending: 6 },
        job: null,
      }),
    ).toBe('BPM, key and energy for 4 of 10 tracks. Stopped until you start it again.');
    expect(
      analysisLine({
        settings: { analyze: false },
        held: false,
        counts: { tracks: 10, analyzed: 4, pending: 6 },
        job: null,
      }),
    ).toBe(
      'BPM, key and energy for 4 of 10 tracks. Working them out is off in Settings → Library.',
    );
    expect(
      analysisLine({ ...base, counts: { tracks: 0, analyzed: 0, pending: 0 }, job: null }),
    ).toBe('');
  });
});
