import { describe, expect, it } from 'vitest';

import {
  spokenProgressWords,
  spokenRecentMeta,
  spokenPlayLine,
  albumLine,
  barCount,
  chapterTicks,
  formatClock,
  formatFromPath,
  formatReadout,
  formatRemaining,
  formatSpeed,
  formatSpeedValue,
  fractionAt,
  parseChapters,
  pathLabel,
  peaksRetryDelay,
  PLAYER_STATE_KEY,
  positionText,
  queueFoot,
  readTrayState,
  seekStep,
  shortFormat,
  sleepButtonLabel,
  sleepButtonText,
  sleepChoiceLabel,
  sleepLabel,
  sourceLabel,
  sourceView,
  timeAgo,
  upNextCount,
  volumeDb,
  waveformBars,
  writeTrayState,
} from './player-state';

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('the tray state, remembered per browser', () => {
  it('is the bar by default, and the tray once chosen', () => {
    const store = memoryStore();
    expect(readTrayState(store)).toBe('bar');
    writeTrayState(store, 'tray');
    expect(store.data.get(PLAYER_STATE_KEY)).toBe('1');
    expect(readTrayState(store)).toBe('tray');
    writeTrayState(store, 'bar');
    expect(store.data.has(PLAYER_STATE_KEY)).toBe(false);
    expect(readTrayState(store)).toBe('bar');
  });

  it('falls back to the bar when storage is missing or blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readTrayState(null)).toBe('bar');
    expect(readTrayState(blocked)).toBe('bar');
    expect(() => writeTrayState(blocked, 'tray')).not.toThrow();
  });
});

describe('source kinds', () => {
  it('library and stream: Previous / Next, a waveform, times', () => {
    for (const kind of ['library', 'stream'] as const) {
      const v = sourceView(kind);
      expect(v).toMatchObject({
        progress: 'waveform',
        times: true,
        skip: null,
        speedButton: false,
      });
    }
    expect(sourceView(undefined).kind).toBe('library');
  });

  it('podcasts and audiobooks: −15 s / +30 s and the speed button', () => {
    for (const kind of ['podcast', 'audiobook'] as const) {
      expect(sourceView(kind)).toMatchObject({
        skip: { back: 15, forward: 30 },
        speedButton: true,
        progress: 'waveform',
      });
    }
  });

  it('radio is only the seam: Live, a level meter, one action slot', () => {
    expect(sourceView('radio')).toMatchObject({
      progress: 'meter',
      times: false,
      actionSlot: true,
      queueModes: false,
      speedButton: false,
    });
  });

  it('where each kind plays from, when the server does not say', () => {
    expect(sourceLabel('library', null)).toBe('Library');
    expect(sourceLabel('podcast', null)).toBe('Podcast feed');
    expect(sourceLabel('audiobook', null)).toBe('Audiobook sample');
    expect(sourceLabel('stream', { username: 'peer' })).toBe('Soulseek');
    expect(sourceLabel('stream', { is_preview: true })).toBe('Preview');
  });
});

describe('times', () => {
  it('clock, remaining, spoken', () => {
    expect(formatClock(102)).toBe('1:42');
    expect(formatClock(3727)).toBe('1:02:07');
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatRemaining(102, 276)).toBe('−2:54');
    expect(positionText(102, 276)).toBe('1 minute 42 seconds of 4 minutes 36 seconds');
    expect(positionText(0, 60)).toBe('0 seconds of 1 minute');
  });

  it('slider keys move 5 s, Page keys 30 s, Home / End the ends, clamped', () => {
    expect(seekStep('ArrowRight', 10, 100)).toBe(15);
    expect(seekStep('ArrowLeft', 2, 100)).toBe(0);
    expect(seekStep('PageUp', 90, 100)).toBe(100);
    expect(seekStep('Home', 50, 100)).toBe(0);
    expect(seekStep('End', 50, 100)).toBe(99);
    expect(seekStep('a', 50, 100)).toBeNull();
    expect(seekStep('ArrowRight', 0, 0)).toBeNull();
  });

  it('the pointer fraction is clamped', () => {
    expect(fractionAt(150, 100, 200)).toBe(0.25);
    expect(fractionAt(0, 100, 200)).toBe(0);
    expect(fractionAt(999, 100, 200)).toBe(1);
  });
});

