/**
 * Brief B's one drag model (32a–32g) for every list of tracks, on pointer
 * events rather than HTML5 drag and drop: one code path for the mouse, the
 * pen and touch (a long-press lifts on a phone, 32e, which HTML5's drag
 * doesn't do on iOS or Android), a ghost that is ours to draw (48px, tilted,
 * title · key · BPM), hit-testing that sees every target the same way (React
 * lists, the sidebar, the legacy Up next in static/media-player.js), and
 * auto-scroll at a constant 8 rows a second.
 *
 * Surfaces register **targets** (`registerTarget`, `useDropTarget`): an
 * element marked `data-dnd-target`, whether it takes what's lifted (and why
 * not: 32b's amber reasons), for a list the gap under the pointer and what
 * the insertion line says there, and the drop itself, which returns the
 * toast's words and its Undo. **Sources** start a drag from a grip's
 * pointerdown (`pointerDown`) or, on the keyboard, Space on a focused row
 * (`keyboardLift`, row-grid.ts). The host (dnd-host.tsx) draws the ghost,
 * the line, the amber notes, the phone's Send to… tray and the sidebar's
 * Your sets while something is lifted.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';

import {
  LONG_PRESS_MS,
  MOUSE_SLOP,
  SLOP,
  UNDO_MS,
  autoScrollSpeed,
  cancelledWords,
  gapAt,
  keyboardTarget,
  liftRefusal,
  pickedUpWords,
  type DragItem,
  type DragSource,
  type Lockable,
  type TargetKind,
} from './dnd-model';

/**
 * DJ now (Brief E) is step 5: it joins as a target (kind `dj`, "drop to
 * cue") when it lands. Until then it isn't drawn at all, rather than shown
 * disabled; the phone's tray says "DJ now · laptop only" (32e).
 */
export const DJ_TARGET_READY = false;

export interface Verdict {
  ok: boolean;
  /** why not, said in amber on the target itself (32b) */
  reason?: string;
  action?: { label: string; run: () => void } | null;
}

export interface Preview {
  /** where it lands (the gap, after locked rows are stepped over) */
  gap: number;
  /** the insertion line's words (the new steps, 327) */
  line: string | null;
  /** a duplicate (32b state 6): the line's words are a note, still a valid drop */
  duplicate?: boolean;
  /** the locked row the pointer was pushed past, and its words (275) */
  locked?: { index: number; words: string } | null;
  /** this place is closed (mid-mix, the incoming track) */
  invalid?: string | null;
}

export interface DropResult {
  /** the toast's words */
  words: string;
  /** one drop, one undo (32c), or null when there's nothing to take back */
  undo: (() => void | Promise<void>) | null;
  /** after a keyboard drop: focus the row where it landed */
  focus?: (() => void) | null;
}

export type DragVia = 'mouse' | 'touch' | 'keyboard' | 'menu';

export interface Drag {
  items: DragItem[];
  source: DragSource;
  via: DragVia;
}

export interface DropTarget {
  id: string;
  kind: TargetKind | 'other';
  /** the list it is: a drop from the same list is a move (32g) */
  listId: string;
  /** "Sunday Set", "Up next" */
  name: string;
  el(): HTMLElement | null;
  accepts(drag: Drag): Verdict;
  /** a list: its row elements, each with `data-dnd-index` (the model's index) */
  rows?(): HTMLElement[];
  /** the model's rows, for the keyboard's steps over locked rows */
  lockables?(): Lockable[];
  preview?(drag: Drag, gap: number): Preview;
  /** a target without rows: what a drop does ("drop to add · goes last") */
  hint?(drag: Drag): string | null;
  drop(drag: Drag, gap: number | null): Promise<DropResult | null>;
  /** the list's own polite region (UX-27), for the keyboard's moves */
  announce?(words: string): void;
  /** the keyboard's move words (32d) for the row at `from` placed at `at` */
  moveWords?(drag: Drag, from: number, at: number): string;
  /** what scrolls (defaults to the nearest scrolling ancestor) */
  scroller?(): HTMLElement | null;
}

export interface Over {
  id: string;
  gap: number | null;
  verdict: Verdict;
  preview: Preview | null;
  hint: string | null;
}

