/**
 * DJ mode's mixer (Brief F, 37g, 37h), the part that is only logic: every
 * control as data (its range, its keys' steps, its value in words) and what
 * each sets on the engine (features/engine/graph.ts's params).
 *
 * The side columns are drawn from `DECK_CONTROLS`, a list, not markup: 3b
 * turns each into a vertical fader (37g's six boxes) and appends Tempo,
 * without touching the mapping.
 *
 * Nothing is automatic: a control moves only when a person moves it (or Back
 * brings the fader to A over a bar, 413).
 */
import type { DeckId, ParamKey } from '@/features/engine/score';

import { HP_OPEN, KILL_DB, LP_OPEN, NEUTRAL } from '@/features/engine/score';

export type Band = 'high' | 'mid' | 'low';
export const BANDS: readonly Band[] = ['high', 'mid', 'low'];

export interface DeckValues {
  /** 0–100, the fader */
  volume: number;
  /** dB, −26 … +6 */
  high: number;
  mid: number;
  low: number;
  /** −100 (low-pass all the way) … 0 (off) … +100 (high-pass all the way) */
  filter: number;
  /** the deck's speed against its own tempo, percent (438; within its range) */
  tempo: number;
  kill: Record<Band, boolean>;
}

export interface MixValues {
  A: DeckValues;
  B: DeckValues;
  /** 0 = A only … 100 = B only */
  xf: number;
  /** the echo's send on A (415: the track going out), 0–100 */
  echoSend: number;
  /** an index into ECHO_TIMES */
  echoTime: number;
  /** 0–90 % */
  echoFeedback: number;
}

export type DeckControlId = 'volume' | 'high' | 'mid' | 'low' | 'filter' | 'tempo';
export type CentreControlId = 'xf' | 'echoSend' | 'echoTime' | 'echoFeedback';

export interface ControlSpec<Id extends string = string> {
  id: Id;
  label: string;
  min: number;
  max: number;
  /** the arrow keys' step (the input's own `step`) */
  step: number;
  /** ⇧ + an arrow (the crossfader's 10%) */
  bigStep?: number;
  /** a band with its KILL toggle */
  kill?: Band;
  /** the value in words, mono, and the slider's aria-valuetext */
  words: (v: number, killed?: boolean) => string;
}

/* ── the words ──────────────────────────────────────────────────────── */

function minus(n: number): string {
  return n < 0 ? `−${Math.abs(n)}` : n > 0 ? `+${n}` : '0';
}

/** A fader's gain: the square of its travel (a fader's audio taper). */
export function volumeGain(v: number): number {
  const x = Math.max(0, Math.min(100, v)) / 100;
  return x * x;
}

export function volumeWords(v: number): string {
  const g = volumeGain(v);
  if (g <= 0) return 'off';
  const db = Math.round(20 * Math.log10(g));
  return db === 0 ? '0 dB' : `${minus(db)} dB`;
}

export function eqWords(v: number, killed = false): string {
  if (killed) return 'kill';
  const db = Math.round(v);
  return db === 0 ? '0' : `${minus(db)} dB`;
}

/** The filter's dead zone at the centre (it's off there). */
export const FILTER_OFF = 2;
const LP_FLOOR = 200;
const HP_CEILING = 5000;

/** The filter knob as the two filters' frequencies (Hz). */
export function filterHz(v: number): { hp: number; lp: number } {
  const x = Math.max(-100, Math.min(100, v));
  if (Math.abs(x) <= FILTER_OFF) return { hp: HP_OPEN, lp: LP_OPEN };
  const u = (Math.abs(x) - FILTER_OFF) / (100 - FILTER_OFF);
  if (x < 0) return { hp: HP_OPEN, lp: LP_OPEN * Math.pow(LP_FLOOR / LP_OPEN, u) };
  return { hp: HP_OPEN * Math.pow(HP_CEILING / HP_OPEN, u), lp: LP_OPEN };
}

