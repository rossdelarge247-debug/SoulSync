/**
 * A saved set as a drop target (32b state 3: the sidebar's Your sets, the
 * Sets page's Your sets; appends, "drop to add · goes last"), the draft in
 * this browser as one, and which of the lifted tracks each set already
 * holds, for "In it already · #4 · drop to add again" (32b state 6: asked
 * once a drag starts, `POST /api/sets/holding`).
 */
import type { SetKind } from '@/features/sets/sets.api';

import type { DropTarget } from './dnd-engine';

import { duplicateWords, type DragItem } from './dnd-model';
import { sendToDraft, sendToSet, setRefusal } from './send-to';

let holdings: Map<number, Record<string, number[]>> = new Map();

/** What a drag's holdings read said (the host asks when a drag starts). */
export function setHoldings(next: Map<number, Record<string, number[]>>): void {
  holdings = next;
}

/** The number in that set of the first of these it already holds, or null. */
export function holdingNumber(setId: number, items: DragItem[]): number | null {
  const holds = holdings.get(setId);
  if (!holds) return null;
  for (const t of items) {
    const n = holds[t.id]?.[0];
    if (n) return n;
  }
  return null;
}

export function setTarget(
  id: string,
  set: { id: number; name: string; kind: SetKind },
  el: () => HTMLElement | null,
): DropTarget {
  return {
    id,
    kind: 'set',
    listId: `set:${set.id}`,
    name: set.name,
    el,
    accepts: () => {
      const reason = setRefusal(set);
      return reason ? { ok: false, reason } : { ok: true };
    },
    hint: (drag) => {
      const n = holdingNumber(set.id, drag.items);
      return n ? duplicateWords(n) : 'drop to add · goes last';
    },
    drop: (drag) => sendToSet(set, drag.items),
  };
}

/** The draft in this browser (Your sets' draft row): appends to it here. */
export function draftTarget(
  id: string,
  profileId: number,
  name: string,
  ids: (string | null)[],
  el: () => HTMLElement | null,
): DropTarget {
  return {
    id,
    kind: 'set',
    listId: 'set:draft',
    name,
    el,
    accepts: () => ({ ok: true }),
    hint: (drag) => {
      const want = new Set(drag.items.map((t) => t.id));
      let n = 0;
      for (const tid of ids) {
        if (!tid) continue;
        n += 1;
        if (want.has(String(tid))) return duplicateWords(n);
      }
      return 'drop to add · goes last';
    },
    drop: async (drag) => sendToDraft(profileId, drag.items),
  };
}
