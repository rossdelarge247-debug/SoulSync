/**
 * UX-27's row grid, folded into Brief B's keys (32d): one tab stop for the
 * list, ↑ ↓ Home End between rows, → and ← to a row's buttons and back,
 * Enter plays (the row's Play), Space picks up (or sends), a field keeps
 * its own keys, and rows drawn again stay in the grid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDnd, keyboardLift, registerTarget, resetDndForTests } from './dnd-engine';
import { bindRowGrid } from './row-grid';

let off: () => void;
let space: ReturnType<typeof vi.fn<(row: HTMLElement) => boolean>>;
let played: string[];

function rowHtml(id: string) {
  return `<li data-row="${id}"><button data-row-play-button aria-label="Play ${id}">▶</button><input aria-label="note ${id}"><button aria-label="More for ${id}">…</button></li>`;
}

beforeEach(() => {
  document.body.innerHTML = `<ul id="list">${['a', 'b', 'c'].map(rowHtml).join('')}</ul>`;
  played = [];
  document
    .querySelectorAll<HTMLButtonElement>('[data-row-play-button]')
    .forEach((b) => b.addEventListener('click', () => played.push(b.getAttribute('aria-label')!)));
  space = vi.fn((_row: HTMLElement) => true);
  off = bindRowGrid(document.getElementById('list')!, {
    rowSelector: '[data-row]',
    onSpace: space,
    hint: 'Arrows move between rows',
  });
});
afterEach(() => off());

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-row]'));
const press = (el: Element, key: string, more: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...more }));

describe('the row grid', () => {
  it('puts one row in the tab order and the rows’ controls out of it, with its hint', () => {
    expect(rows().map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(
      Array.from(document.querySelectorAll('button, input')).every(
        (b) => b.getAttribute('tabindex') === '-1',
      ),
    ).toBe(true);
    const hint = document.getElementById(
      document.getElementById('list')!.getAttribute('aria-describedby')!,
    );
    expect(hint?.textContent).toBe('Arrows move between rows');
  });

  it('moves between rows with the arrows, Home and End, and the tab stop follows', () => {
    rows()[0].focus();
    press(rows()[0], 'ArrowDown');
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows().map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    press(rows()[1], 'End');
    expect(document.activeElement).toBe(rows()[2]);
    press(rows()[2], 'ArrowDown');
    expect(document.activeElement).toBe(rows()[2]);
    press(rows()[2], 'Home');
    expect(document.activeElement).toBe(rows()[0]);
  });

  it('reaches a row’s controls with → and comes back with ←', () => {
    rows()[1].focus();
    press(rows()[1], 'ArrowRight');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Play b');
    press(document.activeElement!, 'ArrowRight');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('note b');
    // a field keeps its own keys: ← in it isn't the grid's
    press(document.activeElement!, 'ArrowLeft');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('note b');
    (rows()[1].querySelector('[data-row-play-button]') as HTMLElement).focus();
    press(document.activeElement!, 'ArrowLeft');
    expect(document.activeElement).toBe(rows()[1]);
  });

  it('Enter plays the row (its Play) and Space picks it up', () => {
    rows()[2].focus();
    press(rows()[2], 'Enter');
    expect(played).toEqual(['Play c']);
    press(rows()[2], ' ');
    expect(space).toHaveBeenCalledWith(rows()[2]);
  });

  it('keeps rows drawn again in the grid', async () => {
    const list = document.getElementById('list')!;
    list.insertAdjacentHTML('beforeend', rowHtml('d'));
    await new Promise((r) => setTimeout(r, 0));
    expect(rows()[3].getAttribute('tabindex')).toBe('-1');
    expect(rows()[3].querySelector('button')!.getAttribute('tabindex')).toBe('-1');
  });
});

describe("a pick-up with the focus on one of the row's controls (review L-a)", () => {
  afterEach(() => resetDndForTests());

  function lift() {
    const list = document.getElementById('list')!;
    rows().forEach((r, i) => r.setAttribute('data-dnd-index', String(i)));
    registerTarget({
      id: 'list',
      kind: 'set-list',
      listId: 'set:1',
      name: 'Sunday Set',
      el: () => list,
      rows: () => rows(),
      lockables: () => [{}, {}, {}],
      accepts: () => ({ ok: true }),
      preview: (_d, gap) => ({ gap, line: null }),
      drop: async () => null,
      announce: () => {},
    });
    rows()[1].focus();
    keyboardLift('list', 1, {
      items: [{ id: 'b', title: 'B' }],
      source: { kind: 'set', listId: 'set:1', indexes: [1] },
      rows: [rows()[1]],
    });
  }

  it('an arrow brings the focus back to the lifted row and moves it', () => {
    lift();
    const more = document.querySelector<HTMLElement>('[aria-label="More for b"]')!;
    more.focus();
    press(more, 'ArrowDown');
    expect(document.activeElement).toBe(rows()[1]);
    expect(getDnd().kbd?.at).toBe(2);
  });

  it('Escape on a control inside the row puts it back', () => {
    lift();
    const more = document.querySelector<HTMLElement>('[aria-label="More for b"]')!;
    more.focus();
    press(more, 'Escape');
    expect(getDnd().drag).toBeNull();
  });
});
