import { queryOptions } from '@tanstack/react-query';
import { HTTPError } from 'ky';

import { apiClient, readJson } from '@/app/api-client';

import type { CheckScope, SetupCheckReport, SetupCheckResponse } from './-setup-check.types';

import { normalizeReport } from './-setup-check.helpers';

export const SETUP_CHECK_QUERY_KEY = ['setup-check'] as const;

/** The endpoint is admin-only; a 403 means this profile may not run it. */
export class SetupCheckForbiddenError extends Error {
  constructor() {
    super('Only an admin can run the setup check');
    this.name = 'SetupCheckForbiddenError';
  }
}

export function isForbidden(error: unknown): boolean {
  return error instanceof SetupCheckForbiddenError;
}

export async function fetchSetupCheck(scope: CheckScope): Promise<SetupCheckReport> {
  let payload: SetupCheckResponse;
  try {
    payload = await readJson<SetupCheckResponse>(
      apiClient.get('setup/check', {
        searchParams: scope === 'local' ? { scope: 'local' } : undefined,
        // the full run waits on slskd and the media server (25 s deadline
        // server-side); ky's own 10 s default would cut it off
        timeout: 60_000,
      }),
    );
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 403) {
      throw new SetupCheckForbiddenError();
    }
    throw error;
  }
  if (!payload.success) throw new Error(payload.error || 'The setup check failed');
  return normalizeReport(payload);
}

/**
 * Two runs, started together: the local checks (folders, the user SoulSync
 * runs as) answer in well under a second, the full run waits on slskd and the
 * media server. The page shows the local results while the full run finishes.
 */
export function setupCheckQueryOptions(scope: CheckScope, enabled: boolean) {
  return queryOptions({
    queryKey: [...SETUP_CHECK_QUERY_KEY, scope],
    queryFn: () => fetchSetupCheck(scope),
    enabled,
    // a slow or refused run is not worth repeating behind the user's back
    retry: false,
    // fresh on every visit (the last report stays on screen meanwhile);
    // nothing in the background reruns it
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

interface SetupStatusResponse {
  setup_complete?: boolean;
}

/** false only while first-run setup (the setup wizard) hasn't been finished. */
export async function fetchSetupComplete(): Promise<boolean> {
  const payload = await readJson<SetupStatusResponse>(apiClient.get('setup/status'));
  return payload.setup_complete !== false;
}

export function setupStatusQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: ['setup-status'],
    queryFn: fetchSetupComplete,
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}
