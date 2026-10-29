/**
 * Up next (the legacy list in static/media-player.js and index.html) in
 * Brief B's drag model: a target (a place in the list, Play next at its
 * top, a transition gap with both new chips, 32b and 32c), a source (its
 * rows still to come: a move within Up next, a copy anywhere else, 32g) and
 * a keyboard list (UX-27's row grid, Space and the arrows, 32d). The player
 * draws the rows and keeps the queue; this reads its rows' data-dnd-*
 * attributes and calls `window.SoulSyncPlayer` (insertAt, moveTrack,
 * removeTracks, announce). It replaces the list's own HTML5 drag.
 */
import type { QueryClient } from '@tanstack/react-query';

import { AUTO_CHOICE, planKey, planWords, type PairPlan } from '@/features/automix/plans';
import { getPrefs } from '@/features/automix/prefs';

import {
  keyboardLift,
  pointerDown,
  registerTarget,
  type Drag,
  type DropTarget,
  type Lifted,
  type Preview,
} from './dnd-engine';
import {
  REASONS,
  dropWords,
  gapToIndex,
  movedWords,
  textOf,
  type DragItem,
  type StepTrack,
} from './dnd-model';
import { bindRowGrid } from './row-grid';
import { player, sendToUpNext } from './send-to';

export const UP_NEXT_ID = 'upnext';

type QueueRow = Record<string, unknown>;

function queue(): { rows: QueueRow[]; index: number } {
  const st = player()?.state();
  return { rows: st?.queue ?? [], index: st?.index ?? -1 };
}

function num(v: unknown): number | null {
  const n = Number(v);
  return n > 0 ? n : null;
}

/** A queue row's DJ data, when it carries any (rows from Tracks do; others may not). */
export function queueStep(row: QueueRow | undefined): StepTrack & { title: string } {
  const dj = (row?.dj ?? {}) as Record<string, unknown>;
  return {
    title: textOf(row?.title),
    key: (dj.key as string | undefined) ?? (row?.key as string | undefined) ?? null,
    bpm: num(dj.bpm ?? row?.bpm),
  };
}

/** A queue row as the ghost and the other surfaces take it. */
export function queueItem(row: QueueRow): DragItem {
  const s = queueStep(row);
  return {
    id: textOf(row.id),
    title: s.title,
    artist: (row.artist as string | undefined) ?? null,
    key: s.key,
    bpm: s.bpm,
    fileMissing: !row.file_path,
    inLibrary: Boolean(row.file_path) && !row.media_src,
    queue: row,
  };
}

/** A mix running or counting down: the first gap is closed (32c). */
export function mixing(): boolean {
  const view = window.SoulSyncAutomix?.view?.() as
    | { stage?: string; barsToGo?: number | null }
    | undefined;
  if (!view) return false;
  return (
    ['counting', 'mixing', 'settling'].includes(view.stage ?? '') ||
    (view.barsToGo !== null && view.barsToGo !== undefined)
  );
}

function gapsShown(): boolean {
  try {
    return Boolean(
      (window.SoulSyncAutomix as { gapsWanted?: () => boolean } | undefined)?.gapsWanted?.(),
    );
  } catch {
    return false;
  }
}

/** A pair's chip from the plan already in the cache (327: never asked for on a hover). */
export function cachedChip(qc: QueryClient | null, from: unknown, to: unknown): string | null {
  if (!qc || from === undefined || from === null || to === undefined || to === null) return null;
  const plan = qc.getQueryData<PairPlan>(
    planKey(textOf(from), textOf(to), AUTO_CHOICE, getPrefs().lean),
  );
  if (!plan) return null;
  return planWords(plan, AUTO_CHOICE).replace(/ bars$/, '');
}

/**
 * What the line says at queue place `g` (32b, 32c): "Play next" at the top;
 * in a transition gap both new chips ("Long blend · 32 then Cut · 4") when
 * code's plan for both pairs is cached; otherwise where it goes.
 */
export function upNextLine(
  qc: QueryClient | null,
  rows: QueueRow[],
  index: number,
  g: number,
  items: DragItem[],
  move: boolean,
): string {
  const top = g === index + 1;
  if (gapsShown() && items.length) {
    const before = rows[g - 1];
    const after = rows[g];
    const a = before ? cachedChip(qc, before.id, items[0].id) : null;
    const b = after ? cachedChip(qc, items[items.length - 1].id, after.id) : null;
    if (a && b) return `${top ? 'Play next · ' : ''}${a} then ${b}`;
    if (a) return `${top ? 'Play next · ' : ''}${a}`;
  }
  if (top) return 'Play next';
  return move ? `Moves to #${g + 1}` : `Goes in as #${g + 1}`;
}

/** The queue place a gap names: never at or above the playing row. */
function clampGap(g: number, index: number, length: number): number {
  return Math.max(index + 1, Math.min(length, g));
}

function listEl(): HTMLElement | null {
  return document.getElementById('np-queue-list');
}

function rowEls(): HTMLElement[] {
  return Array.from(listEl()?.querySelectorAll<HTMLElement>('.np-queue-item') ?? []);
}

function liftRow(row: HTMLElement): Lifted | null {
  const i = Number(row.dataset.dndIndex);
  const q = queue();
  const track = q.rows[i];
  if (!track || i <= q.index || row.querySelector('[data-dnd-grip]') === null) return null;
  return {
    items: [queueItem(track)],
    source: { kind: 'upnext', listId: UP_NEXT_ID, indexes: [i] },
    rows: [row],
  };
}

