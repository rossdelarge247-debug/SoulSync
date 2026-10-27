/**
 * Player settings → Between tracks (26h): how one track gives way to the
 * next, kept per browser like the player's other settings.
 *
 * - `between`: `off` (each track plays to its end; gapless albums stay
 *   gapless), `smart` (the player's crossfade, smarter where the tracks are
 *   analysed: on a downbeat, past the silence, at even loudness) or `dj`
 *   (auto-mix: beat-matched, on the phrase, in each pair's style);
 * - `auto`: Mix automatically. Off, DJ mix waits for Mix now and tracks
 *   play to their end;
 * - `lean`: Auto's lean ("Style when Auto can choose"): `auto` keeps its own
 *   pick, `long` prefers long blends where a short one was picked, `short`
 *   the other way.
 *
 * Storage keys (code identifiers, not shown): `soulsync-between-tracks`
 * (read by static/media-player.js too), `soulsync-dj-auto`, `soulsync-dj-lean`.
 * Before this setting the crossfade's own switch (`soulsync-crossfade`)
 * said which, so with no key it's read from there; Smart crossfade keeps
 * that switch on, so the "…" menu's Crossfade and this setting agree.
 */
import { useSyncExternalStore } from 'react';

export type BetweenTracks = 'off' | 'smart' | 'dj';
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

export function readPrefs(): AutomixPrefs {
  const b = read(BETWEEN_KEY);
  const between: BetweenTracks =
    b === 'off' || b === 'smart' || b === 'dj' ? b : read(CROSSFADE_KEY) === '1' ? 'smart' : 'off';
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
  setCrossfade?: (on: boolean) => void;
  renderQueue?: () => void;
}

function player(): PlayerLike | null {
  return (window as unknown as { SoulSyncPlayer?: PlayerLike }).SoulSyncPlayer ?? null;
}

export function setPrefs(patch: Partial<AutomixPrefs>): void {
  const next = { ...snapshot, ...patch };
  if (patch.between) {
    write(BETWEEN_KEY, patch.between);
    // the player's crossfade is Smart crossfade
    const p = player();
    if (p?.setCrossfade) p.setCrossfade(patch.between === 'smart');
    else write(CROSSFADE_KEY, patch.between === 'smart' ? '1' : '0');
    // setCrossfade(false) leaves DJ mix's key alone; say it again
    write(BETWEEN_KEY, patch.between);
  }
  if (patch.auto !== undefined) write(AUTO_KEY, patch.auto ? '1' : '0');
  if (patch.lean) write(LEAN_KEY, patch.lean);
  snapshot = next;
  for (const fn of listeners) fn();
  // Up next's chips come and go with DJ mix
  player()?.renderQueue?.();
}

/** Read again (the "…" menu's Crossfade changed it from the player's side). */
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