export interface LineBox {
  top: number;
  left: number;
  width: number;
  words: string | null;
  duplicate: boolean;
}

export interface NoteBox {
  top: number;
  left: number;
  width: number;
  words: string;
  action?: { label: string; run: () => void } | null;
}

export interface DndState {
  drag: Drag | null;
  x: number;
  y: number;
  /** where the row was grabbed, so the ghost keeps the offset (32b) */
  grabX: number;
  grabY: number;
  over: Over | null;
  line: LineBox | null;
  /** an amber note: an invalid target's reason, or a locked row's words */
  note: NoteBox | null;
  /** the edge being auto-scrolled, for the gradient cue */
  scroll: { edge: 'up' | 'down'; top: number; left: number; width: number; height: number } | null;
  /** a source that wouldn't lift: its reason, on the row (32b state 5) */
  refused: NoteBox | null;
  /** the keyboard's pick-up (32d) */
  kbd: { targetId: string; from: number; at: number } | null;
}

const EMPTY: DndState = {
  drag: null,
  x: 0,
  y: 0,
  grabX: 0,
  grabY: 0,
  over: null,
  line: null,
  note: null,
  scroll: null,
  refused: null,
  kbd: null,
};

let state: DndState = EMPTY;
const listeners = new Set<() => void>();
const targets = new Map<string, DropTarget>();
const targetListeners = new Set<() => void>();
let targetsVersion = 0;

