import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DragItem } from './dnd-model';

import {
  UNDO_TOAST_KEY,
  getDnd,
  keyboardKey,
  keyboardLift,
  pointerDown,
  registerTarget,
  resetDndForTests,
  undoLast,
  type DropTarget,
  type Lifted,
} from './dnd-engine';

const item = (id: string, more: Partial<DragItem> = {}): DragItem => ({
  id,
  title: `Track ${id}`,
  key: '8A',
  bpm: 124,
  queue: { id },
  ...more,
});

function box(el: HTMLElement, top: number, height = 50, left = 0, width = 400) {
  el.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      left,
      right: left + width,
      width,
      height,
      x: left,
      y: top,
    }) as DOMRect;
}

let pointAt: Element | null = null;
let toast: ReturnType<typeof vi.fn>;
let dismiss: ReturnType<typeof vi.fn>;

function setup() {
  document.body.innerHTML = `
    <ul id="source"><li id="src-row" data-dnd-row="x"><span id="grip"></span>Track 1</li></ul>
    <ol id="list"><li data-dnd-index="0" id="r0">A</li><li data-dnd-index="1" id="r1">B</li><li data-dnd-index="2" id="r2">C</li></ol>
    <div id="set">Warm-up</div>
    <div id="famous">Boiler Room 2019</div>
    <div id="outside"></div>`;
  box(document.getElementById('src-row')!, 0);
  box(document.getElementById('r0')!, 100);
  box(document.getElementById('r1')!, 150);
  box(document.getElementById('r2')!, 200);
  box(document.getElementById('list')!, 100, 150);
  box(document.getElementById('set')!, 300);
  box(document.getElementById('famous')!, 360);
}

function listTarget(
  over: Partial<DropTarget> = {},
): DropTarget & { drop: ReturnType<typeof vi.fn>; announce: ReturnType<typeof vi.fn> } {
  const list = document.getElementById('list')!;
  const t = {
    id: 'list',
    kind: 'set-list' as const,
    listId: 'set:1',
    name: 'Sunday Set',
    el: () => list,
    rows: () => Array.from(list.querySelectorAll<HTMLElement>('[data-dnd-index]')),
    lockables: () => [{}, {}, {}],
    accepts: () => ({ ok: true }),
    preview: (_d: unknown, gap: number) => ({ gap, line: `Smooth · at ${gap}` }),
    drop: vi.fn(async () => ({ words: 'Added Track 1 to Sunday Set · #2', undo: vi.fn() })),
    announce: vi.fn(),
    moveWords: (_d: unknown, _from: number, at: number) => `Track 1, ${at + 1} of 3.`,
    ...over,
  };
  return t as DropTarget & { drop: ReturnType<typeof vi.fn>; announce: ReturnType<typeof vi.fn> };
}

function lifted(items: DragItem[] = [item('1')]): () => Lifted {
  return () => ({
    items,
    source: { kind: 'tracks', listId: 'tracks', indexes: [0] },
    rows: [document.getElementById('src-row')!],
  });
}

function down(type = 'mouse', x = 5, y = 5) {
  pointerDown(
    {
      pointerId: 1,
      pointerType: type,
      button: 0,
      clientX: x,
      clientY: y,
      preventDefault: () => {},
    },
    document.getElementById('grip')!,
    lifted(),
  );
}

function move(x: number, y: number, at: Element | null) {
  pointAt = at;
  window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x, clientY: y }));
}

beforeEach(() => {
  setup();
  toast = vi.fn();
  dismiss = vi.fn(() => true);
  window.showToast = toast as unknown as typeof window.showToast;
  window.dismissToast = dismiss as unknown as typeof window.dismissToast;
  pointAt = null;
  document.elementFromPoint = (() => pointAt) as typeof document.elementFromPoint;
});
afterEach(() => {
  resetDndForTests();
  vi.useRealTimers();
});

