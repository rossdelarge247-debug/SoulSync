/**
 * A saved set's own actions, shared by its page's header (33c) and Your
 * sets (33e):
 *
 * - **the working-set control**: "✓ My working set" (pressed) on the set
 *   that's working, "Make this my working set" on the others (295, 33c,
 *   33e); one per profile (`PUT /api/sets/working`), and the Mix tab, the
 *   sidebar and every other set read it again;
 * - **Remove this set…**: a proper confirm on 15a's frame (Design's 267),
 *   "Remove Sunday Set? Its playlist stays." with Remove · Keep, never the
 *   browser's own;
 * - **Duplicate** (262): a copy of the set's rows, saved as "Sunday Set
 *   (copy)", opened.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';
import { chooseWorkingSet, useWorkingSet } from '@/features/mix/mix.api';
import { useProfile } from '@/platform/shell/route-controllers';

import type { SetRow } from './sets.api';

import { MIX_SET_CHANGED, SETS_QUERY_KEY, createSet } from './sets.api';
import styles from './sets.module.css';

/** Tell every place that shows the working set to read it again. */
export function workingSetChanged(): void {
  window.dispatchEvent(new CustomEvent(MIX_SET_CHANGED, { detail: {} }));
}

/** Make a set the working set, or (with null) have none. */
export async function chooseWorking(id: number | null, name: string): Promise<boolean> {
  try {
    await chooseWorkingSet(id);
    workingSetChanged();
    window.showToast?.(
      id === null
        ? `${name} isn't your working set any more.`
        : `${name} is your working set: the Mix tab adds to it.`,
      'success',
    );
    return true;
  } catch (err) {
    window.showToast?.(err instanceof Error ? err.message : "That set wasn't chosen.", 'error');
    return false;
  }
}

/** Is this set the profile's working set? */
export function useIsWorking(setId: number | null): boolean {
  const { profileId } = useProfile();
  const working = useWorkingSet(setId ? profileId : null);
  return Boolean(setId && working && working.id === setId);
}

/**
 * The working-set toggle (33c, 33e): "✓ My working set" when it is (press to
 * have none), "Make this my working set" when it isn't.
 */
export function WorkingSetToggle({
  setId,
  name,
  compact = false,
}: {
  setId: number;
  name: string;
  /** Your sets' row: "✓ Working set" */
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const working = useIsWorking(setId);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    await chooseWorking(working ? null : setId, name);
    await qc.invalidateQueries({ queryKey: [...SETS_QUERY_KEY, 'working'] });
    setBusy(false);
  };
  return (
    <button
      type="button"
      className={styles.workingToggle}
      aria-pressed={working}
      disabled={busy}
      data-working-toggle=""
      title={working ? 'Your working set: the Mix tab adds to it. Press to have none' : undefined}
      onClick={() => void toggle()}
    >
      {working ? (
        <>
          <span aria-hidden="true">✓ </span>
          {compact ? 'Working set' : 'My working set'}
        </>
      ) : (
        'Make this my working set'
      )}
    </button>
  );
}

/** Remove this set… (267): the confirm on 15a's frame. */
export function RemoveSetDialog({
  name,
  open,
  onRemove,
  onKeep,
}: {
  name: string;
  open: boolean;
  onRemove: () => void;
  onKeep: () => void;
}) {
  return (
    <DialogFrame open={open} onOpenChange={(o) => !o && onKeep()} aria-label={`Remove ${name}?`}>
      <DialogHeader title={`Remove ${name}?`} description="Its playlist stays." />
      <DialogBody>
        <p className={styles.confirmBody}>
          The set, its order, notes and chips go. The playlist made from it stays on the Playlists
          page, and the tracks stay in your library.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" variant="secondary" onClick={onKeep}>
          Keep
        </Button>
        <Button size="lg" className={styles.removeButton} data-remove-set="" onClick={onRemove}>
          Remove
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}

/** Duplicate (262): the set's rows saved again as "<name> (copy)"; its id. */
export async function duplicateSet(set: {
  name: string;
  kind: 'hand' | 'famous' | 'suggested';
  rows: SetRow[];
}): Promise<number | null> {
  try {
    const name = `${set.name} (copy)`;
    const made = await createSet({ name, kind: set.kind, rows: set.rows });
    window.showToast?.(`Made ${name}: in Your sets and as a playlist`, 'success');
    return made.id;
  } catch (err) {
    window.showToast?.(err instanceof Error ? err.message : "The copy wasn't made.", 'error');
    return null;
  }
}

/**
 * The sidebar's Sets row says the working set's name (33c), read from the
 * same query as the rest, and again when any place changes it.
 */
export function WorkingSetNav() {
  const { profileId } = useProfile();
  const qc = useQueryClient();
  const working = useWorkingSet(profileId);
  useEffect(() => {
    const again = () => void qc.invalidateQueries({ queryKey: [...SETS_QUERY_KEY, 'working'] });
    window.addEventListener(MIX_SET_CHANGED, again);
    return () => window.removeEventListener(MIX_SET_CHANGED, again);
  }, [qc]);
  useEffect(() => {
    const note = document.querySelector<HTMLElement>('[data-nav-working-set]');
    if (!note) return;
    note.textContent = working?.name ?? '';
    note.hidden = !working;
    const row = note.closest('a');
    if (row) {
      if (working) row.setAttribute('title', `Sets · your working set is ${working.name}`);
      else row.removeAttribute('title');
    }
  }, [working]);
  return null;
}
