// Types for milkdrop-presets.mjs, so its vitest suite type-checks.

export interface PresetIndexEntry {
  key: string;
  name: string;
  size: number;
  /** in one of the curated packs (MilkDrop's default list) */
  curated: boolean;
}

export interface PresetIndex {
  source: string;
  count: number;
  curated: number;
  presets: PresetIndexEntry[];
}

export function presetKey(name: string): string;
export const CURATED_PACKS: string[];
export function curatedName(name: string): string;
export function readCuratedNames(metaPath: string): Set<string> | null;
export function buildPresetIndex(opts: {
  srcDir: string;
  outDir: string;
  curated?: Set<string> | null;
}): PresetIndex;
