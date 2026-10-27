/**
 * Each of 26a's styles as a score: what every control of the two decks does,
 * beat by beat, through the window (master beats φ from the outgoing phrase,
 * four a bar; clock.ts turns them into context seconds). Pure data, so the
 * executor schedules it as AudioParam automation and Decks (26j) can draw it.
 *
 * The decks' controls (graph.ts): trim (loudness), the 3-band EQ in dB (low
 * shelf, mid peak, high shelf; KILL_DB is a kill), a high-pass and a
 * low-pass filter (Hz), the volume, the crossfader's gain for the deck, and
 * an echo (send, feedback, its tone (a high-pass in the loop), return and
 * time). The echo's return goes to the master past the volume and the
 * crossfader, so an echo out keeps its tail after the deck is cut.
 */

export type Style =
  | 'long_blend'
  | 'short_blend'
  | 'bass_swap'
  | 'cut'
  | 'echo_out'
  | 'filter_sweep'
  | 'drop_swap'
  | 'crossfade';

export const STYLES: readonly Style[] = [
  'long_blend',
  'short_blend',
  'bass_swap',
  'cut',
  'echo_out',
  'filter_sweep',
  'drop_swap',
  'crossfade',
];

export type DeckId = 'A' | 'B';
export type ParamName =
  | 'trim'
  | 'volume'
  | 'xf'
  | 'low'
  | 'mid'
  | 'high'
  | 'hp'
  | 'lp'
  | 'echoSend'
  | 'echoReturn'
  | 'echoFeedback'
  | 'echoTone'
  | 'echoTime';
export type ParamKey = `${DeckId}.${ParamName}`;

export const PARAM_NAMES: readonly ParamName[] = [
  'trim',
  'volume',
  'xf',
  'low',
  'mid',
  'high',
  'hp',
  'lp',
  'echoSend',
  'echoReturn',
  'echoFeedback',
  'echoTone',
  'echoTime',
];

/** An EQ band all the way down. */
export const KILL_DB = -40;
export const HP_OPEN = 12;
export const LP_OPEN = 20000;

/** Every control at rest: a deck that plays as it is. */
export const NEUTRAL: Readonly<Record<ParamName, number>> = {
  trim: 1,
  volume: 1,
  xf: 1,
  low: 0,
  mid: 0,
  high: 0,
  hp: HP_OPEN,
  lp: LP_OPEN,
  echoSend: 0,
  echoReturn: 1,
  echoFeedback: 0.55,
  echoTone: 250,
  echoTime: 0.5,
};

/** Frequencies move on exponential ramps; everything else in straight lines. */
export function rampFor(name: ParamName): 'linear' | 'exp' {
  return name === 'hp' || name === 'lp' || name === 'echoTone' ? 'exp' : 'linear';
}

export interface Point {
  beat: number;
  value: number;
  ramp: 'set' | 'linear' | 'exp';
}

export interface Score {
  style: Style;
  /** the window (Φ, master beats; seconds for a crossfade) */
  beats: number;
  /** both decks play on one beat (tempo matched) */
  beatmatch: boolean;
  /** each automated control's points, in time order */
  lanes: Partial<Record<ParamKey, Point[]>>;
  /** where the incoming deck starts (its `in.start`) */
  bStart: number;
  /** after this the outgoing deck can stop (its echo may ring on) */
  aStop: number;
  /** the bass swap or the drop, for the handover view ("bass swaps at bar 16") */
  marker: { beat: number; label: string } | null;
}

export interface ScoreOptions {
  /** the incoming deck's trim (dB), from the two tracks' loudness */
  trimDb?: number;
  /** a crossfade's length (seconds) when there's no beat to count */
  crossfadeSeconds?: number;
  /** the outgoing deck's beat (seconds), for the echo's time */
  beatSeconds?: number;
}

export const DEFAULT_BARS: Readonly<Record<Style, number>> = {
  long_blend: 32,
  short_blend: 8,
  bass_swap: 16,
  cut: 0,
  echo_out: 4,
  filter_sweep: 16,
  drop_swap: 16,
  crossfade: 0,
};

const BEATMATCH: ReadonlySet<Style> = new Set([
  'long_blend',
  'short_blend',
  'bass_swap',
  'filter_sweep',
  'drop_swap',
]);

