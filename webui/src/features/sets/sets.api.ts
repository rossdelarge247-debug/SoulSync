/**
 * Library → Sets (api/sets.py, CONTRACTS.md "Sets"): saved sets, the draft's
 * view (steps between tracks and the meta line), Swap, famous mixes from
 * MixesDB, MusicBrainz and Discogs, a pasted tracklist, and Wanted.
 */
import { queryOptions } from '@tanstack/react-query';

import type { DjTrack } from '@/features/dj/dj.api';

import { apiClient } from '@/app/api-client';

export type SetKind = 'hand' | 'famous' | 'suggested';
export type RowState = 'owned' | 'version' | 'missing' | 'id';
export type SourceName = 'mixesdb' | 'musicbrainz' | 'discogs';
export type SetSource = SourceName | 'paste';

/** One row of a set as it's kept (in the browser or on the server). */
export interface SetRow {
  track_id: string | null;
  artist: string | null;
  title: string | null;
  /** the mix's own time, "27:02" */
  at?: string | null;
  state: RowState;
  /** Another version rows: keep yours (default) or want the mix's cut */
  want?: 'yours' | 'wanted';
  /** the cut the mix plays ("Dub") */
  version?: string | null;
  locked?: boolean;
  note?: string | null;
  /** the step after this row: its transition style and length (26a; auto by default) */
  transition?: Transition | null;
  mbid?: string | null;
  raw?: string | null;
}

/** 26a's styles; "auto" lets auto-mix pick (not built yet, so it only says Auto). */
export const TRANSITION_STYLES = [
  'auto',
  'long_blend',
  'short_blend',
  'bass_swap',
  'cut',
  'echo_out',
  'filter_sweep',
  'drop_swap',
] as const;
export type TransitionStyle = (typeof TRANSITION_STYLES)[number];
/** 26a's lengths, in bars */
export const TRANSITION_BARS = [2, 4, 8, 16, 32] as const;

/** A step's transition as a mix set keeps it (the chip, 26i). */
export interface Transition {
  style: TransitionStyle;
  bars: number | null;
}

export type StepKind = 'smooth' | 'jump' | 'unknown';

export interface Step {
  kind: StepKind;
  reason: string;
  steps: number | null;
  bpm_diff: number | null;
}

export interface ViewRow extends SetRow {
  track: DjTrack | null;
  /** the set holds this track but it can't be reached now (it plays again when its file is back) */
  unreachable?: boolean;
  /** 28e: a File missing row's title and values, when the library still has its row */
  gone_track?: Omit<DjTrack, 'file_path'> | null;
}

export interface SetSummary {
  tracks: number;
  seconds: number;
  bpm_min: number | null;
  bpm_max: number | null;
  smooth: number;
  jumps: number;
  unknown: number;
  locked: number;
}

export interface SetView {
  rows: ViewRow[];
  /** the step after each row to the next playing one (null: none) */
  steps: (Step | null)[];
  summary: SetSummary;
}

export interface MixMeta {
  title?: string;
  artist?: string;
  date?: string;
  edited?: string;
  kind?: string;
  seconds?: number;
  lines?: number;
}

export interface SavedSet {
  id: number;
  name: string;
  kind: SetKind;
  status: string;
  shape: string | null;
  source: SetSource | null;
  source_id: string | null;
  source_url: string | null;
  source_meta: MixMeta;
  playlist_id: number | null;
  /** the playlist stopped following the set: edited elsewhere, or deleted */
  playlist_state: 'changed' | 'deleted' | null;
  /** the last autosave applied */
  revision: number;
  created_at: number | null;
  updated_at: number | null;
}

export interface SetListItem extends SavedSet {
  tracks: number;
  lines: number;
  owned: number;
  seconds: number;
  energy: (number | null)[];
}

export interface MatchRow {
  artist: string;
  title: string;
  at: string;
  mbid: string | null;
  raw?: string | null;
  note: string;
  n?: number | null;
  state: RowState;
  track: DjTrack | null;
  confidence: number;
  matched_by: 'musicbrainz' | 'title' | null;
  have?: string;
  want_version?: string;
}

export interface MatchCounts {
  owned: number;
  version: number;
  missing: number;
  ids: number;
  of: number;
}

export interface UnreadLine {
  n: number;
  raw: string;
  at: string;
  why: string;
}

export interface SourceState {
  state: 'ok' | 'down' | 'off' | 'limited';
  why?: 'token' | 'terms' | 'rate_limited' | 'profile' | 'busy';
}

export type SourceStates = Record<SourceName, SourceState>;

export interface MixResult {
  source: SourceName;
  id: string;
  title: string;
  artist?: string;
  date?: string | null;
  edited?: string | null;
  tracks?: number | null;
  kind: 'mix' | 'cd';
}

export interface SavedResult {
  source: 'saved';
  id: string;
  title: string;
  from: SetSource | null;
  tracks: number;
  source_id: string | null;
}

export interface SearchAnswer {
  query: string;
  results: MixResult[];
  saved: SavedResult[];
  sources: SourceStates;
}