function hz(f: number): string {
  if (f >= 1000) return `${(f / 1000).toFixed(f >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(f / 10) * 10);
}

/** "off", "HP 320", "LP 1.2k" (37h). */
export function filterWords(v: number): string {
  const { hp, lp } = filterHz(v);
  if (v < -FILTER_OFF) return `LP ${hz(lp)}`;
  if (v > FILTER_OFF) return `HP ${hz(hp)}`;
  return 'off';
}

/** The crossfader as the two decks' gains: constant power, so the middle isn't a dip. */
export function xfGains(x: number): { A: number; B: number } {
  const u = Math.max(0, Math.min(100, x)) / 100;
  const a = Math.cos((u * Math.PI) / 2);
  const b = Math.sin((u * Math.PI) / 2);
  return { A: a < 1e-6 ? 0 : a, B: b < 1e-6 ? 0 : b };
}

/** "A only", "B only", "B 62% · A 38%" (37g, 37h). */
export function xfWords(x: number): string {
  const v = Math.round(x);
  if (v <= 0) return 'A only';
  if (v >= 100) return 'B only';
  return `B ${v}% · A ${100 - v}%`;
}

/** The echo's time in beats of A (37g's "3/8"). */
export const ECHO_TIMES: readonly { label: string; beats: number }[] = [
  { label: '1/8', beats: 0.125 },
  { label: '1/4', beats: 0.25 },
  { label: '3/8', beats: 0.375 },
  { label: '1/2', beats: 0.5 },
  { label: '3/4', beats: 0.75 },
  { label: '1 beat', beats: 1 },
];
const MAX_ECHO_S = 2;

/** The delay (s) for an echo time at A's beat period (0.5 s without a grid: 120 BPM). */
export function echoSeconds(index: number, beatPeriod: number | null): number {
  const t = ECHO_TIMES[Math.max(0, Math.min(ECHO_TIMES.length - 1, Math.round(index)))]!;
  const period = beatPeriod && beatPeriod > 0 ? beatPeriod : 0.5;
  return Math.min(MAX_ECHO_S, t.beats * period);
}

export function pctWords(v: number, zero = '0%'): string {
  const n = Math.round(v);
  return n <= 0 ? zero : `${n}%`;
}

/** Tempo's ranges (438): ±8% by default. */
export const TEMPO_RANGES = [6, 8, 10, 16] as const;
export type TempoRange = (typeof TEMPO_RANGES)[number];
export const DEFAULT_TEMPO_RANGE: TempoRange = 8;

/** "0.0%", "+1.6%", "−3.2%" */
export function tempoWords(v: number): string {
  const r = Math.round(v * 10) / 10;
  if (r === 0) return '0.0%';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}%`;
}

/** A range's BPM span at a tempo (438's menu): ±8 at 124 → "114.1–133.9 BPM". */
export function tempoSpan(range: number, bpm: number | null): string | null {
  if (!bpm || !(bpm > 0)) return null;
  return `${(bpm * (1 - range / 100)).toFixed(1)}–${(bpm * (1 + range / 100)).toFixed(1)} BPM`;
}

/** The deck's speed from its tempo fader. */
export function tempoRate(tempo: number): number {
  return 1 + tempo / 100;
}

/* ── the controls ───────────────────────────────────────────────────── */

const EQ_MIN = -26;
const EQ_MAX = 6;

/** A deck's column, top to bottom (37g; 3b turns each into a vertical fader and adds Tempo). */
export const DECK_CONTROLS: readonly ControlSpec<DeckControlId>[] = [
  { id: 'volume', label: 'Volume', min: 0, max: 100, step: 1, bigStep: 10, words: volumeWords },
  {
    id: 'high',
    label: 'Hi',
    min: EQ_MIN,
    max: EQ_MAX,
    step: 1,
    bigStep: 6,
    kill: 'high',
    words: eqWords,
  },
  {
    id: 'mid',
    label: 'Mid',
    min: EQ_MIN,
    max: EQ_MAX,
    step: 1,
    bigStep: 6,
    kill: 'mid',
    words: eqWords,
  },
  {
    id: 'low',
    label: 'Low',
    min: EQ_MIN,
    max: EQ_MAX,
    step: 1,
    bigStep: 6,
    kill: 'low',
    words: eqWords,
  },
  { id: 'filter', label: 'Filter', min: -100, max: 100, step: 2, bigStep: 10, words: filterWords },
  // its range is the deck's (±6/8/10/16, the menu on its label); ↑↓ 0.1%, ⇧ 1%
  { id: 'tempo', label: 'Tempo', min: -8, max: 8, step: 0.1, bigStep: 1, words: tempoWords },
];

