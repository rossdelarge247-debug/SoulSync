/**
 * Scheduled AudioParam changes the engine can stop where they are (Design's
 * 250, 26j: "touching it takes over: the automation stops where it is,
 * nothing jumps").
 *
 * Every change the executor schedules goes through an AutomatedParam, which
 * keeps its own copy of the timeline (ParamTimeline: setValueAtTime,
 * linearRampToValueAtTime and exponentialRampToValueAtTime, evaluated as the
 * Web Audio spec says). So the engine always knows a param's value at any
 * time, and can hold it:
 *
 * - where the browser has `cancelAndHoldAtTime` (Chrome, Edge, Safari), that;
 * - elsewhere (Firefox), `cancelScheduledValues(t)` and then the cut ramp
 *   rescheduled to end at t on the value it would have had: a ramp from the
 *   event before to (t, v(t)) lies on the old ramp, so nothing moves before
 *   t; then the value stays. A plain `cancelScheduledValues` would drop the
 *   ramp in progress and jump back to where it started.
 *
 * Holds take effect a little ahead of now (the render thread may already be
 * working on the next quantum), at `now + LOOKAHEAD`.
 */

export type RampKind = 'set' | 'linear' | 'exp';

export interface AutoEvent {
  kind: RampKind;
  time: number;
  value: number;
}

/** How far ahead of the context's time a change is made (seconds). */
export const LOOKAHEAD = 0.03;
/** An exponential ramp's values can't reach or cross zero: they're kept above this. */
export const EXP_FLOOR = 1e-4;

export class ParamTimeline {
  readonly events: AutoEvent[] = [];

  constructor(readonly defaultValue: number) {}

  add(kind: RampKind, time: number, value: number): void {
    if (!Number.isFinite(time) || !Number.isFinite(value)) throw new Error('not a finite event');
    if (kind === 'exp') value = Math.max(EXP_FLOOR, value);
    // events at the same time keep the order they came in (the spec's rule)
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > time) i--;
    this.events.splice(i, 0, { kind, time, value });
  }

  /** Remove every event at or after `time` (cancelScheduledValues). */
  cancelFrom(time: number): void {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time >= time) i--;
    this.events.length = i;
  }

  /** The value at time t, as the spec computes it. */
  valueAt(t: number): number {
    const ev = this.events;
    if (ev.length === 0 || t < ev[0].time) {
      // before the first event a ramp starts from the default
      if (ev.length && ev[0].kind !== 'set' && t >= 0) {
        return rampValue(ev[0].kind, 0, this.defaultValue, ev[0].time, ev[0].value, t);
      }
      return this.defaultValue;
    }
    let i = 0;
    while (i + 1 < ev.length && ev[i + 1].time <= t) i++;
    const cur = ev[i];
    const next = ev[i + 1];
    if (next && next.kind !== 'set') {
      return rampValue(next.kind, cur.time, cur.value, next.time, next.value, t);
    }
    return cur.value;
  }

  /**
   * cancelAndHoldAtTime(t), on the model: the value at t is kept from t on;
   * a ramp that was running at t now ends at t on that value.
   * Returns the held value and the kind of event that now ends at t.
   */
  holdAt(t: number): { value: number; kind: RampKind } {
    const value = this.valueAt(t);
    const ev = this.events;
    let i = 0;
    while (i < ev.length && ev[i].time <= t) i++;
    const cut = ev[i];
    const running = cut && cut.kind !== 'set' && i > 0 ? cut.kind : null;
    this.cancelFrom(t);
    // a ramp in progress: the same ramp ending at t (on its own curve);
    // otherwise a plain set
    const kind: RampKind = running ?? 'set';
    this.add(kind, t, value);
    return { value, kind };
  }

  /** The last time anything is scheduled (or -Infinity). */
  get lastTime(): number {
    return this.events.length ? this.events[this.events.length - 1].time : -Infinity;
  }
}

function rampValue(
  kind: RampKind,
  t0: number,
  v0: number,
  t1: number,
  v1: number,
  t: number,
): number {
  if (t1 <= t0) return v1;
  const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  if (kind === 'exp') {
    const a = Math.max(EXP_FLOOR, v0);
    const b = Math.max(EXP_FLOOR, v1);
    return a * Math.pow(b / a, u);
  }
  return v0 + (v1 - v0) * u;
}

/** The part of AudioParam the engine uses (a fake in tests). */
export interface ParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
  cancelScheduledValues(time: number): unknown;
  cancelAndHoldAtTime?: (time: number) => unknown;
}

export interface HoldOptions {
  /** Use cancelAndHoldAtTime where the param has it (default true). */
  native?: boolean;
}

/** One AudioParam with the engine's copy of its timeline. */
export class AutomatedParam {
  readonly timeline: ParamTimeline;

  constructor(
    readonly param: ParamLike,
    readonly name: string,
    defaultValue: number,
  ) {
    this.timeline = new ParamTimeline(defaultValue);
    try {
      param.value = defaultValue;
    } catch {
      /* a param under automation may refuse a plain value: the timeline still holds */
    }
  }

  set(time: number, value: number): void {
    this.timeline.add('set', time, value);
    this.param.setValueAtTime(value, time);
  }

  linear(time: number, value: number): void {
    this.timeline.add('linear', time, value);
    this.param.linearRampToValueAtTime(value, time);
  }

  exp(time: number, value: number): void {
    const v = Math.max(EXP_FLOOR, value);
    this.timeline.add('exp', time, v);
    this.param.exponentialRampToValueAtTime(v, time);
  }

  ramp(kind: RampKind, time: number, value: number): void {
    if (kind === 'set') this.set(time, value);
    else if (kind === 'exp') this.exp(time, value);
    else this.linear(time, value);
  }

  valueAt(t: number): number {
    return this.timeline.valueAt(t);
  }

  /** Stop every change from `time` on where it is: nothing jumps. Returns the value held. */
  hold(time: number, opts: HoldOptions = {}): number {
    const { value, kind } = this.timeline.holdAt(time);
    const native = opts.native !== false && typeof this.param.cancelAndHoldAtTime === 'function';
    if (native) {
      this.param.cancelAndHoldAtTime!(time);
    } else {
      this.param.cancelScheduledValues(time);
      if (kind === 'exp') this.param.exponentialRampToValueAtTime(Math.max(EXP_FLOOR, value), time);
      else if (kind === 'linear') this.param.linearRampToValueAtTime(value, time);
      else this.param.setValueAtTime(value, time);
    }
    return value;
  }

  /** Drop everything from `time` on and go straight to `value` there. */
  reset(time: number, value: number): void {
    this.timeline.cancelFrom(time);
    this.param.cancelScheduledValues(time);
    this.set(time, value);
  }
}
