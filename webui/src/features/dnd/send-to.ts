/**
 * What a drop (or "Send to…", its keyboard and phone path, 32d and 32e) does
 * once it lands on another surface: a set that isn't open (the sidebar's,
 * Your sets'), the working set (after the playing track while it plays,
 * 293), Up next (a place, or Play next at its top), the draft in this
 * browser. Every one returns the toast's words and its Undo (32c), reusing
 * the routes that exist (CONTRACTS "Sets": `POST /api/sets/<id>/tracks`
 * to add, `GET` and `PUT /api/sets/<id>` with `base_revision` to take the
 * added rows out again), and queues what isn't ready to mix the way step
 * 1's triggers do ("Added · analysing, 2nd in line").
 *
 * `sendToContext` is what the "…"'s Send to… names (the working set and
 * where a track would go in it, Up next's last row), kept fresh by the host.
 */
import { askForAdded } from '@/features/dj/analysis.api';
import { addedAnalysisWords } from '@/features/dj/analysis.format';
import { addToWorkingSet, startWorkingSet } from '@/features/mix/mix.api';
import { workingSetName } from '@/features/mix/mix.format';
import { readDraft, writeDraft } from '@/features/sets/draft-store';
import {
  MIX_SET_CHANGED,
  StaleSaveError,
  deleteSet,
  fetchSet,
  rowsBody,
  updateSet,
  type SetKind,
  type SetRow,
} from '@/features/sets/sets.api';

import type { DropResult } from './dnd-engine';

import { REASONS, dropWords, removeKeepingLocked, type DragItem } from './dnd-model';

export interface SetRef {
  id: number;
  name: string;
  kind: SetKind;
}

export interface SendToContext {
  profileId: number | null;
  working: (SetRef & { next: number | null }) | null;
  /** while the working set plays: the playing row, so a track goes in after it (293) */
  after: { track_id: string; number: number; title: string } | null;
  /** Up next's last row's title ("after Static Bloom") */
  upNextLast: string | null;
}

let ctx: SendToContext = { profileId: null, working: null, after: null, upNextLast: null };

export function setSendToContext(next: Partial<SendToContext>): void {
  ctx = { ...ctx, ...next };
}

export function sendToContext(): SendToContext {
  return ctx;
}

/** A set a drop can't change (32b): a famous mix, as 32b draws it; why, or null. */
export function setRefusal(set: Pick<SetRef, 'kind'> | null | undefined): string | null {
  if (!set) return REASONS.noSet;
  return set.kind === 'famous' ? REASONS.famous : null;
}

function changed(id: number): void {
  window.dispatchEvent(new CustomEvent(MIX_SET_CHANGED, { detail: { id } }));
}

async function analysingWords(ids: string[], setId: number | null): Promise<string> {
  const words = addedAnalysisWords(await askForAdded(ids, { source: 'set', setId }));
  return words ? ` · ${words}` : '';
}