function set(patch: Partial<DndState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getDnd(): DndState {
  return state;
}

export function subscribeDnd(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDnd(): DndState {
  return useSyncExternalStore(subscribeDnd, getDnd, getDnd);
}

/**
 * One part of the drag's state (L7): a surface re-renders when that part
 * changes, not on every pointer move (`x` and `y` change each frame; `over`
 * and `drag` only when the target or the lift does).
 */
export function useDndSelect<T>(select: (s: DndState) => T): T {
  const get = () => select(state);
  return useSyncExternalStore(subscribeDnd, get, get);
}

/** Is something lifted (a pointer's or the keyboard's)? */
export function useDragging(): Drag | null {
  return useDndSelect((s) => s.drag);
}

/* ── targets ───────────────────────────────────────────────────────────── */

export function registerTarget(target: DropTarget): () => void {
  targets.set(target.id, target);
  targetsVersion += 1;
  targetListeners.forEach((l) => l());
  // a target that appears mid-drag (the sidebar's sets) lights at once
  if (state.drag) light();
  return () => {
    if (targets.get(target.id) === target) {
      // its list went (a route change, the page closed): a keyboard pick-up in it ends (M2)
      if (state.kbd?.targetId === target.id) cancel(true);
      targets.delete(target.id);
      targetsVersion += 1;
      targetListeners.forEach((l) => l());
    }
  };
}

export function getTarget(id: string): DropTarget | undefined {
  return targets.get(id);
}

export function listTargets(): DropTarget[] {
  return [...targets.values()];
}

export function useTargetsVersion(): number {
  return useSyncExternalStore(
    (l) => {
      targetListeners.add(l);
      return () => targetListeners.delete(l);
    },
    () => targetsVersion,
    () => targetsVersion,
  );
}

/**
 * A React surface's target. `make` is read fresh on every call (a ref), so
 * the target always sees the surface's latest rows without registering
 * again; it registers once per id.
 */
export function useDropTarget(id: string | null, make: () => DropTarget): void {
  const latest = useRef(make);
  latest.current = make;
  useEffect(() => {
    if (!id) return;
    const live: DropTarget = {
      get id() {
        return id;
      },
      get kind() {
        return latest.current().kind;
      },
      get listId() {
        return latest.current().listId;
      },
      get name() {
        return latest.current().name;
      },
      el: () => latest.current().el(),
      accepts: (d) => latest.current().accepts(d),
      rows: () => latest.current().rows?.() ?? [],
      lockables: () => latest.current().lockables?.() ?? [],
      preview: (d, g) => latest.current().preview?.(d, g) ?? { gap: g, line: null },
      hint: (d) => latest.current().hint?.(d) ?? null,
      drop: (d, g) => latest.current().drop(d, g),
      announce: (w) => latest.current().announce?.(w),
      moveWords: (d, f, a) => latest.current().moveWords?.(d, f, a) ?? '',
      scroller: () => latest.current().scroller?.() ?? null,
    };
    // a list target without rows() behaves as a single drop zone
    if (!make().rows) {
      delete (live as Partial<DropTarget>).rows;
      delete (live as Partial<DropTarget>).preview;
    }
    return registerTarget(live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}

/* ── speaking ──────────────────────────────────────────────────────────── */

/**
 * Say something politely. The list's own region when it has one; otherwise
 * the toast's polite region (`#toast-live`, static/downloads.js), the one
 * the Undo notices already use.
 */
export function liveSay(words: string, target?: DropTarget | null): void {
  if (target?.announce) {
    target.announce(words);
    return;
  }
  if (typeof document === 'undefined') return;
  let live = document.getElementById('toast-live');
  if (!live) {
    live = document.createElement('div');
    live.id = 'toast-live';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.className = 'sr-only';
    live.style.cssText =
      'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
    document.body.appendChild(live);
  }
  // the same words twice are still said twice
  live.textContent = live.textContent === words ? `${words}\u00a0` : words;
}

/* ── lighting the targets ─────────────────────────────────────────────── */

const verdicts = new Map<string, Verdict>();

function verdictFor(t: DropTarget, drag: Drag): Verdict {
  const kept = verdicts.get(t.id);
  if (kept) return kept;
  let v: Verdict;
  try {
    v = t.accepts(drag);
  } catch {
    v = { ok: false };
  }
  verdicts.set(t.id, v);
  return v;
}

function light(): void {
  const drag = state.drag;
  if (!drag) return;
  for (const t of targets.values()) {
    const el = t.el();
    if (!el) continue;
    el.setAttribute('data-dnd-target', t.id);
    const v = verdictFor(t, drag);
    const overThis = state.over?.id === t.id;
    const stateWord = overThis ? (state.over?.verdict.ok ? 'over' : 'invalid') : v.ok ? 'lit' : '';
    if (stateWord) el.setAttribute('data-dnd-state', stateWord);
    else el.removeAttribute('data-dnd-state');
  }
}

function unlight(): void {
  if (typeof document === 'undefined') return;
  document
    .querySelectorAll('[data-dnd-state]')
    .forEach((el) => el.removeAttribute('data-dnd-state'));
  document.querySelectorAll('[data-dnd-gap]').forEach((el) => el.removeAttribute('data-dnd-gap'));
  document
    .querySelectorAll('[data-dnd-lifted]')
    .forEach((el) => el.removeAttribute('data-dnd-lifted'));
  document
    .querySelectorAll('[data-dnd-locked-note]')
    .forEach((el) => el.removeAttribute('data-dnd-locked-note'));
}

/* ── geometry ──────────────────────────────────────────────────────────── */

function visibleRows(t: DropTarget): HTMLElement[] {
  return (t.rows?.() ?? []).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.height > 0 && el.getAttribute('data-dnd-index') !== null;
  });
}

/** The model gap under `y`: before the row it's over, or after the last. */
export function modelGap(t: DropTarget, y: number): number {
  const rows = visibleRows(t);
  if (!rows.length) return 0;
  const rects = rows.map((el) => el.getBoundingClientRect());
  // the rows' own boxes, without the 36px the line opened
  const k = gapAt(rects, y);
  if (k < rows.length) return Number(rows[k].getAttribute('data-dnd-index'));
  const last = Number(rows[rows.length - 1].getAttribute('data-dnd-index'));
  return last + 1;
}

function clearGap(): void {
  document.querySelectorAll('[data-dnd-gap]').forEach((el) => el.removeAttribute('data-dnd-gap'));
  document
    .querySelectorAll('[data-dnd-locked-note]')
    .forEach((el) => el.removeAttribute('data-dnd-locked-note'));
}

/** Open the 36px gap at `gap` (32a) and say where the line is. */
function openGap(t: DropTarget, preview: Preview | null): LineBox | null {
  clearGap();
  // nothing would change (a row dropped on its own place): no line
  if (!preview || (preview.line === null && !preview.duplicate)) return null;
  const rows = visibleRows(t);
  if (preview.locked) {
    const row = rows.find(
      (el) => Number(el.getAttribute('data-dnd-index')) === preview.locked!.index,
    );
    row?.setAttribute('data-dnd-locked-note', '');
  }
  const before = rows.find((el) => Number(el.getAttribute('data-dnd-index')) >= preview.gap);
  const row = before ?? rows[rows.length - 1];
  row?.setAttribute('data-dnd-gap', before ? 'before' : 'after');
  return measureLine(t, preview);
}

/** Where the open gap's line is now (the list may have scrolled under it). */
function measureLine(t: DropTarget, preview: Preview): LineBox | null {
  const words = preview.line;
  const duplicate = Boolean(preview.duplicate);
  const row = (t.el() ?? document).querySelector<HTMLElement>('[data-dnd-gap]');
  if (!row) {
    const box = t.el()?.getBoundingClientRect();
    return box ? { top: box.top + 8, left: box.left, width: box.width, words, duplicate } : null;
  }
  const r = row.getBoundingClientRect();
  // the line sits in the middle of the 36px the row's margin opened
  const top = row.getAttribute('data-dnd-gap') === 'before' ? r.top - 18 : r.bottom + 18;
  return { top, left: r.left, width: r.width, words, duplicate };
}

function scrollerOf(t: DropTarget | null, el: Element | null): HTMLElement | null {
  const own = t?.scroller?.();
  if (own) return own;
  let node: HTMLElement | null = (el as HTMLElement | null) ?? null;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1)
      return node;
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

/* ── the pointer ───────────────────────────────────────────────────────── */

export interface Lifted {
  items: DragItem[];
  source: DragSource;
  /** the source rows, dimmed to 40% while lifted (32b state 2) */
  rows?: HTMLElement[];
}

let pending: {
  pointerId: number;
  x: number;
  y: number;
  timer: number | null;
  el: HTMLElement;
  lift: () => Lifted | null;
  touch: boolean;
} | null = null;
let raf = 0;
let lastFrame = 0;
let scrollCarry = 0;
let captured: { el: HTMLElement; id: number } | null = null;

function onTouchMove(e: TouchEvent): void {
  // once a row is lifted on a phone, the finger drags it, not the page
  if (state.drag) e.preventDefault();
}

function clearPending(): void {
  if (pending?.timer) window.clearTimeout(pending.timer);
  pending = null;
  if (!state.drag) document.removeEventListener('touchmove', onTouchMove);
  window.removeEventListener('pointermove', onPendingMove);
  window.removeEventListener('pointerup', clearPending);
  window.removeEventListener('pointercancel', clearPending);
}

function onPendingMove(e: PointerEvent): void {
  if (!pending || e.pointerId !== pending.pointerId) return;
  const d = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
  if (pending.touch) {
    // moved before the long-press: a scroll, not a lift
    if (d > SLOP) clearPending();
    return;
  }
  if (d > MOUSE_SLOP) {
    const p = pending;
    clearPending();
    begin(
      p.el,
      p.lift,
      e.clientX,
      e.clientY,
      e.pointerType === 'touch' ? 'touch' : 'mouse',
      e.pointerId,
    );
  }
}

/**
 * A grip's pointerdown (or, on a phone, a row's): a mouse lifts once it has
 * moved 4px with the button held; touch lifts after a 450ms long-press that
 * hasn't moved (32e). `lift` is asked then, so it reads the selection as it
 * is.
 */
export function pointerDown(
  e: {
    pointerId: number;
    pointerType: string;
    button: number;
    clientX: number;
    clientY: number;
    preventDefault?: () => void;
  },
  el: HTMLElement,
  lift: () => Lifted | null,
  /** a grip: a finger drags from it at once, as a mouse does; a row: a long-press */
  from: 'grip' | 'row' = 'row',
): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  // a keyboard pick-up left behind gives way to the pointer (M2)
  if (state.kbd) cancel(true);
  if (state.drag) return;
  clearPending();
  const touch = e.pointerType === 'touch' && from === 'row';
  pending = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, timer: null, el, lift, touch };
  if (touch) {
    // L9: a non-passive touchmove from the touch's start, so once the
    // long-press lifts the row the browser can't already have committed the
    // finger to a scroll (it fires pointercancel then). Before the lift it
    // lets every move through: moving first is a scroll. (Real devices to check.)
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    pending.timer = window.setTimeout(() => {
      const p = pending;
      clearPending();
      if (p) begin(p.el, p.lift, p.x, p.y, 'touch', p.pointerId);
    }, LONG_PRESS_MS);
  } else {
    // the grip, not the text under it
    e.preventDefault?.();
  }
  window.addEventListener('pointermove', onPendingMove);
  window.addEventListener('pointerup', clearPending);
  window.addEventListener('pointercancel', clearPending);
}

function showRefusal(el: HTMLElement, reason: string, action?: 'find' | 'download'): void {
  const r = el.getBoundingClientRect();
  const note: NoteBox = {
    top: r.bottom + 4,
    left: r.left,
    width: Math.max(240, Math.min(r.width, 420)),
    words: reason,
    action:
      action === 'find'
        ? {
            label: 'Find it again',
            run: () => window.dispatchEvent(new CustomEvent('ss:dnd-find-again')),
          }
        : null,
  };
  set({ refused: note });
  liveSay(reason);
  window.setTimeout(() => {
    if (state.refused === note) set({ refused: null });
  }, 4000);
}

function begin(
  el: HTMLElement,
  lift: () => Lifted | null,
  x: number,
  y: number,
  via: DragVia,
  pointerId: number,
): void {
  const got = lift();
  if (!got || !got.items.length) return;
  const refused = liftRefusal(got.items);
  if (refused) {
    showRefusal(el, refused.reason, refused.action);
    return;
  }
  const row = got.rows?.[0] ?? (el.closest('[data-dnd-row]') as HTMLElement | null) ?? el;
  const box = row.getBoundingClientRect();
  verdicts.clear();
  (got.rows ?? [row]).forEach((r) => r.setAttribute('data-dnd-lifted', ''));
  set({
    drag: { items: got.items, source: got.source, via },
    x,
    y,
    grabX: Math.max(0, Math.min(box.width, x - box.left)),
    grabY: Math.max(0, Math.min(48, y - box.top)),
    over: null,
    line: null,
    note: null,
    refused: null,
  });
  try {
    el.setPointerCapture?.(pointerId);
    captured = { el, id: pointerId };
  } catch {
    captured = null;
  }
  if (via === 'touch') navigator.vibrate?.(10);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancelEvent);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onCancelEvent);
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  light();
  liveSay(
    got.items.length === 1
      ? `Picked up ${got.items[0].title}. Drop it on a set, Up next or a place in a list; Escape cancels.`
      : `Picked up ${got.items.length} tracks. Drop them on a set, Up next or a place in a list; Escape cancels.`,
  );
  lastFrame = 0;
  raf = window.requestAnimationFrame(frame);
}

