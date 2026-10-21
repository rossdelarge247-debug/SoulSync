import { queryOptions } from '@tanstack/react-query';

import { apiClient, readJson } from '@/app/api-client';

import { normalizeModules, type ModuleState } from './modules.helpers';

export const modulesQueryKey = ['modules'] as const;

interface ModulesResponse {
  success?: boolean;
  modules?: unknown;
}

export async function fetchModules(): Promise<ModuleState[]> {
  const data = await readJson<ModulesResponse>(apiClient.get('modules'));
  return normalizeModules(data?.modules);
}

/**
 * What the page shell rendered with (window.SOULSYNC_MODULES), kept current
 * by the legacy shell after every change. Null when the page didn't carry it
 * (tests, an older server).
 */
export function readShellModules(): ModuleState[] | null {
  const raw = typeof window === 'undefined' ? undefined : window.SOULSYNC_MODULES;
  if (!Array.isArray(raw)) return null;
  const modules = normalizeModules(raw);
  return modules.length ? modules : null;
}

export function modulesQueryOptions() {
  return queryOptions({
    queryKey: modulesQueryKey,
    queryFn: fetchModules,
    initialData: () => readShellModules() ?? undefined,
    // the shell's copy is current (it follows every change), so only a
    // stale one is worth a round trip
    initialDataUpdatedAt: () => (readShellModules() ? Date.now() : 0),
    staleTime: 60_000,
    retry: false,
  });
}