export const XF_CONTROL: ControlSpec<'xf'> = {
  id: 'xf',
  label: 'Crossfader',
  min: 0,
  max: 100,
  step: 2,
  bigStep: 10,
  words: xfWords,
};

/** The echo (415: Send A, Time, Feedback). */
export const ECHO_CONTROLS: readonly ControlSpec<'echoSend' | 'echoTime' | 'echoFeedback'>[] = [
  {
    id: 'echoSend',
    label: 'Echo · Send A',
    min: 0,
    max: 100,
    step: 1,
    bigStep: 10,
    words: (v) => pctWords(v, 'off'),
  },
  {
    id: 'echoTime',
    label: 'Time',
    min: 0,
    max: ECHO_TIMES.length - 1,
    step: 1,
    words: (v) => ECHO_TIMES[Math.max(0, Math.min(ECHO_TIMES.length - 1, Math.round(v)))]!.label,
  },
  {
    id: 'echoFeedback',
    label: 'Feedback',
    min: 0,
    max: 90,
    step: 1,
    bigStep: 10,
    words: (v) => pctWords(v),
  },
];

export function defaultDeck(): DeckValues {
  return {
    volume: 100,
    high: 0,
    mid: 0,
    low: 0,
    filter: 0,
    tempo: 0,
    kill: { high: false, mid: false, low: false },
  };
}

/** Every control at rest: the fader on A, the echo off (37g). */
export function defaultMix(): MixValues {
  return {
    A: defaultDeck(),
    B: defaultDeck(),
    xf: 0,
    echoSend: 0,
    echoTime: 2,
    echoFeedback: 35,
  };
}

export function clampTo(spec: ControlSpec, v: number): number {
  const stepped = Math.round((v - spec.min) / spec.step) * spec.step + spec.min;
  const out = Math.max(spec.min, Math.min(spec.max, stepped));
  // no 0.30000000000000004 from a 0.1 step
  return Math.round(out * 1e6) / 1e6;
}

/* ── the engine's params ────────────────────────────────────────────── */

/**
 * What every engine param should be for these values: the EQ in dB (a kill is
 * KILL_DB), the filters in Hz, the volume and the crossfader as gains, the
 * echo's send on A (B's stays shut), its time from A's beat and its feedback.
 */
export function engineTargets(
  v: MixValues,
  beatPeriod: number | null,
): Partial<Record<ParamKey, number>> {
  const out: Partial<Record<ParamKey, number>> = {};
  const xf = xfGains(v.xf);
  for (const deck of ['A', 'B'] as const satisfies readonly DeckId[]) {
    const d = v[deck];
    out[`${deck}.volume`] = volumeGain(d.volume);
    out[`${deck}.xf`] = xf[deck];
    for (const band of BANDS) out[`${deck}.${band}`] = d.kill[band] ? KILL_DB : d[band];
    const f = filterHz(d.filter);
    out[`${deck}.hp`] = f.hp;
    out[`${deck}.lp`] = f.lp;
    out[`${deck}.echoTime`] = echoSeconds(v.echoTime, beatPeriod);
    out[`${deck}.echoFeedback`] = v.echoFeedback / 100;
    out[`${deck}.echoReturn`] = NEUTRAL.echoReturn;
  }
  out['A.echoSend'] = v.echoSend / 100;
  out['B.echoSend'] = 0;
  return out;
}

/** "Deck A Low" as a control's accessible name. */
export function controlName(deck: DeckId | null, spec: ControlSpec): string {
  return deck ? `Deck ${deck} ${spec.label}` : spec.label;
}

/** The words a kill's change is announced with (one per change, 37p). */
export function killWords(deck: DeckId, band: Band, on: boolean): string {
  const name = { high: 'Hi', mid: 'Mid', low: 'Low' }[band];
  return `Deck ${deck} ${name} ${on ? 'killed' : 'back'}`;
}