function onMove(e: PointerEvent): void {
  if (!state.drag) return;
  set({ x: e.clientX, y: e.clientY });
  hitTest();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && state.drag && !state.kbd) {
    e.preventDefault();
    e.stopPropagation();
    cancel(true);
  }
}

function onCancelEvent(): void {
  if (state.drag && !state.kbd) cancel(true);
}

/** The click a pointer's release makes after a drag isn't a press on what's under it. */
function swallowNextClick(): void {
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 400);
}

function onUp(): void {
  const drag = state.drag;
  const over = state.over;
  if (!drag) return;
  swallowNextClick();
  const t = over ? targets.get(over.id) : undefined;
  if (!t || !over?.verdict.ok) {
    // 32e: let go anywhere else to cancel
    cancel(true);
    return;
  }
  end();
  void runDrop(t, drag, over.preview ? over.preview.gap : null);
}

/** Work the target under the pointer out again (its words changed: the holdings came). */
export function refreshOver(): void {
  if (!state.drag || state.kbd || !state.over) return;
  set({ over: null });
  hitTest();
}

/** Find the target under the pointer and what it would do there. */
function hitTest(): void {
  const drag = state.drag;
  if (!drag) return;
  const hit = document.elementFromPoint?.(state.x, state.y) ?? null;
  const el = hit?.closest?.('[data-dnd-target]') as HTMLElement | null;
  const t = el ? targets.get(el.getAttribute('data-dnd-target') ?? '') : undefined;
  if (!t) {
    if (state.over) {
      clearGap();
      set({ over: null, line: null, note: null });
      light();
    }
    return;
  }
  let verdict = verdictFor(t, drag);
  let preview: Preview | null = null;
  let gap: number | null = null;
  if (verdict.ok && t.rows && t.preview) {
    gap = modelGap(t, state.y);
    preview = t.preview(drag, gap);
    if (preview.invalid) verdict = { ok: false, reason: preview.invalid };
  }
  const hint = verdict.ok && !preview ? (t.hint?.(drag) ?? null) : null;
  const same =
    state.over &&
    state.over.id === t.id &&
    state.over.gap === gap &&
    state.over.preview?.line === preview?.line &&
    state.over.preview?.gap === preview?.gap &&
    state.over.verdict.ok === verdict.ok &&
    state.over.verdict.reason === verdict.reason;
  if (same) return;
  const line = verdict.ok ? openGap(t, preview) : openGap(t, null);
  const box = t.el()?.getBoundingClientRect();
  let note: NoteBox | null = null;
  if (!verdict.ok && verdict.reason && box) {
    note = {
      top: box.top + 6,
      left: box.left + 6,
      width: Math.min(box.width - 12, 420),
      words: verdict.reason,
      action: verdict.action ?? null,
    };
  } else if (preview?.locked) {
    const row = visibleRows(t).find(
      (r) => Number(r.getAttribute('data-dnd-index')) === preview!.locked!.index,
    );
    const rb = row?.getBoundingClientRect();
    if (rb)
      note = {
        top: rb.top + 4,
        left: rb.right - Math.min(rb.width, 380) - 8,
        width: Math.min(rb.width, 380),
        words: preview.locked.words,
      };
  }
  set({ over: { id: t.id, gap, verdict, preview, hint }, line, note });
  light();
}

