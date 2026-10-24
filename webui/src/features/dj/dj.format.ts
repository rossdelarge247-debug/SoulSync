/** Words for the library's DJ data: BPM, Camelot keys, energy, how two tracks mix. */
import type { BpmRelation, DjInfo, KeyRelation } from './dj.api';

/** "124", "123.5": whole when it's whole, one decimal otherwise. */
export function bpmNumber(bpm: number): string {
  const tenth = Math.round(bpm * 10) / 10;
  return Number.isInteger(tenth) ? String(tenth) : tenth.toFixed(1);
}

export function bpmWords(bpm: number | null | undefined): string {
  return bpm ? `${bpmNumber(bpm)} BPM` : '';
}

const SOURCE_WORDS: Record<string, string> = {
  tag: "from the file's tag",
  enrichment: 'from the metadata source',
  analysis: 'worked out by SYNCHRO.S',
};

/** The key's title: "A minor (Am), worked out by SYNCHRO.S, key uncertain". */
export function keyTitle(
  dj: Pick<DjInfo, 'key_long' | 'key_name' | 'key_source' | 'key_uncertain'>,
): string {
  if (!dj.key_long) return '';
  const parts = [`${dj.key_long} (${dj.key_name})`];
  if (dj.key_source && SOURCE_WORDS[dj.key_source]) parts.push(SOURCE_WORDS[dj.key_source]);
  if (dj.key_uncertain) parts.push('key uncertain');
  return parts.join(', ');
}

export function bpmTitle(dj: Pick<DjInfo, 'bpm' | 'bpm_source'>): string {
  if (!dj.bpm) return '';
  const source = dj.bpm_source ? SOURCE_WORDS[dj.bpm_source] : '';
  return [bpmWords(dj.bpm), source].filter(Boolean).join(', ');
}

/** "Same key", "Relative minor", "+1 on the wheel", "−1 on the wheel". */
export function keyRelationWords(relation: KeyRelation, matchKey: string | null): string {
  switch (relation) {
    case 'same':
      return 'Same key';
    case 'relative':
      return matchKey?.endsWith('A') ? 'Relative minor' : 'Relative major';
    case 'up':
      return '+1 on the wheel';
    case 'down':
      return '−1 on the wheel';
  }
}

/** "same BPM", "+1.6%", "−2%", "half time", "double time". */
export function bpmRelationWords(relation: BpmRelation, diffPct: number): string {
  if (relation === 'half') return 'half time';
  if (relation === 'double') return 'double time';
  if (Math.abs(diffPct) < 0.05) return 'same BPM';
  const n = Math.abs(diffPct);
  const shown = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return `${diffPct > 0 ? '+' : '−'}${shown}%`;
}

export function energyWords(energy: number | null | undefined): string {
  return energy ? `Energy ${energy}` : '';
}

/** Every Camelot key, wheel order, with the tag form: for the key filter. */
const WHEEL: [string, string][] = [
  ['1A', 'Abm'],
  ['1B', 'B'],
  ['2A', 'Ebm'],
  ['2B', 'F#'],
  ['3A', 'Bbm'],
  ['3B', 'Db'],
  ['4A', 'Fm'],
  ['4B', 'Ab'],
  ['5A', 'Cm'],
  ['5B', 'Eb'],
  ['6A', 'Gm'],
  ['6B', 'Bb'],
  ['7A', 'Dm'],
  ['7B', 'F'],
  ['8A', 'Am'],
  ['8B', 'C'],
  ['9A', 'Em'],
  ['9B', 'G'],
  ['10A', 'Bm'],
  ['10B', 'D'],
  ['11A', 'F#m'],
  ['11B', 'A'],
  ['12A', 'C#m'],
  ['12B', 'E'],
];

export const CAMELOT_KEYS = WHEEL.map(([code, name]) => ({ code, name }));

export function isCamelot(value: string): boolean {
  return WHEEL.some(([code]) => code === value);
}

/** "120-128" (the URL's form) -> {min, max}; either side may be empty. */
export function parseBpmRange(raw: string): { min: number | null; max: number | null } {
  const match = /^\s*(\d{2,3}(?:\.\d)?)?\s*-\s*(\d{2,3}(?:\.\d)?)?\s*$/.exec(raw || '');
  if (!match) return { min: null, max: null };
  let min = match[1] ? Number(match[1]) : null;
  let max = match[2] ? Number(match[2]) : null;
  if (min !== null && max !== null && min > max) [min, max] = [max, min];
  return { min, max };
}

export function formatBpmRange(min: number | null, max: number | null): string {
  if (min === null && max === null) return '';
  return `${min ?? ''}-${max ?? ''}`;
}

type AnalysisStatus = {
  counts: { tracks: number; analyzed: number; pending: number };
  job: {
    status: string;
    total: number;
    done: number;
    waiting?: string | null;
    recent?: boolean;
  } | null;
  settings: { analyze: boolean };
  held: boolean;
};

const WAITING_WORDS: Record<string, string> = {
  download: 'waiting while a download runs',
  import: 'waiting while an import runs',
  drive_away: "waiting for your library's drive",
  drive_move: 'waiting while your music moves to another drive',
  tag_write: 'waiting while tags are written',
};

/** Tracks the analysis has been through (BPM, key and energy, or why not): the bar's fill. */
export function analysisProgress(status: AnalysisStatus): { done: number; total: number } | null {
  const { tracks, pending } = status.counts;
  if (!tracks || !pending) return null;
  return { done: Math.max(0, tracks - pending), total: tracks };
}

/**
 * Tracks' analysis line (153), beside its 120px bar: "BPM, key and energy:
 * 3,328 of 3,740 tracks done · waiting while a download runs" (Stop follows
 * it for admins); finished, "All 3,740 tracks have BPM, key and energy" for a
 * day after the sweep, then nothing.
 */
export function analysisLine(status: AnalysisStatus): string {
  const { counts, job } = status;
  const n = (v: number) => v.toLocaleString();
  if (!counts.tracks) return '';
  const done = `BPM, key and energy: ${n(counts.tracks - counts.pending)} of ${n(counts.tracks)} tracks done`;
  if (job?.status === 'running') {
    const waiting = job.waiting ? WAITING_WORDS[job.waiting] : '';
    return waiting ? `${done} · ${waiting}` : done;
  }
  if (!counts.pending) {
    // finished: said for a day after the last sweep, then the line goes
    if (job && !job.recent) return '';
    if (counts.analyzed >= counts.tracks)
      return `All ${n(counts.tracks)} tracks have BPM, key and energy`;
    const rest = counts.tracks - counts.analyzed;
    return `${n(counts.analyzed)} of ${n(counts.tracks)} tracks have BPM, key and energy · ${n(rest)} couldn't be analysed`;
  }
  if (!status.settings.analyze) return `${done} · working them out is off in Settings → Library`;
  if (status.held) return `${done} · stopped until you start it again`;
  return `${done} · the rest are worked out in the background`;
}
