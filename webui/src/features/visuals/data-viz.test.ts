/**
 * Data's numbers (30a–30i): the file's integers from the analyser's floats
 * (253), signed hex and decimal (30e), bits as sign and size, full scale in
 * the newest samples only (256), and the readout line by line (30i).
 */
import { describe, expect, it } from 'vitest';

import {
  allZero,
  bitCells,
  channelWords,
  counterWords,
  countFullScale,
  decSigned,
  EMPTY_INFO,
  hexSigned,
  isFullScale,
  readout,
  rowsThatFit,
  shownDepth,
  sliceWords,
  toInt,
  type DataInfo,
} from './data-viz';

const FLAC: DataInfo = {
  format: 'FLAC',
  fileRate: 44100,
  bitDepth: 16,
  channels: 2,
  bitrateKbps: 912,
  onDiskKbps: 912,
  station: null,
  lossless: true,
};

describe('the file’s integers (253)', () => {
  it('× 32,768 at 16-bit gives back the exact integers, clamped to the range', () => {
    for (const n of [0, 1, -1, 7994, -7994, 32767, -32768]) expect(toInt(n / 32768, 16)).toBe(n);
    expect(toInt(1, 16)).toBe(32767);
    expect(toInt(-1.5, 16)).toBe(-32768);
    expect(toInt(Number.NaN, 16)).toBe(0);
  });

  it('× 8,388,608 at 24-bit', () => {
    for (const n of [0, 123456, -123456, 8388607, -8388608]) expect(toInt(n / 8388608, 24)).toBe(n);
  });
});

describe('hex and decimal (30e)', () => {
  it('hex is the signed value: four digits at 16-bit, six at 24, a minus not the two’s complement', () => {
    expect(hexSigned(0, 16)).toBe('0x0000');
    expect(hexSigned(0x1f3a, 16)).toBe('0x1F3A');
    expect(hexSigned(-0x1f3a, 16)).toBe('−0x1F3A');
    expect(hexSigned(-32768, 16)).toBe('−0x8000');
    expect(hexSigned(0x7fffff, 24)).toBe('0x7FFFFF');
    expect(hexSigned(-87, 24)).toBe('−0x000057');
  });

  it('decimal is thousands separated with a true minus sign', () => {
    expect(decSigned(-7994)).toBe('−7,994');
    expect(decSigned(32767)).toBe('32,767');
    expect(decSigned(0)).toBe('0');
  });
});

describe('bits as sign and size (30e)', () => {
  it('a sign cell lit for negative, then the magnitude from the high bit', () => {
    const quiet = bitCells(3, 16);
    expect(quiet.sign).toBe(false);
    expect(quiet.cells).toHaveLength(15);
    expect(quiet.cells.slice(0, 13).some(Boolean)).toBe(false);
    expect(quiet.cells.slice(13)).toEqual([true, true]);
    const peak = bitCells(-32768, 16);
    expect(peak.sign).toBe(true);
    expect(peak.cells.every(Boolean)).toBe(true);
    expect(bitCells(0, 24).cells).toHaveLength(23);
  });

  it('full scale is 0x7FFF or −0x8000 (and the 24-bit ends)', () => {
    expect(isFullScale(32767, 16)).toBe(true);
    expect(isFullScale(-32768, 16)).toBe(true);
    expect(isFullScale(32766, 16)).toBe(false);
    expect(isFullScale(8388607, 24)).toBe(true);
    expect(isFullScale(32767, 24)).toBe(false);
  });

  it('counts full scale in the newest samples only, so a frame never counts one twice (256)', () => {
    const buf = new Float32Array(8);
    buf[1] = 1;
    buf[6] = -1;
    buf[7] = 32767 / 32768;
    expect(countFullScale(buf, 2, 16)).toBe(2);
    expect(countFullScale(buf, 8, 16)).toBe(3);
    expect(countFullScale(buf, 0, 16)).toBe(0);
    expect(countFullScale(buf, 99, 16)).toBe(3);
  });

  it('silence is every value exactly zero', () => {
    expect(allZero([])).toBe(false);
    expect(
      allZero([
        { l: 0, r: 0 },
        { l: 0, r: null },
      ]),
    ).toBe(true);
    expect(allZero([{ l: 0, r: 3 }])).toBe(false);
  });
});

