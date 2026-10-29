/**
 * Brief B's drag and drop (32a–32g), the part that is only logic: what can
 * be lifted and why not, move or copy (32g's matrix), where a drop lands in
 * a list with locked rows (275), the step an insertion would make in Sets'
 * words (Design's 327: code, so it's instant), duplicates, the keyboard's
 * moves (32d) and every sentence a drop, a move or a cancel says.
 *
 * Nothing here touches the page; `dnd-engine.ts` and the surfaces use it.
 */
import { camelotParts } from '@/features/dj/key-colour';

/* ── what's lifted ─────────────────────────────────────────────────────── */

/** One track on the ghost. */
export interface DragItem {
  /** the library track's id */
  id: string;
  title: string;
  artist?: string | null;
  /** Camelot key and BPM, when known: the ghost shows them, and the step preview needs both */
  key?: string | null;
  bpm?: number | null;
  /** its file isn't on this computer */
  fileMissing?: boolean;
  /** the library's drive is away: why (Design's 328: refused as File missing) */
  away?: string | null;
  /** false for a search result that isn't yours (32b: only library tracks lift) */
  inLibrary?: boolean;
  /** as the player's queue takes it (Up next) */
  queue?: Record<string, unknown> | null;
}

/** Where a drag started (32g's rows). */
export type SourceKind = 'tracks' | 'search' | 'album' | 'mix' | 'upnext' | 'set';

export interface DragSource {
  kind: SourceKind;
  /** the list it came from: a drop in the same list is a move */
  listId: string;
  /** the rows lifted, in that list's order */
  indexes: number[];
}

/** 32g's columns. `dj` is DJ now (Brief E, step 5): a hook, absent until then. */
export type TargetKind = 'set-list' | 'set' | 'working' | 'upnext' | 'gap' | 'dj';

/** 32b's reasons, in its words. */
export const REASONS = {
  fileMissing: "Can't be lifted: its file is missing",
  notInLibrary: 'Only library tracks can be mixed · Download it first',
  famous: "A famous mix can't be changed · Save a copy to edit it",
  incoming: "Can't replace the incoming track · drop after it",
  noSet: 'Make a working set first · New set in the Mix tab',
} as const;

/** A locked row's own words (32b state 5): the line skips it. */
export function lockedWords(title: string): string {
  return `${title || 'That track'} is locked in its place · drops land after it`;
}

/**
 * Why these can't be lifted, or null. A missing file and a drive that's away
 * both say File missing (Design's 328 default: refused, not added); a search
 * result that isn't yours says Download it first. Said on the source row;
 * nothing lifts.
 */
export function liftRefusal(
  items: DragItem[],
): { reason: string; action?: 'find' | 'download' } | null {
  if (!items.length) return { reason: REASONS.notInLibrary, action: 'download' };
  if (items.some((t) => t.inLibrary === false))
    return { reason: REASONS.notInLibrary, action: 'download' };
  if (items.some((t) => t.fileMissing || t.away))
    return { reason: REASONS.fileMissing, action: 'find' };
  return null;
}

/**
 * 32g: within one list it's a move; anything dropped elsewhere is a copy (the
 * source keeps its row: Up next's rows on a set, a set's rows on Up next).
 */
export function dropMode(source: DragSource, targetListId: string): 'move' | 'copy' {
  return source.listId === targetListId ? 'move' : 'copy';
}

/* ── the step (core/sets/steps.py, the same rules) ─────────────────────── */

/** a step is a jump when the tempo moves more than this many BPM */
export const JUMP_BPM = 3;
/** ... or the key moves this many steps round the wheel, or more */
export const JUMP_STEPS = 2;

/** Steps round the Camelot wheel: 0 the same key, 1 for ±1 or the relative key, … */
export function wheelSteps(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const pa = camelotParts(a);
  const pb = camelotParts(b);
  if (!pa || !pb) return null;
  let apart = Math.abs(pa.number - pb.number) % 12;
  apart = Math.min(apart, 12 - apart);
  return apart + (pa.letter === pb.letter ? 0 : 1);
}

/** The BPM change from a to b, at the same tempo or played double or half time. */
export function tempoStep(a: number, b: number): { diff: number; how: 'same' | 'half' | 'double' } {
  let best: { diff: number; how: 'same' | 'half' | 'double' } = { diff: b - a, how: 'same' };
  for (const [factor, how] of [
    [0.5, 'half'],
    [2, 'double'],
  ] as const) {
    const diff = b * factor - a;
    if (Math.abs(diff) < Math.abs(best.diff) - 1e-9) best = { diff, how };
  }
  return best;
}

