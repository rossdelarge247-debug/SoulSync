/**
 * Between tracks (33e: Settings → Library → DJ, and the same choice, small,
 * in Up next's head, the Mix tab and the player's "…"): how one track gives
 * way to the next, kept per browser like the player's other settings.
 *
 * - `between`: `off` (plain playback: each track plays to its end; gapless
 *   albums stay gapless) or `dj`, shown as **Auto mix** (beat-matched where
 *   both tracks are ready; Design's 302 move where they can't be: a cut on
 *   the phrase, an echo out, or straight on). There's no crossfade (Ross,
 *   27 October): a stored `smart`, and the player's old crossfade switch
 *   (`soulsync-crossfade` on), read as `off` and are written back so;
 * - `auto`: always on since 33e (it replaces 26h's "Mix automatically": Auto
 *   mix mixes by itself, and Mix now still mixes early). A stored `0` is
 *   cleared once; the field stays for the controller's manual path;
 * - `lean`: Auto's lean ("Style when Auto can choose"): `auto` keeps its own
 *   pick, `long` prefers long blends where a short one was picked, `short`
 *   the other way;
 * - `keyLock`: "Key lock in DJ now" (Design's 307), off by default. DJ now
 *   (Brief E) reads it; Auto keeps the planner's rule.
 *
 * Storage keys (code identifiers, not shown): `soulsync-between-tracks`
 * (read by static/media-player.js too), `soulsync-dj-auto`, `soulsync-dj-lean`,
 * `soulsync-dj-keylock`. The crossfade's switch (`soulsync-crossfade`) is kept at `0`.
 */
import { useSyncExternalStore } from 'react';

export type BetweenTracks = 'off' | 'dj';
export type Lean = 'auto' | 'long' | 'short';

export interface AutomixPrefs {
  between: BetweenTracks;
  auto: boolean;
  lean: Lean;
  keyLock: boolean;
  /** "Mix automatically" was off before 33e took it away: say so once (review) */
  autoGone?: boolean;
}

export const BETWEEN_KEY = 'soulsync-between-tracks';
export const AUTO_KEY = 'soulsync-dj-auto';
export const LEAN_KEY = 'soulsync-dj-lean';
export const CROSSFADE_KEY = 'soulsync-crossfade';
export const KEYLOCK_KEY = 'soulsync-dj-keylock';
/** the 33e migration ran (once per browser) */
export const AUTO_MIGRATED_KEY = 'soulsync-dj-auto-migrated';
/** its notice is still to be read: "Mix automatically is gone…" */
export const AUTO_GONE_KEY = 'soulsync-dj-auto-gone';

/** This browser's storage, or none where reading it throws (blocked site data). */
function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    /* kept for this page only */
  }
}

/**
 * No crossfade any more: Smart crossfade (`smart`) and the player's old
 * crossfade switch both become Off, written back once so the player
 * (static/media-player.js) reads the same.
 */
export function migratePrefs(): void {
  const b = read(BETWEEN_KEY);
  if (b !== null && b !== 'off' && b !== 'dj') write(BETWEEN_KEY, 'off');
  if (read(CROSSFADE_KEY) === '1') write(CROSSFADE_KEY, '0');
  // 26h's "Mix automatically" is gone (33e): Auto mix mixes by itself. Once
  // per browser; someone who had it off is told so in Up next's head
  if (read(AUTO_MIGRATED_KEY) !== '1') {
    if (read(AUTO_KEY) === '0') {
      write(AUTO_KEY, '1');
      write(AUTO_GONE_KEY, '1');
    }
    write(AUTO_MIGRATED_KEY, '1');
  }
}

export function readPrefs(): AutomixPrefs {
  migratePrefs();
  const between: BetweenTracks = read(BETWEEN_KEY) === 'dj' ? 'dj' : 'off';
  const l = read(LEAN_KEY);
  return {
    between,
    auto: read(AUTO_KEY) !== '0',
    lean: l === 'long' || l === 'short' ? l : 'auto',
    keyLock: read(KEYLOCK_KEY) === '1',
    autoGone: read(AUTO_GONE_KEY) === '1',
  };
}

const listeners = new Set<() => void>();
let snapshot: AutomixPrefs = readPrefs();

interface PlayerLike {
  renderQueue?: () => void;
}

function player(): PlayerLike | null {
  return (window as unknown as { SoulSyncPlayer?: PlayerLike }).SoulSyncPlayer ?? null;
}

export function setPrefs(patch: Partial<AutomixPrefs>): void {
  const next = { ...snapshot, ...patch };
  if (patch.between) {
    write(BETWEEN_KEY, patch.between);
    // the player's crossfade stays off, whatever is chosen
    write(CROSSFADE_KEY, '0');
  }
  if (patch.auto !== undefined) write(AUTO_KEY, patch.auto ? '1' : '0');
  if (patch.lean) write(LEAN_KEY, patch.lean);
  if (patch.keyLock !== undefined) write(KEYLOCK_KEY, patch.keyLock ? '1' : '0');
  if (patch.autoGone === false) write(AUTO_GONE_KEY, '0');
  snapshot = next;
  for (const fn of listeners) fn();
  // Up next's chips come and go with Auto mix
  player()?.renderQueue?.();
}

/** Read again (another tab, or the player's side, changed it). */
export function refreshPrefs(): void {
  const next = readPrefs();
  if (
    next.between === snapshot.between &&
    next.auto === snapshot.auto &&
    next.lean === snapshot.lean &&
    next.keyLock === snapshot.keyLock &&
    next.autoGone === snapshot.autoGone
  )
    return;
  snapshot = next;
  for (const fn of listeners) fn();
}

export function getPrefs(): AutomixPrefs {
  return snapshot;
}

export function subscribePrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function usePrefs(): AutomixPrefs {
  return useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
}