export function needsBeatmatch(style: Style): boolean {
  return BEATMATCH.has(style);
}

/** A tiny ramp, so a cut on the one doesn't click (about 15 ms at 124 BPM). */
const SNAP = 1 / 32;

class Builder {
  readonly lanes: Partial<Record<ParamKey, Point[]>> = {};

  set(key: ParamKey, beat: number, value: number): this {
    (this.lanes[key] ??= []).push({ beat, value, ramp: 'set' });
    return this;
  }

  to(key: ParamKey, beat: number, value: number, ramp: 'linear' | 'exp' = 'linear'): this {
    (this.lanes[key] ??= []).push({ beat, value, ramp });
    return this;
  }

  /** From `from` at b0 to `to` at b1 on a quarter sine (equal power), in eight straight steps. */
  curve(
    key: ParamKey,
    b0: number,
    b1: number,
    from: number,
    to: number,
    shape: 'in' | 'out',
  ): this {
    this.set(key, b0, from);
    for (let k = 1; k <= 8; k++) {
      const u = k / 8;
      const s = shape === 'in' ? Math.sin((u * Math.PI) / 2) : 1 - Math.cos((u * Math.PI) / 2);
      this.to(key, b0 + (b1 - b0) * u, k === 8 ? to : from + (to - from) * s);
    }
    return this;
  }

  line(
    key: ParamKey,
    b0: number,
    b1: number,
    from: number,
    to: number,
    ramp: 'linear' | 'exp' = 'linear',
  ): this {
    return this.set(key, b0, from).to(key, b1, to, ramp);
  }
}

