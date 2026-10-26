/**
 * The Mix tab's own state (29a–29c), outside React so the shell's keys and
 * the three places it shows (the tray, the Visuals drawer, the phone sheet)
 * share it:
 *
 * - `mode`: the tray's Now playing · Mix, remembered per browser (29a's
 *   note). The tray shows Mix only while there's a track it works for;
 * - `drawer`: the Visuals' 520px drawer (29b), open or not;
 * - `sheetTab`: the phone sheet's Mix · Set (29c);
 * - `from`: Suggest from Now playing or End of set (29a);
 * - `vibe`: the Vibe switch, off by default and not remembered: each visit
 *   starts with code's order, so nothing spends AI usage unasked;
 * - `chain`: More like this, the tracks browsed from the playing one (the
 *   list follows the last; "Back to Night Ferry" empties it). A new
 *   playing track empties it too;
 * - `wide`: "Widen the search" (29d), until the track changes.
 */
import { useSyncExternalStore } from 'react';

export type TrayMode = 'now' | 'mix';
export type SheetTab = 'mix' | 'set';
export type SuggestFrom = 'now' | 'end';

export interface ChainStep {
  id: string;
  title: string;
}

export interface MixState {
  mode: TrayMode;
  drawer: boolean;
  sheetTab: SheetTab;
  from: SuggestFrom;
  vibe: boolean;
  chain: ChainStep[];
  wide: boolean;
}

export const MODE_STORAGE_KEY = 'soulsync.player.tray-mode';
/** More like this keeps at most this many steps back */
const MAX_CHAIN = 20;

function readMode(): TrayMode {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === 'mix' ? 'mix' : 'now';
  } catch {
    return 'now';
  }
}

const INITIAL: MixState = {
  mode: 'now',
  drawer: false,
  sheetTab: 'mix',
  from: 'now',
  vibe: false,
  chain: [],
  wide: false,
};

let state: MixState = INITIAL;
let loaded = false;
const listeners = new Set<() => void>();

function current(): MixState {
  if (!loaded && typeof window !== 'undefined') {
    loaded = true;
    state = { ...state, mode: readMode() };
  }
  return state;
}

function emit(patch: Partial<MixState>): void {
  const now = current();
  const next = { ...now, ...patch };
  if (Object.keys(patch).every((k) => now[k as keyof MixState] === next[k as keyof MixState]))
    return;
  state = next;
  for (const l of listeners) l();
}

export function getMixState(): MixState {
  return current();
}

export function setTrayMode(mode: TrayMode): void {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* a private window: for this visit only */
  }
  emit({ mode });
}

export function setDrawer(open: boolean): void {
  emit({ drawer: open });
}

export function setSheetTab(tab: SheetTab): void {
  emit({ sheetTab: tab });
}

export function setSuggestFrom(from: SuggestFrom): void {
  emit({ from, chain: [], wide: false });
}

export function setVibe(on: boolean): void {
  emit({ vibe: on });
}

export function setWide(wide: boolean): void {
  emit({ wide });
}

/** More like this: follow that track's own matches. */
export function moreLikeThis(step: ChainStep): void {
  const chain = current().chain;
  if (chain[chain.length - 1]?.id === step.id) return;
  emit({ chain: [...chain, step].slice(-MAX_CHAIN), wide: false });
}

/** "Back to Night Ferry": the playing track's matches again. */
export function backToPlaying(): void {
  emit({ chain: [], wide: false });
}

/** The playing track changed: More like this and Widen start over. */
export function trackChanged(): void {
  const now = current();
  if (now.chain.length || now.wide) emit({ chain: [], wide: false });
}

export function subscribeMix(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMixState(): MixState {
  return useSyncExternalStore(subscribeMix, current, current);
}

/** Tests: back to the start, nothing remembered. */
export function resetMixForTests(): void {
  try {
    window.localStorage.removeItem(MODE_STORAGE_KEY);
  } catch {
    /* nothing kept */
  }
  loaded = false;
  state = INITIAL;
  for (const l of listeners) l();
}
