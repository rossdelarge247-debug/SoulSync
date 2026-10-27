/**
 * A track's beat grid as the engine uses it (auto-mix stage A's
 * `GET /api/library/dj/grid/<id>`, CONTRACTS "Auto-mix stage A"): beat i's
 * time, the beat at a time, bars from the first downbeat. Mirrors
 * core/dj/grid.py's Grid: a constant grid runs on past the analysed part,
 * a beat list carries on at its first and last period.
 */

export interface ApiGrid {
  track_id: string;
  analyzed: boolean;
  reason?: string;
  bpm?: number | null;
  grid?: {
    kind: 'constant' | 'beats';
    first_beat: number;
    period: number;
    beats: number[] | null;
    confidence: number;
    steady?: boolean;
    confident?: boolean;
  };
  downbeats?: {
    first: number;
    beat_index: number;
    beats_per_bar?: number;
    meter?: string;
    confidence?: number;
    uncertain?: boolean;
    note?: string | null;
  };
  bars?: number;
  loudness?: { replaygain_db: number | null; level_db: number | null; source?: string } | null;
  analysed_s?: number;
  truncated?: boolean;
}

export class BeatGrid {
  readonly kind: 'constant' | 'beats';
  readonly period: number;
  readonly firstBeat: number;
  readonly downbeatIndex: number;
  readonly beats: readonly number[] | null;

  constructor(opts: {
    kind?: 'constant' | 'beats';
    period: number;
    firstBeat: number;
    downbeatIndex?: number;
    beats?: readonly number[] | null;
  }) {
    if (!(opts.period > 0) || !Number.isFinite(opts.period))
      throw new Error('a grid needs a period');
    this.kind = opts.kind === 'beats' && opts.beats && opts.beats.length > 1 ? 'beats' : 'constant';
    this.period = opts.period;
    this.firstBeat = opts.firstBeat;
    this.downbeatIndex = opts.downbeatIndex ?? 0;
    this.beats = this.kind === 'beats' ? (opts.beats ?? null) : null;
  }

  /** The time (seconds in the track) of beat i (fractional). */
  timeAt(i: number): number {
    const b = this.beats;
    if (b) {
      const n = b.length;
      const k = Math.floor(i);
      if (k >= 0 && k < n - 1) return b[k] + (i - k) * (b[k + 1] - b[k]);
      if (k >= n - 1) return b[n - 1] + (i - (n - 1)) * (b[n - 1] - b[n - 2]);
      return b[0] + i * (b[1] - b[0]);
    }
    return this.firstBeat + i * this.period;
  }

  /** The (fractional) beat playing at a time. */
  beatAt(t: number): number {
    const b = this.beats;
    if (b) {
      const n = b.length;
      if (t <= b[0]) return (t - b[0]) / (b[1] - b[0]);
      if (t >= b[n - 1]) return n - 1 + (t - b[n - 1]) / (b[n - 1] - b[n - 2]);
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (b[mid] <= t) lo = mid;
        else hi = mid;
      }
      return lo + (t - b[lo]) / (b[lo + 1] - b[lo] || this.period);
    }
    return (t - this.firstBeat) / this.period;
  }

  /** How long beat i lasts (seconds). */
  periodAt(i: number): number {
    const k = Math.floor(i);
    return this.timeAt(k + 1) - this.timeAt(k);
  }

  /** Bar b's first beat (bar 0 is the first downbeat). */
  barBeat(bar: number): number {
    return this.downbeatIndex + 4 * bar;
  }

  barTime(bar: number): number {
    return this.timeAt(this.barBeat(bar));
  }
}

/** The engine's grid for a track, or null when it has none to mix on. */
export function gridFromApi(g: ApiGrid | null | undefined): BeatGrid | null {
  if (!g || !g.analyzed || !g.grid || !(g.grid.period > 0)) return null;
  return new BeatGrid({
    kind: g.grid.kind,
    period: g.grid.period,
    firstBeat: g.grid.first_beat,
    downbeatIndex: g.downbeats?.beat_index ?? 0,
    beats: g.grid.beats,
  });
}

/**
 * The incoming deck's trim (dB) so the two sound as loud: from ReplayGain
 * when both tracks have it, else from the analysed levels; kept within ±9 dB.
 */
export function relativeTrimDb(out: ApiGrid | null, incoming: ApiGrid | null): number {
  const a = out?.loudness;
  const b = incoming?.loudness;
  let db = 0;
  if (a?.replaygain_db != null && b?.replaygain_db != null) db = b.replaygain_db - a.replaygain_db;
  else if (a?.level_db != null && b?.level_db != null) db = a.level_db - b.level_db;
  if (!Number.isFinite(db)) return 0;
  return Math.max(-9, Math.min(9, db));
}
