/**
 * UX-27's row grid, folded into Brief B's keyboard model (32d): a list of
 * tracks is one tab stop (a roving tabindex on its rows), ↑ ↓ Home End move
 * between rows, → and ← reach a row's own buttons and come back, Enter plays
 * the row (its Play, Brief D's one visible button), and Space picks the row
 * up: in a list that reorders (a set's, Up next) it lifts where it is and
 * the arrows move it (dnd-engine `keyboardLift`); elsewhere it opens Send
 * to… for the row (or the selection). While a row is picked up, ↑ ↓ ⇧↑ ⇧↓
 * move it, Enter or Space drops it, Escape cancels.
 *
 * DOM-based, so the same binding serves React's lists and the legacy Up
 * next (static/media-player.js), whose rows are drawn again on each change:
 * a MutationObserver keeps one row in the tab order and the rows' buttons
 * out of it.
 */
import { useEffect, useRef } from 'react';

import { isKeyboardLifted, keyboardKey } from './dnd-engine';

export interface RowGridOptions {
  /** the rows, inside the list */
  rowSelector: string;
  /** Space on a row; true when it acted */
  onSpace?: (row: HTMLElement) => boolean;
  /** Enter on a row (defaults to pressing its Play) */
  onEnter?: (row: HTMLElement) => void;
  /** Delete or Backspace on a row (Up next: remove it) */
  onDelete?: (row: HTMLElement) => void;
  /** said once to a screen reader on reaching the list (aria-describedby) */
  hint?: string;
}

const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([data-grid-row]), [role="menuitem"]';

const HINT_ID_PREFIX = 'dnd-grid-hint-';
let hints = 0;

function inField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (el as HTMLElement).isContentEditable === true
  );
}

/** Press a row's Play (Brief D's one visible button; Up next's "Play now"). */
export function pressPlay(row: HTMLElement): void {
  const play =
    row.querySelector<HTMLElement>('[data-row-play-button]:not([aria-disabled="true"])') ??
    row.querySelector<HTMLElement>('[data-queue-action="play-now"]') ??
    row.querySelector<HTMLElement>('[data-queue-action="play"]');
  play?.click();
}

/** Shown (a played Up next row is display: none until "Show all"). */
function shown(el: HTMLElement): boolean {
  if (el.hidden || el.closest('[hidden]')) return false;
  return typeof window === 'undefined' || window.getComputedStyle(el).display !== 'none';
}

