/**
 * Look for releases you don't have (HANDOFF 68): the background job that
 * fetches the discography of every library artist SYNCHRO.S has none listed
 * for. GET /api/library/missing-releases (the job and the candidates), POST
 * …/start and …/stop (admins). Activity shows the run; the Artists header
 * says what it found.
 */

import { queryOptions } from '@tanstack/react-query';

import { apiClient, readJson } from '@/app/api-client';

import { LIBRARY_QUERY_KEY } from './-library.api';
import { plural } from './-ui/parts';

export interface MissingReleasesJob {
  id: number;
  status: 'running' | 'done' | 'stopped' | 'failed';
  total: number;
  done: number;
  failed?: number;
  found_releases?: number;
  found_artists?: number;
  started_at: number;
  finished_at?: number | null;
  /** Unix seconds: when Spotify's pause ends, while the job waits for it. */
  waiting_until?: number | null;
  note?: string | null;
  /** Running, or finished within a day: the header still says so. */
  recent: boolean;
}

export interface MissingReleasesState {
  success?: boolean;
  error?: string;
  job: MissingReleasesJob | null;
  /** Library artists with no releases listed: what a run would ask about. */
  candidates: number;
  can_start: boolean;
}

export const MISSING_QUERY_KEY = [...LIBRARY_QUERY_KEY, 'missing-releases'] as const;

/** The job's state; polled every 3 s while it runs. */
export function missingReleasesQueryOptions(profileId: number) {
  return queryOptions({
    queryKey: [...MISSING_QUERY_KEY, profileId] as const,
    queryFn: async () => {
      const body = await readJson<MissingReleasesState>(apiClient.get('library/missing-releases'));
      if (body.success === false) throw new Error(body.error || "Couldn't read the job");
      return body;
    },
    refetchInterval: (query) => (query.state.data?.job?.status === 'running' ? 3000 : false),
    staleTime: 10_000,
  });
}

async function post(path: string, fallback: string): Promise<void> {
  const response = await apiClient.post(path, { json: {}, throwHttpErrors: false });
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string };
  if (!response.ok || body.success === false) throw new Error(body.error || fallback);
}

export function startMissingReleases(): Promise<void> {
  return post('library/missing-releases/start', "Couldn't start looking");
}

export function stopMissingReleases(): Promise<void> {
  return post('library/missing-releases/stop', "Couldn't stop it");
}

/**
 * What the Artists header adds to its sentence (68): the run's progress while
 * it goes, then what it found, for a day. '' when there's nothing to say.
 */
export function missingHeaderPhrase(job: MissingReleasesJob | null | undefined): string {
  if (!job || !job.recent) return '';
  if (job.status === 'running')
    return job.waiting_until
      ? `Looking for releases you don't have: waiting for Spotify's pause, ${job.done.toLocaleString()} of ${plural(job.total, 'artist')} done`
      : `Looking for releases you don't have: ${job.done.toLocaleString()} of ${plural(job.total, 'artist')} done`;
  const n = job.found_releases ?? 0;
  const found = n
    ? `${plural(n, 'release')} you don't have, by ${plural(job.found_artists ?? 0, 'artist')}`
    : 'nothing new';
  if (job.status === 'done') return `The last look found ${found}`;
  if (job.status === 'stopped')
    return `The last look stopped after ${job.done.toLocaleString()} of ${plural(job.total, 'artist')} and found ${found}`;
  return "The last look didn't finish; Activity says why";
}

/** The confirm's sentence (68): what it does, how, and what it doesn't. */
export function missingConfirmText(candidates: number): string {
  return (
    `SYNCHRO.S asks the metadata services for the releases of the ${plural(candidates, 'artist')} in your library it has none listed for, ` +
    'one at a time, in the background. It waits out any Spotify pause and shows its progress in Activity, where you can stop it. ' +
    "Nothing goes to Wanted: what it finds shows here as releases you don't have."
  );
}