function frame(now: number): void {
  if (!state.drag) return;
  const dt = lastFrame ? Math.min(64, now - lastFrame) / 1000 : 0;
  lastFrame = now;
  const over = state.over ? targets.get(state.over.id) : null;
  const hit = document.elementFromPoint?.(state.x, state.y) ?? null;
  // over a target that isn't a list (a set, the bar's zone, the tray) nothing scrolls (L6)
  const scroller =
    over && !over.rows ? null : scrollerOf(over ?? null, (over?.el() ?? hit) as Element | null);
  let scroll: DndState['scroll'] = null;
  if (scroller && state.drag.via !== 'keyboard') {
    const isPage = scroller === document.scrollingElement;
    const box = isPage
      ? { top: 0, bottom: window.innerHeight, left: 0, width: window.innerWidth }
      : scroller.getBoundingClientRect();
    const rowEl = over ? visibleRows(over)[0] : null;
    const rowHeight = rowEl?.getBoundingClientRect().height || 56;
    const speed = autoScrollSpeed(state.y, box.top, box.bottom, rowHeight);
    if (speed) {
      scrollCarry += speed * dt;
      const step = Math.trunc(scrollCarry);
      if (step) {
        scroller.scrollTop += step;
        scrollCarry -= step;
      }
      scroll = {
        edge: speed < 0 ? 'up' : 'down',
        top: speed < 0 ? box.top : box.bottom - 48,
        left: box.left,
        width: box.width,
        height: 48,
      };
      hitTest();
    } else scrollCarry = 0;
  }
  if (Boolean(scroll) !== Boolean(state.scroll) || scroll?.top !== state.scroll?.top)
    set({ scroll });
  // the line follows its row while the list moves under it
  if (over && state.line && state.over?.preview && state.over.verdict.ok) {
    const line = measureLine(over, state.over.preview);
    if (line && (line.top !== state.line.top || line.left !== state.line.left)) set({ line });
  }
  raf = window.requestAnimationFrame(frame);
}

