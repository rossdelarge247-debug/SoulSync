/**
 * The Visuals overlay's families and what the panel, the stage and the credit
 * read (boards 10a–10f). AVS isn't a family yet (Ross, 23 October: a later
 * spike, user-supplied presets only).
 */

export type Family = 'synchros' | 'milkdrop' | 'classic';

export const FAMILIES: readonly Family[] = ['synchros', 'milkdrop', 'classic'];

export const FAMILY_NAMES: Record<Family, string> = {
  synchros: 'SYNCHRO.S',
  milkdrop: 'MilkDrop',
  classic: 'Classic',
};

/** MilkDrop's resolution scale (10a's foot). */
export type Quality = 'full' | 'half' | 'quarter';
export const QUALITIES: readonly Quality[] = ['full', 'half', 'quarter'];
export const QUALITY_NAMES: Record<Quality, string> = {
  full: 'Full',
  half: 'Half',
  quarter: 'Quarter',
};

/**
 * Off · Every 30 s · Every 2 min · On track change (10a). Shared with the
 * SYNCHRO.S visuals' own setting (`soulsync-npv2-viz-autocycle`), which also
 * knew 60 and 300 seconds; those still work when they're what's saved.
 */
export type Autocycle = 'off' | '30' | '60' | '120' | '300' | 'track';

export type ClassicMode = 'bars' | 'scope';
export type ScopeDraw = 'lines' | 'dots' | 'solid';

/** Show: All, Favourites, Recent, and Yours once an own-presets folder is set (18a). */
export type ShowFilter = 'all' | 'favourites' | 'recent' | 'yours';

/** Which bundled presets MilkDrop lists: the curated packs, or every preset (101). */
export type PresetSet = 'curated' | 'all';

/** What moved the visual, for the credit's last words (10c). */
export type Moved =
  | 'picked'
  | 'next'
  | 'previous'
  | 'random'
  | 'every'
  | 'track'
  | 'opened'
  | 'retry'
  | 'back';

export interface PresetEntry {
  key: string;
  /** The title, after "Author - ". */
  name: string;
  author: string | null;
  full_name: string;
  size: number;
  source: 'bundled' | 'own';
  /** a bundled preset in one of the curated packs */
  curated?: boolean;
}

export interface PresetAuthor {
  name: string;
  key: string;
  count: number;
}

/** What the server says about the admin's own-presets folder (18b). */
export interface OwnFolderState {
  configured: boolean;
  count: number;
  /** "missing" (not there inside the container) or "unreadable" */
  problem: string | null;
  truncated?: boolean;
  /** .milk files left out for being over 512 KB */
  too_big?: number;
  /** when the folder was read, seconds since the epoch */
  read_at?: number | null;
}

export interface PresetIndex {
  family: 'milkdrop';
  set?: PresetSet;
  total: number;
  count: number;
  presets: PresetEntry[];
  /** favourites and Recent's presets the curated set leaves out */
  kept?: PresetEntry[];
  authors: PresetAuthor[];
  own: OwnFolderState;
  bundled?: number;
  curated?: number;
  /** the bundled presets outside the curated packs ("Every preset" adds them) */
  uncurated?: number;
}

export interface SynchrosTheme {
  id: string;
  name: string;
  blurb: string;
}

/** The legacy engine's hooks (static/media-player-v2.js `window.npV2`). */
export interface NpV2 {
  themeList?: () => SynchrosTheme[];
  getTheme?: () => string;
  setTheme?: (id: string, opts?: { silent?: boolean }) => void;
  cycleTheme?: (skipOff?: boolean) => void;
  prevTheme?: () => void;
  getVizAutocycle?: () => string;
  setVizAutocycle?: (v: string) => void;
  getReduceMotion?: () => boolean;
  visualsOpen?: () => boolean;
  openVisuals?: () => void;
  closeVisuals?: () => void;
  wakeVisuals?: () => void;
}
