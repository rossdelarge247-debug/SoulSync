/**
 * The library's DJ data (api/dj.py, CONTRACTS.md "DJ data"): BPM, key in
 * Camelot notation and energy per track, Library → Tracks and "Mixes well
 * with…".
 */
import { infiniteQueryOptions, queryOptions, useQuery } from '@tanstack/react-query';

import { apiClient, readJson } from '@/app/api-client';

export type DjSource = 'tag' | 'enrichment' | 'analysis';

/** One track's DJ data, or null when nothing is known yet. */
export interface DjInfo {
  bpm: number | null;
  bpm_source: DjSource | null;
  /** Camelot, e.g. "8A". */
  key: string | null;
  /** The tag form, e.g. "Am". */
  key_name: string | null;
  /** "A minor", shown as the key's title. */
  key_long: string | null;
  key_source: DjSource | null;
  key_confidence: number | null;
  /** Analysis wasn't sure (confidence under 0.5). */
  key_uncertain: boolean;
  /** 1–10. */
  energy: number | null;
  analyzed: boolean;
  /** Why analysis left it out ("too long to analyse"), else null. */
  skipped?: string | null;
}

export interface DjTrack {
  id: string;
  title: string;
  artist_name: string;
  album_title: string;
  artist_id: string | number | null;
  album_id: string | number | null;
  duration_ms: number | null;
  file_path: string | null;
  bitrate: number | null;
  image_url: string | null;
  dj: DjInfo | null;
}

export type KeyRelation = 'same' | 'up' | 'down' | 'relative';
export type BpmRelation = 'same' | 'half' | 'double';

export interface DjMatch extends DjTrack {
  key_relation: KeyRelation;
  bpm_relation: BpmRelation;
  bpm_diff_pct: number;
}

export interface DjMixesResponse {
  success?: boolean;
  error?: string;
  track: DjTrack | null;
  matches: DjMatch[];
  total?: number;
  reason: 'not_analyzed' | 'none' | null;
}

export interface DjBrowseResponse {
  success?: boolean;
  error?: string;
  tracks: DjTrack[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
  sort: string;
}

export interface DjJob {
  id: number;
  status: 'running' | 'done' | 'stopped' | 'failed';
  total: number;
  done: number;
  failed: number;
  unreachable: number;
  tags_written: number;
  started_at: number;
  finished_at?: number | null;
  waiting?: 'download' | 'import' | 'drive_away' | 'drive_move' | 'tag_write' | null;
  note?: string | null;
  recent: boolean;
}

export interface DjStatus {
  success?: boolean;
  settings: { analyze: boolean; write_tags: boolean; overwrite_tags: boolean };
  counts: {
    tracks: number;
    analyzed: number;
    failed: number;
    unreachable: number;
    pending: number;
  };
  job: DjJob | null;
  held: boolean;
  can_start: boolean;
  can_stop: boolean;
}

export const DJ_QUERY_KEY = ['dj'] as const;
export const DJ_PAGE_SIZE = 50;

async function readOk<T extends { success?: boolean; error?: string }>(
  promise: Promise<T>,
): Promise<T> {
  const payload = await promise;
  if (payload.success === false) throw new Error(payload.error || 'Something went wrong');
  return payload;
}

/** The track rows' BPM and key, for any page that lists library tracks. */
export function djTracksQueryOptions(ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))].sort();
  return queryOptions({
    queryKey: [...DJ_QUERY_KEY, 'tracks', unique.join(',')] as const,
    queryFn: async () =>
      (
        await readOk(
          readJson<{ success?: boolean; tracks: Record<string, DjInfo> }>(
            apiClient.post('library/dj/tracks', { json: { track_ids: unique.slice(0, 500) } }),
          ),
        )
      ).tracks,
    enabled: unique.length > 0,
    staleTime: 60_000,
  });
}

/**
 * DJ data for the rows a page shows, in one request per set of rows. A
 * failure is quiet: the rows just don't show BPM and key.
 */
export function useDjInfo(ids: (string | number | null | undefined)[]): Record<string, DjInfo> {
  const list = ids.filter(
    (id): id is string | number => id !== null && id !== undefined && id !== '',
  );
  const query = useQuery({ ...djTracksQueryOptions(list.map(String)), retry: false });
  return query.data ?? {};
}

export function djStatusQueryOptions() {
  return queryOptions({
    queryKey: [...DJ_QUERY_KEY, 'status'] as const,
    queryFn: () => readOk(readJson<DjStatus>(apiClient.get('library/dj/status'))),
    refetchInterval: (query) => (query.state.data?.job?.status === 'running' ? 5_000 : 60_000),
  });
}

export interface DjBrowseQuery {
  bpmMin: number | null;
  bpmMax: number | null;
  key: string;
  q: string;
  sort: string;
}

export function djBrowseInfiniteQueryOptions(profileId: number, query: DjBrowseQuery) {
  return infiniteQueryOptions({
    queryKey: [...DJ_QUERY_KEY, 'browse', profileId, query] as const,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const searchParams: Record<string, string | number> = {
        sort: query.sort,
        page: pageParam,
        limit: DJ_PAGE_SIZE,
      };
      if (query.bpmMin !== null) searchParams.bpm_min = query.bpmMin;
      if (query.bpmMax !== null) searchParams.bpm_max = query.bpmMax;
      if (query.key) searchParams.key = query.key;
      if (query.q) searchParams.q = query.q;
      return readOk(
        readJson<DjBrowseResponse>(apiClient.get('library/dj/browse', { searchParams })),
      );
    },
    getNextPageParam: (last) => (last.has_more ? last.page + 1 : undefined),
  });
}

export function djMixesQueryOptions(trackId: string) {
  return queryOptions({
    queryKey: [...DJ_QUERY_KEY, 'mixes', trackId] as const,
    queryFn: () =>
      readOk(
        readJson<DjMixesResponse>(apiClient.get(`library/dj/mixes/${encodeURIComponent(trackId)}`)),
      ),
  });
}

/** Start (or Stop) the analysis; throws with the server's sentence. */
export async function postDjJob(action: 'start' | 'stop'): Promise<void> {
  const response = await apiClient.post(`library/dj/${action}`, { throwHttpErrors: false });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
  };
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || "That didn't work. Try again in a moment.");
  }
}
