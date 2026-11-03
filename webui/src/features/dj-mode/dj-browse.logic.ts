/**
 * DJ mode's Browse (Brief F, 37f; 418, 435), the part that is only logic:
 * the chips and what they ask `GET /api/library/dj/browse` for, a row from
 * its answer, "Closest first" (the tempo gap, then the steps on the wheel),
 * and a row's step in words ("+1.6%", "same", "−0.8% · +1 on the wheel",
 * "half time · relative").
 *
 * The server filters and sorts (435: it takes half and double time in its
 * tempo filter and orders by the gap and the wheel); the words are worked
 * out here, from the BPM and key it sends, as the drop line's are.
 */
import { camelotParts } from '@/features/dj/key-colour';
import { pyRound, wheelSteps } from '@/features/dnd/dnd-model';

/** ±6%, at the same tempo or half or double time (418; core/dj/camelot.py BPM_TOLERANCE). */
export const NEAR = 0.06;
/** How many rows Browse asks for (the server's cap for "closest" is 100). */
export const BROWSE_LIMIT = 50;

export interface BrowseChips {
  near: boolean;
  keys: boolean;
  starred: boolean;
  recent: boolean;
}

/** 418: near in tempo and keys that mix on; Starred and Recently played off. */
export const DEFAULT_CHIPS: Readonly<BrowseChips> = {
  near: true,
  keys: true,
  starred: false,
  recent: false,
};

/** What Browse suits: the playing track (lane A). */
export interface BrowseRef {
  id: string | null;
  title: string;
  bpm: number | null;
  key: string | null;
}

export interface BrowseRow {
  id: string;
  title: string;
  artist: string;
  image: string | null;
  durationS: number | null;
  key: string | null;
  keyUncertain: boolean;
  bpm: number | null;
  /** its beat grid is done: Sync can work at once */
  gridReady: boolean;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** 124 → "117–131, and 62 or 248" (37f's chip). */
export function nearWords(bpm: number): string {
  const low = Math.round(bpm * (1 - NEAR));
  const high = Math.round(bpm * (1 + NEAR));
  return `${low}–${high}, and ${Math.round(bpm / 2)} or ${Math.round(bpm * 2)}`;
}

/** The keys that mix with a key, as 37f's chip names them: the key, −1, +1, the relative. */
export function mixKeys(key: string | null | undefined): string[] {
  const p = camelotParts(key);
  if (!p) return [];
  const wrap = (n: number) => ((((n - 1) % 12) + 12) % 12) + 1;
  const other = p.letter === 'A' ? 'B' : 'A';
  return [
    `${p.number}${p.letter}`,
    `${wrap(p.number - 1)}${p.letter}`,
    `${wrap(p.number + 1)}${p.letter}`,
    `${p.number}${other}`,
  ];
}

/** The query for the chips and the search: always "closest first", A left out. */
export function browseQuery(
  ref: BrowseRef,
  chips: BrowseChips,
  q: string,
  limit = BROWSE_LIMIT,
): URLSearchParams {
  const p = new URLSearchParams({ sort: 'closest', limit: String(limit) });
  if (ref.bpm && ref.bpm > 0) p.set('near', String(round1(ref.bpm)));
  const key = camelotParts(ref.key);
  if (key) p.set('near_key', `${key.number}${key.letter}`);
  if (chips.near && ref.bpm && ref.bpm > 0) p.set('tempo', 'near');
  if (chips.keys && key) p.set('key', `${key.number}${key.letter}:mix`);
  if (chips.starred) p.set('starred', '1');
  if (chips.recent) p.set('recent', '1');
  const text = q.trim();
  if (text) p.set('q', text.slice(0, 200));
  if (ref.id) p.set('exclude', ref.id);
  return p;
}

interface ApiBrowseTrack {
  id?: string | number;
  title?: string | null;
  artist_name?: string | null;
  image_url?: string | null;
  duration_ms?: number | null;
  grid_ready?: boolean;
  dj?: { bpm?: number | null; key?: string | null; key_uncertain?: boolean } | null;
}

export function rowFromApi(t: ApiBrowseTrack): BrowseRow {
  const ms = Number(t.duration_ms);
  const bpm = Number(t.dj?.bpm);
  return {
    id: String(t.id ?? ''),
    title: t.title || 'Unknown track',
    artist: t.artist_name || '',
    image: t.image_url || null,
    // the library stores milliseconds
    durationS: ms > 0 ? ms / 1000 : null,
    key: t.dj?.key ?? null,
    keyUncertain: Boolean(t.dj?.key_uncertain),
    bpm: bpm > 0 ? bpm : null,
    gridReady: Boolean(t.grid_ready),
  };
}

/** B against A as Sync plays it: the factor (1, ½ or 2) and the signed gap after it. */
export function tempoRelation(
  a: number | null | undefined,
  b: number | null | undefined,
): { how: 'same' | 'half' | 'double'; gap: number } | null {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0) || !(y > 0)) return null;
  let best: { how: 'same' | 'half' | 'double'; gap: number } = { how: 'same', gap: y / x - 1 };
  // "half": B runs at half A's tempo (it's doubled to meet A); "double" the other way
  for (const [factor, how] of [
    [2, 'half'],
    [0.5, 'double'],
  ] as const) {
    const gap = (y * factor) / x - 1;
    if (Math.abs(gap) < Math.abs(best.gap) - 1e-9) best = { how, gap };
  }
  return best;
}