/** The row index each added track's number names (numbers count rows with a track). */
export function indexesOfNumbers(
  rows: Pick<SetRow, 'track_id'>[],
  added: { track_id: string; number: number }[],
): number[] {
  const out: number[] = [];
  let n = 0;
  const want = new Map(added.map((a) => [a.number, String(a.track_id)]));
  rows.forEach((row, i) => {
    if (!row.track_id) return;
    n += 1;
    if (want.get(n) === String(row.track_id)) out.push(i);
  });
  // a row moved since: the same track, the last one of it
  if (out.length < added.length) {
    for (const a of added) {
      if (out.some((i) => String(rows[i].track_id) === String(a.track_id))) continue;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (String(rows[i].track_id) === String(a.track_id) && !out.includes(i)) {
          out.push(i);
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Undo an add to a saved set that isn't open here: read it, take out the
 * rows the add put in (the unlocked rows flow back round locked ones), save
 * from the revision just read. Tried twice if the set moves on in between.
 */
export async function undoServerAdd(
  setId: number,
  added: { track_id: string; number: number }[],
): Promise<void> {
  for (let tries = 0; tries < 2; tries += 1) {
    const now = await fetchSet(setId);
    const rows = now.rows.map(
      ({ track: _t, unreachable: _u, gone_track: _g, ...row }) => row as SetRow,
    );
    const gone = indexesOfNumbers(rows, added);
    if (!gone.length) throw new Error("Can't undo: those tracks aren't in the set any more");
    try {
      await updateSet(setId, {
        rows: rowsBody(removeKeepingLocked(rows, gone)),
        baseRevision: now.set.revision,
      });
      changed(setId);
      return;
    } catch (err) {
      if (!(err instanceof StaleSaveError) || tries > 0) throw err;
    }
  }
}

/** Add to a saved set (the sidebar's, Your sets', Send to… → a set). A duplicate goes in again (32b). */
export async function sendToSet(
  set: SetRef,
  items: DragItem[],
  opts: { after?: { track_id: string; number: number } | null } = {},
): Promise<DropResult | null> {
  const refusal = setRefusal(set);
  if (refusal) throw new Error(refusal);
  const ids = items.map((t) => t.id);
  const asking = analysingWords(ids, set.id);
  const done = await addToWorkingSet(set.id, ids, { again: true, after: opts.after ?? null });
  changed(set.id);
  if (!done.added.length) {
    const why = done.left_out.length
      ? done.left_out.some((l) => l.reason === 'file_missing')
        ? REASONS.fileMissing
        : REASONS.notInLibrary
      : `Nothing went into ${done.name || set.name}.`;
    window.showToast?.(why, 'info');
    return null;
  }
  const added = done.added;
  const words =
    dropWords({
      mode: 'copy',
      items,
      where: done.name || set.name,
      numbers: added.map((a) => a.number),
    }) + (await asking);
  return { words, undo: () => undoServerAdd(set.id, added) };
}

/** The working set: after the playing track while it plays (293), else at the end; none yet: start one. */
export async function sendToWorkingSet(items: DragItem[]): Promise<DropResult | null> {
  const ws = ctx.working;
  if (!ws) {
    const name = workingSetName();
    const ids = items.map((t) => t.id);
    const made = await startWorkingSet(name, ids);
    window.dispatchEvent(new CustomEvent(MIX_SET_CHANGED, { detail: {} }));
    const words = `Started ${name} with ${items.length === 1 ? items[0].title : `${items.length} tracks`}${await analysingWords(ids, made.id)}`;
    return {
      words,
      undo: async () => {
        await deleteSet(made.id);
        window.dispatchEvent(new CustomEvent(MIX_SET_CHANGED, { detail: {} }));
      },
    };
  }
  return sendToSet(ws, items, {
    after: ctx.after ? { track_id: ctx.after.track_id, number: ctx.after.number } : null,
  });
}

/** The draft in this browser (Your sets' draft row): its rows, appended. */
export function sendToDraft(profileId: number, items: DragItem[]): DropResult | null {
  const draft = readDraft(profileId);
  if (!draft) return null;
  const fresh: SetRow[] = items.map((t) => ({
    track_id: t.id,
    artist: t.artist ?? null,
    title: t.title,
    state: 'owned',
    want: 'yours',
  }));
  writeDraft(profileId, { ...draft, rows: [...draft.rows, ...fresh] });
  const numbered = draft.rows.filter((r) => r.track_id).length;
  return {
    words: dropWords({
      mode: 'copy',
      items,
      where: draft.name,
      numbers: fresh.map((_f, k) => numbered + k + 1),
    }),
    undo: () => {
      const now = readDraft(profileId);
      if (!now) throw new Error("Can't undo: the draft has gone");
      const rows = [...now.rows];
      // the rows themselves, or (a draft read again) the last rows of those tracks
      for (const f of [...fresh].reverse()) {
        let at = rows.indexOf(f);
        if (at < 0) at = rows.map((r) => String(r.track_id)).lastIndexOf(String(f.track_id));
        if (at >= 0) rows.splice(at, 1);
      }
      writeDraft(profileId, { ...now, rows });
    },
  };
}

/* ── Up next (static/media-player.js) ──────────────────────────────────── */

interface PlayerRows {
  state(): {
    queue: Record<string, unknown>[];
    index: number;
    track: Record<string, unknown> | null;
  };
  insertAt?(index: number, tracks: Record<string, unknown>[]): Record<string, unknown>[];
  removeTracks?(rows: Record<string, unknown>[]): number;
  moveTrack?(row: Record<string, unknown>, to: number): number;
  announce?(words: string): void;
  focusRow?(index: number): void;
  startMoveMode?(index: number): void;
}

export function player(): PlayerRows | null {
  return (window as unknown as { SoulSyncPlayer?: PlayerRows }).SoulSyncPlayer ?? null;
}

/** What Up next takes for these: their queue shape (a track without one is left out). */
function queueRows(items: DragItem[]): Record<string, unknown>[] {
  return items.map((t) => t.queue ?? null).filter((q): q is Record<string, unknown> => Boolean(q));
}

/** Up next's own words for where a track goes ("Added … to Up next · #3"), its analysis line too. */
async function upNextWords(items: DragItem[], at: number, playNext: boolean): Promise<string> {
  const ask = window.ssAnalysisToastWords;
  const more = typeof ask === 'function' ? await ask(items.map((t) => t.id)).catch(() => '') : '';
  const words = dropWords({
    mode: 'copy',
    items,
    where: 'Up next',
    numbers: items.map((_t, k) => at + k + 1),
    playNext,
  });
  return more ? `${words} · ${more}` : words;
}

/**
 * Tracks into Up next at `at` (a queue index: never at or above the playing
 * row), or Play next (straight after it), or the end. Undo takes exactly
 * those rows out again.
 */
export async function sendToUpNext(
  items: DragItem[],
  at: number | 'next' | 'end',
): Promise<DropResult | null> {
  const p = player();
  const rows = queueRows(items);
  if (!p?.insertAt || !rows.length) {
    window.showToast?.("The player isn't ready yet. Try again in a moment.", 'error');
    return null;
  }
  const st = p.state();
  const index = at === 'next' ? st.index + 1 : at === 'end' ? st.queue.length : at;
  const put = p.insertAt(index, rows);
  const landed = p.state().queue.indexOf(put[0]);
  const words = await upNextWords(items, landed < 0 ? index : landed, at === 'next');
  return {
    words,
    undo: () => {
      if (!p.removeTracks?.(put))
        throw new Error("Can't undo: those tracks aren't in Up next any more");
    },
  };
}
