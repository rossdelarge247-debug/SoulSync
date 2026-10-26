/**
 * The Mix tab's routes (CONTRACTS.md, "The Mix tab"): Mixes well with in the
 * tab's order (`GET /api/library/dj/mixes/<id>?rank=mix`), Vibe (`POST
 * …/vibe`), the working set (`/api/sets/working`), and Add after the
 * playing track (`POST /api/sets/<id>/tracks` with `after`).
 */
import { queryOptions } from '@tanstack/react-query';

import type { DjMatch, DjMixesResponse } from '@/features/dj/dj.api';
import type { AddedToSet, SetKind } from '@/features/sets/sets.api';

import { apiClient } from '@/app/api-client';
import { DJ_QUERY_KEY } from '@/features/dj/dj.api';
import { SETS_QUERY_KEY } from '@/features/sets/sets.api';

export interface MixSignals {
  starred: boolean;
  /** in your listening history in the last two days, or the last week */
  played: 'today' | 'this_week' | null;
  energy_delta: number | null;
  /** the share of genres in common, 0–1 */
  style: number;
  shared_genres: string[];
  same_artist: boolean;
}

export interface MixMatch extends Omit<DjMatch, 'key_relation'> {
  key_relation: DjMatch['key_relation'] | 'other';
  /** "Same key · +2% BPM · energy ↑1" */
  reason: string;
  /** the phone's line: "same key · +2% · ↑1" */
  reason_short: string;
  starred: boolean;
  signals: MixSignals;
}

export interface MixAnswer extends Omit<DjMixesResponse, 'matches'> {
  matches: MixMatch[];
  ranked: 'mix';
  wide: boolean;
  /** the set followed: its tracks left out, its energy direction */
  set: {
    id: number;
    name: string;
    direction: 'up' | 'down' | 'steady' | null;
    left_out: number;
  } | null;
  /** Vibe's answer: what the order goes for */
  vibe?: { line: string };
}

export interface MixQuery {
  setId: number | null;
  wide: boolean;
  /** a track to leave out: More like this leaves out the playing one */
  exclude?: string | null;
}

async function call<T>(promise: Promise<Response>): Promise<T> {
  const response = await promise;
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    code?: string;
  } & T;
  if (!response.ok || payload.success === false) {
    const err = new MixError(
      payload.error || "That didn't work. Try again in a moment.",
      response.status,
      payload.code ?? null,
    );
    throw err;
  }
  return payload;
}

/** A refused request: the server's sentence, its status and (Vibe) its code. */
export class MixError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const opts = { throwHttpErrors: false } as const;

export const MIX_LIMIT = 5;

/** Mixes well with in the tab's order: five, the working set's tracks left out. */
export function mixQueryOptions(trackId: string, q: MixQuery) {
  return queryOptions({
    queryKey: [...DJ_QUERY_KEY, 'mix', trackId, q.setId, q.wide, q.exclude ?? null] as const,
    queryFn: () => {
      const searchParams: Record<string, string | number> = { rank: 'mix', limit: MIX_LIMIT };
      if (q.setId) searchParams.set_id = q.setId;
      if (q.wide) searchParams.wide = 1;
      if (q.exclude) searchParams.exclude = q.exclude;
      return call<MixAnswer>(
        apiClient.get(`library/dj/mixes/${encodeURIComponent(trackId)}`, {
          ...opts,
          searchParams,
        }),
      );
    },
    staleTime: 30_000,
  });
}

/** Vibe: the top 20 re-ordered for feel by the AI. Throws MixError with its code. */
export function vibeQueryOptions(trackId: string, q: MixQuery) {
  return queryOptions({
    queryKey: [...DJ_QUERY_KEY, 'mix-vibe', trackId, q.setId, q.wide, q.exclude ?? null] as const,
    queryFn: () =>
      call<MixAnswer>(
        apiClient.post(`library/dj/mixes/${encodeURIComponent(trackId)}/vibe`, {
          ...opts,
          json: {
            set_id: q.setId,
            wide: q.wide,
            limit: MIX_LIMIT,
            ...(q.exclude ? { exclude: [q.exclude] } : {}),
          },
        }),
      ),
    // one request per track: each counts against the profile's AI usage
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
}

export interface WorkingSet {
  id: number;
  name: string;
  kind: SetKind;
  revision: number;
  updated_at: number | null;
}

export function workingSetQueryOptions(profileId: number | string | null | undefined) {
  return queryOptions({
    queryKey: [...SETS_QUERY_KEY, 'working', profileId ?? null] as const,
    queryFn: () =>
      call<{ working: WorkingSet | null }>(apiClient.get('sets/working', opts)).then(
        (p) => p.working,
      ),
  });
}

export function chooseWorkingSet(setId: number | null): Promise<WorkingSet | null> {
  return call<{ working: WorkingSet | null }>(
    apiClient.put('sets/working', { ...opts, json: { set_id: setId } }),
  ).then((p) => p.working);
}

/** A new mix set of these tracks, made the working set. */
export function startWorkingSet(
  name: string,
  trackIds: string[],
): Promise<{ id: number; working: WorkingSet | null }> {
  return call(
    apiClient.post('sets/working/start', { ...opts, json: { name, track_ids: trackIds } }),
  );
}

/** Add to a set: at the end, or after the playing track while the set plays (29b). */
export function addToWorkingSet(
  setId: number,
  trackIds: string[],
  opts2: { again?: boolean; after?: { track_id: string; number: number } | null } = {},
): Promise<AddedToSet & { placed: 'after' | 'end' }> {
  return call(
    apiClient.post(`sets/${setId}/tracks`, {
      ...opts,
      json: {
        track_ids: trackIds,
        again: Boolean(opts2.again),
        ...(opts2.after ? { after: opts2.after } : {}),
      },
    }),
  );
}

export interface AiStatus {
  configured: boolean;
  can_use: boolean;
  reason: 'not_configured' | 'members_not_allowed' | 'key_refused' | 'cap_reached' | null;
}

export function aiStatusQueryOptions() {
  return queryOptions({
    queryKey: ['ai', 'status'] as const,
    queryFn: () => call<AiStatus>(apiClient.get('ai/status', opts)),
    staleTime: 60_000,
  });
}