export interface OpenedMix {
  mix: {
    source: SourceName;
    id: string;
    title: string;
    artist?: string;
    date?: string | null;
    edited?: string | null;
    url?: string | null;
    kind?: string;
    seconds?: number | null;
  };
  rows: MatchRow[];
  counts: MatchCounts;
}

export interface PasteAnswer {
  rows: MatchRow[];
  unread: UnreadLine[];
  counts: MatchCounts;
  lines: number;
  cut: boolean;
}

export interface SwapAlternative {
  track: DjTrack;
  into: Step | null;
  out_of: Step | null;
  jumps: number;
}

export interface SwapAnswer {
  alternatives: SwapAlternative[];
  total: number;
  before: DjTrack | null;
  after: DjTrack | null;
}

/** A source didn't answer (22r): which one, for the words. */
export class SourceDownError extends Error {
  source: SourceName;

  constructor(source: SourceName, message: string) {
    super(message);
    this.source = source;
  }
}

export const SETS_QUERY_KEY = ['sets'] as const;

async function call<T>(promise: Promise<Response>): Promise<T> {
  const response = await promise;
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    down?: SourceName;
  } & T;
  if (!response.ok || payload.success === false) {
    if (payload.down) throw new SourceDownError(payload.down, payload.error || '');
    throw new Error(payload.error || "That didn't work. Try again in a moment.");
  }
  return payload;
}

const opts = { throwHttpErrors: false } as const;

export function setsListQueryOptions(profileId: number) {
  return queryOptions({
    queryKey: [...SETS_QUERY_KEY, 'list', profileId] as const,
    queryFn: () => call<{ sets: SetListItem[] }>(apiClient.get('sets', opts)).then((p) => p.sets),
  });
}

/** One saved set as the page reads it (its rows, steps and revision). */
export function fetchSet(id: number): Promise<SetView & { set: SavedSet }> {
  return call<SetView & { set: SavedSet }>(apiClient.get(`sets/${id}`, opts));
}

export function setQueryOptions(profileId: number, id: number) {
  return queryOptions({
    queryKey: [...SETS_QUERY_KEY, 'set', profileId, id] as const,
    // another tab or device may have changed it (the page takes it when it
    // has nothing unsaved; otherwise its next save says so)
    refetchOnWindowFocus: true,
    queryFn: () => fetchSet(id),
  });
}

export function sourcesQueryOptions() {
  return queryOptions({
    queryKey: [...SETS_QUERY_KEY, 'sources'] as const,
    queryFn: () =>
      call<{ sources: SourceStates }>(apiClient.get('sets/sources', opts)).then((p) => p.sources),
    staleTime: 60_000,
  });
}

/** The rows as the routes take them. */
export function rowsBody(rows: SetRow[]): SetRow[] {
  return rows.map((r) => ({
    track_id: r.track_id,
    artist: r.artist,
    title: r.title,
    at: r.at ?? null,
    state: r.state,
    want: r.want ?? 'yours',
    version: r.version ?? null,
    locked: Boolean(r.locked),
    note: r.note ?? null,
    transition: r.transition ?? null,
    mbid: r.mbid ?? null,
    raw: r.raw ?? null,
  }));
}

export function postView(rows: SetRow[]): Promise<SetView> {
  return call<SetView>(apiClient.post('sets/view', { ...opts, json: { tracks: rowsBody(rows) } }));
}

export interface SetBody {
  name: string;
  kind: SetKind;
  rows: SetRow[];
  source?: SetSource | null;
  source_id?: string | null;
  source_url?: string | null;
  source_meta?: MixMeta;
  shape?: string | null;
}

export function createSet(body: SetBody): Promise<{ id: number; playlist_id: number | null }> {
  const { rows, ...rest } = body;
  return call(apiClient.post('sets', { ...opts, json: { ...rest, tracks: rowsBody(rows) } }));
}

/** A newer save of this set is already on the server (another window). */
export class StaleSaveError extends Error {
  revision: number;

  constructor(revision: number, message: string) {
    super(message);
    this.revision = revision;
  }
}

/**
 * Save a set's name and/or rows. Send only what changed: a rename sends the
 * name alone. `baseRevision` is the revision this page last read or had a
 * save confirmed at; the server applies the save only while the set is
 * still at it, and answers the new one. Anything else (StaleSaveError)
 * means the set changed somewhere else.
 */
export async function updateSet(
  id: number,
  patch: { name?: string; rows?: SetRow[]; baseRevision?: number },
): Promise<{ id: number; revision: number; playlist_state: SavedSet['playlist_state'] }> {
  const json: Record<string, unknown> = {};
  if (patch.name !== undefined) json.name = patch.name;
  if (patch.rows) json.tracks = rowsBody(patch.rows);
  if (patch.baseRevision !== undefined) json.base_revision = patch.baseRevision;
  const response = await apiClient.put(`sets/${id}`, { ...opts, json });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    stale?: boolean;
    revision?: number;
    error?: string;
    playlist_state?: SavedSet['playlist_state'];
    id?: number;
  };
  if (payload.stale) throw new StaleSaveError(payload.revision ?? 0, payload.error || '');
  if (!response.ok || payload.success === false)
    throw new Error(payload.error || "The change wasn't saved.");
  return {
    id: payload.id ?? id,
    revision: payload.revision ?? 0,
    playlist_state: payload.playlist_state ?? null,
  };
}