function end(): void {
  if (raf) window.cancelAnimationFrame(raf);
  raf = 0;
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onCancelEvent);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', onCancelEvent);
  document.removeEventListener('touchmove', onTouchMove);
  if (captured) {
    try {
      captured.el.releasePointerCapture?.(captured.id);
    } catch {
      /* already released */
    }
    captured = null;
  }
  unwatchKeyboardLift();
  unlight();
  verdicts.clear();
  set({ drag: null, over: null, line: null, note: null, scroll: null, kbd: null });
}

/* a keyboard pick-up ends when the focus leaves its list or Escape is pressed anywhere (M2) */
let kbdWatch: { list: HTMLElement | null; timer: number } | null = null;

function kbdEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !state.kbd) return;
  // on the lifted row the row grid takes Escape itself, with the same words;
  // anywhere else (a control inside the row too) it's put back here (L-a)
  const lifted = (e.target as Element | null)?.getAttribute?.('data-dnd-lifted') === 'keyboard';
  if (lifted && kbdWatch?.list?.contains(e.target as Node)) return;
  e.preventDefault();
  e.stopPropagation();
  cancel(true);
}

function kbdFocusOut(): void {
  if (!kbdWatch) return;
  window.clearTimeout(kbdWatch.timer);
  // a tick later: a list that draws its rows again puts the focus back first
  kbdWatch.timer = window.setTimeout(() => {
    const list = kbdWatch?.list;
    if (!state.kbd || !list) return;
    if (!list.contains(document.activeElement)) cancel(true);
  }, 0);
}