export function upNextTarget(qc: QueryClient | null): DropTarget {
  return {
    id: UP_NEXT_ID,
    kind: 'upnext',
    listId: UP_NEXT_ID,
    name: 'Up next',
    el: () => {
      const panel = document.getElementById('np-queue-panel');
      return panel && panel.getClientRects().length ? panel : null;
    },
    rows: rowEls,
    // the playing row and those played hold their places
    lockables: () => {
      const q = queue();
      return q.rows.map((_r, i) => ({ locked: i <= q.index }));
    },
    accepts: (drag: Drag) =>
      drag.items.every((t) => t.queue) ? { ok: true } : { ok: false, reason: REASONS.notInLibrary },
    preview: (drag: Drag, gap: number): Preview => {
      const q = queue();
      const move = drag.source.listId === UP_NEXT_ID;
      const g = clampGap(gap, q.index, q.rows.length);
      if (g === q.index + 1 && q.index >= 0 && mixing())
        return { gap: g, line: null, invalid: REASONS.incoming };
      return { gap: g, line: upNextLine(qc, q.rows, q.index, g, drag.items, move) };
    },
    drop: async (drag: Drag, gap: number | null) => {
      const q = queue();
      const p = player();
      const g = clampGap(gap ?? q.rows.length, q.index, q.rows.length);
      if (drag.source.listId === UP_NEXT_ID) {
        const from = drag.source.indexes[0];
        const row = q.rows[from];
        if (!row || !p?.moveTrack) return null;
        const to = gapToIndex(from, g);
        const at = p.moveTrack(row, to);
        if (at < 0 || at === from) return null;
        return {
          words: dropWords({
            mode: 'move',
            items: drag.items,
            where: 'Up next',
            numbers: [at + 1],
          }),
          undo: () => {
            if ((p.moveTrack?.(row, from) ?? -1) < 0)
              throw new Error("Can't undo: that track isn't in Up next any more");
          },
          focus: () => p.focusRow?.(at),
        };
      }
      return sendToUpNext(drag.items, g === q.index + 1 ? 'next' : g);
    },
    announce: (words) => player()?.announce?.(words),
    moveWords: (drag: Drag, _from: number, at: number) => {
      const q = queue();
      const order = q.rows.slice();
      const from = drag.source.indexes[0];
      const [me] = order.splice(from, 1);
      order.splice(at, 0, me);
      // Up next's own numbers (its rows show them), the playing row included
      const before = at > 0 ? queueStep(order[at - 1]) : null;
      const after = order[at + 1] ? queueStep(order[at + 1]) : null;
      return movedWords(
        drag.items[0]?.title || 'The track',
        at + 1,
        order.length,
        queueStep(me),
        before,
        after,
      );
    },
    scroller: () => listEl()?.closest<HTMLElement>('.ss-player-rows, .ss-player-view') ?? listEl(),
  };
}

/** Bind Up next: its target, its rows' pointer and its keyboard. Returns the unbinding. */
export function bindUpNext(qc: QueryClient | null): () => void {
  const off = registerTarget(upNextTarget(qc));
  let unbindGrid: (() => void) | null = null;
  let boundTo: HTMLElement | null = null;

  const onPointerDown = (e: PointerEvent) => {
    const t = e.target as HTMLElement | null;
    const row = t?.closest<HTMLElement>('.np-queue-item');
    if (!row) return;
    const grip = t?.closest<HTMLElement>('[data-dnd-grip]');
    // a mouse lifts from the grip; a finger long-presses the row (32e)
    if (e.pointerType === 'touch' && !grip) {
      if (t?.closest('button:not(.np-queue-item-play)')) return;
      if (!row.querySelector('[data-dnd-grip]')) return;
      pointerDown(e, row, () => liftRow(row));
    } else if (grip) {
      pointerDown(e, grip, () => liftRow(row), 'grip');
    }
  };

  const bind = () => {
    const list = listEl();
    if (!list || list === boundTo) return;
    unbindGrid?.();
    boundTo?.removeEventListener('pointerdown', onPointerDown);
    boundTo = list;
    list.addEventListener('pointerdown', onPointerDown);
    unbindGrid = bindRowGrid(list, {
      rowSelector: '.np-queue-item',
      hint: 'Arrows move between rows; Space picks a row up to move it; Enter plays it; Delete removes it.',
      onSpace: (row) => {
        const lifted = liftRow(row);
        // the arrows move it among the rows still to come
        return lifted ? keyboardLift(UP_NEXT_ID, lifted.source.indexes[0], lifted) : false;
      },
      onDelete: (row) => {
        const i = Number(row.dataset.dndIndex);
        const q = queue();
        if (i <= q.index) return;
        (row.querySelector('[data-queue-action="remove"]') as HTMLElement | null)?.click();
      },
    });
  };
  bind();
  // the shell may draw the tray after us
  const late = window.setTimeout(bind, 800);
  const onPlayer = () => bind();
  window.addEventListener('ss:player', onPlayer);
  return () => {
    off();
    window.clearTimeout(late);
    window.removeEventListener('ss:player', onPlayer);
    unbindGrid?.();
    boundTo?.removeEventListener('pointerdown', onPointerDown);
  };
}