describe('the readout', () => {
  it('lossless with depth and rate, lossy with bitrate and rate', () => {
    expect(
      formatReadout({ format: 'FLAC', bit_depth: 24, sample_rate: 96000, bitrate_kbps: 2304 }),
    ).toBe('FLAC 24/96 · 2,304 kbps');
    expect(formatReadout({ format: 'MP3', bitrate_kbps: 320, sample_rate: 44100 })).toBe(
      'MP3 · 320 kbps · 44.1 kHz',
    );
    expect(formatReadout(null)).toBe('—');
    expect(shortFormat({ format: 'FLAC', bit_depth: 16, sample_rate: 44100 })).toBe('FLAC 16/44.1');
    expect(shortFormat({ format: 'MP3', bitrate_kbps: 320 })).toBe('MP3 320');
  });

  it('formats from file names, the path label, the album line', () => {
    expect(formatFromPath('/music/a.flac')).toBe('FLAC');
    expect(formatFromPath('/stream/x.m4a?token=1')).toBe('AAC');
    expect(formatFromPath('noext')).toBeNull();
    expect(pathLabel('Library', null)).toBe('Library → This device');
    expect(pathLabel('Library', 'Living room')).toBe('Library → Living room');
    expect(
      albumLine({ album: 'Lantern', year: 2024, track_number: 3, album_track_count: 11 }),
    ).toBe('Lantern · 2024 · track 3 of 11');
  });

  it('volume in dB', () => {
    expect(volumeDb(100)).toBe('0 dB');
    expect(volumeDb(25)).toBe('−12 dB');
    expect(volumeDb(0)).toBe('Muted');
    expect(volumeDb(60, true)).toBe('Muted');
  });
});

describe('the waveform', () => {
  it('fits the width and resamples to the loudest of each span', () => {
    expect(barCount(498)).toBe(100);
    expect(barCount(10)).toBe(24);
    expect(barCount(5000)).toBe(200);
    expect(waveformBars([0.1, 0.9, 0.3, 0.5], 2)).toEqual([0.9, 0.5]);
    expect(waveformBars(null, 3, 0.1)).toEqual([0.1, 0.1, 0.1]);
    expect(waveformBars([0, 0], 2, 0.08)).toEqual([0.08, 0.08]);
  });

  it('chapter ticks, from PodcastIndex chapters', () => {
    const chapters = parseChapters({
      chapters: [
        { startTime: 0, title: 'Intro' },
        { startTime: 300, title: 'Part 2' },
        { startTime: 450, title: 'hidden', toc: false },
      ],
    });
    expect(chapters).toEqual([
      { start: 0, title: 'Intro' },
      { start: 300, title: 'Part 2' },
    ]);
    expect(chapterTicks(chapters, 600)).toEqual([{ left: 50, title: 'Part 2' }]);
    expect(parseChapters({})).toEqual([]);
  });

  it('peaks polling backs off and gives up', () => {
    expect(peaksRetryDelay(0)).toBe(1500);
    expect(peaksRetryDelay(3)).toBe(8000);
    expect(peaksRetryDelay(6)).toBeNull();
  });
});

describe('the list and menus', () => {
  it('counts what is up next and says what happens after', () => {
    expect(upNextCount({ length: 10, index: 1 })).toBe(8);
    expect(upNextCount({ length: 0, index: -1 })).toBe(0);
    const q = { length: 10, index: 1, radio: false, repeat: 'off' as const, context: '' };
    expect(queueFoot(q)).toBe('8 up next · then playback stops');
    expect(queueFoot({ ...q, radio: true })).toBe('8 up next · then similar tracks');
    expect(queueFoot({ ...q, repeat: 'all', context: 'Lantern' })).toBe(
      '8 up next · from Lantern · then from the top',
    );
    expect(queueFoot({ ...q, index: 9 })).toBe('Nothing up next · playback stops after this');
  });

  it('sleep and speed wording', () => {
    expect(sleepLabel(0, 0, 0)).toBe('Off');
    expect(sleepLabel('track', 0, 0)).toBe('End of track');
    expect(sleepLabel(30, 12 * 60000, 0)).toBe('12 min left');
    expect(sleepChoiceLabel(60)).toBe('1 hour');
    expect(sleepChoiceLabel(15)).toBe('15 minutes');
    expect(sleepChoiceLabel('track')).toBe('At the end of this track');
    expect(formatSpeed(1.2)).toBe('1.2×');
    expect(formatSpeed(1)).toBe('1×');
  });

  it('time ago, from the history table’s UTC stamps', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    expect(timeAgo('2026-10-22 11:57:00', now)).toBe('3 min ago');
    expect(timeAgo('2026-10-22 10:00:00', now)).toBe('2 h ago');
    expect(timeAgo('2026-10-21 10:00:00', now)).toBe('yesterday');
    expect(timeAgo('2026-10-01 10:00:00', now)).toBe('1 Oct');
    expect(timeAgo(null, now)).toBe('');
  });
});

