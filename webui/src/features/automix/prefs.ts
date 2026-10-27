/**
 * Player settings → Between tracks (26h): how one track gives way to the
 * next, kept per browser like the player's other settings.
 *
 * - `between`: `off` (plain playback: each track plays to its end; gapless
 *   albums stay gapless) or `dj`, shown as **Auto mix** (beat-matched, on
 *   the phrase, in each pair's style; a pair that can't be beat-matched
 *   echoes out, cuts on the bar or plays on). There's no crossfade (Ross,
 *   27 October): a stored `smart`, and the player's old crossfade switch
 *   (`soulsync-crossfade` on), read as `off` and are written back so;
 * - `auto`: Mix automatically. Off, DJ mix waits for Mix now and tracks
 *   play to their end;
 * - `lean`: Auto's lean ("Style when Auto can choose"): `auto` keeps its own
 *   pick, `long` prefers long blends where a short one was picked, `short`
 *   the other way.
 *
 * Storage keys (code identifiers, not shown): `soulsync-between-tracks`
 * (read by static/media-player.js too), `soulsync-dj-auto`, `soulsync-dj-lean`.
 * The crossfade's switch (`soulsync-crossfade`) is kept at `0`.
 */
import { useSyncExternalStore } from 'react';

export type BetweenTracks = 'off' | 'dj';
export type Lean = 'auto' | 'long' | 'short';

export interface AutomixPrefs {
  between: BetweenTracks;
  auto: boolean;
  lean: Lean;
}

export const BETWEEN_KEY = 'soulsync-between-tracks';
export const AUTO_KEY = 'soulsync-dj-auto';
export const LEAN_KEY = 'soulsync-dj-lean';
export const CROSSFADE_KEY = 'soulsync-crossfade';

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
}

export function readPrefs(): AutomixPrefs {
  migratePrefs();
  const between: BetweenTracks = read(BETWEEN_KEY) === 'dj' ? 'dj' : 'off';
  const l = read(LEAN_KEY);
  return {
    between,
    auto: read(AUTO_KEY) !== '0',
    lean: l === 'long' || l === 'short' ? l : 'auto',
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
  snapshot = next;
  for (const fn of listeners) fn();
  // Up next's chips come and go with DJ mix
  player()?.renderQueue?.();
}

/** Read again (another tab, or the player's side, changed it). */
export function refreshPrefs(): void {
  const next = readPrefs();
  if (
    next.between === snapshot.between &&
    next.auto === snapshot.auto &&
    next.lean === snapshot.lean
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
