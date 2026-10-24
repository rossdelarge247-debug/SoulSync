/**
 * "Mixes well with"'s one panel (17a, 17b, 17d; HANDOFF 152, 164). It lives
 * in the shell (`MixesPanelHost` in `routes/__root.tsx`), so it stays open
 * while you move between pages and play. Any page's "…" opens it with
 * `openMixes(seed)`; "Follow what's playing" (on by default, remembered per
 * browser) re-seeds it from the player.
 */
import { useSyncExternalStore } from 'react';

export interface MixesSeed {
  /** the library track's id */
  id: string;
  title: string;
}

export interface MixesState {
  /** the track it's matching against; null while closed */
  seed: MixesSeed | null;
  /** re-seed from the player when the track changes */
  follow: boolean;
  /** the tempo window in percent: 6, or 10 after "Widen to 10%" */
  within: number;
}

export const FOLLOW_STORAGE_KEY = 'soulsync.dj.mixes.follow';
/** The open seed, per tab: a link that loads a whole page keeps the panel open. */
export const SEED_STORAGE_KEY = 'soulsync.dj.mixes.seed';
export const DEFAULT_WITHIN = 6;
export const WIDE_WITHIN = 10;

function readFollow(): boolean {
  try {
    return window.localStorage.getItem(FOLLOW_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function readSeed(): MixesSeed | null {
  try {
    const raw = window.sessionStorage.getItem(SEED_STORAGE_KEY);
    if (!raw) return null;
    const seed = JSON.parse(raw) as Partial<MixesSeed>;
    return seed && typeof seed.id === 'string' && seed.id
      ? { id: seed.id, title: typeof seed.title === 'string' ? seed.title : '' }
      : null;
  } catch {
    return null;
  }
}

function writeSeed(seed: MixesSeed | null): void {
  try {
    if (seed) window.sessionStorage.setItem(SEED_STORAGE_KEY, JSON.stringify(seed));
    else window.sessionStorage.removeItem(SEED_STORAGE_KEY);
  } catch {
    /* private window: the panel closes on a full page load */
  }
}

let state: MixesState = { seed: null, follow: true, within: DEFAULT_WITHIN };
let loaded = false;
const listeners = new Set<() => void>();

function emit(next: MixesState): void {
  state = next;
  for (const listener of listeners) listener();
}

function current(): MixesState {
  if (!loaded && typeof window !== 'undefined') {
    loaded = true;
    state = { ...state, follow: readFollow(), seed: state.seed ?? readSeed() };
  }
  return state;
}

export function getMixesState(): MixesState {
  return current();
}

/** Open the panel on a track (or move it to that track). */
export function openMixes(seed: MixesSeed): void {
  const now = current();
  if (now.seed?.id === seed.id && now.seed.title === seed.title) return;
  const next = { id: String(seed.id), title: seed.title };
  writeSeed(next);
  emit({ ...now, seed: next, within: DEFAULT_WITHIN });
}

export function closeMixes(): void {
  const now = current();
  writeSeed(null);
  if (now.seed) emit({ ...now, seed: null, within: DEFAULT_WITHIN });
}

export function setMixesFollow(follow: boolean): void {
  const now = current();
  try {
    window.localStorage.setItem(FOLLOW_STORAGE_KEY, follow ? 'on' : 'off');
  } catch {
    /* private window: on for this visit only */
  }
  if (now.follow !== follow) emit({ ...now, follow });
}

/** "Widen to 10%" (17b, nothing matches): until the seed changes. */
export function setMixesWithin(within: number): void {
  const now = current();
  if (now.within !== within) emit({ ...now, within });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMixes(): MixesState {
  return useSyncExternalStore(subscribe, current, current);
}

/** Tests: back to closed, following, nothing remembered. */
export function resetMixesForTests(): void {
  writeSeed(null);
  loaded = false;
  state = { seed: null, follow: true, within: DEFAULT_WITHIN };
  for (const listener of listeners) listener();
}