export interface StepTrack {
  key?: string | null;
  bpm?: number | null;
}

export interface PreviewStep {
  kind: 'smooth' | 'jump';
  from: string;
  to: string;
  turns: number;
  bpmDiff: number;
  how: 'same' | 'half' | 'double';
  /** why it's a jump: the keys, the tempo, or both */
  clash: 'key' | 'tempo' | null;
}

/**
 * The step from one track to the next by Sets' rules, or null when either
 * BPM or key isn't known (327: then the line shows the step after the drop,
 * never a guess).
 */
export function stepBetween(
  left: StepTrack | null | undefined,
  right: StepTrack | null | undefined,
): PreviewStep | null {
  const a = Number(left?.bpm);
  const b = Number(right?.bpm);
  if (!(a > 0) || !(b > 0) || !left?.key || !right?.key) return null;
  const turns = wheelSteps(left.key, right.key);
  if (turns === null) return null;
  const { diff, how } = tempoStep(a, b);
  const keyJump = turns >= JUMP_STEPS;
  const tempoJump = Math.abs(diff) > JUMP_BPM;
  return {
    kind: keyJump || tempoJump ? 'jump' : 'smooth',
    from: String(left.key).toUpperCase(),
    to: String(right.key).toUpperCase(),
    turns,
    bpmDiff: Math.round(diff * 10) / 10,
    how,
    clash: keyJump ? 'key' : tempoJump ? 'tempo' : null,
  };
}

function bpmShort(step: PreviewStep): string {
  if (step.how === 'half') return 'half time';
  if (step.how === 'double') return 'double time';
  const n = Math.round(step.bpmDiff);
  return n === 0 ? 'same BPM' : `${n > 0 ? '+' : '−'}${Math.abs(n)} BPM`;
}

/**
 * The insertion line's words (32a, 32b): "Smooth · 8A → 9A, +1" (+1 a step
 * round the wheel), "Smooth · 9A → 9A, same key", and the tempo when it's
 * what makes the jump ("Jump · 8A → 8A, same key, +6 BPM").
 */
export function stepLine(step: PreviewStep): string {
  const kind = step.kind === 'smooth' ? 'Smooth' : 'Jump';
  const keys = `${step.from} → ${step.to}, ${step.turns === 0 ? 'same key' : `+${step.turns}`}`;
  return `${kind} · ${keys}${step.clash === 'tempo' ? `, ${bpmShort(step)}` : ''}`;
}

/** The same step said aloud (32d): "Smooth, 9A to 9A", "Jump, 4B to 9A, the keys clash". */
export function stepSpoken(step: PreviewStep): string {
  const kind = step.kind === 'smooth' ? 'Smooth' : 'Jump';
  const why =
    step.clash === 'key'
      ? ', the keys clash'
      : step.clash === 'tempo'
        ? `, the tempos are ${Math.abs(Math.round(step.bpmDiff))} BPM apart`
        : '';
  return `${kind}, ${step.from} to ${step.to}${why}`;
}

/**
 * The whole line for an insertion between `before` and `after` (32a): the
 * step in, the count when several go in, and the step out "into" the next
 * track. A step that isn't known is left out (327); with neither known,
 * null (the line says where it goes instead).
 */
export function insertionLine(
  before: (StepTrack & { title?: string }) | null,
  items: StepTrack[],
  after: (StepTrack & { title?: string }) | null,
): string | null {
  const into = before && items[0] ? stepBetween(before, items[0]) : null;
  const out = after && items.length ? stepBetween(items[items.length - 1], after) : null;
  const parts: string[] = [];
  if (into) parts.push(stepLine(into));
  if (items.length > 1) parts.push(`${items.length} tracks`);
  if (out) parts.push(`${stepLine(out)} into ${after?.title || 'the next track'}`);
  return into || out ? parts.join(' · ') : null;
}

/* ── lists with locked rows (275) ──────────────────────────────────────── */

export interface Lockable {
  locked?: boolean | null;
}

/**
 * `rows` with `fresh` put in at `gap` (before row `gap`; `rows.length` is
 * the end), the way a set moves rows and the server inserts them
 * (`core/sets/store.insert_keeping_locked`): rows before the gap stay; after
 * it each locked row keeps its index and the unlocked ones, the fresh
 * first, fill the free places in order.
 */
