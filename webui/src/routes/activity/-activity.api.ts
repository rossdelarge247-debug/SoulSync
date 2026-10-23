import { infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query';
import { HTTPError } from 'ky';

import { apiClient, readJson } from '@/app/api-client';

import type {
  ActivityItem,
  ActivityLogLine,
  ActivityLogResponse,
  ActivityRange,
  ActivityResponse,
  ActivityShow,
} from './-activity.types';

import { activityParams, refreshInterval } from './-activity.helpers';

export const ACTIVITY_QUERY_KEY = ['activity'] as const;

function asItems(value: unknown): ActivityItem[] {
  return Array.isArray(value) ? (value as ActivityItem[]) : [];
}

/** Every part present, whatever an older server leaves out. */
export function normalizeActivity(payload: Partial<ActivityResponse>): ActivityResponse {
  return {
    success: payload.success !== false,
    items: asItems(payload.items),
    next_before: payload.next_before || null,
    range: payload.range ?? '7d',
    since: Number(payload.since) || 0,
    kind: payload.kind ?? 'all',
    counts: {
      download: 0,
      import: 0,
      automation: 0,
      library: 0,
      sync: 0,
      safety: 0,
      radio: 0,
      needs_you: 0,
      ...payload.counts,
    },
    running_count: Number(payload.running_count) || 0,
    needs_you: asItems(payload.needs_you),
    generated_at: Number(payload.generated_at) || 0,
  };
}

export async function fetchActivity(
  show: ActivityShow,
  range: ActivityRange,
  before: string | null,
  signal?: AbortSignal,
): Promise<ActivityResponse> {
  const payload = await readJson<Partial<ActivityResponse>>(
    apiClient.get('activity', { searchParams: activityParams(show, range, before), signal }),
  );
  if (payload.success === false) throw new Error(payload.error || 'Couldn’t load activity');
  return normalizeActivity(payload);
}

/**
 * One infinite query per filter and range: page 1, then a page per "Show
 * earlier days" (`before` = the previous page's `next_before`). While
 * something runs it refetches every 10 s, otherwise every minute; never while
 * the tab is hidden (refetchIntervalInBackground), and once on coming back.
 */
export function activityQueryOptions(show: ActivityShow, range: ActivityRange) {
  return infiniteQueryOptions({
    queryKey: [...ACTIVITY_QUERY_KEY, 'feed', show, range],
    queryFn: ({ pageParam, signal }) => fetchActivity(show, range, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_before ?? undefined,
    refetchInterval: (query) => refreshInterval(query.state.data?.pages[0]),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });
}

export async function fetchActivityLog(
  id: string,
  signal?: AbortSignal,
): Promise<ActivityLogLine[]> {
  const payload = await readJson<ActivityLogResponse>(
    apiClient.get(`activity/log/${encodeURIComponent(id)}`, { signal }),
  );
  if (payload.success === false) throw new Error(payload.error || 'Couldn’t load the log');
  return Array.isArray(payload.log_lines) ? payload.log_lines : [];
}

export function activityLogQueryOptions(id: string, enabled: boolean) {
  return queryOptions({
    queryKey: [...ACTIVITY_QUERY_KEY, 'log', id],
    queryFn: ({ signal }) => fetchActivityLog(id, signal),
    enabled,
    retry: false,
    // a finished run's log doesn't change
    staleTime: Infinity,
  });
}

/**
 * Close an expired preview. 404 means it's already closed (previewed again,
 * confirmed, or dismissed elsewhere), which is what the user wanted.
 */
export async function dismissActivityItem(id: string): Promise<void> {
  try {
    await readJson(apiClient.post('activity/dismiss', { json: { id } }));
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 404) return;
    throw error;
  }
}

/** The retry routes answer `{success: false, error}` with a 200 sometimes. */
export async function postRetry(path: string): Promise<void> {
  const payload = await readJson<{ success?: boolean; error?: string; message?: string }>(
    apiClient.post(path),
  );
  if (payload && payload.success === false) {
    throw new Error(payload.error || payload.message || 'That didn’t go through');
  }
}

/** Drop a dismissed item from every cached page before the refetch lands. */
export function removeFromCache(queryClient: QueryClient, id: string): void {
  queryClient.setQueriesData<{ pages: ActivityResponse[]; pageParams: unknown[] }>(
    { queryKey: [...ACTIVITY_QUERY_KEY, 'feed'] },
    (data) => {
      if (!data) return data;
      return {
        ...data,
        pages: data.pages.map((page) => {
          const had = page.needs_you.some((item) => item.id === id);
          return {
            ...page,
            needs_you: page.needs_you.filter((item) => item.id !== id),
            items:
              page.kind === 'needs_you'
                ? page.items.filter((item) => item.id !== id)
                : page.items.map((item) => (item.id === id ? { ...item, needs_you: false } : item)),
            counts: had
              ? { ...page.counts, needs_you: Math.max(0, page.counts.needs_you - 1) }
              : page.counts,
          };
        }),
      };
    },
  );
}

export function invalidateActivity(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: [...ACTIVITY_QUERY_KEY, 'feed'] });
}