export function bindRowGrid(list: HTMLElement, opts: RowGridOptions): () => void {
  let current: HTMLElement | null = null;
  const allRows = () => Array.from(list.querySelectorAll<HTMLElement>(opts.rowSelector));
  /**
   * The shown row `dir` steps from `from` in `every` (or the first / last
   * shown with `from` -1 / every.length). Only the rows it passes are
   * styled-checked, not the whole list on each key (L7).
   */
  const shownFrom = (every: HTMLElement[], from: number, dir: 1 | -1): HTMLElement | undefined => {
    for (let i = from + dir; i >= 0 && i < every.length; i += dir)
      if (shown(every[i])) return every[i];
    return undefined;
  };

  const tidy = (row: HTMLElement) => {
    row.setAttribute('data-grid-row', '');
    const want = row === current ? '0' : '-1';
    if (row.getAttribute('tabindex') !== want) row.setAttribute('tabindex', want);
    row.querySelectorAll<HTMLElement>(FOCUSABLE).forEach((el) => {
      if (el.closest(opts.rowSelector) !== row) return;
      if (el.getAttribute('tabindex') !== '-1') el.setAttribute('tabindex', '-1');
    });
  };

  let applying = false;
  /** every row (binding, or the current row went); `only` just those rows (a mutation, L7) */
  const apply = (only?: Iterable<HTMLElement>) => {
    if (applying) return;
    applying = true;
    try {
      if (!current || !list.contains(current)) {
        const every = allRows();
        if (!every.length) return;
        current = shownFrom(every, -1, 1) ?? every[0];
        only = undefined;
      }
      if (only) for (const row of only) tidy(row);
      else allRows().forEach(tidy);
    } finally {
      applying = false;
    }
  };
  /** the rows a mutation touched: the row it happened in, and rows it added */
  const onMutations = (records: MutationRecord[]) => {
    const touched = new Set<HTMLElement>();
    for (const r of records) {
      const at = (r.target as Element).closest?.(opts.rowSelector) as HTMLElement | null;
      if (at && list.contains(at)) touched.add(at);
      r.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        if (n.matches(opts.rowSelector)) touched.add(n as HTMLElement);
        n.querySelectorAll<HTMLElement>(opts.rowSelector).forEach((x) => touched.add(x));
      });
    }
    apply(touched);
  };

  const focusRow = (row: HTMLElement | undefined) => {
    if (!row) return;
    const was = current;
    current = row;
    apply(was && was !== row ? [was, row] : [row]);
    row.focus();
    row.scrollIntoView?.({ block: 'nearest' });
  };

  const controls = (row: HTMLElement) =>
    Array.from(row.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) =>
        el.closest(opts.rowSelector) === row &&
        !(el as HTMLButtonElement).disabled &&
        el.getAttribute('aria-hidden') !== 'true' &&
        shown(el),
    );

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const row = target.closest<HTMLElement>(opts.rowSelector);
    if (!row || !list.contains(row)) return;
    const onRow = target === row;
    const shift = event.shiftKey;

    // a row picked up with Space (32d). Focus on one of its controls (or
    // another row) goes back to the lifted row first, so its keys still work (L-a)
    if (isKeyboardLifted()) {
      if (!onRow) {
        const back = list.querySelector<HTMLElement>('[data-dnd-lifted="keyboard"]') ?? row;
        back.focus();
      }
      const map: Record<string, Parameters<typeof keyboardKey>[0] | undefined> = {
        ArrowUp: shift ? 'top' : 'up',
        ArrowDown: shift ? 'end' : 'down',
        Enter: 'drop',
        ' ': 'drop',
        Escape: 'cancel',
      };
      const k = map[event.key];
      if (k) {
        event.preventDefault();
        event.stopPropagation();
        keyboardKey(k);
      }
      return;
    }
    if (inField(target)) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (event.altKey || event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        const every = allRows();
        const next = shownFrom(every, every.indexOf(row), event.key === 'ArrowDown' ? 1 : -1);
        focusRow(next ?? row);
        return;
      }
      case 'Home':
      case 'End': {
        if (!onRow) return;
        event.preventDefault();
        const every = allRows();
        focusRow(
          event.key === 'Home' ? shownFrom(every, -1, 1) : shownFrom(every, every.length, -1),
        );
        return;
      }
      case 'ArrowRight':
      case 'ArrowLeft': {
        const cs = controls(row);
        if (!cs.length) return;
        event.preventDefault();
        if (onRow) {
          if (event.key === 'ArrowRight') cs[0].focus();
          return;
        }
        const i = cs.indexOf(target);
        if (event.key === 'ArrowRight') cs[Math.min(cs.length - 1, i + 1)]?.focus();
        else if (i <= 0) focusRow(row);
        else cs[i - 1]?.focus();
        return;
      }
      case ' ':
        if (!onRow || !opts.onSpace) return;
        if (opts.onSpace(row)) event.preventDefault();
        return;
      case 'Enter':
        if (!onRow) return;
        event.preventDefault();
        (opts.onEnter ?? pressPlay)(row);
        return;
      case 'Delete':
      case 'Backspace':
        if (!onRow || !opts.onDelete) return;
        event.preventDefault();
        opts.onDelete(row);
        return;
      default:
    }
  };

  const onFocusIn = (event: FocusEvent) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(opts.rowSelector);
    if (row && list.contains(row) && row !== current) {
      const was = current;
      current = row;
      apply(was ? [was, row] : [row]);
    }
  };

  let hintEl: HTMLElement | null = null;
  if (opts.hint && typeof document !== 'undefined') {
    hints += 1;
    hintEl = document.createElement('span');
    hintEl.id = `${HINT_ID_PREFIX}${hints}`;
    hintEl.textContent = opts.hint;
    hintEl.hidden = true;
    list.after(hintEl);
    const was = list.getAttribute('aria-describedby');
    list.setAttribute('aria-describedby', [was, hintEl.id].filter(Boolean).join(' '));
  }

  apply();
  const observer =
    typeof MutationObserver === 'undefined' ? null : new MutationObserver(onMutations);
  observer?.observe(list, { childList: true, subtree: true });
  list.addEventListener('keydown', onKeyDown);
  list.addEventListener('focusin', onFocusIn);
  return () => {
    observer?.disconnect();
    list.removeEventListener('keydown', onKeyDown);
    list.removeEventListener('focusin', onFocusIn);
    if (hintEl) {
      const ids = (list.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .filter((id) => id && id !== hintEl!.id);
      if (ids.length) list.setAttribute('aria-describedby', ids.join(' '));
      else list.removeAttribute('aria-describedby');
      hintEl.remove();
    }
  };
}

/**
 * A React list's row grid on `el` (keep it in state with a callback ref, so
 * the grid binds when the list appears). `opts`' handlers are read fresh.
 */
export function useRowGrid(el: HTMLElement | null, opts: RowGridOptions, enabled = true): void {
  const latest = useRef(opts);
  latest.current = opts;
  const { rowSelector, hint } = opts;
  useEffect(() => {
    if (!el || !enabled) return;
    return bindRowGrid(el, {
      rowSelector,
      hint,
      onSpace: (row) => latest.current.onSpace?.(row) ?? false,
      onEnter: (row) => (latest.current.onEnter ?? pressPlay)(row),
      onDelete: (row) => latest.current.onDelete?.(row),
    });
  }, [el, enabled, rowSelector, hint]);
}