describe('the record’s Sleep timer and the menu’s Speed (HANDOFF 47)', () => {
  it('shows the time left only while it runs', () => {
    const now = 1_000_000;
    expect(sleepButtonText(0, 0, now)).toBe('');
    expect(sleepButtonText('track', 0, now)).toBe('End of track');
    expect(sleepButtonText(30, now + 23 * 60000 - 500, now)).toBe('23 min');
    expect(sleepButtonLabel(0, 0, now)).toBe('Sleep timer, off');
    expect(sleepButtonLabel(15, now + 60000, now)).toBe('Sleep timer, 1 minute left');
    expect(sleepButtonLabel('track', 0, now)).toBe('Sleep timer, at the end of this track');
  });

  it('writes Speed with a decimal', () => {
    expect(formatSpeedValue(1)).toBe('1.0×');
    expect(formatSpeedValue(1.5)).toBe('1.5×');
    expect(formatSpeedValue(1.25)).toBe('1.25×');
    expect(formatSpeedValue(Number.NaN)).toBe('1.0×');
  });
});

describe('podcast and audiobook progress words (HANDOFF 46)', () => {
  it('says how much is left, or that it was played', () => {
    expect(spokenProgressWords({ position_s: 420, duration_s: 1800 })).toBe('23 min left');
    expect(spokenProgressWords({ position_s: 600, duration_s: 9000 })).toBe('2 h 20 min left');
    expect(spokenProgressWords({ position_s: 1800, duration_s: 5400 })).toBe('1 h left');
    expect(spokenProgressWords({ position_s: 120, duration_s: null })).toBe('2 min in');
    expect(spokenProgressWords({ position_s: 2, duration_s: 1800 })).toBe('');
    expect(spokenProgressWords({ position_s: 1790, duration_s: 1800, finished: true })).toBe(
      'Finished',
    );
  });

  it('starts Recent’s meta line with the kind', () => {
    expect(
      spokenRecentMeta({
        kind: 'podcast',
        subtitle: 'Quiet Rooms',
        position_s: 420,
        duration_s: 1800,
      }),
    ).toBe('Podcast · Quiet Rooms · 23 min left');
    expect(spokenRecentMeta({ kind: 'audiobook', subtitle: 'Ann Leckie', finished: true })).toBe(
      'Audiobook · Ann Leckie · sample · Finished',
    );
  });

  it('says "sample" in an audiobook’s play line (HANDOFF 67), never a podcast’s', () => {
    expect(
      spokenPlayLine({
        kind: 'audiobook',
        subtitle: 'Tide Lines',
        position_s: 60,
        duration_s: 240,
      }),
    ).toBe('Tide Lines · sample · 3 min left');
    expect(spokenPlayLine({ kind: 'audiobook', subtitle: 'Tide Lines' })).toBe(
      'Tide Lines · sample',
    );
    expect(
      spokenPlayLine({
        kind: 'podcast',
        subtitle: 'Quiet Rooms',
        position_s: 420,
        duration_s: 1800,
      }),
    ).toBe('Quiet Rooms · 23 min left');
  });
});

describe('the radio meter fills its width (Ross, 2026-10-23)', () => {
  it('counts a bar every 6px (8 in the deck), 12 to 160, 24 before layout', async () => {
    const { meterBarCount, meterBarWidth, meterBin } = await import('./player-state');
    expect(meterBarCount(0)).toBe(24);
    expect(meterBarCount(Number.NaN)).toBe(24);
    expect(meterBarCount(120)).toBe(20);
    expect(meterBarCount(598)).toBe(100);
    expect(meterBarCount(688, 8)).toBe(86);
    expect(meterBarCount(40)).toBe(12);
    expect(meterBarCount(4000)).toBe(160);
    // whole-pixel bars so they draw crisply
    expect(meterBarWidth(598, 100)).toBe(4);
    expect(meterBarWidth(0, 10)).toBe(0);
    // the bins spread logarithmically, from 1 to the top
    expect(meterBin(0, 20, 57)).toBe(1);
    expect(meterBin(19, 20, 57)).toBe(57);
    expect(meterBin(10, 20, 57)).toBeLessThan(57 / 2);
  });
});

describe('Scan now goes icon-only by room (148)', () => {
  it('keeps its word while the track block can have 240px beside the least meter', async () => {
    const { scanIconOnly } = await import('./player-state');
    // a narrow centre: 600 less the action and gaps (150), the meter (120) and Scan now (132)
    expect(scanIconOnly(600, 150, 120)).toBe(true);
    // 1920: plenty of room
    expect(scanIconOnly(1180, 150, 120)).toBe(false);
    // exactly 240 left keeps the word; a pixel less doesn't
    expect(scanIconOnly(150 + 120 + 132 + 240, 150, 120)).toBe(false);
    expect(scanIconOnly(150 + 120 + 132 + 239, 150, 120)).toBe(true);
    // not laid out yet: leave it as it is
    expect(scanIconOnly(0, 150, 120)).toBe(false);
  });
});