function watchKeyboardLift(list: HTMLElement | null): void {
  unwatchKeyboardLift();
  kbdWatch = { list, timer: 0 };
  window.addEventListener('keydown', kbdEscape, true);
  list?.addEventListener('focusout', kbdFocusOut);
}

function unwatchKeyboardLift(): void {
  if (!kbdWatch) return;
  window.clearTimeout(kbdWatch.timer);
  window.removeEventListener('keydown', kbdEscape, true);
  kbdWatch.list?.removeEventListener('focusout', kbdFocusOut);
  kbdWatch = null;
}

/** Put it back (Escape, a drop outside every target, a lost pointer). */
export function cancel(say = false): void {
  const drag = state.drag;
  const kbd = state.kbd;
  end();
  if (!say || !drag) return;
  if (kbd) {
    const t = targets.get(kbd.targetId);
    const total = t?.lockables?.().length ?? 0;
    liveSay(cancelledWords(drag.items[0]?.title || 'The track', kbd.from + 1, total), t);
  } else
    liveSay(
      drag.items.length === 1
        ? `Cancelled. ${drag.items[0].title} wasn't moved.`
        : 'Cancelled. Nothing was moved.',
    );
}

/* ── the drop, its toast and its Undo ─────────────────────────────────── */

/** The toast's key, so a page that goes can take it down (step 3's dismissToast). */
export const UNDO_TOAST_KEY = 'dnd-undo';

let lastUndo: { run: () => void; until: number } | null = null;

/** ⌘Z / Ctrl Z while the toast shows (32c): the last drop's Undo, once. */
export function undoLast(): boolean {
  if (!lastUndo || Date.now() > lastUndo.until) {
    lastUndo = null;
    return false;
  }
  const run = lastUndo.run;
  lastUndo = null;
  window.dismissToast?.(UNDO_TOAST_KEY);
  run();
  return true;
}

/** For tests: forget the last drop. */
export function resetDndForTests(): void {
  clearPending();
  end();
  lastUndo = null;
  targets.clear();
  state = EMPTY;
}

/** Say a drop with its Undo (6 s, 32c). Shared by Send to…, which has no drag. */
export function showDropResult(result: DropResult, target?: DropTarget | null): void {
  const undo = result.undo;
  if (!undo) {
    lastUndo = null;
    window.showToast?.(result.words, 'success');
    return;
  }
  let used = false;
  const run = () => {
    if (used) return;
    used = true;
    lastUndo = null;
    Promise.resolve()
      .then(() => undo())
      .then(() => liveSay(`Undone: ${result.words}`, target ?? null))
      .catch((err: unknown) =>
        window.showToast?.(
          err instanceof Error ? err.message : "That couldn't be undone.",
          'error',
        ),
      );
  };
  lastUndo = { run, until: Date.now() + UNDO_MS };
  window.showToast?.(result.words, 'success', null, {
    key: UNDO_TOAST_KEY,
    ms: UNDO_MS,
    action: { label: 'Undo', run },
  });
}

async function runDrop(t: DropTarget, drag: Drag, gap: number | null): Promise<void> {
  try {
    const result = await t.drop(drag, gap);
    if (!result) return;
    showDropResult(result, t);
    result.focus?.();
  } catch (err) {
    window.showToast?.(err instanceof Error ? err.message : "That didn't go in.", 'error');
  }
}

