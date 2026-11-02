/** Test data for DJ mode's lanes (the tests and nothing else import it). */
import type { LaneApiGrid } from './dj-mode.logic';

/** 120 BPM (a beat every 0.5 s, a bar every 2 s), the first downbeat at 1 s, 142 bars. */
export function apiGrid(over: Partial<LaneApiGrid> = {}): LaneApiGrid {
  return {
    track_id: 't2',
    analyzed: true,
    bpm: 120,
    grid: {
      kind: 'constant',
      first_beat: 1,
      period: 0.5,
      beats: null,
      confidence: 0.9,
      confident: true,
    },
    downbeats: { first: 1, beat_index: 0, beats_per_bar: 4, meter: '4/4' },
    bars: 142,
    sections: [
      { kind: 'intro', start_bar: 0, end_bar: 16, start: 1, end: 33 },
      { kind: 'main', start_bar: 16, end_bar: 64, start: 33, end: 129 },
      { kind: 'breakdown', start_bar: 64, end_bar: 80, start: 129, end: 161 },
      { kind: 'drop', start_bar: 80, end_bar: 112, start: 161, end: 225 },
      { kind: 'outro', start_bar: 112, end_bar: 142, start: 225, end: 285 },
    ],
    mix_in: { start_bar: 0, end_bar: 16, start: 1, end: 33 },
    mix_out: { start_bar: 120, end_bar: 142, start: 241, end: 285 },
    ...over,
  };
}
