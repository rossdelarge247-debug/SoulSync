import { describe, expect, it } from 'vitest';

import type { DragItem } from '@/features/dnd/dnd-model';

import { apiGrid } from './dj-mode.fixtures';
import {
  barLine,
  barAt,
  barsWithin,
  beatMap,
  inMixOut,
  beatMapWords,
  clock,
  cuedLine,
  cueTime,
  djAvailability,
  dropRefusal,
  dropStepLine,
  gridProblem,
  headerLine,
  keyStepWords,
  laneGrid,
  laneGroupName,
  laneLine,
  laneVerdict,
  noGridWords,
  phraseAt,
  tempoStepWords,
} from './dj-mode.logic';

const LIB = {
  id: '2',
  title: 'Night Ferry',
  artist: 'Tidewater',
  is_library: true,
  filename: '/music/night-ferry.flac',
};

describe('the toggle is offered (425, 417, 37l)', () => {
  it('for a library track with its file, on a laptop or desktop', () => {
    expect(djAvailability({ track: LIB, kind: 'library', phone: false })).toEqual({
      offered: true,
      why: null,
    });
  });

  it('never on a phone, whatever plays (417)', () => {
    expect(djAvailability({ track: LIB, kind: 'library', phone: true })).toEqual({
      offered: false,
      why: 'phone',
    });
  });

  it('not with nothing playing', () => {
    expect(djAvailability({ track: null, kind: null, phone: false }).why).toBe('nothing');
  });

  it.each([
    ['radio', { title: 'NTS 1', is_library: false, kind: 'radio' }, 'radio'],
    ['a podcast', { title: 'Ep 1', is_library: false, kind: 'podcast', id: 'p1' }, 'podcast'],
    ['an audiobook', { title: 'Ch 1', is_library: false, kind: 'audiobook' }, 'audiobook'],
    ['a stream (Spotify, a search result)', { title: 'X', is_library: false, id: 's' }, 'stream'],
    ['a 30-second preview', { ...LIB, is_library: false, is_preview: true }, 'stream'],
    [
      'a queued track still downloading',
      { ...LIB, is_library: false, download_pending: true },
      'stream',
    ],
  ])('not for %s', (_, track, kind) => {
    expect(djAvailability({ track, kind, phone: false })).toEqual({
      offered: false,
      why: 'not_library',
    });
  });

  it('not for a library track whose file is away (the drive isn’t connected)', () => {
    expect(
      djAvailability({ track: LIB, kind: 'library', phone: false, libraryAway: true }).why,
    ).toBe('file_away');
    expect(
      djAvailability({ track: { ...LIB, filename: '' }, kind: 'library', phone: false }).why,
    ).toBe('file_away');
  });

  it('is not behind the mixing setting: nothing about it is read', () => {
    window.localStorage.setItem('soulsync-mix-tab', '0');
    expect(djAvailability({ track: LIB, kind: 'library', phone: false }).offered).toBe(true);
    window.localStorage.removeItem('soulsync-mix-tab');
  });
});