/** The score for a style and a length in bars (a crossfade's length comes in seconds). */
export function scoreFor(
  style: Style,
  bars: number | null | undefined,
  opts: ScoreOptions = {},
): Score {
  const trim = Math.pow(10, (opts.trimDb ?? 0) / 20);
  const n = style === 'crossfade' ? 0 : Math.max(0, bars ?? DEFAULT_BARS[style]);
  const phi = n * 4;
  const s = new Builder();
  let marker: Score['marker'] = null;
  let aStop = phi;
  // the incoming deck comes in at its own loudness against the outgoing one,
  // and is back to its own level by the end (the player carries on with it)
  const settleTrim = (from: number) => {
    if (trim !== 1) s.set('B.trim', 0, trim).set('B.trim', from, trim).to('B.trim', phi, 1);
  };
  switch (style) {
    case 'long_blend':
    case 'short_blend': {
      const mid = phi / 2;
      s.curve('B.xf', 0, mid, 0, 1, 'in');
      s.set('A.xf', 0, 1).curve('A.xf', mid, phi, 1, 0, 'out');
      // the bass swaps on the middle downbeat, over one beat
      s.set('B.low', 0, KILL_DB)
        .set('B.low', mid, KILL_DB)
        .to('B.low', mid + 1, 0);
      s.set('A.low', 0, 0)
        .set('A.low', mid, 0)
        .to('A.low', mid + 1, KILL_DB);
      settleTrim(mid);
      marker = { beat: mid, label: 'bass swap' };
      break;
    }
    case 'bass_swap': {
      const mid = phi / 2;
      s.curve('B.xf', 0, phi / 4, 0, 1, 'in');
      s.set('A.xf', 0, 1).curve('A.xf', (3 * phi) / 4, phi, 1, 0, 'out');
      // a quick swap on the one: a quarter of a beat
      s.set('B.low', 0, KILL_DB)
        .set('B.low', mid, KILL_DB)
        .to('B.low', mid + 0.25, 0);
      s.set('A.low', 0, 0)
        .set('A.low', mid, 0)
        .to('A.low', mid + 0.25, KILL_DB);
      settleTrim(mid);
      marker = { beat: mid, label: 'bass swap' };
      break;
    }
    case 'filter_sweep': {
      const mid = phi / 2;
      s.curve('B.xf', 0, phi / 4, 0, 1, 'in');
      s.line('B.hp', 0, mid, 900, HP_OPEN, 'exp');
      s.set('A.hp', 0, HP_OPEN).line('A.hp', mid, phi, HP_OPEN, 1500, 'exp');
      s.set('A.xf', 0, 1).curve('A.xf', (3 * phi) / 4, phi, 1, 0, 'out');
      settleTrim(mid);
      marker = { beat: mid, label: 'filters cross' };
      break;
    }
    case 'drop_swap': {
      // the incoming build-up under the outgoing breakdown; on the drop, the swap
      s.curve('B.xf', 0, phi / 2, 0, 1, 'in');
      s.set('B.low', 0, KILL_DB)
        .set('B.low', phi, KILL_DB)
        .to('B.low', phi + SNAP, 0);
      s.set('A.xf', 0, 1)
        .set('A.xf', phi, 1)
        .to('A.xf', phi + SNAP, 0);
      if (trim !== 1)
        s.set('B.trim', 0, trim)
          .set('B.trim', phi, trim)
          .to('B.trim', phi + 8, 1);
      aStop = phi + 2 * SNAP;
      marker = { beat: phi, label: 'drop' };
      break;
    }
    case 'cut': {
      s.set('A.xf', 0, 1).to('A.xf', SNAP, 0);
      s.set('B.xf', 0, 0).to('B.xf', SNAP, 1);
      aStop = 2 * SNAP;
      break;
    }
    case 'echo_out': {
      // the last beat goes into the echo, the dry signal is cut on the one,
      // and the echo rings on over the incoming track, thinning out
      const beat = opts.beatSeconds && opts.beatSeconds > 0 ? opts.beatSeconds : NEUTRAL.echoTime;
      s.set('A.echoTime', -1, Math.min(2, beat * 0.75));
      s.set('A.echoReturn', -1, 1)
        .set('A.echoReturn', phi / 2, 1)
        .to('A.echoReturn', phi, 0);
      s.line('A.echoSend', -1, -1 / 8, 0, 1)
        .to('A.echoSend', 0, 1)
        .to('A.echoSend', SNAP, 0);
      s.set('A.echoFeedback', -1, 0.6).to('A.echoFeedback', phi, 0.35);
      s.set('A.echoTone', 0, NEUTRAL.echoTone).to('A.echoTone', phi, 2500, 'exp');
      s.set('A.xf', 0, 1).to('A.xf', SNAP, 0);
      s.set('B.xf', 0, 0).to('B.xf', SNAP, 1);
      aStop = 2 * SNAP;
      break;
    }
    case 'crossfade': {
      const secs = opts.crossfadeSeconds && opts.crossfadeSeconds > 0 ? opts.crossfadeSeconds : 6;
      s.curve('B.xf', 0, secs, 0, 1, 'in');
      s.curve('A.xf', 0, secs, 1, 0, 'out');
      if (trim !== 1) s.set('B.trim', 0, trim).to('B.trim', secs, 1);
      return {
        style,
        beats: secs,
        beatmatch: false,
        lanes: s.lanes,
        bStart: 0,
        aStop: secs,
        marker: null,
      };
    }
  }
  return {
    style,
    beats: phi,
    beatmatch: needsBeatmatch(style),
    lanes: s.lanes,
    bStart: 0,
    aStop,
    marker,
  };
}

/** Where every control ends once the incoming track has taken over. */
export const FINISHED: Readonly<Partial<Record<ParamKey, number>>> = {
  'A.xf': 0,
  'A.echoSend': 0,
  'A.echoReturn': 0,
  'B.xf': 1,
  'B.volume': 1,
  'B.trim': 1,
  'B.low': 0,
  'B.mid': 0,
  'B.high': 0,
  'B.hp': HP_OPEN,
  'B.lp': LP_OPEN,
  'B.echoSend': 0,
};

/** Where every control ends when the mix goes back to the outgoing track. */
export const WENT_BACK: Readonly<Partial<Record<ParamKey, number>>> = {
  'A.xf': 1,
  'A.volume': 1,
  'A.low': 0,
  'A.mid': 0,
  'A.high': 0,
  'A.hp': HP_OPEN,
  'A.lp': LP_OPEN,
  'A.echoSend': 0,
  'A.echoReturn': 0,
  'B.xf': 0,
  'B.echoSend': 0,
};

export const STYLE_WORDS: Readonly<Record<Style, string>> = {
  long_blend: 'Long blend',
  short_blend: 'Short blend',
  bass_swap: 'Bass swap',
  cut: 'Cut',
  echo_out: 'Echo out',
  filter_sweep: 'Filter sweep',
  drop_swap: 'Drop swap',
  crossfade: 'Crossfade',
};
