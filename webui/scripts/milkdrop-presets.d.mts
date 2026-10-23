// Types for milkdrop-presets.mjs, so its vitest suite type-checks.

export interface PresetIndexEntry {
  key: string;
  name: string;
  size: number;
}

export interface PresetIndex {
  source: string;
  count: number;
  presets: PresetIndexEntry[];
}

export function presetKey(name: string): string;
export function buildPresetIndex(opts: { srcDir: string; outDir: string }): PresetIndex;