describe('the beat map from a grid (37b)', () => {
  const g = laneGrid(apiGrid())!;
  const duration = 286;

  it('a tick a bar, a phrase every 8 bars, a number every 32', () => {
    const map = beatMap(g, duration);
    expect(map.ticks).toHaveLength(142);
    expect(map.ticks[0]).toEqual({ bar: 1, x: 1 / 286, phrase: true, label: 1 });
    expect(map.ticks.filter((t) => t.phrase).map((t) => t.bar)).toEqual([
      1, 9, 17, 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, 105, 113, 121, 129, 137,
    ]);
    expect(map.ticks.filter((t) => t.label !== null).map((t) => t.label)).toEqual([
      1, 33, 65, 97, 129,
    ]);
    // bar 33 starts 32 bars (64 s) after the first downbeat
    expect(map.ticks[32]!.x).toBeCloseTo(65 / 286, 6);
  });

  it('places the mix-in and mix-out regions and the sections across the lane', () => {
    const map = beatMap(g, duration);
    expect(map.mixIn).toEqual({ x0: 1 / 286, x1: 33 / 286 });
    expect(map.mixOut!.x0).toBeCloseTo(241 / 286, 6);
    expect(map.mixOut!.x1).toBeCloseTo(285 / 286, 6);
    expect(map.sections.map((s) => s.kind)).toEqual([
      'intro',
      'main',
      'breakdown',
      'drop',
      'outro',
    ]);
    expect(map.sections[3]!.x0).toBeCloseTo(161 / 286, 6);
  });

  it('follows a beat list (a grid that drifts), not just a constant one', () => {
    const beats = Array.from(
      { length: 64 },
      (_, i) => 2 + i * 0.5 + (i > 31 ? 0.01 * (i - 31) : 0),
    );
    const drift = laneGrid(
      apiGrid({
        bars: 16,
        grid: { kind: 'beats', first_beat: 2, period: 0.5, beats, confidence: 0.9 },
        sections: [],
        mix_in: null,
        mix_out: null,
      }),
    )!;
    const map = beatMap(drift, 40);
    expect(map.ticks).toHaveLength(16);
    expect(map.ticks[8]!.x * 40).toBeCloseTo(beats[32]!, 6);
    expect(map.mixIn).toBeNull();
  });

  it('shows only the window when zoomed (3b’s seam): ticks inside it, regions clipped', () => {
    const map = beatMap(g, duration, { start: 233, end: 265 });
    expect(map.ticks.map((t) => t.bar)).toEqual(Array.from({ length: 17 }, (_, i) => 117 + i));
    expect(map.ticks[0]!.x).toBe(0);
    expect(map.mixOut).toEqual({ x0: 0.25, x1: 1 });
    expect(map.mixIn).toBeNull();
  });

  it('drops ticks past the file’s end and says nothing for no bars', () => {
    // bar 51 starts at 101 s exactly: it's in; bar 52 isn't
    expect(beatMap(g, 101).ticks).toHaveLength(51);
    expect(beatMap(laneGrid(apiGrid({ bars: 0 }))!, 286).ticks).toEqual([]);
  });

  it('says the map in words (an image with text, 37p)', () => {
    expect(beatMapWords(g)).toBe(
      'Beat map: 142 bars, a phrase every 8; mix-in bars 1 to 16; mix-out bars 121 to 142; sections: intro, main, breakdown, drop, outro',
    );
  });
});

describe('the line under a lane (37b), its text equivalent', () => {
  const g = laneGrid(apiGrid())!;

  it('bar n of N, the next drop, the mix-out', () => {
    // 121 s: (121 − 1) / 2 = bar index 60, bar 61
    expect(laneLine(g, 121)).toBe('bar 61 of 142 · drop in 0:40 · mix-out from bar 121 (4:01)');
  });

  it('in the drop, and in the mix-out', () => {
    expect(laneLine(g, 170)).toBe('bar 85 of 142 · in the drop · mix-out from bar 121 (4:01)');
    expect(laneLine(g, 250)).toBe('bar 125 of 142 · in the mix-out');
  });

  it('bar 1 before the first downbeat, never past the last', () => {
    expect(barAt(g, 0)).toBe(1);
    expect(barAt(g, 9999)).toBe(142);
  });

  it('changes once a phrase: the phrase index moves every 8 bars', () => {
    expect(phraseAt(g, 1)).toBe(0);
    expect(phraseAt(g, 16.9)).toBe(0);
    expect(phraseAt(g, 17)).toBe(1);
    expect(phraseAt(null, 17)).toBe(-1);
  });

  it('B is cued at its mix-in and says so (37m)', () => {
    expect(cueTime(g)).toBe(1);
    expect(cuedLine(g)).toBe('cued at bar 1 of 142 · mix-out from bar 121');
    const noIn = laneGrid(apiGrid({ mix_in: null, mix_out: null }))!;
    expect(cueTime(noIn)).toBe(1);
    expect(cuedLine(noIn)).toBe('cued at bar 1 of 142');
    expect(cueTime(null)).toBe(0);
  });

  it('clock', () => {
    expect(clock(62)).toBe('1:02');
    expect(clock(0)).toBe('0:00');
    expect(clock(Number.NaN)).toBe('0:00');
  });
});

describe('a grid that can’t be blended on (37d)', () => {
  it('says why, in the lane', () => {
    expect(noGridWords('Harbour Lights', 'no_beat')).toBe(
      'Harbour Lights has no steady beat: Sync is off, blend by ear',
    );
    expect(noGridWords('Harbour Lights', 'not_4_4')).toBe(
      'Harbour Lights isn’t in 4/4: Sync is off, blend by ear',
    );
    expect(noGridWords('A Long Mix', 'too_long')).toBe(
      'A Long Mix is too long to analyse: Sync is off, blend by ear',
    );
    expect(noGridWords('Sand Script', 'unreachable')).toBe(
      'Sand Script couldn’t be read: Sync is off, blend by ear',
    );
  });

  it('a grid that isn’t in 4/4 or isn’t sure is no grid to blend on', () => {
    expect(gridProblem(laneGrid(apiGrid())!)).toBeNull();
    const waltz = laneGrid(apiGrid({ downbeats: { first: 1, beat_index: 0, meter: '3/4' } }))!;
    expect(gridProblem(waltz)).toBe('not_4_4');
    const unsure = laneGrid(
      apiGrid({
        grid: {
          kind: 'constant',
          first_beat: 1,
          period: 0.5,
          beats: null,
          confidence: 0.2,
          confident: false,
        },
      }),
    )!;
    expect(gridProblem(unsure)).toBe('unsure');
    expect(laneGrid({ track_id: 'x', analyzed: false, reason: 'no_beat' })).toBeNull();
  });
});

