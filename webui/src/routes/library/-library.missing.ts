/**
 * Look for releases you don't have (HANDOFF 68): the background job that
 * fetches the discography of every library artist SYNCHRO.S has none listed
 * for. GET /api/library/missing-releases (the job and the candidates), POST
 * …/start and …/stop (admins). Activity shows the run; the Artists header
 * says what it found.
 */

import { queryOptions } from '@tanstack/react-query';

import { apiClient, readJson } from '@/app/api-client';
import { formatWait } from '@/features/spotify-pause/spotify-pause';

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

export interface MissingHeader {
  text: string;
  /** The link that ends it: Stop while it runs (admins), Show them once it found some. */
  action: 'stop' | 'show' | null;
}

/**
 * What the Artists header adds to its sentence (68, 15e): the run's progress
 * while it goes ("Looking for releases you don't have: 40 of 212", with
 * Spotify's pause and its time left while it waits), then what it found, for
 * a day ("The last look found 61 releases you don't have, by 18 artists",
 * then Show them; "found nothing new for 212 artists"). null when there's
 * nothing to say. `nowMs` is the browser's clock, for the pause's time left.
 */
export function missingHeader(
  job: MissingReleasesJob | null | undefined,
  nowMs = Date.now(),
): MissingHeader | null {
  if (!job || !job.recent) return null;
  const progress = `${job.done.toLocaleString()} of ${job.total.toLocaleString()}`;
  if (job.status === 'running') {
    const left = job.waiting_until ? Math.max(0, job.waiting_until - nowMs / 1000) : 0;
    return {
      text: job.waiting_until
        ? `Looking for releases you don't have: ${progress}, waiting for Spotify's pause${left > 0 ? `, ${formatWait(left)} left` : ''}`
        : `Looking for releases you don't have: ${progress}`,
      action: 'stop',
    };
  }
  const n = job.found_releases ?? 0;
  const found = `${plural(n, 'release')} you don't have, by ${plural(job.found_artists ?? 0, 'artist')}`;
  if (job.status === 'done')
    return n
      ? { text: `The last look found ${found}`, action: 'show' }
      : {
          text: `The last look found nothing new for ${plural(job.total, 'artist')}`,
          action: null,
        };
  if (job.status === 'stopped')
    return {
      text: `The last look stopped after ${progress} artists and found ${n ? found : 'nothing new'}`,
      action: n ? 'show' : null,
    };
  return { text: "The last look didn't finish; Activity says why", action: null };
}

/** The confirm's middle tile (15e): one artist a second, rounded up to minutes. */
export function aboutHowLong(artists: number): string {
  const minutes = Math.max(1, Math.ceil(Math.max(0, artists) / 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** The confirm's sentence (15e): the rate with its reason, and what it doesn't do. */
export const MISSING_CONFIRM_TEXT =
  'SYNCHRO.S asks the metadata services about one artist a second, so it stays well inside their limits for everyone on this server. ' +
  "What it finds shows on Library → Artists as releases you don't have; you choose what goes to Wanted.";
