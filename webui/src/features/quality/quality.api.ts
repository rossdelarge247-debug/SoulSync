/**
 * The quality target: GET /api/quality/presets (how much of the library meets
 * each preset, and the current target) and PUT /api/quality/target (admin
 * only), which writes a preset into the default quality profile. Both in
 * docs/design/CONTRACTS.md.
 */

import { queryOptions } from '@tanstack/react-query';
import { HTTPError } from 'ky';

import { apiClient, readJson } from '@/app/api-client';

import type { PresetKey, QualityRule } from './quality.model';

export interface PresetCount {
  key: PresetKey;
  name: string;
  meeting: number;
  total: number;
  /** FLAC 24-bit: bit depth isn't stored, so it's judged from the bitrate. */
  estimated: boolean;
}

export interface CurrentTarget {
  preset: PresetKey | null;
  name: string;
  quality_profile_id: number | null;
  quality_profile_name: string | null;
  /** Unix seconds: when the default profile was last saved. */
  updated_at: number | null;
  /** The profile keeps upgrading tracks below the target. */
  upgrade_existing?: boolean;
  /** A search that finds nothing at the target takes the best other copy. */
  fallback_enabled?: boolean;
  /** The target's bar: a file meets the target when it meets any of these. */
  targets?: QualityRule[];
}

export interface QualityPresets {
  total: number;
  unknown_format: number;
  presets: PresetCount[];
  current: CurrentTarget;
}

export const QUALITY_PRESETS_KEY = ['quality', 'presets'] as const;

export async function fetchQualityPresets(): Promise<QualityPresets> {
  const body = await readJson<QualityPresets & { success?: boolean; error?: string }>(
    apiClient.get('quality/presets', { timeout: 20_000 }),
  );
  if (body.success === false) throw new Error(body.error || 'Could not count your library');
  return body;
}

export function qualityPresetsQueryOptions() {
  return queryOptions({
    queryKey: QUALITY_PRESETS_KEY,
    queryFn: fetchQualityPresets,
    // the server caches the counts for 10 minutes; a minute here is plenty
    staleTime: 60_000,
  });
}

export type SetTargetFailure =
  | { kind: 'changed'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'failed'; message: string };

export class SetTargetError extends Error {
  failure: SetTargetFailure;
  constructor(failure: SetTargetFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

/**
 * Make `preset` the target. `basedOn` is the `current.updated_at` the dialog
 * showed: if the profile was saved since, the server answers 409 and nothing
 * changes. Rejects with a SetTargetError that says which failure it was.
 */
export async function putQualityTarget(input: {
  preset: PresetKey;
  upgradeExisting: boolean;
  basedOn: number | null;
}): Promise<QualityPresets> {
  try {
    const body = await apiClient
      .put('quality/target', {
        json: {
          preset: input.preset,
          upgrade_existing: input.upgradeExisting,
          ...(input.basedOn != null ? { based_on: input.basedOn } : {}),
        },
        timeout: 30_000,
      })
      .json<QualityPresets & { success?: boolean }>();
    return body;
  } catch (error) {
    if (error instanceof HTTPError) {
      const data = (error.data ?? {}) as { error?: string; message?: string };
      const status = error.response.status;
      if (status === 409) {
        throw new SetTargetError({
          kind: 'changed',
          message:
            data.message ||
            'The quality target was changed somewhere else while this was open. Nothing was saved.',
        });
      }
      if (status === 403) {
        throw new SetTargetError({
          kind: 'forbidden',
          message: 'Only an admin can change the quality target. Nothing was saved.',
        });
      }
      throw new SetTargetError({
        kind: 'failed',
        message: data.message || "SYNCHRO.S couldn't save the target. Nothing changed.",
      });
    }
    throw new SetTargetError({
      kind: 'failed',
      message: "SYNCHRO.S didn't answer, so the target wasn't saved. Nothing changed.",
    });
  }
}

/** One automation row, as much of GET /api/automations as the dialogs read. */
export interface AutomationRow {
  id: number;
  name: string;
  enabled?: boolean | number;
  trigger_type?: string;
  trigger_config?: Record<string, unknown> | null;
  action_type?: string;
  action_config?: Record<string, unknown> | null;
  next_run?: string | null;
  owned_by?: string | null;
}

export async function fetchAutomations(): Promise<AutomationRow[]> {
  const body = await readJson<AutomationRow[] | { error?: string }>(apiClient.get('automations'));
  if (!Array.isArray(body)) throw new Error(body?.error || 'Could not load automations');
  return body;
}

export function automationsQueryOptions() {
  return queryOptions({
    queryKey: ['automations', 'list'] as const,
    queryFn: fetchAutomations,
    staleTime: 30_000,
  });
}

/** The music side's automations are paused (Automations → pause). */
export async function fetchAutomationsPaused(): Promise<boolean> {
  const body = await readJson<{ music?: boolean }>(apiClient.get('automations/master'));
  return body.music === false;
}

export function automationsPausedQueryOptions() {
  return queryOptions({
    queryKey: ['automations', 'master'] as const,
    queryFn: fetchAutomationsPaused,
    staleTime: 30_000,
  });
}