describe('lane B’s drop (37c, 37d)', () => {
  const item = (over: Partial<DragItem> = {}): DragItem => ({
    id: '8',
    title: 'Harbour Lights',
    artist: 'Tidewater',
    key: '8A',
    bpm: 126,
    inLibrary: true,
    ...over,
  });

  it('takes a library track that isn’t the playing one', () => {
    expect(laneVerdict([item()], { playingId: '2' })).toEqual({ ok: true });
    expect(dropRefusal(item(), { playingId: null })).toBeNull();
  });

  it('refuses a track whose drive is away, with its name', () => {
    expect(laneVerdict([item({ title: 'Low Tide', away: 'Music' })], { playingId: '2' })).toEqual({
      ok: false,
      reason: 'Can’t load Low Tide: its file is on a drive that isn’t connected',
    });
    expect(dropRefusal(item({ title: 'Low Tide', fileMissing: true }), { playingId: '2' })).toBe(
      'Can’t load Low Tide: its file is on a drive that isn’t connected',
    );
  });

  it('refuses what isn’t a library track (radio, a podcast, a Search result that isn’t yours)', () => {
    expect(dropRefusal(item({ inLibrary: false }), { playingId: '2' })).toBe(
      'Only a track from your library can be the second track',
    );
    expect(laneVerdict([], { playingId: '2' }).ok).toBe(false);
  });

  it('refuses the playing track itself (a version of it is another id, and fine)', () => {
    expect(dropRefusal(item({ id: '2' }), { playingId: '2' })).toBe(
      'That’s the track that’s playing',
    );
    expect(dropRefusal(item({ id: '2-dub' }), { playingId: '2' })).toBeNull();
  });

  it('names the step it would make: "Same key · +1.6% · has its beat grid"', () => {
    const a = { key: '8A', bpm: 124 };
    expect(dropStepLine(a, { key: '8A', bpm: 126 }, true)).toBe(
      'Same key · +1.6% · has its beat grid',
    );
    expect(dropStepLine(a, { key: '9A', bpm: 124 }, false)).toBe(
      '+1 on the wheel · same tempo · analysed when it’s loaded',
    );
    expect(dropStepLine(a, { key: '8B', bpm: 62 }, null)).toBe('Relative · half time');
    expect(dropStepLine(a, { key: null, bpm: null }, true)).toBe('Has its beat grid');
    expect(dropStepLine(null, { key: '8A', bpm: 126 }, null)).toBe('');
  });

  it('key and tempo steps', () => {
    expect(keyStepWords('8A', '7A')).toBe('−1 on the wheel');
    expect(keyStepWords('12A', '1A')).toBe('+1 on the wheel');
    expect(keyStepWords('8A', '11A')).toBe('3 steps on the wheel');
    expect(keyStepWords('8A', null)).toBe('');
    expect(tempoStepWords(124, 120)).toBe('−3.2%');
    expect(tempoStepWords(124, 248)).toBe('double time');
    expect(tempoStepWords(124, 62)).toBe('half time');
    expect(tempoStepWords(null, 120)).toBe('');
  });
});