describe('the readout (30i)', () => {
  const plain = { fullScale: 0, silent: false };

  it('line 1 is format · rate · depth · channels; line 2 decoded and on disk', () => {
    const r = readout(FLAC, 44100, plain);
    expect(r.line1).toBe('FLAC · 44.1 kHz · 16-bit · stereo');
    expect(r.line2).toBe('1,411 kbps decoded · 912 kbps on disk');
    expect(r.flag).toBeNull();
  });

  it('says both rates when the browser resamples (254)', () => {
    expect(readout({ ...FLAC, fileRate: 96000, bitDepth: 24 }, 48000, plain).line1).toBe(
      'FLAC · 96 kHz file · playing at 48 kHz · 24-bit · stereo',
    );
  });

  it('a lossy file has no bit depth of its own and is shown at 16 bits', () => {
    const mp3: DataInfo = {
      ...FLAC,
      format: 'MP3',
      bitDepth: null,
      lossless: false,
      bitrateKbps: 128,
    };
    const r = readout(mp3, 44100, plain);
    expect(r.line1).toBe('MP3 · 44.1 kHz · stereo');
    expect(r.line2).toBe('128 kbps decoded and on disk');
    expect(r.flag).toBe('Lossy: no bit depth of its own · shown at 16 bits');
    expect(shownDepth(mp3)).toBe(16);
  });

  it('a mono file says so; a station names itself and its stream', () => {
    expect(readout({ ...FLAC, channels: 1 }, 44100, plain).flag).toBe(
      'Mono: one channel, shown once',
    );
    const radio: DataInfo = {
      ...EMPTY_INFO,
      format: 'AAC',
      bitrateKbps: 320,
      station: 'BBC Radio 6 Music',
    };
    const r = readout(radio, 48000, plain);
    expect(r.line1).toBe('AAC · 48 kHz · stereo · BBC Radio 6 Music');
    expect(r.line2).toBe('320 kbps stream · decoded to floating point, shown at 16 bits');
  });

  it('full scale is counted in amber words, before silence or mono', () => {
    const r = readout(FLAC, 44100, { fullScale: 14, silent: false });
    expect(r.flag).toBe('At full scale: 0x7FFF reached 14 times');
    expect(r.flagTone).toBe('warning');
    expect(readout(FLAC, 44100, { fullScale: 0, silent: true }).flag).toBe('Silence');
    expect(readout({ ...FLAC, bitDepth: 24 }, 44100, { fullScale: 1, silent: false }).flag).toBe(
      'At full scale: 0x7FFFFF reached 1 time',
    );
  });

  it('the counter, the channels and the slice (255)', () => {
    expect(counterWords(4512768.4, 2, false)).toBe('4,512,768 samples played per channel');
    expect(counterWords(10, 1, false)).toBe('10 samples played');
    expect(counterWords(10, 2, true)).toBe('10 samples since you tuned in per channel');
    expect(channelWords(6)).toBe('6 channels, showing L and R');
    expect(sliceWords(44100, 60)).toBe(
      'The newest sample is at the bottom; one row in every 735, 60 times a second',
    );
    expect(sliceWords(48000, 120)).toContain('one row in every 400, 120 times');
  });

  it('rows fit the core: 22px each, at most 20 (24 lines on a phone, in L/R pairs)', () => {
    expect(rowsThatFit(600, false, false)).toBe(20);
    expect(rowsThatFit(200, false, false)).toBe(8);
    expect(rowsThatFit(40, false, false)).toBe(4);
    expect(rowsThatFit(900, true, false)).toBe(12);
    expect(rowsThatFit(900, true, true)).toBe(24);
  });
});
