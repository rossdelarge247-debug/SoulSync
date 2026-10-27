/**
 * Fakes for the engine's tests: an AudioParam that keeps its timeline by the
 * spec's rules (as a browser does), and a deck port with a clock the test
 * moves. No Web Audio needed.
 */

import type { DeckPort } from './executor';

import { AutomatedParam, ParamTimeline, type ParamLike } from './automation';
import { positionAt, spliceKnots, type Knot } from './clock';
import { NEUTRAL, PARAM_NAMES, type DeckId, type ParamName } from './score';

/** An AudioParam as a browser keeps it (the spec's rules), with or without cancelAndHoldAtTime. */
export class FakeParam implements ParamLike {
  readonly browser: ParamTimeline;
  calls: string[] = [];
  cancelAndHoldAtTime?: (t: number) => void;

  constructor(value = 0, hasHold = true) {
    this.browser = new ParamTimeline(value);
    if (hasHold) {
      this.cancelAndHoldAtTime = (t: number) => {
        this.calls.push(`hold ${t}`);
        this.browser.holdAt(t);
      };
    }
  }

  get value(): number {
    return this.browser.defaultValue;
  }

  set value(_v: number) {
    /* the default is fixed at construction here */
  }

  setValueAtTime(v: number, t: number) {
    this.calls.push(`set ${v} ${t}`);
    this.browser.add('set', t, v);
  }

  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(`linear ${v} ${t}`);
    this.browser.add('linear', t, v);
  }

  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(`exp ${v} ${t}`);
    this.browser.add('exp', t, v);
  }

  cancelScheduledValues(t: number) {
    this.calls.push(`cancel ${t}`);
    this.browser.cancelFrom(t);
  }
}

/** The decks as the executor sees them, with the clock in the test's hands. */
export class FakePort implements DeckPort {
  readonly sampleRate: number;
  time = 0;
  readonly maps: Record<DeckId, Knot[]> = { A: [], B: [] };
  readonly stops: Record<DeckId, number> = { A: Infinity, B: Infinity };
  readonly modes: Record<DeckId, 'resample' | 'stretch'> = { A: 'resample', B: 'resample' };
  readonly jumps: { deck: DeckId; from: number }[] = [];
  readonly fakes: Record<DeckId, Record<ParamName, FakeParam>>;
  private readonly automated: Record<DeckId, Record<ParamName, AutomatedParam>>;

  constructor(sampleRate = 48000, hasHold = true) {
    this.sampleRate = sampleRate;
    const make = (deck: DeckId) => {
      const fakes = {} as Record<ParamName, FakeParam>;
      const params = {} as Record<ParamName, AutomatedParam>;
      for (const name of PARAM_NAMES) {
        const start = name === 'xf' && deck === 'B' ? 0 : NEUTRAL[name];
        fakes[name] = new FakeParam(start, hasHold);
        params[name] = new AutomatedParam(fakes[name], `${deck}.${name}`, start);
      }
      return { fakes, params };
    };
    const a = make('A');
    const b = make('B');
    this.fakes = { A: a.fakes, B: b.fakes };
    this.automated = { A: a.params, B: b.params };
  }

  now(): number {
    return this.time;
  }

  current(deck: DeckId): Knot[] {
    return this.maps[deck];
  }

  map(deck: DeckId, from: number, knots: Knot[], jump = false): void {
    this.maps[deck] = spliceKnots(this.maps[deck], from, knots);
    if (jump) this.jumps.push({ deck, from });
  }

  stop(deck: DeckId, atFrame: number): void {
    this.stops[deck] = atFrame;
  }

  mode(deck: DeckId, mode: 'resample' | 'stretch'): void {
    this.modes[deck] = mode;
  }

  params(deck: DeckId): Record<ParamName, AutomatedParam> {
    return this.automated[deck];
  }

  /** What the browser would play for a param at t. */
  value(deck: DeckId, name: ParamName, t: number): number {
    return this.fakes[deck][name].browser.valueAt(t);
  }

  position(deck: DeckId, t: number): number | null {
    return positionAt(this.maps[deck], t * this.sampleRate, this.sampleRate);
  }

  /** A deck's speed at t (track seconds a second). */
  rate(deck: DeckId, t: number): number {
    const a = this.position(deck, t - 0.0005);
    const b = this.position(deck, t + 0.0005);
    return a === null || b === null ? NaN : (b - a) / 0.001;
  }
}