describe('words', () => {
  it('a lane is a named group (37p)', () => {
    expect(laneGroupName('A', 'Night Ferry', 'playing', 'bar 61 of 142')).toBe(
      'Deck A, Night Ferry, playing, bar 61 of 142',
    );
    expect(laneGroupName('B', null, '')).toBe('Deck B, empty');
  });

  it('the header’s line (37b, 37e, 37m)', () => {
    const base = { a: 'Night Ferry', aPhase: 'ready' as const, b: null, bPhase: null };
    expect(headerLine({ ...base, browse: true })).toBe(
      'Night Ferry on the speakers · drop or Browse a second track',
    );
    // step 2: no Browse yet, so the line doesn't offer it
    expect(headerLine({ ...base, browse: false })).toBe(
      'Night Ferry on the speakers · drop a second track',
    );
    expect(headerLine({ ...base, aPhase: 'analysing', browse: true })).toBe(
      'Analysing Night Ferry · you can load B now; Sync comes with the grid',
    );
    expect(headerLine({ ...base, b: 'Harbour Lights', bPhase: 'ready', browse: true })).toBe(
      'Harbour Lights cued',
    );
    expect(headerLine({ ...base, b: 'Harbour Lights', bPhase: 'analysing', browse: true })).toBe(
      'Analysing Harbour Lights · Sync comes with the grid',
    );
  });

  it('the header’s line follows the mixer (37g, 37h)', () => {
    const cued = {
      a: 'Night Ferry',
      aPhase: 'ready' as const,
      b: 'Harbour Lights',
      bPhase: 'ready' as const,
      browse: true,
    };
    expect(headerLine({ ...cued, mix: 'loading' })).toBe(
      'Harbour Lights cued · getting the decks ready',
    );
    expect(headerLine({ ...cued, mix: 'ready' })).toBe(
      'Harbour Lights cued · Play B, then move the fader',
    );
    expect(headerLine({ ...cued, mix: 'starting' })).toBe('Blending · Back ends it over a bar');
    expect(headerLine({ ...cued, mix: 'playing' })).toBe('Blending · Back ends it over a bar');
    expect(headerLine({ ...cued, mix: 'paused' })).toBe(
      'Harbour Lights paused · Play B carries on on the next bar',
    );
    expect(headerLine({ ...cued, mix: 'backing' })).toBe('Bringing Night Ferry back over a bar');
  });
});

describe('the analysis popover names DJ mode', () => {
  it('a lane’s ask (source dj_now) reads “DJ mode” in the line', async () => {
    const { whyWords } = await import('@/features/dj/analysis.format');
    const e = (by: string | null) => ({
      track_id: '2',
      title: 'Night Ferry',
      artist: 'Tidewater',
      position: 1,
      source: 'dj_now' as const,
      by,
      set_name: null,
      front: true,
    });
    expect(whyWords(e('you'))).toBe('DJ mode');
    expect(whyWords(e('Mira K.'))).toBe("Mira's DJ mode");
  });
});

describe('a long file analysed in part (review L6)', () => {
  const g = laneGrid(apiGrid({ bars: 60, truncated: true, analysed_s: 121, mix_out: null }))!;

  it('the ticks follow the grid on to the file’s end, and the analysed part’s end is marked', () => {
    const map = beatMap(g, 286);
    expect(barsWithin(g, 286)).toBe(143);
    expect(map.ticks).toHaveLength(143);
    expect(map.analysedTo).toBeCloseTo(121 / 286, 6);
    // a whole grid has no marker and stops at its own bars
    expect(beatMap(laneGrid(apiGrid())!, 286).analysedTo).toBeNull();
  });

  it('the line says past the analysed part, not a wrong bar; the mix-out is reached once', () => {
    expect(laneLine(g, 100)).toBe('bar 50 of 60 · drop in 1:01');
    expect(laneLine(g, 130)).toBe('past the analysed part (the first 2:01)');
    const whole = laneGrid(apiGrid())!;
    expect(inMixOut(whole, 240)).toBe(false);
    expect(inMixOut(whole, 241)).toBe(true);
    expect(inMixOut(null, 999)).toBe(false);
  });
});

describe('step 4: the header while handing over or B plays alone, and the bar’s one line (37o)', () => {
  const base = {
    a: 'Night Ferry',
    aPhase: 'ready' as const,
    b: 'Harbour Lights',
    bPhase: 'ready' as const,
    browse: true,
  };
  it('the header', () => {
    expect(headerLine({ ...base, mix: 'handing' })).toBe('Handing over to Harbour Lights');
    expect(headerLine({ ...base, mix: 'playing', solo: true })).toBe(
      'Harbour Lights on its own · Hand over makes it the player’s track',
    );
  });

  it('the bar: nothing with DJ mode off or the Visuals open; with B, cued or blending', () => {
    expect(barLine({ on: false, open: false, b: 'Harbour Lights', mix: 'playing' })).toBeNull();
    expect(barLine({ on: true, open: true, b: 'Harbour Lights', mix: 'playing' })).toBeNull();
    expect(barLine({ on: true, open: false, b: null, mix: 'idle' })).toBeNull();
    expect(barLine({ on: true, open: false, b: 'Harbour Lights', mix: 'ready' })).toBe(
      'DJ mode · Harbour Lights cued',
    );
    expect(barLine({ on: true, open: false, b: 'Harbour Lights', mix: 'playing' })).toBe(
      'DJ mode · blending into Harbour Lights',
    );
    expect(barLine({ on: true, open: false, b: 'Harbour Lights', mix: 'paused' })).toBe(
      'DJ mode · Harbour Lights paused',
    );
    expect(barLine({ on: true, open: false, b: null, mix: 'handing' })).toBe(
      'DJ mode · handing over to B',
    );
  });
});