export function insertKeepingLocked<T extends Lockable>(rows: T[], gap: number, fresh: T[]): T[] {
  const at = Math.max(0, Math.min(rows.length, gap));
  const total = rows.length + fresh.length;
  const out: (T | undefined)[] = Array.from<T | undefined>({ length: total });
  for (let i = 0; i < at; i += 1) out[i] = rows[i];
  const queue: T[] = [...fresh];
  for (let i = at; i < rows.length; i += 1) {
    if (rows[i].locked) out[i] = rows[i];
    else queue.push(rows[i]);
  }
  let k = 0;
  for (let i = 0; i < total; i += 1) {
    if (out[i] === undefined) {
      out[i] = queue[k];
      k += 1;
    }
  }
  return out.filter((r): r is T => r !== undefined);
}

/**
 * The inverse of `insertKeepingLocked` (a drop's Undo): the rows at
 * `indexes` go, locked rows after them keep their places and the unlocked
 * ones flow back up.
 */
export function removeKeepingLocked<T extends Lockable>(rows: T[], indexes: number[]): T[] {
  const gone = new Set(indexes.filter((i) => i >= 0 && i < rows.length));
  if (!gone.size) return rows;
  const first = Math.min(...gone);
  const total = rows.length - gone.size;
  const out: (T | undefined)[] = Array.from<T | undefined>({ length: total });
  for (let i = 0; i < first; i += 1) out[i] = rows[i];
  const queue: T[] = [];
  for (let i = first; i < rows.length; i += 1) {
    if (gone.has(i)) continue;
    if (rows[i].locked && i < total) out[i] = rows[i];
    else queue.push(rows[i]);
  }
  let k = 0;
  for (let i = 0; i < total; i += 1) {
    if (out[i] === undefined) {
      out[i] = queue[k];
      k += 1;
    }
  }
  return out.filter((r): r is T => r !== undefined);
}

/**
 * Where the line may open (32a: never at a locked row's place): a gap right
 * before a locked row moves past it, and past any locked rows after it.
 */
export function snapGap(rows: Lockable[], gap: number): number {
  let g = Math.max(0, Math.min(rows.length, gap));
  while (g < rows.length && rows[g]?.locked) g += 1;
  return g;
}

/** The locked row a pointer gap was pushed past, for its amber words, or -1. */
export function lockedAt(rows: Lockable[], gap: number): number {
  const g = Math.max(0, Math.min(rows.length, gap));
  return g < rows.length && rows[g]?.locked ? g : -1;
}

/** Where the fresh rows really end up after `insertKeepingLocked` (their indexes). */
export function placedIndexes<T extends Lockable>(rows: T[], gap: number, fresh: T[]): number[] {
  const out = insertKeepingLocked(rows, gap, fresh);
  const mine = new Set<T>(fresh);
  return out.flatMap((r, i) => (mine.has(r) ? [i] : []));
}

/** A drop at `gap` of the row at `from`, as moveRow's target index. */
export function gapToIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/**
 * The keyboard's next place for a lifted row (32d): ↑ and ↓ one free place
 * (locked rows are stepped over), ⇧↑ and ⇧↓ the top or the end's free place.
 */
export function keyboardTarget(
  rows: Lockable[],
  from: number,
  at: number,
  key: 'up' | 'down' | 'top' | 'end',
): number {
  const free = rows.flatMap((r, i) => (r.locked && i !== from ? [] : [i]));
  if (!free.length) return at;
  if (key === 'top') return free[0];
  if (key === 'end') return free[free.length - 1];
  const pos = free.indexOf(at);
  if (pos < 0) return at;
  const next = key === 'up' ? pos - 1 : pos + 1;
  return free[Math.max(0, Math.min(free.length - 1, next))];
}

/* ── duplicates ────────────────────────────────────────────────────────── */

/**
 * A set already holding one of these (32b state 6): its number, for "In it
 * already · #4 · drop to add again". `ids` is the list's rows' track ids in
 * order; `numberOf` their numbers in the set. Up next allows duplicates
 * without a note, so it doesn't ask.
 */
export function duplicateNumber(
  ids: (string | number | null | undefined)[],
  items: DragItem[],
  numberOf: (index: number) => number | null = (i) => i + 1,
): number | null {
  const want = new Set(items.map((t) => String(t.id)));
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (id !== null && id !== undefined && want.has(String(id))) return numberOf(i);
  }
  return null;
}

export function duplicateWords(number: number): string {
  return `In it already · #${number} · drop to add again`;
}

/* ── the words ─────────────────────────────────────────────────────────── */

/** "#7", "#7–8", "#3, #9". */
export function numbersWords(numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (!sorted.length) return '';
  const run = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  if (sorted.length === 1) return `#${sorted[0]}`;
  if (run) return `#${sorted[0]}–${sorted[sorted.length - 1]}`;
  return sorted.map((n) => `#${n}`).join(', ');
}

