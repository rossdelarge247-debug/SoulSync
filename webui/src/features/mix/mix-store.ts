/**
 * The Mix tab's own state (29a–29c), outside React so the shell's keys and
 * the three places it shows (the tray, the Visuals drawer, the phone sheet)
 * share it:
 *
 * - `mode`: the tray's Now playing · Mix · DJ (Brief C, 33a; 36a), remembered
 *   per browser (29a's note). The tray shows Mix only while there's a track
 *   it works for. DJ is DJ now (Brief E, step 5): the mode is reserved here
 *   (`DJ_MODE_READY`), not shown, and its key D isn't bound until it lands;
 * - `drawer`: the Visuals' 520px drawer (29b), open or not;
 * - `sheetTab`: the phone sheet's Mix · Set (29c);
 * - `from`: Suggest from Now playing or End of set (29a);
 * - `vibe`: the Vibe switch, off by default and remembered per browser
 *   (Design's 296); it only acts while the AI is on for the profile: with
 *   the AI off it reads off and says why (UX-17);
 * - `chain`: More like this, the tracks browsed from the playing one (the
 *   list follows the last; "Back to Night Ferry" empties it). A new
 *   playing track empties it too. "Mixes well with…" in any track's "…"
 *   starts it at that track and opens the tray in Mix (33a; the docked
 *   Mixes panel is retired, HANDOFF 329): `followTrack`;
 * - `wide`: "Widen the search" (29d), until the track changes.
 */
import { useSyncExternalStore } from 'react';

export type TrayMode = 'now' | 'mix' | 'dj';

/**
 * DJ now (Brief E) is step 5 of Design's build order: until it lands the
 * switch shows Now playing · Mix only, and D does nothing. Flip this, add
 * its panel to mix-host.tsx and bind D in static/media-player.js's
 * NP_LETTER_KEYS when it does.
 */
export const DJ_MODE_READY = false;
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
export const VIBE_STORAGE_KEY = 'soulsync.mix.vibe';

/** The retired Mixes panel's keys (step 3): let go of once, in each browser. */
export const RETIRED_STORAGE_KEYS = {
  local: ['soulsync.dj.mixes.follow'],
  session: ['soulsync.dj.mixes.seed'],
} as const;

let retiredForgotten = false;

/** Take the retired Mixes panel's keys out of this browser (once a page load). */
export function forgetRetiredKeys(): void {
  if (retiredForgotten) return;
  retiredForgotten = true;
  try {
    for (const key of RETIRED_STORAGE_KEYS.local) window.localStorage.removeItem(key);
    for (const key of RETIRED_STORAGE_KEYS.session) window.sessionStorage.removeItem(key);
  } catch {
    /* storage refused: nothing kept to forget */
  }
}
/** More like this keeps at most this many steps back */
const MAX_CHAIN = 20;

function readMode(): TrayMode {
  try {
    const kept = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (kept === 'mix') return 'mix';
    if (kept === 'dj') return DJ_MODE_READY ? 'dj' : 'mix';
    return 'now';
  } catch {
    return 'now';
  }
}

function readVibe(): boolean {
  try {
    return window.localStorage.getItem(VIBE_STORAGE_KEY) === 'on';
  } catch {
    return false;
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
    state = { ...state, mode: readMode(), vibe: readVibe() };
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
  if (mode === 'dj' && !DJ_MODE_READY) return;
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
  try {
    window.localStorage.setItem(VIBE_STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* for this visit only */
  }
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

/**
 * "Mixes well with…" (any track's "…", 33a): follow that track in Mix
 * ("Following Copper Sky · Back to Night Ferry"). The tray opens in Mix
 * (mix-host.tsx's `openMixWith` does the opening).
 */
export function followTrack(step: ChainStep): void {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, 'mix');
  } catch {
    /* for this visit only */
  }
  emit({ chain: [step], wide: false, mode: 'mix', sheetTab: 'mix' });
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
    window.localStorage.removeItem(VIBE_STORAGE_KEY);
  } catch {
    /* nothing kept */
  }
  loaded = false;
  retiredForgotten = false;
  state = INITIAL;
  for (const l of listeners) l();
}
