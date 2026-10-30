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
import { mixTabShown } from '@/features/mix/mix-visibility';
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
  type SetJoinReset,
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
  // the Mix tab's New set isn't there while the tab is hidden
  if (!set) return mixTabShown() ? REASONS.noSet : REASONS.noSetHidden;
  return set.kind === 'famous' ? REASONS.famous : null;
}

function changed(id: number): void {
  window.dispatchEvent(new CustomEvent(MIX_SET_CHANGED, { detail: { id } }));
}

async function analysingWords(ids: string[], setId: number | null): Promise<string> {
  const words = addedAnalysisWords(await askForAdded(ids, { source: 'set', setId }));
  return words ? ` · ${words}` : '';
}

/**
 * The row index each added track's number names (numbers count rows with a
 * track). Only an exact match counts: a row whose number now holds another
 * track was moved since, and guessing which copy is ours could take out the
 * person's own row (review L4), so it's left out and the Undo says it can't.
 */
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
  return out;
}

const AUTO_RESET = { style: 'auto', bars: 16 };

/**
 * The joins an add after a row reset to Auto, given back (review M1): each
 * found by its number and track, and only while it's still the Auto the
 * add left (one the person chose since is theirs).
 */
export function restoreJoins(rows: SetRow[], reset: SetJoinReset[]): SetRow[] {
  if (!reset.length) return rows;
  // by number and track together: a set can hold the same track twice (L-b)
  const want = new Map(reset.map((r) => [r.number, r]));
  const out = rows.slice();
  let n = 0;
  out.forEach((row, i) => {
    if (!row.track_id) return;
    n += 1;
    const r = want.get(n);
    if (!r || String(r.track_id) !== String(row.track_id)) return;
    const now = row.transition;
    if (!now || now.style !== AUTO_RESET.style || now.bars !== AUTO_RESET.bars) return;
    out[i] = { ...row, transition: r.transition };
  });
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
  reset: SetJoinReset[] = [],
): Promise<void> {
  for (let tries = 0; tries < 2; tries += 1) {
    const now = await fetchSet(setId);
    const rows = now.rows.map(
      ({ track: _t, unreachable: _u, gone_track: _g, ...row }) => row as SetRow,
    );
    const gone = indexesOfNumbers(rows, added);
    if (!gone.length) throw new Error("Can't undo: those tracks aren't in the set any more");
    if (gone.length < added.length)
      throw new Error("Can't undo: the set has changed since · move or remove them in the set");
    // the reset joins first, by the numbers the add gave (the rows as it left them)
    const joined = restoreJoins(rows, reset);
    try {
      await updateSet(setId, {
        rows: rowsBody(removeKeepingLocked(joined, gone)),
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
  const reset = done.reset ?? [];
  return { words, undo: () => undoServerAdd(set.id, added, reset) };
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
  /** -1 not in Up next, -2 playing or played now, -3 the incoming row a mix holds */
  moveTrack?(row: Record<string, unknown>, to: number): number;
  firstFree?(): number;
  announce?(words: string): void;
  focusRow?(index: number): void;
  startMoveMode?(index: number): void;
}

export function player(): PlayerRows | null {
  return (window as unknown as { SoulSyncPlayer?: PlayerRows }).SoulSyncPlayer ?? null;
}

/** A mix running or counting down: it holds the incoming row (32c), so Play next waits behind it. */
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

/** Why a queue row can't be moved now (H1, M3), or null: by the row itself, not a remembered index. */
export function moveRefusal(code: number, undo = false): string | null {
  if (code === -1) return "Can't do that: the track isn't in Up next any more";
  if (code === -2) return undo ? REASONS.undoPlayingNow : REASONS.playingNow;
  if (code === -3) return REASONS.incoming;
  return null;
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
  // while a mix holds the incoming row, Play next goes straight after it (M3)
  const held = at === 'next' && st.index >= 0 && mixing();
  const index = at === 'next' ? st.index + (held ? 2 : 1) : at === 'end' ? st.queue.length : at;
  const put = p.insertAt(index, rows);
  if (!put.length) return null;
  const landed = p.state().queue.indexOf(put[0]);
  const words =
    (await upNextWords(items, landed < 0 ? index : landed, at === 'next' && !held)) +
    (held ? ' · after the incoming track' : '');
  return {
    words,
    undo: () => {
      const gone = p.removeTracks?.(put) ?? 0;
      if (!gone) throw new Error("Can't undo: those tracks aren't in Up next any more");
      // some stayed (the incoming track a mix holds, or one playing now): say so (L-c)
      const left = put.length - gone;
      if (left > 0)
        throw new Error(
          `Took ${gone} of ${put.length} out · ${left === 1 ? 'one is playing or mixing in now, so it stays' : `${left} are playing or mixing in now, so they stay`}`,
        );
    },
  };
}