/* ── the keyboard (32d) ────────────────────────────────────────────────── */

/** The gap a keyboard place means for the row at `from`. */
export function kbdGap(from: number, at: number): number {
  return at > from ? at + 1 : at;
}

function kbdPreview(): void {
  const k = state.kbd;
  const drag = state.drag;
  if (!k || !drag) return;
  const t = targets.get(k.targetId);
  if (!t) return;
  const preview = k.at === k.from ? null : (t.preview?.(drag, kbdGap(k.from, k.at)) ?? null);
  // a place the target refuses (the incoming track mid-mix, M3): amber, no line
  const verdict: Verdict = preview?.invalid ? { ok: false, reason: preview.invalid } : { ok: true };
  const line0 = openGap(t, verdict.ok ? preview : null);
  // the line's place stays in view as the arrows move it
  const gapRow = t.el()?.querySelector<HTMLElement>('[data-dnd-gap]');
  gapRow?.scrollIntoView?.({ block: 'nearest' });
  const line = gapRow && preview && verdict.ok ? measureLine(t, preview) : line0;
  let note: NoteBox | null = null;
  const box = !verdict.ok ? t.el()?.getBoundingClientRect() : null;
  if (box && verdict.reason)
    note = {
      top: box.top + 6,
      left: box.left + 6,
      width: Math.min(box.width - 12, 420),
      words: verdict.reason,
    };
  set({
    over: preview ? { id: t.id, gap: kbdGap(k.from, k.at), verdict, preview, hint: null } : null,
    line,
    note,
  });
}

/**
 * Space on a focused row of a list that reorders (a set's, Up next): picks
 * it up where it is (32d). The row keeps the focus, drawn as lifted.
 */
export function keyboardLift(targetId: string, from: number, lifted: Lifted): boolean {
  const t = targets.get(targetId);
  if (!t || state.drag) return false;
  const refused = liftRefusal(lifted.items);
  if (refused) {
    liveSay(refused.reason, t);
    return false;
  }
  verdicts.clear();
  lifted.rows?.forEach((r) => r.setAttribute('data-dnd-lifted', 'keyboard'));
  watchKeyboardLift(t.el());
  set({
    drag: { items: lifted.items, source: lifted.source, via: 'keyboard' },
    kbd: { targetId, from, at: from },
    over: null,
    line: null,
    note: null,
  });
  const total = t.lockables?.().length ?? 0;
  liveSay(pickedUpWords(lifted.items[0]?.title || 'The track', from + 1, total), t);
  return true;
}

/** While a row is picked up: ↑ ↓ ⇧↑ ⇧↓ move it, Enter or Space drops, Escape cancels. */
export function keyboardKey(key: 'up' | 'down' | 'top' | 'end' | 'drop' | 'cancel'): boolean {
  const k = state.kbd;
  const drag = state.drag;
  if (!k || !drag) return false;
  const t = targets.get(k.targetId);
  if (!t) {
    end();
    return true;
  }
  if (key === 'cancel') {
    cancel(true);
    return true;
  }
  if (key === 'drop') {
    const at = k.at;
    const from = k.from;
    // a refused place: say why and keep it lifted, so the arrows can find another
    const why = state.over && !state.over.verdict.ok ? state.over.verdict.reason : null;
    if (why) {
      liveSay(why, t);
      return true;
    }
    end();
    if (at === from) {
      liveSay(`${drag.items[0]?.title || 'The track'} stays at ${from + 1}.`, t);
      return true;
    }
    void runDrop(t, drag, kbdGap(from, at));
    return true;
  }
  const at = keyboardTarget(t.lockables?.() ?? [], k.from, k.at, key);
  set({ kbd: { ...k, at } });
  kbdPreview();
  const refused = state.over && !state.over.verdict.ok ? state.over.verdict.reason : null;
  const words = refused
    ? `${drag.items[0]?.title || 'The track'}, ${at + 1}. ${refused}.`
    : t.moveWords?.(drag, k.from, at);
  if (words) liveSay(words, t);
  return true;
}

export function isKeyboardLifted(): boolean {
  return Boolean(state.kbd);
}
