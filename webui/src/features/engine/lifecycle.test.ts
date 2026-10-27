import { describe, expect, it } from 'vitest';

import { LifecycleWatch, looksLikePhone, type LifecycleEvent } from './lifecycle';

class FakeContext {
  state = 'running';
  currentTime = 0;
  private fns = new Set<() => void>();
  addEventListener(_t: 'statechange', fn: () => void) {
    this.fns.add(fn);
  }
  removeEventListener(_t: 'statechange', fn: () => void) {
    this.fns.delete(fn);
  }
  set(state: string) {
    this.state = state;
    for (const fn of this.fns) fn();
  }
}

class FakeDoc {
  visibilityState = 'visible';
  private fns = new Set<() => void>();
  addEventListener(_t: string, fn: () => void) {
    this.fns.add(fn);
  }
  removeEventListener(_t: string, fn: () => void) {
    this.fns.delete(fn);
  }
  set(v: string) {
    this.visibilityState = v;
    for (const fn of this.fns) fn();
  }
}

function watch(phone = false) {
  const context = new FakeContext();
  const doc = new FakeDoc();
  let wall = 0;
  const events: LifecycleEvent[] = [];
  const w = new LifecycleWatch({ context, doc, phone, now: () => wall, timers: false }, (e) =>
    events.push(e),
  );
  w.start();
  return {
    context,
    doc,
    events,
    w,
    advance: (ms: number, ctxMoves = true) => {
      wall += ms;
      if (ctxMoves) context.currentTime += ms / 1000;
      w.check();
    },
  };
}

describe('telling that Web Audio stopped (Design 252)', () => {
  it('hears the context suspended, interrupted (Safari) and closed, and back', () => {
    const { context, events, advance } = watch();
    context.set('suspended');
    advance(5000, false);
    context.set('running');
    context.set('interrupted');
    context.set('running');
    context.set('closed');
    expect(events.map((e) => `${e.kind}:${e.reason}`)).toEqual([
      'interrupted:suspended',
      'resumed:suspended',
      'interrupted:interrupted',
      'resumed:interrupted',
      'interrupted:closed',
    ]);
    expect(events[1].forMs).toBe(5000);
  });

  it('counts a hidden page on a phone only (a computer keeps playing a hidden tab)', () => {
    const desk = watch(false);
    desk.doc.set('hidden');
    expect(desk.events).toEqual([]);
    const phone = watch(true);
    phone.doc.set('hidden');
    phone.doc.set('visible');
    expect(phone.events.map((e) => `${e.kind}:${e.reason}`)).toEqual([
      'interrupted:hidden',
      'resumed:hidden',
    ]);
  });

  it('notices a clock that stopped while the state says running', () => {
    const { events, advance, w } = watch();
    advance(250);
    advance(250);
    expect(events).toEqual([]);
    advance(500, false);
    advance(500, false);
    expect(w.interrupted).toBe('stalled');
    advance(250);
    expect(w.interrupted).toBeNull();
    expect(events.map((e) => e.kind)).toEqual(['interrupted', 'resumed']);
  });

  it('stops listening', () => {
    const { context, events, w } = watch();
    w.stop();
    context.set('suspended');
    expect(events).toEqual([]);
  });

  it('knows a phone', () => {
    expect(
      looksLikePhone({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }),
    ).toBe(true);
    expect(looksLikePhone({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile' })).toBe(
      true,
    );
    expect(
      looksLikePhone({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        maxTouchPoints: 5,
      }),
    ).toBe(true);
    expect(
      looksLikePhone({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        maxTouchPoints: 0,
      }),
    ).toBe(false);
    expect(looksLikePhone(null)).toBe(false);
  });
});