/** A set the "Add to mix set…" picker lists (POST /api/sets/holding). */
export interface HoldingSet {
  id: number;
  name: string;
  kind: SetKind;
  updated_at: number | null;
  /** the number the next track added takes */
  next: number;
  rows: number;
  /** where the tracks asked about already are: id -> their numbers */
  holds: Record<string, number[]>;
}

export function fetchHolding(trackIds: string[]): Promise<HoldingSet[]> {
  return call<{ sets: HoldingSet[] }>(
    apiClient.post('sets/holding', { ...opts, json: { track_ids: trackIds.slice(0, 500) } }),
  ).then((p) => p.sets);
}

/** The Mix tab's working set's id (`GET /api/sets/working`), or null; the picker puts it first. */
export function fetchWorkingSetId(): Promise<number | null> {
  return call<{ working: { id: number } | null }>(apiClient.get('sets/working', opts)).then(
    (p) => p.working?.id ?? null,
  );
}

export interface AddedToSet {
  id: number;
  name: string;
  added: { track_id: string; number: number }[];
  already: string[];
  left_out: { id: string; reason: 'not_in_library' | 'file_missing' }[];
  revision: number;
  playlist_state: SavedSet['playlist_state'];
}

/** "Add to mix set…": at the end; one the set holds is skipped unless `again`. */
export function addToSet(id: number, trackIds: string[], again = false): Promise<AddedToSet> {
  return call<AddedToSet>(
    apiClient.post(`sets/${id}/tracks`, {
      ...opts,
      json: { track_ids: trackIds.slice(0, 500), again },
    }),
  );
}

/** Said on window when a set changed outside its page (the picker added to it). */
export const MIX_SET_CHANGED = 'ss:mix-set-changed';

/** "Make a new playlist from this set", or "Not now" for the note that it went its own way. */
export function setPlaylist(
  id: number,
  action: 'new' | 'dismiss',
): Promise<{ playlist_id: number | null }> {
  return call(apiClient.post(`sets/${id}/playlist`, { ...opts, json: { action } }));
}

export function deleteSet(id: number): Promise<unknown> {
  return call(apiClient.delete(`sets/${id}`, opts));
}

export function fetchSwap(args: {
  before: string | null;
  after: string | null;
  current: string | null;
  exclude: string[];
}): Promise<SwapAnswer> {
  const searchParams: Record<string, string> = { limit: '8' };
  if (args.before) searchParams.before = args.before;
  if (args.after) searchParams.after = args.after;
  if (args.current) searchParams.current = args.current;
  if (args.exclude.length) searchParams.exclude = args.exclude.slice(0, 500).join(',');
  return call<SwapAnswer>(apiClient.get('sets/swap', { ...opts, searchParams }));
}

export function searchMixes(q: string): Promise<SearchAnswer> {
  return call<SearchAnswer>(apiClient.get('sets/famous/search', { ...opts, searchParams: { q } }));
}

export function openMix(source: SourceName, id: string): Promise<OpenedMix> {
  return call<OpenedMix>(apiClient.post('sets/famous/open', { ...opts, json: { source, id } }));
}

export function matchLines(
  lines: { artist: string; title: string; at?: string; mbid?: string | null }[],
): Promise<{ rows: MatchRow[]; counts: MatchCounts }> {
  return call(apiClient.post('sets/match', { ...opts, json: { lines } }));
}

export function pasteTracklist(text: string): Promise<PasteAnswer> {
  return call<PasteAnswer>(apiClient.post('sets/paste', { ...opts, json: { text } }));
}

/** The most tracks one Wanted request carries; longer lists go in batches. */
export const WANTED_BATCH = 500;

export async function addToWanted(
  tracks: { artist: string; title: string; album?: string }[],
  setName: string,
): Promise<{ added: number; already: number; refused: { artist: string; title: string }[] }> {
  const total = { added: 0, already: 0, refused: [] as { artist: string; title: string }[] };
  for (let i = 0; i < tracks.length; i += WANTED_BATCH) {
    const done = await call<{
      added: number;
      already: number;
      refused: { artist: string; title: string }[];
    }>(
      apiClient.post('sets/wanted', {
        ...opts,
        json: { tracks: tracks.slice(i, i + WANTED_BATCH), set_name: setName },
      }),
    );
    total.added += done.added;
    total.already += done.already;
    total.refused.push(...done.refused);
  }
  return total;
}

/** "Use yours" after "Want the Dub": the Wanted row it added goes, if it's still waiting. */
export function removeFromWanted(
  track: { artist: string; title: string },
  setName: string,
): Promise<{ removed: boolean }> {
  return call(
    apiClient.post('sets/wanted/remove', { ...opts, json: { ...track, set_name: setName } }),
  );
}