/** The ghost (32a): "Static Bloom · 9A 124"; several: "Static Bloom, Undertow" with a count. */
export function ghostWords(items: DragItem[]): { title: string; meta: string; count: number } {
  const first = items[0];
  if (!first) return { title: '', meta: '', count: 0 };
  if (items.length > 1) {
    const meta = items
      .slice(0, 2)
      .map((t) => [t.key, t.bpm ? Math.round(t.bpm) : null].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(' · ');
    return {
      title:
        items
          .slice(0, 2)
          .map((t) => t.title || 'Untitled')
          .join(', ') + (items.length > 2 ? ', …' : ''),
      meta,
      count: items.length,
    };
  }
  return {
    title: first.title || 'Untitled',
    meta: [first.key, first.bpm ? Math.round(first.bpm) : null].filter(Boolean).join(' '),
    count: 1,
  };
}

/** What a drop says in its toast (32b state 8). */
export function dropWords(opts: {
  mode: 'move' | 'copy';
  items: DragItem[];
  /** the set or "Up next" */
  where: string;
  numbers?: number[];
  playNext?: boolean;
}): string {
  const { mode, items, where, numbers = [], playNext } = opts;
  const what = items.length === 1 ? items[0].title || 'The track' : String(items.length);
  if (playNext) return `Playing next: ${items.length === 1 ? what : `${items.length} tracks`}`;
  const at = numbersWords(numbers);
  if (mode === 'move') return `Moved ${what} to ${at || where}`;
  return `Added ${what} to ${where}${at ? ` · ${at}` : ''}`;
}

/** 32d: said once when a row is picked up. */
export function pickedUpWords(title: string, place: number, total: number): string {
  return `Picked up ${title}, ${place} of ${total}. Arrows move it; Enter drops; Escape cancels.`;
}

/**
 * 32d: each move, with the new steps around it ("Canopy, 5 of 8. After Brass
 * Tide: Jump, 4B to 9A, the keys clash. Before Undertow: Smooth.").
 */
export function movedWords(
  title: string,
  place: number,
  total: number,
  self: StepTrack,
  before: (StepTrack & { title?: string }) | null,
  after: (StepTrack & { title?: string }) | null,
): string {
  const parts = [`${title}, ${place} of ${total}.`];
  if (before) {
    const step = stepBetween(before, self);
    parts.push(
      `After ${before.title || 'the track before'}${step ? `: ${stepSpoken(step)}` : ''}.`,
    );
  } else parts.push('At the top.');
  if (after) {
    const step = stepBetween(self, after);
    parts.push(
      `Before ${after.title || 'the next track'}${step ? `: ${step.kind === 'smooth' ? 'Smooth' : 'Jump'}` : ''}.`,
    );
  }
  return parts.join(' ');
}

/** 32d's Escape: the row goes back and says so. */
export function cancelledWords(title: string, place: number, total: number): string {
  return `Cancelled. ${title} is back at ${place} of ${total}.`;
}

/* ── pointer geometry ──────────────────────────────────────────────────── */

/** How near an edge auto-scroll starts (32a), in px. */
export const EDGE = 48;
/** 32a: a constant 8 rows a second. */
export const ROWS_PER_SECOND = 8;

/** Auto-scroll's speed in px a second: negative up, positive down, 0 away from the edges. */
export function autoScrollSpeed(y: number, top: number, bottom: number, rowHeight: number): number {
  if (bottom - top < EDGE * 3) return 0;
  if (y < top + EDGE && y >= top - EDGE) return -ROWS_PER_SECOND * rowHeight;
  if (y > bottom - EDGE && y <= bottom + EDGE) return ROWS_PER_SECOND * rowHeight;
  return 0;
}

/** The gap the pointer is over: before the first row whose middle is below it, else the end. */
export function gapAt(rects: { top: number; bottom: number }[], y: number): number {
  for (let i = 0; i < rects.length; i += 1) {
    if (y < (rects[i].top + rects[i].bottom) / 2) return i;
  }
  return rects.length;
}

/** A phone's long-press (32e): this long, without moving further than SLOP px. */
export const LONG_PRESS_MS = 450;
export const SLOP = 8;
/** A mouse lifts once it has moved this far with the grip held. */
export const MOUSE_SLOP = 4;
/** One drop is one undo, for this long (32c; the toast's own 6 s). */
export const UNDO_MS = 6000;

/** A queue row's field as text (a number or a string; anything else is empty). */
export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}