describe('a mouse drag (32a, 32b)', () => {
  it('lifts once the grip has moved 4px: the source dims, the targets light', () => {
    const list = listTarget();
    registerTarget(list);
    registerTarget({
      id: 'famous',
      kind: 'set',
      listId: 'set:9',
      name: 'Boiler Room 2019',
      el: () => document.getElementById('famous'),
      accepts: () => ({
        ok: false,
        reason: "A famous mix can't be changed · Save a copy to edit it",
      }),
      drop: vi.fn(),
    });
    down();
    move(7, 6, null);
    expect(getDnd().drag).toBeNull();
    move(12, 12, null);
    expect(getDnd().drag?.items.map((t) => t.id)).toEqual(['1']);
    expect(document.getElementById('src-row')!.hasAttribute('data-dnd-lifted')).toBe(true);
    expect(document.getElementById('list')!.getAttribute('data-dnd-state')).toBe('lit');
    // an invalid target isn't lit; it goes amber when the ghost is over it
    expect(document.getElementById('famous')!.hasAttribute('data-dnd-state')).toBe(false);
    move(10, 370, document.getElementById('famous'));
    expect(document.getElementById('famous')!.getAttribute('data-dnd-state')).toBe('invalid');
    expect(getDnd().note?.words).toBe("A famous mix can't be changed · Save a copy to edit it");
  });

  it('opens the 36px gap with the line’s words over a list, and drops there', async () => {
    const list = listTarget();
    registerTarget(list);
    down();
    move(20, 20, null);
    move(20, 160, document.getElementById('r1'));
    // y 160 is above B's middle: the gap before B
    expect(getDnd().over?.gap).toBe(1);
    expect(getDnd().line?.words).toBe('Smooth · at 1');
    expect(document.getElementById('r1')!.getAttribute('data-dnd-gap')).toBe('before');
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    await vi.waitFor(() => expect(list.drop).toHaveBeenCalled());
    expect(list.drop.mock.calls[0][1]).toBe(1);
    expect(getDnd().drag).toBeNull();
    expect(
      document.querySelector('[data-dnd-gap], [data-dnd-state], [data-dnd-lifted]'),
    ).toBeNull();
    // one drop, one Undo, for 6 s (32c)
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    const [words, kind, , opts] = toast.mock.calls[0];
    expect(words).toBe('Added Track 1 to Sunday Set · #2');
    expect(kind).toBe('success');
    expect(opts).toMatchObject({ key: UNDO_TOAST_KEY, ms: 6000, action: { label: 'Undo' } });
  });

  it('⌘Z undoes the last drop once, and takes its toast down', async () => {
    const undo = vi.fn();
    const list = listTarget({ drop: vi.fn(async () => ({ words: 'Moved', undo })) });
    registerTarget(list);
    down();
    move(20, 20, null);
    move(20, 210, document.getElementById('r2'));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    expect(undoLast()).toBe(true);
    await vi.waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
    expect(dismiss).toHaveBeenCalledWith(UNDO_TOAST_KEY);
    expect(undoLast()).toBe(false);
    // the toast's own Undo is the same one, used up
    toast.mock.calls[0][3].action.run();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('cancels when let go outside every target, and says so', () => {
    const list = listTarget();
    registerTarget(list);
    down();
    move(20, 20, null);
    move(20, 500, document.getElementById('outside'));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    expect(list.drop).not.toHaveBeenCalled();
    expect(getDnd().drag).toBeNull();
    expect(document.getElementById('toast-live')?.textContent).toBe(
      "Cancelled. Track 1 wasn't moved.",
    );
  });

  it('Escape puts it back', () => {
    registerTarget(listTarget());
    down();
    move(20, 20, null);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(getDnd().drag).toBeNull();
  });

  it('swallows the click the release makes, so a drop isn’t also a Play', async () => {
    const list = listTarget();
    registerTarget(list);
    const clicked = vi.fn();
    document.getElementById('r1')!.addEventListener('click', clicked);
    down();
    move(20, 20, null);
    move(20, 160, document.getElementById('r1'));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    document.getElementById('r1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clicked).not.toHaveBeenCalled();
  });

  it('doesn’t lift a missing file: the row says why (32b state 5)', () => {
    registerTarget(listTarget());
    pointerDown(
      { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 5, clientY: 5 },
      document.getElementById('grip')!,
      lifted([item('1', { fileMissing: true })]),
    );
    move(30, 30, null);
    expect(getDnd().drag).toBeNull();
    expect(getDnd().refused?.words).toBe("Can't be lifted: its file is missing");
    expect(getDnd().refused?.action?.label).toBe('Find it again');
  });
});

describe('a phone’s long-press (32e)', () => {
  it('lifts after 450ms held still', () => {
    vi.useFakeTimers();
    registerTarget(listTarget());
    down('touch');
    vi.advanceTimersByTime(300);
    expect(getDnd().drag).toBeNull();
    vi.advanceTimersByTime(200);
    expect(getDnd().drag?.via).toBe('touch');
  });
  it('is a scroll when the finger moves first', () => {
    vi.useFakeTimers();
    registerTarget(listTarget());
    down('touch');
    move(5, 30, null);
    vi.advanceTimersByTime(600);
    expect(getDnd().drag).toBeNull();
  });
});

describe('the keyboard (32d)', () => {
  it('picks a row up, moves it with words, and drops it with Enter', async () => {
    const list = listTarget();
    registerTarget(list);
    const row = document.getElementById('r0')!;
    expect(
      keyboardLift('list', 0, {
        items: [item('1')],
        source: { kind: 'set', listId: 'set:1', indexes: [0] },
        rows: [row],
      }),
    ).toBe(true);
    expect(row.getAttribute('data-dnd-lifted')).toBe('keyboard');
    expect(list.announce).toHaveBeenLastCalledWith(
      'Picked up Track 1, 1 of 3. Arrows move it; Enter drops; Escape cancels.',
    );
    keyboardKey('down');
    expect(list.announce).toHaveBeenLastCalledWith('Track 1, 2 of 3.');
    expect(getDnd().kbd?.at).toBe(1);
    // the line previews the new place (after B: gap 2)
    expect(getDnd().over?.gap).toBe(2);
    keyboardKey('end');
    expect(getDnd().kbd?.at).toBe(2);
    keyboardKey('drop');
    await vi.waitFor(() => expect(list.drop).toHaveBeenCalled());
    expect(list.drop.mock.calls[0][1]).toBe(3);
    expect(row.hasAttribute('data-dnd-lifted')).toBe(false);
  });

  it('Escape cancels and says where it is', () => {
    const list = listTarget();
    registerTarget(list);
    keyboardLift('list', 1, {
      items: [item('1')],
      source: { kind: 'set', listId: 'set:1', indexes: [1] },
      rows: [document.getElementById('r1')!],
    });
    keyboardKey('down');
    keyboardKey('cancel');
    expect(list.drop).not.toHaveBeenCalled();
    expect(list.announce).toHaveBeenLastCalledWith('Cancelled. Track 1 is back at 2 of 3.');
  });

  it('dropping where it started changes nothing and says so', () => {
    const list = listTarget();
    registerTarget(list);
    keyboardLift('list', 1, {
      items: [item('1')],
      source: { kind: 'set', listId: 'set:1', indexes: [1] },
      rows: [document.getElementById('r1')!],
    });
    keyboardKey('drop');
    expect(list.drop).not.toHaveBeenCalled();
    expect(list.announce).toHaveBeenLastCalledWith('Track 1 stays at 2.');
  });
});

describe("Brief B's review: a keyboard pick-up left behind (M2) and a refused place (M3)", () => {
  const liftR1 = () =>
    keyboardLift('list', 1, {
      items: [item('1')],
      source: { kind: 'set', listId: 'set:1', indexes: [1] },
      rows: [document.getElementById('r1')!],
    });

  it('Escape anywhere else cancels it, with its words', () => {
    const list = listTarget();
    registerTarget(list);
    liftR1();
    document
      .getElementById('outside')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(getDnd().drag).toBeNull();
    expect(list.announce).toHaveBeenLastCalledWith('Cancelled. Track 1 is back at 2 of 3.');
  });

  it('the focus leaving its list cancels it', () => {
    vi.useFakeTimers();
    try {
      const list = listTarget();
      registerTarget(list);
      const r1 = document.getElementById('r1')!;
      r1.tabIndex = 0;
      r1.focus();
      liftR1();
      // to another row of the same list: still lifted
      const r2 = document.getElementById('r2')!;
      r2.tabIndex = 0;
      r2.focus();
      vi.advanceTimersByTime(5);
      expect(getDnd().drag).not.toBeNull();
      // out of it: put back
      const out = document.getElementById('outside')!;
      out.tabIndex = 0;
      out.focus();
      vi.advanceTimersByTime(5);
      expect(getDnd().drag).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('its list going (a route change) cancels it', () => {
    const off = registerTarget(listTarget());
    liftR1();
    off();
    expect(getDnd().drag).toBeNull();
  });

  it('a mouse drag isn’t refused by a stale pick-up: the pointer wins', () => {
    registerTarget(listTarget());
    liftR1();
    down();
    move(50, 50, null);
    expect(getDnd().kbd).toBeNull();
    expect(getDnd().drag?.source.kind).toBe('tracks');
  });

  it('a place the target refuses is said, drawn amber and not dropped on', async () => {
    const list = listTarget({
      preview: (_d: unknown, gap: number) =>
        gap === 0
          ? { gap, line: null, invalid: "Can't replace the incoming track · drop after it" }
          : { gap, line: `Smooth · at ${gap}` },
    });
    registerTarget(list);
    liftR1();
    keyboardKey('up');
    expect(getDnd().over?.verdict.ok).toBe(false);
    expect(getDnd().line).toBeNull();
    expect(getDnd().note?.words).toBe("Can't replace the incoming track · drop after it");
    expect(list.announce).toHaveBeenLastCalledWith(
      "Track 1, 1. Can't replace the incoming track · drop after it.",
    );
    keyboardKey('drop');
    expect(list.drop).not.toHaveBeenCalled();
    expect(getDnd().kbd).not.toBeNull();
    // the arrows find a place it takes, and that one drops
    keyboardKey('down');
    keyboardKey('down');
    keyboardKey('drop');
    await vi.waitFor(() => expect(list.drop).toHaveBeenCalled());
  });
});
