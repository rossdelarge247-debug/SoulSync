/**
 * What the Visuals remember per browser (HANDOFF "Visuals, what's remembered
 * where"): the family, MilkDrop's preset, Recent, Quality, Blend, "Every
 * preset", Classic's settings, Data's (30a, 30d, 30h) and how often the key
 * hints have shown. Auto-cycle is the
 * SYNCHRO.S visuals' own key, shared. Favourites are per profile, on the
 * server. "Play visuals this time" lasts the session.
 *
 * Storage can be missing or throw (private windows, blocked site data): every
 * read falls back and every write is best effort.
 */

import type { DataColour, DataNumbers } from './data-viz';
import type { ClassicMode, Family, Quality, ScopeDraw } from './visuals.types';

import { normaliseQuality, RECENT_MAX } from './visuals.logic';

const PREFIX = 'soulsync-visuals-';
/** the SYNCHRO.S visuals' key (static/media-player-v2.js npv2GetG) */
export const AUTOCYCLE_KEY = 'soulsync-npv2-viz-autocycle';
const PLAY_ANYWAY_KEY = 'soulsync-visuals-play-anyway';
const FAILED_KEY = 'soulsync-visuals-failed';

export interface VisualsPrefs {
  family: Family;
  preset: string | null;
  recent: string[];
  quality: Quality;
  blend: boolean;
  /** MilkDrop lists every preset, not only the curated packs (101) */
  everyPreset: boolean;
  classicMode: ClassicMode;
  classicPeaks: boolean;
  scopeDraw: ScopeDraw;
  hints: number;
  /** Data (30a): hex or decimal, the bits, the texture, the colour (30h) */
  dataNumbers: DataNumbers;
  dataBits: boolean;
  dataTexture: boolean;
  dataColour: DataColour;
  /** "Data underneath" (30d), per visual, off by default */
  dataUnderBars: boolean;
  dataUnderScope: boolean;
}

export const DEFAULT_PREFS: VisualsPrefs = {
  family: 'synchros',
  preset: null,
  recent: [],
  quality: 'full',
  blend: true,
  everyPreset: false,
  classicMode: 'bars',
  classicPeaks: true,
  scopeDraw: 'lines',
  hints: 0,
  dataNumbers: 'hex',
  dataBits: true,
  dataTexture: true,
  dataColour: 'accent',
  dataUnderBars: false,
  dataUnderScope: false,
};

function local(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function read(store: Storage | null, key: string): string | null {
  try {
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}

function write(store: Storage | null, key: string, value: string | null): void {
  try {
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // best effort
  }
}

export function loadPrefs(): VisualsPrefs {
  const s = local();
  const get = (k: string) => read(s, PREFIX + k);
  const family = get('family');
  let recent: string[] = [];
  try {
    const raw = JSON.parse(get('recent') || '[]');
    if (Array.isArray(raw))
      recent = raw.filter((k): k is string => typeof k === 'string').slice(0, RECENT_MAX);
  } catch {
    recent = [];
  }
  const mode = get('classic-mode');
  const draw = get('scope-draw');
  const hints = Number(get('hints'));
  return {
    family:
      family === 'milkdrop' || family === 'classic' || family === 'data' ? family : 'synchros',
    preset: get('preset') || null,
    recent,
    quality: normaliseQuality(get('quality')),
    blend: get('blend') !== '0',
    everyPreset: get('every-preset') === '1',
    classicMode: mode === 'scope' ? 'scope' : 'bars',
    classicPeaks: get('classic-peaks') !== '0',
    scopeDraw: draw === 'dots' || draw === 'solid' ? draw : 'lines',
    hints: Number.isFinite(hints) && hints > 0 ? Math.floor(hints) : 0,
    dataNumbers: get('data-numbers') === 'dec' ? 'dec' : 'hex',
    dataBits: get('data-bits') !== '0',
    dataTexture: get('data-texture') !== '0',
    dataColour: (['phosphor', 'white'] as const).find((c) => c === get('data-colour')) ?? 'accent',
    dataUnderBars: get('data-under-bars') === '1',
    dataUnderScope: get('data-under-scope') === '1',
  };
}

export function savePrefs(p: Partial<VisualsPrefs>): void {
  const s = local();
  const set = (k: string, v: string | null) => write(s, PREFIX + k, v);
  if (p.family !== undefined) set('family', p.family);
  if (p.preset !== undefined) set('preset', p.preset);
  if (p.recent !== undefined) set('recent', JSON.stringify(p.recent.slice(0, RECENT_MAX)));
  if (p.quality !== undefined) set('quality', p.quality);
  if (p.blend !== undefined) set('blend', p.blend ? '1' : '0');
  if (p.everyPreset !== undefined) set('every-preset', p.everyPreset ? '1' : null);
  if (p.classicMode !== undefined) set('classic-mode', p.classicMode);
  if (p.classicPeaks !== undefined) set('classic-peaks', p.classicPeaks ? '1' : '0');
  if (p.scopeDraw !== undefined) set('scope-draw', p.scopeDraw);
  if (p.hints !== undefined) set('hints', String(p.hints));
  if (p.dataNumbers !== undefined) set('data-numbers', p.dataNumbers);
  if (p.dataBits !== undefined) set('data-bits', p.dataBits ? '1' : '0');
  if (p.dataTexture !== undefined) set('data-texture', p.dataTexture ? '1' : '0');
  if (p.dataColour !== undefined) set('data-colour', p.dataColour);
  if (p.dataUnderBars !== undefined) set('data-under-bars', p.dataUnderBars ? '1' : null);
  if (p.dataUnderScope !== undefined) set('data-under-scope', p.dataUnderScope ? '1' : null);
}

export function loadAutocycle(): string {
  return read(local(), AUTOCYCLE_KEY) || 'off';
}

export function playAnyway(): boolean {
  return read(session(), PLAY_ANYWAY_KEY) === '1';
}

export function setPlayAnyway(on: boolean): void {
  write(session(), PLAY_ANYWAY_KEY, on ? '1' : null);
}

/** Presets that wouldn't load, this session: auto-cycle skips them. */
export function loadFailed(): string[] {
  try {
    const raw = JSON.parse(read(session(), FAILED_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function saveFailed(keys: readonly string[]): void {
  write(session(), FAILED_KEY, JSON.stringify(keys.slice(-200)));
}