/** The tempo gap's sort key (to 0.1%, as the server's) and the key's steps; unknown last. */
function closeness(ref: BrowseRef, row: BrowseRow): [number, number] {
  const rel = tempoRelation(ref.bpm, row.bpm);
  const gap = rel ? Math.round(Math.abs(rel.gap) * 1000) : Number.POSITIVE_INFINITY;
  const steps = wheelSteps(ref.key, row.key);
  return [gap, steps ?? Number.POSITIVE_INFINITY];
}

/** "Closest first" (37f): the tempo gap, then the steps on the wheel, then the title. */
export function closestFirst(ref: BrowseRef, rows: readonly BrowseRow[]): BrowseRow[] {
  return rows
    .map((row, i) => ({ row, i, c: closeness(ref, row) }))
    .sort(
      (x, y) =>
        x.c[0] - y.c[0] ||
        x.c[1] - y.c[1] ||
        x.row.title.localeCompare(y.row.title, undefined, { sensitivity: 'base' }) ||
        x.i - y.i,
    )
    .map((x) => x.row);
}

/** The tempo half of a row's step: "+1.6%", "same", "half time", "double time · +1.2%". */
export function tempoWords(a: number | null | undefined, b: number | null | undefined): string {
  const rel = tempoRelation(a, b);
  if (!rel) return '';
  const pct = pyRound(rel.gap * 100, 1);
  const signed = pct === 0 ? '' : `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
  if (rel.how === 'same') return signed || 'same';
  const name = rel.how === 'half' ? 'half time' : 'double time';
  return signed ? `${name} ${signed}` : name;
}

/** The key half: nothing for the same key (37f), "relative", "+1 on the wheel", "3 steps on the wheel". */
export function keyWords(a: string | null | undefined, b: string | null | undefined): string {
  const turns = wheelSteps(a, b);
  if (turns === null || turns === 0) return '';
  const pa = camelotParts(a)!;
  const pb = camelotParts(b)!;
  if (pa.number === pb.number) return 'relative';
  if (turns === 1) return `${(pb.number - pa.number + 12) % 12 === 1 ? '+1' : '−1'} on the wheel`;
  return `${turns} steps on the wheel`;
}

/** A row's step against A (37f's BPM · STEP column, after the BPM). */
export function stepWords(ref: BrowseRef, row: Pick<BrowseRow, 'bpm' | 'key'>): string {
  return [tempoWords(ref.bpm, row.bpm), keyWords(ref.key, row.key)].filter(Boolean).join(' · ');
}

/** The readiness after the artist (37f). */
export function readinessWords(row: BrowseRow, ref: BrowseRef): string {
  const words = row.gridReady ? 'has its grid' : 'not analysed yet · loads, then analyses';
  // "Night Ferry (Dub)" beside Night Ferry: a version of A
  const base = ref.title.trim().toLowerCase();
  const version =
    base && row.title.toLowerCase().startsWith(base) && row.title.length > base.length
      ? ' · a version of A'
      : '';
  return words + version;
}

/** "38 tracks fit · the smallest tempo and key step first" (37f). */
export function countLine(total: number, searching: boolean): string {
  if (total === 0) return searching ? 'Nothing matches' : 'Nothing fits these chips';
  const n = `${total.toLocaleString('en-GB')} ${total === 1 ? 'track fits' : 'tracks fit'}`;
  return `${n} · the smallest tempo and key step first`;
}

/** 288 → "4:48" */
export function lengthWords(seconds: number | null): string {
  if (seconds === null || !(seconds > 0)) return '–';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The row as a drag item lane B loads (laneTrackFromItem's shape). */
export function rowAsLaneTrack(row: BrowseRow) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    image: row.image,
    duration: row.durationS,
    key: row.key,
    bpm: row.bpm,
  };
}
